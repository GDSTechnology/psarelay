// On-demand company names (default) + title keyword search on search_tickets.
// 2026-09-30: one ticket search cost 13 upstream calls — 1 ticket query plus a
// walk of every company (~4.5k, 9+ pages) to name the rows; and search_tickets
// had no title filter, so finding an existing ticket meant listing a whole
// company's open tickets page by page.

import { MappingService, _resetTenantCacheStore } from '../src/utils/mapping.service';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices3.autotask.net/ATServicesRest/' } };

const svc = (names: Record<number, string> = { 1: 'Fourth Coffee', 2: '100 Example Ave', 3: 'Example Holdings LP' }) => ({
  listAllCompanies: jest.fn(async () => []),
  getCompanyNamesByIds: jest.fn(async (ids: number[]) => ids.filter((id) => names[id]).map((id) => ({ id, companyName: names[id]! }))),
  getCompany: jest.fn(async () => null),
  searchResources: jest.fn(async () => ({ items: [], page: 1, pageSize: 500, hasMore: false })),
  listAllResources: jest.fn(async () => []),
  getResource: jest.fn(async () => null),
});

beforeEach(() => { _resetTenantCacheStore(); delete process.env.AUTOTASK_COMPANY_PREWARM; });

describe('MappingService — on-demand company names (default)', () => {
  test('creating the service does NOT walk every company', async () => {
    const s = svc();
    await MappingService.create(s as unknown as AutotaskService, logger, { tenantKey: 'u@e.com' });
    expect(s.listAllCompanies).not.toHaveBeenCalled();
  });

  test('primeCompanies looks up only the missing ids, in ONE batch; then serves from memory', async () => {
    const s = svc();
    const m = await MappingService.create(s as unknown as AutotaskService, logger, { tenantKey: 'u@e.com' });
    await m.primeCompanies([1, 2, 2, null, undefined, 3]);
    expect(s.getCompanyNamesByIds).toHaveBeenCalledTimes(1);
    expect(s.getCompanyNamesByIds).toHaveBeenCalledWith([1, 2, 3]);
    expect(await m.getCompanyName(2)).toBe('100 Example Ave');
    await m.primeCompanies([1, 3]);
    expect(s.getCompanyNamesByIds).toHaveBeenCalledTimes(1); // all known — no call
    expect(s.getCompany).not.toHaveBeenCalled(); // never a per-id GET
  });

  test('a name past cacheExpiryMs is re-fetched', async () => {
    const s = svc();
    const m = new MappingService(s as unknown as AutotaskService, logger, 60_000, false, 'u@e.com');
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await m.primeCompanies([1]);
    now.mockReturnValue(1_000_000 + 59_000);
    await m.primeCompanies([1]);
    now.mockReturnValue(1_000_000 + 61_000);
    await m.primeCompanies([1]);
    expect(s.getCompanyNamesByIds).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  test('getCompanyName alone batches the single id; a failed lookup keeps known names', async () => {
    const s = svc();
    const m = await MappingService.create(s as unknown as AutotaskService, logger, { tenantKey: 'u@e.com' });
    expect(await m.getCompanyName(3)).toBe('Example Holdings LP');
    s.getCompanyNamesByIds.mockRejectedValueOnce(new Error('429'));
    expect(await m.getCompanyName(9)).toBeNull();
    expect(await m.getCompanyName(3)).toBe('Example Holdings LP');
  });

  test('names stay per tenant (2026-06-03 isolation invariant)', async () => {
    const a = svc({ 1: 'Tenant A Co' });
    const b = svc({ 1: 'Tenant B Co' });
    const ma = await MappingService.create(a as unknown as AutotaskService, logger, { tenantKey: 'a@x.com' });
    const mb = await MappingService.create(b as unknown as AutotaskService, logger, { tenantKey: 'b@x.com' });
    expect(await ma.getCompanyName(1)).toBe('Tenant A Co');
    expect(await mb.getCompanyName(1)).toBe('Tenant B Co');
  });

  test('AUTOTASK_COMPANY_PREWARM=on restores the full walk', async () => {
    process.env.AUTOTASK_COMPANY_PREWARM = 'on';
    const s = svc();
    await MappingService.create(s as unknown as AutotaskService, logger, { tenantKey: 'u@e.com' });
    expect(s.listAllCompanies).toHaveBeenCalledTimes(1);
  });
});

describe('getCompanyNamesByIds', () => {
  test('one `in` query per 200 ids, names only', async () => {
    const s = new AutotaskService(config, logger);
    const query = jest.fn(async (_e: string, _f: unknown, _o?: unknown) => [{ id: 1, companyName: 'Fourth Coffee' }, { id: 2 }]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const out = await s.getCompanyNamesByIds(ids);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![1]).toEqual([{ op: 'in', field: 'id', value: ids.slice(0, 200) }]);
    expect(query.mock.calls[0]![2]).toEqual(expect.objectContaining({ includeFields: ['id', 'companyName'] }));
    expect(out).toEqual([{ id: 1, companyName: 'Fourth Coffee' }, { id: 1, companyName: 'Fourth Coffee' }]);
  });
});

describe('search_tickets — title keyword search (filter payload sent upstream)', () => {
  const ticketFilters = async (args: Record<string, unknown>) => {
    const s = new AutotaskService(config, logger);
    const query = jest.fn(async (_e: string, _f: unknown, _o?: unknown) => [] as unknown[]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    await s.searchTickets(args as never);
    return query.mock.calls.find((c) => c[0] === 'Tickets')![1] as unknown[];
  };

  test('title + companyID → server-side contains on title, scoped to the company', async () => {
    expect(await ticketFilters({ title: 'ThreatLocker', companyId: 29684117 })).toEqual([
      { op: 'contains', field: 'title', value: 'ThreatLocker' },
      { op: 'noteq', field: 'status', value: 5 },
      { op: 'eq', field: 'companyID', value: 29684117 },
    ]);
  });

  test.each([
    ['T20260921.0086', { op: 'beginsWith', field: 'ticketNumber', value: 'T20260921.0086' }],
    ['T20260921', { op: 'beginsWith', field: 'ticketNumber', value: 'T20260921' }],
    ['20260921.0086', { op: 'beginsWith', field: 'ticketNumber', value: 'T20260921.0086' }],
    ['Lenel', { op: 'contains', field: 'title', value: 'Lenel' }],
    ['  passkey  ', { op: 'contains', field: 'title', value: 'passkey' }],
  ])('searchTerm %j → %j', async (term, filter) => {
    expect((await ticketFilters({ searchTerm: term }))[0]).toEqual(filter);
  });

  test('the handler treats a title-only search as filtered (no date prompt) and passes it through', async () => {
    const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
    const s = new AutotaskService(config, logger);
    const search = jest.spyOn(s, 'searchTickets').mockResolvedValue({ items: [], page: 1, pageSize: 25, hasMore: false } as never);
    const h = new AutotaskToolHandler(s, logger);
    const elicit = jest.spyOn(h as any, 'elicitDateRange');
    (h as any).mcpServer = {};
    await h.callTool('autotask_search_tickets', { title: 'ThreatLocker', companyID: 29684117 });
    expect(elicit).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ title: 'ThreatLocker', companyId: 29684117 }));
  });

  test('each ticket row carries status / priority / queue LABELS and its Autotask link (no "Status 18")', async () => {
    const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'searchTickets').mockResolvedValue({ items: [{ id: 501, ticketNumber: 'T20260101.0001', title: 'No internet', status: 18, priority: 2, queueID: 7, companyID: 1 }], page: 1, pageSize: 25, hasMore: false } as never);
    const pick = (name: string, values: Array<[number, string]>) => ({ name, dataType: 'integer', isPickList: true, picklistValues: values.map(([value, label]) => ({ value: String(value), label, isActive: true })) });
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([pick('status', [[1, 'New'], [18, 'Waiting Customer']]), pick('priority', [[2, 'High']]), pick('queueID', [[7, 'Service Desk']])] as never);
    jest.spyOn(s, 'getTicketWebUrl').mockReturnValue('https://ww3.example/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketID=501');
    const h = new AutotaskToolHandler(s, logger);
    const out = await h.callTool('autotask_search_tickets', { assignedResourceID: 42 });
    const text = out.content[0].text as string;
    expect(text).toContain('"statusLabel":"Waiting Customer"');
    expect(text).toContain('"priorityLabel":"High"');
    expect(text).toContain('"queueLabel":"Service Desk"');
    expect(text).toContain('TicketID=501');
  });

  test('"my tickets": assignedToMe filters on the signed-in person (no resource-id lookup by the client)', async () => {
    const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
    const s = new AutotaskService(config, logger);
    const search = jest.spyOn(s, 'searchTickets').mockResolvedValue({ items: [], page: 1, pageSize: 25, hasMore: false } as never);
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([] as never);
    const h = new AutotaskToolHandler(s, logger);
    jest.spyOn(h, 'resolveCaller').mockResolvedValue({ status: 'resolved', via: 'token', resource: { id: 4242, name: 'Jane Doe' } } as never);
    await h.callTool('autotask_search_tickets', { assignedToMe: true, priority: 1 });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ assignedResourceID: 4242, priority: 1 }));
    expect(search.mock.calls[0]![0]).not.toHaveProperty('assignedToMe');
  });

  test('my day: tickets carry labels, company name and link; a missing-time item names its ticket (no "Company ID 29683560")', async () => {
    const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
    const s = new AutotaskService(config, logger);
    const day = { date: '2026-10-27', assignedTickets: [{ id: 501, ticketNumber: 'T20261026.0099', title: 'No Internet and Phones', status: 18, priority: 2, companyID: 77 }],
      missingTime: [{ ticketID: 501, serviceCallIDs: [9], scheduledHours: 4, reason: 'service_call_without_time' }], openTasks: [], serviceCalls: [], openTodos: [], timeEntries: [],
      totals: { assignedTickets: 1, serviceCalls: 1, openTodos: 0, missingTime: 1, timeEntries: 0, hoursLogged: 0 } };
    jest.spyOn(s, 'getMyDay').mockResolvedValue(day as never);
    const pick = (name: string, values: Array<[number, string]>) => ({ name, dataType: 'integer', isPickList: true, picklistValues: values.map(([value, label]) => ({ value: String(value), label, isActive: true })) });
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([pick('status', [[18, 'Waiting Customer']]), pick('priority', [[2, 'High']])] as never);
    jest.spyOn(s, 'getTicketWebUrl').mockImplementation((id: number) => `https://ww3.example/x?TicketID=${id}`);
    const h = new AutotaskToolHandler(s, logger);
    jest.spyOn(h as any, 'enhanceItems').mockImplementation(async (rows: any) => rows.map((r: any) => ({ ...r, company: 'Acme Properties' })));
    const out = await h.callTool('autotask_get_my_day', { resourceID: 42 });
    const text = out.content[0].text as string;
    expect(text).toContain('"statusLabel":"Waiting Customer"');
    expect(text).toContain('"priorityLabel":"High"');
    expect(text).toContain('"company":"Acme Properties"');
    // The missing-time item names its ticket.
    expect(text).toMatch(/"ticketID":501[^}]*"ticketNumber":"T20261026\.0099"[^}]*"company":"Acme Properties"[^}]*"ticketUrl":"https:\/\/ww3\.example\/x\?TicketID=501"/);
  });
});
