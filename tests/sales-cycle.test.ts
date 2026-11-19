// Sales-cycle correlation (#20 §7): opportunity ↔ quotes / contracts / projects by Autotask's opportunityID,
// findings (mismatch, won without delivery, lost with delivery, unlinked delivery with a suggested link), the
// service's reads (live field checks, scoped queries) and the dry-run-first repair.

import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { classifyRisk } from '../src/utils/risk';
import { correlateSalesCycle, plausibleSource, salesPhase } from '../src/utils/sales-cycle';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

describe('salesPhase', () => {
  test.each([
    ['Closed', 'won'], ['Implemented', 'won'], ['Won', 'won'], ['Closed - Won', 'won'],
    ['Lost', 'lost'], ['Closed Lost', 'lost'], ['Closed/Lost', 'lost'],
    ['Active', 'open'], ['Not Ready to Buy', 'open'], [null, 'open'], ['', 'open'],
  ])('%s → %s', (label, phase) => expect(salesPhase(label as any)).toBe(phase));
});

describe('plausibleSource', () => {
  const opp = { id: 1, closedDate: '2026-06-01T12:00:00Z' };
  test('30 days before to a year after the close', () => {
    expect(plausibleSource(opp, { id: 2, startDate: '2026-05-10' })).toBe(true);
    expect(plausibleSource(opp, { id: 2, startDate: '2026-04-01' })).toBe(false);
    expect(plausibleSource(opp, { id: 2, startDate: '2027-07-01' })).toBe(false);
    expect(plausibleSource(opp, { id: 2 })).toBe(true);
  });
});

describe('correlateSalesCycle', () => {
  const OPPS = [
    { id: 1, title: 'Firewall', companyID: 0, statusLabel: 'Closed', closedDate: '2026-06-01' },
    { id: 2, title: 'Backup', companyID: 5, statusLabel: 'Closed', closedDate: '2026-07-01' },
    { id: 3, title: 'VoIP', companyID: 5, statusLabel: 'Lost' },
    { id: 4, title: 'Laptops', companyID: 5, statusLabel: 'Active' },
  ];

  test('chains each opportunity and flags mismatch, won without delivery, lost with delivery, won without quote', () => {
    const r = correlateSalesCycle({
      opportunities: OPPS,
      quotes: [{ id: 10, companyID: 0, opportunityID: 1 }, { id: 11, companyID: 6, opportunityID: 4 }],
      contracts: [{ id: 20, companyID: 0, opportunityID: 1 }],
      projects: [{ id: 30, companyID: 5, opportunityID: 3 }],
    });
    const ch1 = r.chains.find((c) => c.opportunityID === 1)!;
    expect(ch1).toMatchObject({ phase: 'won', companyID: 0 });
    expect(ch1.quotes.map((x) => x.id)).toEqual([10]);
    expect(ch1.contracts.map((x) => x.id)).toEqual([20]);
    const codes = r.findings.map((f) => `${f.code}:${f.opportunityID}`);
    expect(codes).toEqual(expect.arrayContaining(['company_mismatch:4', 'won_no_delivery:2', 'lost_with_delivery:3', 'won_no_quote:2']));
    // Company 0 is a real company: the contract on 0 matches opportunity 1 on 0.
    expect(codes).not.toContain('company_mismatch:1');
    expect(codes).not.toContain('won_no_delivery:1');
    expect(r.findings[0]!.severity).toBe('error');
    expect(r.summary).toMatchObject({ opportunities: 4, won: 2, lost: 1, open: 1, company_mismatch: 1 });
  });

  test('an unlinked contract on a company with exactly one won deal lacking one gets a suggested repair', () => {
    const r = correlateSalesCycle({
      opportunities: OPPS, quotes: [], contracts: [], projects: [],
      unlinkedContracts: [{ id: 21, companyID: 5, name: 'Backup MSA', startDate: '2026-07-15' }, { id: 22, companyID: 9 }],
      unlinkedProjects: [{ id: 31, companyID: 5, startDate: '2020-01-01' }],
    });
    const u = r.findings.filter((f) => f.code === 'unlinked_delivery');
    expect(u).toHaveLength(1); // contract 22 is on a company with no won deal; project 31 starts long before the close
    expect(u[0]).toMatchObject({ kind: 'contract', recordID: 21, suggestedOpportunityID: 2,
      repair: { tool: 'autotask_link_to_opportunity', args: { opportunityID: 2, contractID: 21, dryRun: true } } });
  });

  test('several candidates are listed without a suggestion or repair', () => {
    const r = correlateSalesCycle({
      opportunities: [...OPPS, { id: 5, companyID: 5, statusLabel: 'Implemented' }],
      quotes: [], contracts: [], projects: [], unlinkedProjects: [{ id: 32, companyID: 5 }],
    });
    const u = r.findings.find((f) => f.code === 'unlinked_delivery')!;
    expect(u.candidateOpportunityIDs).toEqual([2, 5]);
    expect(u.suggestedOpportunityID).toBeUndefined();
    expect(u.repair).toBeUndefined();
  });
});

