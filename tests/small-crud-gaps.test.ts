// Project charges (#20), company locations (#22) and the sales follow-up staff tool (#21 §9):
// the routes and filters sent upstream, PATCH-only updates read back, rerun safety, company 0, and the
// follow-up's company / due-time / action-type rules.

import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { ACTING_RESOURCE_TOOLS, CURRENT_USER_DEFAULT_TOOLS } from '../src/utils/caller-resolution';
import { classifyRisk } from '../src/utils/risk';
import { nextBusinessDay, pickSalesActionType, resolveFollowupDue } from '../src/utils/sales-followup';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const NY = 'America/New_York';
afterEach(() => jest.restoreAllMocks());

type Row = Record<string, any>;
function world(tables: Record<string, Row[]> = {}, picklist: Row[] = []) {
  const db: Record<string, Map<number, Row>> = {};
  for (const [e, rows] of Object.entries(tables)) db[e] = new Map(rows.map((r) => [Number(r.id), { ...r }]));
  const t = (e: string) => (db[e] ??= new Map());
  const childEntity: Record<string, string> = { 'Projects/Charges': 'ProjectCharges', 'Companies/Locations': 'CompanyLocations', 'Companies/ToDos': 'CompanyToDos' };
  let next = 900;
  const http = {
    query: jest.fn(async (entity: string, filters: any[]) => [...t(entity).values()].filter((r) => filters.every((f) => {
      if (f.op === 'eq') return f.value === null ? r[f.field] == null : r[f.field] === f.value;
      if (f.op === 'contains') return String(r[f.field] ?? '').toLowerCase().includes(String(f.value).toLowerCase());
      if (f.op === 'gte') return String(r[f.field]) >= f.value;
      if (f.op === 'lte') return String(r[f.field]) <= f.value;
      return true;
    }))),
    get: jest.fn(async (entity: string, id: number) => t(entity).get(Number(id)) ?? null),
    childCreate: jest.fn(async (p: string, pid: number, c: string, body: Row) => {
      const e = childEntity[`${p}/${c}`]!; const id = next++;
      const parentField = p === 'Projects' ? 'projectID' : 'companyID';
      t(e).set(id, { id, [parentField]: pid, isActive: true, ...body }); return id;
    }),
    childUpdate: jest.fn(async (p: string, _pid: number, c: string, id: number, body: Row) => {
      const e = childEntity[`${p}/${c}`]!; t(e).set(id, { ...t(e).get(id), ...body });
    }),
    childDelete: jest.fn(async (p: string, _pid: number, c: string, id: number) => { t(childEntity[`${p}/${c}`]!).delete(id); }),
    picklistValues: jest.fn(async () => picklist),
  };
  const svc = new AutotaskService(config, logger);
  jest.spyOn(svc as any, 'ensureClient').mockResolvedValue(http);
  jest.spyOn(svc, 'resolveResourceTimeZone').mockResolvedValue(NY);
  return { svc, http, db: t };
}

describe('tool registration', () => {
  const names = TOOL_DEFINITIONS.map((d) => d.name);
  test('all ten tools are registered with the right risk', () => {
    for (const n of ['get', 'search', 'create', 'update', 'delete'].map((v) => `autotask_${v}_project_charge${v === 'search' ? 's' : ''}`)) expect(names).toContain(n);
    for (const n of ['autotask_get_company_location', 'autotask_search_company_locations', 'autotask_create_company_location', 'autotask_update_company_location', 'autotask_create_sales_followup']) expect(names).toContain(n);
    const ann = (n: string) => TOOL_DEFINITIONS.find((d) => d.name === n)!.annotations as any;
    expect(classifyRisk('autotask_create_project_charge', ann('autotask_create_project_charge'))).toBe('financial');
    expect(classifyRisk('autotask_update_project_charge', ann('autotask_update_project_charge'))).toBe('financial');
    expect(classifyRisk('autotask_delete_project_charge', ann('autotask_delete_project_charge'))).toBe('destructive');
    expect(classifyRisk('autotask_create_sales_followup', ann('autotask_create_sales_followup'))).toBe('reversible-update');
  });
  test('the follow-up acts as the caller by default', () => {
    expect(ACTING_RESOURCE_TOOLS.autotask_create_sales_followup).toBe('assignedToResourceID');
    expect(CURRENT_USER_DEFAULT_TOOLS.autotask_create_sales_followup).toBe('assignedToResourceID');
  });
});

