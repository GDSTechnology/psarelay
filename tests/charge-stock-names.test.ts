// Ticket charges for techs: TicketCharges.status is READ-ONLY (entityInformation,
// verified live 2026-11-26) — Autotask gives a new charge Ready to Deliver/Ship when
// the product is in stock (or needs no procurement), else Need to Order/Fulfill,
// which is the order sheet. The API can't pick stock against a charge. So:
// the tech names where the parts came from, the stock there is checked BEFORE
// writing, the order-sheet lines are said up front, and the real status is read
// back. Plus: replies across the tools name records instead of reading out ids.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

const CATALOG = [
  { id: 10, name: 'Plenum Cat6 Cable (per ft)', sku: 'C6-PLN-FT', unitPrice: 0.65, unitCost: 0.31, isActive: true },
  { id: 11, name: 'Cat6 Patch Cable 3ft', sku: 'C6-PC-3', unitPrice: 4.5, unitCost: 1.2, isActive: true },
  { id: 13, name: 'Cat6 Keystone Jack', sku: 'C6-KJ', unitPrice: 6, unitCost: 2, isActive: true, doesNotRequireProcurement: true },
];
const LOCATIONS = [
  { id: 1, locationName: 'Warehouse', isActive: true, resourceID: null },
  { id: 2, locationName: 'Van 3', isActive: true, resourceID: 501 },
  { id: 3, locationName: 'Van 4', isActive: true, resourceID: 502 },
];
// Van 3 has 300 ft of cable; patch cables only in the warehouse; keystones nowhere (but need no procurement).
const STOCK = [
  { productID: 10, inventoryLocationID: 2, availableUnits: 300 },
  { productID: 11, inventoryLocationID: 1, availableUnits: 20 },
];
const STATUS = [{ value: '3', label: 'Need to Order/Fulfill' }, { value: '6', label: 'Ready to Deliver/Ship' }];

function mk(backStatus: Record<number, number> = {}) {
  const s = new AutotaskService(config, logger);
  let next = 7000;
  const made = new Map<number, number>();
  const childCreate = jest.fn(async (_p: string, _id: number, _c: string, body: Record<string, unknown>): Promise<number> => { const id = ++next; made.set(id, Number(body.productID)); return id; });
  const query = jest.fn(async (entity: string, filter: Array<{ field: string; value: unknown }>) => {
    if (entity === 'Products' && filter[0]?.field === 'id' && Array.isArray(filter[0].value)) return CATALOG.filter((p) => (filter[0]!.value as number[]).includes(p.id));
    if (entity === 'Products') return CATALOG;
    if (entity === 'InventoryLocations') return LOCATIONS;
    if (entity === 'InventoryProducts') return STOCK.filter((r) => (filter[0]!.value as number[]).includes(r.productID));
    if (entity === 'TicketCharges') return [];
    if (entity === 'Tickets') return [{ id: 42, ticketNumber: 'T20261005.0123', title: 'Wire the new office' }];
    return [];
  });
  const get = jest.fn(async (entity: string, id: number) => (entity === 'Tickets' ? { id, ticketNumber: 'T20261005.0123', title: 'Wire the new office', companyID: 0 }
    : entity === 'TicketCharges' ? { id, ticketID: 42, status: backStatus[made.get(id) ?? 0] ?? 6 } : null));
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query, get, childCreate });
  jest.spyOn(s, 'getPicklistValues').mockImplementation(async (_e, field) => (field === 'chargeType' ? [{ value: '1', label: 'Operational', isDefaultValue: true }] : STATUS) as never);
  return { h: new AutotaskToolHandler(s, logger), childCreate };
}
const call = async (h: AutotaskToolHandler, args: Record<string, unknown>) => JSON.parse((await h.callTool('autotask_add_ticket_materials', args)).content[0]!.text);
const ITEMS = [{ productId: 10, quantity: 200 }, { productId: 11, quantity: 3 }, { productId: 13, quantity: 2 }];