describe('reportSalesCycle', () => {
  function world(opts: { contractsHaveOpp?: boolean } = {}) {
    const fields: Record<string, any[]> = {
      Opportunities: ['id', 'title', 'companyID', 'status', 'closedDate', 'createDate'].map((name) => ({ name, ...(name === 'status' ? { picklistValues: [{ value: '1', label: 'Active' }, { value: '2', label: 'Lost' }, { value: '3', label: 'Closed' }] } : {}) })),
      Quotes: ['id', 'companyID', 'opportunityID', 'name'].map((name) => ({ name })),
      Contracts: ['id', 'companyID', 'contractName', 'startDate', 'status', ...(opts.contractsHaveOpp === false ? [] : ['opportunityID'])].map((name) => ({ name })),
      Projects: ['id', 'companyID', 'opportunityID', 'projectName', 'startDateTime', 'status'].map((name) => ({ name })),
    };
    const http = {
      query: jest.fn(async (e: string, f: any[]) => {
        if (e === 'Opportunities') return [{ id: 1, title: 'Firewall', companyID: 5, status: 3, closedDate: '2026-06-01T12:00:00Z' }, { id: 2, title: 'VoIP', companyID: 5, status: 2 }];
        if (e === 'Quotes') return [{ id: 10, companyID: 5, opportunityID: 1, name: 'Q1' }];
        if (e === 'Projects' && f[0].field === 'opportunityID') return [];
        if (e === 'Projects') return [{ id: 31, companyID: 5, projectName: 'Firewall install', startDateTime: '2026-06-10T00:00:00Z' }];
        return [];
      }),
    };
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc as any, 'ensureClient').mockResolvedValue(http);
    jest.spyOn(svc, 'getFieldInfo').mockImplementation(async (e: string) => fields[e] as any);
    return { svc, http };
  }

  test('scopes by company, reads links by opportunityID and unlinked delivery on won companies', async () => {
    const { svc, http } = world();
    const r = await svc.reportSalesCycle({ companyID: 5 });
    const calls = http.query.mock.calls as any[];
    expect(calls[0][1]).toEqual([{ op: 'eq', field: 'companyID', value: 5 }]);
    expect(calls.find((c) => c[0] === 'Quotes')[1]).toEqual([{ op: 'in', field: 'opportunityID', value: [1, 2] }]);
    expect(calls.find((c) => c[0] === 'Projects' && c[1][1]?.op === 'notExist')[1]).toEqual([{ op: 'in', field: 'companyID', value: [5] }, { op: 'notExist', field: 'opportunityID' }]);
    expect(r.summary).toMatchObject({ opportunities: 2, won: 1, lost: 1 });
    expect(r.findings.find((f: any) => f.code === 'unlinked_delivery')).toMatchObject({ kind: 'project', recordID: 31, suggestedOpportunityID: 1 });
  });

  test('an entity without opportunityID in the tenant is skipped, not queried', async () => {
    const { svc, http } = world({ contractsHaveOpp: false });
    const r = await svc.reportSalesCycle({ opportunityID: 1 });
    expect(r.skipped).toEqual(['Contracts has no opportunityID field in this tenant']);
    expect((http.query.mock.calls as any[]).some((c) => c[0] === 'Contracts')).toBe(false);
  });

  test('needs a scope; bad date is refused before any read', async () => {
    const { svc, http } = world();
    expect(await svc.reportSalesCycle({})).toMatchObject({ status: 'invalid' });
    expect(await svc.reportSalesCycle({ createdSince: '2026-13' })).toMatchObject({ status: 'invalid' });
    expect(http.query).not.toHaveBeenCalled();
  });
});

