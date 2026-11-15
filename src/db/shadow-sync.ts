// Keeps the Postgres shadow in step with Autotask, within an API budget.
//
//   backfill     first load: walk `id > cursor` in 500-row pages (ids come back
//                ascending — verified live), resumable across runs. The
//                watermark is stamped BEFORE the backfill starts, so changes
//                made while it runs are picked up by the first incremental.
//   incremental  rows whose modified (or created) stamp is ≥ watermark − 2 min,
//                paged by id; the watermark advances to the newest stamp seen
//                (Autotask's clock, not ours).
//   full         small tables without a modified stamp (contract services /
//                blocks, resources): re-read whole on an interval; rows that
//                vanished are marked deleted.
//   reconcile    id-only walk of the big tables to catch DELETIONS (Autotask has
//                no delete feed); run rarely (default nightly).
//   refreshIds   rows the MCP just wrote — re-read right away so the mirror
//                never lags its own writes.
//
// Every Autotask call is counted against the run's budget; a run is skipped
// entirely when the tenant's hourly API usage is already high.

import { Logger } from '../utils/logger.js';
import { SHADOW_ENTITIES, ShadowEntity, WATERMARK_OVERLAP_MS, modifiedAt, shadowEntity } from './shadow-entities.js';
import { ShadowStore } from './shadow-store.js';
import type { ShadowFilter } from './shadow-sql.js';

export interface SyncHttp {
  query<T>(entity: string, filter: ShadowFilter[], opts?: { maxRecords?: number; includeFields?: string[]; noCache?: boolean }): Promise<T[]>;
  /** Entity field list (entityInformation/fields); used to resolve tenant-dependent fields. */
  fieldInfo?(entity: string): Promise<{ fields: Array<{ name?: string; isQueryable?: boolean }> }>;
}

export interface SyncOptions {
  maxCallsPerRun: number;
  /** Skip the run when the tenant's hourly usage is at/above this %. */
  pauseAtPct: number;
  /** Current hourly usage %, or null if unknown (then the run proceeds). */
  usagePct?: () => Promise<number | null>;
  /** Backfill only this many months of history for windowed entities (0/absent = everything). */
  historyMonths?: number;
  /** Window-refresh entities: how many recent days the hourly refresh re-reads (default 30). */
  refreshDays?: number;
}

export interface EntityReport { entity: string; mode: 'backfill' | 'incremental' | 'full' | 'refresh' | 'skip'; calls: number; rows: number; done?: boolean; deleted?: number; error?: string }
export interface RunReport { skipped?: string; calls: number; entities: EntityReport[] }

const PAGE = 500;
type Row = Record<string, unknown> & { id: number };

export class ShadowSync {
  private calls = 0;
  private readonly dirty = new Map<string, Set<number>>();
  private readonly lastWrite = new Map<string, number>();
  /** Per-process resolution of tenant-dependent fields (see ShadowEntity.watermarkCandidates). */
  private readonly resolved = new Map<string, ShadowEntity | { error: string }>();

  constructor(private readonly http: () => Promise<SyncHttp>, private readonly store: ShadowStore, private readonly logger: Logger, private readonly opts: SyncOptions) {}

