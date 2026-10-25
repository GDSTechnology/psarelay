// Catalog Phase B (#93): guarded bulk-update + merge planning, and dry-run-first
// gating through the service. Pure planners + mocked service.

import { planBulkProductUpdate, planProductMerge } from '../src/utils/catalog-hygiene';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

describe('planBulkProductUpdate (pure)', () => {
  test('keeps only real changes, skips no-ops, unknown fields, and not-found', () => {
    const current = new Map<number, any>([
      [1, { id: 1, description: 'old', msrp: 0, productCategory: 7 }],
      [2, { id: 2, description: 'same', msrp: 10 }],
    ]);
    const plan = planBulkProductUpdate(current, [
      { id: 1, description: 'new', msrp: 25, productCategory: 7, bogusField: 'x' }, // desc+msrp change; category same; bogus ignored
      { id: 2, description: 'same' },                                                // no-op
      { id: 99, description: 'ghost' },                                              // not found
    ]);
    const i1 = plan.items.find((i) => i.id === 1)!;
    expect(Object.keys(i1.changes).sort()).toEqual(['description', 'msrp']);
    expect(i1.changes.msrp).toEqual({ from: 0, to: 25 });
    expect(plan.items.find((i) => i.id === 2)!.noop).toBe(true);
    expect(plan.notFound).toEqual([99]);
    expect(plan.totalWithChanges).toBe(1);
    expect(plan.totalChangedFields).toBe(2);
  });
});

describe('planProductMerge (pure)', () => {
  test('enriches survivor from dups, lists deactivations, flags on-hand', () => {
    const survivor = { id: 10, description: '', msrp: 0, productCategory: null };
    const dups = [
      { id: 11, description: 'good desc', msrp: 0, productCategory: 7 },
      { id: 12, description: 'other', msrp: 99, productCategory: 7 },
    ];
    const onHand = new Map<number, number>([[11, 0], [12, 5]]);
    const plan = planProductMerge(survivor, dups, onHand);
    expect(plan.survivorPatch.description.to).toBe('good desc'); // first non-empty
    expect(plan.survivorPatch.msrp.to).toBe(99);                 // first dup with msrp>0
    expect(plan.survivorPatch.productCategory.to).toBe(7);
    expect(plan.deactivate.sort()).toEqual([11, 12]);
    expect(plan.onHandWarnings).toEqual([{ id: 12, onHand: 5 }]); // dup 12 still holds stock
  });
  test('enrichSurvivor:false leaves survivor untouched', () => {
    const plan = planProductMerge({ id: 1, description: '' }, [{ id: 2, description: 'x' }], new Map(), { enrichSurvivor: false });
    expect(plan.survivorPatch).toEqual({});
  });
});

describe('service dry-run gating', () => {
  const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
  const mk = () => new AutotaskService(config, new Logger('error'));

  test('bulkUpdateProducts defaults to dry-run — no writes', async () => {
    const s = mk();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: async () => [{ id: 1, description: 'old' }] });
    const upd = jest.spyOn(s, 'updateProduct').mockResolvedValue(undefined);
    const r = await s.bulkUpdateProducts({ updates: [{ id: 1, description: 'new' }] });
    expect(r.status).toBe('dry_run');
    expect(upd).not.toHaveBeenCalled();
  });

  test('bulkUpdateProducts with dryRun:false applies only changed fields', async () => {
    const s = mk();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: async () => [{ id: 1, description: 'old', msrp: 5 }] });
    const upd = jest.spyOn(s, 'updateProduct').mockResolvedValue(undefined);
    const r = await s.bulkUpdateProducts({ updates: [{ id: 1, description: 'new', msrp: 5 }], dryRun: false });
    expect(r.status).toBe('updated');
    expect(upd).toHaveBeenCalledWith(1, { description: 'new' }); // msrp unchanged → not sent
  });

  test('mergeProducts dry-run reports plan without writing', async () => {
    const s = mk();
    jest.spyOn(s, 'getProduct').mockImplementation(async (id: number) => ({ id, description: id === 1 ? '' : 'donor desc', msrp: 0 } as any));
    jest.spyOn(s, 'searchInventoryProducts').mockResolvedValue([{ onHandUnits: 0 }] as any);
    const upd = jest.spyOn(s, 'updateProduct').mockResolvedValue(undefined);
    const r = await s.mergeProducts({ survivorId: 1, duplicateIds: [2] });
    expect(r.status).toBe('dry_run');
    expect(r.wouldDeactivate).toEqual([2]);
    expect(upd).not.toHaveBeenCalled();
  });

  test('mergeProducts execute enriches survivor and deactivates dups', async () => {
    const s = mk();
    jest.spyOn(s, 'getProduct').mockImplementation(async (id: number) => ({ id, description: id === 1 ? '' : 'donor desc', msrp: 0 } as any));
    jest.spyOn(s, 'searchInventoryProducts').mockResolvedValue([] as any);
    const upd = jest.spyOn(s, 'updateProduct').mockResolvedValue(undefined);
    const r = await s.mergeProducts({ survivorId: 1, duplicateIds: [2], dryRun: false });
    expect(r.status).toBe('merged');
    expect(upd).toHaveBeenCalledWith(1, expect.objectContaining({ description: 'donor desc' }));
    expect(upd).toHaveBeenCalledWith(2, { isActive: false });
    expect(r.deactivated).toEqual([2]);
  });
});
