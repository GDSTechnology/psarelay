// Postgres shadow: filter→SQL translation, write detection, the sync engine
// (backfill / incremental / full / reconcile / budget / usage pause) against a
// fake Autotask and an in-memory store, and the search read path's fallbacks.
// The real Postgres + live Autotask path was verified separately (local dev DB):
// shadow-served searches returned the same ids, order and hasMore as live.

import { SqlBuilder, filterToSql, groupExpr, whereClause } from '../src/db/shadow-sql';
import { ShadowSync } from '../src/db/shadow-sync';
import { SHADOW_ENTITIES, modifiedAt, shadowEntity } from '../src/db/shadow-entities';
import { writtenRow, shadowRead, _setShadowRuntime } from '../src/db/shadow-runtime';
import { Logger } from '../src/utils/logger';

const logger = new Logger('error');
afterEach(() => _setShadowRuntime(null));

describe('filter → SQL', () => {
  const sql = (f: any) => { const b = new SqlBuilder(); return { s: filterToSql(f, b), p: b.params }; };
  test('eq: numbers by jsonb containment (GIN), strings case-insensitive, null → IS NULL', () => {
    expect(sql({ op: 'eq', field: 'contractID', value: 29685345 })).toEqual({ s: 'data @> $1::jsonb', p: ['{"contractID":29685345}'] });
    expect(sql({ op: 'eq', field: 'emailAddress', value: 'A@x.com' })).toEqual({ s: "lower((data->>'emailAddress')) = lower($1)", p: ['A@x.com'] });
    expect(sql({ op: 'eq', field: 'assignedResourceID', value: null }).s).toBe("(data->>'assignedResourceID') IS NULL");
  });
  test('text matching ignores case and whitespace runs (double spaces, line breaks, non-breaking spaces)', () => {
    const r = sql({ op: 'contains', field: 'summaryNotes', value: 'replaced  the' });
    expect(r.s).toContain("regexp_replace(translate((data->>'summaryNotes')");
    expect(r.s).toContain('ILIKE');
    expect(r.p).toEqual(['%replaced the%']);
    expect(sql({ op: 'contains', field: 'Notes', value: 'x', udf: true }).s).toContain('regexp_replace');
  });
  test('ranges numeric vs date text; LIKE ops escape wildcards; exist/isnotnull; in/notIn', () => {
    expect(sql({ op: 'gte', field: 'hoursWorked', value: 2 }).s).toBe("((data->>'hoursWorked'))::numeric >= $1");
    expect(sql({ op: 'lt', field: 'dateWorked', value: '2026-10-01' })).toEqual({ s: "(data->>'dateWorked') < $1", p: ['2026-10-01'] });
    expect(sql({ op: 'contains', field: 'title', value: '50%_off' }).p).toEqual(['%50\\%\\_off%']);
    expect(sql({ op: 'isnotnull', field: 'billingApprovalDateTime' }).s).toBe("(data->>'billingApprovalDateTime') IS NOT NULL");
    expect(sql({ op: 'in', field: 'status', value: [1, 8] })).toEqual({ s: "lower((data->>'status')) = ANY($1::text[])", p: [['1', '8']] });
  });
  test('and/or groups, AND-ed top level, injection-proof field names', () => {
    const b = new SqlBuilder();
    expect(whereClause([{ op: 'or', items: [{ op: 'eq', field: 'a', value: 1 }, { op: 'notExist', field: 'b' }] }, { op: 'gt', field: 'id', value: 5 }], b))
      .toBe("(data @> $1::jsonb OR (data->>'b') IS NULL) AND ((data->>'id'))::numeric > $2");
    expect(() => sql({ op: 'eq', field: "x'); DROP TABLE t;--", value: 1 })).toThrow(/Invalid field name/);
    expect(() => sql({ op: 'regex', field: 'x', value: 1 })).toThrow(/Unsupported filter op/);
    expect(groupExpr('month:dateWorked')).toEqual({ sql: "substr((data->>'dateWorked'), 1, 7)", alias: 'month_dateWorked' });
  });
  test('UDF filters use the structured udf column (migration 0016); names bound, values as text; group by a UDF', () => {
    expect(sql({ op: 'eq', field: 'Nexus-Status', value: 2, udf: true })).toEqual({ s: 'lower((udf->>$1)) = lower($2)', p: ['Nexus-Status', '2'] });
    expect(sql({ op: 'isnull', field: 'Opp Tag #2', udf: true })).toEqual({ s: '(udf->>$1) IS NULL', p: ['Opp Tag #2'] });
    expect(sql({ op: 'in', field: 'BP-Status', value: ['Open', 'Hold'], udf: true }).p).toEqual(['BP-Status', ['open', 'hold']]);
    expect(() => sql({ op: 'eq', field: "x'); DROP TABLE t;--", value: 1, udf: true })).toThrow(/Invalid UDF name/);
    expect(groupExpr('udf:Nexus-Status')).toEqual({ sql: "(udf->>'Nexus-Status')", alias: 'udf_Nexus-Status' });
    expect(() => groupExpr("udf:a'; drop")).toThrow(/Invalid UDF name/);
  });
});

