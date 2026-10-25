// API budget guards (2026-09-30 incident: an n8n workload hit HTTP 429 and the
// whole tenant went into cooldown). Every caller shares one Autotask API user,
// and Autotask limits per-integration requests per hour AND concurrent
// requests — so the expensive paths must be sequential, batched and skippable.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices3.autotask.net/ATServicesRest/' } };
const logger = new Logger('error');

/** A query mock that records the peak number of calls in flight. */
function trackingQuery(rows: (entity: string) => unknown[] = () => []) {
  let inFlight = 0;
  const state = { peak: 0, calls: [] as string[] };
  const query = jest.fn(async (entity: string, _filter?: unknown, _opts?: unknown) => {
    inFlight++; state.peak = Math.max(state.peak, inFlight); state.calls.push(entity);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return rows(entity);
  });
  return { query, state };
}

describe('getResourceNames', () => {
  test('one batched `in` query, then served from the memo', async () => {
    const s = new AutotaskService(config, logger);
    const { query, state } = trackingQuery((e) => (e === 'Resources' ? [{ id: 1, firstName: 'Travis', lastName: 'Stives' }, { id: 2, firstName: 'Tricia', lastName: 'Clearman' }] : []));
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    const a = await s.getResourceNames([1, 2, 2, 1]);
    expect(a).toEqual(new Map([[1, 'Travis Stives'], [2, 'Tricia Clearman']]));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toEqual([{ op: 'in', field: 'id', value: [1, 2] }]);
    await s.getResourceNames([2, 1]);
    expect(state.calls).toEqual(['Resources']); // memo: no second call
  });

  test('a failed lookup returns what the memo has, never throws', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: jest.fn().mockRejectedValue(new Error('429')) });
    await expect(s.getResourceNames([1])).resolves.toEqual(new Map());
  });
});

describe('reportActivityWithoutTime runs its Autotask queries one at a time', () => {
  test('peak concurrency is 1', async () => {
    const s = new AutotaskService(config, logger);
    const { query, state } = trackingQuery();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([] as any);
    await s.reportActivityWithoutTime({ resourceIDs: [30683880, 30683829], from: '2026-09-22', to: '2026-09-29', timeZone: 'America/New_York' });
    expect(state.peak).toBe(1);
    expect(state.calls.filter((c) => c === 'TicketNotes')).toHaveLength(2);
  });
});

describe('ticket card is not built for unattended callers', () => {
  const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
  const run = async (meta: Record<string, unknown> | undefined) => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'getTicket').mockResolvedValue({ id: 208520, ticketNumber: 'T20260921.0086', title: 'x' } as any);
    const notes = jest.spyOn(s, 'searchTicketNotes').mockResolvedValue([]);
    const time = jest.spyOn(s, 'searchTimeEntries').mockResolvedValue({ items: [], page: 1, pageSize: 500, hasMore: false } as any);
    const h = new AutotaskToolHandler(s, logger);
    jest.spyOn(h as any, 'enhanceItems').mockImplementation(async (x: any) => x);
    const res = await h.callTool('autotask_get_ticket_details', { ticketID: 208520, ...(meta ? { _context: meta } : {}) });
    return { data: JSON.parse(res.content[0].text).data, cardReads: notes.mock.calls.length + time.mock.calls.length };
  };

  test.each(['n8n', 'cron'])('source %s: no card, no card reads', async (source) => {
    const r = await run({ source });
    expect(r.data._card).toBeUndefined();
    expect(r.cardReads).toBe(0);
  });

  test.each([['chatgpt'], [undefined]])('source %s: card is built', async (source) => {
    const r = await run(source ? { source } : undefined);
    expect(r.data._card).toEqual(expect.objectContaining({ id: 208520 }));
  });
});
