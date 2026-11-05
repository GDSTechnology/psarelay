// autotask_add_ticket_materials: catalog products → priced ticket charges.
// A tech's "add 200 ft cable, 3 patch cords, 2 keystones to ticket T…" must
// (a) never guess between similar products, (b) price from the catalog,
// (c) never double-bill a product already on the ticket, (d) write nothing
// without confirm, and (e) write all-or-nothing on unsettled lines.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import { planMaterialLines, resolveProductQuery, summarizeMaterialLines } from '../src/utils/ticket-materials';
import { matchProducts } from '../src/utils/catalog-hygiene';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

const CATALOG = [
  { id: 10, name: 'Plenum Cat6 Cable (per ft)', sku: 'C6-PLN-FT', unitPrice: 0.65, unitCost: 0.31, isActive: true, productBillingCodeID: 900 },
  { id: 11, name: 'Cat6 Patch Cable 3ft', sku: 'C6-PC-3', unitPrice: 4.5, unitCost: 1.2, isActive: true, productBillingCodeID: 900 },
  { id: 12, name: 'Cat6 Patch Cable 6ft', sku: 'C6-PC-6', unitPrice: 5.5, unitCost: 1.6, isActive: true, productBillingCodeID: 900 },
  { id: 13, name: 'Cat6 Keystone Jack', sku: 'C6-KJ', unitPrice: 6, unitCost: 2, isActive: true },
  { id: 14, name: 'Dual Port Surface Mount Jack', sku: 'SMB-2', unitPrice: null, unitCost: 1.1, isActive: true },
  { id: 15, name: 'Old Cat5 Keystone', sku: 'C5-KJ', unitPrice: 3, isActive: false },
];

describe('pure planning', () => {
  test('find_product matches now carry price, cost and description', () => {
    const [m] = matchProducts(CATALOG, 'C6-PC-3');
    expect(m).toMatchObject({ id: 11, unitPrice: 4.5, unitCost: 1.2 });
  });

  test('an exact part number resolves; name words shared by several products come back as a choice', () => {
    expect(resolveProductQuery(CATALOG, 'C6-PC-6')).toEqual({ productId: 12 });
    const r = resolveProductQuery(CATALOG, 'cat6 patch cable');
    expect('candidates' in r && r.candidates.map((c) => c.id).sort()).toEqual([11, 12]);
    expect(resolveProductQuery(CATALOG, 'keystone')).toEqual({ productId: 13 }); // the inactive one is not a candidate
    expect(resolveProductQuery(CATALOG, 'plenum cat6 cable')).toEqual({ productId: 10 }); // the only product with every word
    expect(resolveProductQuery(CATALOG, 'fiber spool')).toEqual({ candidates: [] });
  });

  test('prices from the catalog, flags a product already on the ticket, refuses a missing price', () => {
    const products = new Map(CATALOG.map((p) => [p.id, p]));
    const lines = planMaterialLines({
      items: [{ productId: 10, quantity: 200 }, { productId: 11, quantity: 3 }, { productId: 13, quantity: 2, unitPrice: 7 }, { productId: 14, quantity: 2 }, { query: 'cat6 patch cable', quantity: 2 }, { productId: 12, quantity: 0 }],
      resolved: [{ productId: 10 }, { productId: 11 }, { productId: 13 }, { productId: 14 }, resolveProductQuery(CATALOG, 'cat6 patch cable'), { productId: 12 }],
      products,
      existing: [{ id: 501, productID: 11, unitQuantity: 3, unitPrice: 4.5, datePurchased: '2026-10-05T00:00:00Z' }],
    });
    expect(lines.map((l) => l.action)).toEqual(['create', 'duplicate', 'create', 'invalid', 'needs_product', 'invalid']);
    expect(lines[0]).toMatchObject({ unitPrice: 0.65, unitCost: 0.31, extendedPrice: 130, billingCodeID: 900, priceSource: 'catalog' });
    expect(lines[1]!.existing![0]!.id).toBe(501);
    expect(lines[2]).toMatchObject({ unitPrice: 7, extendedPrice: 14, priceSource: 'override' });
    expect(lines[3]!.problem).toMatch(/no unit price/);
    expect(lines[4]!.candidates!.length).toBe(2);
    const sum = summarizeMaterialLines(lines);
    expect(sum).toMatchObject({ total: 144, readyToWrite: false });
  });

  test('allowDuplicates adds again; the same product twice in one request is flagged', () => {
    const products = new Map(CATALOG.map((p) => [p.id, p]));
    const existing = [{ id: 501, productID: 11 }];
    const again = planMaterialLines({ items: [{ productId: 11, quantity: 1 }], resolved: [{ productId: 11 }], products, existing, allowDuplicates: true });
    expect(again[0]!.action).toBe('create');
    const twice = planMaterialLines({ items: [{ productId: 13, quantity: 1 }, { productId: 13, quantity: 1 }], resolved: [{ productId: 13 }, { productId: 13 }], products, existing: [] });
    expect(twice.map((l) => l.action)).toEqual(['create', 'duplicate']);
  });
});

