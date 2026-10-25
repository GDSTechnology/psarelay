// Company 0 is the tenant's OWN company (Autotask's owner account) — a real id
// that internal tickets, contacts, contracts and quotes live on. It must never
// be treated as "no company": not rejected, not dropped from a filter, not
// missing from the write log or the mirror's dirty marks.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import { parseWrite } from '../src/utils/operation-context';
import { writtenRow } from '../src/db/shadow-runtime';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

function mk() {
  const s = new AutotaskService(config, logger);
  const query = jest.fn(async (_entity: string, _filter: unknown) => [] as unknown[]);
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query, create: jest.fn(), update: jest.fn() });
  return { s, query };
}
const text = async (p: Promise<{ content: Array<{ text: string }> }>) => JSON.parse((await p).content[0]!.text);

test('get_company and find_duplicate_companies accept 0; an empty id is still refused', async () => {
  const { s } = mk();
  const full = jest.spyOn(s, 'getCompanyFull').mockResolvedValue({ company: { companyName: 'GDS Technology', isActive: true, createDate: '2018-01-01' }, labels: {}, names: {}, udfs: [] } as never);
  const h = new AutotaskToolHandler(s, logger);
  expect((await text(h.callTool('autotask_get_company', { companyID: 0 }))).message).toMatch(/^Company 0: "GDS Technology"/);
  expect(full).toHaveBeenCalledWith(0);
  const dup = jest.spyOn(s, 'findDuplicateCompanies').mockResolvedValue({ status: 'ok', candidates: [], clusters: [] } as never);
  await h.callTool('autotask_find_duplicate_companies', { companyId: 0 });
  expect(dup).toHaveBeenCalledWith(0);
  full.mockClear();
  const none = await text(h.callTool('autotask_get_company', {}));
  expect(JSON.stringify(none)).toMatch(/No company found|companyID is required/);
  expect(full).not.toHaveBeenCalled(); // an empty id is never looked up as company 0
});

test('search_quotes / search_opportunities keep the companyID = 0 filter', async () => {
  const { s, query } = mk();
  await s.searchQuotes({ companyId: 0 });
  await s.searchOpportunities({ companyId: 0 });
  for (const [, filter] of query.mock.calls) expect(filter).toEqual(expect.arrayContaining([expect.objectContaining({ field: "companyID", value: 0 })]));
});

test('the write log and the mirror see writes to company 0', () => {
  expect(parseWrite('PATCH', '/Companies', { id: 0, phone: '555' }, {})).toMatchObject({ entityId: 0 });
  expect(parseWrite('POST', '/Companies/0/Contacts', { firstName: 'A' }, { itemId: 77 })).toMatchObject({ parentId: 0, entityId: 77 });
  expect(writtenRow('/Companies', { id: 0 }, {})).toEqual({ entity: 'Companies', id: 0 });
  expect(writtenRow('/Companies', {}, {})).toBeNull(); // no id is not company 0
});
