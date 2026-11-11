// Wires the Postgres shadow into the running MCP: the store, the sync engine,
// the scheduler (one instance at a time via a Postgres advisory lock), the
// write hook (re-read rows the MCP just wrote), and the read path the search
// methods use. Entirely inert unless MCP_PG_ENABLED + MCP_PG_SHADOW_ENABLED.
//
// Env (defaults):
//   MCP_PG_SHADOW_INTERVAL_SECONDS   300   how often a sync run starts
//   MCP_PG_SHADOW_MAX_CALLS_PER_RUN  100   Autotask calls one run may spend
//   MCP_PG_SHADOW_PAUSE_AT_PCT       85    skip a run when the tenant's hourly
//                                           usage is at/above this %. Kept HIGH on
//                                           purpose: a run costs ≤100 calls, while a
//                                           stale mirror sends every read live —
//                                           pausing at 50% turned busy hours into 429s.
//   MCP_PG_SHADOW_RECONCILE_HOUR_UTC 7     hour of the nightly deletion sweep
//   MCP_PG_SHADOW_SERVE_READS        false answer search_* from the shadow
//   MCP_PG_SHADOW_MAX_AGE_SECONDS    900   ...only while it is at most this old
//   MCP_PG_SHADOW_HISTORY_MONTHS     6     backfill only this much history of
//                                           Tickets (plus every open ticket) and
//                                           TimeEntries; 0 = everything. Reads
//                                           reaching further back go live.

import { Logger } from '../utils/logger.js';
import { getPool } from './pool.js';
import { loadPgFlags } from './config.js';
import { ShadowStore, Freshness } from './shadow-store.js';
import { AuditLedger } from './audit-ledger.js';
import { ShadowSync, RunReport } from './shadow-sync.js';
import { SHADOW_ENTITIES, shadowEntity } from './shadow-entities.js';
import type { ShadowFilter } from './shadow-sql.js';
import { setWriteListener, setReadInterceptor } from '../services/autotask-http.js';
import type { AutotaskService } from '../services/autotask.service.js';
import { runJob, noteShadowRead } from '../services/call-log.js';
import { verifyEntity, overallStatus, type VerifyReport, type VerifyDeps } from './shadow-verify.js';

const ADVISORY_KEY = 727_210_455; // "shadow sync" — distinct from the migration lock

const intEnv = (v: string | undefined, d: number): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

export interface ShadowRuntime {
  store: ShadowStore;
  /** Normalized audit event ledger (ticket history cache, webhook + row-diff events). */
  ledger: AuditLedger;
  sync: ShadowSync;
  serveReads: boolean;
  maxAgeSeconds: number;
  /** False pauses the scheduled sync (admin console). runNow still works. */
  syncEnabled: boolean;
  /** Consistency check (under the lock): sampled rows + counts vs Autotask; repairs the mirror. Null if the lock is busy. */
  verify(opts?: { entities?: string[]; sample?: number; repair?: boolean; trigger?: string }): Promise<VerifyReport | null>;
  lastVerify(): VerifyReport | null;
  /** Run one sync now (under the lock). Returns null if another instance holds it. */
  runNow(): Promise<RunReport | null>;
  lastRun(): { at: string; report: RunReport } | null;
  stop(): void;
}

let runtime: ShadowRuntime | null = null;
export const getShadowRuntime = (): ShadowRuntime | null => runtime;

