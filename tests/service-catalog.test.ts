// Services catalog writes: validate / create / update_service.
// The catalog is checked live for duplicates (SKU and name), fields against the
// tenant's live field list, periodType against its picklist, and nothing is
// written without dryRun:false + confirm:true.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import { checkServiceInput, diffService, findServiceDuplicates, fullWritableRecord } from '../src/utils/service-catalog';
import type { McpServerConfig } from '../src/types/mcp';
import type { FieldInfo } from '../src/services/picklist.cache';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

const fi = (name: string, o: Partial<FieldInfo> = {}): FieldInfo => ({ name, dataType: 'string', isRequired: false, isReadOnly: false, isQueryable: true, isReference: false, isPickList: false, ...o });
const FIELDS: FieldInfo[] = [
  fi('id', { isReadOnly: true, isRequired: true }),
  fi('name', { isRequired: true, length: 100 }),
  fi('description'), fi('invoiceDescription'), fi('sku'), fi('catalogNumberPartNumber'),
  fi('unitPrice', { isRequired: true, dataType: 'decimal' }),
  fi('unitCost', { dataType: 'decimal' }),
  fi('billingCodeID', { isRequired: true, isReference: true, referenceEntityType: 'BillingCode' }),
  fi('periodType', { isRequired: true, isPickList: true, picklistValues: [
    { value: '1', label: 'Monthly', isActive: true }, { value: '2', label: 'Quarterly', isActive: true }, { value: '4', label: 'Yearly', isActive: true },
  ] }),
  fi('isActive', { dataType: 'boolean' }),
  fi('lastModifiedDate', { isReadOnly: true }),
];
const CATALOG = [
  { id: 10, name: 'Managed Backup', sku: 'BK-1', isActive: true, unitPrice: 50, periodType: 1, billingCodeID: 700 },
  { id: 11, name: 'Old Helpdesk', sku: null, catalogNumberPartNumber: 'HD-OLD', isActive: false, unitPrice: 99, periodType: 1, billingCodeID: 700 },
];
const CODES = [{ id: 700, name: 'Recurring Services', useType: 5, isActive: true }, { id: 701, name: 'Inactive code', useType: 5, isActive: false }, { id: 702, name: 'Hardware', useType: 4, isActive: true }];

function mk(opts: { createThrows?: boolean; landAnyway?: boolean } = {}) {
  const s = new AutotaskService(config, logger);
  const catalog: any[] = CATALOG.map((c) => ({ ...c }));
  const query = jest.fn(async (entity: string, filters: any[]) => {
    if (entity === 'Services') {
      const f = filters[0];
      return f.field === 'id' && f.op === 'eq' ? catalog.filter((c) => c.id === f.value).map((c) => ({ ...c })) : catalog.map((c) => ({ ...c }));
    }
    if (entity === 'BillingCodes') {
      const f = filters[0];
      const ids = f.op === 'in' ? f.value : [f.value];
      return CODES.filter((c) => ids.includes(c.id));
    }
    return [];
  });
  const create = jest.fn(async (_e: string, body: any) => {
    if (opts.createThrows) {
      if (opts.landAnyway) catalog.push({ id: 99, ...body });
      throw Object.assign(new Error('Autotask POST /Services failed: socket hang up'), { status: undefined });
    }
    catalog.push({ id: 99, ...body });
    return 99;
  });
  const update = jest.fn(async (_e: string, id: number, body: any, _o?: any) => { Object.assign(catalog.find((c) => c.id === id), body); });
  const getWithRetry = jest.fn(async (_e: string, id: number) => ({ ...catalog.find((c) => c.id === id) }));
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query, create, update, getWithRetry, fieldInfo: jest.fn(async () => ({ fields: [] })) });
  jest.spyOn(s, 'getFieldInfo').mockResolvedValue(FIELDS);
  return { s, h: new AutotaskToolHandler(s, logger), create, update, catalog };
}
const call = async (h: AutotaskToolHandler, name: string, args: Record<string, unknown>) => {
  const r = await h.callTool(name, args);
  return JSON.parse(r.content[0]!.text);
};
const BASE = { name: 'Managed IT Services - Base (2 Users)', sku: 'MIT-BASE', unitPrice: 500, unitCost: 0, periodType: 'Monthly', billingCodeID: 700, description: 'Help desk, endpoint protection and proactive management for two users.' };

