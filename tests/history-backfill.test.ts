// Bounded historical backfill (MCP-006): filters sent upstream, usage pause,
// budget cut → resume at the cursor, cached history skipped, done, errors
// stop without retrying.

import { runBackfillStep, type BackfillDeps, type BackfillJob } from '../src/db/history-backfill';
import type { AuditEvent } from '../src/utils/audit-events';

const T = (id: number, lastMod = '2026-02-01T00:00:00Z') => ({ id, ticketNumber: `T${id}`, companyID: 5, lastTrackedModificationDateTime: lastMod });

function world(o: { tickets: Array<Record<string, unknown>>; usage?: number | null; fail?: string; fetched?: Map<number, Date> }) {
  const calls: Array<{ entity: string; filters: any[]; max?: number | undefined }> = [];
  const stored: AuditEvent[] = [];
  let job: BackfillJob = { id: 'j1', rangeFrom: '2026-01-01T00:00:00.000Z', rangeTo: '2026-03-01T00:00:00.000Z', sources: ['tickets', 'ticketNotes', 'timeEntries'], cursor: 0, status: 'running', ticketsTotal: 3, ticketsDone: 0, eventsIngested: 0, apiCalls: 0, lastError: null, createdAt: 'x', updatedAt: 'x' };
  const fetched = o.fetched ?? new Map<number, Date>();
  const deps: BackfillDeps = {
    ledger: {
      insert: async (evs) => { let n = 0; for (const e of evs) if (!stored.some((s) => s.eventId === e.eventId)) { stored.push(e); n++; } return n; },
      historyFetched: async (ids) => new Map([...fetched].filter(([k]) => ids.includes(k))),
      markHistoryFetched: async (id, at) => { fetched.set(id, at); },
    },
    jobs: {
      update: async (_id, p) => {
        job = { ...job, ...(p.cursor !== undefined ? { cursor: p.cursor } : {}), ...(p.status ? { status: p.status } : {}), ticketsDone: job.ticketsDone + (p.ticketsDone ?? 0), eventsIngested: job.eventsIngested + (p.eventsIngested ?? 0), apiCalls: job.apiCalls + (p.apiCalls ?? 0), ...(p.lastError !== undefined ? { lastError: p.lastError } : {}) };
        return job;
      },
    },
    http: {
      query: jest.fn(async (entity: string, filters: any[], opts: { maxRecords?: number }) => {
        calls.push({ entity, filters, max: opts.maxRecords });
        if (o.fail && entity === o.fail) throw new Error('Autotask 500');
        if (entity === 'Tickets') { const after = Number(filters.find((f) => f.op === 'gt').value); return o.tickets.filter((t) => Number(t.id) > after).slice(0, opts.maxRecords) as never; }
        if (entity === 'TicketNotes') return (filters[0].value as number[]).map((tid) => ({ id: 1000 + tid, ticketID: tid, creatorResourceID: 10, createDateTime: '2026-01-15T10:00:00Z', description: 'n' })) as never;
        if (entity === 'TimeEntries') return (filters[0].value as number[]).map((tid) => ({ id: 2000 + tid, ticketID: tid, resourceID: 10, createDateTime: '2026-01-15T11:00:00Z', dateWorked: '2026-01-15', hoursWorked: 1 })) as never;
        if (entity === 'TicketHistory') { const tid = Number(filters[0].value); return [{ id: 3000 + tid, action: 'Status Changed', date: '2026-01-20T10:00:00Z', detail: 'Status changed from New to Complete', resourceID: 10 }] as never; }
        return [] as never;
      }),
    },
    service: { getFieldInfo: async () => [], getPicklistValues: async () => [] },
    usagePct: async () => (o.usage === undefined ? 12 : o.usage),
  };
  return { deps, calls, stored, job: () => job };
}
const opts = { maxApiCalls: 100, batchSize: 50, pauseAtPct: 50, timeZone: 'America/New_York' };