/** Which shadow row an Autotask write touched (path forms: /Tickets, /TimeEntries/123, /Companies/5/Contacts, /Projects/9/Tasks). */
export function writtenRow(path: string, body: unknown, response: unknown): { entity: string; id: number } | null {
  // raw_request writes arrive as ABSOLUTE zone URLs (https://…/ATServicesRest/v1.0/Tickets).
  // Missing that left the row un-dirtied, so n8n's read-back after a raw PATCH
  // was answered from the stale mirror ("update did not verify", 2026-10-09).
  let p = path.split('?')[0]!;
  if (/^https?:\/\//i.test(p)) { try { p = new URL(p).pathname; } catch { /* keep */ } }
  p = p.replace(/^.*?\/v1\.0(?=\/|$)/i, '');
  const segs = p.split('/').filter(Boolean);
  if (!segs.length || segs[segs.length - 1] === 'query' || segs.includes('query')) return null;
  const childMap: Record<string, string> = { Contacts: 'Contacts', Services: 'ContractServices', Blocks: 'ContractBlocks', Tasks: 'Tasks', ToDos: 'CompanyToDos' };
  // "Charges" is a child of several parents: /Tickets/1/Charges → TicketCharges, etc.
  const parentChild: Record<string, string> = { 'Tickets/Charges': 'TicketCharges', 'Projects/Charges': 'ProjectCharges', 'Contracts/Charges': 'ContractCharges', 'Tickets/Notes': 'TicketNotes' };
  const entityName = segs.length >= 3 ? (parentChild[`${segs[0]}/${segs[2]}`] ?? childMap[segs[2]!]) : segs[0];
  const e = entityName ? shadowEntity(entityName) : undefined;
  if (!e) return null;
  const idFromPath = segs.length === 2 ? Number(segs[1]) : segs.length === 4 ? Number(segs[3]) : NaN;
  const b = body as { id?: unknown } | undefined, r = response as { itemId?: unknown } | undefined;
  const rawId = b?.id ?? r?.itemId;
  // Number(null) is 0 — and 0 is a real company — so a missing id must stay missing.
  const id = Number.isFinite(idFromPath) ? idFromPath : rawId == null || rawId === '' ? NaN : Number(rawId);
  // id 0 is real for Companies (the tenant's own company).
  return Number.isInteger(id) && id >= 0 ? { entity: e.name, id } : null;
}

/** Start the shadow (no-op unless enabled). Safe to call once at server start. */
export function initShadow(service: AutotaskService, logger: Logger, env: NodeJS.ProcessEnv = process.env): ShadowRuntime | null {
  if (runtime) return runtime;
  if (!loadPgFlags(env).shadow) return null;
  const pool = getPool(logger, env);
  if (!pool) return null;
  const store = new ShadowStore(pool);
  const ledger = new AuditLedger(pool);
  store.onDiff = (events) => ledger.insert(events);
  const sync = new ShadowSync(() => service.httpClient(), store, logger, {
    maxCallsPerRun: intEnv(env.MCP_PG_SHADOW_MAX_CALLS_PER_RUN, 100),
    pauseAtPct: intEnv(env.MCP_PG_SHADOW_PAUSE_AT_PCT, 85),
    historyMonths: intEnv(env.MCP_PG_SHADOW_HISTORY_MONTHS, 6),
    refreshDays: intEnv(env.MCP_PG_SHADOW_REFRESH_DAYS, 30),
    usagePct: async () => { const u = await service.getApiUsage(); return 'usedPct' in u.autotask ? (u.autotask.usedPct ?? null) : null; },
  });
  const reconcileHour = intEnv(env.MCP_PG_SHADOW_RECONCILE_HOUR_UTC, 7);
  const verifyHour = intEnv(env.MCP_PG_SHADOW_VERIFY_HOUR_UTC, 8);
  const verifySample = Math.min(Math.max(intEnv(env.MCP_PG_SHADOW_VERIFY_SAMPLE, 10), 1), 50);
  let lastVerify: VerifyReport | null = null;
  let last: { at: string; report: RunReport } | null = null;
  let running = false;

  const underLock = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    const client = await pool.connect();
    try {
      const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_KEY]);
      if (!got.rows[0]?.ok) return null;
      try { return await fn(); } finally { await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]); }
    } finally { client.release(); }
  };

  const runVerify = async (o: { entities?: string[]; sample?: number; repair?: boolean; trigger?: string }, now = new Date()): Promise<VerifyReport> => {
    const http = await service.httpClient();
    const deps: VerifyDeps = {
      query: (entity, filter, q) => http.query<Record<string, unknown>>(entity, filter as never, q),
      count: (entity, filter) => http.count(entity, filter as never),
      sample: (entity, n) => store.sample(entity, n),
      countMatching: (entity, filter) => store.countMatching(entity, filter),
      upsert: (e, rows) => store.upsert(e, rows),
      markDeleted: (entity, ids) => store.markDeleted(entity, ids),
      effective: (e) => sync.effective(e),
      state: (entity) => store.getState(entity),
    };
    const report: VerifyReport = { at: now.toISOString(), trigger: o.trigger ?? 'manual', status: 'ok', calls: 0, sample: o.sample ?? verifySample, entities: [] };
    const pct = await service.getApiUsage().then((u) => ('usedPct' in u.autotask ? u.autotask.usedPct : null)).catch(() => null);
    // The mirror check is optional extra reads: it keeps the old, lower threshold.
    if (pct != null && pct >= Math.min(sync.pauseAtPct, 50)) { report.status = 'skipped'; report.skipped = `Autotask API usage ${pct}% ≥ ${sync.pauseAtPct}% — check skipped`; }
    else {
      const wanted = o.entities?.length ? SHADOW_ENTITIES.filter((e) => o.entities!.some((n) => n.toLowerCase() === e.name.toLowerCase())) : SHADOW_ENTITIES;
      for (const e of wanted) {
        const r = await runJob('shadow verify', () => verifyEntity(e, deps, { sample: report.sample, repair: o.repair !== false, now }));
        report.calls += r.calls;
        report.entities.push(r);
      }
      report.status = overallStatus(report.entities);
    }
    lastVerify = report;
    try { await store.saveVerifyRun(report.trigger, report.status, report); } catch (err) { logger.warn('shadow verify: could not save the result (run migration 0005?)', err); }
    const bad = report.entities.filter((x) => x.differs || x.missing || x.countOk === false || x.error);
    logger[report.status === 'attention' ? 'warn' : 'info'](`shadow verify (${report.trigger}): ${report.skipped ?? `${report.status}, ${report.calls} call(s)${bad.length ? ` — attention: ${bad.map((x) => `${x.entity} ${x.differs} differ / ${x.missing} missing${x.countOk === false ? ` / count Δ${x.countDelta}` : ''}${x.error ? ` / error` : ''}`).join(', ')}` : ''}`}`);
    return report;
  };

  const tick = async (): Promise<RunReport | null> => {
    if (running) return null;
    running = true;
    try {
      return await underLock(async () => {
        const now = new Date();
        const report = await runJob('shadow sync', () => sync.runOnce(now));
        // Nightly deletion sweep for the big tables, once per day in the configured hour.
        if (!report.skipped && now.getUTCHours() === reconcileHour) {
          for (const e of SHADOW_ENTITIES.filter((x) => x.watermarkField)) {
            const st = await store.getState(e.name);
            if (st?.backfill_done && (!st.last_reconcile_at || now.getTime() - new Date(st.last_reconcile_at).getTime() > 20 * 3600_000)) {
              report.entities.push(await runJob('shadow sync', () => sync.reconcile(e.name, 600, now)));
            }
          }
        }
        last = { at: now.toISOString(), report };
        if (!report.skipped && now.getUTCHours() === verifyHour && (!lastVerify || now.getTime() - Date.parse(lastVerify.at) > 20 * 3600_000)) {
          await runVerify({ trigger: 'nightly' }, now).catch((err) => logger.warn('shadow verify failed (continuing)', err));
        }
        logger.info(`shadow sync: ${report.skipped ?? `${report.calls} Autotask call(s); ${report.entities.filter((x) => x.rows).map((x) => `${x.entity} ${x.mode} ${x.rows}`).join(', ') || 'no changes'}`}`);
        return report;
      });
    } catch (err) {
      logger.error('shadow sync run failed (continuing)', err);
      return null;
    } finally { running = false; }
  };

  setWriteListener((method, path, body, response) => {
    if (method === 'GET') return;
    const w = writtenRow(path, body, response);
    if (w) sync.markDirty(w.entity, w.id);
  });

  const intervalMs = Math.max(30, intEnv(env.MCP_PG_SHADOW_INTERVAL_SECONDS, 300)) * 1000;
  const first = setTimeout(() => { if (runtime?.syncEnabled !== false) void tick(); }, 15_000);
  const timer = setInterval(() => { if (runtime?.syncEnabled !== false) void tick(); }, intervalMs);
  first.unref?.(); timer.unref?.();

  runtime = {
    store, ledger, sync,
    serveReads: String(env.MCP_PG_SHADOW_SERVE_READS).toLowerCase() === 'true',
    maxAgeSeconds: intEnv(env.MCP_PG_SHADOW_MAX_AGE_SECONDS, 900),
    syncEnabled: true,
    runNow: tick,
    verify: (o = {}) => underLock(() => runVerify(o)),
    lastVerify: () => lastVerify,
    lastRun: () => last,
    stop: () => { clearTimeout(first); clearInterval(timer); setWriteListener(null); setReadInterceptor(null); runtime = null; },
  };
  // Every Autotask query / by-id read of THIS tenant asks the shadow first.
  const tenant = (env.AUTOTASK_USERNAME ?? '').toLowerCase();
  setReadInterceptor({
    query: async (t, entity, filter, limit) => (t === tenant ? (await shadowRead(entity, filter as ShadowFilter[], limit))?.rows ?? null : null),
    get: async (t, entity, id) => (t === tenant ? shadowGet(entity, id) : undefined),
  });
  logger.info(`Postgres shadow enabled: sync every ${intervalMs / 1000}s, ≤${intEnv(env.MCP_PG_SHADOW_MAX_CALLS_PER_RUN, 100)} calls/run, pause at ${intEnv(env.MCP_PG_SHADOW_PAUSE_AT_PCT, 85)}% usage, serve reads: ${runtime.serveReads}`);
  return runtime;
}

