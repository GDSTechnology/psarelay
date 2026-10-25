// Revenue-First Service Automation — PR A (issue #60): CI + ContractService
// read foundation. Field names verified against the live Autotask
// ConfigurationItems (107 fields) and ContractServices (10 fields) schemas.
// Mocked http / mocked service.

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
afterEach(() => jest.restoreAllMocks());

describe('searchConfigurationItems entitlement filters (§4.1)', () => {
  test('passes each entitlement filter through as an eq filter', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 1 }]);
    const svc = withHttp({ query });
    await svc.searchConfigurationItems({
      companyID: 5, companyLocationID: 7, contractID: 100, contractServiceID: 200,
      contractServiceBundleID: 300, serviceID: 400, serviceBundleID: 500,
      parentConfigurationItemID: 600, isActive: true,
    } as any);
    const [entity, filters] = query.mock.calls[0];
    expect(entity).toBe('ConfigurationItems');
    const byField = Object.fromEntries((filters as any[]).map((f) => [f.field, f.value]));
    expect(byField).toMatchObject({
      companyID: 5, companyLocationID: 7, contractID: 100, contractServiceID: 200,
      contractServiceBundleID: 300, serviceID: 400, serviceBundleID: 500,
      parentConfigurationItemID: 600, isActive: true,
    });
  });

  test('isActive:false is still applied (not dropped as falsy)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = withHttp({ query });
    await svc.searchConfigurationItems({ isActive: false } as any);
    const filters = query.mock.calls[0][1] as any[];
    expect(filters).toContainEqual({ op: 'eq', field: 'isActive', value: false });
  });

  test('searchTerm matches referenceTitle (the CI name field)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = withHttp({ query });
    await svc.searchConfigurationItems({ searchTerm: 'firewall' } as any);
    const filters = query.mock.calls[0][1] as any[];
    expect(filters).toContainEqual({ op: 'contains', field: 'referenceTitle', value: 'firewall' });
  });
});

describe('getConfigurationItem + enrichment (§5)', () => {
  test('getConfigurationItem reads ConfigurationItems by id', async () => {
    const get = jest.fn().mockResolvedValue({ id: 42, referenceTitle: 'Core Switch' });
    const svc = withHttp({ get });
    expect(await svc.getConfigurationItem(42)).toMatchObject({ id: 42 });
    expect(get).toHaveBeenCalledWith('ConfigurationItems', 42);
  });

  test('enrichConfigurationItemReferences resolves names best-effort', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getCompany').mockResolvedValue({ id: 5, companyName: 'Acme' } as any);
    jest.spyOn(svc, 'getContract').mockResolvedValue({ id: 100, contractName: 'MSA', status: 1 } as any);
    jest.spyOn(svc, 'getService').mockResolvedValue({ id: 400, name: 'Firmware Mgmt' } as any);
    jest.spyOn(svc, 'getProduct').mockResolvedValue({ id: 9, name: 'FortiGate' } as any);
    jest.spyOn(svc, 'getContractService').mockResolvedValue({ id: 200, invoiceDescription: 'Managed FW' } as any);

    const enriched = await svc.enrichConfigurationItemReferences({
      id: 1, companyID: 5, contractID: 100, serviceID: 400, productID: 9, contractServiceID: 200,
    } as any);
    expect(enriched).toMatchObject({
      companyName: 'Acme', contractName: 'MSA', contractStatus: '1',
      serviceName: 'Firmware Mgmt', productName: 'FortiGate', contractServiceName: 'Managed FW',
    });
  });

  test('enrichment never throws when a reference lookup fails', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getCompany').mockRejectedValue(new Error('boom'));
    const enriched = await svc.enrichConfigurationItemReferences({ id: 1, companyID: 5 } as any);
    expect(enriched).toEqual({});
  });
});

describe('ContractService reads (§6)', () => {
  test('getContractService reads ContractServices by id', async () => {
    const get = jest.fn().mockResolvedValue({ id: 200, contractID: 100, serviceID: 400 });
    const svc = withHttp({ get });
    expect(await svc.getContractService(200)).toMatchObject({ id: 200, serviceID: 400 });
    expect(get).toHaveBeenCalledWith('ContractServices', 200);
  });

  test('searchContractServices filters by contractID / serviceID / quoteItemID', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 200 }]);
    const svc = withHttp({ query });
    await svc.searchContractServices({ contractID: 100, serviceID: 400, quoteItemID: 7 });
    const [entity, filters] = query.mock.calls[0];
    expect(entity).toBe('ContractServices');
    expect(filters).toEqual([
      { op: 'eq', field: 'contractID', value: 100 },
      { op: 'eq', field: 'serviceID', value: 400 },
      { op: 'eq', field: 'quoteItemID', value: 7 },
    ]);
  });

  test('searchContractServices with no filter uses MATCH_ALL (bounded page)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = withHttp({ query });
    await svc.searchContractServices({});
    const filters = query.mock.calls[0][1] as any[];
    expect(filters).toEqual([{ op: 'gte', field: 'id', value: 0 }]);
    expect(query.mock.calls[0][2]).toMatchObject({ maxRecords: 25 });
  });
});

describe('tool definitions (issue #60)', () => {
  test('search_configuration_items exposes the entitlement filters', () => {
    const props = findTool('autotask_search_configuration_items')!.inputSchema.properties as Record<string, any>;
    for (const f of ['companyLocationID', 'contractID', 'contractServiceID', 'contractServiceBundleID', 'serviceID', 'serviceBundleID', 'parentConfigurationItemID']) {
      expect(props[f]?.type).toBe('number');
    }
  });

  test('get_configuration_item requires configurationItemId and offers enrichReferences', () => {
    const tool = findTool('autotask_get_configuration_item');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(['configurationItemId']);
    expect((tool!.inputSchema.properties as any).enrichReferences.type).toBe('boolean');
  });

  test('contract service read tools exist and are read-only', () => {
    expect(findTool('autotask_get_contract_service')!.inputSchema.required).toEqual(['id']);
    expect((findTool('autotask_get_contract_service') as any).annotations.readOnlyHint).toBe(true);
    expect(findTool('autotask_search_contract_services')).toBeDefined();
    expect((findTool('autotask_search_contract_services') as any).annotations.readOnlyHint).toBe(true);
  });

  test('new tools are registered in TOOL_CATEGORIES (no drift)', () => {
    const categorized = new Set(Object.values(TOOL_CATEGORIES).flatMap((c: any) => c.tools));
    for (const name of ['autotask_get_configuration_item', 'autotask_get_contract_service', 'autotask_search_contract_services']) {
      expect(categorized.has(name)).toBe(true);
    }
  });
});
