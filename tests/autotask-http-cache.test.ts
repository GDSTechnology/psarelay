// Autotask read cache, request coalescing and upstream metrics (2026-09-30:
// a shared API user tripped HTTP 429; much traffic re-pulled the same data).
// Driven through the real AutotaskHttpClient against a mocked fetch.

import { AutotaskHttpClient, _resetRateLimitCooldowns } from '../src/services/autotask-http';
import { classify, entityOf, isCacheableValue, isRead, usageSnapshot, _resetHttpCache } from '../src/services/http-cache';
import { runWithRequestContext } from '../src/utils/request-context';
import { Logger } from '../src/utils/logger';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const USER = 'user@example.com';
const client = () => new AutotaskHttpClient(USER, 'secret', 'ic', 'https://webservices3.autotask.net/ATServicesRest/', logger);
const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }) as unknown as Response;
const calls = () => (global.fetch as jest.Mock).mock.calls.map((c) => `${(c[1] as RequestInit).method} ${String(c[0]).replace(/^.*\/v1\.0/, '')}`);

beforeEach(() => {
  _resetHttpCache(); _resetRateLimitCooldowns(); _resetZoneUrlCache();
  delete process.env.AUTOTASK_CACHE; delete process.env.AUTOTASK_CACHE_TTL_VOLATILE_SECONDS;
  global.fetch = jest.fn() as unknown as typeof fetch;
});
afterEach(() => jest.restoreAllMocks());

describe('classification', () => {
  test.each([
    ['/Tickets/123', 'Tickets', 'volatile'],
    ['/Tickets/123/Notes/query', 'Tickets', 'volatile'],
    ['/Resources/query', 'Resources', 'reference'],
    ['/Roles/query', 'Roles', 'reference'],
    ['/Companies/query', 'Companies', 'slow-reference'],
    ['/TimeEntries/entityInformation/fields', 'TimeEntries', 'fields'],
    ['/ThresholdInformation', 'ThresholdInformation', 'never'],
    ['https://webservices3.autotask.net/ATServicesRest/v1.0/Tickets/query/next?paging=abc', 'Tickets', 'volatile'],
  ])('%s → %s / %s', (path, entity, cls) => {
    expect(entityOf(path)).toBe(entity);
    expect(classify(path)).toBe(cls);
  });
  test('reads vs writes: continuation pages are reads', () => {
    expect(isRead('GET', '/Tickets/1')).toBe(true);
    expect(isRead('POST', '/Tickets/query')).toBe(true);
    expect(isRead('POST', 'https://x/v1.0/Tickets/query/next?paging=abc')).toBe(true);
    expect(isRead('POST', '/Tickets')).toBe(false);
    expect(isRead('PATCH', '/Tickets')).toBe(false);
  });
  test('misses and empty results are never cacheable', () => {
    expect(isCacheableValue({ item: null })).toBe(false);
    expect(isCacheableValue({ items: [] })).toBe(false);
    expect(isCacheableValue({ item: { id: 1 } })).toBe(true);
    expect(isCacheableValue({ items: [{ id: 1 }] })).toBe(true);
    expect(isCacheableValue({ fields: [] })).toBe(true);
  });
});

