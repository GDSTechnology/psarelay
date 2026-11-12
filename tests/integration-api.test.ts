// Integration read API (/api/v1, migration 0024): key checks, entity scope, mirror-first answers, and the gates a
// mirror miss passes before it may reach Autotask (key allows live, live cap, backpressure). Asserts on what is sent
// upstream, not only on the rows returned.

import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { handleReadApi, validateFilter, writeRoute, type ReadApiDeps } from '../src/integrations/read-api';
import { ApiKeyStore, coercePolicy, apiKeyShapeOk, newApiKey, hashApiKey, type ApiKeyAuth, type WriteClaim } from '../src/integrations/api-keys';
import { _setShadowRuntime, mirrorQuery, shadowRead } from '../src/db/shadow-runtime';

const GOOD = newApiKey();
const baseKey: ApiKeyAuth = { id: 7, name: 'Time module', entities: ['Companies', 'TimeEntries'], allowLive: false, allowExternal: true, hourlyLimit: 100, liveHourlyLimit: 5,
  writeEntities: [], allowDelete: false, writeHourlyLimit: 3 };

function setup(over: { key?: Partial<ApiKeyAuth>; mirror?: Partial<ReadApiDeps['mirror']>; pressure?: 'ok' | 'stop'; writeError?: Error; claim?: WriteClaim } = {}) {
  const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  const keys = new ApiKeyStore(fakePool);
  const key = { ...baseKey, ...over.key };
  keys.verify = async (k: string) => (k === GOOD ? key : null);
  const upstream: Array<{ method: string; path: string; body?: unknown }> = [];
  const live = {
    rawRequest: async <T>(method: string, path: string, body?: unknown) => { upstream.push({ method, path, body }); return { items: [{ id: 1, companyName: 'Live Co', phone: 'x' }], pageDetails: { nextPageUrl: 'https://webservices.example/next' } } as T; },
    get: async <T>(entity: string, id: number) => { upstream.push({ method: 'GET', path: `/${entity}/${id}` }); return { id, companyName: 'Live Co' } as T; },
    write: async <T>(method: string, path: string, body?: unknown) => {
      upstream.push({ method, path, body });
      if (over.writeError) throw over.writeError;
      return (method === 'DELETE' ? undefined : { itemId: (body as { id?: number })?.id ?? 900 }) as T;
    },
  };
  const writes: Array<{ id: number; status: string; httpStatus: number; recordId?: number | null; error?: string | null }> = [];
  const claims: unknown[] = [];
  keys.claimWrite = async (o) => { claims.push(o); return over.claim ?? { kind: 'new', id: 41 }; };
  keys.finishWrite = async (id, o) => { writes.push({ id, ...o }); };
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
  return { deps, keys, upstream, writes, claims };
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
    expect(coercePolicy({ entities: ['timeentries', 'Companies', 'companies'] })).toMatchObject({ entities: ['Companies', 'TimeEntries'], allowLive: false, allowExternal: false, hourlyLimit: 3600, liveHourlyLimit: 100 });
    expect(() => coercePolicy({ entities: ['Invoicez'] })).toThrow(/not a mirrored entity/);
    expect(() => coercePolicy({ entities: [] })).toThrow(/at least one/);
    expect(() => coercePolicy({ entities: ['Companies'], liveHourlyLimit: 99999 })).toThrow(/0 to 5000/);
    expect(() => coercePolicy({ entities: ['Companies'], allowLive: 'yes' })).toThrow(/true or false/);
    // An edit keeps what it doesn't name.
    expect(coercePolicy({ allowLive: true }, { entities: ['Tickets'], allowLive: false, allowExternal: true, hourlyLimit: 10, liveHourlyLimit: 2, writeEntities: [], allowDelete: false, writeHourlyLimit: 200 }))
      .toMatchObject({ entities: ['Tickets'], allowLive: true, allowExternal: true, hourlyLimit: 10, liveHourlyLimit: 2 });
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
    expect(s.keys.current(7)).toEqual({ total: 1, live: 0, writes: 0 });
  });

  test('bad input is a 400, not an upstream call', async () => {
    const s = setup({ key: { allowLive: true } });
    current = s.deps;
    expect((await call('/api/v1/Companies/query', { body: { filter: [{ op: 'nope', field: 'id' }] } })).status).toBe(400);
    expect((await call('/api/v1/Companies/query', { body: { MaxRecords: 501 } })).status).toBe(400);
    expect((await call('/api/v1/Companies/query', { method: 'GET' })).status).toBe(405);
    expect((await call('/api/v1/Companies/5', { method: 'DELETE' })).status).toBe(403); // a write, and this key is read-only
    expect((await call('/api/v1/Companies/5', { method: 'PATCH', body: { name: 'x' } })).status).toBe(405);
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
    expect(s.keys.current(7)).toEqual({ total: 1, live: 1, writes: 0 });
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

describe('writes', () => {
  const W = { writeEntities: ['TicketNotes', 'TimeEntries'] };
  const entry = { ticketID: 4567, resourceID: 123, roleID: 456, dateWorked: '2026-11-11', hoursWorked: 1, summaryNotes: 'Fixed it' };

  test('routes: Autotask paths, child URLs mapped to the entity a key needs', () => {
    expect(writeRoute('/api/v1/timeentries', 'POST')).toEqual({ method: 'POST', entity: 'TimeEntries', asked: 'timeentries', path: '/TimeEntries', recordId: null });
    expect(writeRoute('/api/v1/TimeEntries/12', 'DELETE')).toMatchObject({ entity: 'TimeEntries', path: '/TimeEntries/12', recordId: 12 });
    expect(writeRoute('/api/v1/tickets/12/notes', 'POST')).toMatchObject({ entity: 'TicketNotes', path: '/Tickets/12/Notes' });
    expect(writeRoute('/api/v1/Companies/5/Contacts', 'PATCH')).toMatchObject({ entity: 'Contacts', path: '/Companies/5/Contacts' });
    expect(writeRoute('/api/v1/Invoices', 'POST')).toMatchObject({ entity: null });
    expect(writeRoute('/api/v1/Contracts/3/Charges', 'POST')).toMatchObject({ entity: null }); // financial: MCP tools only
    expect(writeRoute('/api/v1/TimeEntries', 'GET')).toBeNull();
  });

  test('a read-only key cannot write; nothing is sent', async () => {
    const s = setup();
    current = s.deps;
    const r = await call('/api/v1/TimeEntries', { body: entry });
    expect(r.status).toBe(403);
    expect((await json(r)).error).toMatch(/read-only/);
    expect(s.upstream).toEqual([]);
    expect(s.claims).toEqual([]);
  });

  test('create: the body goes to Autotask as given, the answer comes back, the write is logged', async () => {
    const s = setup({ key: W });
    current = s.deps;
    const r = await call('/api/v1/TimeEntries', { body: entry, headers: { 'Idempotency-Key': 'tm-8812' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-psarelay-source')).toBe('live');
    expect(await json(r)).toEqual({ itemId: 900 });
    expect(s.upstream).toEqual([{ method: 'POST', path: '/TimeEntries', body: entry }]);
    expect(s.claims).toEqual([{ keyId: 7, method: 'POST', path: '/TimeEntries', entity: 'TimeEntries', recordId: null, idempotencyKey: 'tm-8812' }]);
    expect(s.writes).toEqual([expect.objectContaining({ id: 41, status: 'ok', httpStatus: 200, recordId: 900 })]);
    expect(s.keys.current(7)).toMatchObject({ writes: 1 });
  });

  test('update: PATCH needs the id and sends only the given fields; PUT is refused', async () => {
    const s = setup({ key: W });
    current = s.deps;
    expect((await call('/api/v1/TimeEntries', { method: 'PATCH', body: { summaryNotes: 'x' } })).status).toBe(400);
    expect((await call('/api/v1/TimeEntries', { method: 'PATCH', body: { id: 5 } })).status).toBe(400);
    expect((await call('/api/v1/TimeEntries', { method: 'PUT', body: { id: 5, summaryNotes: 'x' } })).status).toBe(405);
    expect((await call('/api/v1/TimeEntries', { body: { id: 5, summaryNotes: 'x' } })).status).toBe(400); // a create with an id
    expect(s.upstream).toEqual([]);
    const r = await call('/api/v1/TimeEntries', { method: 'PATCH', body: { id: 5, summaryNotes: 'x' } });
    expect(r.status).toBe(200);
    expect(s.upstream).toEqual([{ method: 'PATCH', path: '/TimeEntries', body: { id: 5, summaryNotes: 'x' } }]);
  });

  test('child URL: a note on a ticket needs TicketNotes', async () => {
    const s = setup({ key: { writeEntities: ['TimeEntries'] } });
    current = s.deps;
    expect((await call('/api/v1/Tickets/12/Notes', { body: { title: 't', description: 'd' } })).status).toBe(403);
    expect(s.upstream).toEqual([]);
    const t = setup({ key: W });
    current = t.deps;
    expect((await call('/api/v1/tickets/12/notes', { body: { title: 't', description: 'd' } })).status).toBe(200);
    expect(t.upstream).toEqual([{ method: 'POST', path: '/Tickets/12/Notes', body: { title: 't', description: 'd' } }]);
  });

  test('delete only when the key allows it', async () => {
    const s = setup({ key: W });
    current = s.deps;
    expect((await call('/api/v1/TimeEntries/12', { method: 'DELETE' })).status).toBe(403);
    expect(s.upstream).toEqual([]);
    const t = setup({ key: { ...W, allowDelete: true } });
    current = t.deps;
    const r = await call('/api/v1/TimeEntries/12', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ itemId: 12 });
    expect(t.upstream).toEqual([{ method: 'DELETE', path: '/TimeEntries/12', body: undefined }]);
  });

  test('entities outside the writable list are refused, financial ones included', async () => {
    const s = setup({ key: W });
    current = s.deps;
    expect((await call('/api/v1/Invoices', { body: { x: 1 } })).status).toBe(403);
    expect((await call('/api/v1/Tickets', { body: { title: 'x' } })).status).toBe(403); // writable, not by this key
    expect(s.upstream).toEqual([]);
  });

  test('backpressure "stop" and the hourly write cap stop a write before it is sent', async () => {
    const s = setup({ key: W, pressure: 'stop' });
    current = s.deps;
    const r = await call('/api/v1/TimeEntries', { body: entry });
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('120');
    const t = setup({ key: W });
    current = t.deps;
    for (let i = 0; i < 3; i++) expect((await call('/api/v1/TimeEntries', { body: entry })).status).toBe(200);
    const capped = await call('/api/v1/TimeEntries', { body: entry });
    expect(capped.status).toBe(429);
    expect(t.upstream).toHaveLength(3);
    expect(s.upstream).toEqual([]);
  });

  test('Idempotency-Key: a finished write is replayed, a running or unclear one is not sent again', async () => {
    const s = setup({ key: W, claim: { kind: 'replay', httpStatus: 200, response: { itemId: 77 } } });
    current = s.deps;
    const r = await call('/api/v1/TimeEntries', { body: entry, headers: { 'Idempotency-Key': 'tm-1' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-psarelay-source')).toBe('replay');
    expect(await json(r)).toEqual({ itemId: 77 });
    expect(s.upstream).toEqual([]);
    for (const claim of [{ kind: 'busy' }, { kind: 'unknown' }] as WriteClaim[]) {
      const t = setup({ key: W, claim });
      current = t.deps;
      expect((await call('/api/v1/TimeEntries', { body: entry, headers: { 'Idempotency-Key': 'tm-1' } })).status).toBe(409);
      expect(t.upstream).toEqual([]);
    }
    expect((await call('/api/v1/TimeEntries', { body: entry, headers: { 'Idempotency-Key': 'has space' } })).status).toBe(400);
  });

  test('Autotask refuses → 502 "not_written" (retryable); no answer → "unknown" (check first)', async () => {
    const refused = Object.assign(new Error('Autotask POST /TimeEntries failed: HTTP 500: Ticket is closed'), { status: 500 });
    const s = setup({ key: W, writeError: refused });
    current = s.deps;
    const r = await call('/api/v1/TimeEntries', { body: entry });
    expect(r.status).toBe(502);
    expect(await json(r)).toMatchObject({ outcome: 'not_written', autotaskStatus: 500 });
    expect(s.writes).toEqual([expect.objectContaining({ status: 'failed' })]);
    const t = setup({ key: W, writeError: new Error('Autotask POST /TimeEntries network error: timeout') });
    current = t.deps;
    const u = await call('/api/v1/TimeEntries', { body: entry });
    expect(u.status).toBe(502);
    expect(await json(u)).toMatchObject({ outcome: 'unknown' });
    expect(t.writes).toEqual([expect.objectContaining({ status: 'unknown' })]);
  });

  test('the read-only switch / a read-only plan stops API writes too', async () => {
    const s = setup({ key: W });
    current = { ...s.deps, writeLock: () => 'PSArelay is read-only.' };
    const r = await call('/api/v1/TimeEntries', { body: entry });
    expect(r.status).toBe(503);
    expect((await json(r)).error).toMatch(/Writes are off/);
    expect(s.upstream).toEqual([]);
    expect(s.claims).toEqual([]);
    expect((await call('/api/v1/TimeEntries/query', { body: {} })).status).toBe(200); // reads unaffected
  });

  test('info shows what the key may write', async () => {
    const s = setup({ key: { ...W, allowDelete: true } });
    current = s.deps;
    const b = await json(await call('/api/v1'));
    expect(b.key.write).toEqual({ entities: ['TicketNotes', 'TimeEntries'], allowDelete: true, hourlyLimit: 3 });
  });

  test('policy: write entities normalised, non-writable refused, delete needs writes, write-only keys allowed', () => {
    const p = coercePolicy({ entities: [], writeEntities: ['timeentries', 'TimeEntries'], allowDelete: true });
    expect(p).toMatchObject({ entities: [], writeEntities: ['TimeEntries'], allowDelete: true, writeHourlyLimit: 200 });
    expect(() => coercePolicy({ entities: ['Companies'], writeEntities: ['Invoices'] })).toThrow(/can't be written/);
    expect(coercePolicy({ entities: ['Companies'], allowDelete: true }).allowDelete).toBe(false);
    expect(() => coercePolicy({ entities: [], writeEntities: [] })).toThrow(/at least one/);
    // an existing read-only key keeps its writes off when edited without them
    const base = coercePolicy({ entities: ['Companies'] });
    expect(coercePolicy({ hourlyLimit: 10 }, base)).toMatchObject({ writeEntities: [], allowDelete: false });
  });
});