const freshCache = new Map<string, { at: number; f: Freshness }>();
const fieldCache = new Map<string, { at: number; names: Set<string>; udfLoaded?: boolean }>();

/** Every field a filter names (walking and/or groups); a UDF filter is "udf:<name>". */
function filterFields(filters: ShadowFilter[], out: string[] = []): string[] {
  for (const f of filters as Array<ShadowFilter & { items?: ShadowFilter[]; udf?: boolean }>) {
    if (f.items) filterFields(f.items, out);
    else if (f.udf) out.push(`udf:${String(f.field)}`);
    else if (f.field != null) out.push(String(f.field));
  }
  return out;
}

/**
 * Autotask matches field names case-insensitively; the jsonb mirror doesn't.
 * Serve only when every filtered field is a real key of the mirrored rows,
 * spelled exactly so — otherwise a "companyId" filter would silently match
 * nothing. Unknown → go live.
 */
async function fieldsKnown(rt: ShadowRuntime, name: string, filters: ShadowFilter[]): Promise<boolean> {
  const want = filterFields(filters);
  if (!want.length) return true;
  let c = fieldCache.get(name);
  if (!c || Date.now() - c.at > 600_000) { c = { at: Date.now(), names: new Set(await rt.store.fieldNames(name)) }; fieldCache.set(name, c); }
  // UDF filters (migration 0016): served when the mirror holds that UDF with values; an unknown name goes live.
  if (!c.udfLoaded && want.some((w) => w.startsWith('udf:'))) {
    for (const n of await rt.store.udfNames(name).catch(() => [] as string[])) c.names.add(`udf:${n}`);
    c.udfLoaded = true;
  }
  return c.names.size > 0 && want.every((f) => c!.names.has(f));
}
/**
 * How old a copy may be and still answer reads. An entity re-copied on a schedule (full or
 * window refresh, e.g. Resources every 60 min) is trusted for its whole interval plus 5 min:
 * with only the global limit (900 s) it went live for ~45 min of every hour — Resources made
 * hundreds of live reads although mirrored. Incremental entities keep the global limit.
 */
