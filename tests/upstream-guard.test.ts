// Spec §24 upstream guard: tenant / per-caller concurrency caps, jittered retry of transient
// READ failures (never writes, never HTTP 500), and the outage breaker.

import { AutotaskHttpClient, _resetRateLimitCooldowns } from '../src/services/autotask-http';
import {
  AutotaskOutageError, _resetUpstreamGuard, acquireUpstream, backoffMs, checkBreaker, isTransient,
  endpointOutages, endpointOutageSeconds, outageSeconds, recordSuccess, recordTransientFailure, upstreamQueueDepth,
} from '../src/services/upstream-guard';
import { assessBackpressure } from '../src/services/backpressure';
import { Logger } from '../src/utils/logger';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const client = () => new AutotaskHttpClient('user@example.com', 'secret', 'ic', 'https://webservices2.autotask.net/ATServicesRest/', logger);
const res = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
}) as unknown as Response;

beforeEach(() => {
  process.env.AUTOTASK_READ_RETRIES = '2'; process.env.AUTOTASK_OUTAGE_FAILURES = '5'; // setup.ts turns them off
  _resetUpstreamGuard(); _resetRateLimitCooldowns(); _resetZoneUrlCache();
  jest.spyOn(Math, 'random').mockReturnValue(0); // backoff waits 0 ms
});
afterEach(() => { jest.restoreAllMocks(); process.env.AUTOTASK_READ_RETRIES = '0'; process.env.AUTOTASK_OUTAGE_FAILURES = '100'; delete process.env.MCP_MAX_CONCURRENT_PER_CALLER; delete process.env.AUTOTASK_MAX_CONCURRENT_TOTAL; });

describe('classifier and backoff', () => {
  test('transient: network flag, 502/503/504 — never 500, 404, 429, nor a truncated body', () => {
    expect(isTransient(Object.assign(new Error('x'), { transient: true }))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { name: 'AutotaskResponseError' }))).toBe(false);
    for (const s of [502, 503, 504]) expect(isTransient(Object.assign(new Error('x'), { status: s }))).toBe(true);
    for (const s of [500, 404, 429, 401]) expect(isTransient(Object.assign(new Error('x'), { status: s }))).toBe(false);
  });
  test('full jitter, capped', () => {
    expect(backoffMs(0, () => 0.999)).toBe(499);
    expect(backoffMs(10, () => 0.999)).toBe(3996);
    expect(backoffMs(3, () => 0)).toBe(0);
  });
});