describe('project charges', () => {
  test('search sends the project filters upstream', async () => {
    const { svc } = world();
    const qp = jest.spyOn(svc as any, 'queryPaged').mockResolvedValue({ items: [] });
    await svc.searchProjectCharges({ projectIds: [7, 7, 8], isBilled: false, purchasedAfter: '2026-10-01' });
    expect(qp.mock.calls[0]![0]).toBe('ProjectCharges');
    expect(qp.mock.calls[0]![1]).toEqual([
      { op: 'in', field: 'projectID', value: [7, 8] },
      { op: 'eq', field: 'isBilled', value: false },
      { op: 'gte', field: 'datePurchased', value: '2026-10-01' },
    ]);
  });
  test('create goes through POST /Projects/{id}/Charges', async () => {
    const { svc, http } = world();
    const id = await svc.createProjectCharge({ projectID: 7, name: 'Cable', chargeType: 1, unitQuantity: 2 });
    expect(http.childCreate).toHaveBeenCalledWith('Projects', 7, 'Charges', expect.objectContaining({ name: 'Cable' }));
    expect(id).toBe(900);
    await expect(svc.createProjectCharge({ name: 'x' })).rejects.toThrow(/projectID/);
  });
  test('update PATCHes only the given fields through the project and reports old → new', async () => {
    const { svc, http } = world({ ProjectCharges: [{ id: 5, projectID: 7, name: 'Cable', unitQuantity: 2, unitPrice: 10 }] });
    const r = await svc.updateProjectCharge(5, { unitQuantity: 3, projectID: 99 });
    expect(http.childUpdate).toHaveBeenCalledWith('Projects', 7, 'Charges', 5, { unitQuantity: 3 });
    expect(r).toMatchObject({ projectID: 7, changes: { unitQuantity: { from: 2, to: 3 } }, notApplied: [] });
  });
  test('ticket charge update still works through the shared updater', async () => {
    const { svc, http } = world({ TicketCharges: [{ id: 4, ticketID: 3, unitPrice: 10 }] });
    (http as any).childUpdate.mockImplementation(async () => { /* Autotask ignored it */ });
    const r = await svc.updateTicketCharge(4, { unitPrice: 12 });
    expect(http.childUpdate).toHaveBeenCalledWith('Tickets', 3, 'Charges', 4, { unitPrice: 12 });
    expect(r).toMatchObject({ ticketID: 3, notApplied: ['unitPrice'] });
  });
  test('delete reads first, refuses billed charges and a wrong project', async () => {
    const { svc, http } = world({ ProjectCharges: [{ id: 5, projectID: 7, name: 'Cable' }, { id: 6, projectID: 7, isBilled: true }] });
    expect(await svc.deleteProjectCharge(1)).toMatchObject({ status: 'not_found' });
    expect(await svc.deleteProjectCharge(6)).toMatchObject({ status: 'invalid' });
    expect(await svc.deleteProjectCharge(5, 8)).toMatchObject({ status: 'invalid' });
    expect(http.childDelete).not.toHaveBeenCalled();
    expect(await svc.deleteProjectCharge(5, 7)).toMatchObject({ status: 'deleted', projectID: 7, deleted: { name: 'Cable' } });
    expect(http.childDelete).toHaveBeenCalledWith('Projects', 7, 'Charges', 5);
  });
});