describe('entities + write detection', () => {
  test('registry: watermark fields verified live; modifiedAt falls back to the create stamp', () => {
    expect(shadowEntity('timeentries')!.watermarkField).toBe('lastModifiedDateTime');
    expect(SHADOW_ENTITIES.filter((e) => !e.watermarkField && !e.window).map((e) => e.name)).toEqual(['ContractServices', 'ContractBlocks', 'Resources', 'Opportunities', 'ConfigurationItems']);
    // Billing entities: windowed, watermark resolved per tenant (window refresh when none).
    expect(SHADOW_ENTITIES.filter((e) => e.watermarkCandidates).map((e) => e.name)).toEqual(['TicketNotes', 'Invoices', 'BillingItems', 'TicketCharges', 'ProjectCharges', 'ContractCharges', 'ExpenseItems', 'Opportunities', 'ConfigurationItems']);
    expect(modifiedAt(shadowEntity('Tickets')!, { createDate: '2026-10-01T00:00:00Z' })?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
  test('writtenRow: top-level PATCH/POST, by-id DELETE, child-route create; ignores queries and unmirrored entities', () => {
    expect(writtenRow('/Tickets', { id: 7, status: 5 }, {})).toEqual({ entity: 'Tickets', id: 7 });
    expect(writtenRow('/TimeEntries', { ticketID: 1 }, { itemId: 99 })).toEqual({ entity: 'TimeEntries', id: 99 });
    expect(writtenRow('/TimeEntries/55', undefined, undefined)).toEqual({ entity: 'TimeEntries', id: 55 });
    expect(writtenRow('/Tickets/12/Notes', { title: 'x' }, { itemId: 345 })).toEqual({ entity: 'TicketNotes', id: 345 });
    expect(writtenRow('/TicketNotes', { ticketID: 12 }, { itemId: 346 })).toEqual({ entity: 'TicketNotes', id: 346 });
    expect(writtenRow('/Projects/3/Notes', {}, { itemId: 9 })).toBeNull(); // project notes aren't mirrored
    expect(writtenRow('/Companies/5/Contacts', { firstName: 'x' }, { itemId: 12 })).toEqual({ entity: 'Contacts', id: 12 });
    expect(writtenRow('/Contracts/9/Services', {}, { itemId: 3 })).toEqual({ entity: 'ContractServices', id: 3 });
    expect(writtenRow('/Tickets/query', {}, {})).toBeNull();
    expect(writtenRow('/Quotes', { id: 1 }, {})).toBeNull();
    expect(writtenRow('/Projects/9/Tasks', { id: 4 }, {})).toEqual({ entity: 'Tasks', id: 4 });
    // raw_request writes arrive as absolute zone URLs (n8n 'update did not verify', 2026-10-09).
    expect(writtenRow('https://webservices3.autotask.net/ATServicesRest/v1.0/Tickets', { id: 210669, priority: 1 }, {})).toEqual({ entity: 'Tickets', id: 210669 });
    expect(writtenRow('https://webservices3.autotask.net/ATServicesRest/v1.0/Tickets/210669', undefined, undefined)).toEqual({ entity: 'Tickets', id: 210669 });
    expect(writtenRow('https://webservices3.autotask.net/ATServicesRest/V1.0/Companies/5/Contacts?x=1', {}, { itemId: 12 })).toEqual({ entity: 'Contacts', id: 12 });
    expect(writtenRow('https://webservices3.autotask.net/ATServicesRest/v1.0/Tickets/query', {}, {})).toBeNull();
  });
});

/** In-memory stand-in for ShadowStore (the methods the sync engine uses). */
function memStore() {
  const rows = new Map<string, Map<number, any>>();
  const deleted = new Map<string, Set<number>>();
  const states = new Map<string, any>();
  const tbl = (e: string) => rows.get(e) ?? rows.set(e, new Map()).get(e)!;
  return {
    rows, deleted, states,
    upsert: jest.fn(async (e: any, rs: any[]) => { for (const r of rs) { tbl(e.name).set(Number(r.id), r); deleted.get(e.name)?.delete(Number(r.id)); } return rs.length; }),
    markDeleted: jest.fn(async (e: string, ids: number[]) => { const d = deleted.get(e) ?? deleted.set(e, new Set()).get(e)!; ids.forEach((i) => d.add(i)); return ids.length; }),
    liveIds: jest.fn(async (e: string) => [...tbl(e).keys()].filter((i) => !deleted.get(e)?.has(i))),
    getState: jest.fn(async (e: string) => states.get(e) ?? null),
    saveState: jest.fn(async (e: string, p: any) => { const { apiCalls = 0, ...f } = p; const s = states.get(e) ?? { entity: e, backfill_cursor: 0, backfill_done: false, api_calls_total: 0 }; states.set(e, { ...s, ...f, api_calls_total: s.api_calls_total + apiCalls }); }),
  };
}

/** Fake Autotask: per entity a sorted table; honours `id gt`, `in`, the incremental OR, and 500-row pages. */
function fakeAutotask(tables: Record<string, any[]>) {
  const calls: Array<{ entity: string; filter: any[] }> = [];
  const match = (r: any, f: any): boolean => {
    if (f.op === 'or') return f.items.some((i: any) => match(r, i));
    if (f.op === 'gt') return Number(r[f.field]) > f.value;
    if (f.op === 'gte') return String(r[f.field] ?? '') >= f.value;
    if (f.op === 'in') return f.value.includes(r[f.field]);
    return true;
  };
  return {
    calls,
    http: async () => ({
      query: async (entity: string, filter: any[], opts: any) => {
        calls.push({ entity, filter });
        expect(opts.noCache).toBe(true);
        return (tables[entity] ?? []).filter((r) => filter.every((f) => match(r, f))).sort((a, b) => a.id - b.id).slice(0, 500);
      },
    }),
  };
}

const range = (n: number, mk: (i: number) => any) => Array.from({ length: n }, (_, i) => mk(i + 1));

describe('ShadowSync', () => {
  test('backfill walks id > cursor in 500s, resumes across runs, stamps the watermark first; then incremental', async () => {
    const tickets = range(1200, (i) => ({ id: i, lastTrackedModificationDateTime: '2026-01-01T00:00:00Z' }));
    const at = fakeAutotask({ Tickets: tickets });
    const store = memStore();
    const sync = new ShadowSync(at.http, store as any, logger, { maxCallsPerRun: 2, pauseAtPct: 50 });
    const t0 = new Date('2026-10-06T12:00:00Z');
    const r1 = await sync.runOnce(t0);
    expect(r1.entities[0]).toMatchObject({ entity: 'Tickets', mode: 'backfill', calls: 2, rows: 1000, done: false });
    expect(r1.entities.slice(1).every((e) => e.error === 'run budget spent')).toBe(true);
    expect(store.states.get('Tickets')).toMatchObject({ backfill_cursor: 1000, backfill_done: false, watermark: t0 });
    expect(at.calls.map((c) => c.filter)).toEqual([[{ op: 'gt', field: 'id', value: 0 }], [{ op: 'gt', field: 'id', value: 500 }]]);

    const r2 = await sync.runOnce(new Date('2026-10-06T12:05:00Z'));
    expect(r2.entities[0]).toMatchObject({ mode: 'backfill', rows: 200, done: true });
    expect(store.rows.get('Tickets')!.size).toBe(1200);

    // A ticket changes; the next run picks it up incrementally (watermark − 2 min overlap, OR'd with createDate).
    tickets[4] = { ...tickets[4], title: 'changed', lastTrackedModificationDateTime: '2026-10-06T12:07:00Z' };
    at.calls.length = 0;
    const r3 = await new ShadowSync(at.http, store as any, logger, { maxCallsPerRun: 1, pauseAtPct: 50 }).runOnce(new Date('2026-10-06T12:10:00Z'));
    expect(r3.entities[0]).toMatchObject({ entity: 'Tickets', mode: 'incremental', rows: 1, done: true });
    expect(at.calls[0]!.filter[0]).toEqual({ op: 'or', items: [{ op: 'gte', field: 'lastTrackedModificationDateTime', value: '2026-10-06T11:58:00.000Z' }, { op: 'gte', field: 'createDate', value: '2026-10-06T11:58:00.000Z' }] });
    expect(store.rows.get('Tickets')!.get(5).title).toBe('changed');
    expect(store.states.get('Tickets').watermark.toISOString()).toBe('2026-10-06T12:07:00.000Z'); // Autotask's newest stamp, not our clock
  });

  test('history window: Tickets backfill = active/created in the last N months OR still open; cutoff fixed at start', async () => {
    const at = fakeAutotask({ Tickets: [{ id: 1 }] });
    const store = memStore();
    const sync = new ShadowSync(at.http, store as any, logger, { maxCallsPerRun: 1, pauseAtPct: 50, historyMonths: 6 });
    await sync.runOnce(new Date('2026-10-06T12:00:00Z'));
    expect(at.calls[0]!.filter).toEqual([
      { op: 'or', items: [{ op: 'gte', field: 'lastActivityDate', value: '2026-04-06' }, { op: 'gte', field: 'createDate', value: '2026-04-06' }, { op: 'noteq', field: 'status', value: 5 }] },
      { op: 'gt', field: 'id', value: 0 },
    ]);
    expect(store.states.get('Tickets').window_from.toISOString()).toBe('2026-04-06T00:00:00.000Z');
    // Small / reference tables are never windowed.
    expect(shadowEntity('Companies')!.window).toBeUndefined();
  });

  test('windowCovers: only queries that stay inside the window may be served from it', () => {
    const t = shadowEntity('Tickets')!, te = shadowEntity('TimeEntries')!;
    const c = '2026-04-06';
    expect(t.windowCovers!([{ op: 'noteq', field: 'status', value: 5 }, { op: 'eq', field: 'companyID', value: 1 }], c)).toBe(true); // default open-ticket search
    expect(t.windowCovers!([{ op: 'eq', field: 'status', value: 8 }], c)).toBe(true);
    expect(t.windowCovers!([{ op: 'gte', field: 'createDate', value: '2026-05-01' }], c)).toBe(true);
    expect(t.windowCovers!([{ op: 'eq', field: 'status', value: 5 }], c)).toBe(false);          // completed, any age
    expect(t.windowCovers!([{ op: 'gte', field: 'createDate', value: '2024-01-01' }], c)).toBe(false); // reaches back
    expect(t.windowCovers!([{ op: 'eq', field: 'contractID', value: 9 }], c)).toBe(false);     // unbounded (includeCompleted)
    expect(te.windowCovers!([{ op: 'gte', field: 'dateWorked', value: '2026-06-01' }], c)).toBe(true);
    expect(te.windowCovers!([{ op: 'eq', field: 'ticketID', value: 200523 }], c)).toBe(false);
  });

  test('full-refresh tables: re-read on their interval, vanished rows marked deleted', async () => {
    const resources = range(3, (i) => ({ id: i }));
    const at = fakeAutotask({ Resources: resources });
    const store = memStore();
    for (const e of SHADOW_ENTITIES.filter((x) => x.name !== 'Resources')) store.states.set(e.name, { entity: e.name, backfill_done: true, backfill_cursor: 0, api_calls_total: 0, watermark: new Date(), last_full_at: new Date() });
    const sync = new ShadowSync(at.http, store as any, logger, { maxCallsPerRun: 50, pauseAtPct: 50 });
    await sync.runOnce(new Date('2026-10-06T12:00:00Z'));
    expect(store.rows.get('Resources')!.size).toBe(3);
    resources.pop();
    const again = await sync.runOnce(new Date('2026-10-06T12:30:00Z'));
    expect(again.entities.find((e) => e.entity === 'Resources')!.mode).toBe('skip'); // not due (60 min)
    const due = await sync.runOnce(new Date('2026-10-06T13:01:00Z'));
    expect(due.entities.find((e) => e.entity === 'Resources')).toMatchObject({ mode: 'full', deleted: 1 });
    expect([...store.deleted.get('Resources')!]).toEqual([3]);
  });

  test('pauses when tenant usage is at/above the threshold; written rows are refreshed first', async () => {
    const at = fakeAutotask({ Tickets: [{ id: 7, status: 5 }] });
    const store = memStore();
    const paused = new ShadowSync(at.http, store as any, logger, { maxCallsPerRun: 10, pauseAtPct: 50, usagePct: async () => 52.1 });
    expect((await paused.runOnce()).skipped).toMatch(/52\.1% ≥ 50%/);
    expect(at.calls).toHaveLength(0);
    const sync = new ShadowSync(at.http, store as any, logger, { maxCallsPerRun: 1, pauseAtPct: 50, usagePct: async () => 30 });
    sync.markDirty('tickets', 7); sync.markDirty('Quotes', 1);
    expect(sync.dirtyCount()).toBe(1);
    await sync.runOnce();
    expect(at.calls[0]).toEqual({ entity: 'Tickets', filter: [{ op: 'in', field: 'id', value: [7] }] });
    expect(store.rows.get('Tickets')!.get(7)).toEqual({ id: 7, status: 5 });
  });

  test('new notes / time entries queue their ticket and task for a re-read (lastActivity* moves without the modified stamp); searches stay on the mirror', async () => {
    const sync = new ShadowSync(fakeAutotask({}).http, memStore() as any, logger, { maxCallsPerRun: 1, pauseAtPct: 85 });
    sync.markParentsStale(shadowEntity('TicketNotes')!, [{ id: 1, ticketID: 70 }, { id: 2, ticketID: 71 }]);
    sync.markParentsStale(shadowEntity('TimeEntries')!, [{ id: 3, ticketID: 72, taskID: null }, { id: 4, ticketID: null, taskID: 90 }]);
    sync.markParentsStale(shadowEntity('Companies')!, [{ id: 5, ticketID: 99 }]); // no activity parent
    expect([70, 71, 72].map((t) => sync.isDirty('Tickets', t))).toEqual([true, true, true]);
    expect(sync.isDirty('Tasks', 90)).toBe(true);
    expect(sync.isDirty('Tickets', 99)).toBe(false);
    expect(sync.writtenWithin('Tickets', 60_000)).toBe(false); // not 'the MCP wrote it'
  });

  test('a 429 cooldown skips the run instead of failing every entity; an unrelated usage error still syncs', async () => {
    const at = fakeAutotask({ Tickets: [{ id: 7, status: 5 }] });
    const held = new ShadowSync(at.http, memStore() as any, logger, { maxCallsPerRun: 10, pauseAtPct: 85, usagePct: async () => { throw new Error('Autotask API threshold exceeded (HTTP 429) — this tenant is in a 30s cooldown'); } });
    const r = await held.runOnce();
    expect(r.skipped).toMatch(/holding calls/);
    expect(at.calls).toHaveLength(0);
    const other = new ShadowSync(at.http, memStore() as any, logger, { maxCallsPerRun: 1, pauseAtPct: 85, usagePct: async () => { throw new Error('socket hang up'); } });
    expect((await other.runOnce()).skipped).toBeUndefined();
  });

  test('reconcile: id-only walk marks rows Autotask no longer returns as deleted', async () => {
    const at = fakeAutotask({ Contacts: [{ id: 1 }, { id: 3 }] });
    const store = memStore();
    await store.upsert({ name: 'Contacts' }, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const r = await new ShadowSync(at.http, store as any, logger, { maxCallsPerRun: 5, pauseAtPct: 50 }).reconcile('Contacts', 10);
    expect(r).toMatchObject({ rows: 2, deleted: 1, done: true });
    expect([...store.deleted.get('Contacts')!]).toEqual([2]);
  });
});

describe('shadowRead (search read path)', () => {
  const store = (f: any, rows: any[] = [{ id: 1 }]) => ({ freshness: jest.fn(async () => f), query: jest.fn(async () => ({ rows, total: rows.length })), fieldNames: jest.fn(async () => ['id', 'status', 'contractID', 'companyID']) });
  test('serves only when enabled, mirrored, backfilled and fresh; otherwise null (→ live)', async () => {
    expect(await shadowRead('Tickets', [], 10)).toBeNull(); // no runtime
    const s = store({ entity: 'Tickets', ready: true, ageSeconds: 30, rows: 1 });
    _setShadowRuntime({ store: s, serveReads: true, maxAgeSeconds: 900 } as any);
    expect(await shadowRead('Tickets', [{ op: 'eq', field: 'status', value: 1 }], 26)).toEqual({ rows: [{ id: 1 }], ageSeconds: 30 });
    expect(s.query).toHaveBeenCalledWith('Tickets', [{ op: 'eq', field: 'status', value: 1 }], { limit: 26, order: 'id_asc' });
    expect(await shadowRead('Quotes', [], 10)).toBeNull(); // not mirrored
    _setShadowRuntime({ store: store({ ready: false, ageSeconds: null }), serveReads: true, maxAgeSeconds: 900 } as any);
    expect(await shadowRead('Tickets', [], 10)).toBeNull(); // still backfilling
    _setShadowRuntime({ store: store({ ready: true, ageSeconds: 2000 }), serveReads: true, maxAgeSeconds: 900 } as any);
    expect(await shadowRead('Tickets', [], 10)).toBeNull(); // too old
    _setShadowRuntime({ store: store({ ready: true, ageSeconds: 5 }), serveReads: false, maxAgeSeconds: 900 } as any);
    expect(await shadowRead('Tickets', [], 10)).toBeNull(); // serving off
    _setShadowRuntime({ store: store({ ready: true, ageSeconds: 5, windowFrom: '2026-04-06' }), serveReads: true, maxAgeSeconds: 900 } as any);
    expect(await shadowRead('Tickets', [{ op: 'noteq', field: 'status', value: 5 }], 10)).not.toBeNull(); // open tickets: in window
    _setShadowRuntime({ store: store({ ready: true, ageSeconds: 5, windowFrom: '2026-04-06' }), serveReads: true, maxAgeSeconds: 900 } as any);
    expect(await shadowRead('Tickets', [{ op: 'eq', field: 'contractID', value: 9 }], 10)).toBeNull(); // could reach older → live
    _setShadowRuntime({ store: store({ ready: true, ageSeconds: 5 }), serveReads: true, maxAgeSeconds: 900 } as any);
    expect(await shadowRead('Tickets', [{ op: 'eq', field: 'companyId', value: 9 }], 10)).toBeNull(); // wrong case: Autotask would match, jsonb would not → live
    expect(await shadowRead('Tickets', [{ op: 'or', items: [{ op: 'eq', field: 'companyID', value: 9 }, { op: 'eq', field: 'nope', value: 1 }] }], 10)).toBeNull(); // unknown field inside an OR → live
    expect(await shadowRead('Tickets', [{ op: 'eq', field: 'companyID', value: 9 }], 10)).not.toBeNull();
    const bad = store({ ready: true, ageSeconds: 5 }); bad.query.mockRejectedValue(new Error('Unsupported filter op'));
    _setShadowRuntime({ store: bad, serveReads: true, maxAgeSeconds: 900 } as any);
    expect(await shadowRead('Tickets', [], 10)).toBeNull(); // untranslatable → live
  });
});
