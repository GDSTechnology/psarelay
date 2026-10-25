// PG audit sink + dual-write wiring (Expansion Spec §23, issue #18).

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import { PgAuditSink, auditRowValues, createAuditSink } from '../src/db/audit-sink';
import { closePool } from '../src/db/pool';
import type { CallerContext } from '../src/types/context';
import type { AuditEntry } from '../src/utils/audit';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const ctx: CallerContext = {
  source: 'hermes-teams', correlationId: 'corr-1', timestamp: '2026-08-27T00:00:00Z',
  requestingUserEmail: 'jf@gds.com', autotaskResourceId: 30683829, conversationId: 'conv-9',
};
const entry: AuditEntry = { tool: 'autotask_create_time_entry', outcome: 'ok', durationMs: 42, resultId: 700 };

afterEach(async () => {
  delete process.env.MCP_PG_ENABLED;
  delete process.env.MCP_PG_AUDIT_ENABLED;
  delete process.env.MCP_PG_PASSWORD;
  await closePool();
  jest.restoreAllMocks();
});

describe('auditRowValues', () => {
  test('maps ctx + entry to ordered params, null for absent fields', () => {
    expect(auditRowValues(ctx, entry)).toEqual([
      'autotask_create_time_entry', 'ok', 42, 'hermes-teams', 'corr-1', 'jf@gds.com',
      30683829, 'conv-9', null, null, 700, null,
    ]);
  });

  test('absent optional caller/entry fields become null', () => {
    const bare: CallerContext = { source: 'unknown', correlationId: 'c', timestamp: 't' };
    const err: AuditEntry = { tool: 't', outcome: 'error', durationMs: 1, error: 'boom' };
    const vals = auditRowValues(bare, err);
    expect(vals[5]).toBeNull(); // requesting_user_email
    expect(vals[6]).toBeNull(); // autotask_resource_id
    expect(vals[11]).toBe('boom'); // error
  });
});

describe('PgAuditSink', () => {
  test('record issues the INSERT with the mapped values', () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const fakePool = { query: (sql: string, params: unknown[]) => { calls.push({ sql, params }); return Promise.resolve({}); } } as any;

    new PgAuditSink(fakePool, logger).record(ctx, entry);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('INSERT INTO audit_log');
    expect(calls[0].params).toEqual(auditRowValues(ctx, entry));
  });

  test('a failed write is swallowed (best-effort, never throws)', async () => {
    const rejPool = { query: () => Promise.reject(new Error('db down')) } as any;
    expect(() => new PgAuditSink(rejPool, logger).record(ctx, entry)).not.toThrow();
    await new Promise((r) => setImmediate(r)); // allow the rejection to be caught
  });
});

describe('createAuditSink', () => {
  test('null when the audit flag is off', () => {
    expect(createAuditSink(logger, {} as any)).toBeNull();
    expect(createAuditSink(logger, { MCP_PG_AUDIT_ENABLED: 'true' } as any)).toBeNull(); // master off
  });

  test('returns a sink when PG + audit are both enabled', () => {
    const sink = createAuditSink(logger, {
      MCP_PG_ENABLED: 'true', MCP_PG_AUDIT_ENABLED: 'true', MCP_PG_PASSWORD: 'devapp',
    } as any);
    expect(sink).toBeInstanceOf(PgAuditSink);
  });
});

describe('handler dual-write wiring', () => {
  const config: McpServerConfig = {
    name: 'test', version: '0.0.0',
    autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' },
  };

  test('callTool routes audit records through the sink as well as the log', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'getContract').mockResolvedValue({ id: 55 } as any);
    const handler = new AutotaskToolHandler(service, logger);
    const recorded: AuditEntry[] = [];
    (handler as any).auditSink = { record: (_c: CallerContext, e: AuditEntry) => recorded.push(e) };

    await handler.callTool('autotask_get_contract', { id: 55 }, { source: 'hermes-teams', requestingUserEmail: 'x@y.com' });

    expect(recorded.some((e) => e.tool === 'autotask_get_contract' && e.outcome === 'ok')).toBe(true);
  });
});
