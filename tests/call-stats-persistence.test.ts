// The console's hourly traffic counts (Reads by entity, Tool gaps) survive a
// restart: saved to Postgres, added back at start (on top of anything counted
// since), and summarised on the Overview as THIS MCP's live reads and tool gaps.

import { runToolCall, startApiCall, noteRawRequest, noteToolAudit, entityReadStats, toolGapStats, snapshotStats, restoreStats, _resetCallLog } from '../src/services/call-log';
import { saveStats, loadStats, startCallStatsPersistence } from '../src/db/call-stats-store';
import { mcpTrafficSummary } from '../src/admin/server';

beforeEach(() => _resetCallLog());

const raw = (method: string, path: string) =>
  runToolCall('autotask_raw_request', async () => { noteRawRequest(method, path); noteToolAudit({ outcome: 'ok', durationMs: 1, source: 'n8n', ip: '172.19.0.3', userAgent: 'n8n' }); return {}; });
const reads = (tool: string, path: string, n: number) => runToolCall(tool, async () => { for (let i = 0; i < n; i++) startApiCall('POST', path)(200); return {}; });

/** An in-memory stand-in for the mcp_call_stat_hour table. */
function fakeDb() {
  const rows = new Map<string, { hour: number; kind: string; key: string; data: unknown }>();
  return {
    rows,
    query: async (sql: string, p: unknown[] = []) => {
      if (sql.startsWith('INSERT')) {
        const [hours, kinds, keys, data] = p as [number[], string[], string[], string[]];
        hours.forEach((h, i) => rows.set(`${h}|${kinds[i]}|${keys[i]}`, { hour: h, kind: kinds[i]!, key: keys[i]!, data: JSON.parse(data[i]!) }));
        return { rows: [] };
      }
      if (sql.startsWith('SELECT')) return { rows: [...rows.values()].filter((r) => r.hour > Number(p[0])) };
      return { rows: [] };
    },
  };
}

test('counts round-trip through Postgres and restore ADDS to what arrived since the restart', async () => {
  await reads('autotask_search_quotes', '/Quotes/query', 5);
  await raw('PATCH', '/TicketNotes');
  await raw('PATCH', '/TicketNotes');
  const db = fakeDb();
  await saveStats(db as never, snapshotStats(0));
  expect([...db.rows.values()].map((r) => r.kind).sort()).toEqual(['gap', 'read']);

  _resetCallLog(); // the restart
  await reads('autotask_search_quotes', '/Quotes/query', 2); // traffic before the restore ran
  expect(restoreStats(await loadStats(db as never))).toBe(2);
  expect(entityReadStats(24).entities.find((e) => e.entity === 'Quotes')).toMatchObject({ upstream: 7, topCallers: [{ caller: 'autotask_search_quotes', count: 7 }] });
  expect(toolGapStats(168).raw).toEqual([expect.objectContaining({ shape: 'PATCH /TicketNotes', calls: 2, callers: [{ caller: 'n8n · 172.19.0.3 · n8n', count: 2 }] })]);
});

test('a missing table never breaks start: counts stay in memory', async () => {
  const warn = jest.fn();
  const stop = await startCallStatsPersistence({ query: async () => { throw new Error('relation "mcp_call_stat_hour" does not exist'); } } as never, { info: jest.fn(), warn } as never);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/run the migrations \(0013\)/));
  stop();
});

test('the Overview summary: live reads by entity, and raw_request calls no tool covers vs ones that have a tool', async () => {
  await reads('autotask_search_quotes', '/Quotes/query', 60);
  await raw('PATCH', '/TicketNotes');      // no tool covers it
  await raw('POST', '/Tickets/query');     // search_tickets covers it
  const s = mcpTrafficSummary(24) as { reads: { live: number; top: Array<{ entity: string; live: number; candidate: boolean }> }; gaps: { uncoveredCalls: number; uncoveredShapes: number; coveredCalls: number; top: Array<{ shape: string }> } };
  expect(s.reads.live).toBe(60);
  expect(s.reads.top[0]).toMatchObject({ entity: 'Quotes', live: 60, candidate: true });
  expect(s.gaps).toMatchObject({ uncoveredCalls: 1, uncoveredShapes: 1, coveredCalls: 1, top: [{ shape: 'PATCH /TicketNotes' }] });
});
