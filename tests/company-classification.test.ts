// autotask_search_companies by Classification: an exact label or id, resolved
// against the tenant's live picklist; server-side filter combined with the name
// / active filters; rows carry classification {id, label} or null.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { matchPicklistExact } from '../src/utils/staff-tools';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

const CLASS = [
  { value: '204', label: 'At Risk Account', isActive: true },
  { value: '202', label: 'Reseller', isActive: true },
  { value: '203', label: 'Reseller Account', isActive: true },
  { value: '201', label: 'No Fit', isActive: false },
];
const TYPES = [{ value: '1', label: 'Customer', isActive: true }, { value: '3', label: 'Prospect', isActive: true }];

function mk(rows: unknown[] = [{ id: 11, companyName: 'Example Account', classification: 204, isActive: true }, { id: 12, companyName: 'Plain Co', classification: null, isActive: true }]) {
  const s = new AutotaskService(config, logger);
  const query = jest.fn(async (_entity: string, _filter: unknown, _opts?: unknown) => rows);
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query, create: jest.fn(), update: jest.fn() });
  jest.spyOn(s, 'getPicklistValues').mockImplementation(async (_e: string, f: string) => (f === 'classification' ? CLASS : TYPES) as never);
  return { s, query, h: new AutotaskToolHandler(s, logger) };
}
const call = async (h: AutotaskToolHandler, args: Record<string, unknown>) => { const p = JSON.parse((await h.callTool("autotask_search_companies", args)).content[0]!.text); if (p.error) throw new Error(p.error); return { ...p, result: p.data ?? p.items }; };
const filterOf = (query: jest.Mock) => query.mock.calls.find(([e]) => e === 'Companies')?.[1] as Array<{ field: string; op: string; value: unknown }>;

test('exact label (any case) or id → a server-side classification filter, combined with name and active', async () => {
  const { h, query } = mk();
  const r = await call(h, { classification: 'at risk account', searchTerm: 'Example', isActive: true, pageSize: 100 });
  expect(filterOf(query)).toEqual(expect.arrayContaining([
    { op: 'eq', field: 'classification', value: 204 }, { op: 'contains', field: 'companyName', value: 'Example' }, { op: 'eq', field: 'isActive', value: true },
  ]));
  expect(r.message).toMatch(/classified "At Risk Account" \(204\)/);
  expect(r.result[0].classification).toEqual({ id: 204, label: 'At Risk Account' });
  expect(r.result[1].classification).toBeNull();
  query.mockClear();
  await call(h, { classification: '204' });
  expect(filterOf(query)).toEqual([{ op: 'eq', field: 'classification', value: 204 }]);
});

test('"Reseller" is exact, never "Reseller Account"; a partial is a suggestion, not a match', async () => {
  const { h, query } = mk();
  await call(h, { classification: 'Reseller' });
  expect(filterOf(query)).toEqual([{ op: 'eq', field: 'classification', value: 202 }]);
  query.mockClear();
  const r = await call(h, { classification: 'Resell' });
  expect(r.result).toMatchObject({ status: 'invalid_classification', suggestions: [{ value: 202, label: 'Reseller' }, { value: 203, label: 'Reseller Account' }] });
  expect(r.message).toMatch(/did you mean/);
  expect(query).not.toHaveBeenCalled(); // nothing searched on a guess
});

test('inactive labels only on request; an id always; unknown → the active choices', async () => {
  const { h, query } = mk();
  const r = await call(h, { classification: 'No Fit' });
  expect(r.result).toMatchObject({ status: 'invalid_classification', inactiveMatch: { value: 201 } });
  expect(r.message).toMatch(/INACTIVE — pass includeInactiveClassifications/);
  expect(r.result.choices.map((c: { value: number }) => c.value)).not.toContain(201);
  await call(h, { classification: 'No Fit', includeInactiveClassifications: true });
  expect(filterOf(query)).toEqual([{ op: 'eq', field: 'classification', value: 201 }]);
  query.mockClear();
  expect((await call(h, { classification: 999 })).result.status).toBe('invalid_classification');
  expect(query).not.toHaveBeenCalled();
});

test('classification stays plain mode: companyType is a filter; identity-only fields are refused', async () => {
  const { h, query } = mk();
  await call(h, { classification: 204, companyType: 'Customer', name: 'Example' });
  expect(filterOf(query)).toEqual(expect.arrayContaining([{ op: 'eq', field: 'companyType', value: 1 }, { op: 'contains', field: 'companyName', value: 'Example' }]));
  const r = await call(h, { classification: 204, phone: '555-1212' });
  expect(r.result).toMatchObject({ status: 'invalid_combination', fields: ['phone'] });
});

test('plain search without classification also labels each row', async () => {
  const { h } = mk();
  const r = await call(h, { searchTerm: "Ex" });
  expect(r.result.map((c: { classification: unknown }) => c.classification)).toEqual([{ id: 204, label: 'At Risk Account' }, null]);
});

test('matchPicklistExact: duplicate labels are ambiguous', () => {
  const m = matchPicklistExact([{ value: '1', label: 'Gold', isActive: true }, { value: '2', label: 'gold', isActive: true }] as never, 'GOLD');
  expect(m).toMatchObject({ ok: false, reason: 'ambiguous', choices: [{ value: 1 }, { value: 2 }] });
});
