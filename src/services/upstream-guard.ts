// Upstream guard (spec §24, cross-cutting performance): what sits around every Autotask call
// besides the per-endpoint gate (autotask-http.ts), the 429 cooldown and the login pause.
//
// - Concurrency caps: a TENANT-wide cap on calls in flight (AUTOTASK_MAX_CONCURRENT_TOTAL,
//   default 8) and a PER-CALLER cap (MCP_MAX_CONCURRENT_PER_CALLER, default 4) keyed by the
//   tool call's source + user, so one chat burst can't take every slot from the dispatchers.
//   Extra calls queue, they don't fail. Background work (shadow sync, bulk worker) has no
//   caller and only counts toward the tenant cap.
// - Transient retry: a READ (GET, POST …/query) that fails with a network error, a timeout or
//   HTTP 502 / 503 / 504 is retried up to AUTOTASK_READ_RETRIES (2) times
//   with exponential backoff and full jitter, its slots released while it waits. (A truncated 2xx body
//   is NOT retried here: it fails closed as AutotaskResponseError and the caller decides.) Writes are
//   never retried (they may have landed), and neither is HTTP 500 — Autotask answers
//   validation errors with 500, so a retry would only repeat them.
// - Outage breaker, PER ENDPOINT: AUTOTASK_OUTAGE_FAILURES (5) transient failures within 60 s on
//   one endpoint (Quotes, Opportunities, …) open ITS breaker for 30 s (doubling up to 5 min while
//   failures continue): calls to it fail LOCALLY with a retryable AutotaskOutageError, while every
//   other module carries on. Only when the failures span TENANT_SPREAD (3) or more endpoints does the
//   whole tenant count as down. Then one probe call goes through; success closes it.

export interface Gate { active: number; waiting: Array<() => void> }

const envInt = (name: string, d: number, min: number, max: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};
export const maxTotal = () => envInt('AUTOTASK_MAX_CONCURRENT_TOTAL', 8, 1, 64);
export const maxPerCaller = () => envInt('MCP_MAX_CONCURRENT_PER_CALLER', 4, 1, 64);
export const readRetries = () => envInt('AUTOTASK_READ_RETRIES', 2, 0, 5);
const outageFailures = () => envInt('AUTOTASK_OUTAGE_FAILURES', 5, 2, 100);

/** Wait for a slot on a gate; resolves to its release (idempotent). */
export async function acquire(g: Gate, max: number): Promise<() => void> {
  if (g.active >= max) await new Promise<void>((resolve) => g.waiting.push(resolve));
  g.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    g.active--;
    g.waiting.shift()?.();
  };
}

const tenantGates = new Map<string, Gate>();
const callerGates = new Map<string, Gate>();
const gate = (m: Map<string, Gate>, k: string) => m.get(k) ?? m.set(k, { active: 0, waiting: [] }).get(k)!;

/** Tenant cap, then the caller's (fixed order, so two gates can't deadlock). */
export async function acquireUpstream(tenant: string, caller: string | null): Promise<() => void> {
  const releaseCaller = caller ? await acquire(gate(callerGates, `${tenant} ${caller}`), maxPerCaller()) : () => {};
  let releaseTenant: () => void;
  try {
    releaseTenant = await acquire(gate(tenantGates, tenant), maxTotal());
  } catch (e) { releaseCaller(); throw e; }
  return () => { releaseTenant(); releaseCaller(); };
}

/** Calls waiting on the tenant / caller caps (for backpressure). */
export function upstreamQueueDepth(): number {
  let n = 0;
  for (const g of tenantGates.values()) n += g.waiting.length;
  for (const g of callerGates.values()) n += g.waiting.length;
  return n;
}

// ── transient failures ──

/**
 * Network error, timeout or 502/503/504. Never 500, 4xx, 401, 429 — and not a truncated / empty 2xx body
 * (AutotaskResponseError): that stays fail-closed for the caller to decide (read-after-write relies on it).
 */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { status?: number; transient?: boolean; name: string };
  if (e.transient === true) return true;
  return e.status === 502 || e.status === 503 || e.status === 504;
}

/** Full-jitter exponential backoff: random in [0, min(cap, base·2^attempt)]. */
export function backoffMs(attempt: number, random: () => number = Math.random, base = 500, cap = 4000): number {
  return Math.floor(random() * Math.min(cap, base * 2 ** attempt));
}

// ── outage breaker ──

