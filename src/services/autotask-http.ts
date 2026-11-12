import { createHash } from 'node:crypto';
// Autotask HTTP client — native fetch wrapper around the Autotask REST API.
//
// Replaces the autotask-node SDK in the service layer. The SDK gets several
// URL shapes wrong (PATCH /{Entity}/{id} returning 405, certain GETs 404,
// list() silently dropping filters), so we talk to the API directly.
//
// Zero new runtime deps — Node 18+ built-in `fetch` only.

import { noteOperationWrite } from '../utils/operation-context.js';
import { resolveAutotaskApiUrl, invalidateZoneUrlCache } from '../utils/config';
import { mapWithConcurrency } from '../utils/concurrency';
import { getImpersonationResourceId } from '../utils/request-context';
import { Logger } from '../utils/logger';
import { cachedRead, invalidateAfterWrite, isRead, recordRateLimited, recordUpstream } from './http-cache';
import { startApiCall } from './call-log';

export interface QueryFilter {
  op: string;
  field?: string;
  value?: any;
  items?: QueryFilter[];
}

export interface QueryOptions {
  maxRecords?: number;
  includeFields?: string[];
  page?: number;
  /**
   * Skip the in-memory read cache and send straight upstream. For
   * bulk walks like the Postgres shadow sync: hundreds of 500-row pages read
   * once must not sit in process memory for the cache TTL.
   */
  noCache?: boolean;
}

export interface QueryByIdsOptions extends QueryOptions {
  /**
   * IDs per `in` chunk. Autotask tolerates large `in` lists but the proven
   * n8n batch size is 200 (brief §7.19); keep it configurable. Clamped >= 1.
   */
  chunkSize?: number;
  /**
   * Chunks queried concurrently. Bounded so a wide ID set stays under
   * Autotask's per-integration thread threshold (see mapWithConcurrency).
   */
  concurrency?: number;
}

export interface BatchedQueryResult<T> {
  /** Deduplicated rows across all chunks (by `id` when the record carries one). */
  items: T[];
  /**
   * Chunks whose query rejected, with the IDs that were in them. Surfaced
   * rather than silently dropped (brief §7.19) so callers can decide whether a
   * partial result is acceptable or the whole operation should fail.
   */
  failedChunks: Array<{ ids: Array<number | string>; error: string }>;
}

interface PageDetails {
  nextPageUrl?: string | null;
  count?: number;
}

interface QueryResponse<T> {
  items?: T[];
  pageDetails?: PageDetails;
}

const RAW_REQUEST_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

/**
 * Unwrap an Autotask GET-by-id response into the entity, or null when absent.
 *
 * Autotask returns `{ item: {...} }`, but two not-found shapes must both map to
 * null: a genuine 404 (handled by the caller) and — the subtle one — an HTTP
 * 200 carrying `{ item: null }`, which Autotask uses for a missing id on several
 * entities (verified live: GET /Tasks/{missing} and /Projects/{missing}). The
 * previous `res?.item ?? res` returned the truthy `{ item: null }` wrapper for
 * that case, so a missing entity read as "found" — which would defeat
 * read-after-write retry (getWithRetry would stop on a null-item wrapper) and
 * hand callers a useless shell. When `item` is present we use it (even if null);
 * otherwise the entity is at the top level (some legacy routes).
 */
/**
 * Process-wide hook called after every successful Autotask WRITE (method, path,
 * body, response). The Postgres shadow uses it to re-read the rows the MCP
 * just changed, so the mirror never lags the MCP's own writes.
 */
export type WriteListener = (method: string, path: string, body: unknown, response: unknown) => void;
let writeListener: WriteListener | null = null;
export function setWriteListener(fn: WriteListener | null): void { writeListener = fn; }

/**
 * Read interceptor (set by the Postgres shadow runtime): lets EVERY query and
 * by-id GET — not only the paged search tools — be answered from the mirror
 * when it can. Returning null/undefined means "go to Autotask". Never used for
 * the shadow's own sync reads (noCache) or impersonated reads.
 */
export interface ReadInterceptor {
  query(tenant: string, entity: string, filter: QueryFilter[], limit: number): Promise<unknown[] | null>;
  get(tenant: string, entity: string, id: number): Promise<unknown | undefined>;
}
let readInterceptor: ReadInterceptor | null = null;
export function setReadInterceptor(fn: ReadInterceptor | null): void { readInterceptor = fn; }
/** The shadow's query cap: larger reads always go to Autotask. */
const SHADOW_MAX_ROWS = 5000;

function project<T>(rows: unknown[], fields?: string[]): T[] {
  if (!fields?.length) return rows as T[];
  const keep = new Set([...fields, 'id']);
  return rows.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => keep.has(k)))) as T[];
}

/** The object endpoint a path hits: "/Tickets/query" → "Tickets"; absolute URLs use their path. */
export function endpointOf(path: string): string {
  const p = path.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/?(atservicesrest\/)?(v1\.0\/)?/i, '/');
  return p.split('?')[0]!.split('/').filter(Boolean)[0] ?? '';
}

const endpointGates = new Map<string, { active: number; waiting: Array<() => void> }>();
function maxPerEndpoint(): number {
  const n = Number(process.env.AUTOTASK_MAX_CONCURRENT_PER_ENDPOINT);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 2;
}
/** Wait for a free slot on an endpoint; resolves to the release function. */
export async function acquireEndpointSlot(key: string): Promise<() => void> {
  const g = endpointGates.get(key) ?? endpointGates.set(key, { active: 0, waiting: [] }).get(key)!;
  if (g.active >= maxPerEndpoint()) await new Promise<void>((resolve) => g.waiting.push(resolve));
  g.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    g.active--;
    g.waiting.shift()?.();
  };
}
/** Calls currently waiting for an endpoint slot (all endpoints). */
export function endpointQueueDepth(): number { let n = 0; for (const g of endpointGates.values()) n += g.waiting.length; return n; }

/** A UDF definition from entityInformation/userDefinedFields (list UDFs carry picklistValues). */
export interface UdfDefinition { name: string; isPickList?: boolean; picklistValues?: Array<{ value: unknown; label: string }> }

function unwrapEntity<T>(res: unknown): T | null {
  if (res && typeof res === 'object' && 'item' in (res as Record<string, unknown>)) {
    return ((res as { item?: T }).item ?? null) as T | null;
  }
  // Some by-id GETs answer in the QUERY shape: GET /TicketAttachments/{id}
  // (and the child route) return { items: [record], pageDetails } — verified
  // live. Returning that wrapper made callers see no fields at all (the
  // attachment's `data`, `ticketID`, …), silently bypassing the parent-scope
  // check and the inline-size cap in getTicketAttachment.
  if (res && typeof res === 'object' && Array.isArray((res as { items?: unknown }).items) && 'pageDetails' in (res as Record<string, unknown>)) {
    return (((res as { items: T[] }).items[0]) ?? null) as T | null;
  }
  return ((res as T) ?? null) as T | null;
}

