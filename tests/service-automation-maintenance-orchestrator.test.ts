// Revenue-First Service Automation — PR D (issue #63): maintenance orchestrator
// + entitlement/coverage helpers. Contract "active" is judged by the tenant
// status LABEL + endDate (verified live: this tenant uses 0=Inactive/1=Active),
// and coverage gaps are computed in-memory (Autotask null filters on CI FKs
// return 0 rows — verified live). Mocked service.

import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };

function withHttp(fake: any) {
  const service = new AutotaskService(config, logger);
  jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fake);
  return service;
}
const findTool = (name: string) => TOOL_DEFINITIONS.find((t) => t.name === name);
const future = new Date(Date.now() + 365 * 864e5).toISOString();
const past = new Date(Date.now() - 365 * 864e5).toISOString();
// Contracts.status field info with the live tenant's 0=Inactive/1=Active picklist.
const contractsFieldInfo = [{ name: 'status', picklistValues: [
  { value: '0', label: 'Inactive', isActive: true },
  { value: '1', label: 'Active', isActive: true },
] }];
afterEach(() => jest.restoreAllMocks());

describe('getConfigurationItemEntitlement (§14)', () => {
  const setup = (ci: any, extra: Partial<Record<string, any>> = {}) => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getConfigurationItem').mockResolvedValue(ci);
    jest.spyOn(svc, 'getFieldInfo').mockResolvedValue(contractsFieldInfo as any);
    if ('contract' in extra) jest.spyOn(svc, 'getContract').mockResolvedValue(extra.contract as any);
    if ('cs' in extra) jest.spyOn(svc, 'getContractService').mockResolvedValue(extra.cs as any);
    return svc;
  };

  test('not found', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getConfigurationItem').mockResolvedValue(null);
    expect(await svc.getConfigurationItemEntitlement(1)).toMatchObject({ found: false, isEntitled: false });
  });

  test('CI_INACTIVE', async () => {
    const svc = setup({ id: 1, isActive: false, contractID: 10 });
    expect(await svc.getConfigurationItemEntitlement(1)).toMatchObject({ reason: 'CI_INACTIVE', isEntitled: false });
  });

  test('ACTIVE_CI_NO_CONTRACT', async () => {
    const svc = setup({ id: 1, isActive: true });
    expect(await svc.getConfigurationItemEntitlement(1)).toMatchObject({ reason: 'ACTIVE_CI_NO_CONTRACT' });
  });

  test('CONTRACT_TERMINATED when contract status is not active (Inactive)', async () => {
    const svc = setup({ id: 1, isActive: true, contractID: 10, contractServiceID: 20 },
      { contract: { id: 10, status: 0, endDate: future } });
    expect(await svc.getConfigurationItemEntitlement(1)).toMatchObject({ reason: 'CONTRACT_TERMINATED' });
  });

  test('CONTRACT_EXPIRED when endDate is past (status active)', async () => {
    const svc = setup({ id: 1, isActive: true, contractID: 10, contractServiceID: 20 },
      { contract: { id: 10, status: 1, endDate: past } });
    expect(await svc.getConfigurationItemEntitlement(1)).toMatchObject({ reason: 'CONTRACT_EXPIRED' });
  });

  test('SERVICE_NOT_MAPPED when contract active but CI has no contractServiceID', async () => {
    const svc = setup({ id: 1, isActive: true, contractID: 10 },
      { contract: { id: 10, status: 1, endDate: future } });
    expect(await svc.getConfigurationItemEntitlement(1)).toMatchObject({ reason: 'SERVICE_NOT_MAPPED' });
  });

  test('CONTRACT_SERVICE_MISMATCH when the service line points at another contract', async () => {
    const svc = setup({ id: 1, isActive: true, contractID: 10, contractServiceID: 20 },
      { contract: { id: 10, status: 1, endDate: future }, cs: { id: 20, contractID: 99, serviceID: 5 } });
    expect(await svc.getConfigurationItemEntitlement(1)).toMatchObject({ reason: 'CONTRACT_SERVICE_MISMATCH' });
  });

  test('ACTIVE_CI_ACTIVE_CONTRACT_SERVICE (entitled) — happy path', async () => {
    const svc = setup({ id: 1, isActive: true, contractID: 10, contractServiceID: 20, serviceID: 5 },
      { contract: { id: 10, status: 1, endDate: future }, cs: { id: 20, contractID: 10, serviceID: 5 } });
    const r = await svc.getConfigurationItemEntitlement(1);
    expect(r).toMatchObject({ reason: 'ACTIVE_CI_ACTIVE_CONTRACT_SERVICE', isEntitled: true });
  });
});