function mk(existing: unknown[] = []) {
  const s = new AutotaskService(config, logger);
  let next = 7000;
  const childCreate = jest.fn(async (..._a: unknown[]): Promise<number> => ++next);
  const query = jest.fn(async (entity: string, filter: Array<{ field: string; value: unknown }>) => {
    if (entity === 'Products' && filter[0]?.field === 'id' && Array.isArray(filter[0].value)) return CATALOG.filter((p) => (filter[0]!.value as number[]).includes(p.id));
    if (entity === 'Products') return CATALOG.filter((p) => p.isActive);
    if (entity === 'TicketCharges') return existing;
    if (entity === 'Tickets') return [{ id: 42, ticketNumber: 'T20261005.0123' }];
    return [];
  });
  const get = jest.fn(async (entity: string, id: number) => (entity === 'Tickets' ? { id, ticketNumber: 'T20261005.0123', companyID: 0 } : entity === 'TicketCharges' ? { id, ticketID: 42 } : null));
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query, get, childCreate });
  jest.spyOn(s, 'getPicklistValues').mockImplementation(async (_e, field) => (field === 'chargeType' ? [{ value: '1', label: 'Operational', isDefaultValue: true }] : [{ value: '1', label: 'Need to Order/Fulfill' }, { value: '7', label: 'Delivered/Shipped Full' }]) as never);
  return { s, h: new AutotaskToolHandler(s, logger), childCreate, query };
}
const call = async (h: AutotaskToolHandler, args: Record<string, unknown>) => JSON.parse((await h.callTool('autotask_add_ticket_materials', args)).content[0]!.text);
const ITEMS = [{ query: 'C6-PLN-FT', quantity: 200 }, { query: 'C6-PC-3', quantity: 3 }, { productId: 13, quantity: 2 }];

describe('add_ticket_materials tool', () => {
  test('dry run by default: a priced plan with the total, nothing written', async () => {
    const { h, childCreate } = mk();
    const r = await call(h, { ticketNumber: 'T20261005.0123', items: ITEMS });
    expect(r.message).toMatch(/^DRY RUN/);
    expect(r.message).toMatch(/Total to add: \$155\.50/);
    expect(childCreate).not.toHaveBeenCalled();
  });

  test('dryRun:false without confirm is stopped by the financial gate', async () => {
    const { h, childCreate } = mk();
    const r = await call(h, { ticketNumber: 'T20261005.0123', items: ITEMS, dryRun: false });
    expect(JSON.stringify(r)).toMatch(/confirm/i);
    expect(childCreate).not.toHaveBeenCalled();
  });

  test('confirmed: creates each charge with catalog price, billing code, picklist defaults, isBillableToCompany', async () => {
    const { h, childCreate } = mk();
    const r = await call(h, { ticketNumber: 'T20261005.0123', items: ITEMS, dryRun: false, confirm: true, status: 'delivered', datePurchased: '2026-10-05' });
    expect(r.message).toMatch(/^Added to T20261005\.0123/);
    expect(childCreate).toHaveBeenCalledTimes(3);
    expect(childCreate.mock.calls[0]).toEqual(['Tickets', 42, 'Charges', expect.objectContaining({ productID: 10, unitQuantity: 200, unitPrice: 0.65, unitCost: 0.31, billingCodeID: 900, chargeType: 1, status: 7, isBillableToCompany: true, datePurchased: '2026-10-05' })]);
    expect((childCreate.mock.calls[2] as unknown[])[3]).not.toHaveProperty('billingCodeID'); // product without one: left to Autotask
  });

  test('a product already on the ticket is not added again; an ambiguous line blocks the whole write', async () => {
    const { h, childCreate } = mk([{ id: 501, productID: 11, unitQuantity: 3, unitPrice: 4.5 }]);
    const dup = await call(h, { ticketNumber: 'T20261005.0123', items: [{ query: 'C6-PC-3', quantity: 3 }], dryRun: false, confirm: true });
    expect(dup.message).toMatch(/nothing to add/);
    const amb = await call(h, { ticketNumber: 'T20261005.0123', items: [{ query: 'C6-PLN-FT', quantity: 200 }, { query: 'cat6 patch cable', quantity: 2 }], dryRun: false, confirm: true });
    expect(amb.message).toMatch(/^NOTHING WRITTEN .*need a decision/s);
    expect(amb.message).toMatch(/NEEDS_PRODUCT/);
    expect(childCreate).not.toHaveBeenCalled();
  });

  test('the router sends "add charges to ticket T…" here, not to ticket search', async () => {
    const { h } = mk();
    const r = JSON.parse((await h.callTool('autotask_router', { intent: 'need to add charges to ticket T20261005.0123: 200ft cable, 2 keystones' })).content[0]!.text);
    expect(JSON.stringify(r)).toMatch(/autotask_add_ticket_materials/);
    expect(JSON.stringify(r)).toMatch(/T20261005\.0123/);
  });
});
