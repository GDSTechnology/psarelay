// Full-access product/inventory CRUD: read dispatch + confirmation gating on the
// count-mutating writes (transfer/add = inventory-movement, remove = destructive).

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const mk = () => { const s = new AutotaskService(config, logger); jest.spyOn(s as any, 'ensureClient').mockResolvedValue({}); return s; };
const parse = (r: any) => JSON.parse(r.content[0].text);

describe('inventory read tools dispatch', () => {
  test('search_inventory_locations returns results', async () => {
    const s = mk();
    jest.spyOn(s, 'searchInventoryLocations').mockResolvedValue([{ id: 1, locationName: 'Main WH', isActive: true }] as any);
    const h = new AutotaskToolHandler(s, logger);
    const r = parse(await h.callTool('autotask_search_inventory_locations', {}));
    expect(r.data[0].locationName).toBe('Main WH');
  });
});

describe('count-mutating writes require confirmation', () => {
  test('create_inventory_transfer without confirm → confirmation-required, no write', async () => {
    const s = mk();
    const spy = jest.spyOn(s, 'createInventoryTransfer').mockResolvedValue(1);
    const h = new AutotaskToolHandler(s, logger);
    const r = parse(await h.callTool('autotask_create_inventory_transfer', { fromLocationID: 1, toLocationID: 2, productID: 3, quantityTransferred: 5 }));
    expect(r.data.status).toBe('confirmation_required');
    expect(spy).not.toHaveBeenCalled();
  });

  test('create_inventory_transfer with confirm:true executes', async () => {
    const s = mk();
    const spy = jest.spyOn(s, 'createInventoryTransfer').mockResolvedValue(77);
    const h = new AutotaskToolHandler(s, logger);
    const r = parse(await h.callTool('autotask_create_inventory_transfer', { fromLocationID: 1, toLocationID: 2, productID: 3, quantityTransferred: 5, confirm: true }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ fromLocationID: 1, toLocationID: 2, productID: 3, quantityTransferred: 5 }));
    expect(r.data.id ?? r.data).toBeDefined();
    // confirm must be stripped before reaching the service
    expect(spy.mock.calls[0][0]).not.toHaveProperty('confirm');
  });

  test('add_inventory_stock without confirm → confirmation-required', async () => {
    const s = mk();
    const spy = jest.spyOn(s, 'addInventoryStock').mockResolvedValue(1);
    const h = new AutotaskToolHandler(s, logger);
    const r = parse(await h.callTool('autotask_add_inventory_stock', { inventoryProductID: 9, quantityBeingAdded: 10, vendorID: 4, determineCostUsing: 1 }));
    expect(r.data.status).toBe('confirmation_required');
    expect(spy).not.toHaveBeenCalled();
  });

  test('remove_inventory_stock (destructive) without confirm → confirmation-required', async () => {
    const s = mk();
    const spy = jest.spyOn(s, 'removeInventoryStock').mockResolvedValue(1);
    const h = new AutotaskToolHandler(s, logger);
    const r = parse(await h.callTool('autotask_remove_inventory_stock', { inventoryProductID: 9, quantityBeingRemoved: 3 }));
    expect(r.data.status).toBe('confirmation_required');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('non-movement writes do not require confirmation', () => {
  test('update_product executes without confirm', async () => {
    const s = mk();
    const spy = jest.spyOn(s, 'updateProduct').mockResolvedValue(undefined);
    const h = new AutotaskToolHandler(s, logger);
    await h.callTool('autotask_update_product', { id: 5, msrp: 42 });
    expect(spy).toHaveBeenCalledWith(5, expect.objectContaining({ msrp: 42 }));
  });
});
