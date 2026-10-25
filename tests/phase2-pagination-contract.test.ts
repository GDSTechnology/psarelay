// MCP-CORE-001 — pagination contract tests.
//
// Every search tool that advertises a `page` parameter must actually advance
// through the result set. Before this suite, `page` was accepted and discarded
// by 7 of the 9 tools exposing it: the service read only `pageSize` into
// `maxRecords`, so page 2 re-sent the identical first-N query and returned the
// same records as page 1 while reporting itself as page 2 (MCP-DEF-001).
//
// Autotask's REST API paginates by cursor (`pageDetails.nextPageUrl`) and has no
// offset parameter, so these tests drive a fake cursor-paginated dataset and
// assert the offset-style contract the MCP exposes on top of it.

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

/**
 * Stand up a fake cursor-paginated Autotask entity holding `total` records with
 * ids 1..total, mirroring the real API: each response carries at most the
 * requested `MaxRecords`, and a `nextPageUrl` whenever more remain. The walk
 * offset rides in the nextPageUrl exactly as Autotask's `paging` token does.
 */
function mockDataset(entity: string, total: number, opts: { allowOtherEntities?: boolean } = {}) {
  const all = Array.from({ length: total }, (_, i) => ({ id: i + 1, name: `${entity}-${i + 1}` }));
  const calls: Array<{ url: string; body: any }> = [];
  jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    const init = (args[1] || {}) as RequestInit;
    const body = JSON.parse((init.body as string) || '{}');
    calls.push({ url, body });
    if (!new RegExp(`/${entity}/query`).test(url)) {
      // Unrelated entities are a wrong-endpoint bug at the service level, but the
      // tool handler legitimately pre-warms its company/resource name caches, so
      // those tests opt into an empty 200 instead of a loud failure.
      return Promise.resolve(opts.allowOtherEntities
        ? res(200, { items: [], pageDetails: { nextPageUrl: null } })
        : res(599, { errors: [`unexpected ${url}`] }));
    }

    const max: number = body.MaxRecords ?? 500;
    const offset = Number(new URL(url, 'https://x.invalid').searchParams.get('paging') ?? 0);
    const items = all.slice(offset, offset + max);
    const nextOffset = offset + items.length;
    const pageDetails = nextOffset < all.length
      ? { nextPageUrl: `/${entity}/query/next?paging=${nextOffset}` }
      : { nextPageUrl: null };
    return Promise.resolve(res(200, { items, pageDetails }));
  });
  return { all, calls };
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('MCP-CORE-001 — pagination contract', () => {
  // The regression that started this: same range, page 1 vs page 2.
  test('MCP-DEF-001: time-entry page 2 returns different ids from page 1', async () => {
    mockDataset('TimeEntries', 60);
    const svc = new AutotaskService(config, logger);
    const opts = { dateWorkedAfter: '2026-08-01', dateWorkedBefore: '2026-08-31', pageSize: 25 };

    const p1 = await svc.searchTimeEntries({ ...opts, page: 1 } as any);
    const p2 = await svc.searchTimeEntries({ ...opts, page: 2 } as any);

    const ids1 = p1.items.map(i => (i as any).id);
    const ids2 = p2.items.map(i => (i as any).id);
    expect(ids1).not.toEqual(ids2);
    expect(ids1.filter(id => ids2.includes(id))).toEqual([]);
    expect(p1.page).toBe(1);
    expect(p2.page).toBe(2);
  });

  // Table-driven so a newly paginated tool is one line away from covered.
  const paginated: Array<{ name: string; entity: string; call: (s: AutotaskService, o: any) => Promise<any> }> = [
    { name: 'searchCompanies', entity: 'Companies', call: (s, o) => s.searchCompanies(o) },
    { name: 'searchContacts', entity: 'Contacts', call: (s, o) => s.searchContacts(o) },
    { name: 'searchTickets', entity: 'Tickets', call: (s, o) => s.searchTickets(o) },
    { name: 'searchProjects', entity: 'Projects', call: (s, o) => s.searchProjects(o) },
    { name: 'searchResources', entity: 'Resources', call: (s, o) => s.searchResources(o) },
    { name: 'searchTasks', entity: 'Tasks', call: (s, o) => s.searchTasks(o) },
    { name: 'searchTimeEntries', entity: 'TimeEntries', call: (s, o) => s.searchTimeEntries(o) },
    { name: 'searchBillingItems', entity: 'BillingItems', call: (s, o) => s.searchBillingItems(o) },
    { name: 'searchBillingItemApprovalLevels', entity: 'BillingItemApprovalLevels', call: (s, o) => s.searchBillingItemApprovalLevels(o) },
    { name: 'searchServiceCalls', entity: 'ServiceCalls', call: (s, o) => s.searchServiceCalls(o) },
    // searchPhases reads a child collection (/Projects/{id}/Phases/query), which
    // returns a single page rather than a cursor walk — so it is exercised at
    // sizes well inside that ceiling.
    { name: 'searchPhases', entity: 'Phases', call: (s, o) => s.searchPhases(7, o) },
  ];

  describe.each(paginated)('$name', ({ entity, call }) => {
    test('walks the whole result set with no repeats and terminates', async () => {
      mockDataset(entity, 55);
      const svc = new AutotaskService(config, logger);

      const seen: number[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const r = await call(svc, { page, pageSize: 10 });
        expect(r.page).toBe(page);
        expect(r.pageSize).toBe(10);
        expect(r.items.length).toBeLessThanOrEqual(10);
        seen.push(...r.items.map((i: any) => i.id));
        hasMore = r.hasMore;
        page++;
        if (page > 20) throw new Error('pagination did not terminate');
      }

      expect(seen).toHaveLength(55);
      expect(new Set(seen).size).toBe(55);
      expect(seen).toEqual(Array.from({ length: 55 }, (_, i) => i + 1));
    });

    test('hasMore is false on an exactly-full final page', async () => {
      // The old `items.length >= pageSize` heuristic reported "more" here and
      // cost the caller a wasted empty request.
      mockDataset(entity, 20);
      const svc = new AutotaskService(config, logger);
      const last = await call(svc, { page: 2, pageSize: 10 });
      expect(last.items).toHaveLength(10);
      expect(last.hasMore).toBe(false);
    });

    test('a page past the end is empty rather than a repeat of page 1', async () => {
      mockDataset(entity, 5);
      const svc = new AutotaskService(config, logger);
      const beyond = await call(svc, { page: 3, pageSize: 10 });
      expect(beyond.items).toEqual([]);
      expect(beyond.hasMore).toBe(false);
    });
  });
});