  /** Queue a row the MCP just wrote; the next run re-reads it first. */
  markDirty(entity: string, id: number): void {
    const e = shadowEntity(entity);
    if (!e || !Number.isFinite(id)) return;
    (this.dirty.get(e.name) ?? this.dirty.set(e.name, new Set()).get(e.name)!).add(id);
    this.lastWrite.set(e.name, Date.now());
  }
  /**
   * Queue a row Autotask says changed (a webhook callout): the next run re-reads it first. Unlike markDirty this is
   * not "PSArelay wrote it", so searches of the entity keep using the mirror meanwhile; only a by-id read of this row
   * goes live until it is re-read. (markDirty would send every search of the entity live for 90 s, and busy webhooks
   * would keep the mirror from answering at all.)
   */
  markStale(entity: string, id: number): void {
    const e = shadowEntity(entity);
    if (!e || !Number.isFinite(id)) return;
    (this.dirty.get(e.name) ?? this.dirty.set(e.name, new Set()).get(e.name)!).add(id);
  }
  /**
   * A note or time entry moves its ticket's / task's lastActivity* fields WITHOUT moving their modified stamp
   * (mirror check 2026-10-22: Tickets.lastActivityDate, Tasks.lastActivityResourceID), so the incremental
   * sync never re-read them. New / changed activity rows queue their parent for a re-read on the next run.
   * Unlike markDirty this is not "the MCP wrote it": searches keep using the mirror meanwhile.
   */
  markParentsStale(e: ShadowEntity, rows: Array<Record<string, unknown>>): void {
    const links: Array<[string, string]> = e.name === 'TicketNotes' ? [['ticketID', 'Tickets']] : e.name === 'TimeEntries' ? [['ticketID', 'Tickets'], ['taskID', 'Tasks']] : [];
    for (const [field, parent] of links) {
      const p = shadowEntity(parent);
      if (!p) continue;
      for (const r of rows) {
        const id = Number(r[field]);
        if (Number.isInteger(id) && id > 0) (this.dirty.get(p.name) ?? this.dirty.set(p.name, new Set()).get(p.name)!).add(id);
      }
    }
  }
  /** A row the MCP wrote that the mirror hasn't re-read yet (by-id reads must go live). */
  isDirty(entity: string, id: number): boolean { return this.dirty.get(shadowEntity(entity)?.name ?? entity)?.has(id) ?? false; }
  /** The MCP wrote this entity within `ms` (searches go live briefly: a just-created row isn't mirrored yet). */
  writtenWithin(entity: string, ms: number): boolean { const t = this.lastWrite.get(shadowEntity(entity)?.name ?? entity); return t !== undefined && Date.now() - t < ms; }

  /**
   * The entity as it applies to this tenant: a watermark picked from the
   * candidates, and required fields checked — one field-list call per entity
   * per process. Unresolvable (field list unreadable) → used as declared.
   */
  async effective(e: ShadowEntity): Promise<ShadowEntity | { error: string }> {
    if (!e.watermarkCandidates && !e.requiredFields) return e;
    const hit = this.resolved.get(e.name);
    if (hit) return hit;
    const h = await this.http();
    if (!h.fieldInfo) { this.resolved.set(e.name, e); return e; }
    this.calls++;
    let fields: Array<{ name?: string; isQueryable?: boolean }>;
    try { fields = (await h.fieldInfo(e.name)).fields ?? []; } catch (err) { return { error: `could not read the ${e.name} field list: ${err instanceof Error ? err.message : String(err)}` }; }
    const names = new Set(fields.filter((f) => f.isQueryable !== false).map((f) => String(f.name ?? '').toLowerCase()));
    const actual = (want: string) => fields.find((f) => String(f.name ?? '').toLowerCase() === want.toLowerCase())?.name;
    const missing = (e.requiredFields ?? []).filter((f) => !names.has(f.toLowerCase()));
    if (missing.length && fields.length) {
      const r = { error: `not mirrored on this tenant: field(s) ${missing.join(', ')} not available on ${e.name}` };
      this.resolved.set(e.name, r);
      return r;
    }
    const wm = (e.watermarkCandidates ?? []).find((f) => names.has(f.toLowerCase()));
    const out: ShadowEntity = wm ? { ...e, watermarkField: actual(wm) ?? wm } : e;
    this.resolved.set(e.name, out);
    if (wm) this.logger.info(`shadow: ${e.name} has ${out.watermarkField} — incremental sync`);
    return out;
  }
  /** Change the usage threshold at runtime (admin console). */
  setPauseAtPct(pct: number): void { this.opts.pauseAtPct = pct; }
  get pauseAtPct(): number { return this.opts.pauseAtPct; }
  dirtyCount(): number { let n = 0; for (const s of this.dirty.values()) n += s.size; return n; }

  private budgetLeft(): number { return this.opts.maxCallsPerRun - this.calls; }

  private async page(e: ShadowEntity, filter: ShadowFilter[], includeFields?: string[]): Promise<Row[]> {
    this.calls++;
    const h = await this.http();
    return h.query<Row>(e.name, filter, { maxRecords: PAGE, noCache: true, ...(includeFields ? { includeFields } : {}) });
  }