describe('searchConfigurationItemCoverageGaps (§15)', () => {
  test('queries active CIs and keeps only those lacking any contract link (in-memory)', async () => {
    const query = jest.fn().mockResolvedValue([
      { id: 1, isActive: true, contractID: null, contractServiceID: null }, // gap
      { id: 2, isActive: true, contractID: 10, contractServiceID: null },   // covered by contract
      { id: 3, isActive: true, contractID: null, contractServiceID: 20 },   // covered by service line
    ]);
    const svc = withHttp({ query });
    const gaps = await svc.searchConfigurationItemCoverageGaps({ companyID: 5 });
    expect(gaps.map((c) => c.id)).toEqual([1]);
    const filters = query.mock.calls[0][1] as any[];
    expect(filters).toContainEqual({ op: 'eq', field: 'isActive', value: true });
    expect(filters).toContainEqual({ op: 'eq', field: 'companyID', value: 5 });
  });
});

describe('createMaintenanceTicket (§13)', () => {
  test('validation_failed when the company does not exist', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getCompany').mockResolvedValue(null);
    const r = await svc.createMaintenanceTicket({ companyID: 9, title: 't', description: 'd' });
    expect(r).toMatchObject({ status: 'validation_failed', step: 'company' });
  });

  test('duplicate short-circuits creation when externalID already exists', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getCompany').mockResolvedValue({ id: 1 } as any);
    jest.spyOn(svc, 'findTicketByExternalId').mockResolvedValue([{ id: 500, externalID: 'K' } as any]);
    const create = jest.spyOn(svc, 'createTicket').mockResolvedValue(1);
    const r = await svc.createMaintenanceTicket({ companyID: 1, title: 't', description: 'd', externalID: 'K' });
    expect(r).toMatchObject({ status: 'duplicate' });
    expect(create).not.toHaveBeenCalled();
  });

  test('dryRun validates and returns the plan without writing', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getCompany').mockResolvedValue({ id: 1 } as any);
    jest.spyOn(svc, 'getConfigurationItem').mockResolvedValue({ id: 7, companyID: 1, isActive: true } as any);
    jest.spyOn(svc, 'findTicketByExternalId').mockResolvedValue([]);
    const create = jest.spyOn(svc, 'createTicket').mockResolvedValue(1);
    const r = await svc.createMaintenanceTicket({ companyID: 1, title: 't', description: 'd', configurationItemID: 7, externalID: 'K', dryRun: true });
    expect(r.status).toBe('dry_run');
    expect(r.plannedTicket).toMatchObject({ companyID: 1, configurationItemID: 7, externalID: 'K' });
    expect(create).not.toHaveBeenCalled();
  });

  test('created flow: create → apply checklist → read back', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getCompany').mockResolvedValue({ id: 1 } as any);
    jest.spyOn(svc, 'getConfigurationItem').mockResolvedValue({ id: 7, companyID: 1, isActive: true } as any);
    jest.spyOn(svc, 'findTicketByExternalId').mockResolvedValue([]);
    jest.spyOn(svc, 'createTicket').mockResolvedValue(1234);
    jest.spyOn(svc, 'getTicket').mockResolvedValue({ id: 1234, title: 't' } as any);
    const applyChecklist = jest.spyOn(svc, 'applyChecklistLibraryToTicket').mockResolvedValue({ ticketID: 1234, checklistLibraryID: 4, created: [1, 2], itemErrors: [] });
    const r = await svc.createMaintenanceTicket({ companyID: 1, title: 't', description: 'd', configurationItemID: 7, checklistLibraryID: 4 });
    expect(r).toMatchObject({ status: 'created', id: 1234, item: { id: 1234 } });
    expect(applyChecklist).toHaveBeenCalledWith(1234, 4);
    expect(r.checklist).toMatchObject({ created: [1, 2] });
  });

  test('requireEntitlement blocks creation of an unentitled CI', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getCompany').mockResolvedValue({ id: 1 } as any);
    jest.spyOn(svc, 'getConfigurationItem').mockResolvedValue({ id: 7, companyID: 1, isActive: true } as any);
    jest.spyOn(svc, 'getConfigurationItemEntitlement').mockResolvedValue({ configurationItemId: 7, found: true, isEntitled: false, reason: 'ACTIVE_CI_NO_CONTRACT', evidence: {} });
    const create = jest.spyOn(svc, 'createTicket').mockResolvedValue(1);
    const r = await svc.createMaintenanceTicket({ companyID: 1, title: 't', description: 'd', configurationItemID: 7, requireEntitlement: true });
    expect(r).toMatchObject({ status: 'validation_failed', step: 'entitlement' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('tool definitions (issue #63)', () => {
  test('all three tools exist with expected shapes', () => {
    expect((findTool('autotask_get_configuration_item_entitlement') as any).annotations.readOnlyHint).toBe(true);
    expect((findTool('autotask_search_configuration_item_coverage_gaps') as any).annotations.readOnlyHint).toBe(true);
    expect(findTool('autotask_create_maintenance_ticket')!.inputSchema.required).toEqual(['companyID', 'title', 'description']);
  });

  test('registered in TOOL_CATEGORIES', () => {
    const categorized = new Set(Object.values(TOOL_CATEGORIES).flatMap((c: any) => c.tools));
    for (const n of ['autotask_get_configuration_item_entitlement', 'autotask_search_configuration_item_coverage_gaps', 'autotask_create_maintenance_ticket']) {
      expect(categorized.has(n)).toBe(true);
    }
  });
});