/**
 * Maximum value Autotask accepts for the per-page `MaxRecords` body param on
 * `/query` endpoints. Anything outside [1, AUTOTASK_MAX_PAGE_SIZE] returns
 * HTTP 500 with the body "maxCountOfRecordsToReturn must be between 1 and 500".
 * This is the per-page page-size limit, NOT a cap on total rows the caller
 * can retrieve — multi-page walks via `pageDetails.nextPageUrl` aggregate
 * across pages until the caller's `opts.maxRecords` total cap is reached.
 */
export const AUTOTASK_MAX_PAGE_SIZE = 500;

/**
 * Thrown when Autotask returns 429 (per-integration API threshold exceeded).
 * Carries `retryAfterSeconds` parsed from the `Retry-After` header (RFC 7231
 * — either an integer seconds value or an HTTP-date) so callers can back off
 * accurately. Tool handlers convert this into a structured `error_type:
 * "rate_limited"` tool result so LLM-driven workflows stop hammering the
 * same path. Issue #69 (faspina) — \"status report for all open projects
 * with notes\" fan-out tripped the threshold; the model couldn't tell what
 * happened from the generic HTTP error.
 *
 * Autotask thresholds (per integration code, per hour):
 *   - ~10k req/hr soft (warning email, sporadic 429s)
 *   - ~20k req/hr hard (sustained 429s until the window rolls)
 */
export class AutotaskRateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'AutotaskRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Thrown when Autotask returns a 2xx (other than a legitimate 204 No Content)
 * whose body cannot be turned into a usable payload — an empty body where one
 * is expected, a body-read that aborted or errored mid-stream, or text that
 * fails to JSON.parse (the classic truncated-response case).
 *
 * This exists to FAIL CLOSED. The old behavior returned `undefined` here, which
 * `get()` turned into `null` (indistinguishable from a 404 / "not found") and
 * `query()` turned into `[]` (indistinguishable from "zero records"). During a
 * heavy Sanctuary Park build session that masqueraded as: project reads with no
 * payload, phase/task lookups returning zero for projects known to contain them,
 * and a just-created task reading back as absent — inviting duplicate creates on
 * rerun. A transient truncation/timeout must never be mistaken for real absence,
 * so we surface it as a distinct, retryable error instead. (Consolidated plan §2,
 * §29, §31.)
 */
export class AutotaskResponseError extends Error {
  readonly status: number;
  /** Payload-integrity failures are safe to retry — the request may have succeeded upstream. */
  readonly retryable = true;

  constructor(method: string, path: string, status: number, detail: string, cause?: unknown) {
    super(
      `Autotask ${method} ${path} returned HTTP ${status} but the response payload was unusable: ${detail}. ` +
        `Failing closed instead of returning an empty result, so a transient truncation/timeout is not ` +
        `mistaken for "not found" or "no records". This is safe to retry.`,
      cause !== undefined ? { cause } : undefined
    );
    this.name = 'AutotaskResponseError';
    this.status = status;
  }
}

/**
 * Per-request ceiling for a single Autotask REST call. Distant zones (e.g.
 * an Azure US region talking to the Sydney zone) add meaningful RTT, and
 * heavyweight requests (500-row query pages, entityInformation) can
 * legitimately run long — cutting them off early just wastes the work.
 * Callers above us (gateway, MCP client) enforce their own end-to-end
 * budgets, so this is a backstop against a truly hung connection, not the
 * primary timeout.
 */
const REQUEST_TIMEOUT_MS = 60_000;

// Default backoff when Autotask doesn't send a parseable Retry-After header.
// One minute is conservative: their thresholds reset on a rolling hour window,
// so waiting longer than a minute is rarely useful, and waiting less risks
// re-tripping while still over.
const DEFAULT_RETRY_AFTER_SECONDS = 60;

function parseRetryAfter(headerValue: string | null): number {
  if (!headerValue) return DEFAULT_RETRY_AFTER_SECONDS;
  // RFC 7231: either an integer count of seconds, or an HTTP-date.
  const asInt = Number.parseInt(headerValue, 10);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt;
  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) {
    return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
  }
  return DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * Per-tenant 429 cooldown gate, keyed by lowercased API username.
 *
 * Observed in production: LLM clients ignore the "Do NOT retry" text in the
 * rate-limit error and re-fire the same call within seconds, sending every
 * retry upstream into a tenant already over Autotask's hourly threshold —
 * which can extend the cooldown. Once a tenant gets a 429, we remember the
 * Retry-After deadline and fail every request for that tenant fast and
 * LOCALLY (no upstream call) until it passes. Retry-spamming then costs the
 * tenant nothing.
 *
 * Module-level and keyed by tenant credential (same isolation reasoning as
 * the zone cache): in gateway mode client instances are per-request, so an
 * instance-level gate would never trip across calls.
 */
const rateLimitCooldowns = new Map<string, number>();

/** Cap a bad/hostile Retry-After header so it can't lock a tenant out for long. */
const MAX_COOLDOWN_MS = 5 * 60 * 1000;

/** Seconds left in the tenant's 429 cooldown (0 = none) — backpressure state for dispatchers. */
export function rateLimitCooldownSeconds(tenant: string): number {
  const until = rateLimitCooldowns.get(tenant.toLowerCase());
  return until && until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
}

/**
 * Reset the cooldown gate. Intended for tests only.
 */
export function _resetRateLimitCooldowns(): void {
  rateLimitCooldowns.clear();
}

/**
 * Thrown when Autotask rejects the API credentials (HTTP 401), and for every
 * call made while the auth pause below is active (those never leave the MCP).
 */
