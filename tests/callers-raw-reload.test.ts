// (1) raw_request reads are offered to the Postgres shadow (n8n queries tickets
// through raw_request every 5 minutes); (2) "Caller names" rules label clients
// that don't declare a source; (3) the console tells an open tab when a new
// version was deployed and versions its script URLs.

import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { AutotaskHttpClient, setReadInterceptor, _resetRateLimitCooldowns } from '../src/services/autotask-http';
import { runToolCall, noteToolAudit, recentToolCalls, callerName, _resetCallLog } from '../src/services/call-log';
import { coerceSetting, setOverride, _resetSettings } from '../src/admin/settings';
import { adminHandler } from '../src/admin/server';
import type { AdminStore } from '../src/admin/store';
import { Logger } from '../src/utils/logger';

const logger = new Logger('error');
const realFetch = global.fetch;
afterEach(() => { setReadInterceptor(null); _resetSettings(); _resetCallLog(); jest.restoreAllMocks(); });

describe('raw_request reads through the shadow', () => {
  const upstream = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ items: [{ id: 99 }], pageDetails: { nextPageUrl: 'x' } }) }));
  const client = () => new AutotaskHttpClient('api@example.com', 's', 'ic', 'https://webservices3.autotask.net/ATServicesRest/', logger);
  beforeEach(() => { _resetRateLimitCooldowns(); upstream.mockClear(); global.fetch = upstream as unknown as typeof fetch; });

  test('POST /Entity/query answered from the shadow when it holds the whole page; shaped like Autotask', async () => {
    const query = jest.fn(async () => [{ id: 1, status: 1, title: 'a' }, { id: 2, status: 1, title: 'b' }]);
    setReadInterceptor({ query, get: async () => undefined });
    const r = await client().rawRequest('POST', '/Tickets/query', { MaxRecords: 50, IncludeFields: ['title'], filter: [{ op: 'eq', field: 'status', value: 1 }] });
    expect(r).toEqual({ items: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }], pageDetails: { count: 2, requestCount: 50, prevPageUrl: null, nextPageUrl: null } });
    expect(query).toHaveBeenCalledWith('api@example.com', 'Tickets', [{ op: 'eq', field: 'status', value: 1 }], 51); // one extra row: is there more?
    expect(upstream).not.toHaveBeenCalled();
  });

  test('more rows than the page → live (the caller needs the real nextPageUrl); writes, query params and unmatched paths → live', async () => {
    setReadInterceptor({ query: async (_t, _e, _f, limit) => Array.from({ length: limit }, (_, i) => ({ id: i + 1 })), get: async () => undefined });
    const c = client();
    expect(await c.rawRequest('POST', '/Tickets/query', { MaxRecords: 2, filter: [] })).toEqual({ items: [{ id: 99 }], pageDetails: { nextPageUrl: 'x' } });
    await c.rawRequest('PATCH', '/Tickets', { id: 1, status: 5 });
    await c.rawRequest('GET', '/Tickets/5', undefined, { includeFields: 'id' });
    await c.rawRequest('POST', '/Tickets/query/count', { filter: [] });
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  test('GET /Entity/{id} answered from the shadow as { item }', async () => {
    setReadInterceptor({ query: async () => null, get: async (_t, e, id) => (e === 'Tickets' && id === 5 ? { id: 5, title: 'x' } : undefined) });
    expect(await client().rawRequest('GET', '/Tickets/5')).toEqual({ item: { id: 5, title: 'x' } });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('caller names', () => {
  test('rules validate as pattern=name lines', () => {
    expect(coerceSetting('callers.labels', '172.19.0.3=n8n\n\nPython-urllib=cron')).toEqual(['172.19.0.3=n8n', 'Python-urllib=cron']);
    expect(() => coerceSetting('callers.labels', ['n8n'])).toThrow(/pattern=name/);
  });

  test('undeclared clients are named by IP or user agent; a declared source wins', async () => {
    setOverride('callers.labels', ['172.19.0.3=n8n', 'python-urllib=cron', 'Go-http-client=ChatGPT']);
    expect(callerName('172.19.0.3', 'n8n')).toBe('n8n');
    expect(callerName('172.19.0.1', 'Python-urllib/3.11')).toBe('cron');
    expect(callerName('10.0.0.1', 'curl')).toBeNull();
    await runToolCall('autotask_get_my_day', async () => { noteToolAudit({ outcome: 'ok', durationMs: 1, source: 'unknown', ip: '172.19.0.1', userAgent: 'Go-http-client/1.1' }); return {}; });
    await runToolCall('autotask_x', async () => { noteToolAudit({ outcome: 'ok', durationMs: 1, source: 'chatgpt', ip: '172.19.0.3', userAgent: 'n8n' }); return {}; });
    await runToolCall('autotask_y', async () => { noteToolAudit({ outcome: 'ok', durationMs: 1, source: 'unknown', ip: '10.9.9.9', userAgent: 'curl' }); return {}; });
    const [y, x, day] = recentToolCalls();
    expect(day).toMatchObject({ source: 'ChatGPT', named: true });
    expect(x).toMatchObject({ source: 'chatgpt' });
    expect(x!.named).toBeUndefined();
    expect(y).toMatchObject({ source: 'unknown' });
  });
});

describe('console version', () => {
  let server: Server, base: string;
  beforeAll(async () => {
    global.fetch = realFetch;
    const store = { sessionUser: async () => null } as unknown as AdminStore;
    const handler = adminHandler({ store, pool: null, startedAt: Date.now(), opts: { logger, service: {} as any, version: '3.59.0', env: { MCP_ADMIN_UI_DIR: resolve(__dirname, '..', 'admin-ui') } } });
    server = createServer((q, r) => { void handler(q, r); });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  test('the page carries its version and versioned asset URLs; API answers carry the server version', async () => {
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('<meta name="psarelay-version" content="3.59.0">');
    expect(html).toContain('src="/app.js?v=3.59.0"');
    expect(html).toContain('href="/app.css?v=3.59.0"');
    expect((await fetch(base + '/app.js?v=3.59.0')).status).toBe(200);
    expect((await fetch(base + '/api/me')).headers.get('x-psarelay-version')).toBe('3.59.0');
  });
});
