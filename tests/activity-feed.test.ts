// Activity feed (MCP-002/003): checkpointed ingest into the ledger, cursor =
// ingestion order (late events never skipped), idempotent replay, budget →
// pending (not dropped), the ingest lock, actor classification + filters,
// and the tool end-to-end against an in-memory ledger.

import { ingestActivity, decodeCursor, encodeCursor, eventType, feedActor, clampSince, type FeedDeps } from '../src/db/activity-feed';
import type { AuditEvent } from '../src/utils/audit-events';
import type { ClassifyContext } from '../src/utils/actor-classify';
import { _setShadowRuntime } from '../src/db/shadow-runtime';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

afterEach(() => { _setShadowRuntime(null); jest.restoreAllMocks(); });

/** In-memory audit_event + checkpoints, same semantics as AuditLedger (unique event_key, serial id). */
class FakeLedger {
  rows: Array<AuditEvent & { feedId: number; ingestedAt: string }> = [];
  fetched = new Map<number, Date>();
  cps = new Map<string, { watermark: Date; coveredFrom: Date; updatedAt: Date }>();
  locked = false;
  private seq = 0;
  async insert(evs: AuditEvent[]) {
    let n = 0;
    for (const e of evs) {
      if (this.rows.some((r) => r.eventId === e.eventId)) continue;
      this.rows.push({ ...e, feedId: ++this.seq, ingestedAt: new Date().toISOString() }); n++;
    }
    return n;
  }
  async historyFetched(ids: number[]) { return new Map([...this.fetched].filter(([k]) => ids.includes(k))); }
  async markHistoryFetched(id: number, at: Date) { this.fetched.set(id, at); }
  async feedPage(o: { afterId: number; since: string; limit: number; entityTypes?: string[]; ticketIds?: number[] }) {
    return this.rows
      .filter((r) => r.feedId > o.afterId && r.timestamp >= o.since && (!o.entityTypes?.length || o.entityTypes.includes(r.entityType)))
      .filter((r) => !o.ticketIds?.length || (r.entityType === 'ticket' ? o.ticketIds.includes(r.entityId) : r.parentEntityType === 'ticket' && o.ticketIds.includes(r.parentEntityId!)))
      .sort((a, b) => a.feedId - b.feedId).slice(0, o.limit + 1);
  }
  async feedCheckpoints() { return new Map(this.cps); }
  async setFeedCheckpoint(s: string, w: Date, c: Date) { this.cps.set(s, { watermark: w, coveredFrom: c, updatedAt: new Date() }); }
  async withIngestLock<T>(fn: () => Promise<T>) { if (this.locked) return null; this.locked = true; try { return await fn(); } finally { this.locked = false; } }
}

const NOW = new Date('2026-10-09T12:00:00Z');
const SINCE = new Date('2026-10-09T00:00:00Z');