describe('service catalog — pure checks', () => {
  test('duplicates by SKU (either identifier field, case-insensitive) and by exact name; inactive included', () => {
    expect(findServiceDuplicates(CATALOG as any, { sku: 'bk-1' }).map((d) => d.id)).toEqual([10]);
    expect(findServiceDuplicates(CATALOG as any, { sku: 'HD-OLD' })[0]).toMatchObject({ id: 11, isActive: false, matchedOn: ['sku'] });
    expect(findServiceDuplicates(CATALOG as any, { name: '  managed   backup ' }).map((d) => d.matchedOn)).toEqual([['name']]);
    expect(findServiceDuplicates(CATALOG as any, { name: 'Managed Backup', excludeId: 10 })).toEqual([]);
    expect(findServiceDuplicates(CATALOG as any, { name: 'Managed', sku: 'BK' })).toEqual([]); // exact only
  });

  test('field checks: unknown / read-only / required; 0 is a value; negative and non-numbers refused', () => {
    const ok = checkServiceInput(FIELDS, { name: 'X', unitPrice: 0, unitCost: 0, periodType: 1, billingCodeID: 700 }, 'create');
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.join(' ')).toMatch(/unitPrice is 0/);
    const bad = checkServiceInput(FIELDS, { name: 'X', unitPrice: -1, unitCost: 'abc' as any, lastModifiedDate: 'x', bogus: 1 } as any, 'create');
    const msgs = bad.errors.map((e) => e.message).join(' | ');
    expect(msgs).toMatch(/unitPrice cannot be negative/);
    expect(msgs).toMatch(/unitCost must be a number/);
    expect(msgs).toMatch(/lastModifiedDate is read-only/);
    expect(msgs).toMatch(/no field "bogus"/);
    expect(msgs).toMatch(/periodType is required/);
    expect(msgs).toMatch(/billingCodeID is required/);
    expect(checkServiceInput(FIELDS, { name: 'X', description: 'Cost $40, 25% markup' }, 'update').errors[0]!.message).toMatch(/markup/);
    expect(checkServiceInput(FIELDS, { name: 'X', unitPrice: 5 }, 'create').warnings.join(' ')).toMatch(/unitCost not given/);
  });

  test('diff: only real changes, pricing first; full PUT body keeps unchanged writable fields', () => {
    const before = { id: 10, name: 'A', unitPrice: 50, unitCost: 10, description: 'd', lastModifiedDate: 'x' };
    expect(diffService(before, { name: 'A', unitPrice: 50.0, description: 'new' })).toEqual([{ field: 'description', from: 'd', to: 'new', pricing: false }]);
    expect(diffService(before, { description: 'new', unitPrice: 60 }).map((c) => c.field)).toEqual(['unitPrice', 'description']);
    expect(diffService({ unitCost: null }, { unitCost: 0 })).toHaveLength(1); // 0 is not "blank"
    expect(fullWritableRecord(FIELDS, before, { description: 'new' })).toEqual({ name: 'A', unitPrice: 50, unitCost: 10, description: 'new' });
  });
});