describe('add_ticket_materials: stock location and the order sheet', () => {
  test('parts from a named van: stock checked there, the order-sheet line said up front', async () => {
    const { h, childCreate } = mk();
    const r = await call(h, { ticketNumber: 'T20261005.0123', items: ITEMS, fromLocation: 'van 3' });
    expect(childCreate).not.toHaveBeenCalled();
    const lines = r.data.lines as Array<Record<string, any>>;
    expect(lines[0]).toMatchObject({ expectedStatus: 'Ready to Deliver/Ship', onOrderSheet: false, stock: { location: 'Van 3', availableAtLocation: 300 } });
    // patch cables are in the warehouse, not in Van 3 → order sheet
    expect(lines[1]).toMatchObject({ expectedStatus: 'Need to Order/Fulfill', onOrderSheet: true, stock: { availableAtLocation: 0, availableAnywhere: 20 } });
    // keystones need no procurement → never on the order sheet
    expect(lines[2]).toMatchObject({ onOrderSheet: false, stock: { doesNotRequireProcurement: true } });
    expect(r.data.onOrderSheet).toEqual([2]);
    expect(r.message).toMatch(/^DRY RUN \(nothing written\) — T20261005\.0123 — Wire the new office, parts from Van 3:/);
    expect(r.message).toMatch(/Line 2 will land on the order sheet as Need to Order/);
  });

  test('"my van" is the caller\'s own location', async () => {
    const { h } = mk();
    const r = await call(h, { ticketNumber: 'T20261005.0123', items: ITEMS.slice(0, 1), fromLocation: 'my van', resourceID: 502 });
    expect(r.data.settings.fromLocation).toEqual({ id: 3, name: 'Van 4' });
    expect(r.data.lines[0]).toMatchObject({ onOrderSheet: true, stock: { location: 'Van 4', availableAtLocation: 0 } });
  });

  test('an unknown location writes nothing and lists the locations', async () => {
    const { h, childCreate } = mk();
    const r = await call(h, { ticketNumber: 'T20261005.0123', items: ITEMS, fromLocation: 'truck 9', dryRun: false, confirm: true });
    expect(childCreate).not.toHaveBeenCalled();
    expect(r.data.status).toBe('validation_failed');
    expect(r.message).toMatch(/NOTHING WRITTEN — No stock location called "truck 9"\. Locations: Warehouse, Van 3, Van 4\./);
  });

  test('written: status is never sent, the real status is read back and said by name', async () => {
    const { h, childCreate } = mk({ 11: 3 });
    const r = await call(h, { ticketNumber: 'T20261005.0123', items: ITEMS, fromLocation: 'Van 3', dryRun: false, confirm: true, status: 'Delivered' });
    expect(childCreate).toHaveBeenCalledTimes(3);
    for (const c of childCreate.mock.calls) expect(c[3]).not.toHaveProperty('status');
    expect(r.message).toMatch(/^Added to T20261005\.0123 — Wire the new office \(parts from Van 3\):/);
    expect(r.message).toMatch(/Status: Plenum Cat6 Cable \(per ft\) — Ready to Deliver\/Ship; Cat6 Patch Cable 3ft — Need to Order\/Fulfill \(on the order sheet\); Cat6 Keystone Jack — Ready to Deliver\/Ship\./);
    expect(r.message).toMatch(/Ignored: status/);
    expect(r.message).not.toMatch(/700\d/); // no charge ids read out
    expect(r.data.created.map((c: { chargeID: number }) => c.chargeID)).toEqual([7001, 7002, 7003]); // ids stay in the result
  });
});