describe('company locations', () => {
  test('search: company 0 is a real filter; active only unless includeInactive', async () => {
    const { svc, http } = world();
    await svc.searchCompanyLocationRecords({ companyId: 0, name: 'Main' });
    expect(http.query.mock.calls[0]![1]).toEqual([
      { op: 'eq', field: 'companyID', value: 0 },
      { op: 'contains', field: 'name', value: 'Main' },
      { op: 'eq', field: 'isActive', value: true },
    ]);
    await svc.searchCompanyLocationRecords({ companyId: 3, includeInactive: true });
    expect(http.query.mock.calls[1]![1]).toEqual([{ op: 'eq', field: 'companyID', value: 3 }]);
  });
  test('create on company 0 via POST /Companies/0/Locations; same name again returns the existing one', async () => {
    const { svc, http } = world();
    const r = await svc.createCompanyLocation({ companyID: 0, name: 'Warehouse', city: 'Springfield', bogus: 1 });
    expect(r).toMatchObject({ status: 'created', locationID: 900, verified: true });
    expect(http.childCreate).toHaveBeenCalledWith('Companies', 0, 'Locations', { name: 'Warehouse', city: 'Springfield' });
    expect(await svc.createCompanyLocation({ companyID: 0, name: 'warehouse ' })).toMatchObject({ status: 'exists', locationID: 900 });
    expect(http.childCreate).toHaveBeenCalledTimes(1);
    expect(await svc.createCompanyLocation({ name: 'X' })).toMatchObject({ status: 'invalid' });
  });
  test('update sends only changed fields, refuses retiring the primary, dryRun writes nothing', async () => {
    const { svc, http } = world({ CompanyLocations: [
      { id: 1, companyID: 3, name: 'HQ', city: 'A', isPrimary: true, isActive: true },
      { id: 2, companyID: 3, name: 'Shop', city: 'B', isPrimary: false, isActive: true },
    ] });
    expect(await svc.updateCompanyLocation(1, { isActive: false })).toMatchObject({ status: 'invalid' });
    expect(await svc.updateCompanyLocation(2, { city: 'B' })).toMatchObject({ status: 'unchanged' });
    expect(await svc.updateCompanyLocation(2, { city: 'C', dryRun: true })).toMatchObject({ status: 'planned', changes: { city: { from: 'B', to: 'C' } } });
    expect(http.childUpdate).not.toHaveBeenCalled();
    const r = await svc.updateCompanyLocation(2, { city: 'C', name: 'Shop', isActive: false });
    expect(http.childUpdate).toHaveBeenCalledWith('Companies', 3, 'Locations', 2, { city: 'C', isActive: false });
    expect(r).toMatchObject({ status: 'updated', changes: { city: { from: 'B', to: 'C' }, isActive: { from: true, to: false } } });
    expect(await svc.updateCompanyLocation(9, { city: 'x' })).toMatchObject({ status: 'not_found' });
  });
});

describe('sales follow-up helpers', () => {
  const pl = [{ value: 1, label: 'General' }, { value: 2, label: 'Phone Call' }, { value: 3, label: 'Sales Follow Up' }, { value: 4, label: 'Sales', isActive: false }];
  test('action type: exact label, else a "sales" label, else General; unknown label lists choices', () => {
    expect(pickSalesActionType(pl)).toEqual({ ok: true, value: 3, label: 'Sales Follow Up' });
    expect(pickSalesActionType([{ value: 9, label: 'Sales' }, ...pl])).toMatchObject({ value: 9 });
    expect(pickSalesActionType([{ value: 1, label: 'General' }])).toMatchObject({ value: 1 });
    expect(pickSalesActionType(pl, 'phone call')).toMatchObject({ value: 2 });
    expect(pickSalesActionType(pl, 'Lunch')).toMatchObject({ ok: false, choices: ['General', 'Phone Call', 'Sales Follow Up'] });
  });
  test('due: default next business day 09:00 local; a date → 09:00; inDays counts business days; past refused', () => {
    const fri = new Date('2026-11-20T20:00:00Z'); // Friday 15:00 in New York
    expect(nextBusinessDay('2026-11-20')).toBe('2026-11-23');
    expect(resolveFollowupDue({ timeZone: NY, now: fri })).toEqual({ ok: true, start: '2026-11-23T14:00:00Z', end: '2026-11-23T14:15:00Z', day: '2026-11-23' });
    expect(resolveFollowupDue({ when: '2026-12-01', durationMinutes: 30, timeZone: NY, now: fri })).toMatchObject({ start: '2026-12-01T14:00:00Z', end: '2026-12-01T14:30:00Z' });
    expect(resolveFollowupDue({ inDays: 2, timeZone: NY, now: fri })).toMatchObject({ day: '2026-11-24' });
    expect(resolveFollowupDue({ when: '2026-11-20T14:30', timeZone: NY, now: new Date('2026-11-25T00:00:00Z') }).ok).toBe(false);
  });
});