export class AutotaskAuthError extends Error {
  readonly status = 401;
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'AutotaskAuthError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Per-tenant auth-failure pause ("circuit breaker"), keyed like the 429 gate.
 *
 * Why (2026-10-07): a mangled secret sent ~15 failed logins in seconds (each
 * 401 is retried once after a zone re-lookup) and Autotask LOCKED the API user
 * — taking production down, since n8n, cron and ChatGPT all share it. Every
 * further call against a locked or wrong credential is another failed login.
 *
 * So after a confirmed 401 the tenant is paused: calls fail fast locally.
 *
 * Hardened 2026-10-09 (the production user was locked again):
 *   - The FIRST 401 immediately sets a provisional pause, so requests that
 *     arrive while it is being checked are not sent, and requests already in
 *     flight that 401 too don't each run their own check (parallel lookups
 *     would otherwise multiply failed logins).
 *   - Before retrying, the zone is re-looked-up (unauthenticated); the request
 *     is retried only if the zone actually changed.
 *   - Limited automatic tests: after the first rejection, at most
 *     AUTOTASK_AUTH_MAX_PROBES (2) single test calls (after 5, then 10 min);
 *     when those fail too the tenant is HELD until an administrator presses
 *     "Retry now" — no more failed logins while a person fixes the account.
 *   - The pause is saved (Postgres, when configured) so restarts and deploys
 *     respect it. It is tied to a fingerprint of the credentials: changing the
 *     secret in the env file clears it automatically.
 * AUTOTASK_AUTH_PAUSE_SECONDS sets the first pause (0 disables the breaker).
 */
interface AuthBlock { since: number; until: number; failures: number; lastError: string; probeAt?: number; held?: boolean; provisional?: boolean; fp?: string }
const PROBE_WINDOW_MS = 90_000; // > REQUEST_TIMEOUT_MS: one probe at a time
const PROVISIONAL_MS = 60_000; // while the first 401 is being confirmed
const HELD_UNTIL = Number.MAX_SAFE_INTEGER;
const authBlocks = new Map<string, AuthBlock>();
const AUTH_PAUSE_MAX_MS = 60 * 60 * 1000;

function authPauseBaseMs(): number {
  const v = Number(process.env.AUTOTASK_AUTH_PAUSE_SECONDS);
  return (Number.isFinite(v) && v >= 0 ? v : 300) * 1000;
}
function authMaxProbes(): number {
  const v = Number(process.env.AUTOTASK_AUTH_MAX_PROBES);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2;
}

/** A saved pause (survives restarts). */
export interface PersistedAuthBlock { tenant: string; since: number; until: number | null; failures: number; lastError: string; held: boolean; fp: string | null }
export interface AuthBlockPersistence { save(tenant: string, block: PersistedAuthBlock | null): Promise<void> }
let persistence: AuthBlockPersistence | null = null;
export function setAuthBlockPersistence(p: AuthBlockPersistence | null): void { persistence = p; }

/** Load saved pauses at startup (before any Autotask call). */
export function restoreAuthBlocks(entries: PersistedAuthBlock[]): void {
  for (const e of entries) {
    authBlocks.set(e.tenant.toLowerCase(), { since: e.since, until: e.held ? HELD_UNTIL : (e.until ?? 0), failures: e.failures, lastError: e.lastError, held: e.held, ...(e.fp ? { fp: e.fp } : {}) });
  }
}

function persist(tenant: string): void {
  if (!persistence) return;
  const b = authBlocks.get(tenant);
  const row: PersistedAuthBlock | null = b && !b.provisional
    ? { tenant, since: b.since, until: b.held ? null : b.until, failures: b.failures, lastError: b.lastError, held: !!b.held, fp: b.fp ?? null }
    : null;
  persistence.save(tenant, row).catch(() => undefined); // best-effort: the in-memory pause still protects this process
}

/** Record a confirmed rejected login; returns the pause in seconds, -1 when now held, 0 when the breaker is disabled. */
function tripAuthBlock(tenant: string, detail: string, fp?: string): number {
  const base = authPauseBaseMs();
  if (base === 0) { authBlocks.delete(tenant); return 0; }
  const now = Date.now();
  const prev = authBlocks.get(tenant);
  // Calls already in flight when the pause started 401 too: don't escalate for those.
  if (prev && !prev.provisional && prev.until > now && prev.probeAt === undefined) return prev.held ? -1 : Math.ceil((prev.until - now) / 1000);
  const failures = (prev && !prev.provisional ? prev.failures : 0) + 1;
  const held = failures > authMaxProbes();
  const ms = Math.min(base * 2 ** (failures - 1), AUTH_PAUSE_MAX_MS);
  authBlocks.set(tenant, { since: prev && !prev.provisional ? prev.since : now, until: held ? HELD_UNTIL : now + ms, failures, lastError: detail.slice(0, 300), ...(held ? { held: true } : {}), ...(fp ? { fp } : {}) });
  persist(tenant);
  return held ? -1 : Math.ceil(ms / 1000);
}

export interface AuthBlockStatus { tenant: string; blockedUntil: string | null; since: string; failures: number; lastError: string; probing: boolean; held: boolean }

/** The tenant's auth pause, if any (also while waiting for the post-pause probe). Provisional checks are not reported. */
export function authBlockStatus(tenant: string): AuthBlockStatus | null {
  const b = authBlocks.get(tenant.toLowerCase());
  if (!b || b.provisional) return null;
  const active = b.until > Date.now();
  return { tenant: tenant.toLowerCase(), blockedUntil: active && !b.held ? new Date(b.until).toISOString() : null, since: new Date(b.since).toISOString(), failures: b.failures, lastError: b.lastError, probing: !active, held: !!b.held };
}

/** Clear a tenant's auth pause (admin console "Retry now", after fixing the account). */
export function clearAuthBlock(tenant: string): boolean {
  const t = tenant.toLowerCase();
  const had = authBlocks.delete(t);
  persist(t);
  return had;
}

/** Tests only. */
export function _resetAuthBlocks(): void { authBlocks.clear(); persistence = null; }

function assertSafeRelativePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('Autotask rawRequest: path must be a non-empty string');
  }
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    /:\/\//.test(path) ||
    path.includes('..')
  ) {
    throw new Error('Autotask rawRequest: path must be a relative path beginning with "/" (no scheme, host, or traversal)');
  }
}

/**
 * Minimal HTTP client for the Autotask REST API.
 *
 * All public methods:
 * - use the zone-resolved base URL (cached per-username via resolveAutotaskApiUrl)
 * - send the standard ApiIntegrationcode/UserName/Secret auth headers
 * - apply a 60-second timeout via AbortSignal.timeout (REQUEST_TIMEOUT_MS)
 * - throw an Error on non-2xx with the API error array when available
 */
export class AutotaskHttpClient {
  private resolvedBaseUrl: string | null = null;

  constructor(
    private readonly username: string,
    private readonly secret: string,
    private readonly integrationCode: string,
    private readonly apiUrl: string | undefined,
    private readonly logger: Logger
  ) {
    this.credFp = createHash('sha256').update(`${username.toLowerCase()}|${secret}|${integrationCode}`).digest('hex').slice(0, 16);
  }

  /** Fingerprint of the credentials: a saved auth pause applies only to the same ones. */
  private readonly credFp: string;

