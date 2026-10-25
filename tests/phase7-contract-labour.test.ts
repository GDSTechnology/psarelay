// report_contract_labour_basis: derive "is labour included in the fee" from
// contractType so unbilled/leakage reports can tell a real leak from a contract
// working as designed.

import { classifyContractLabourBilling } from '../src/utils/contract-labour';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
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

describe('classifyContractLabourBilling (pure)', () => {
  test('T&M and Per Ticket bill labour on top (leakage-relevant)', () => {
    expect(classifyContractLabourBilling(1)).toMatchObject({ basis: 'billed', labourBilled: true, leakageRelevant: true });
    expect(classifyContractLabourBilling(8)).toMatchObject({ basis: 'billed', labourBilled: true, leakageRelevant: true });
  });
  test('Block Hours = block (overage billable), leakage-relevant', () => {
    expect(classifyContractLabourBilling(4)).toMatchObject({ basis: 'block', labourBilled: null, leakageRelevant: true });
  });
  test('Fixed/Retainer/Recurring absorb labour (not leakage)', () => {
    for (const t of [3, 6, 7]) expect(classifyContractLabourBilling(t)).toMatchObject({ basis: 'absorbed', labourBilled: false, leakageRelevant: false });
  });
  test('Umbrella + unknown', () => {
    expect(classifyContractLabourBilling(9).basis).toBe('umbrella');
    expect(classifyContractLabourBilling(99).basis).toBe('unknown');
    expect(classifyContractLabourBilling(null).basis).toBe('unknown');
  });
});

describe('reportContractLabourBasis', () => {
  beforeEach(() => _resetZoneUrlCache());
  afterEach(() => jest.restoreAllMocks());

  function mockContracts(rows: any[]) {
    const bodies: any[] = [];
    jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
      const url = args[0] as string; const init = (args[1] || {}) as RequestInit;
      if (/\/Contracts\/query$/.test(url)) { bodies.push(JSON.parse(String(init.body))); return Promise.resolve(res(200, { items: rows })); }
      if (/\/Contracts\/entityInformation\/fields$/.test(url)) return Promise.resolve(res(200, { fields: [
        { name: 'contractType', isPickList: true, picklistValues: [
          { value: '1', label: 'Time & Materials' }, { value: '4', label: 'Block Hours' }, { value: '7', label: 'Recurring Service' },
        ] },
        { name: 'billingPreference', isPickList: true, picklistValues: [
          { value: '2', label: 'Manually' }, { value: '3', label: 'On timesheet approval' },
        ] },
      ] }));
      return Promise.resolve(res(200, { items: [] }));
    });
    return bodies;
  }

  const ROWS = [
    { id: 1, contractName: 'ACME T&M', companyID: 10, contractType: 1, billingPreference: 3, overageBillingRate: null, setupFee: 0, contractExclusionSetID: null },
    { id: 2, contractName: 'ACME Managed', companyID: 10, contractType: 7, billingPreference: 2, overageBillingRate: null, setupFee: 0, contractExclusionSetID: 5 },
    { id: 3, contractName: 'PCI Block', companyID: 20, contractType: 4, billingPreference: 3, overageBillingRate: 175, setupFee: 0, contractExclusionSetID: null },
  ];

  test('active-only default; classifies + labels; counts by basis', async () => {
    const svc = new AutotaskService(config, logger);
    const bodies = mockContracts(ROWS);
    const out = await svc.reportContractLabourBasis();

    expect(bodies[0].filter).toEqual([{ op: 'eq', field: 'status', value: 1 }]);
    expect(out.count).toBe(3);
    expect(out.byBasis).toMatchObject({ billed: 1, absorbed: 1, block: 1 });

    const tm = out.contracts.find((c) => c.id === 1)!;
    expect(tm.basis).toBe('billed');
    expect(tm.leakageRelevant).toBe(true);
    expect(tm.contractTypeLabel).toBe('Time & Materials');
    expect(tm.billingPreferenceLabel).toBe('On timesheet approval');

    const managed = out.contracts.find((c) => c.id === 2)!;
    expect(managed.basis).toBe('absorbed');
    expect(managed.leakageRelevant).toBe(false);
    expect(managed.billingPreferenceLabel).toBe('Manually');

    const block = out.contracts.find((c) => c.id === 3)!;
    expect(block.basis).toBe('block');
    expect(block.overageBillingRate).toBe(175);
  });

  test('companyID + contractType + includeInactive filters', async () => {
    const svc = new AutotaskService(config, logger);
    const bodies = mockContracts(ROWS);
    await svc.reportContractLabourBasis({ companyID: 10, contractType: 1, includeInactive: true });
    const f = bodies[0].filter;
    expect(f).toContainEqual({ op: 'eq', field: 'companyID', value: 10 });
    expect(f).toContainEqual({ op: 'eq', field: 'contractType', value: 1 });
    expect(f.find((x: any) => x.field === 'status')).toBeUndefined();
  });

  test('tool dispatch summarises by basis', async () => {
    const svc = new AutotaskService(config, logger);
    mockContracts(ROWS);
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_report_contract_labour_basis', {});
    expect(r.content[0].text).toMatch(/3 contract\(s\): 1 billed, 1 block, 1 absorbed/);
  });
});
