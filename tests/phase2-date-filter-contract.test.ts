// MCP-CORE-002 / MCP-DEF-002 — date filter contract tests.
//
// `autotask_search_service_calls` advertises `startAfter`/`startBefore`, the
// handler passes those args straight through, but the service only ever read
// `options.startDate`/`options.endDate`. Every filter was therefore dropped and
// the query fell through to the MATCH_ALL sentinel — which is why a request
// scoped to 2026 came back with service calls from 2007, 2013 and 2016.
//
// These tests assert on the filter payload actually sent to Autotask, so a
// rename on either side of the boundary fails here instead of silently
// returning the whole table.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' },
};

function res(status: number, body?: any): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (body !== undefined ? JSON.stringify(body) : '') } as unknown as Response;
}

/** Capture the query bodies sent upstream; serve an empty result set. */
function captureQueries(): Array<any> {
  const bodies: any[] = [];
  jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const init = (args[1] || {}) as RequestInit;
    bodies.push(JSON.parse((init.body as string) || '{}'));
    return Promise.resolve(res(200, { items: [], pageDetails: { nextPageUrl: null } }));
  });
  return bodies;
}

/** The "give me everything" sentinel the service falls back to with no filters. */
const MATCH_ALL = [{ op: 'gte', field: 'id', value: 0 }];

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('MCP-DEF-002 — service call date filtering', () => {
  test('startAfter/startBefore become startDateTime bounds, not MATCH_ALL', async () => {
    const bodies = captureQueries();
    await new AutotaskService(config, logger).searchServiceCalls({
      startAfter: '2026-09-01T00:00:00Z',
      startBefore: '2026-09-30T23:59:59Z',
    } as any);

    expect(bodies[0].filter).not.toEqual(MATCH_ALL);
    expect(bodies[0].filter).toEqual(expect.arrayContaining([
      { op: 'gte', field: 'startDateTime', value: '2026-09-01T00:00:00Z' },
      { op: 'lte', field: 'startDateTime', value: '2026-09-30T23:59:59Z' },
    ]));
  });

  test('both bounds constrain startDateTime so a call running past the window is still matched', async () => {
    // Filtering the upper bound on endDateTime (the previous behavior) drops any
    // service call that starts inside the range but finishes after it.
    const bodies = captureQueries();
    await new AutotaskService(config, logger).searchServiceCalls({
      startAfter: '2026-09-01', startBefore: '2026-09-07',
    } as any);
    const fields = bodies[0].filter.map((f: any) => f.field);
    expect(fields).not.toContain('endDateTime');
  });

  test('start-only and end-only filters each work on their own', async () => {
    const bodies = captureQueries();
    const svc = new AutotaskService(config, logger);

    await svc.searchServiceCalls({ startAfter: '2026-09-01' } as any);
    expect(bodies[0].filter).toEqual([{ op: 'gte', field: 'startDateTime', value: '2026-09-01' }]);

    await svc.searchServiceCalls({ startBefore: '2026-09-30' } as any);
    expect(bodies[1].filter).toEqual([{ op: 'lte', field: 'startDateTime', value: '2026-09-30' }]);
  });

  test('companyId and status are translated instead of dropped', async () => {
    const bodies = captureQueries();
    await new AutotaskService(config, logger).searchServiceCalls({
      companyId: 4242, status: 3, startAfter: '2026-09-01',
    } as any);
    expect(bodies[0].filter).toEqual(expect.arrayContaining([
      { op: 'eq', field: 'companyID', value: 4242 },
      { op: 'eq', field: 'status', value: 3 },
    ]));
  });

  test('legacy startDate/endDate callers keep working as aliases', async () => {
    const bodies = captureQueries();
    await new AutotaskService(config, logger).searchServiceCalls({
      startDate: '2026-09-01', endDate: '2026-09-30',
    } as any);
    expect(bodies[0].filter).toEqual(expect.arrayContaining([
      { op: 'gte', field: 'startDateTime', value: '2026-09-01' },
      { op: 'lte', field: 'startDateTime', value: '2026-09-30' },
    ]));
  });

  test('an unfiltered search still falls back to MATCH_ALL', async () => {
    const bodies = captureQueries();
    await new AutotaskService(config, logger).searchServiceCalls({});
    expect(bodies[0].filter).toEqual(MATCH_ALL);
  });
});

describe('MCP-CORE-002 — date filters across other search tools', () => {
  const cases: Array<{ name: string; run: (s: AutotaskService) => Promise<any>; expected: any[] }> = [
    {
      name: 'time entries — dateWorked bounds',
      run: (s) => s.searchTimeEntries({ dateWorkedAfter: '2026-08-01', dateWorkedBefore: '2026-08-31' } as any),
      expected: [
        { op: 'gte', field: 'dateWorked', value: '2026-08-01' },
        { op: 'lte', field: 'dateWorked', value: '2026-08-31' },
      ],
    },
    {
      name: 'tickets — createDate bounds',
      run: (s) => s.searchTickets({ createdAfter: '2026-08-01', createdBefore: '2026-08-31' } as any),
      expected: [
        { op: 'gte', field: 'createDate', value: '2026-08-01' },
        { op: 'lte', field: 'createDate', value: '2026-08-31' },
      ],
    },
    {
      name: 'billing items — itemDate bounds',
      run: (s) => s.searchBillingItems({ dateFrom: '2026-08-01', dateTo: '2026-08-31' } as any),
      expected: [
        { op: 'gte', field: 'itemDate', value: '2026-08-01' },
        { op: 'lte', field: 'itemDate', value: '2026-08-31' },
      ],
    },
    {
      name: 'billing items — postedDate bounds',
      run: (s) => s.searchBillingItems({ postedAfter: '2026-08-01', postedBefore: '2026-08-31' } as any),
      expected: [
        { op: 'gte', field: 'postedDate', value: '2026-08-01' },
        { op: 'lte', field: 'postedDate', value: '2026-08-31' },
      ],
    },
  ];

  test.each(cases)('$name reach Autotask as filters', async ({ run, expected }) => {
    const bodies = captureQueries();
    await run(new AutotaskService(config, logger));
    expect(bodies[0].filter).not.toEqual(MATCH_ALL);
    expect(bodies[0].filter).toEqual(expect.arrayContaining(expected));
  });
});