  /** One scheduled run: dirty rows, then each entity in turn, until the budget is spent. */
  async runOnce(now: Date = new Date()): Promise<RunReport> {
    this.calls = 0;
    if (this.opts.usagePct) {
      // A 429 cooldown (or a login pause) answers the usage check locally: nothing would get through, so skip the run
      // instead of failing every entity in turn.
      let held: string | null = null;
      const pct = await this.opts.usagePct().catch((e: unknown) => { const m = e instanceof Error ? e.message : String(e); if (/429|cooldown|threshold exceeded|login (is )?(paused|held)/i.test(m)) held = m.slice(0, 120); return null; });
      if (held) return { skipped: `Autotask is holding calls (${held}) — sync skipped this run`, calls: 0, entities: [] };
      if (pct != null && pct >= this.opts.pauseAtPct) return { skipped: `Autotask API usage ${pct}% ≥ ${this.opts.pauseAtPct}% — sync paused this run`, calls: 0, entities: [] };
    }
    const entities: EntityReport[] = [];
    for (const [name, ids] of [...this.dirty.entries()]) {
      this.dirty.delete(name);
      try { await this.refreshIds(name, [...ids]); } catch (err) { this.logger.warn(`shadow: refreshing ${ids.size} written ${name} row(s) failed`, err); }
    }
    for (const e of SHADOW_ENTITIES) {
      if (this.budgetLeft() <= 0) { entities.push({ entity: e.name, mode: 'skip', calls: 0, rows: 0, error: 'run budget spent' }); continue; }
      const before = this.calls;
      try {
        const eff = await this.effective(e);
        if ('error' in eff) {
          await this.store.saveState(e.name, { last_error: eff.error.slice(0, 500), last_error_at: now, apiCalls: this.calls - before });
          entities.push({ entity: e.name, mode: 'skip', calls: this.calls - before, rows: 0, error: eff.error });
          continue;
        }
        entities.push(await this.syncEntity(eff, now));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.store.saveState(e.name, { last_error: msg.slice(0, 500), last_error_at: now, apiCalls: this.calls - before });
        entities.push({ entity: e.name, mode: 'skip', calls: this.calls - before, rows: 0, error: msg });
      }
    }
    return { calls: this.calls, entities };
  }

  private async syncEntity(e: ShadowEntity, now: Date): Promise<EntityReport> {
    const st = await this.store.getState(e.name);
    if (!e.watermarkField && e.window) {
      if (!st?.backfill_done) return this.backfill(e, st?.backfill_cursor ?? 0, st?.watermark ?? null, st?.window_from ?? null, now);
      return this.windowRefresh(e, st, now);
    }
    if (!e.watermarkField) return this.fullRefresh(e, st?.last_full_at ?? null, now);
    if (!st?.backfill_done) return this.backfill(e, st?.backfill_cursor ?? 0, st?.watermark ?? null, st?.window_from ?? null, now);
    return this.incremental(e, st.watermark, now);
  }

  private async backfill(e: ShadowEntity, cursor: number, watermark: Date | null, windowFrom: Date | null, now: Date): Promise<EntityReport> {
    const before = this.calls;
    // Stamp the watermark (and fix the history window) when the backfill STARTS,
    // so edits made during it are caught later and the window doesn't drift.
    if (cursor === 0 && !watermark) {
      const months = this.opts.historyMonths ?? 0;
      if (e.window && months > 0) { windowFrom = new Date(now); windowFrom.setUTCMonth(windowFrom.getUTCMonth() - months); windowFrom.setUTCHours(0, 0, 0, 0); }
      await this.store.saveState(e.name, { watermark: now, window_from: windowFrom });
    }
    const windowFilter = e.window && windowFrom ? [e.window(new Date(windowFrom).toISOString().slice(0, 10))] : [];
    let rows = 0, done = false;
    while (this.budgetLeft() > 0) {
      const page = await this.page(e, [...windowFilter, { op: 'gt', field: 'id', value: cursor }]);
      rows += await this.store.upsert(e, page);
      if (page.length) cursor = Math.max(...page.map((r) => Number(r.id)));
      if (page.length < PAGE) { done = true; break; }
      await this.store.saveState(e.name, { backfill_cursor: cursor, apiCalls: 0 });
    }
    await this.store.saveState(e.name, { backfill_cursor: cursor, ...(done ? { backfill_done: true, last_backfill_at: now, last_error: null } : {}), apiCalls: this.calls - before });
    return { entity: e.name, mode: 'backfill', calls: this.calls - before, rows, done };
  }

