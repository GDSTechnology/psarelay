// Contract labour report (#22 §10): covered vs excluded vs non-billable, block-hour factors, monthly allocation /
// balance / forfeit, by role / resource, forecast — and the service's reads (scoped time-entry window, terms).

import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { classifyRisk } from '../src/utils/risk';
import { addMonths, classifyLabour, computeContractLabour, monthRange } from '../src/utils/contract-labour-report';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

const TERMS = {
  blocks: [{ hours: 10, startDate: '2026-09-01' }, { hours: 10, startDate: '2026-10-01' }, { hours: 10, startDate: '2026-11-01T00:00:00' }],
  factors: [{ roleID: 2, blockHourMultiplier: 1.5 }],
  excludedRoleIDs: [9],
  excludedBillingCodeIDs: [77],
};
const E = (dateWorked: string, h: number, extra: Record<string, any> = {}) => ({ dateWorked, hoursWorked: h, roleID: 1, resourceID: 100, ...extra });
const ENTRIES = [
  E('2026-09-10', 4), E('2026-09-11', 2, { roleID: 2 }), // 4 + 3 drawn = 7 of 10 → 3 forfeited
  E('2026-10-02', 8), E('2026-10-03', 4, { roleID: 2, hoursToBill: 4.25 }), // 8 + 6.375 → 14.38 drawn, 4.38 over
  E('2026-10-04', 3, { roleID: 9 }), E('2026-10-05', 1, { billingCodeID: 77 }), E('2026-10-06', 2, { isNonBillable: true, resourceID: 101 }),
  E('2026-11-01', 3), E('2026-11-08', 3), // 6 drawn by the 15th → pace 12 of 10 → over
];

describe('helpers', () => {
  test('months', () => {
    expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', 2)).toBe('2027-01');
  });
  test('classify: non-billable first, then excluded role, then excluded work type', () => {
    expect(classifyLabour(E('2026-10-01', 1, { roleID: 9, isNonBillable: true }), TERMS)).toBe('non_billable');
    expect(classifyLabour(E('2026-10-01', 1, { roleID: 9, billingCodeID: 77 }), TERMS)).toBe('excluded_role');
    expect(classifyLabour(E('2026-10-01', 1, { billingCodeID: 77 }), TERMS)).toBe('excluded_work_type');
    expect(classifyLabour(E('2026-10-01', 1), TERMS)).toBe('covered');
  });
});

describe('computeContractLabour', () => {
  const r = computeContractLabour(ENTRIES, TERMS, { fromMonth: '2026-09', toMonth: '2026-11', asOf: new Date('2026-11-15T12:00:00Z') });

  test('monthly allocation, draw with factors, forfeit only for ended months', () => {
    const [sep, oct, nov] = r.months;
    expect(sep).toMatchObject({ month: '2026-09', coveredHours: 6, drawn: 7, allocated: 10, remaining: 3, overage: 0, forfeited: 3, burnPct: 70, ended: true });
    expect(oct).toMatchObject({ coveredHours: 12.25, drawn: 14.38, overage: 4.38, forfeited: 0, excludedRoleHours: 3, excludedWorkTypeHours: 1, nonBillableHours: 2 });
    expect(nov).toMatchObject({ drawn: 6, remaining: 4, forfeited: 0, ended: false });
    expect(r.totals).toMatchObject({ allocated: 30, drawn: 27.38, overage: 4.38, forfeited: 3, excludedRoleHours: 3, excludedWorkTypeHours: 1, nonBillableHours: 2 });
  });

  test('forecast: calendar pace vs allocation, trailing average of ended months', () => {
    expect(r.forecast).toMatchObject({ month: '2026-11', daysElapsed: 15, daysInMonth: 30, drawnSoFar: 6, projectedDrawn: 12, allocated: 10, projectedOverage: 2, projectedForfeit: 0, status: 'over' });
    expect(r.forecast!.trailingAverageDrawn).toBe(10.69);
  });

  test('by role / resource and the excluded entries list', () => {
    expect(r.byRole.find((x) => x.roleID === 2)).toMatchObject({ coveredHours: 6.25, factor: 1.5, drawn: 9.38 });
    expect(r.byRole.find((x) => x.roleID === 9)).toMatchObject({ coveredHours: 0, excludedHours: 3 });
    expect(r.byResource.find((x) => x.resourceID === 101)).toMatchObject({ nonBillableHours: 2 });
    expect(r.excludedEntries.map((x) => x.reason)).toEqual(['excluded_role', 'excluded_work_type']);
  });

  test('no blocks: allocation fields are null, forecast has no allocation', () => {
    const n = computeContractLabour(ENTRIES, { ...TERMS, blocks: [] }, { fromMonth: '2026-11', toMonth: '2026-11', asOf: new Date('2026-11-15T12:00:00Z') });
    expect(n.months[0]).toMatchObject({ allocated: null, overage: null, forfeited: null, burnPct: null });
    expect(n.totals.allocated).toBeNull();
    expect(n.forecast).toMatchObject({ status: 'no_allocation', projectedOverage: null });
  });

  test('entries outside the window are ignored; no forecast when the current month is outside it', () => {
    const p = computeContractLabour(ENTRIES, TERMS, { fromMonth: '2026-09', toMonth: '2026-09', asOf: new Date('2026-11-15T12:00:00Z') });
    expect(p.totals.coveredHours).toBe(6);
    expect(p.forecast).toBeNull();
  });
});

