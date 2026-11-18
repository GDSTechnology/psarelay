// Contract terms (#22): blocks, block-hour factors, rates, role costs, exclusions, retainers, ticket purchases —
// one tool family. Kind / operation / contract-type checks, fields against the live field list, duplicates,
// dry run by default, child routes for writes, read-back verification.

import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { classifyRisk } from '../src/utils/risk';
import { contractTypeProblem, findSameTerm, planContractTermFields } from '../src/utils/contract-terms';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

const f = (name: string, extra: Record<string, any> = {}) => ({ name, dataType: 'string', isRequired: false, isReadOnly: false, isQueryable: true, isReference: false, isPickList: false, ...extra });
const BLOCK_FIELDS = [
  f('id', { isReadOnly: true }), f('contractID', { isRequired: true }),
  f('datePurchased', { isRequired: true }), f('startDate', { isRequired: true }), f('endDate', { isRequired: true }),
  f('hours', { isRequired: true }), f('hourlyRate', { isRequired: true }), f('isPaid'),
  f('status', { isPickList: true, picklistValues: [{ value: '1', label: 'Active' }, { value: '0', label: 'Inactive' }] }),
  f('paymentType', { isPickList: true, picklistValues: [{ value: '1', label: 'Cash' }, { value: '2', label: 'Check' }, { value: '3', label: 'Credit Card' }] }),
  f('invoiceNumber', { isReadOnly: true }),
];
const RATE_FIELDS = [f('id', { isReadOnly: true }), f('contractID', { isRequired: true }), f('roleID', { isRequired: true }), f('contractHourlyRate', { isRequired: true })];

function world(contract: Record<string, any> | null, rowsByEntity: Record<string, Array<Record<string, any>>> = {}) {
  const store: Record<string, Array<Record<string, any>>> = JSON.parse(JSON.stringify(rowsByEntity));
  let next = 900;
  const entityOf: Record<string, string> = { Blocks: 'ContractBlocks', Rates: 'ContractRates', ExclusionRoles: 'ContractExclusionRoles' };
  const http = {
    get: jest.fn(async (e: string, id: number) => (e === 'Contracts' && contract && id === contract.id ? { ...contract } : null)),
    query: jest.fn(async (e: string, filters: any[]) => {
      const idf = filters.find((x) => x.field === 'id');
      return (store[e] ?? []).filter((r) => !idf || r.id === idf.value).map((r) => ({ ...r }));
    }),
    childCreate: jest.fn(async (_p: string, cid: number, child: string, body: any) => {
      const id = next++; (store[entityOf[child]!] ??= []).push({ id, ...body, contractID: cid }); return id;
    }),
    childUpdate: jest.fn(async (_p: string, _cid: number, child: string, id: number, body: any) => {
      const rows = store[entityOf[child]!]!; const i = rows.findIndex((r) => r.id === id); rows[i] = { ...rows[i], ...body };
    }),
    childDelete: jest.fn(async (_p: string, _cid: number, child: string, id: number) => {
      store[entityOf[child]!] = store[entityOf[child]!]!.filter((r) => r.id !== id);
    }),
    update: jest.fn(),
  };
  const svc = new AutotaskService(config, logger);
  jest.spyOn(svc as any, 'ensureClient').mockResolvedValue(http);
  jest.spyOn(svc, 'getFieldInfo').mockImplementation(async (e: string) => (e === 'ContractBlocks' ? BLOCK_FIELDS : RATE_FIELDS) as any);
  return { svc, http, store };
}
const BLOCK_CONTRACT = { id: 10, contractName: 'Block 20h', companyID: 0, contractType: 4, status: 1 };
const RECURRING = { id: 11, contractName: 'Managed', companyID: 3, contractType: 7, status: 1 };
const BLOCK = { datePurchased: '2026-11-18', startDate: '2026-12-01', endDate: '2026-12-31', hours: 20, hourlyRate: 125 };

