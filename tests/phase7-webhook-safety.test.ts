// Webhook secret from the host env (never in chat, never echoed) and automatic
// loop prevention (exclude this MCP's own API user). 2026-10-01: ChatGPT will
// create Autotask webhooks bound to n8n flows; the MCP and the ticket-writing
// automation share one API user, so without the exclusion every MCP write
// would re-fire the webhook into n8n.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import { buildExclusions, envExcludedResourceIDs, maskSecret, resolveWebhookSecret, secretErrors, secretWarnings } from '../src/utils/webhook-safety';
import type { McpServerConfig } from '../src/types/mcp';

const SECRET = 'n8n-shared-secret-0123456789';
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'g6qb4ubr4c4vj72@gdstech.tech', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices3.autotask.net/ATServicesRest/' } };
const logger = new Logger('error');
const base = { name: 'Ticket flow', webhookUrl: 'https://n8n.example/webhook/tickets', deactivationUrl: 'https://n8n.example/webhook/off', subscribeUpdate: true };

beforeEach(() => { delete process.env.AUTOTASK_WEBHOOK_SECRET; delete process.env.AUTOTASK_WEBHOOK_EXCLUDE_RESOURCE_IDS; });

describe('webhook-safety helpers', () => {
  test('secret: argument wins, else env, else none', () => {
    expect(resolveWebhookSecret('  arg-secret-123  ')).toEqual({ secret: 'arg-secret-123', source: 'argument' });
    process.env.AUTOTASK_WEBHOOK_SECRET = SECRET;
    expect(resolveWebhookSecret(undefined)).toEqual({ secret: SECRET, source: 'env' });
    delete process.env.AUTOTASK_WEBHOOK_SECRET;
    expect(resolveWebhookSecret('')).toEqual({ secret: null, source: null });
  });
  test('Autotask limits: >64 is an error, <10 only a warning', () => {
    expect(secretErrors(null)[0]).toMatch(/AUTOTASK_WEBHOOK_SECRET/);
    expect(secretErrors('x'.repeat(65))[0]).toMatch(/at most 64/);
    expect(secretErrors('x'.repeat(64))).toEqual([]);
    expect(secretWarnings('short')[0]).toMatch(/recommends at least 10/);
    expect(secretWarnings(SECRET)).toEqual([]);
  });
  test('mask replaces only secretKey', () => {
    expect(maskSecret({ name: 'W', secretKey: SECRET }, 'env')).toEqual({ name: 'W', secretKey: '<from AUTOTASK_WEBHOOK_SECRET>' });
    expect(maskSecret({ name: 'W', secretKey: SECRET }, 'argument').secretKey).toBe('<provided — hidden>');
    expect(maskSecret({ name: 'W' }, null)).toEqual({ name: 'W' });
  });
  test('exclusions: requested + self + env, deduped, each with its reason', () => {
    process.env.AUTOTASK_WEBHOOK_EXCLUDE_RESOURCE_IDS = '30683927, 30683921;bad, 0';
    expect(envExcludedResourceIDs()).toEqual([30683927, 30683921]);
    expect(buildExclusions([30683829], 30683921, true)).toEqual([
      { resourceID: 30683829, reason: 'requested' },
      { resourceID: 30683921, reason: 'mcp-api-user' },
      { resourceID: 30683927, reason: 'env' },
    ]);
    expect(buildExclusions([], 30683921, false).map((e) => e.reason)).toEqual(['env', 'env']);
  });
});