/** Fake Autotask + shadow. TimeEntries + Tickets mirrored (fresh); notes + history live. */
function world(o: { tickets?: Array<Record<string, unknown>>; history?: Record<number, Array<Record<string, unknown>>>; notes?: Array<Record<string, unknown>>; times?: Array<Record<string, unknown>>; shadowFresh?: boolean; notesWindowFrom?: string } = {}) {
  const calls: Array<{ entity: string; filters: unknown }> = [];
  const match = (row: Record<string, unknown>, f: Array<{ op: string; field: string; value: unknown }>) => f.every((x) => {
    const v = row[x.field];
    if (x.op === 'gte') return String(v) >= String(x.value);
    if (x.op === 'gt') return Number(v) > Number(x.value);
    if (x.op === 'eq') return Number(v) === Number(x.value);
    if (x.op === 'in') return (x.value as number[]).includes(Number(v));
    return true;
  });
  const table = (e: string) => (e === 'Tickets' ? o.tickets ?? [] : e === 'TimeEntries' ? o.times ?? [] : e === 'TicketNotes' ? o.notes ?? [] : []);
  const http = {
    query: jest.fn(async (entity: string, filters: Array<{ op: string; field: string; value: unknown }>, opts: { maxRecords?: number }) => {
      calls.push({ entity, filters });
      if (entity === 'TicketHistory') return (o.history?.[Number(filters[0]!.value)] ?? []) as never;
      return table(entity).filter((r) => match(r, filters)).sort((a, b) => Number(a.id) - Number(b.id)).slice(0, opts.maxRecords ?? 500) as never;
    }),
  };
  const store = {
    freshness: async (e: string) => ({ ready: (e === 'Tickets' || e === 'TimeEntries' || (e === 'TicketNotes' && o.notesWindowFrom != null)) && o.shadowFresh !== false, ageSeconds: 60, windowFrom: e === 'TicketNotes' ? o.notesWindowFrom ?? null : null }),
    query: async (e: string, f: Array<{ op: string; field: string; value: unknown }>, opts: { limit?: number }) => ({ rows: table(e).filter((r) => match(r, f)).sort((a, b) => Number(a.id) - Number(b.id)).slice(0, opts.limit ?? 100) }),
  };
  const service = {
    getFieldInfo: async () => [{ name: 'status', picklistValues: [{ value: 1, label: 'New' }, { value: 5, label: 'Complete' }, { value: 8, label: 'In Progress' }] }],
    getPicklistValues: async (_e: string, f: string) => (f === 'publish' ? [{ value: '1', label: 'All Autotask Users' }] : [{ value: '1', label: 'Task Summary' }]),
    getActorContext: async (): Promise<ClassifyContext> => CTX,
  };
  return { http, store, service, calls };
}

const CTX: ClassifyContext = {
  resources: new Map([
    [10, { id: 10, firstName: 'Tech', lastName: 'One', licenseType: 1, isActive: true }],
    [21, { id: 21, firstName: 'Nexus Z', lastName: 'API', licenseType: 7, isActive: true }],
    [30, { id: 30, firstName: 'Ref', lastName: 'Tech', licenseType: 1, isActive: true }],
  ]),
  apiLicenseValue: 7, mcpApiUserId: 99, registry: new Map(), reference: new Map([[30, 'Ref Tech']]),
};

const T1 = { id: 1, ticketNumber: 'T1', companyID: 5, lastTrackedModificationDateTime: '2026-10-09T09:00:00Z' };
const T2 = { id: 2, ticketNumber: 'T2', companyID: 5, lastTrackedModificationDateTime: '2026-10-09T10:00:00Z' };
const HIST = {
  1: [{ id: 101, action: 'Status Changed', date: '2026-10-09T09:00:00Z', detail: 'Status changed from New to In Progress', resourceID: 10 }],
  2: [{ id: 201, action: 'Status Changed', date: '2026-10-09T10:00:00Z', detail: 'Status changed from In Progress to Complete', resourceID: 21 }],
};
const deps = (w: ReturnType<typeof world>, ledger: FakeLedger): FeedDeps => ({ ledger: ledger as never, store: w.store, http: w.http as never, service: w.service as never, now: () => NOW });
const opts = { since: SINCE, sources: ['tickets', 'ticketNotes', 'timeEntries'] as const, maxApiCalls: 40, timeZone: 'America/New_York' };