describe('AutotaskHttpClient read cache', () => {
  test('a repeated read is served from cache (one upstream call) and counted', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(ok({ item: { id: 208520, title: 'x' } }));
    const c = client();
    expect(await c.get('Tickets', 208520)).toEqual({ id: 208520, title: 'x' });
    expect(await c.get('Tickets', 208520)).toEqual({ id: 208520, title: 'x' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const u = usageSnapshot(USER);
    expect(u).toEqual(expect.objectContaining({ upstreamCalls: 1, cacheHits: 1, coalesced: 0, savedPct: 50 }));
    expect(u.topUpstream).toEqual([{ call: 'GET Tickets', count: 1 }]);
  });

  test('identical reads in flight share ONE upstream call', async () => {
    let release!: () => void;
    (global.fetch as jest.Mock).mockImplementation(() => new Promise<Response>((r) => { release = () => r(ok({ items: [{ id: 1 }] })); }));
    const c = client();
    const all = Promise.all([0, 1, 2].map(() => c.query('Roles', [{ op: 'eq', field: 'isActive', value: true }])));
    await new Promise((r) => setImmediate(r));
    release();
    expect((await all).map((x) => x.length)).toEqual([1, 1, 1]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(usageSnapshot(USER).coalesced).toBe(2);
  });

  test('callers can mutate results without corrupting the cache or each other', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(ok({ item: { id: 1, title: 'orig' } }));
    const c = client();
    const a = await c.get<Record<string, unknown>>('Tickets', 1);
    a!._card = { injected: true };
    a!.title = 'mutated';
    expect(await c.get('Tickets', 1)).toEqual({ id: 1, title: 'orig' });
  });

  test('"not found" and empty results are NOT cached (read-after-write retries stay live)', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(ok({ item: null }))
      .mockResolvedValueOnce(ok({ item: { id: 5 } }))
      .mockResolvedValueOnce(ok({ items: [] }))
      .mockResolvedValueOnce(ok({ items: [{ id: 9 }] }));
    const c = client();
    expect(await c.get('Tickets', 5)).toBeNull();
    expect(await c.get('Tickets', 5)).toEqual({ id: 5 });
    expect(await c.query('TimeEntries', [{ op: 'eq', field: 'ticketID', value: 5 }])).toEqual([]);
    expect(await c.query('TimeEntries', [{ op: 'eq', field: 'ticketID', value: 5 }])).toEqual([{ id: 9 }]);
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  test('a write clears short-lived entries and the written entity, but keeps unrelated reference data', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'POST' && /\/TimeEntries$/.test(url)) return ok({ itemId: 77 });
      if (/Resources/.test(url)) return ok({ items: [{ id: 1, firstName: 'A' }] });
      return ok({ items: [{ id: 2 }] });
    });
    const c = client();
    await c.query('TimeEntries', [{ op: 'eq', field: 'ticketID', value: 5 }]);
    await c.query('Resources', [{ op: 'in', field: 'id', value: [1] }]);
    await c.create('TimeEntries', { ticketID: 5 });
    await c.query('TimeEntries', [{ op: 'eq', field: 'ticketID', value: 5 }]); // refetched
    await c.query('Resources', [{ op: 'in', field: 'id', value: [1] }]); // still cached
    expect(calls()).toEqual(['POST /TimeEntries/query', 'POST /Resources/query', 'POST /TimeEntries', 'POST /TimeEntries/query']);
  });

  test('cache keys are separate per impersonated identity', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(ok({ item: { id: 1 } }));
    const c = client();
    await runWithRequestContext({ impersonationResourceId: 11 } as never, () => c.get('Tickets', 1));
    await runWithRequestContext({ impersonationResourceId: 22 } as never, () => c.get('Tickets', 1));
    await runWithRequestContext({ impersonationResourceId: 11 } as never, () => c.get('Tickets', 1));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('short-lived entries expire after their TTL', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(ok({ item: { id: 1 } }));
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    const c = client();
    await c.get('Tickets', 1);
    now.mockReturnValue(1_000_000 + 29_000);
    await c.get('Tickets', 1);
    now.mockReturnValue(1_000_000 + 31_000);
    await c.get('Tickets', 1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('AUTOTASK_CACHE=off disables caching (coalescing still applies)', async () => {
    process.env.AUTOTASK_CACHE = 'off';
    (global.fetch as jest.Mock).mockResolvedValue(ok({ item: { id: 1 } }));
    const c = client();
    await c.get('Tickets', 1);
    await c.get('Tickets', 1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(usageSnapshot(USER).cacheEnabled).toBe(false);
  });

  test('ThresholdInformation is always live', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(ok({ externalRequestThreshold: 10000, currentTimeframeRequestCount: 2115, requestThresholdTimeframe: 60 }));
    const c = client();
    await c.thresholdInformation();
    await c.thresholdInformation();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('autotask_get_api_usage', () => {
  test('reports Autotask\'s live counter and this server\'s view', async () => {
    const { AutotaskService } = require('../src/services/autotask.service');
    const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
    (global.fetch as jest.Mock).mockResolvedValue(ok({ externalRequestThreshold: 10000, currentTimeframeRequestCount: 2115, requestThresholdTimeframe: 60 }));
    const s = new AutotaskService({ name: 't', version: '0', autotask: { username: USER, secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices3.autotask.net/ATServicesRest/' } }, logger);
    const res = await new AutotaskToolHandler(s, logger).callTool('autotask_get_api_usage', {});
    const b = JSON.parse(res.content[0].text);
    expect(b.data.autotask).toEqual({ used: 2115, limit: 10000, windowMinutes: 60, usedPct: 21.2 });
    expect(b.message).toMatch(/Autotask: 2115 of 10000 requests used in the current 60-minute window/);
    expect(b.data.server.topUpstream).toEqual([{ call: 'GET ThresholdInformation', count: 1 }]);
  });
});