export function maxAgeFor(rt: Pick<ShadowRuntime, 'maxAgeSeconds'>, name: string): number {
  const def = shadowEntity(name);
  const every = def ? (def.refreshEveryMinutes ?? (!def.watermarkField && !def.watermarkCandidates ? def.fullEveryMinutes : undefined)) : undefined;
  return every ? Math.max(rt.maxAgeSeconds, every * 60 + 300) : rt.maxAgeSeconds;
}

/** After an MCP write to an entity, its searches read live this long (until the next sync re-reads the row). */
const WRITE_BYPASS_MS = 90_000;

/**
 * One row by id from the shadow, or undefined to go live: serving reads on,
 * mirrored, fresh, the row present (a windowed mirror may not hold old rows)
 * and not written by the MCP since the last sync.
 */
export async function shadowGet(entity: string, id: number): Promise<unknown | undefined> {
  if (!runtime?.serveReads) return undefined;
  const r = await mirrorGet(entity, id);
  return r.ok && r.row != null ? r.row : undefined;
}

/**
 * Answer a search from the shadow, or null to go live. Only when serving reads
 * is on, the entity is mirrored, backfilled, and fresh enough, and every
 * filter translates to SQL. Rows come back in ascending id order, like Autotask.
 */
export async function shadowRead<T>(entity: string, filters: ShadowFilter[], limit: number): Promise<{ rows: T[]; ageSeconds: number } | null> {
  if (!runtime?.serveReads) return null;
  const r = await mirrorQuery<T>(entity, filters, limit);
  return r.ok ? { rows: r.rows, ageSeconds: r.ageSeconds } : null;
}