describe('runBackfillStep', () => {
  test('one step: completed-in-range page above the cursor, notes + time in bulk, history per ticket; cursor advances', async () => {
    const w = world({ tickets: [T(1), T(2)] });
    const r = await runBackfillStep(w.deps, w.job(), opts);
    expect(w.calls[0]).toEqual({ entity: 'Tickets', max: 50, filters: [
      { op: 'gte', field: 'completedDate', value: '2026-01-01T00:00:00.000Z' }, { op: 'lt', field: 'completedDate', value: '2026-03-01T00:00:00.000Z' }, { op: 'gt', field: 'id', value: 0 }] });
    expect(w.calls.map((c) => c.entity)).toEqual(['Tickets', 'TicketNotes', 'TimeEntries', 'TicketHistory', 'TicketHistory']);
    expect(w.calls[1]!.filters[0]).toEqual({ op: 'in', field: 'ticketID', value: [1, 2] });
    expect(w.stored.map((e) => e.eventId.replace(/:[0-9a-f]{12}$/, '')).sort()).toEqual(['te:2001', 'te:2002', 'th:3001', 'th:3002', 'ticketNote:1001', 'ticketNote:1002']);
    expect(r).toMatchObject({ ticketsProcessed: 2, eventsIngested: 6, apiCallsUsed: 6 }); // + the usage check
    expect(w.job()).toMatchObject({ cursor: 2, ticketsDone: 2, status: 'running' });
    const last = await runBackfillStep(w.deps, w.job(), opts);
    expect(last.job.status).toBe('done');
  });

  test('tenant usage at/above the threshold → paused, nothing read', async () => {
    const w = world({ tickets: [T(1)], usage: 63 });
    const r = await runBackfillStep(w.deps, w.job(), opts);
    expect(r.paused).toMatch(/63%/);
    expect(w.calls).toHaveLength(0);
  });

  test('budget cut mid-history: cursor stays at the last finished ticket; the next step resumes there without duplicates', async () => {
    const w = world({ tickets: [T(1), T(2), T(3)] });
    // usage 1 + tickets 1 + notes 1 + time 1 = 4, then 1 per history: budget 10 covers all 3 small histories.
    const r = await runBackfillStep(w.deps, w.job(), { ...opts, maxApiCalls: 10 });
    expect(r.ticketsProcessed).toBe(3);
    const w2 = world({ tickets: [T(1), T(2), T(3)] });
    const capped = { ...w2.deps, usagePct: async () => 0 };
    // Large histories (1,200 rows = 3 calls each) exhaust the same budget after two tickets.
    (capped.http.query as jest.Mock).mockImplementation(async (entity: string, filters: any[], o2: any) => {
      w2.calls.push({ entity, filters, max: o2.maxRecords });
      if (entity === 'Tickets') return [T(1), T(2), T(3)].filter((t) => t.id > Number(filters.find((f: any) => f.op === 'gt').value));
      if (entity === 'TicketHistory') return Array.from({ length: 1200 }, (_, i) => ({ id: Number(filters[0].value) * 10_000 + i, action: 'Status Changed', date: '2026-01-20T10:00:00Z', detail: 'Status changed from New to Complete', resourceID: 10 }));
      return [];
    });
    const s1 = await runBackfillStep(capped, w2.job(), { ...opts, maxApiCalls: 10 });
    expect(s1).toMatchObject({ stoppedBy: 'budget', ticketsProcessed: 2 });
    expect(w2.job().cursor).toBe(2);
    const s2 = await runBackfillStep(capped, w2.job(), { ...opts, maxApiCalls: 10 });
    expect(s2.ticketsProcessed).toBe(1);
    expect(w2.job().cursor).toBe(3);
  });

  test('history already indexed after the last change is skipped (0 calls)', async () => {
    const w = world({ tickets: [T(1, '2026-02-01T00:00:00Z')], fetched: new Map([[1, new Date('2026-03-01T00:00:00Z')]]) });
    await runBackfillStep(w.deps, w.job(), opts);
    expect(w.calls.map((c) => c.entity)).not.toContain('TicketHistory');
    expect(w.job().cursor).toBe(1);
  });

  test('an Autotask error stops the step, is recorded on the job, and is not retried', async () => {
    const w = world({ tickets: [T(1)], fail: 'TicketNotes' });
    const r = await runBackfillStep(w.deps, w.job(), opts);
    expect(r).toMatchObject({ stoppedBy: 'error', error: 'Autotask 500' });
    expect(w.job()).toMatchObject({ cursor: 0, lastError: 'Autotask 500', status: 'running' });
    expect(w.calls.filter((c) => c.entity === 'TicketNotes')).toHaveLength(1);
  });
});
