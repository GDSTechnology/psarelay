// Integration API picklist labels: GET /api/v1/{Entity}/entityInformation/fields (Autotask's shape) and
// "PicklistLabels": true on queries / ?picklistLabels=true on by-id reads, so a CRM sync can show the company type
// (Customer, Partner, Vendor …) by the tenant's own labels.

import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { addPicklistLabels, handleReadApi, picklistLabelMap, type ReadApiDeps } from '../src/integrations/read-api';
import { ApiKeyStore, newApiKey, type ApiKeyAuth } from '../src/integrations/api-keys';

const GOOD = newApiKey();
const KEY: ApiKeyAuth = { id: 7, name: 'CRM', entities: ['Companies'], allowLive: false, allowExternal: true, hourlyLimit: 100, liveHourlyLimit: 5,
  writeEntities: [], allowDelete: false, writeHourlyLimit: 3 };
const FIELDS = [
  { name: 'id', isPickList: false },
  { name: 'companyName', isPickList: false },
  { name: 'companyType', isPickList: true, picklistValues: [
    { value: '1', label: 'Customer' }, { value: '2', label: 'Lead' }, { value: '3', label: 'Prospect' },
    { value: '7', label: 'Vendor' }, { value: '8', label: 'Partner' }] },
  { name: 'classification', isPickList: true, picklistValues: [{ value: '5', label: 'Gold' }] },
];
const ROWS = [
  { id: 1, companyName: 'A', companyType: 1, classification: 5 },
  { id: 2, companyName: 'B', companyType: 8, classification: null },
  { id: 3, companyName: 'C', companyType: 99 },
];

function deps(over: { fieldInfo?: () => Promise<{ fields: unknown[] }> | never; noFieldInfo?: boolean } = {}) {
  const keys = new ApiKeyStore({ query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool);
  keys.verify = async (k: string) => (k === GOOD ? KEY : null);
  const calls: string[] = [];
  const live: Record<string, unknown> = {
    rawRequest: async () => ({ items: [] }),
    get: async () => null,
    write: async () => ({}),
  };
  if (!over.noFieldInfo) live.fieldInfo = async (e: string) => { calls.push(e); return over.fieldInfo ? over.fieldInfo() : { fields: FIELDS }; };
  const d: ReadApiDeps = {
    keys,
    mirror: {
      query: async (_e, _f, limit) => ({ ok: true, rows: ROWS.map((r) => ({ ...r })).slice(0, limit), ageSeconds: 10 }),
      get: async (_e, id) => ({ ok: true, row: ROWS.find((r) => r.id === id) ? { ...ROWS.find((r) => r.id === id)! } : null, ageSeconds: 10 }),
      freshness: async () => null,
    },
    live: async () => live as never,
    pressure: () => ({ level: 'ok', retryAfterSeconds: null }),
  };
  return { d, calls };
}

let server: Server;
let base = '';
let current: ReadApiDeps;
beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => { void handleReadApi(req, res, new URL(req.url!, 'http://x'), current); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();
const call = (path: string, body?: unknown, method?: string) => fetch(base + path, {
  method: method ?? (body !== undefined ? 'POST' : 'GET'),
  headers: { Authorization: `Bearer ${GOOD}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

describe('helpers', () => {
  test('label map and labels per row: unknown value → null, absent field skipped', () => {
    const rows: Array<Record<string, unknown>> = [{ id: 1, companyType: 8 }, { id: 2, companyType: 42, classification: null }];
    addPicklistLabels(rows, picklistLabelMap(FIELDS));
    expect(rows[0]!.picklistLabels).toEqual({ companyType: 'Partner' });
    expect(rows[1]!.picklistLabels).toEqual({ companyType: null, classification: null });
  });
});

describe('/api/v1 picklist labels', () => {
  test('entityInformation/fields answers Autotask\'s shape for an entity the key may read', async () => {
    const { d, calls } = deps(); current = d;
    const r = await call('/api/v1/Companies/entityInformation/fields');
    expect(r.status).toBe(200);
    expect((await json(r)).fields.find((f: { name: string }) => f.name === 'companyType').picklistValues).toHaveLength(5);
    expect(calls).toEqual(['Companies']);
    expect((await call('/api/v1/Tickets/entityInformation/fields')).status).toBe(403);
    expect((await call('/api/v1/Companies/entityInformation/fields', {}, 'POST')).status).toBe(405);
  });

  test('query with PicklistLabels adds the company type label; without it rows are unchanged', async () => {
    const { d, calls } = deps(); current = d;
    const r = await call('/api/v1/Companies/query', { filter: [{ op: 'gt', field: 'id', value: 0 }], PicklistLabels: true });
    expect(r.headers.get('x-psarelay-labels')).toBe('ok');
    const items = (await json(r)).items;
    expect(items.map((i: { picklistLabels: Record<string, unknown> }) => i.picklistLabels.companyType)).toEqual(['Customer', 'Partner', null]);
    expect(items[0].picklistLabels.classification).toBe('Gold');
    const plain = await json(await call('/api/v1/Companies/query', { filter: [] }));
    expect(plain.items[0].picklistLabels).toBeUndefined();
    expect(calls).toEqual(['Companies']); // only the labelled query loaded the field list
  });

  test('labels follow IncludeFields', async () => {
    const { d } = deps(); current = d;
    const items = (await json(await call('/api/v1/Companies/query', { filter: [], IncludeFields: ['companyType'], PicklistLabels: true }))).items;
    expect(items[0]).toEqual({ id: 1, companyType: 1, picklistLabels: { companyType: 'Customer' } });
  });

  test('by id with ?picklistLabels=true', async () => {
    const { d } = deps(); current = d;
    const item = (await json(await call('/api/v1/Companies/2?picklistLabels=true'))).item;
    expect(item.picklistLabels.companyType).toBe('Partner');
  });

  test('field list unavailable: rows still come back, header says so', async () => {
    const { d } = deps({ fieldInfo: async () => { throw new Error('HTTP 503'); } }); current = d;
    const r = await call('/api/v1/Companies/query', { filter: [], PicklistLabels: true });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-psarelay-labels')).toBe('unavailable');
    expect((await json(r)).items).toHaveLength(3);
  });
});