describe('linkToOpportunity', () => {
  function world(contract: Record<string, any> | null, opts: { readOnly?: boolean; missing?: boolean } = {}) {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getFieldInfo').mockResolvedValue((opts.missing ? [] : [{ name: 'opportunityID', isReadOnly: !!opts.readOnly }]) as any);
    let stored = contract ? { ...contract } : null;
    jest.spyOn(svc, 'getContract').mockImplementation(async () => stored as any);
    jest.spyOn(svc, 'getOpportunity').mockImplementation(async (id: number) => (id === 7 ? { id: 7, companyID: 5 } : id === 8 ? { id: 8, companyID: 6 } : null) as any);
    const update = jest.spyOn(svc, 'updateContract').mockImplementation(async (_id, u) => { stored = { ...stored, ...u }; });
    return { svc, update };
  }

  test('dry run plans, the write links and reads back, a rerun is a duplicate', async () => {
    const { svc, update } = world({ id: 20, companyID: 5, opportunityID: null });
    const dry = await svc.linkToOpportunity({ opportunityID: 7, contractID: 20, dryRun: true });
    expect(dry).toMatchObject({ status: 'dry_run', plannedUpdate: { opportunityID: 7 } });
    expect(update).not.toHaveBeenCalled();
    const done = await svc.linkToOpportunity({ opportunityID: 7, contractID: 20 });
    expect(done).toMatchObject({ status: 'linked', verified: true, previous: { opportunityID: null } });
    expect(update).toHaveBeenCalledWith(20, { opportunityID: 7 });
    expect(await svc.linkToOpportunity({ opportunityID: 7, contractID: 20 })).toMatchObject({ status: 'duplicate' });
  });

  test('refuses another company, a missing / read-only field, and ambiguous input', async () => {
    expect(await world({ id: 20, companyID: 5 }).svc.linkToOpportunity({ opportunityID: 8, contractID: 20 })).toMatchObject({ status: 'validation_failed' });
    expect(await world({ id: 20, companyID: 5 }, { readOnly: true }).svc.linkToOpportunity({ opportunityID: 7, contractID: 20 })).toMatchObject({ status: 'validation_failed' });
    expect(await world({ id: 20, companyID: 5 }, { missing: true }).svc.linkToOpportunity({ opportunityID: 7, contractID: 20 })).toMatchObject({ status: 'validation_failed' });
    expect(await world(null).svc.linkToOpportunity({ opportunityID: 7, contractID: 20, projectID: 3 })).toMatchObject({ status: 'validation_failed' });
  });

  test('a project goes through linkProjectCommercial', async () => {
    const svc = new AutotaskService(config, logger);
    const spy = jest.spyOn(svc, 'linkProjectCommercial').mockResolvedValue({ status: 'dry_run' } as any);
    await svc.linkToOpportunity({ opportunityID: 7, projectID: 3, dryRun: true });
    expect(spy).toHaveBeenCalledWith({ projectID: 3, opportunityID: 7, dryRun: true });
  });
});

describe('registration', () => {
  test('report is read-only, link is a dry-run-first write; both in the financial category', () => {
    const rep = TOOL_DEFINITIONS.find((x) => x.name === 'autotask_report_sales_cycle')!;
    const link = TOOL_DEFINITIONS.find((x) => x.name === 'autotask_link_to_opportunity')!;
    expect(classifyRisk(rep.name, rep.annotations as any)).toBe('read-only');
    expect(classifyRisk(link.name, link.annotations as any)).not.toBe('read-only');
    expect(TOOL_CATEGORIES.financial!.tools).toEqual(expect.arrayContaining([rep.name, link.name]));
  });
});
