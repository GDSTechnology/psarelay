// #73 — billed units + recurring-revenue roll-up (read-only). Verifies the pure
// MRR/ARR math (proration-aware) and the service wiring (filters + aggregation).
// Live schema confirmed 2026-09-18: ContractServiceUnits/BundleUnits carry
// units + a PRORATED per-period `price`; steady-state monthly = units × rate.

import { computeRecurringRevenue } from '../src/utils/recurring-revenue';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };

describe('computeRecurringRevenue (pure)', () => {
  test('full-month lines: MRR = Σ units×rate, ARR = MRR×12', () => {
    const r = computeRecurringRevenue({
      asOf: new Date('2016-01-15'),
      serviceLines: [{ id: 1060, refId: 35, unitPrice: 40 }],
      serviceUnits: [{ lineId: 1060, units: 1, price: 40, startDate: '2016-01-01', endDate: '2016-01-31' }],
      bundleLines: [{ id: 2, refId: 1, unitPrice: 44.99, adjustedPrice: 44.99 }],
      bundleUnits: [{ lineId: 2, units: 2, price: 89.98, startDate: '2016-01-01', endDate: '2016-01-31' }],
    });
    expect(r.mrr).toBe(129.98);      // 40 + 2*44.99
    expect(r.arr).toBe(1559.76);     // *12
    expect(r.activeLineCount).toBe(2);
    const bundle = r.lines.find((l) => l.kind === 'bundle')!;
    expect(bundle.monthly).toBe(89.98);
    expect(bundle.prorated).toBe(false);
  });

  test('partial covering month: monthly stays units×rate, flagged prorated', () => {
    const r = computeRecurringRevenue({
      asOf: new Date('2019-02-20'),
      serviceLines: [{ id: 1060, refId: 35, unitPrice: 40 }],
      // Feb 11-28: price prorated to 25.71, but steady-state monthly is 40.
      serviceUnits: [{ lineId: 1060, units: 1, price: 25.714296, startDate: '2019-02-11', endDate: '2019-02-28' }],
      bundleLines: [], bundleUnits: [],
    });
    const line = r.lines[0];
    expect(line.monthly).toBe(40);
    expect(line.prorated).toBe(true);
    expect(line.billedThisPeriod).toBeCloseTo(25.714296, 4);
    expect(r.mrr).toBe(40);
  });

  test('adjustedPrice wins over unitPrice', () => {
    const r = computeRecurringRevenue({
      asOf: new Date('2016-01-15'),
      serviceLines: [{ id: 5, refId: 9, unitPrice: 100, adjustedPrice: 75 }],
      serviceUnits: [{ lineId: 5, units: 2, price: 150, startDate: '2016-01-01', endDate: '2016-01-31' }],
      bundleLines: [], bundleUnits: [],
    });
    expect(r.lines[0].rate).toBe(75);
    expect(r.mrr).toBe(150); // 2*75
  });

  test('line with no unit row covering asOf is inactive and excluded from MRR', () => {
    const r = computeRecurringRevenue({
      asOf: new Date('2020-06-01'),
      serviceLines: [{ id: 7, refId: 3, unitPrice: 50 }],
      serviceUnits: [{ lineId: 7, units: 1, price: 50, startDate: '2019-01-01', endDate: '2019-01-31' }],
      bundleLines: [], bundleUnits: [],
    });
    expect(r.lines[0].active).toBe(false);
    expect(r.lines[0].monthly).toBe(0);
    expect(r.mrr).toBe(0);
    expect(r.activeLineCount).toBe(0);
    expect(r.lineCount).toBe(1);
  });

  test('overlapping rows: the one with the latest start wins', () => {
    const r = computeRecurringRevenue({
      asOf: new Date('2016-01-15'),
      serviceLines: [{ id: 1, refId: 1, unitPrice: 10 }],
      serviceUnits: [
        { lineId: 1, units: 1, price: 10, startDate: '2016-01-01', endDate: '2016-12-31' },
        { lineId: 1, units: 5, price: 50, startDate: '2016-01-10', endDate: '2016-01-31' },
      ],
      bundleLines: [], bundleUnits: [],
    });
    expect(r.lines[0].units).toBe(5); // latest-start covering row
    expect(r.mrr).toBe(50);
  });
});

describe('service wiring', () => {
  // Minimal fake http: query() returns rows keyed by entity, capturing filters.
  const makeHttp = (data: Record<string, any[]>, calls: any[] = []) => ({
    query: jest.fn(async (entity: string, filters: any) => { calls.push({ entity, filters }); return data[entity] ?? []; }),
    get: jest.fn(async () => null),
  });

  test('getContractRecurringRevenue filters units to the asOf period and rolls up', async () => {
    const s = new AutotaskService(config, logger);
    const calls: any[] = [];
    const http = makeHttp({
      ContractServices: [{ id: 1060, serviceID: 35, unitPrice: 40 }],
      ContractServiceBundles: [{ id: 2, serviceBundleID: 1, unitPrice: 44.99, adjustedPrice: 44.99 }],
      ContractServiceUnits: [{ contractServiceID: 1060, units: 1, price: 40, startDate: '2016-01-01', endDate: '2016-01-31' }],
      ContractServiceBundleUnits: [{ contractServiceBundleID: 2, units: 2, price: 89.98, startDate: '2016-01-01', endDate: '2016-01-31' }],
    }, calls);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue(http);
    jest.spyOn(s, 'getService').mockResolvedValue({ id: 35, name: 'Managed Service' } as any);
    jest.spyOn(s, 'getServiceBundle').mockResolvedValue({ id: 1, name: 'Gold Bundle' } as any);

    const r = await s.getContractRecurringRevenue({ contractID: 999, asOfDate: '2016-01-15' });
    expect(r.mrr).toBe(129.98);
    expect(r.arr).toBe(1559.76);
    expect(r.contractID).toBe(999);
    // names enriched
    expect(r.lines.find((l) => l.kind === 'service')!.refName).toBe('Managed Service');
    expect(r.lines.find((l) => l.kind === 'bundle')!.refName).toBe('Gold Bundle');
    // units queries carry the covering-date window (startDate lte / endDate gte)
    const unitCall = calls.find((c) => c.entity === 'ContractServiceUnits');
    const ops = unitCall.filters.map((f: any) => `${f.field} ${f.op}`);
    expect(ops).toEqual(expect.arrayContaining(['contractID eq', 'startDate lte', 'endDate gte']));
  });

  test('getContractBilledUnits sums price and omits bundle units for a single line', async () => {
    const s = new AutotaskService(config, logger);
    const http = makeHttp({
      ContractServiceUnits: [
        { contractServiceID: 1060, serviceID: 35, units: 1, price: 25.71, startDate: '2019-02-11', endDate: '2019-02-28' },
        { contractServiceID: 1060, serviceID: 35, units: 1, price: 40, startDate: '2019-03-01', endDate: '2019-03-31' },
      ],
      ContractServiceBundleUnits: [{ contractServiceBundleID: 2, serviceBundleID: 1, units: 2, price: 89.98 }],
    });
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue(http);
    jest.spyOn(s, 'getService').mockResolvedValue({ id: 35, name: 'Svc' } as any);

    const one = await s.getContractBilledUnits({ contractID: 5, contractServiceID: 1060 });
    expect(one.totalServiceUnits).toBe(2);
    expect(one.totalBundleUnits).toBe(0);         // bundles omitted for a single-line scope
    expect(one.totalBilled).toBe(65.71);          // 25.71 + 40 (price summed for billed-units, unlike MRR)
    expect(one.serviceUnits[0].serviceName).toBe('Svc');
  });
});