  private async incremental(e: ShadowEntity, watermark: Date | null, now: Date): Promise<EntityReport> {
    const before = this.calls;
    const since = new Date((watermark ?? now).getTime() - WATERMARK_OVERLAP_MS).toISOString();
    const changed: ShadowFilter = e.createField
      ? { op: 'or', items: [{ op: 'gte', field: e.watermarkField!, value: since }, { op: 'gte', field: e.createField, value: since }] }
      : { op: 'gte', field: e.watermarkField!, value: since };
    let cursor = 0, rows = 0, newest = watermark?.getTime() ?? 0, complete = false;
    while (this.budgetLeft() > 0) {
      const page = await this.page(e, [changed, { op: 'gt', field: 'id', value: cursor }]);
      rows += await this.store.upsert(e, page); this.markParentsStale(e, page);
      for (const r of page) { const m = modifiedAt(e, r)?.getTime(); if (m && m > newest) newest = m; }
      if (page.length) cursor = Math.max(...page.map((r) => Number(r.id)));
      if (page.length < PAGE) { complete = true; break; }
    }
    // Only move the watermark when every changed row was read; otherwise the next run resumes from the same point.
    await this.store.saveState(e.name, { ...(complete ? { watermark: new Date(newest || now.getTime()), last_incremental_at: now, last_error: null } : {}), apiCalls: this.calls - before });
    return { entity: e.name, mode: 'incremental', calls: this.calls - before, rows, done: complete };
  }

  /**
   * Window-refresh mode: new rows every run (id above the highest mirrored);
   * edits by re-reading the last refreshDays every refreshEveryMinutes, and the
   * whole window once a day. Rows a complete re-read no longer returns are
   * marked deleted (only within the re-read range).
   */
  private async windowRefresh(e: ShadowEntity, st: { window_from: Date | null; last_full_at: Date | null; last_reconcile_at: Date | null; last_backfill_at: Date | null }, now: Date): Promise<EntityReport> {
    const before = this.calls;
    let rows = 0;
    // 1. New rows.
    let cursor = await this.store.maxId(e.name), newDone = false;
    while (this.budgetLeft() > 0) {
      const page = await this.page(e, [{ op: 'gt', field: 'id', value: cursor }]);
      rows += await this.store.upsert(e, page); this.markParentsStale(e, page);
      if (page.length) cursor = Math.max(...page.map((r) => Number(r.id)));
      if (page.length < PAGE) { newDone = true; break; }
    }
    if (newDone) await this.store.saveState(e.name, { last_incremental_at: now, last_error: null });
    // 2. Edits: the recent days hourly, the whole window daily.
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const windowDay = st.window_from ? day(new Date(st.window_from)) : null;
    // A just-finished backfill counts as both refreshes.
    const lastFull = st.last_reconcile_at ?? st.last_backfill_at, lastHot = st.last_full_at ?? st.last_backfill_at;
    const fullDue = !lastFull || now.getTime() - new Date(lastFull).getTime() > 20 * 3600_000;
    const hotDue = !lastHot || now.getTime() - new Date(lastHot).getTime() >= (e.refreshEveryMinutes ?? 60) * 60_000;
    let deleted = 0, refreshed = false;
    if (newDone && (fullDue || hotDue) && e.window) {
      const hot = new Date(now); hot.setUTCDate(hot.getUTCDate() - (this.opts.refreshDays ?? 30));
      const fromDay = fullDue ? windowDay : (windowDay && windowDay > day(hot) ? windowDay : day(hot));
      const range: ShadowFilter[] = fromDay ? [e.window(fromDay)] : [];
      const seen = new Set<number>();
      let c = 0, complete = false;
      while (this.budgetLeft() > 0) {
        const page = await this.page(e, [...range, { op: 'gt', field: 'id', value: c }]);
        rows += await this.store.upsert(e, page); this.markParentsStale(e, page);
        for (const r of page) seen.add(Number(r.id));
        if (page.length) c = Math.max(...page.map((r) => Number(r.id)));
        if (page.length < PAGE) { complete = true; break; }
      }
      if (complete) {
        deleted = await this.store.markDeleted(e.name, (await this.store.liveIdsMatching(e.name, range)).filter((id) => !seen.has(id)));
        await this.store.saveState(e.name, fullDue ? { last_full_at: now, last_reconcile_at: now } : { last_full_at: now });
        refreshed = true;
      }
    }
    await this.store.saveState(e.name, { apiCalls: this.calls - before });
    return { entity: e.name, mode: refreshed ? 'refresh' : 'incremental', calls: this.calls - before, rows, done: newDone, deleted };
  }