describe('reportContractLabour', () => {
  function world() {
    const http = {
      get: jest.fn(async (e: string, id: number) => (e === 'Contracts' && id === 10 ? { id: 10, contractName: 'Block', companyID: 0, contractType: 4, status: 1 } : null)),
      query: jest.fn(async (e: string) => {
        if (e === 'ContractBlocks') return TERMS.blocks;
        if (e === 'ContractBlockHourFactors') return TERMS.factors;
        if (e === 'ContractExclusionRoles') return [{ id: 1, roleID: 9 }];
        if (e === 'ContractExclusionBillingCodes') return [{ id: 2, billingCodeID: 77 }];
        if (e === 'TimeEntries') return ENTRIES;
        if (e === 'Roles') return [{ id: 2, name: 'Engineer' }, { id: 9, name: 'Project Manager' }];
        if (e === 'BillingCodes') return [{ id: 77, name: 'Travel' }];
        return [];
      }),
    };
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc as any, 'ensureClient').mockResolvedValue(http);
    jest.spyOn(svc, 'getResourceNames').mockResolvedValue(new Map([[100, 'Tech A']]));
    return { svc, http };
  }

  test('reads the window of time entries on the contract and names roles / work types', async () => {
    const { svc, http } = world();
    const r = await svc.reportContractLabour({ contractID: 10, fromMonth: '2026-09', toMonth: '2026-11', asOf: '2026-11-15' });
    const te = (http.query.mock.calls as any[]).find((c) => c[0] === 'TimeEntries')!;
    expect(te[1]).toEqual([
      { op: 'eq', field: 'contractID', value: 10 },
      { op: 'gte', field: 'dateWorked', value: '2026-09-01T00:00:00Z' },
      { op: 'lt', field: 'dateWorked', value: '2026-12-01T00:00:00Z' },
    ]);
    expect(r).toMatchObject({ status: 'ok', contract: { contractTypeLabel: 'Block Hours' }, totals: { drawn: 27.38 } });
    expect(r.terms.excludedWorkTypes).toEqual([{ billingCodeID: 77, name: 'Travel' }]);
    expect(r.byRole.find((x: any) => x.roleID === 2).roleName).toBe('Engineer');
    expect(r.byResource.find((x: any) => x.resourceID === 100).resourceName).toBe('Tech A');
  });

  test('defaults to the last 6 months; bad input and unknown contract answer without reading time', async () => {
    const { svc, http } = world();
    const r = await svc.reportContractLabour({ contractID: 10, asOf: '2026-11-15' });
    expect(r.window).toEqual({ from: '2026-06', to: '2026-11', asOf: '2026-11-15' });
    http.query.mockClear();
    expect(await svc.reportContractLabour({ contractID: 10, fromMonth: '2026-13' })).toMatchObject({ status: 'invalid' });
    expect(await svc.reportContractLabour({ contractID: 10, fromMonth: '2024-01', toMonth: '2026-11' })).toMatchObject({ status: 'invalid' });
    expect(await svc.reportContractLabour({ contractID: 99 })).toEqual({ status: 'not_found', contractID: 99 });
    expect(http.query.mock.calls.some((c) => c[0] === 'TimeEntries')).toBe(false);
  });

  test('registered read-only in the financial category', () => {
    const d = TOOL_DEFINITIONS.find((x) => x.name === 'autotask_report_contract_labour')!;
    expect(classifyRisk(d.name, d.annotations as any)).toBe('read-only');
    expect(TOOL_CATEGORIES.financial!.tools).toContain(d.name);
  });
});
