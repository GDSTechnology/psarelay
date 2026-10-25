// Caller context + structured audit logging (Expansion Spec §3.5 / §23).

import { extractCallerContext, stripCallerContext, CALLER_CONTEXT_ARG } from '../src/types/context';
import { emitAudit } from '../src/utils/audit';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' },
};

/** Audit entries captured from a spied logger.info. */
function auditEntries(spy: jest.SpyInstance): any[] {
  return spy.mock.calls.filter((c: any[]) => c[0] === 'audit').map((c: any[]) => c[1]);
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('extractCallerContext', () => {
  test('reads context from _meta', () => {
    const ctx = extractCallerContext({ source: 'hermes-teams', requestingUserEmail: 'a@b.com', correlationId: 'C1', intent: 'log time' }, {});
    expect(ctx).toMatchObject({ source: 'hermes-teams', requestingUserEmail: 'a@b.com', correlationId: 'C1', intent: 'log time' });
    expect(ctx.timestamp).toMatch(/\dT\d/);
  });

  test('falls back to the reserved _context argument', () => {
    const ctx = extractCallerContext(undefined, { [CALLER_CONTEXT_ARG]: { source: 'chatgpt', requestingUserEmail: 'x@y.com' } });
    expect(ctx.source).toBe('chatgpt');
    expect(ctx.requestingUserEmail).toBe('x@y.com');
  });

  test('_meta wins over _context', () => {
    const ctx = extractCallerContext({ source: 'hermes-teams' }, { [CALLER_CONTEXT_ARG]: { source: 'chatgpt' } });
    expect(ctx.source).toBe('hermes-teams');
  });

  test('defaults: unknown source + generated correlationId', () => {
    const ctx = extractCallerContext(undefined, undefined);
    expect(ctx.source).toBe('unknown');
    expect(ctx.correlationId).toHaveLength(36); // uuid
  });

  test('invalid source coerces to unknown; resource id accepts a numeric string', () => {
    const ctx = extractCallerContext({ source: 'slack', autotaskResourceId: '30683829' }, {});
    expect(ctx.source).toBe('unknown');
    expect(ctx.autotaskResourceId).toBe(30683829);
  });
});

describe('stripCallerContext', () => {
  test('removes only the reserved key', () => {
    expect(stripCallerContext({ a: 1, [CALLER_CONTEXT_ARG]: { source: 'chatgpt' } })).toEqual({ a: 1 });
  });
  test('passes through when absent', () => {
    const args = { a: 1 };
    expect(stripCallerContext(args)).toBe(args);
  });
});

describe('emitAudit', () => {
  test('emits a structured audit record', () => {
    const logger = new Logger('error');
    const spy = jest.spyOn(logger, 'info');
    emitAudit(logger, extractCallerContext({ source: 'chatgpt', requestingUserEmail: 'a@b.com', correlationId: 'C9' }, {}), {
      tool: 'autotask_create_company', outcome: 'ok', durationMs: 5, resultId: 42,
    });
    const [entry] = auditEntries(spy);
    expect(entry).toMatchObject({ audit: true, tool: 'autotask_create_company', outcome: 'ok', source: 'chatgpt', correlationId: 'C9', requestingUserEmail: 'a@b.com', resultId: 42 });
  });
});

describe('callTool threads caller context to the audit log and strips _context', () => {
  test('create tool: _context stripped from tool args; audit records caller + resultId', async () => {
    const logger = new Logger('error');
    const infoSpy = jest.spyOn(logger, 'info');
    const service = new AutotaskService(config, logger);
    const createSpy = jest.spyOn(service, 'createCompany').mockResolvedValue(42 as any);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool('autotask_create_company', {
      companyName: 'Acme Technology',
      ownerResourceID: 1,
      [CALLER_CONTEXT_ARG]: { source: 'chatgpt', requestingUserEmail: 'a@b.com' },
    });

    // The tool never sees the reserved context key.
    expect(createSpy.mock.calls[0][0]).not.toHaveProperty(CALLER_CONTEXT_ARG);

    const [entry] = auditEntries(infoSpy);
    expect(entry).toMatchObject({ tool: 'autotask_create_company', outcome: 'ok', source: 'chatgpt', requestingUserEmail: 'a@b.com', resultId: 42 });
  });

  test('meta path + error outcome is audited', async () => {
    const logger = new Logger('error');
    const infoSpy = jest.spyOn(logger, 'info');
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'createCompany').mockRejectedValue(new Error('boom'));
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool(
      'autotask_create_company',
      { companyName: 'Acme Technology', ownerResourceID: 1 },
      { source: 'hermes-teams', correlationId: 'C-ERR' }
    );

    expect(result.isError).toBe(true);
    const [entry] = auditEntries(infoSpy);
    expect(entry).toMatchObject({ tool: 'autotask_create_company', outcome: 'error', source: 'hermes-teams', correlationId: 'C-ERR', error: 'boom' });
  });
});
