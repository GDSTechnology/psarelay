// Idempotency for mutating tools (Expansion Spec §4.4, issue #14).
// A repeated logical action replays the prior result instead of mutating twice.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import {
  InMemoryIdempotencyStore,
  deriveIdempotencyKey,
  stableStringify,
} from '../src/utils/idempotency';
import type { CallerContext } from '../src/types/context';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' },
};

const baseCtx = (over: Partial<CallerContext> = {}): CallerContext => ({
  source: 'hermes-teams',
  correlationId: 'c1',
  timestamp: new Date().toISOString(),
  ...over,
});

describe('idempotency key derivation', () => {
  test('caller-supplied idempotencyKey wins', () => {
    const key = deriveIdempotencyKey(baseCtx({ idempotencyKey: 'abc' }), 'autotask_create_ticket', { title: 'x' });
    expect(key).toBe('k:abc');
  });

  test('no key without a conversation context', () => {
    const key = deriveIdempotencyKey(baseCtx(), 'autotask_create_ticket', { title: 'x' });
    expect(key).toBeUndefined();
  });

  test('derived key is stable across payload key order', () => {
    const ctx = baseCtx({ conversationId: 'conv-1', autotaskResourceId: 5 });
    const a = deriveIdempotencyKey(ctx, 'autotask_create_ticket', { title: 'x', companyID: 1 });
    const b = deriveIdempotencyKey(ctx, 'autotask_create_ticket', { companyID: 1, title: 'x' });
    expect(a).toBe(b);
  });

  test('derived key changes with payload, tool, and conversation', () => {
    const ctx = baseCtx({ conversationId: 'conv-1', autotaskResourceId: 5 });
    const base = deriveIdempotencyKey(ctx, 'autotask_create_ticket', { title: 'x' });
    expect(deriveIdempotencyKey(ctx, 'autotask_create_ticket', { title: 'y' })).not.toBe(base);
    expect(deriveIdempotencyKey(ctx, 'autotask_create_note', { title: 'x' })).not.toBe(base);
    expect(deriveIdempotencyKey(baseCtx({ conversationId: 'conv-2', autotaskResourceId: 5 }), 'autotask_create_ticket', { title: 'x' })).not.toBe(base);
  });

  test('stableStringify sorts keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe('InMemoryIdempotencyStore', () => {
  test('get returns the stored result; miss returns undefined', () => {
    const store = new InMemoryIdempotencyStore<{ v: number }>();
    store.set('k', { v: 1 });
    expect(store.get('k')).toEqual({ v: 1 });
    expect(store.get('nope')).toBeUndefined();
  });

  test('TTL expiry evicts', () => {
    const store = new InMemoryIdempotencyStore<{ v: number }>(1000, -1); // already-expired ttl
    store.set('k', { v: 1 });
    expect(store.get('k')).toBeUndefined();
  });

  test('capacity eviction drops the oldest', () => {
    const store = new InMemoryIdempotencyStore<{ v: number }>(2);
    store.set('a', { v: 1 });
    store.set('b', { v: 2 });
    store.set('c', { v: 3 }); // evicts 'a'
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toEqual({ v: 2 });
    expect(store.get('c')).toEqual({ v: 3 });
  });
});

describe('idempotency in callTool', () => {
  const META = { source: 'hermes-teams', requestingUserEmail: 'jf@gds.com', conversationId: 'conv-42' };

  test('repeat mutation with a conversation context replays without re-calling the service', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'createTimeEntry').mockResolvedValue(700 as any);
    const handler = new AutotaskToolHandler(service, logger);
    const args = { ticketID: 204722, resourceID: 5, hoursWorked: 0.1, dateWorked: '2026-08-26', summaryNotes: 'work' };

    const first = await handler.callTool('autotask_create_time_entry', { ...args }, META);
    const second = await handler.callTool('autotask_create_time_entry', { ...args }, META);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  test('no dedup without a conversation context (both calls run)', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'createTimeEntry').mockResolvedValue(700 as any);
    const handler = new AutotaskToolHandler(service, logger);
    const args = { ticketID: 204722, resourceID: 5, hoursWorked: 0.1, dateWorked: '2026-08-26', summaryNotes: 'work' };

    await handler.callTool('autotask_create_time_entry', { ...args }, { source: 'hermes-teams' });
    await handler.callTool('autotask_create_time_entry', { ...args }, { source: 'hermes-teams' });

    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('caller-supplied idempotencyKey dedups even without a conversation', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'createTimeEntry').mockResolvedValue(700 as any);
    const handler = new AutotaskToolHandler(service, logger);
    const args = { ticketID: 204722, resourceID: 5, hoursWorked: 0.1, dateWorked: '2026-08-26', summaryNotes: 'work' };

    await handler.callTool('autotask_create_time_entry', { ...args }, { source: 'telegram', idempotencyKey: 'once' });
    await handler.callTool('autotask_create_time_entry', { ...args }, { source: 'telegram', idempotencyKey: 'once' });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('read-only tools are never deduped', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'getContract').mockResolvedValue({ id: 55 } as any);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool('autotask_get_contract', { id: 55 }, META);
    await handler.callTool('autotask_get_contract', { id: 55 }, META);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