describe('retry', () => {
  test('a read that hits 503 then succeeds is retried and answers', async () => {
    const f = jest.spyOn(global, 'fetch' as any)
      .mockResolvedValueOnce(res(503, { errors: ['busy'] }) as any)
      .mockResolvedValueOnce(res(200, { item: { id: 1 } }) as any);
    expect(await client().get('Tickets', 1)).toEqual({ id: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  test('a network error on a read is retried; gives up after 2 retries', async () => {
    const f = jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('ECONNRESET'));
    await expect(client().get('Tickets', 2)).rejects.toThrow('network error');
    expect(f).toHaveBeenCalledTimes(3);
  });

  test('HTTP 500 (Autotask validation errors) is never retried', async () => {
    const f = jest.spyOn(global, 'fetch' as any).mockResolvedValue(res(500, { errors: ['Unable to find contactID'] }) as any);
    await expect(client().get('Projects', 3)).rejects.toThrow('HTTP 500');
    expect(f).toHaveBeenCalledTimes(1);
  });

  test('a WRITE that hits 503 is never retried (it may have landed)', async () => {
    const f = jest.spyOn(global, 'fetch' as any).mockResolvedValue(res(503, { errors: ['busy'] }) as any);
    await expect(client().update('Tickets', 4, { title: 'x' })).rejects.toThrow('HTTP 503');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('outage breaker', () => {
  test('5 transient failures in a minute on ONE module open its breaker only; the rest carries on', async () => {
    const t = 'user@example.com';
    const T0 = Date.now();
    for (let i = 0; i < 4; i++) recordTransientFailure(t, 'Quotes', 'HTTP 503', T0 + i);
    expect(endpointOutageSeconds(t, 'Quotes', T0 + 10)).toBe(0);
    recordTransientFailure(t, 'Quotes', 'HTTP 503', T0 + 5);
    expect(endpointOutageSeconds(t, 'Quotes', T0 + 10)).toBe(30);
    expect(outageSeconds(t, T0 + 10)).toBe(0); // the tenant is NOT down
    expect(endpointOutages(t, T0 + 10)).toEqual([{ endpoint: 'Quotes', seconds: 30 }]);
    expect(() => checkBreaker(t, 'Quotes', T0 + 1000)).toThrow(/Quotes endpoint.*Other Autotask modules are not affected/);
    expect(() => checkBreaker(t, 'Tickets', T0 + 1000)).not.toThrow();

    const f = jest.spyOn(global, 'fetch' as any).mockResolvedValue(res(200, { item: { id: 5 } }) as any);
    await expect(client().get('Quotes', 5)).rejects.toThrow('NOT sent');
    expect(f).not.toHaveBeenCalled();
    expect(await client().get('Tickets', 5)).toEqual({ id: 5 }); // another module is served
    expect(f).toHaveBeenCalledTimes(1);

    // After the window: the probe goes through, succeeds, and the breaker closes.
    checkBreaker(t, 'Quotes', T0 + 5 + 31_000);
    expect(() => checkBreaker(t, 'Quotes', T0 + 5 + 31_001)).toThrow(AutotaskOutageError); // only ONE probe at a time
    recordSuccess(t, 'Quotes');
    expect(() => checkBreaker(t, 'Quotes', T0 + 5 + 31_002)).not.toThrow();
  });

  test('failures across 3+ modules open the TENANT-wide breaker', () => {
    const t = 'y';
    for (let i = 0; i < 5; i++) recordTransientFailure(t, ['Tickets', 'Companies', 'Contacts'][i % 3]!, 'ECONNREFUSED', i);
    expect(outageSeconds(t, 10)).toBe(30);
    expect(() => checkBreaker(t, 'Quotes', 10)).toThrow(/^Autotask looks unavailable/);
  });

  test('5 failures on 2 modules: each counts on its own, the tenant stays up', () => {
    const t = 'z';
    for (let i = 0; i < 5; i++) recordTransientFailure(t, i % 2 ? 'Quotes' : 'Opportunities', 'HTTP 504', i);
    expect(outageSeconds(t, 10)).toBe(0);
    expect(endpointOutageSeconds(t, 'Quotes', 10)).toBe(0); // 2 of 5 on Quotes
  });

  test('a failed probe opens it again, twice as long', () => {
    const t = 'x';
    for (let i = 0; i < 5; i++) recordTransientFailure(t, 'Opportunities', 'net', 0);
    checkBreaker(t, 'Opportunities', 31_000); // probe
    recordTransientFailure(t, 'Opportunities', 'net', 31_000);
    expect(endpointOutageSeconds(t, 'Opportunities', 31_000)).toBe(60);
  });

  test('backpressure: a module outage is slow and named, not stop', () => {
    const b = assessBackpressure({ usage: null, auth: null, cooldownSeconds: 0, queued: 0, moduleOutages: [{ endpoint: 'Quotes', seconds: 20 }] });
    expect(b.level).toBe('slow');
    expect(b.reasons.join(' ')).toContain('Quotes (20s)');
    expect(b.moduleOutages).toEqual([{ endpoint: 'Quotes', seconds: 20 }]);
  });

  test('backpressure says stop while the tenant breaker is open', () => {
    const b = assessBackpressure({ usage: null, auth: null, cooldownSeconds: 0, queued: 0, outageSeconds: 25 });
    expect(b.level).toBe('stop');
    expect(b.retryAfterSeconds).toBe(25);
    expect(b.reasons.join(' ')).toContain('unavailable');
  });
});

describe('concurrency caps', () => {
  test('a caller beyond its cap queues (does not fail); another caller is not held up', async () => {
    process.env.MCP_MAX_CONCURRENT_PER_CALLER = '2';
    const a1 = await acquireUpstream('t', 'chatgpt|pat');
    const a2 = await acquireUpstream('t', 'chatgpt|pat');
    let third = false;
    const p = acquireUpstream('t', 'chatgpt|pat').then((r) => { third = true; return r; });
    const other = await acquireUpstream('t', 'n8n|');
    await Promise.resolve();
    expect(third).toBe(false);
    expect(upstreamQueueDepth()).toBe(1);
    a1();
    (await p)();
    expect(third).toBe(true);
    a2(); other();
  });

  test('the tenant cap holds every caller, background work included', async () => {
    process.env.AUTOTASK_MAX_CONCURRENT_TOTAL = '1';
    const a = await acquireUpstream('t', null);
    let got = false;
    const p = acquireUpstream('t', 'chatgpt|pat').then((r) => { got = true; return r; });
    await Promise.resolve();
    expect(got).toBe(false);
    a();
    (await p)();
    expect(got).toBe(true);
  });
});
