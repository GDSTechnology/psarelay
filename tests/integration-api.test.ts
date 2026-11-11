// Integration read API (/api/v1, migration 0024): key checks, entity scope, mirror-first answers, and the gates a
// mirror miss passes before it may reach Autotask (key allows live, live cap, backpressure). Asserts on what is sent
// upstream, not only on the rows returned.

import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { handleReadApi, validateFilter, type ReadApiDeps } from '../src/integrations/read-api';
import { ApiKeyStore, coercePolicy, apiKeyShapeOk, newApiKey, hashApiKey, type ApiKeyAuth } from '../src/integrations/api-keys';
import { _setShadowRuntime, mirrorQuery, shadowRead } from '../src/db/shadow-runtime';

const GOOD = newApiKey();
const baseKey: ApiKeyAuth = { id: 7, name: 'Time module', entities: ['Companies', 'TimeEntries'], allowLive: false, allowExternal: true, hourlyLimit: 100, liveHourlyLimit: 5 };

function setup(over: { key?: Partial<ApiKeyAuth>; mirror?: Partial<ReadApiDeps['mirror']>; pressure?: 'ok' | 'stop' } = {}) {
  const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  const keys = new ApiKeyStore(fakePool);
  const key = { ...baseKey, ...over.key };
  keys.verify = async (k: string) => (k === GOOD ? key : null);
  const upstream: Array<{ method: string; path: string; body?: unknown }> = [];
  const live = {
    rawRequest: async <T>(method: string, path: string, body?: unknown) => { upstream.push({ method, path, body }); return { items: [{ id: 1, companyName: 'Live Co', phone: 'x' }], pageDetails: { nextPageUrl: 'https://webservices.example/next' } } as T; },
    get: async <T>(entity: string, id: number) => { upstream.push({ method: 'GET', path: `/${entity}/${id}` }); return { id, companyName: 'Live Co' } as T; },
  };
  const deps: ReadApiDeps = {
    keys,
    mirror: {
      query: async (_e, _f, limit) => ({ ok: true, rows: [{ id: 1, companyName: 'A', phone: '1' }, { id: 2, companyName: 'B', phone: '2' }, { id: 3, companyName: 'C', phone: '3' }].slice(0, limit), ageSeconds: 42 }),
      get: async (_e, id) => ({ ok: true, row: id === 1 ? { id: 1, companyName: 'A' } : null, ageSeconds: 42 }),
      freshness: async (e) => ({ entity: e, ready: true, lastSyncedAt: null, ageSeconds: 42, rows: 3, windowFrom: null }),
      ...over.mirror,
    },
    live: async () => live,
    pressure: () => ({ level: over.pressure ?? 'ok', retryAfterSeconds: over.pressure === 'stop' ? 120 : null }),
  };
  return { deps, keys, upstream };
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
afterEach(() => _setShadowRuntime(null));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();
const call = (path: string, init: { method?: string; body?: unknown; key?: string | null; headers?: Record<string, string> } = {}) =>
  fetch(base + path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(init.key === null ? {} : { Authorization: `Bearer ${init.key ?? GOOD}` }), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

describe('keys', () => {
  test('shape: psk_ + 43 base64url chars; only the hash is stored', () => {
    const k = newApiKey();
    expect(apiKeyShapeOk(k)).toBe(true);
    expect(apiKeyShapeOk('psr_' + k.slice(4))).toBe(false); // an MCP token is not an API key
    expect(hashApiKey(k)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('policy: entity names normalised to the mirror, unknown / empty refused, caps bounded', () => {
    expect(coercePolicy({ entities: ['timeentries', 'Companies', 'companies'] })).toEqual({ entities: ['Companies', 'TimeEntries'], allowLive: false, allowExternal: false, hourlyLimit: 3600, liveHourlyLimit: 100 });
    expect(() => coercePolicy({ entities: ['Invoicez'] })).toThrow(/not a mirrored entity/);
    expect(() => coercePolicy({ entities: [] })).toThrow(/at least one/);
    expect(() => coercePolicy({ entities: ['Companies'], liveHourlyLimit: 99999 })).toThrow(/0 to 5000/);
    expect(() => coercePolicy({ entities: ['Companies'], allowLive: 'yes' })).toThrow(/true or false/);
    // An edit keeps what it doesn't name.
    expect(coercePolicy({ allowLive: true }, { entities: ['Tickets'], allowLive: false, allowExternal: true, hourlyLimit: 10, liveHourlyLimit: 2 }))
      .toEqual({ entities: ['Tickets'], allowLive: true, allowExternal: true, hourlyLimit: 10, liveHourlyLimit: 2 });
  });
});

describe('filter validation', () => {
  test('accepts Autotask filters, nested groups and UDFs', () => {
    expect(validateFilter([{ op: 'or', items: [{ op: 'eq', field: 'status', value: 1 }, { op: 'in', field: 'id', value: [1, 2] }] }, { op: 'eq', field: 'Region', value: 'N', udf: true }]))
      .toEqual([{ op: 'or', items: [{ op: 'eq', field: 'status', value: 1 }, { op: 'in', field: 'id', value: [1, 2] }] }, { op: 'eq', field: 'Region', value: 'N', udf: true }]);
    expect(validateFilter(undefined)).toEqual([]);
  });
  test('refuses unknown ops, unsafe field names, objects as values, and deep nesting', () => {
    expect(() => validateFilter([{ op: 'drop', field: 'id' }])).toThrow(/Unknown filter op/);
    expect(() => validateFilter([{ op: 'eq', field: 'id; DROP TABLE x', value: 1 }])).toThrow(/field/);
    expect(() => validateFilter([{ op: 'eq', field: 'id', value: { $gt: 1 } }])).toThrow(/must be a string/);
    let deep: Record<string, unknown> = { op: 'eq', field: 'id', value: 1 };
    for (let i = 0; i < 6; i++) deep = { op: 'and', items: [deep] };
    expect(() => validateFilter([deep])).toThrow(/4 levels/);
    expect(() => validateFilter({ op: 'eq' })).toThrow(/array/);
  });
});

describe('/api/v1', () => {
  test('no key / wrong key → 401; an MCP token is not accepted', async () => {
    current = setup().deps;
    expect((await call('/api/v1', { key: null })).status).toBe(401);
    expect((await call('/api/v1', { key: 'psr_' + 'a'.repeat(43) })).status).toBe(401);
    const r = await call('/api/v1', { key: null });
    expect(r.headers.get('www-authenticate')).toMatch(/Bearer/);
  });

  test('info: the key and the freshness of what it may read', async () => {
    current = setup().deps;
    const r = await call('/api/v1');
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.key.name).toBe('Time module');
    expect(b.entities.map((e: { name: string }) => e.name)).toEqual(['Companies', 'TimeEntries']);
    expect(b.entities[0]).toMatchObject({ ready: true, ageSeconds: 42 });
  });

  test('an entity outside the key is refused, whatever its case', async () => {
    current = setup().deps;
    const r = await call('/api/v1/Tickets/query', { body: { filter: [] } });
    expect(r.status).toBe(403);
    expect((await json(r)).error).toMatch(/may read: Companies, TimeEntries/);
    expect((await call('/api/v1/companies/query', { body: { filter: [] } })).status).toBe(200);
  });

  test('query from the mirror: Autotask shape, hasMore from one extra row, IncludeFields keeps id', async () => {
    const s = setup();
    const asked: number[] = [];
    s.deps.mirror.query = async (_e, _f, limit) => { asked.push(limit); return { ok: true, rows: [{ id: 1, companyName: 'A', phone: '1' }, { id: 2, companyName: 'B', phone: '2' }, { id: 3, companyName: 'C', phone: '3' }].slice(0, limit), ageSeconds: 42 }; };
    current = s.deps;
    const r = await call('/api/v1/Companies/query', { body: { filter: [{ op: 'gt', field: 'id', value: 0 }], MaxRecords: 2, IncludeFields: ['companyName'] } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-psarelay-source')).toBe('mirror');
    expect(r.headers.get('x-psarelay-age')).toBe('42');
    const b = await json(r);
    expect(asked).toEqual([3]);
    expect(b.items).toEqual([{ id: 1, companyName: 'A' }, { id: 2, companyName: 'B' }]);
    expect(b.hasMore).toBe(true);
    expect(b.pageDetails).toEqual({ count: 2, requestCount: 2, prevPageUrl: null, nextPageUrl: null });
    expect(s.upstream).toEqual([]);
    expect(s.keys.current(7)).toEqual({ total: 1, live: 0 });
  });

  test('bad input is a 400, not an upstream call', async () => {
    const s = setup({ key: { allowLive: true } });
    current = s.deps;
    expect((await call('/api/v1/Companies/query', { body: { filter: [{ op: 'nope', field: 'id' }] } })).status).toBe(400);
    expect((await call('/api/v1/Companies/query', { body: { MaxRecords: 501 } })).status).toBe(400);
    expect((await call('/api/v1/Companies/query', { method: 'GET' })).status).toBe(405);
    expect((await call('/api/v1/Companies/5', { method: 'DELETE' })).status).toBe(405);
    expect(s.upstream).toEqual([]);
  });

  test('mirror miss on a mirror-only key → 503 with the reason; nothing sent to Autotask', async () => {
    const s = setup({ mirror: { query: async () => ({ ok: false, reason: 'stale' }) } });
    current = s.deps;
    const r = await call('/api/v1/Companies/query', { body: { filter: [] } });
    expect(r.status).toBe(503);
    expect(r.headers.get('x-psarelay-mirror-miss')).toBe('stale');
    expect(await json(r)).toMatchObject({ reason: 'stale', live: 'live_off' });
    expect(s.upstream).toEqual([]);
  });

  test('mirror miss with live allowed → one Autotask query (match-all sentinel when no filter), Autotask paging link not leaked', async () => {
    const s = setup({ key: { allowLive: true }, mirror: { query: async () => ({ ok: false, reason: 'outside_window' }) } });
    current = s.deps;
    const r = await call('/api/v1/Companies/query', { body: { MaxRecords: 50, IncludeFields: ['companyName'] } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-psarelay-source')).toBe('live');
    expect(s.upstream).toEqual([{ method: 'POST', path: '/Companies/query', body: { filter: [{ op: 'gte', field: 'id', value: 0 }], MaxRecords: 50, IncludeFields: ['companyName'] } }]);
    const b = await json(r);
    expect(b.items).toEqual([{ id: 1, companyName: 'Live Co' }]);
    expect(b.hasMore).toBe(true);
    expect(JSON.stringify(b)).not.toMatch(/webservices/);
    expect(s.keys.current(7)).toEqual({ total: 1, live: 1 });
  });

  test('live is refused under backpressure "stop" and past the live cap', async () => {
    const miss = { query: async () => ({ ok: false as const, reason: 'stale' as const }) };
    let s = setup({ key: { allowLive: true }, mirror: miss, pressure: 'stop' });
    current = s.deps;
    let r = await call('/api/v1/Companies/query', { body: {} });
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('120');
    expect(s.upstream).toEqual([]);

    s = setup({ key: { allowLive: true, liveHourlyLimit: 1 }, mirror: miss });
    current = s.deps;
    expect((await call('/api/v1/Companies/query', { body: {} })).status).toBe(200);
    r = await call('/api/v1/Companies/query', { body: {} });
    expect(r.status).toBe(503);
    expect((await json(r)).live).toBe('live_cap');
    expect(s.upstream).toHaveLength(1);
  });

  test('hourly cap → 429 with Retry-After', async () => {
    const s = setup({ key: { hourlyLimit: 2 } });
    current = s.deps;
    await call('/api/v1');
    await call('/api/v1');
    const r = await call('/api/v1');
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('by id: from the mirror; a row not in the mirror is {item:null} on a mirror-only key, asked live otherwise', async () => {
    let s = setup();
    current = s.deps;
    let r = await call('/api/v1/Companies/1');
    expect(await json(r)).toEqual({ item: { id: 1, companyName: 'A' } });
    r = await call('/api/v1/Companies/99');
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ item: null });
    expect(s.upstream).toEqual([]);

    s = setup({ key: { allowLive: true } });
    current = s.deps;
    r = await call('/api/v1/Companies/99');
    expect(r.headers.get('x-psarelay-source')).toBe('live');
    expect(r.headers.get('x-psarelay-mirror-miss')).toBe('not_in_mirror');
    expect(s.upstream).toEqual([{ method: 'GET', path: '/Companies/99' }]);
  });

  test('a private-network key is refused through a proxy / tunnel', async () => {
    current = setup({ key: { allowExternal: false } }).deps;
    expect((await call('/api/v1')).status).toBe(200);
    expect((await call('/api/v1', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status).toBe(403);
  });

  test('no Postgres → 503', async () => {
    current = { ...setup().deps, keys: null };
    expect((await call('/api/v1')).status).toBe(503);
  });
});

describe('mirror reads', () => {
  const rt = (serveReads: boolean, ageSeconds = 10) => ({
    serveReads, maxAgeSeconds: 900, sync: { writtenWithin: () => false, isDirty: () => false },
    store: {
      freshness: async (e: string) => ({ entity: e, ready: true, lastSyncedAt: null, ageSeconds, rows: 1, windowFrom: null }),
      fieldNames: async () => ['id', 'companyName'], udfNames: async () => [],
      query: async () => ({ rows: [{ id: 1, companyName: 'A' }], total: 1 }),
    },
  });
  test('the API reads the mirror even when the MCP\'s own reads go live; MCP reads still honour serveReads', async () => {
    _setShadowRuntime(rt(false) as never);
    expect(await mirrorQuery('Companies', [{ op: 'eq', field: 'companyName', value: 'A' }], 10)).toMatchObject({ ok: true, rows: [{ id: 1 }] });
    expect(await shadowRead('Companies', [], 10)).toBeNull();
  });
  test('misses carry a reason: stale copy, unknown field, entity not mirrored, mirror off', async () => {
    _setShadowRuntime(rt(true, 99_999) as never);
    expect(await mirrorQuery('Companies', [], 10)).toEqual({ ok: false, reason: 'stale' });
    _setShadowRuntime(rt(true) as never);
    expect(await mirrorQuery('Companies', [{ op: 'eq', field: 'nope', value: 1 }], 10)).toEqual({ ok: false, reason: 'unknown_field' });
    expect(await mirrorQuery('Quotes', [], 10)).toEqual({ ok: false, reason: 'not_mirrored' });
    _setShadowRuntime(null);
    expect(await mirrorQuery('Companies', [], 10)).toEqual({ ok: false, reason: 'mirror_off' });
  });
});
