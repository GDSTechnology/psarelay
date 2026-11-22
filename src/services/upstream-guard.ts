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
// - Outage breaker: AUTOTASK_OUTAGE_FAILURES (5) transient failures within 60 s open the
//   breaker for 30 s (doubling up to 5 min while failures continue): calls fail LOCALLY with a
//   retryable AutotaskOutageError. Then one probe call goes through; success closes it.

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

interface Breaker { failures: number[]; openUntil: number; openMs: number; probing: boolean; lastError: string }
const breakers = new Map<string, Breaker>();
const WINDOW_MS = 60_000;
const FIRST_OPEN_MS = 30_000;
const MAX_OPEN_MS = 5 * 60_000;

/** Throws while the tenant's breaker is open; lets ONE probe through once it has run out. */
export function checkBreaker(tenant: string, now = Date.now()): void {
  const b = breakers.get(tenant);
  if (!b || b.openUntil === 0) return;
  // A probe that never reported back (aborted locally) frees the next one after a minute.
  if (now < b.openUntil || (b.probing && now < b.openUntil + 60_000)) {
    const s = Math.max(1, Math.ceil((b.openUntil - now) / 1000));
    throw new AutotaskOutageError(
      `Autotask looks unavailable (${outageFailures()} or more network errors / 5xx answers within a minute; last: ${b.lastError}). ` +
      `This call was NOT sent. Retry after ${s}s — the MCP lets one test call through then.`, s);
  }
  b.probing = true; // half-open: this call is the probe
}

/** Autotask answered (any HTTP status but 502/503/504): it is up. */
export function recordSuccess(tenant: string): void {
  breakers.delete(tenant);
}

export function recordTransientFailure(tenant: string, message: string, now = Date.now()): void {
  const b = breakers.get(tenant) ?? breakers.set(tenant, { failures: [], openUntil: 0, openMs: 0, probing: false, lastError: '' }).get(tenant)!;
  b.lastError = message.slice(0, 200);
  if (b.probing) {
    // The probe failed: open again, twice as long.
    b.probing = false;
    b.openMs = Math.min(MAX_OPEN_MS, Math.max(FIRST_OPEN_MS, b.openMs * 2));
    b.openUntil = now + b.openMs;
    return;
  }
  b.failures = [...b.failures.filter((t) => now - t < WINDOW_MS), now];
  if (b.openUntil === 0 && b.failures.length >= outageFailures()) {
    b.openMs = FIRST_OPEN_MS;
    b.openUntil = now + b.openMs;
  }
}

/** Seconds left on an open breaker (0 = closed or ready for its probe). */
export function outageSeconds(tenant: string, now = Date.now()): number {
  const b = breakers.get(tenant);
  return b && b.openUntil > now ? Math.ceil((b.openUntil - now) / 1000) : 0;
}

/** Tests only. */
export function _resetUpstreamGuard(): void { tenantGates.clear(); callerGates.clear(); breakers.clear(); }