describe('createSalesFollowup', () => {
  const picklist = [{ value: 1, label: 'General' }, { value: 3, label: 'Sales' }];
  const tables = () => ({
    Opportunities: [{ id: 50, companyID: 0, contactID: 60, title: 'Firewall refresh', stage: 2, status: 1 }],
    Contacts: [{ id: 60, companyID: 0, firstName: 'Pat', lastName: 'Example' }, { id: 61, companyID: 4 }],
  });
  test('opportunity sets company (0) and contact; planned in local time; created via the company route; rerun returns it', async () => {
    const { svc, http } = world(tables(), picklist);
    const args = { assignedToResourceID: 5, opportunityID: 50, note: 'Send revised quote', when: '2026-12-01T10:00' };
    const plan = await svc.createSalesFollowup({ ...args, dryRun: true });
    expect(plan).toMatchObject({ status: 'planned', followup: { companyID: 0, contactID: 60, opportunityID: 50, actionType: 3, actionTypeLabel: 'Sales', startDateTime: '2026-12-01T15:00:00Z', endDateTime: '2026-12-01T15:15:00Z', startLocal: '2026-12-01T10:00:00', contact: { name: 'Pat Example' }, opportunity: { title: 'Firewall refresh' } } });
    expect(http.childCreate).not.toHaveBeenCalled();
    const r = await svc.createSalesFollowup(args);
    expect(r).toMatchObject({ status: 'created', todoID: 900 });
    expect(http.childCreate).toHaveBeenCalledWith('Companies', 0, 'ToDos', { companyID: 0, assignedToResourceID: 5, actionType: 3, activityDescription: 'Send revised quote', startDateTime: '2026-12-01T15:00:00Z', endDateTime: '2026-12-01T15:15:00Z', contactID: 60, opportunityID: 50 });
    expect(await svc.createSalesFollowup(args)).toMatchObject({ status: 'exists', todoID: 900 });
    expect(http.childCreate).toHaveBeenCalledTimes(1);
  });
  test('refuses mismatched company / contact, missing note, person or company; unknown ids', async () => {
    const { svc, http } = world(tables(), picklist);
    expect(await svc.createSalesFollowup({ assignedToResourceID: 5, opportunityID: 50, contactID: 61, note: 'x', when: '2026-12-01' })).toMatchObject({ status: 'invalid' });
    expect(await svc.createSalesFollowup({ assignedToResourceID: 5, opportunityID: 50, companyID: 4, note: 'x' })).toMatchObject({ status: 'invalid' });
    expect(await svc.createSalesFollowup({ assignedToResourceID: 5, companyID: 4 })).toMatchObject({ status: 'invalid' });
    expect(await svc.createSalesFollowup({ companyID: 4, note: 'x' })).toMatchObject({ status: 'invalid' });
    expect(await svc.createSalesFollowup({ assignedToResourceID: 5, note: 'x' })).toMatchObject({ status: 'invalid' });
    expect(await svc.createSalesFollowup({ assignedToResourceID: 5, opportunityID: 99, note: 'x' })).toMatchObject({ status: 'not_found' });
    expect(await svc.createSalesFollowup({ assignedToResourceID: 5, companyID: 4, note: 'x', when: '2026-12-01', actionTypeName: 'Lunch' })).toMatchObject({ status: 'invalid', choices: ['General', 'Sales'] });
    expect(http.childCreate).not.toHaveBeenCalled();
  });
});