/** Why the mirror could not answer a read (the integration API reports it; MCP reads just go live). */
export type MirrorMiss = 'mirror_off' | 'not_mirrored' | 'not_ready' | 'stale' | 'recently_written' | 'outside_window' | 'unknown_field' | 'error';
export type MirrorQueryResult<T> = { ok: true; rows: T[]; ageSeconds: number } | { ok: false; reason: MirrorMiss };
export type MirrorGetResult = { ok: true; row: unknown | null; ageSeconds: number } | { ok: false; reason: MirrorMiss };

async function freshness(rt: ShadowRuntime, name: string): Promise<{ f: Freshness; age: number } | MirrorMiss> {
  let c = freshCache.get(name);
  if (!c || Date.now() - c.at > 15_000) { c = { at: Date.now(), f: await rt.store.freshness(name) }; freshCache.set(name, c); }
  const f = c.f;
  if (!f.ready || f.ageSeconds == null) return 'not_ready';
  const age = f.ageSeconds + Math.round((Date.now() - c.at) / 1000);
  return age > maxAgeFor(rt, name) ? 'stale' : { f, age };
}

/**
 * A search answered from the mirror whether or not the MCP's own reads use it (`serveReads`): the integration
 * API (src/integrations) is a mirror client by design. Same rules otherwise — mirrored, backfilled, fresh, inside
 * the history window, every filter field known, nothing just written by the MCP.
 */
export async function mirrorQuery<T>(entity: string, filters: ShadowFilter[], limit: number): Promise<MirrorQueryResult<T>> {
  const rt = runtime;
  if (!rt) return { ok: false, reason: 'mirror_off' };
  const def = shadowEntity(entity);
  if (!def) return { ok: false, reason: 'not_mirrored' };
  try {
    // The MCP just wrote this entity: a created/edited row isn't mirrored yet — read live for a moment.
    if (rt.sync?.writtenWithin(def.name, WRITE_BYPASS_MS)) return { ok: false, reason: 'recently_written' };
    const fr = await freshness(rt, def.name);
    if (typeof fr === 'string') return { ok: false, reason: fr };
    // A windowed mirror only holds recent history: serve only queries whose
    // filters stay inside it (e.g. open tickets, dateWorked ≥ window start).
    if (fr.f.windowFrom && def.windowCovers && !def.windowCovers(filters, fr.f.windowFrom)) return { ok: false, reason: 'outside_window' };
    if (!(await fieldsKnown(rt, def.name, filters))) return { ok: false, reason: 'unknown_field' };
    const r = await rt.store.query(def.name, filters, { limit, order: 'id_asc' });
    noteShadowRead(def.name);
    return { ok: true, rows: r.rows as T[], ageSeconds: fr.age };
  } catch {
    return { ok: false, reason: 'error' }; // unsupported filter, PG hiccup — the live API answers instead
  }
}

/**
 * One row by id from the mirror (row null = not in the mirror). A row the MCP wrote since the last sync is a miss.
 */
export async function mirrorGet(entity: string, id: number): Promise<MirrorGetResult> {
  const rt = runtime;
  if (!rt) return { ok: false, reason: 'mirror_off' };
  const def = shadowEntity(entity);
  if (!def) return { ok: false, reason: 'not_mirrored' };
  if (!Number.isFinite(id)) return { ok: false, reason: 'error' };
  try {
    if (rt.sync?.isDirty(def.name, id)) return { ok: false, reason: 'recently_written' };
    const fr = await freshness(rt, def.name);
    if (typeof fr === 'string') return { ok: false, reason: fr };
    const r = await rt.store.query(def.name, [{ op: 'eq', field: 'id', value: id }], { limit: 1 });
    if (r.rows[0]) noteShadowRead(def.name);
    return { ok: true, row: r.rows[0] ?? null, ageSeconds: fr.age };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/** Test hook. */
export function _setShadowRuntime(rt: ShadowRuntime | null): void { runtime = rt; freshCache.clear(); fieldCache.clear(); }