describe('ticket charge edits', () => {
  test('update_ticket_charge with only a status writes nothing and says why', async () => {
    const s = new AutotaskService(config, logger);
    const upd = jest.spyOn(s, 'updateTicketCharge');
    const r = JSON.parse((await new AutotaskToolHandler(s, logger).callTool('autotask_update_ticket_charge', { chargeId: 9, status: 6, confirm: true })).content[0]!.text);
    expect(upd).not.toHaveBeenCalled();
    expect(r.message).toMatch(/can't be set through the API — Autotask sets it/);
  });

  test('create_ticket_charge drops status and names the ticket and the read-back status', async () => {
    const s = new AutotaskService(config, logger);
    const create = jest.spyOn(s, 'createTicketCharge').mockResolvedValue(77);
    jest.spyOn(s, 'getTicketCharge').mockResolvedValue({ id: 77, ticketID: 42, status: 3 } as never);
    jest.spyOn(s, 'getTicket').mockResolvedValue({ id: 42, ticketNumber: 'T1', title: 'Printer' } as never);
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([{ name: 'status', isPickList: true, picklistValues: STATUS }] as never);
    const r = JSON.parse((await new AutotaskToolHandler(s, logger).callTool('autotask_create_ticket_charge', { ticketID: 42, name: 'Toner', chargeType: 1, status: 7, unitQuantity: 1, datePurchased: '2026-11-26', confirm: true })).content[0]!.text);
    expect(create.mock.calls[0]![0]).not.toHaveProperty('status');
    expect(r.message).toBe('Added charge "Toner" to T1 — Printer — Need to Order/Fulfill (on the order sheet). Status ignored — Autotask sets it itself.');
  });
});

describe('replies name records, not ids', () => {
  const h = (s: AutotaskService) => async (tool: string, args: Record<string, unknown>) => JSON.parse((await new AutotaskToolHandler(s, logger).callTool(tool, args)).content[0]!.text).message as string;

  test('contact, company, To-Do, service call', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'updateContact').mockResolvedValue(undefined);
    jest.spyOn(s, 'getContact').mockResolvedValue({ id: 5, firstName: 'Pat', lastName: 'Lee' } as never);
    jest.spyOn(s, 'updateCompany').mockResolvedValue(undefined);
    jest.spyOn(s, 'getCompany').mockResolvedValue({ id: 8, companyName: 'Example Dental' } as never);
    jest.spyOn(s, 'getCompanyToDo').mockResolvedValue({ id: 9, activityDescription: 'Call back about the printer' } as never);
    jest.spyOn(s, 'deleteCompanyToDo').mockResolvedValue(undefined);
    jest.spyOn(s, 'getServiceCall').mockResolvedValue({ id: 4, description: 'Onsite: switch swap', startDateTime: '2026-11-27T14:00:00Z' } as never);
    jest.spyOn(s, 'updateServiceCall').mockResolvedValue(undefined);
    const say = h(s);
    expect(await say('autotask_update_contact', { id: 5, title: 'Office manager' })).toBe('Updated contact Pat Lee.');
    expect(await say('autotask_update_company', { id: 8, phone: '555' })).toBe('Updated Example Dental.');
    expect(await say('autotask_delete_company_todo', { id: 9, companyID: 8, confirm: true })).toBe('Deleted the To-Do "Call back about the printer".');
    expect(await say('autotask_update_service_call', { serviceCallId: 4, status: 2 })).toBe('Updated the service call "Onsite: switch swap on 2026-11-27".');
  });

  test('task resources, dependencies, phases', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'getTask').mockImplementation(async (id: number) => ({ id, title: id === 1 ? 'Rack the switch' : 'Patch the ports', projectID: 3 }) as never);
    jest.spyOn(s, 'getProject').mockResolvedValue({ id: 3, projectName: 'Office move' } as never);
    jest.spyOn(s, 'getResourceNames').mockResolvedValue(new Map([[30, 'Sam Roe']]));
    jest.spyOn(s, 'addTaskResource').mockResolvedValue(900);
    jest.spyOn(s, 'addTaskPredecessor').mockResolvedValue(901);
    jest.spyOn(s, 'getPhase').mockResolvedValue({ id: 6, title: 'Cutover', projectID: 3 } as never);
    jest.spyOn(s, 'updatePhase').mockResolvedValue(undefined);
    const say = h(s);
    expect(await say('autotask_add_task_resource', { taskID: 1, resourceID: 30, roleID: 2 })).toBe('Added Sam Roe to task "Rack the switch" on project Office move.');
    expect(await say('autotask_add_task_predecessor', { successorTaskID: 2, predecessorTaskID: 1 })).toBe('task "Rack the switch" on project Office move now comes before task "Patch the ports" on project Office move.');
    expect(await say('autotask_get_phase', { id: 6 })).toBe('phase "Cutover" on project "Office move"');
    expect(await say('autotask_update_phase', { id: 6, title: 'Cutover' })).toBe('Updated phase "Cutover".');
  });

  test('inventory transfer and stock adjustments name the product and locations', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'getProduct').mockResolvedValue({ id: 10, name: 'Cat6 Keystone Jack' } as never);
    jest.spyOn(s, 'getInventoryLocation').mockImplementation(async (id: number) => ({ id, locationName: id === 1 ? 'Warehouse' : 'Van 3' }));
    jest.spyOn(s, 'getInventoryProduct').mockResolvedValue({ id: 70, productID: 10, inventoryLocationID: 2 });
    jest.spyOn(s, 'createInventoryTransfer').mockResolvedValue(55);
    jest.spyOn(s, 'addInventoryStock').mockResolvedValue(56);
    const say = h(s);
    expect(await say('autotask_create_inventory_transfer', { fromLocationID: 1, toLocationID: 2, productID: 10, quantityTransferred: 5, confirm: true })).toBe('Moved 5 × Cat6 Keystone Jack from Warehouse to Van 3.');
    expect(await say('autotask_add_inventory_stock', { inventoryProductID: 70, quantityBeingAdded: 4, vendorID: 1, determineCostUsing: 1, confirm: true })).toBe('Added 4 unit(s) of Cat6 Keystone Jack at Van 3.');
  });

  test('a name lookup that fails falls back to the id instead of failing the call', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'updateContract').mockResolvedValue(undefined);
    jest.spyOn(s, 'getContract').mockRejectedValue(new Error('boom'));
    expect(await h(s)('autotask_update_contract', { id: 12, contractName: 'x', confirm: true })).toBe('Updated contract 12.');
  });
});