export class AutotaskOutageError extends Error {
  readonly retryable = true;
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'AutotaskOutageError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface Breaker { failures: Array<{ t: number; ep: string }>; openUntil: number; openMs: number; probing: boolean; lastError: string; openedAt: number }
const breakers = new Map<string, Breaker>();
const WINDOW_MS = 60_000;
const FIRST_OPEN_MS = 30_000;
const MAX_OPEN_MS = 5 * 60_000;
/** Distinct endpoints failing within the window before the WHOLE tenant counts as down. */
export const TENANT_SPREAD = 3;
const ALL = '*';
const keyOf = (tenant: string, ep: string) => `${tenant} ${ep || '?'}`;
const breaker = (k: string) => breakers.get(k) ?? breakers.set(k, { failures: [], openUntil: 0, openMs: 0, probing: false, lastError: '', openedAt: 0 }).get(k)!;

function guard(k: string, label: string, now: number): void {
  const b = breakers.get(k);
  if (!b || b.openUntil === 0) return;
  // A probe that never reported back (aborted locally) frees the next one after a minute.
  if (now < b.openUntil || (b.probing && now < b.openUntil + 60_000)) {
    const s = Math.max(1, Math.ceil((b.openUntil - now) / 1000));
    throw new AutotaskOutageError(
      `${label} looks unavailable (${outageFailures()} or more network errors / 5xx answers within a minute; last: ${b.lastError}). ` +
      `This call was NOT sent. Retry after ${s}s — the MCP lets one test call through then.` +
      (label === 'Autotask' ? '' : ' Other Autotask modules are not affected; carry on with work that does not need this one.'), s);
  }
  b.probing = true; // half-open: this call is the probe
}

/**
 * Throws while the breaker is open for the whole tenant or for this endpoint (e.g. Quotes during a
 * module outage); lets ONE probe through once it has run out. Module outages are real (a 19-minute
 * Quotes / Opportunities outage stalled a signed proposal), so one failing module never stops the rest.
 */
export function checkBreaker(tenant: string, endpoint: string, now = Date.now()): void {
  guard(keyOf(tenant, ALL), 'Autotask', now);
  guard(keyOf(tenant, endpoint), `Autotask's ${endpoint || 'API'} endpoint`, now);
}

/** Autotask answered on this endpoint (any HTTP status but 502/503/504): it, and the tenant, are up. */
export function recordSuccess(tenant: string, endpoint: string): void {
  breakers.delete(keyOf(tenant, endpoint));
  breakers.delete(keyOf(tenant, ALL));
}

function fail(b: Breaker, message: string, now: number, ep: string, opensAt: (b: Breaker) => boolean): void {
  b.lastError = message.slice(0, 200);
  if (b.probing) {
    // The probe failed: open again, twice as long.
    b.probing = false;
    b.openMs = Math.min(MAX_OPEN_MS, Math.max(FIRST_OPEN_MS, b.openMs * 2));
    b.openUntil = now + b.openMs;
    return;
  }
  b.failures = [...b.failures.filter((f) => now - f.t < WINDOW_MS), { t: now, ep }];
  if (b.openUntil === 0 && opensAt(b)) {
    b.openedAt = now;
    b.openMs = FIRST_OPEN_MS;
    b.openUntil = now + b.openMs;
  }
}

export function recordTransientFailure(tenant: string, endpoint: string, message: string, now = Date.now()): void {
  const enough = (b: Breaker) => b.failures.length >= outageFailures();
  fail(breaker(keyOf(tenant, endpoint)), message, now, endpoint, enough);
  // The whole tenant only when the failures span several modules — a single module's outage stays local.
  fail(breaker(keyOf(tenant, ALL)), message, now, endpoint, (b) => enough(b) && new Set(b.failures.map((f) => f.ep)).size >= TENANT_SPREAD);
}

const secondsLeft = (b: Breaker | undefined, now: number) => (b && b.openUntil > now ? Math.ceil((b.openUntil - now) / 1000) : 0);

/** Seconds left on the TENANT-wide breaker (0 = closed or ready for its probe). */
export function outageSeconds(tenant: string, now = Date.now()): number {
  return secondsLeft(breakers.get(keyOf(tenant, ALL)), now);
}

export interface OutageStatus {
  /** Seconds the calls still fail locally (0 = the pause is over). */
  seconds: number;
  /** The pause is over but no call has got through yet: Autotask is not confirmed back. */
  awaitingTest: boolean;
  /** When the breaker opened (ISO). */
  since: string;
  /** Network errors / 5xx answers counted in the last minute. */
  failures: number;
  /** The modules (endpoints) that failed, most failures first. */
  endpoints: string[];
  lastError: string;
}

/**
 * The tenant-wide outage breaker in detail, or null when it is closed. It stays non-null after
 * its pause runs out until a call gets through (recordSuccess) — only that confirms Autotask is back.
 */
export function outageStatus(tenant: string, now = Date.now()): OutageStatus | null {
  const b = breakers.get(keyOf(tenant, ALL));
  if (!b || b.openUntil === 0) return null;
  const recent = b.failures.filter((f) => now - f.t < WINDOW_MS);
  const counts = new Map<string, number>();
  for (const f of (recent.length ? recent : b.failures)) counts.set(f.ep || '?', (counts.get(f.ep || '?') ?? 0) + 1);
  const seconds = secondsLeft(b, now);
  return {
    seconds, awaitingTest: seconds === 0, since: new Date(b.openedAt || now).toISOString(), failures: recent.length,
    endpoints: [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([ep]) => ep),
    lastError: b.lastError,
  };
}

/** Seconds left for this endpoint — the tenant-wide breaker included. */
export function endpointOutageSeconds(tenant: string, endpoint: string, now = Date.now()): number {
  return Math.max(outageSeconds(tenant, now), secondsLeft(breakers.get(keyOf(tenant, endpoint)), now));
}

/** Endpoints whose own breaker is open (module outages), for backpressure. */
export function endpointOutages(tenant: string, now = Date.now()): Array<{ endpoint: string; seconds: number }> {
  const out: Array<{ endpoint: string; seconds: number }> = [];
  const prefix = `${tenant} `;
  for (const [k, b] of breakers) {
    const ep = k.startsWith(prefix) ? k.slice(prefix.length) : null;
    if (ep == null || ep === ALL) continue;
    const s = secondsLeft(b, now);
    if (s > 0) out.push({ endpoint: ep, seconds: s });
  }
  return out.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}

/** Tests only. */
export function _resetUpstreamGuard(): void { tenantGates.clear(); callerGates.clear(); breakers.clear(); }