describe('autotask_create_service', () => {
  test('dry run by default: resolves "Monthly", names the billing code, writes nothing', async () => {
    const { h, create } = mk();
    const r = await call(h, 'autotask_create_service', BASE);
    expect(create).not.toHaveBeenCalled();
    expect(r.result?.operation ?? r.data?.operation ?? JSON.stringify(r)).toBeTruthy();
    expect(r.message).toMatch(/^DRY RUN \(nothing written\)/);
    expect(r.message).toMatch(/Billing period: 1 = Monthly/);
    expect(r.message).toMatch(/Billing code: 700 Recurring Services/);
    expect(r.message).toMatch(/starts no billing/);
  });

  test('the write needs confirm:true; then creates once, sends periodType as the id, reads back', async () => {
    const { h, create } = mk();
    const gate = await call(h, 'autotask_create_service', { ...BASE, dryRun: false });
    expect(JSON.stringify(gate)).toMatch(/confirm/i);
    expect(create).not.toHaveBeenCalled();
    const r = await call(h, 'autotask_create_service', { ...BASE, dryRun: false, confirm: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toMatchObject({ name: BASE.name, sku: 'MIT-BASE', unitPrice: 500, unitCost: 0, periodType: 1, billingCodeID: 700, isActive: true });
    expect(create.mock.calls[0]![1]).not.toHaveProperty('dryRun');
    expect(create.mock.calls[0]![1]).not.toHaveProperty('confirm');
    expect(r.message).toMatch(/^Created Service 99 .*\(read back: values match\)/);
    expect(r.message).toMatch(/Correlation id [0-9a-f-]{36}/);
  });

  test('a second create of the same SKU is refused as a duplicate', async () => {
    const { h, create } = mk();
    await call(h, 'autotask_create_service', { ...BASE, dryRun: false, confirm: true });
    const again = await call(h, 'autotask_create_service', { ...BASE, name: 'Other name', dryRun: false, confirm: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(again.message).toMatch(/^NOTHING WRITTEN .*\[duplicate\] Service 99 .*already has this SKU/);
  });

  test('a duplicate name is refused unless allowDuplicateName; an inactive SKU match still blocks', async () => {
    const { h } = mk();
    expect((await call(h, 'autotask_create_service', { ...BASE, name: 'managed backup', sku: 'NEW-1' })).message).toMatch(/\[duplicate\] Service 10 .*same name|already has this name/);
    expect((await call(h, 'autotask_create_service', { ...BASE, name: 'managed backup', sku: 'NEW-1', allowDuplicateName: true })).message).toMatch(/^DRY RUN/);
    expect((await call(h, 'autotask_create_service', { ...BASE, sku: 'hd-old' })).message).toMatch(/Service 11 .*inactive.*already has this SKU/);
  });

  test('bad period, inactive billing code, missing billing code (with suggestions)', async () => {
    const { h } = mk();
    expect((await call(h, 'autotask_create_service', { ...BASE, periodType: 'Weekly' })).message).toMatch(/periodType "Weekly" is not a valid billing period — choose one of: 1 = Monthly, 2 = Quarterly, 4 = Yearly/);
    expect((await call(h, 'autotask_create_service', { ...BASE, billingCodeID: 701 })).message).toMatch(/billing code 701 \(Inactive code\) is inactive/);
    expect((await call(h, 'autotask_create_service', { ...BASE, billingCodeID: 702 })).message).toMatch(/different kind \(useType 4\)/);
    const { billingCodeID: _b, ...noCode } = BASE;
    const r = await call(h, 'autotask_create_service', noCode);
    expect(r.message).toMatch(/billingCodeID is required/);
    expect(r.message).toMatch(/Billing codes existing services use: 700 Recurring Services \(2\)/);
  });

  test('a POST that errors after Autotask committed is reported as created, never posted again', async () => {
    const { h, create } = mk({ createThrows: true, landAnyway: true });
    const r = await call(h, 'autotask_create_service', { ...BASE, dryRun: false, confirm: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(r.message).toMatch(/^Created Service 99 .*not created again/);
  });

  test('a POST that really failed says so, with its kind', async () => {
    const { h } = mk({ createThrows: true });
    const r = await call(h, 'autotask_create_service', { ...BASE, dryRun: false, confirm: true });
    expect(r.message).toMatch(/^FAILED .*\[api\] .*socket hang up.*NOT created/);
  });
});

describe('autotask_update_service', () => {
  test('dry run shows before → after; write sends only the changed field; pricing called out', async () => {
    const { h, update } = mk();
    const plan = await call(h, 'autotask_update_service', { serviceId: 10, name: 'Managed Backup', unitPrice: 55, description: 'Nightly backup' });
    expect(update).not.toHaveBeenCalled();
    expect(plan.message).toMatch(/\[PRICING\] unitPrice: 50 → 55/);
    expect(plan.message).toMatch(/description: \(blank\) → "Nightly backup"/);
    expect(plan.message).not.toMatch(/name:/);
    expect(plan.message).toMatch(/contracts and quotes that already carry this service keep their own prices/);
    const r = await call(h, 'autotask_update_service', { serviceId: 10, description: 'Nightly backup', dryRun: false, confirm: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![2]).toEqual({ description: 'Nightly backup' });
    expect(update.mock.calls[0]![3].putBody).toMatchObject({ id: 10, name: 'Managed Backup', unitPrice: 50, description: 'Nightly backup' });
    expect(r.message).toMatch(/^Updated Service 10 \(read back: values match\)/);
  });

  test('unchanged values write nothing; unknown service; deactivation warned', async () => {
    const { h, update } = mk();
    expect((await call(h, 'autotask_update_service', { serviceId: 10, unitPrice: 50, dryRun: false, confirm: true })).message).toMatch(/nothing to change/);
    expect(update).not.toHaveBeenCalled();
    expect((await call(h, 'autotask_update_service', { serviceId: 12345, unitPrice: 1 })).message).toMatch(/Service 12345 not found/);
    expect((await call(h, 'autotask_update_service', { serviceId: 10, isActive: false })).message).toMatch(/existing contract lines keep billing/);
  });

  test('renaming to another service\'s SKU is refused', async () => {
    const { h } = mk();
    expect((await call(h, 'autotask_update_service', { serviceId: 10, sku: 'HD-OLD' })).message).toMatch(/\[duplicate\] Service 11/);
  });
});

describe('read-only service tools', () => {
  test('validate_service answers the spec shape', async () => {
    const { h, create } = mk();
    const r = await call(h, 'autotask_validate_service', BASE);
    const result = r.result ?? r.data ?? r;
    expect(JSON.stringify(r)).toMatch(/"readyToCreate":true/);
    expect(JSON.stringify(r)).toMatch(/"duplicateFound":false/);
    expect(result).toBeTruthy();
    expect(r.message).toMatch(/^VALID/);
    expect(create).not.toHaveBeenCalled();
  });

  test('find_service_by_sku: exact, inactive flagged; field info lists periods and codes', async () => {
    const { h } = mk();
    expect((await call(h, 'autotask_find_service_by_sku', { sku: 'hd-old' })).message).toMatch(/11 "Old Helpdesk".* INACTIVE — matched on sku/);
    expect((await call(h, 'autotask_find_service_by_sku', { sku: 'MIT-BASE' })).message).toMatch(/^No service has SKU MIT-BASE/);
    const fi = await call(h, 'autotask_get_service_field_info', {});
    expect(fi.message).toMatch(/1 = Monthly \(1 active services\)/);
    expect(fi.message).toMatch(/700 Recurring Services \(2 services\)/);
    expect(fi.message).toMatch(/required name, unitPrice, billingCodeID, periodType/);
  });

  test('tool annotations: reads are read-only, writes are financial and dry-run first', async () => {
    const { TOOL_DEFINITIONS } = await import('../src/handlers/tool.definitions');
    const { classifyRisk } = await import('../src/utils/risk');
    const get = (n: string) => TOOL_DEFINITIONS.find((t) => t.name === n)!;
    for (const n of ['autotask_get_service_field_info', 'autotask_find_service_by_sku', 'autotask_validate_service']) expect((get(n).annotations as any)?.readOnlyHint).toBe(true);
    for (const n of ['autotask_create_service', 'autotask_update_service']) expect(classifyRisk(n, get(n).annotations as any)).toBe('financial');
  });
});
