// Backpressure state for dispatchers (gap register MCP-008): one verdict —
// ok / slow / stop — from what the MCP already knows, with the reasons and
// how long to wait. Costs no Autotask call: tenant usage is the latest reading
// (the shadow sync takes one every run), the rest is in-process state.
//
// What the MCP already does on its own (documented in docs/THROTTLING.md):
// a 401 pauses ALL calls for the tenant (login
// protection — 2 test logins, then held until "Retry now"); a 429 arms a
// cooldown during which calls fail locally without reaching Autotask; at most
// 2 (max 3) concurrent calls per endpoint (the rest queue); the shadow sync pauses at
// a usage threshold. It never retries a 401 or a 429 itself. Since §24 (upstream-guard.ts):
// tenant + per-caller concurrency caps (queue), jittered retry of transient read failures,
// and an outage breaker that fails calls locally after a run of network errors / 5xx.

import { authBlockStatus, endpointQueueDepth, rateLimitCooldownSeconds, type AuthBlockStatus } from './autotask-http.js';
import { latestTenantUsage } from './call-log.js';
import { endpointOutages, outageSeconds, upstreamQueueDepth } from './upstream-guard.js';

export type BackpressureLevel = 'ok' | 'slow' | 'stop';

export interface Backpressure {
  level: BackpressureLevel;
  /** Why (empty when ok). */
  reasons: string[];
  /** Wait at least this long before the next call (null = no fixed wait; for a held login, until an admin clears it). */
  retryAfterSeconds: number | null;
  advice: string;
  autotask: {
    usedPct: number | null; used: number | null; limit: number | null;
    /** Added latency Autotask applies at this usage (documented tiers). */
    latencyTier: 'none' | '+0.5s' | '+1s';
    readingAt: string | null; readingAgeSeconds: number | null;
  };
  auth: AuthBlockStatus | null;
  rateLimitCooldownSeconds: number;
  /** Seconds the TENANT-wide outage breaker stays open (0 = closed). */
  outageSeconds: number;
  /** Modules (endpoints) whose own breaker is open — work that needs them waits, the rest carries on. */
  moduleOutages: Array<{ endpoint: string; seconds: number }>;
  queuedRequests: number;
}

export interface BackpressureThresholds { slowPct: number; stopPct: number; queueSlow: number; staleReadingSeconds: number }
export const DEFAULT_THRESHOLDS: BackpressureThresholds = { slowPct: 50, stopPct: 90, queueSlow: 10, staleReadingSeconds: 1800 };

/** Pure verdict — inputs injected so it is testable. */
export function assessBackpressure(i: {
  usage: { usedPct: number | null; used: number | null; limit: number | null; at: string | null } | null;
  auth: AuthBlockStatus | null; cooldownSeconds: number; queued: number; now?: number;
  /** Outage breaker (upstream-guard.ts): seconds it stays open. */
  outageSeconds?: number;
  moduleOutages?: Array<{ endpoint: string; seconds: number }>;
}, t: BackpressureThresholds = DEFAULT_THRESHOLDS): Backpressure {
  const now = i.now ?? Date.now();
  const reasons: string[] = [];
  let level = 'ok' as BackpressureLevel; // widened: raise() mutates it
  let retry: number | null = null;
  const raise = (l: BackpressureLevel) => { if (l === 'stop' || (l === 'slow' && level === 'ok')) level = l; };

  if (i.auth?.held) { raise('stop'); reasons.push('Autotask login is HELD after repeated failed logins — an administrator must fix the API user and press "Retry now" in the console'); }
  else if (i.auth?.blockedUntil) {
    raise('stop'); const s = Math.max(1, Math.ceil((Date.parse(i.auth.blockedUntil) - now) / 1000)); retry = Math.max(retry ?? 0, s);
    reasons.push(`Autotask login paused after a failed login (${i.auth.failures} so far) — calls fail locally for ${s}s`);
  } else if (i.auth?.probing) { raise('slow'); reasons.push('Autotask login is being re-tested after a pause'); }

  const outage = i.outageSeconds ?? 0;
  if (outage > 0) { raise('stop'); retry = Math.max(retry ?? 0, outage); reasons.push(`Autotask looks unavailable (a run of network errors / 5xx answers) — calls fail locally for ${outage}s, then one test call goes through`); }
  const modules = i.moduleOutages ?? [];
  if (modules.length) {
    raise('slow');
    reasons.push(`Autotask module(s) unavailable: ${modules.map((m) => `${m.endpoint} (${m.seconds}s)`).join(', ')} — hold work that needs them (retry it after), carry on with everything else`);
  }

  if (i.cooldownSeconds > 0) { raise('stop'); retry = Math.max(retry ?? 0, i.cooldownSeconds); reasons.push(`Autotask returned 429 (threshold) — cooling down ${i.cooldownSeconds}s`); }

  const pct = i.usage?.usedPct ?? null;
  const ageS = i.usage?.at ? Math.round((now - Date.parse(i.usage.at)) / 1000) : null;
  if (pct != null) {
    if (pct >= t.stopPct) { raise('stop'); retry = Math.max(retry ?? 0, 300); reasons.push(`tenant API usage ${pct}% of the hourly limit — stop non-essential work`); }
    else if (pct >= t.slowPct) { raise('slow'); reasons.push(`tenant API usage ${pct}% — Autotask adds ${pct >= 75 ? '1 s' : '0.5 s'} per call; defer bulk work`); }
  }
  if (ageS != null && ageS > t.staleReadingSeconds) reasons.push(`usage reading is ${Math.round(ageS / 60)} min old`);
  if (i.queued >= t.queueSlow) { raise('slow'); reasons.push(`${i.queued} request(s) queued behind the concurrency gates`); }

  const advice = level === 'stop'
    ? (i.auth?.held ? 'Do not call Autotask tools until the login is fixed; queue the work.' : `Do not send calls for ${retry ?? 60}s; queue the work and retry after.`)
    : level === 'slow' ? 'Proceed with essential calls only, one at a time; postpone backfills, bulk syncs and reports.'
    : 'Proceed normally.';
  return {
    level, reasons, retryAfterSeconds: level === 'stop' ? retry : null, advice,
    autotask: { usedPct: pct, used: i.usage?.used ?? null, limit: i.usage?.limit ?? null, latencyTier: pct == null ? 'none' : pct >= 75 ? '+1s' : pct >= 50 ? '+0.5s' : 'none', readingAt: i.usage?.at ?? null, readingAgeSeconds: ageS },
    auth: i.auth, rateLimitCooldownSeconds: i.cooldownSeconds, outageSeconds: outage, moduleOutages: modules, queuedRequests: i.queued,
  };
}

/** Current backpressure for a tenant (the API username). */
export function backpressure(tenant: string, t?: BackpressureThresholds): Backpressure {
  const u = latestTenantUsage();
  return assessBackpressure({
    usage: u ? { usedPct: u.usedPct, used: u.used, limit: u.limit, at: u.at } : null,
    auth: authBlockStatus(tenant), cooldownSeconds: rateLimitCooldownSeconds(tenant), queued: endpointQueueDepth() + upstreamQueueDepth(),
    outageSeconds: outageSeconds(tenant.toLowerCase()),
    moduleOutages: endpointOutages(tenant.toLowerCase()),
  }, t);
}