  private async fullRefresh(e: ShadowEntity, lastFull: Date | null, now: Date): Promise<EntityReport> {
    const due = !lastFull || now.getTime() - new Date(lastFull).getTime() >= (e.fullEveryMinutes ?? 60) * 60_000;
    if (!due) return { entity: e.name, mode: 'skip', calls: 0, rows: 0 };
    const before = this.calls;
    const seen = new Set<number>();
    let cursor = 0, rows = 0, complete = false;
    while (this.budgetLeft() > 0) {
      const page = await this.page(e, [{ op: 'gt', field: 'id', value: cursor }]);
      rows += await this.store.upsert(e, page);
      for (const r of page) seen.add(Number(r.id));
      if (page.length) cursor = Math.max(...page.map((r) => Number(r.id)));
      if (page.length < PAGE) { complete = true; break; }
    }
    let deleted = 0;
    if (complete) deleted = await this.store.markDeleted(e.name, (await this.store.liveIds(e.name)).filter((id) => !seen.has(id)));
    await this.store.saveState(e.name, { ...(complete ? { last_full_at: now, backfill_done: true, last_backfill_at: now, last_error: null } : {}), apiCalls: this.calls - before });
    return { entity: e.name, mode: 'full', calls: this.calls - before, rows, done: complete, deleted };
  }

  /** Catch deletions in a big table: id-only walk, rows Autotask no longer returns are marked deleted. */
  async reconcile(entityName: string, maxCalls: number, now: Date = new Date()): Promise<EntityReport> {
    const e = shadowEntity(entityName);
    if (!e) throw new Error(`Not a shadow entity: ${entityName}`);
    const saved = this.opts.maxCallsPerRun;
    (this.opts as { maxCallsPerRun: number }).maxCallsPerRun = maxCalls;
    this.calls = 0;
    try {
      const seen = new Set<number>();
      let cursor = 0, complete = false;
      while (this.budgetLeft() > 0) {
        const page = await this.page(e, [{ op: 'gt', field: 'id', value: cursor }], ['id']);
        for (const r of page) seen.add(Number(r.id));
        if (page.length) cursor = Math.max(...page.map((r) => Number(r.id)));
        if (page.length < PAGE) { complete = true; break; }
      }
      let deleted = 0;
      if (complete) deleted = await this.store.markDeleted(e.name, (await this.store.liveIds(e.name)).filter((id) => !seen.has(id)));
      await this.store.saveState(e.name, { ...(complete ? { last_reconcile_at: now } : {}), apiCalls: this.calls });
      return { entity: e.name, mode: 'full', calls: this.calls, rows: seen.size, done: complete, deleted };
    } finally {
      (this.opts as { maxCallsPerRun: number }).maxCallsPerRun = saved;
    }
  }

  /** Re-read specific rows (e.g. just written by the MCP); ids Autotask no longer has are marked deleted. */
  async refreshIds(entityName: string, ids: number[]): Promise<number> {
    const e = shadowEntity(entityName);
    if (!e || !ids.length) return 0;
    let n = 0;
    for (let i = 0; i < ids.length; i += PAGE) {
      const chunk = ids.slice(i, i + PAGE);
      const rows = await this.page(e, [{ op: 'in', field: 'id', value: chunk }]);
      n += await this.store.upsert(e, rows);
      const found = new Set(rows.map((r) => Number(r.id)));
      await this.store.markDeleted(e.name, chunk.filter((id) => !found.has(id)));
    }
    return n;
  }
}
