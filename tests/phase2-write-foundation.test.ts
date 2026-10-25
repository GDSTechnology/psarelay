// Phase 2 P0 items 6-8 — safe-orchestration contract, CI lifecycle writes, and
// project commercial linkage.
//
// Field names and mutability here are not guesses: they were read from this
// tenant's `entityInformation/fields`. The two that shape the design:
//   - ConfigurationItems.companyID is REQUIRED but READ-ONLY, so a CI is created
//     through the company child route and can never be moved between companies.
//   - Projects.contractID and Projects.opportunityID are both writable, so
//     commercial linkage needs no new entity — only a guarded write path.

import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { CREATE_TOOL_META } from '../src/utils/create-result';
import { WritePlan, isNoWrite, NO_WRITE_STATUSES } from '../src/utils/write-plan';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 't', version: '0',
  autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' },
};

function withHttp(fake: any) {
  const service = new AutotaskService(config, logger);
  jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fake);
  return service;
}
const findTool = (name: string) => TOOL_DEFINITIONS.find((t) => t.name === name);
const future = new Date(Date.now() + 365 * 864e5).toISOString();
const past = new Date(Date.now() - 365 * 864e5).toISOString();
const contractsFieldInfo = [{ name: 'status', picklistValues: [
  { value: '0', label: 'Inactive', isActive: true },
  { value: '1', label: 'Active', isActive: true },
] }];

afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// MCP-CORE-004 / MCP-CORE-005 — the shared envelope
// ---------------------------------------------------------------------------

describe('WritePlan — safe-orchestration envelope', () => {
  test('fail records the failing step and keeps the trail of what passed', () => {
    const plan = new WritePlan();
    plan.ok('company', { id: 1 });
    const r = plan.fail('contract', 'Contract 9 not found');
    expect(r).toMatchObject({ status: 'validation_failed', step: 'contract', detail: 'Contract 9 not found' });
    expect(r.validation).toEqual([
      { step: 'company', ok: true, detail: { id: 1 } },
      { step: 'contract', ok: false, detail: 'Contract 9 not found' },
    ]);
  });

  test('ok without detail omits the key rather than writing undefined', () => {
    const plan = new WritePlan();
    plan.ok('company');
    expect(plan.validation[0]).toEqual({ step: 'company', ok: true });
    expect('detail' in plan.validation[0]).toBe(false);
  });

  test('dry_run, duplicate and validation_failed all mean nothing was written', () => {
    const plan = new WritePlan();
    expect(isNoWrite(plan.dryRun({ planned: {} }))).toBe(true);
    expect(isNoWrite(plan.duplicate({ existing: [1] }))).toBe(true);
    expect(isNoWrite(new WritePlan().fail('x', 'y'))).toBe(true);
    expect(isNoWrite(plan.done('linked', { id: 1 }))).toBe(false);
    expect(NO_WRITE_STATUSES.has('linked')).toBe(false);
  });

  test('every terminal result carries the validation trail', () => {
    const plan = new WritePlan().ok('a').ok('b');
    for (const r of [plan.dryRun(), plan.duplicate(), plan.done('created')]) {
      expect(r.validation.map((s) => s.step)).toEqual(['a', 'b']);
    }
  });
});