  /**
   * After a 401: is it the credentials (pause everything) or just this entity?
   * ThresholdInformation is readable by every API user, so a 401 there means the
   * login itself is rejected. Anything else (network error, 2xx) → not confirmed.
   */
  private async credentialsRejected(): Promise<boolean> {
    try {
      const url = `${await this.baseUrl()}/ThresholdInformation`;
      const logged = startApiCall('GET', url);
      const r = await fetch(url, { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(15_000) });
      logged(r.status);
      return r.status === 401;
    } catch {
      return false;
    }
  }

  private async baseUrl(): Promise<string> {
    if (this.resolvedBaseUrl) return this.resolvedBaseUrl;
    const url = await resolveAutotaskApiUrl(this.username, this.apiUrl, this.logger);
    // Normalize: strip trailing slashes and append /v1.0 root.
    this.resolvedBaseUrl = `${url.replace(/\/+$/, '')}/v1.0`;
    return this.resolvedBaseUrl;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ApiIntegrationcode: this.integrationCode,
      UserName: this.username,
      Secret: this.secret,
    };
    // Native Autotask impersonation (#42): when the current tool dispatch has a
    // resolved acting resource, tunnel the write on their behalf. Autotask
    // honors this on create/update and ignores it on reads. The id is only ever
    // present when AUTOTASK_IMPERSONATION is enabled and a caller was resolved,
    // and it is scoped per-request via AsyncLocalStorage (no cross-request leak).
    const impersonationResourceId = getImpersonationResourceId();
    if (impersonationResourceId != null) {
      headers.ImpersonationResourceId = String(impersonationResourceId);
    }
    return headers;
  }

  /**
   * Every Autotask call goes through here. READS (GET, POST …/query) are served
   * from the per-tenant read cache when fresh, share an identical in-flight
   * call, or go upstream once; WRITES go upstream and then invalidate the
   * cache (see http-cache.ts). Keyed by API user + impersonated identity.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    isZoneRetry = false,
    opts: { allowEmptyBody?: boolean; noCache?: boolean } = {}
  ): Promise<T> {
    const tenant = this.username.toLowerCase();
    if (isRead(method, path) && !opts.noCache) {
      const key = `${method.toUpperCase()} ${path} ${body === undefined ? '' : JSON.stringify(body)} imp=${getImpersonationResourceId() ?? ''}`;
      return cachedRead<T>(tenant, key, path, () => this.send<T>(method, path, body, isZoneRetry, opts));
    }
    const { value } = await this.send<T>(method, path, body, isZoneRetry, opts);
    invalidateAfterWrite(tenant, path);
    noteOperationWrite(method, path, body, value);
    if (writeListener) {
      try { writeListener(method.toUpperCase(), path, body, value); } catch { /* a listener must never fail a write */ }
    }
    return value;
  }

  /**
   * The actual upstream call. `path` is either a leading-slash path (resolved
   * against the zone base URL) or an absolute URL (used by
   * pageDetails.nextPageUrl pagination). Returns the parsed body plus its size
   * (for the cache's size cap).
   */
  /**
   * Per-endpoint concurrency gate in front of every upstream call. Autotask
   * allows 3 concurrent requests per integration per object endpoint and
   * answers the 4th with 429 (thread limiting). A burst of parallel searches
   * used to trip that; now calls beyond AUTOTASK_MAX_CONCURRENT_PER_ENDPOINT
   * (default 2 — one thread of headroom) WAIT their turn instead of failing.
   * Cached / coalesced reads never reach here, so they take no slot.
   */
  private async send<T>(
    method: string,
    path: string,
    body?: any,
    isZoneRetry = false,
    opts: { allowEmptyBody?: boolean } = {}
  ): Promise<{ value: T; bytes: number }> {
    const release = await acquireEndpointSlot(`${this.username.toLowerCase()} ${endpointOf(path)}`);
    try {
      return await this.sendUngated<T>(method, path, body, isZoneRetry, opts);
    } finally {
      release();
    }
  }

  private async sendUngated<T>(
    method: string,
    path: string,
    body?: unknown,
    isZoneRetry = false,
    opts: { allowEmptyBody?: boolean } = {}
  ): Promise<{ value: T; bytes: number }> {
    // Cooldown gate: while this tenant is inside a known 429 window, fail
    // fast locally instead of sending more requests upstream. See
    // rateLimitCooldowns.
    const cooldownKey = this.username.toLowerCase();
    // Auth pause: Autotask recently rejected these credentials — don't send
    // another failed login (each one counts toward locking the API user).
    let auth = authBlocks.get(cooldownKey);
    // A saved pause for DIFFERENT credentials (the secret was changed) no longer applies.
    if (auth?.fp && auth.fp !== this.credFp) { authBlocks.delete(cooldownKey); persist(cooldownKey); auth = undefined; }
    const probeBusy = auth?.probeAt !== undefined && Date.now() - auth.probeAt < PROBE_WINDOW_MS;
    if (auth && (auth.until > Date.now() || probeBusy)) {
      if (auth.provisional) {
        throw new AutotaskAuthError(`Autotask just rejected a request with HTTP 401; checking whether the API login itself is rejected — this call was NOT sent (to avoid locking the API user). Try again in a minute.`, 60);
      }
      const wait = auth.held ? 0 : Math.max(1, Math.ceil((Math.max(auth.until, (auth.probeAt ?? 0) + PROBE_WINDOW_MS) - Date.now()) / 1000));
      throw new AutotaskAuthError(
        `Autotask rejected this MCP's API credentials (HTTP 401) at ${new Date(auth.since).toISOString()}, so Autotask calls are ` +
        (auth.held ? `HELD until an administrator presses "Retry now" in the admin console (${auth.failures} rejected logins) ` : `paused for ${wait}s `) +
        `to avoid locking the API user — this call was NOT sent. Do NOT retry. An administrator must check the Autotask API user ` +
        `(locked out, or secret changed) and then use "Retry now" in the admin console. Last error: ${auth.lastError}`,
        wait,
      );
    }
    // After a pause this call is the single probe: no zone-retry, so a still-bad credential costs one failed login, not two.
    const probing = auth !== undefined;
    if (auth) auth.probeAt = Date.now(); // every other call waits for this probe's answer
    const cooldownUntil = rateLimitCooldowns.get(cooldownKey);
    if (cooldownUntil !== undefined) {
      const remainingSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (remainingSeconds > 0) {
        throw new AutotaskRateLimitError(
          `Autotask API threshold exceeded (HTTP 429) — this tenant is in a ${remainingSeconds}s cooldown and this call was NOT sent upstream. ` +
          `Do NOT retry until the cooldown passes; retries cannot succeed and querying again immediately only delays recovery. ` +
          `Wait ${remainingSeconds}s, or ask the user to narrow the workload (smaller date ranges, specific IDs).`,
          remainingSeconds,
        );
      }
      rateLimitCooldowns.delete(cooldownKey);
    }

    const url = path.startsWith('http') ? path : `${await this.baseUrl()}${path.startsWith('/') ? '' : '/'}${path}`;

    this.logger.debug(`Autotask HTTP ${method} ${url}`);
    recordUpstream(cooldownKey, method, path);
    const logged = startApiCall(method, path);

    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      response = await fetch(url, init);
      logged(response.status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logged(0, msg);
      throw new Error(`Autotask ${method} ${url} network error: ${msg}`, { cause: err });
    }

    if (response.status === 204) {
      return { value: undefined as unknown as T, bytes: 0 };
    }

    // Read the body defensively but do NOT silently swallow a read failure.
    // A body-read that rejects on a 2xx (e.g. the 60s AbortSignal fires
    // mid-stream, or the connection drops after headers arrive) previously
    // collapsed to '' → undefined → a misleading empty payload. We remember
    // the failure and fail closed below on the success path; on an error
    // response an unreadable body just means we have no detail to show.
    let text = '';
    let bodyReadError: unknown;
    try {
      text = await response.text();
    } catch (err) {
      bodyReadError = err;
    }

    if (!response.ok) {
      // A 401 against a relative (zone-resolved) path — as opposed to an
      // absolute pageDetails.nextPageUrl, which is already baked to a host
      // we can't safely rewrite — most often means our cached zone URL is
      // stale (e.g. a data-center migration moved this tenant to a new
      // zone after we cached the old one). Drop the cache and retry once
      // against a freshly-resolved zone before giving up.
      let detail = text.slice(0, 1000);
      try {
        const parsed = JSON.parse(text);
        if (parsed?.errors && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
          detail = parsed.errors.join('; ');
        }
      } catch {
        /* fall through with raw text */
      }
      if (response.status === 429) {
        recordRateLimited(cooldownKey);
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        // Arm the per-tenant cooldown gate so any further calls (including
        // LLM retry-spam and mapping-cache lookups) fail fast locally until
        // the window passes instead of piling onto the throttled tenant.
        rateLimitCooldowns.set(
          cooldownKey,
          Date.now() + Math.min(retryAfter * 1000, MAX_COOLDOWN_MS),
        );
        // Single-line message that LLMs will read verbatim — instruct against
        // retry, surface the wait, point at the underlying issue. The structured
        // `retryAfterSeconds` field lets handlers do programmatic things too.
        throw new AutotaskRateLimitError(
          `Autotask API threshold exceeded (HTTP 429). Do NOT retry this call automatically — ` +
          `the next ${retryAfter}s will likely hit 429 again, and repeated retries can extend the ` +
          `cooldown. Ask the user to scope the query (e.g. narrow date range, filter by company/ticket ID) ` +
          `or wait ${retryAfter}s before trying again. Detail: ${detail}`,
          retryAfter,
        );
      }
      if (response.status === 401 && authPauseBaseMs() > 0) {
        const existing = authBlocks.get(cooldownKey);
        // Another request is already checking, or the tenant is paused: don't spend another failed login on a check.
        if (existing && !probing) {
          throw new AutotaskAuthError(`Autotask rejected this request (HTTP 401) while the API login is being checked or is paused — not retried, to avoid locking the API user.`, 60);
        }
        // First 401: stop every other request right now while this one is checked.
        if (!probing) authBlocks.set(cooldownKey, { since: Date.now(), until: Date.now() + PROVISIONAL_MS, failures: 0, lastError: 'checking', provisional: true });
        // A stale zone (tenant moved data centre) also answers 401: re-look it up (unauthenticated) and retry only if it changed.
        if (!probing && !isZoneRetry && !path.startsWith('http')) {
          const before = this.resolvedBaseUrl;
          this.resolvedBaseUrl = null;
          invalidateZoneUrlCache(this.username);
          let after: string | null = null;
          try { after = await this.baseUrl(); } catch { /* keep checking below */ }
          if (after && before && after !== before) {
            this.logger.warn(`Autotask zone for ${this.username} changed (${before} → ${after}) — retrying once`);
            authBlocks.delete(cooldownKey);
            return this.sendUngated<T>(method, path, body, true, opts); // already holds the endpoint slot
          }
        }
        // Pause only when the LOGIN is rejected, not one entity: confirm with ThresholdInformation (readable by every API user).
        const rejected = probing || /ThresholdInformation/i.test(path) || await this.credentialsRejected();
        if (rejected) {
          const pause = tripAuthBlock(cooldownKey, `HTTP 401 on ${method} ${path.split('?')[0]}: ${detail}`, this.credFp);
          if (pause !== 0) {
            const how = pause < 0 ? 'HELD until an administrator presses "Retry now" in the admin console' : `paused for ${pause}s`;
            this.logger.error(`Autotask rejected the API credentials for ${this.username} (HTTP 401) — Autotask calls ${how} to avoid locking the account`);
            throw new AutotaskAuthError(
              `Autotask rejected this MCP's API credentials (HTTP 401): ${(detail || 'unauthorized').replace(/\.+$/, '')}. Autotask calls are now ${how} so repeated ` +
              `failed logins don't lock the API user. Do NOT retry. An administrator must check the Autotask API user (locked out, or secret changed).`,
              pause < 0 ? 0 : pause,
            );
          }
        } else if (authBlocks.get(cooldownKey)?.provisional) {
          authBlocks.delete(cooldownKey); // only this entity is refused — the login works
        }
      }
      const httpError = new Error(`Autotask ${method} ${path} failed: HTTP ${response.status}: ${detail}`);
      // Attach the numeric status so callers can branch on it reliably instead
      // of substring-matching the message (the message embeds the response body,
      // which can coincidentally contain a status-like number).
      (httpError as Error & { status?: number }).status = response.status;
      throw httpError;
    }

    // Credentials work again: end any auth pause.
    if (probing && authBlocks.delete(cooldownKey)) { persist(cooldownKey); this.logger.info(`Autotask accepted the API credentials for ${this.username} again — auth pause cleared`); }
    else if (authBlocks.get(cooldownKey)?.provisional) authBlocks.delete(cooldownKey); // a request succeeded: the login works

    // Success path — fail closed on any payload anomaly (plan §2/§29/§31).
    // A body-read failure on a 2xx is always an anomaly.
    if (bodyReadError !== undefined) {
      const msg = bodyReadError instanceof Error ? bodyReadError.message : String(bodyReadError);
      throw new AutotaskResponseError(method, path, response.status, `response body could not be read (${msg})`, bodyReadError);
    }
    if (!text) {
      // Writes (update/delete) legitimately answer some 2xx with an empty body;
      // they opt in via allowEmptyBody. For reads/creates an empty 2xx body is
      // an anomaly, not "not found" (404) or "no records" (an empty items array).
      if (opts.allowEmptyBody) return { value: undefined as unknown as T, bytes: 0 };
      throw new AutotaskResponseError(method, path, response.status, 'empty response body on a successful (non-204) response');
    }
    try {
      return { value: JSON.parse(text) as T, bytes: text.length };
    } catch (err) {
      // Non-empty body that will not parse is the truncation signature — the
      // exact case §2 calls out ("transport, or truncation loses the payload").
      // Never downgrade this to an empty result.
      throw new AutotaskResponseError(
        method,
        path,
        response.status,
        `response body was not valid JSON — likely truncated (${text.length} bytes received)`,
        err
      );
    }
  }

  /** Autotask's own live request counter for this integration (never cached). */
  async thresholdInformation(): Promise<{ externalRequestThreshold?: number; requestThresholdTimeframe?: number; currentTimeframeRequestCount?: number }> {
    return this.request('GET', '/ThresholdInformation');
  }

  /**
   * Generic passthrough for any Autotask REST endpoint. The escape hatch is
   * tool-callable, so auth headers must only ever go to the zone-resolved
   * host — validation, method allowlist, and a final host assertion enforce
   * that independently.
   */
  async rawRequest<T = any>(
    method: string,
    path: string,
    body?: any,
    queryParams?: Record<string, string | number | boolean>
  ): Promise<T> {
    const upperMethod = method.toUpperCase();
    if (!(RAW_REQUEST_METHODS as readonly string[]).includes(upperMethod)) {
      throw new Error(`Autotask rawRequest: method must be one of ${RAW_REQUEST_METHODS.join(', ')}`);
    }
    assertSafeRelativePath(path);

    let finalPath = path;
    if (queryParams && Object.keys(queryParams).length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined && v !== null) params.append(k, String(v));
      }
      const qs = params.toString();
      if (qs) {
        finalPath = `${finalPath}${finalPath.includes('?') ? '&' : '?'}${qs}`;
      }
    }

    // Plain reads (POST /Entity/query, GET /Entity/{id}) are offered to the
    // Postgres shadow like any other read. A query is answered only when the
    // shadow holds the WHOLE result within the page size (asked for one extra
    // row), so callers that page by nextPageUrl still get Autotask's real link.
    if (readInterceptor && finalPath === path && getImpersonationResourceId() === undefined) {
      const tenant = this.username.toLowerCase();
      const q = /^\/([A-Za-z]+)\/query$/.exec(path);
      const b = body as { filter?: unknown; MaxRecords?: unknown; maxRecords?: unknown; IncludeFields?: unknown; includeFields?: unknown } | undefined;
      if (upperMethod === 'POST' && q && Array.isArray(b?.filter)) {
        const limit = Math.min(Math.max(Number(b!.MaxRecords ?? b!.maxRecords) || AUTOTASK_MAX_PAGE_SIZE, 1), AUTOTASK_MAX_PAGE_SIZE);
        const rows = await readInterceptor.query(tenant, q[1]!, b!.filter as QueryFilter[], limit + 1).catch(() => null);
        if (rows && rows.length <= limit) {
          const fields = (b!.IncludeFields ?? b!.includeFields) as string[] | undefined;
          return { items: project(rows, Array.isArray(fields) ? fields : undefined), pageDetails: { count: rows.length, requestCount: limit, prevPageUrl: null, nextPageUrl: null } } as T;
        }
      }
      const g = /^\/([A-Za-z]+)\/(\d+)$/.exec(path);
      if (upperMethod === 'GET' && g) {
        const hit = await readInterceptor.get(tenant, g[1]!, Number(g[2])).catch(() => undefined);
        if (hit != null) return { item: hit } as T;
      }
    }

    const base = await this.baseUrl();
    const absoluteUrl = `${base}${finalPath}`;
    if (new URL(absoluteUrl).host !== new URL(base).host) {
      throw new Error('Autotask rawRequest: refusing to send to non-zone host');
    }

    return this.request<T>(upperMethod, absoluteUrl, body);
  }

  /**
   * A write on a relative Autotask path (POST / PATCH / DELETE), for the integration API. Never answered from the
   * mirror or the cache. A DELETE may answer with an empty 2xx; a create / update must return a usable body.
   */
  async write<T = unknown>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    assertSafeRelativePath(path);
    return this.request<T>(method, path, body, false, { allowEmptyBody: method === 'DELETE' });
  }

  /**
   * GET /{Entity}/{id} — returns the entity, or null on 404.
   */
  async get<T>(entity: string, id: number): Promise<T | null> {
    if (readInterceptor && getImpersonationResourceId() === undefined) {
      const hit = await readInterceptor.get(this.username.toLowerCase(), entity, id).catch(() => undefined);
      if (hit != null) return hit as T;
    }
    try {
      const res = await this.request<{ item?: T } & T>('GET', `/${entity}/${id}`);
      return unwrapEntity<T>(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('HTTP 404')) return null;
      throw err;
    }
  }

  /**
   * GET /{Entity}/{id} with a bounded retry for read-after-write verification
   * (plan §2). Autotask can briefly return 404 for an entity that was just
   * created (replication lag between the write node and the read node), so a
   * single read immediately after a create can falsely report "not found".
   *
   * This retries ONLY on a genuine null (not-yet-visible). It does NOT retry a
   * payload anomaly: get() now throws AutotaskResponseError on a truncated/empty
   * 2xx, and that propagates immediately — a corrupt response is a real error to
   * surface, not a lag to wait out. Returns the entity once visible, or null if
   * it never appears within the attempt budget (the caller decides what an
   * unverified-but-created result means — for creates, the itemId is already
   * authoritative, so this is confirmation, not the source of truth).
   *
   * Delays are linear (delayMs, 2·delayMs, …); the first read is immediate, so
   * the common case (entity already visible) costs nothing extra.
   */
  async getWithRetry<T>(
    entity: string,
    id: number,
    opts: { attempts?: number; delayMs?: number } = {}
  ): Promise<T | null> {
    const attempts = Math.max(1, Math.floor(opts.attempts ?? 4));
    const delayMs = Math.max(0, Math.floor(opts.delayMs ?? 250));
    let found: T | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      found = await this.get<T>(entity, id);
      if (found !== null) return found;
      if (attempt < attempts - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
    return found;
  }

  /**
   * POST /{Entity}/query — handles pagination transparently via nextPageUrl.
   *
   * `opts.maxRecords` is the TOTAL CAP — the caller's "stop after this many
   * rows" budget across the whole pagination walk. The PER-PAGE size sent in
   * the request body (`MaxRecords`) is a separate concept: Autotask rejects
   * any value outside [1, AUTOTASK_MAX_PAGE_SIZE] with
   * HTTP 500 "maxCountOfRecordsToReturn must be between 1 and 500". The
   * per-page size is therefore clamped to `min(maxRecords, AUTOTASK_MAX_PAGE_SIZE)`
   * regardless of how large the caller's total cap is, and the walk keeps
   * following `pageDetails.nextPageUrl` until exhausted or `items.length`
   * reaches the total cap.
   *
   * Pass an empty filter array to request "all rows" — the caller is expected
   * to supply the Autotask-required `{op:'gte', field:'id', value:0}` sentinel
   * if they actually want to fetch everything.
   */
  async query<T>(
    entity: string,
    filter: QueryFilter[],
    opts: QueryOptions = {}
  ): Promise<T[]> {
    const totalCap = opts.maxRecords ?? AUTOTASK_MAX_PAGE_SIZE;
    const pageSize = Math.min(totalCap, AUTOTASK_MAX_PAGE_SIZE);
    const body: Record<string, any> = {
      filter,
      MaxRecords: pageSize,
    };
    if (opts.includeFields && opts.includeFields.length > 0) {
      body.IncludeFields = opts.includeFields;
    }

    if (readInterceptor && !opts.noCache && totalCap <= SHADOW_MAX_ROWS && getImpersonationResourceId() === undefined) {
      const rows = await readInterceptor.query(this.username.toLowerCase(), entity, filter, totalCap).catch(() => null);
      if (rows) return project<T>(rows, opts.includeFields);
    }

    const items: T[] = [];
    const reqOpts = opts.noCache ? { noCache: true } : {};
    let resp = await this.request<QueryResponse<T>>('POST', `/${entity}/query`, body, false, reqOpts);
    if (resp?.items) items.push(...resp.items);

    while (
      resp?.pageDetails?.nextPageUrl &&
      items.length < totalCap
    ) {
      // Autotask's thread-safe pagination returns nextPageUrl as
      // `/{entity}/query/next?paging=...` and requires the SAME POST + filter
      // body as the initial query; a GET returns HTTP 405 ("does not support
      // http method 'GET'"), which silently truncates large result sets (e.g.
      // the company name cache never loads past the first page).
      resp = await this.request<QueryResponse<T>>('POST', resp.pageDetails.nextPageUrl, body, false, reqOpts);
      if (resp?.items) items.push(...resp.items);
    }

    return items.slice(0, totalCap);
  }

  /**
   * Query an entity for records whose `field` is one of `ids`, batching the IDs
   * into `in`-filter chunks (brief §7.19). Autotask's own hourly workflow chunks
   * ID lists into groups of 200 before querying (e.g. ServiceCallTickets by
   * serviceCallID, Tickets by id); this centralizes that so callers pass the
   * whole list and get merged results back.
   *
   * - IDs are deduplicated and deterministically sorted, so the chunk set — and
   *   thus the requests issued — are stable across calls.
   * - Chunks run with bounded concurrency to stay under Autotask's thread limit.
   * - Each chunk paginates fully (via query()); the per-chunk cap defaults high
   *   so a foreign-key `in` (one parent → many rows) isn't truncated at 500.
   * - Results are deduplicated by `id`.
   * - A failed chunk does NOT abort the batch: its IDs and error are returned in
   *   `failedChunks` so the caller decides whether the partial result is usable.
   */
  async queryByIds<T>(
    entity: string,
    field: string,
    ids: ReadonlyArray<number | string>,
    opts: QueryByIdsOptions = {}
  ): Promise<BatchedQueryResult<T>> {
    const unique = Array.from(new Set(ids));
    unique.sort((a, b) =>
      typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
    );

    if (unique.length === 0) {
      return { items: [], failedChunks: [] };
    }

    const chunkSize = Math.max(1, Math.floor(opts.chunkSize ?? 200));
    const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));

    const chunks: Array<Array<number | string>> = [];
    for (let i = 0; i < unique.length; i += chunkSize) {
      chunks.push(unique.slice(i, i + chunkSize));
    }

    // Per-chunk total cap defaults high so an `in` over a foreign key
    // paginates through ALL matches rather than stopping at query()'s 500 default.
    const perChunkOpts: QueryOptions = { maxRecords: opts.maxRecords ?? 100_000 };
    if (opts.includeFields && opts.includeFields.length > 0) {
      perChunkOpts.includeFields = opts.includeFields;
    }

    const settled = await mapWithConcurrency(chunks, concurrency, (chunk) =>
      this.query<T>(entity, [{ op: 'in', field, value: chunk }], perChunkOpts)
    );

    const items: T[] = [];
    const failedChunks: Array<{ ids: Array<number | string>; error: string }> = [];
    const seen = new Set<unknown>();

    settled.forEach((res, idx) => {
      if (res.status === 'fulfilled') {
        for (const row of res.value) {
          const rowId = (row as { id?: unknown })?.id;
          if (rowId !== undefined) {
            if (seen.has(rowId)) continue;
            seen.add(rowId);
          }
          items.push(row);
        }
      } else {
        const reason = res.reason;
        failedChunks.push({
          ids: chunks[idx],
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    });

    return { items, failedChunks };
  }

  /**
   * POST /{Entity} — returns the created itemId.
   */
  async create(entity: string, body: any): Promise<number> {
    const res = await this.request<{ itemId?: number; item?: { id?: number }; id?: number }>(
      'POST',
      `/${entity}`,
      body
    );
    const id = res?.itemId ?? res?.item?.id ?? res?.id;
    if (typeof id !== 'number') {
      throw new Error(`Autotask create ${entity}: response did not include an itemId`);
    }
    return id;
  }

  /**
   * POST /{Entity} for entities whose create answers 2xx WITHOUT an itemId —
   * ContractServiceAdjustments / ContractServiceBundleAdjustments (verified live
   * 2026-10-11: the adjustment is applied, the response carries no id; nothing on
   * them is queryable either). Returns the id when there is one, else null; the
   * caller verifies the write by its effect. Errors still throw.
   */
  async createWithoutId(entity: string, body: any): Promise<{ id: number | null; response: unknown }> {
    const res = await this.request<{ itemId?: number | null; item?: { id?: number }; id?: number }>('POST', `/${entity}`, body, false, { allowEmptyBody: true });
    const id = res?.itemId ?? res?.item?.id ?? res?.id;
    return { id: typeof id === 'number' ? id : null, response: res ?? null };
  }

  /**
   * PATCH /{Entity} with body `{id, ...fields}`. This is the Autotask update
   * pattern — there is NO PATCH /{Entity}/{id} route (the SDK's default
   * generates one and gets 405 Method Not Allowed for every update).
   *
   * Zone DE1 (Zone 18) is an exception: its IIS instance does not register the
   * collection-level PATCH route at all and returns an HTML 404 (issue #133).
   * When that happens we fall back to `PUT /{Entity}/{id}`, which Autotask
   * supports universally across zones. The fallback is gated strictly on a 404
   * status so genuine validation errors (400/422) still surface to the caller.
   */
  async update(entity: string, id: number, body: Record<string, any>, opts: { putBody?: Record<string, any> } = {}): Promise<void> {
    try {
      await this.request<void>('PATCH', `/${entity}`, { id, ...body }, false, { allowEmptyBody: true });
    } catch (err) {
      if ((err as { status?: number })?.status === 404) {
        this.logger.debug(
          `Autotask PATCH /${entity} returned 404 (likely Zone DE1) — retrying as PUT /${entity}/${id}`
        );
        // PUT replaces the whole record: callers that can, pass the full merged record (putBody).
        await this.request<void>('PUT', `/${entity}/${id}`, opts.putBody ?? body, false, { allowEmptyBody: true });
        return;
      }
      throw err;
    }
  }

  /**
   * DELETE /{Entity}/{id}
   */
  async delete(entity: string, id: number): Promise<void> {
    await this.request<void>('DELETE', `/${entity}/${id}`, undefined, false, { allowEmptyBody: true });
  }

  /**
   * GET /{Entity}/entityInformation/fields — returns the raw { fields: [...] } shape.
   */
  /** POST /{Entity}/query/count — how many records match (never cached, never answered by the shadow). */
  async count(entity: string, filter: QueryFilter[]): Promise<number | null> {
    const res = await this.request<{ queryCount?: number; count?: number }>('POST', `/${entity}/query/count`, { filter }, false, { noCache: true });
    const n = res?.queryCount ?? res?.count;
    return typeof n === 'number' ? n : null;
  }

  async fieldInfo(entity: string): Promise<{ fields: any[] }> {
    const res = await this.request<{ fields?: any[]; items?: any[] }>(
      'GET',
      `/${entity}/entityInformation/fields`
    );
    return { fields: res?.fields || res?.items || [] };
  }

  /**
   * GET /{Entity}/entityInformation/userDefinedFields — the entity's UDF
   * definitions, list UDFs with their picklistValues (cached as metadata).
   */
  async udfInfo(entity: string): Promise<{ fields: UdfDefinition[] }> {
    const res = await this.request<{ fields?: UdfDefinition[]; items?: UdfDefinition[] }>(
      'GET',
      `/${entity}/entityInformation/userDefinedFields`
    );
    return { fields: res?.fields || res?.items || [] };
  }

  /**
   * Picklist values for a specific field. Autotask typically embeds picklist
   * values inline inside the field info response, so we derive them from
   * fieldInfo() rather than hitting a separate endpoint (which does not exist
   * uniformly across entities).
   */
  async picklistValues(entity: string, fieldName: string): Promise<any[]> {
    const { fields } = await this.fieldInfo(entity);
    const match = fields.find((f: any) => f?.name === fieldName);
    return match?.picklistValues || [];
  }

  /**
   * GET /{ParentEntity}/{parentId}/{ChildEntity}/{childId}
   */
  async childGet<T>(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    childId: number
  ): Promise<T | null> {
    try {
      const res = await this.request<{ item?: T } & T>(
        'GET',
        `/${parentEntity}/${parentId}/${childEntity}/${childId}`
      );
      return unwrapEntity<T>(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('HTTP 404')) return null;
      throw err;
    }
  }

  /**
   * POST /{ParentEntity}/{parentId}/{ChildEntity}/query — child collection query.
   * Falls back to GET (no /query suffix) if POST returns 404, since some child
   * entities (Notes, Attachments) don't support the /query endpoint.
   */
  async childQuery<T>(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    filter: QueryFilter[],
    opts: QueryOptions = {}
  ): Promise<T[]> {
    // Per-page size sent to Autotask must respect AUTOTASK_MAX_PAGE_SIZE.
    // childQuery does not walk nextPageUrl, so the request gets at most a
    // single page; clamping is the only thing that matters here.
    const pageSize = Math.min(opts.maxRecords ?? AUTOTASK_MAX_PAGE_SIZE, AUTOTASK_MAX_PAGE_SIZE);
    const body: Record<string, any> = {
      filter,
      MaxRecords: pageSize,
    };
    if (opts.includeFields && opts.includeFields.length > 0) {
      body.IncludeFields = opts.includeFields;
    }
    try {
      const res = await this.request<QueryResponse<T>>(
        'POST',
        `/${parentEntity}/${parentId}/${childEntity}/query`,
        body
      );
      return res?.items || [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('HTTP 404')) {
        // Fallback: GET /{Parent}/{id}/{Child} returns { items: [...] }
        const res = await this.request<QueryResponse<T>>(
          'GET',
          `/${parentEntity}/${parentId}/${childEntity}`
        );
        return res?.items || [];
      }
      throw err;
    }
  }

  /**
   * POST /{ParentEntity}/{parentId}/{ChildEntity} — create a child entity under a parent.
   */
  async childCreate(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    body: any
  ): Promise<number> {
    const res = await this.request<{ itemId?: number; item?: { id?: number }; id?: number }>(
      'POST',
      `/${parentEntity}/${parentId}/${childEntity}`,
      body
    );
    const id = res?.itemId ?? res?.item?.id ?? res?.id;
    if (typeof id !== 'number') {
      throw new Error(
        `Autotask child create ${parentEntity}/${parentId}/${childEntity}: response did not include an itemId`
      );
    }
    return id;
  }

  /**
   * PATCH /{ParentEntity}/{parentId}/{ChildEntity} with `{id, ...fields}` — child update.
   */
  async childUpdate(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    id: number,
    body: Record<string, any>
  ): Promise<void> {
    await this.request<void>(
      'PATCH',
      `/${parentEntity}/${parentId}/${childEntity}`,
      { id, ...body },
      false,
      { allowEmptyBody: true }
    );
  }

  /**
   * DELETE /{ParentEntity}/{parentId}/{ChildEntity}/{childId}
   */
  async childDelete(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    childId: number
  ): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/${parentEntity}/${parentId}/${childEntity}/${childId}`,
      undefined,
      false,
      { allowEmptyBody: true }
    );
  }
}