describe('ingestActivity', () => {
  test('time entries from the shadow (0 calls), notes live, history once per changed ticket; checkpoints set', async () => {
    const ledger = new FakeLedger();
    const w = world({
      tickets: [T1, T2], history: HIST,
      notes: [{ id: 501, ticketID: 1, creatorResourceID: 10, createDateTime: '2026-10-09T09:05:00Z', description: 'Rebooted', noteType: 1, publish: 1 }],
      times: [{ id: 700, resourceID: 10, ticketID: 1, createDateTime: '2026-10-09T09:10:00Z', lastModifiedDateTime: '2026-10-09T11:00:00Z', dateWorked: '2026-10-09', hoursWorked: 1 }],
    });
    const r = await ingestActivity(deps(w, ledger), { ...opts, sources: [...opts.sources] });
    expect(r.ran).toBe(true);
    expect(w.calls.map((c) => c.entity)).toEqual(['TicketNotes', 'TicketHistory', 'TicketHistory']); // TimeEntries + Tickets from the shadow
    expect(r.apiCallsUsed).toBe(3);
    expect(ledger.rows.map((e) => e.eventId)).toEqual(['te:700', 'te:700:m:2026-10-09T11:00:00.000Z', 'ticketNote:501', 'th:101', 'th:201']);
    expect(r.sources.tickets).toMatchObject({ read: 'shadow', checked: 2, historyFetched: 2, pending: 0, watermark: '2026-10-09T10:00:00.000Z' });
    expect(ledger.cps.get('timeEntries')!.watermark.toISOString()).toBe('2026-10-09T11:00:00.000Z');

    // Second pass: nothing changed → history served from the cache, no duplicate events.
    w.calls.length = 0;
    const r2 = await ingestActivity(deps(w, ledger), { ...opts, sources: [...opts.sources] });
    expect(w.calls.map((c) => c.entity)).toEqual(['TicketNotes']);
    expect(r2.sources.tickets).toMatchObject({ checked: 1, fromCache: 1, historyFetched: 0, ingested: 0 }); // T1 is behind watermark − overlap
    expect(ledger.rows).toHaveLength(5);
  });

  test('a budget cut leaves the rest PENDING and holds the watermark at the first unread ticket; the next call finishes', async () => {
    const ledger = new FakeLedger();
    const w = world({ tickets: [T1, T2], history: HIST });
    const r = await ingestActivity(deps(w, ledger), { ...opts, sources: ['tickets'], maxApiCalls: 1 });
    expect(r.sources.tickets).toMatchObject({ historyFetched: 1, pending: 1, watermark: '2026-10-09T10:00:00.000Z' });
    expect(r.incomplete.join()).toMatch(/1 ticket\(s\) left for the next call/);
    const r2 = await ingestActivity(deps(w, ledger), { ...opts, sources: ['tickets'], maxApiCalls: 1 });
    expect(r2.sources.tickets).toMatchObject({ checked: 1, historyFetched: 1, pending: 0 });
    expect(ledger.rows.map((e) => e.eventId)).toEqual(['th:101', 'th:201']);
  });

  test('re-scan overlaps the watermark, so a row the shadow synced late is still picked up', async () => {
    const ledger = new FakeLedger();
    const w = world({ tickets: [T2], history: HIST });
    await ingestActivity(deps(w, ledger), { ...opts, sources: ['tickets'] });
    // T1 changed at 09:55 but only reached the shadow after T2 (10:00) was ingested.
    (w as unknown as { calls: unknown[] }).calls.length = 0;
    const late = { ...T1, lastTrackedModificationDateTime: '2026-10-09T09:55:00Z' };
    const w2 = world({ tickets: [late, T2], history: HIST });
    await ingestActivity(deps(w2, ledger), { ...opts, sources: ['tickets'] });
    expect(ledger.rows.map((e) => e.eventId)).toEqual(['th:201', 'th:101']);
  });

  test('notes come from the TicketNotes mirror (0 calls) when its window covers the scan; live when the window starts later', async () => {
    const note = { id: 501, ticketID: 1, creatorResourceID: 10, createDateTime: '2026-10-09T09:05:00Z', description: 'x', noteType: 1, publish: 1 };
    const ledger = new FakeLedger();
    const w = world({ tickets: [T1], notes: [note], notesWindowFrom: '2026-04-01' });
    const r = await ingestActivity(deps(w, ledger), { ...opts, sources: ['ticketNotes'] });
    expect(r.sources.ticketNotes).toMatchObject({ read: 'shadow', ingested: 1 });
    expect(w.calls.filter((c) => c.entity === 'TicketNotes')).toHaveLength(0);

    const w2 = world({ tickets: [T1], notes: [note], notesWindowFrom: '2026-10-09' }); // window starts after the scan (since − overlap)
    const r2 = await ingestActivity(deps(w2, new FakeLedger()), { ...opts, sources: ['ticketNotes'] });
    expect(r2.sources.ticketNotes!.read).toBe('live');
    expect(w2.calls.map((c) => c.entity)).toContain('TicketNotes');
  });

  test('another ingest holding the lock → nothing run, reported', async () => {
    const ledger = new FakeLedger(); ledger.locked = true;
    const w = world({ tickets: [T1], history: HIST });
    const r = await ingestActivity(deps(w, ledger), { ...opts, sources: ['tickets'] });
    expect(r.ran).toBe(false);
    expect(r.incomplete.join()).toMatch(/another feed ingest is running/);
    expect(w.http.query).not.toHaveBeenCalled();
  });

  test('stale shadow → live reads, counted against the budget', async () => {
    const ledger = new FakeLedger();
    const w = world({ tickets: [T1], history: HIST, shadowFresh: false });
    const r = await ingestActivity(deps(w, ledger), { ...opts, sources: ['tickets'] });
    expect(w.calls.map((c) => c.entity)).toEqual(['Tickets', 'TicketHistory']);
    expect(r.sources.tickets!.read).toBe('live');
    expect(r.apiCallsUsed).toBe(2);
  });

  test('backfill reaches back to since only when asked; lookback is capped at 90 days', async () => {
    const ledger = new FakeLedger();
    const w = world({ tickets: [T1], history: HIST });
    await ingestActivity(deps(w, ledger), { ...opts, sources: ['tickets'] });
    const earlier = new Date('2026-10-01T00:00:00Z');
    await ingestActivity(deps(w, ledger), { ...opts, since: earlier, sources: ['tickets'] });
    expect(ledger.cps.get('tickets')!.coveredFrom.toISOString()).toBe(SINCE.toISOString());
    await ingestActivity(deps(w, ledger), { ...opts, since: earlier, sources: ['tickets'], backfill: true });
    expect(ledger.cps.get('tickets')!.coveredFrom.toISOString()).toBe(earlier.toISOString());
    expect(clampSince(new Date('2025-01-01T00:00:00Z'), NOW).toISOString()).toBe('2026-07-11T12:00:00.000Z');
  });
});

