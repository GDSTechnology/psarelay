// Calling-container attribution: transport origin capture, per-instance
// impersonation mode, source allowlist gating, and the audit fields that make
// "which container is making the request" answerable. Mocked http / service.

import type { IncomingMessage } from 'node:http';
import { extractRequestOrigin } from '../src/utils/origin';
import {
  runWithRequestContext, getRequestOrigin, getImpersonationResourceId,
  getImpersonationMode, isImpersonationEnabled, isImpersonationAllowedForSource,
  getInstanceLabel,
} from '../src/utils/request-context';
import { emitAudit } from '../src/utils/audit';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import type { CallerContext } from '../src/types/context';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const svcWith = (fake: any) => { const s = new AutotaskService(config, logger); jest.spyOn(s as any, 'ensureClient').mockResolvedValue(fake); return s; };

const IMPERSONATION_ENVS = ['MCP_TRUST_UNVERIFIED_IDENTITY', 'AUTOTASK_IMPERSONATION', 'AUTOTASK_IMPERSONATION_MODE', 'AUTOTASK_IMPERSONATION_SOURCES', 'MCP_INSTANCE_LABEL'];
afterEach(() => { jest.restoreAllMocks(); for (const k of IMPERSONATION_ENVS) delete process.env[k]; });

const mkReq = (over: Partial<{ remoteAddress: string; headers: Record<string, string | string[]> }>): IncomingMessage => ({
  socket: { remoteAddress: over.remoteAddress } as any,
  headers: over.headers ?? {},
} as IncomingMessage);

describe('extractRequestOrigin', () => {
  test('captures peer address, first XFF hop, and user-agent', () => {
    const o = extractRequestOrigin(mkReq({
      remoteAddress: '172.18.0.5',
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'n8n/1.2' },
    }));
    expect(o).toEqual({ remoteAddr: '172.18.0.5', forwardedFor: '203.0.113.9', userAgent: 'n8n/1.2' });
  });

  test('undefined when no transport signal is present', () => {
    expect(extractRequestOrigin(mkReq({ headers: {} }))).toBeUndefined();
  });

  test('tolerates array-valued headers', () => {
    const o = extractRequestOrigin(mkReq({ remoteAddress: '10.1.1.1', headers: { 'user-agent': ['curl/8'] } }));
    expect(o).toMatchObject({ remoteAddr: '10.1.1.1', userAgent: 'curl/8' });
  });
});

describe('origin flows through AsyncLocalStorage', () => {
  test('getRequestOrigin returns the scoped origin and clears outside', async () => {
    expect(getRequestOrigin()).toBeUndefined();
    await runWithRequestContext({ origin: { remoteAddr: '1.2.3.4' } }, async () => {
      expect(getRequestOrigin()).toEqual({ remoteAddr: '1.2.3.4' });
    });
    expect(getRequestOrigin()).toBeUndefined();
  });
});

describe('getImpersonationMode', () => {
  test('defaults to off', () => { expect(getImpersonationMode()).toBe('off'); expect(isImpersonationEnabled()).toBe(false); });
  test('explicit modes win', () => {
    process.env.AUTOTASK_IMPERSONATION_MODE = 'gateway'; expect(getImpersonationMode()).toBe('off'); // removed mode fails closed
    process.env.AUTOTASK_IMPERSONATION_MODE = 'caller'; expect(getImpersonationMode()).toBe('caller');
    process.env.AUTOTASK_IMPERSONATION_MODE = 'off'; expect(getImpersonationMode()).toBe('off');
  });
  test('legacy AUTOTASK_IMPERSONATION=on maps to caller', () => {
    process.env.AUTOTASK_IMPERSONATION = 'on'; expect(getImpersonationMode()).toBe('caller');
  });
  test('explicit MODE overrides the legacy flag', () => {
    process.env.AUTOTASK_IMPERSONATION = 'on'; process.env.AUTOTASK_IMPERSONATION_MODE = 'off';
    expect(getImpersonationMode()).toBe('off');
  });
});

describe('isImpersonationAllowedForSource', () => {
  test('unset allowlist allows every source', () => {
    expect(isImpersonationAllowedForSource('n8n')).toBe(true);
    expect(isImpersonationAllowedForSource('chatgpt')).toBe(true);
  });
  test('allowlist restricts to listed sources', () => {
    process.env.AUTOTASK_IMPERSONATION_SOURCES = 'chatgpt, hermes-teams';
    expect(isImpersonationAllowedForSource('chatgpt')).toBe(true);
    expect(isImpersonationAllowedForSource('hermes-teams')).toBe(true);
    expect(isImpersonationAllowedForSource('n8n')).toBe(false);
  });
});

