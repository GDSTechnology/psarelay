// ContractMilestone CRUD (plan §30). Semantics verified against the live
// Autotask ContractMilestone entity: canDelete=false (no delete tool),
// contractID required + readonly, status a tenant picklist. Financial mutations,
// so create/update are confirmation-gated. Mocked http / mocked service.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };

function withHttp(fake: any) {
  const service = new AutotaskService(config, logger);
  jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fake);
  return service;
}
function toolData(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0].text).data;
}
afterEach(() => jest.restoreAllMocks());

describe('ContractMilestone service CRUD', () => {
  test('getContractMilestone reads by id', async () => {
    const get = jest.fn().mockResolvedValue({ id: 913, title: '1105 - Installation Labor', amount: 3120, contractID: 29685498 });
    const svc = withHttp({ get });
    expect(await svc.getContractMilestone(913)).toMatchObject({ id: 913, amount: 3120 });
    expect(get).toHaveBeenCalledWith('ContractMilestones', 913);
  });

  test('searchContractMilestones filters by contractID', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 913 }, { id: 914 }]);
    const svc = withHttp({ query });
    const rows = await svc.searchContractMilestones({ contractID: 29685498 });
    expect(rows).toHaveLength(2);
    expect(query).toHaveBeenCalledWith(
      'ContractMilestones',
      [{ op: 'eq', field: 'contractID', value: 29685498 }],
      expect.objectContaining({ maxRecords: 500 })
    );
  });

  test('searchContractMilestones combines contractID + status', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = withHttp({ query });
    await svc.searchContractMilestones({ contractID: 1, status: 1 });
    expect(query).toHaveBeenCalledWith(
      'ContractMilestones',
      [{ op: 'eq', field: 'contractID', value: 1 }, { op: 'eq', field: 'status', value: 1 }],
      expect.anything()
    );
  });

  test('searchContractMilestones returns [] unfiltered (no tenant scan)', async () => {
    const query = jest.fn();
    const svc = withHttp({ query });
    expect(await svc.searchContractMilestones({})).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  test('createContractMilestone requires contractID', async () => {
    const svc = withHttp({ create: jest.fn() });
    await expect(svc.createContractMilestone({ title: 'x', amount: 1 })).rejects.toThrow(/contractID/);
  });

  test('createContractMilestone posts the body and returns the id', async () => {
    const create = jest.fn().mockResolvedValue(913);
    const svc = withHttp({ create });
    const id = await svc.createContractMilestone({ contractID: 29685498, title: '1105', amount: 3120, dateDue: '2026-09-18', status: 1, isInitialPayment: false });
    expect(id).toBe(913);
    expect(create).toHaveBeenCalledWith('ContractMilestones', expect.objectContaining({ contractID: 29685498, amount: 3120 }));
  });

  test('updateContractMilestone drops readonly contractID, forwards writable fields', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const svc = withHttp({ update });
    await svc.updateContractMilestone(913, { contractID: 999, amount: 3200, status: 2 });
    const [, , body] = update.mock.calls[0];
    expect(body).toEqual({ amount: 3200, status: 2 });
    expect('contractID' in body).toBe(false);
  });
});

describe('ContractMilestone tools are wired and gated', () => {
  test('all four milestone tools exist in the catalog (no delete tool)', () => {
    const names = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    expect(names.has('autotask_get_contract_milestone')).toBe(true);
    expect(names.has('autotask_search_contract_milestones')).toBe(true);
    expect(names.has('autotask_create_contract_milestone')).toBe(true);
    expect(names.has('autotask_update_contract_milestone')).toBe(true);
    // REST canDelete=false — there must be no delete tool.
    expect(names.has('autotask_delete_contract_milestone')).toBe(false);
  });

  test('create without confirm → confirmation_required (financial), service not called', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'createContractMilestone').mockResolvedValue(913 as any);
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool('autotask_create_contract_milestone', {
      contractID: 29685498, title: '1105', amount: 3120, dateDue: '2026-09-18', status: 1, isInitialPayment: false,
    });

    expect(toolData(result)).toMatchObject({ status: 'confirmation_required', riskLevel: 'financial' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('update without confirm → confirmation_required', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'updateContractMilestone').mockResolvedValue(undefined as any);
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool('autotask_update_contract_milestone', { id: 913, amount: 3200 });
    expect(toolData(result)).toMatchObject({ status: 'confirmation_required', riskLevel: 'financial' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('create with confirm:true proceeds and read-after-write attaches verified + item', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'createContractMilestone').mockResolvedValue(913 as any);
    jest.spyOn(service, 'readEntityForVerification').mockResolvedValue({ id: 913, title: '1105', contractID: 29685498 });
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool('autotask_create_contract_milestone', {
      contractID: 29685498, title: '1105', amount: 3120, dateDue: '2026-09-18', status: 1, isInitialPayment: false, confirm: true,
    });

    expect(toolData(result)).toMatchObject({
      id: 913, entityType: 'ContractMilestones', parentType: 'Contracts', parentId: 29685498,
      verified: true, item: { id: 913 },
    });
  });
});