describe('createWebhook — secret from env, never echoed', () => {
  const mk = (selfId: number | null = 30683921) => {
    const s = new AutotaskService(config, logger);
    const ids = [900, 901, 902, 903];
    const create = jest.fn(async () => ids.shift());
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create });
    jest.spyOn(s, 'resolveApiUserResourceId').mockResolvedValue(selfId);
    return { s, create };
  };

  test('no secretKey + env set: dry run masks it, plans the self exclusion, writes nothing', async () => {
    process.env.AUTOTASK_WEBHOOK_SECRET = SECRET;
    const { s, create } = mk();
    const r = await s.createWebhook('tickets', { ...base });
    expect(r.status).toBe('dry_run');
    expect((r.plannedWebhook as any).secretKey).toBe('<from AUTOTASK_WEBHOOK_SECRET>');
    expect(r.plannedExcludedResources).toEqual([{ resourceID: 30683921, reason: 'mcp-api-user' }]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(create).not.toHaveBeenCalled();
  });

  test('execute: the REAL secret goes upstream, the API user is excluded, the result never contains the secret', async () => {
    process.env.AUTOTASK_WEBHOOK_SECRET = SECRET;
    const { s, create } = mk();
    const r = await s.createWebhook('tickets', { ...base, dryRun: false });
    expect(r.status).toBe('created');
    expect(create).toHaveBeenNthCalledWith(1, 'TicketWebhooks', expect.objectContaining({ secretKey: SECRET }));
    expect(create).toHaveBeenNthCalledWith(2, 'TicketWebhookExcludedResources', { webhookID: 900, resourceID: 30683921 });
    expect(r).toEqual(expect.objectContaining({ secretSource: 'env', excludedResources: [{ resourceID: 30683921, reason: 'mcp-api-user' }] }));
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  test('no secretKey and no env → validation_failed pointing at the env var', async () => {
    const { s, create } = mk();
    const r = await s.createWebhook('tickets', { ...base, dryRun: false });
    expect(r.status).toBe('validation_failed');
    expect(JSON.stringify(r)).toMatch(/AUTOTASK_WEBHOOK_SECRET/);
    expect(create).not.toHaveBeenCalled();
  });

  test('excludeSelf:false leaves the API user out; an unresolvable self is warned about', async () => {
    process.env.AUTOTASK_WEBHOOK_SECRET = SECRET;
    const off = await mk().s.createWebhook('tickets', { ...base, excludeSelf: false });
    expect(off.plannedExcludedResources).toEqual([]);
    const unknown = await mk(null).s.createWebhook('tickets', { ...base });
    expect((unknown.warnings as string[]).join(' ')).toMatch(/Could not resolve this MCP's own API-user resource/);
  });
});

describe('resolveApiUserResourceId', () => {
  test('matches Resource userName = API-username local part, then memoises', async () => {
    const s = new AutotaskService(config, logger);
    const query = jest.fn(async (_e: string, _f: unknown, _o?: unknown) => [{ id: 30683921 }]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    expect(await s.resolveApiUserResourceId()).toBe(30683921);
    expect(await s.resolveApiUserResourceId()).toBe(30683921);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toEqual([{ op: 'eq', field: 'userName', value: 'g6qb4ubr4c4vj72' }]);
  });
  test('falls back to email = username; a lookup failure is not memoised', async () => {
    const s = new AutotaskService(config, logger);
    const query = jest.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 42 }]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    expect(await s.resolveApiUserResourceId()).toBeNull();
    expect(await s.resolveApiUserResourceId()).toBe(42);
    expect(query.mock.calls[2]![1]).toEqual([{ op: 'eq', field: 'email', value: 'g6qb4ubr4c4vj72@gdstech.tech' }]);
  });
});

describe('updateWebhook useEnvSecret', () => {
  test('rotates to the env secret, masked in the dry run, real value upstream', async () => {
    process.env.AUTOTASK_WEBHOOK_SECRET = SECRET;
    const s = new AutotaskService(config, logger);
    const update = jest.fn();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ update });
    const dry = await s.updateWebhook('tickets', 900, { useEnvSecret: true });
    expect(dry.plannedPatch).toEqual({ secretKey: '<from AUTOTASK_WEBHOOK_SECRET>' });
    expect(JSON.stringify(dry)).not.toContain(SECRET);
    await s.updateWebhook('tickets', 900, { useEnvSecret: true }, false);
    expect(update).toHaveBeenCalledWith('TicketWebhooks', 900, { secretKey: SECRET });
  });
  test('useEnvSecret without the env var fails cleanly', async () => {
    const s = new AutotaskService(config, logger);
    const r = await s.updateWebhook('tickets', 900, { useEnvSecret: true });
    expect(r.status).toBe('validation_failed');
  });
});

describe('autotask_create_webhook handler message', () => {
  test('lists excluded resources with reasons, names the secret source, never the secret', async () => {
    process.env.AUTOTASK_WEBHOOK_SECRET = SECRET;
    const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'resolveApiUserResourceId').mockResolvedValue(30683921);
    const res = await new AutotaskToolHandler(s, logger).callTool('autotask_create_webhook', { entity: 'tickets', ...base });
    const text = res.content[0].text;
    expect(JSON.parse(text).message).toMatch(/excluded resources: 30683921 \(mcp-api-user\); secret from AUTOTASK_WEBHOOK_SECRET; nothing written/);
    expect(JSON.parse(text).message).toMatch(/Receiver: verify the signature with the n8n Code node in https:\/\/github\.com\/.*docs\/N8N_WEBHOOKS\.md/);
    expect(text).not.toContain(SECRET);
  });
});