describe('MCP-CORE-001 — pagination metadata reaches the tool response', () => {
  test('search_time_entries reports the requested page and an honest hasMore', async () => {
    mockDataset('TimeEntries', 60, { allowOtherEntities: true });
    const { AutotaskToolHandler } = await import('../src/handlers/tool.handler');
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);

    const call = async (page: number) => {
      const r = await handler.callTool('autotask_search_time_entries', { page, pageSize: 25 });
      return JSON.parse((r.content[0] as any).text);
    };

    const p1 = await call(1);
    expect(p1.summary).toMatchObject({ page: 1, pageSize: 25, returned: 25, hasMore: true });

    const p3 = await call(3);
    // 60 records at 25/page → page 3 holds the final 10 and there is nothing after it.
    expect(p3.summary).toMatchObject({ page: 3, pageSize: 25, returned: 10, hasMore: false });

    const ids = (r: any) => r.items.map((i: any) => i.id);
    expect(ids(p1)).not.toEqual(ids(p3));
  });

  test('a full final page reports hasMore false rather than the old length heuristic', async () => {
    mockDataset('TimeEntries', 50, { allowOtherEntities: true });
    const { AutotaskToolHandler } = await import('../src/handlers/tool.handler');
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);

    const r = await handler.callTool('autotask_search_time_entries', { page: 2, pageSize: 25 });
    const body = JSON.parse((r.content[0] as any).text);
    expect(body.summary.returned).toBe(25);
    expect(body.summary.hasMore).toBe(false);
    expect(body.summary.hint).toBeUndefined();
  });
});