describe('feed helpers', () => {
  test('cursor round-trips; junk is rejected', () => {
    const c = encodeCursor({ id: 42, since: '2026-10-09T00:00:00.000Z' });
    expect(decodeCursor(c)).toEqual({ id: 42, since: '2026-10-09T00:00:00.000Z' });
    expect(decodeCursor('42')).toBeNull();
    expect(decodeCursor('af1.bm9wZQ')).toBeNull();
  });
  test('event types', () => {
    const base = { eventId: 'x', timestamp: 't', resourceId: 1, entityId: 1, source: 'ticket_history', systemGenerated: false } as const;
    expect(eventType({ ...base, entityType: 'ticket', action: 'update', field: 'Status' })).toBe('ticket.status.changed');
    expect(eventType({ ...base, entityType: 'ticket', action: 'assign', field: 'Primary Resource' })).toBe('ticket.primaryResource.changed');
    expect(eventType({ ...base, entityType: 'ticket', action: 'create' })).toBe('ticket.created');
    expect(eventType({ ...base, entityType: 'ticketNote', action: 'note' })).toBe('ticketNote.created');
    expect(eventType({ ...base, entityType: 'timeEntry', action: 'update' })).toBe('timeEntry.updated');
  });
  test('actors: integration licence is never human; reference flag; contact-created note; no roster → unknown', () => {
    const ev = (resourceId: number | null, details?: Record<string, unknown>) => ({ eventId: 'x', timestamp: 't', resourceId, action: 'note', entityType: 'ticketNote', entityId: 1, source: 'record', systemGenerated: false, ...(details ? { details } : {}) }) as AuditEvent;
    expect(feedActor(ev(21), CTX)).toMatchObject({ actorType: 'integration', classificationSource: 'license-api-user' });
    expect(feedActor(ev(30), CTX)).toMatchObject({ actorType: 'human', reference: true });
    expect(feedActor(ev(null, { createdByContactID: 77 }), CTX)).toMatchObject({ actorType: 'contact', contactId: 77 });
    expect(feedActor(ev(10), null)).toMatchObject({ actorType: 'unknown', classificationSource: 'roster-unavailable' });
  });
});