describe('maintenance orchestrator still honors the envelope after extraction', () => {
  // The orchestrator was the one bespoke dry-run implementation; it now uses
  // WritePlan. Its own suite covers behavior — this pins the shared vocabulary.
  test('its dryRun arg is still advertised', () => {
    expect((findTool('autotask_create_maintenance_ticket')!.inputSchema as any).properties.dryRun).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// MCP-CI-001 — configuration item lifecycle writes
// ---------------------------------------------------------------------------

describe('createConfigurationItem (MCP-CI-001)', () => {
  const childCreate = () => jest.fn().mockResolvedValue(555);

  test('creates through the company child route, not POST /ConfigurationItems', async () => {
    const cc = childCreate();
    const svc = withHttp({ childCreate: cc, create: jest.fn() });
    const id = await svc.createConfigurationItem({ companyID: 7, productID: 42, serialNumber: 'SN1' });
    expect(id).toBe(555);
    expect(cc).toHaveBeenCalledWith('Companies', 7, 'ConfigurationItems', expect.objectContaining({ productID: 42, serialNumber: 'SN1' }));
  });

  test('defaults isActive true so a new CI is not born retired', async () => {
    const cc = childCreate();
    await withHttp({ childCreate: cc }).createConfigurationItem({ companyID: 7, productID: 42 });
    expect(cc.mock.calls[0][3]).toMatchObject({ isActive: true });
  });

  test('an explicit isActive is respected', async () => {
    const cc = childCreate();
    await withHttp({ childCreate: cc }).createConfigurationItem({ companyID: 7, productID: 42, isActive: false });
    expect(cc.mock.calls[0][3]).toMatchObject({ isActive: false });
  });

  test('companyID is required and the error says why', async () => {
    await expect(withHttp({ childCreate: childCreate() }).createConfigurationItem({ productID: 42 }))
      .rejects.toThrow(/companyID is required/);
  });

  test('productID is required — Autotask rejects the create without it', async () => {
    await expect(withHttp({ childCreate: childCreate() }).createConfigurationItem({ companyID: 7 }))
      .rejects.toThrow(/productID is required/);
  });

  test('read-only rmm/ssl audit fields are dropped instead of failing the write', async () => {
    const cc = childCreate();
    await withHttp({ childCreate: cc }).createConfigurationItem({
      companyID: 7, productID: 42,
      rmmDeviceAuditHostname: 'HOST1', sslCommonName: 'x.example', id: 999, madeUpField: 1,
    });
    const body = cc.mock.calls[0][3];
    expect(body).not.toHaveProperty('rmmDeviceAuditHostname');
    expect(body).not.toHaveProperty('sslCommonName');
    expect(body).not.toHaveProperty('madeUpField');
    expect(body).not.toHaveProperty('id');
    expect(body).toMatchObject({ productID: 42 });
  });

  test('refuses a contract owned by a different company', async () => {
    const svc = withHttp({ childCreate: childCreate() });
    jest.spyOn(svc, 'getContract').mockResolvedValue({ id: 10, companyID: 99 } as any);
    await expect(svc.createConfigurationItem({ companyID: 7, productID: 42, contractID: 10 }))
      .rejects.toThrow(/belongs to company 99, not 7/);
  });

  test('accepts a contract owned by the same company', async () => {
    const cc = childCreate();
    const svc = withHttp({ childCreate: cc });
    jest.spyOn(svc, 'getContract').mockResolvedValue({ id: 10, companyID: 7 } as any);
    await expect(svc.createConfigurationItem({ companyID: 7, productID: 42, contractID: 10 })).resolves.toBe(555);
    expect(cc.mock.calls[0][3]).toMatchObject({ contractID: 10 });
  });

  test('refuses a parent CI owned by a different company', async () => {
    const svc = withHttp({ childCreate: childCreate() });
    jest.spyOn(svc, 'getConfigurationItem').mockResolvedValue({ id: 5, companyID: 99 } as any);
    await expect(svc.createConfigurationItem({ companyID: 7, productID: 42, parentConfigurationItemID: 5 }))
      .rejects.toThrow(/belongs to company 99, not 7/);
  });

  test('refuses a missing contract rather than creating an unlinked CI', async () => {
    const svc = withHttp({ childCreate: childCreate() });
    jest.spyOn(svc, 'getContract').mockResolvedValue(null);
    await expect(svc.createConfigurationItem({ companyID: 7, productID: 42, contractID: 10 }))
      .rejects.toThrow(/contract 10 not found/);
  });
});

describe('updateConfigurationItem (MCP-CI-001)', () => {
  test('retire is isActive:false — there is no lifecycle/status field on the entity', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    await withHttp({ update }).updateConfigurationItem(555, { isActive: false });
    expect(update).toHaveBeenCalledWith('ConfigurationItems', 555, { isActive: false });
  });

  test('moving a CI between sites writes companyLocationID', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    await withHttp({ update }).updateConfigurationItem(555, { companyLocationID: 12 });
    expect(update).toHaveBeenCalledWith('ConfigurationItems', 555, { companyLocationID: 12 });
  });

  test('refuses to move a CI between companies — companyID is read-only', async () => {
    await expect(withHttp({ update: jest.fn() }).updateConfigurationItem(555, { companyID: 8 }))
      .rejects.toThrow(/companyID is read-only/);
  });

  test('a write of only unwritable fields fails loudly instead of sending an empty PATCH', async () => {
    const update = jest.fn();
    await expect(withHttp({ update }).updateConfigurationItem(555, { rmmDeviceAuditHostname: 'H' }))
      .rejects.toThrow(/no writable fields supplied/);
    expect(update).not.toHaveBeenCalled();
  });

  test('unwritable fields are stripped from an otherwise valid update', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    await withHttp({ update }).updateConfigurationItem(555, { notes: 'ok', rmmDeviceID: 1 });
    expect(update).toHaveBeenCalledWith('ConfigurationItems', 555, { notes: 'ok' });
  });
});

describe('configuration item tools are exposed and verified on create', () => {
  test('both lifecycle write tools are registered', () => {
    expect(findTool('autotask_create_configuration_item')).toBeDefined();
    expect(findTool('autotask_update_configuration_item')).toBeDefined();
  });

  test('create requires companyID and productID', () => {
    expect((findTool('autotask_create_configuration_item')!.inputSchema as any).required.sort())
      .toEqual(['companyID', 'productID']);
  });

  test('update does not advertise companyID, which Autotask will not change', () => {
    const props = (findTool('autotask_update_configuration_item')!.inputSchema as any).properties;
    expect(props.companyID).toBeUndefined();
    expect(props.isActive).toBeDefined();
  });

  test('the create is registered for read-after-write verification', () => {
    expect(CREATE_TOOL_META.autotask_create_configuration_item).toMatchObject({
      entityType: 'ConfigurationItems', parentType: 'Companies', verifyRead: true,
    });
  });
});

// ---------------------------------------------------------------------------
// MCP-PROJ-001 — project commercial linkage
// ---------------------------------------------------------------------------

describe('linkProjectCommercial (MCP-PROJ-001)', () => {
  const setup = (project: any, opts: { contract?: any; opportunity?: any; after?: any } = {}) => {
    const svc = withHttp({});
    const getProject = jest.spyOn(svc, 'getProject');
    getProject.mockResolvedValue(project);
    if (opts.after !== undefined) getProject.mockResolvedValueOnce(project).mockResolvedValueOnce(opts.after);
    jest.spyOn(svc, 'getFieldInfo').mockResolvedValue(contractsFieldInfo as any);
    if ('contract' in opts) jest.spyOn(svc, 'getContract').mockResolvedValue(opts.contract);
    if ('opportunity' in opts) jest.spyOn(svc, 'getOpportunity').mockResolvedValue(opts.opportunity);
    const updateProject = jest.spyOn(svc, 'updateProject').mockResolvedValue(undefined);
    return { svc, updateProject };
  };

  test('requires something to link', async () => {
    const { svc, updateProject } = setup({ id: 1, companyID: 7 });
    expect(await svc.linkProjectCommercial({ projectID: 1 })).toMatchObject({ status: 'validation_failed', step: 'input' });
    expect(updateProject).not.toHaveBeenCalled();
  });

  test('missing project fails before any write', async () => {
    const { svc, updateProject } = setup(null);
    expect(await svc.linkProjectCommercial({ projectID: 1, contractID: 10 }))
      .toMatchObject({ status: 'validation_failed', step: 'project' });
    expect(updateProject).not.toHaveBeenCalled();
  });

  test('refuses a contract owned by another company — this is the billing misroute guard', async () => {
    const { svc, updateProject } = setup({ id: 1, companyID: 7 }, { contract: { id: 10, companyID: 99, status: 1, endDate: future } });
    const r = await svc.linkProjectCommercial({ projectID: 1, contractID: 10 });
    expect(r).toMatchObject({ status: 'validation_failed', step: 'contract' });
    expect(String(r.detail)).toMatch(/another company/);
    expect(updateProject).not.toHaveBeenCalled();
  });

  test('refuses an expired contract', async () => {
    const { svc, updateProject } = setup({ id: 1, companyID: 7 }, { contract: { id: 10, companyID: 7, status: 1, endDate: past } });
    expect(await svc.linkProjectCommercial({ projectID: 1, contractID: 10 }))
      .toMatchObject({ status: 'validation_failed', step: 'contract' });
    expect(updateProject).not.toHaveBeenCalled();
  });

  test('refuses an inactive contract by tenant status label', async () => {
    const { svc } = setup({ id: 1, companyID: 7 }, { contract: { id: 10, companyID: 7, status: 0, endDate: future } });
    expect(await svc.linkProjectCommercial({ projectID: 1, contractID: 10 }))
      .toMatchObject({ status: 'validation_failed', step: 'contract' });
  });

  test('refuses an opportunity owned by another company', async () => {
    const { svc, updateProject } = setup({ id: 1, companyID: 7 }, { opportunity: { id: 3, companyID: 99 } });
    expect(await svc.linkProjectCommercial({ projectID: 1, opportunityID: 3 }))
      .toMatchObject({ status: 'validation_failed', step: 'opportunity' });
    expect(updateProject).not.toHaveBeenCalled();
  });

  test('dryRun validates and returns the planned change without writing', async () => {
    const { svc, updateProject } = setup({ id: 1, companyID: 7, contractID: null }, { contract: { id: 10, companyID: 7, status: 1, endDate: future } });
    const r = await svc.linkProjectCommercial({ projectID: 1, contractID: 10, dryRun: true });
    expect(r).toMatchObject({
      status: 'dry_run',
      plannedUpdate: { contractID: 10 },
      currentValues: { contractID: null, opportunityID: null },
    });
    expect(r.validation.map((s: any) => s.step)).toContain('contract');
    expect(updateProject).not.toHaveBeenCalled();
  });

  test('re-linking the same values is a duplicate, not a redundant write', async () => {
    const { svc, updateProject } = setup({ id: 1, companyID: 7, contractID: 10 }, { contract: { id: 10, companyID: 7, status: 1, endDate: future } });
    expect(await svc.linkProjectCommercial({ projectID: 1, contractID: 10 }))
      .toMatchObject({ status: 'duplicate', alreadyLinked: { contractID: 10 } });
    expect(updateProject).not.toHaveBeenCalled();
  });

  test('links contract and opportunity together and confirms both by read-back', async () => {
    const { svc, updateProject } = setup(
      { id: 1, companyID: 7, contractID: null, opportunityID: null },
      {
        contract: { id: 10, companyID: 7, status: 1, endDate: future },
        opportunity: { id: 3, companyID: 7 },
        after: { id: 1, companyID: 7, contractID: 10, opportunityID: 3 },
      },
    );
    const r = await svc.linkProjectCommercial({ projectID: 1, contractID: 10, opportunityID: 3 });
    expect(updateProject).toHaveBeenCalledWith(1, { contractID: 10, opportunityID: 3 });
    expect(r).toMatchObject({
      status: 'linked',
      id: 1,
      entityType: 'Projects',
      applied: { contractID: 10, opportunityID: 3 },
      verified: true,
      fieldsConfirmed: { contractID: true, opportunityID: true },
    });
  });

  test('a write Autotask accepts but does not apply reports verified:false', async () => {
    const { svc } = setup(
      { id: 1, companyID: 7, contractID: null },
      { contract: { id: 10, companyID: 7, status: 1, endDate: future }, after: { id: 1, companyID: 7, contractID: null } },
    );
    const r = await svc.linkProjectCommercial({ projectID: 1, contractID: 10 });
    expect(r).toMatchObject({ status: 'linked', verified: false, fieldsConfirmed: { contractID: false } });
  });

  test('only the changed field is written when the other already matches', async () => {
    const { svc, updateProject } = setup(
      { id: 1, companyID: 7, contractID: 10, opportunityID: null },
      {
        contract: { id: 10, companyID: 7, status: 1, endDate: future },
        opportunity: { id: 3, companyID: 7 },
        after: { id: 1, companyID: 7, contractID: 10, opportunityID: 3 },
      },
    );
    await svc.linkProjectCommercial({ projectID: 1, contractID: 10, opportunityID: 3 });
    expect(updateProject).toHaveBeenCalledWith(1, { opportunityID: 3 });
  });
});

describe('project write surface matches the live Projects schema', () => {
  const props = () => (findTool('autotask_update_project')!.inputSchema as any).properties;

  test('the linkage tool is registered and only projectID is required', () => {
    const t = findTool('autotask_link_project_commercial')!;
    expect(t).toBeDefined();
    expect((t.inputSchema as any).required).toEqual(['projectID']);
    expect((t.inputSchema as any).properties.dryRun).toBeDefined();
  });

  test('update_project exposes the writable commercial fields', () => {
    expect(props().contractID).toBeDefined();
    expect(props().opportunityID).toBeDefined();
  });

  test('the Projects department field is exposed under its real name', () => {
    // Autotask calls it `department`; only `departmentID` was advertised, so the
    // value was dropped on every update.
    expect(props().department).toBeDefined();
    expect(props().departmentID.description).toMatch(/alias/i);
  });

  test('fields Autotask cannot write are marked as ignored, not silently accepted', () => {
    for (const f of ['estimatedTime', 'assignedResourceID', 'assignedResourceRoleID']) {
      expect(props()[f].description).toMatch(/IGNORED/);
    }
  });
});