describe('helpers', () => {
  test('contract type fit', () => {
    expect(contractTypeProblem('block', 4)).toBeNull();
    expect(contractTypeProblem('block', 7)).toMatch(/Block Hours \(4\).*Recurring Service \(7\)/);
    expect(contractTypeProblem('rate', 7)).toBeNull();
    expect(contractTypeProblem('retainer', 6)).toBeNull();
  });
  test('field plan: unknown / read-only refused, required enforced, picklist by label', () => {
    const p = planContractTermFields('create', { ...BLOCK, status: 'active', paymentType: 'credit', bogus: 1, invoiceNumber: 'X' }, BLOCK_FIELDS as any);
    expect(p.ok).toBe(false);
    expect(p.errors.join(' ')).toMatch(/unknown field "bogus"/);
    expect(p.errors.join(' ')).toMatch(/"invoiceNumber" is read-only/);
    expect(p.errors.join(' ')).toMatch(/"paymentType": unknown value "credit"/); // exact labels only
    const q = planContractTermFields('create', { ...BLOCK, status: 'Active', paymentType: 'Credit Card' }, BLOCK_FIELDS as any);
    expect(q.ok).toBe(true);
    expect(q.body).toMatchObject({ status: 1, paymentType: 3, hours: 20 });
    expect(planContractTermFields('create', { hours: 5 }, BLOCK_FIELDS as any).errors[0]).toMatch(/missing required field\(s\): datePurchased, startDate, endDate, hourlyRate/);
  });
  test('update keeps only what differs; dates compare by day', () => {
    const p = planContractTermFields('update', { hours: 20, endDate: '2026-12-31', hourlyRate: 130 }, BLOCK_FIELDS as any, { id: 5, hours: 20, endDate: '2026-12-31T00:00:00', hourlyRate: 125 });
    expect(p.body).toEqual({ hourlyRate: 130 });
    expect(p.changes).toEqual({ hourlyRate: { before: 125, after: 130 } });
  });
  test('same term: by role for rates, by dates + hours for blocks', () => {
    expect(findSameTerm('rate', { roleID: 7 }, [{ id: 1, roleID: 7 }, { id: 2, roleID: 8 }])).toEqual([{ id: 1, roleID: 7 }]);
    expect(findSameTerm('block', { startDate: '2026-12-01', endDate: '2026-12-31', hours: 20 }, [{ id: 3, startDate: '2026-12-01T00:00:00', endDate: '2026-12-31T00:00:00', hours: 20 }])).toHaveLength(1);
    expect(findSameTerm('block', { startDate: '2026-12-01', endDate: '2026-12-31', hours: 10 }, [{ id: 3, startDate: '2026-12-01', endDate: '2026-12-31', hours: 20 }])).toHaveLength(0);
  });
});

describe('tools', () => {
  test('registered, in the financial category, writes gated', () => {
    for (const n of ['autotask_list_contract_terms', 'autotask_create_contract_term', 'autotask_update_contract_term', 'autotask_delete_contract_term']) {
      const d = TOOL_DEFINITIONS.find((x) => x.name === n)!;
      expect(d).toBeDefined();
      expect(TOOL_CATEGORIES.financial!.tools).toContain(n);
      expect(classifyRisk(n, d.annotations as any)).toBe(n.includes('list') ? 'read-only' : n.includes('delete') ? 'destructive' : 'financial');
    }
  });
});