describe('autotask_get_activity_feed (tool)', () => {
  const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
  const logger = new Logger('error');

  async function setup(w: ReturnType<typeof world>, ledger: FakeLedger) {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'httpClient').mockResolvedValue(w.http as never);
    jest.spyOn(service, 'getFieldInfo').mockImplementation(w.service.getFieldInfo as never);
    jest.spyOn(service, 'getPicklistValues').mockImplementation(w.service.getPicklistValues as never);
    jest.spyOn(service, 'getActorContext').mockResolvedValue(CTX);
    _setShadowRuntime({ store: w.store, ledger } as never);
    const handler = new AutotaskToolHandler(service, logger);
    return async (args: Record<string, unknown>) => {
      const r = await handler.callTool('autotask_get_activity_feed', args);
      return JSON.parse(r.content[0]!.text as string) as { message: string; data: Record<string, any> };
    };
  }

  test('pages by cursor; a late event appears after the cursor; replay returns the same ids; human filter excludes integrations', async () => {
    const ledger = new FakeLedger();
    const w = world({ tickets: [T1, T2], history: HIST });
    const call = await setup(w, ledger);

    const p1 = await call({ since: SINCE.toISOString(), limit: 1 });
    expect(p1.data.events.map((e: any) => e.eventId)).toEqual(['th:101']);
    expect(p1.data.events[0]).toMatchObject({ eventType: 'ticket.status.changed', ticketId: 1, before: 'New', after: 'In Progress', actor: { actorType: 'human' } });
    expect(p1.data.hasMore).toBe(true);
    expect(p1.data.coverage.complete).toBe(true);

    const p2 = await call({ cursor: p1.data.nextCursor, limit: 10, ingest: false });
    expect(p2.data.events.map((e: any) => [e.eventId, e.actor.actorType])).toEqual([['th:201', 'integration']]);

    // Late arrival: an OLDER change stored after the reader passed it.
    await ledger.insert([{ eventId: 'th:099', timestamp: '2026-10-09T08:00:00.000Z', resourceId: 10, action: 'update', entityType: 'ticket', entityId: 1, field: 'Priority', oldValue: 'Low', newValue: 'High', source: 'ticket_history', systemGenerated: false }]);
    const p3 = await call({ cursor: p2.data.nextCursor, ingest: false });
    expect(p3.data.events.map((e: any) => e.eventId)).toEqual(['th:099']);
    expect(p3.data.hasMore).toBe(false);

    const replay = await call({ cursor: p1.data.nextCursor, limit: 10, ingest: false });
    expect(replay.data.events.map((e: any) => e.eventId)).toEqual(['th:201', 'th:099']);

    const humans = await call({ since: SINCE.toISOString(), actorTypes: ['human'], ingest: false });
    expect(humans.data.events.map((e: any) => e.eventId)).toEqual(['th:101', 'th:099']);
    expect(humans.data.scanned).toBe(3);
  });

  test('no Postgres → unavailable, no Autotask calls', async () => {
    const service = new AutotaskService(config, logger);
    const handler = new AutotaskToolHandler(service, logger);
    const r = JSON.parse((await handler.callTool('autotask_get_activity_feed', {})).content[0]!.text as string);
    expect(r.data.status).toBe('unavailable');
  });

  test('a bad cursor is refused', async () => {
    const call = await setup(world(), new FakeLedger());
    expect((await call({ cursor: 'nope' })).data.status).toBe('invalid_cursor');
  });
});