describe('emitAudit records the attribution signals', () => {
  const baseCtx = (over: Partial<CallerContext> = {}): CallerContext => ({
    source: 'chatgpt', correlationId: 'c1', timestamp: new Date().toISOString(), ...over,
  });

  test('instanceLabel, impersonationMode and origin are emitted', () => {
    process.env.MCP_INSTANCE_LABEL = 'gpt-teams';
    process.env.AUTOTASK_IMPERSONATION_MODE = 'caller';
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    emitAudit(logger, baseCtx({ origin: { remoteAddr: '172.18.0.5', forwardedFor: '203.0.113.9', userAgent: 'n8n/1.2' } }), { tool: 't', outcome: 'ok', durationMs: 1 });
    const payload = info.mock.calls[0][1] as any;
    expect(payload).toMatchObject({
      instanceLabel: 'gpt-teams', impersonationMode: 'caller',
      originRemoteAddr: '172.18.0.5', originForwardedFor: '203.0.113.9', originUserAgent: 'n8n/1.2',
    });
    expect(getInstanceLabel()).toBe('gpt-teams');
  });

  test('mode still emitted (off) when nothing configured; no origin keys when absent', () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    emitAudit(logger, baseCtx(), { tool: 't', outcome: 'ok', durationMs: 1 });
    const payload = info.mock.calls[0][1] as any;
    expect(payload.impersonationMode).toBe('off');
    expect(payload).not.toHaveProperty('originRemoteAddr');
    expect(payload).not.toHaveProperty('instanceLabel');
  });
});

describe('callTool honours mode + source gating', () => {
  test('the removed gateway mode fails closed: no caller resolution, no impersonation', async () => {
    process.env.AUTOTASK_IMPERSONATION_MODE = 'gateway';
    const service = svcWith({});
    const handler = new AutotaskToolHandler(service, logger);
    const resolveSpy = jest.spyOn(handler as any, 'resolveCaller');
    let seen: number | undefined = -1;
    jest.spyOn(service, 'createTicket').mockImplementation(async () => { seen = getImpersonationResourceId(); return 1; });
    await handler.callTool('autotask_create_ticket', { companyID: 1, title: 'T', description: 'D' });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(seen).toBeUndefined();
  });

  test('caller mode + source barred by allowlist → no impersonation', async () => {
    process.env.AUTOTASK_IMPERSONATION_MODE = 'caller';
    process.env.AUTOTASK_IMPERSONATION_SOURCES = 'chatgpt';
    const service = svcWith({});
    const handler = new AutotaskToolHandler(service, logger);
    const resolveSpy = jest.spyOn(handler as any, 'resolveCaller').mockResolvedValue({ status: 'resolved', resource: { id: 5, name: 'Me' } });
    let seen: number | undefined = -1;
    jest.spyOn(service, 'createTicket').mockImplementation(async () => { seen = getImpersonationResourceId(); return 1; });
    // n8n source is not on the allowlist → impersonation skipped (runs as integration user)
    await handler.callTool('autotask_create_ticket', { companyID: 1, title: 'T', description: 'D', _context: { source: 'n8n' } });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(seen).toBeUndefined();
  });

  test('caller mode + allowed source + trusted declared identity → impersonates the resolved caller', async () => {
    process.env.MCP_TRUST_UNVERIFIED_IDENTITY = 'true';
    process.env.AUTOTASK_IMPERSONATION_MODE = 'caller';
    process.env.AUTOTASK_IMPERSONATION_SOURCES = 'chatgpt';
    const service = svcWith({});
    const handler = new AutotaskToolHandler(service, logger);
    jest.spyOn(handler as any, 'resolveCaller').mockResolvedValue({ status: 'resolved', resource: { id: 5, name: 'Me' } });
    let seen: number | undefined = -1;
    jest.spyOn(service, 'createTicket').mockImplementation(async () => { seen = getImpersonationResourceId(); return 1; });
    await handler.callTool('autotask_create_ticket', { companyID: 1, title: 'T', description: 'D', _context: { source: 'chatgpt' } });
    expect(seen).toBe(5);
  });

  test('origin captured at the entry reaches the audit record', async () => {
    const service = svcWith({});
    const handler = new AutotaskToolHandler(service, logger);
    jest.spyOn(service, 'getConfigurationItem').mockResolvedValue({ id: 9 } as any);
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    await runWithRequestContext({ origin: { remoteAddr: '172.18.0.9', userAgent: 'cron/1' } }, () =>
      handler.callTool('autotask_get_configuration_item', { configurationItemId: 9 })
    );
    const audit = info.mock.calls.map((c) => c[1] as any).find((p) => p && p.audit);
    expect(audit).toMatchObject({ originRemoteAddr: '172.18.0.9', originUserAgent: 'cron/1' });
  });
});