describe('writeContractTerm', () => {
  test('block on a block-hour contract: dry run by default, then created on the child route and verified', async () => {
    const { svc, http } = world(BLOCK_CONTRACT);
    const dry = await svc.writeContractTerm({ op: 'create', kind: 'block', contractID: 10, fields: BLOCK });
    expect(dry.status).toBe('dry_run');
    expect(dry.planned).toEqual({ method: 'POST', path: '/Contracts/10/Blocks', body: { contractID: 10, ...BLOCK } });
    expect(http.childCreate).not.toHaveBeenCalled();
    const r = await svc.writeContractTerm({ op: 'create', kind: 'block', contractID: 10, fields: BLOCK, dryRun: false });
    expect(r).toMatchObject({ status: 'created', id: 900, verified: true });
    expect(http.childCreate).toHaveBeenCalledWith('Contracts', 10, 'Blocks', { contractID: 10, ...BLOCK });
  });

  test('a re-run is a duplicate unless allowDuplicate', async () => {
    const { svc, http } = world(BLOCK_CONTRACT, { ContractBlocks: [{ id: 5, contractID: 10, ...BLOCK, startDate: '2026-12-01T00:00:00', endDate: '2026-12-31T00:00:00' }] });
    const r = await svc.writeContractTerm({ op: 'create', kind: 'block', contractID: 10, fields: BLOCK, dryRun: false });
    expect(r.status).toBe('duplicate');
    expect(http.childCreate).not.toHaveBeenCalled();
    const r2 = await svc.writeContractTerm({ op: 'create', kind: 'block', contractID: 10, fields: BLOCK, dryRun: false, allowDuplicate: true });
    expect(r2.status).toBe('created');
  });

  test('a create that errors but landed is reported, not retried', async () => {
    const { svc, http, store } = world(BLOCK_CONTRACT);
    http.childCreate.mockImplementationOnce(async () => { store.ContractBlocks = [{ id: 950, contractID: 10, ...BLOCK }]; throw new Error('timeout'); });
    const r = await svc.writeContractTerm({ op: 'create', kind: 'block', contractID: 10, fields: BLOCK, dryRun: false });
    expect(r).toMatchObject({ status: 'created', id: 950 });
    expect(http.childCreate).toHaveBeenCalledTimes(1);
  });

  test('wrong contract type, unknown contract, unknown kind, unsupported op: nothing written', async () => {
    const { svc, http } = world(RECURRING);
    expect(await svc.writeContractTerm({ op: 'create', kind: 'block', contractID: 11, fields: BLOCK, dryRun: false })).toMatchObject({ status: 'validation_failed', step: 'contract_type' });
    expect(await svc.writeContractTerm({ op: 'create', kind: 'rate', contractID: 99, fields: {}, dryRun: false })).toMatchObject({ status: 'validation_failed', step: 'contract' });
    expect(await svc.writeContractTerm({ op: 'create', kind: 'nope', contractID: 11, fields: {}, dryRun: false })).toMatchObject({ status: 'validation_failed', step: 'kind' });
    const r = await svc.writeContractTerm({ op: 'update', kind: 'exclusionRole', contractID: 11, id: 1, fields: {}, dryRun: false });
    expect(r).toMatchObject({ status: 'validation_failed', step: 'operation' });
    expect(String(r.detail)).toMatch(/delete it and create it again/);
    expect(await svc.writeContractTerm({ op: 'delete', kind: 'block', contractID: 11, id: 1, dryRun: false })).toMatchObject({ status: 'validation_failed', step: 'operation' });
    expect(http.childCreate).not.toHaveBeenCalled();
    expect(http.childDelete).not.toHaveBeenCalled();
  });

  test('rate update: only the change is sent, before → after; a row on another contract is refused', async () => {
    const { svc, http } = world(RECURRING, { ContractRates: [{ id: 40, contractID: 11, roleID: 7, contractHourlyRate: 150 }] });
    const dry = await svc.writeContractTerm({ op: 'update', kind: 'rate', contractID: 11, id: 40, fields: { roleID: 7, contractHourlyRate: 165 } });
    expect(dry).toMatchObject({ status: 'dry_run', changes: { contractHourlyRate: { before: 150, after: 165 } } });
    const r = await svc.writeContractTerm({ op: 'update', kind: 'rate', contractID: 11, id: 40, fields: { contractHourlyRate: 165 }, dryRun: false });
    expect(r).toMatchObject({ status: 'updated', verified: true });
    expect(http.childUpdate).toHaveBeenCalledWith('Contracts', 11, 'Rates', 40, { contractHourlyRate: 165 });
    expect(await svc.writeContractTerm({ op: 'update', kind: 'rate', contractID: 11, id: 40, fields: { contractHourlyRate: 165 }, dryRun: false })).toMatchObject({ status: 'unchanged' });
    expect(await svc.writeContractTerm({ op: 'update', kind: 'rate', contractID: 11, id: 41, fields: { contractHourlyRate: 1 }, dryRun: false })).toMatchObject({ status: 'validation_failed', step: 'row' });
  });

  test('delete an excluded role: dry run shows the row, then deleted and verified gone', async () => {
    const { svc, http } = world(RECURRING, { ContractExclusionRoles: [{ id: 60, contractID: 11, roleID: 9 }] });
    const dry = await svc.writeContractTerm({ op: 'delete', kind: 'exclusionRole', contractID: 11, id: 60 });
    expect(dry).toMatchObject({ status: 'dry_run', planned: { method: 'DELETE', path: '/Contracts/11/ExclusionRoles/60' }, before: { roleID: 9 } });
    expect(http.childDelete).not.toHaveBeenCalled();
    const r = await svc.writeContractTerm({ op: 'delete', kind: 'exclusionRole', contractID: 11, id: 60, dryRun: false });
    expect(r).toMatchObject({ status: 'deleted', id: 60, verified: true });
  });

  test('list: every kind, a failing kind reported not thrown', async () => {
    const { svc, http } = world(BLOCK_CONTRACT, { ContractBlocks: [{ id: 5, contractID: 10, hours: 20 }] });
    const q = http.query.getMockImplementation()!;
    http.query.mockImplementation(async (e: string, fl: any[]) => { if (e === 'ContractRoleCosts') throw new Error('HTTP 500'); return q(e, fl); });
    const r = await svc.listContractTerms(10);
    expect(r.contract.contractTypeLabel).toBe('Block Hours');
    expect(r.counts.block).toBe(1);
    expect(r.errors).toEqual([{ kind: 'roleCost', error: 'HTTP 500' }]);
    expect(await svc.listContractTerms(99)).toEqual({ status: 'not_found', contractID: 99 });
  });
});
