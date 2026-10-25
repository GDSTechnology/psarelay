// Operation log + durable idempotency (MCP-007): which writes a call made,
// `_operation` in write results, the claim → replay / conflict / partial
// rules, and linking the MCP's own audit events back to their operation.

import { parseWrite, noteOperationWrite, runInOperation } from '../src/utils/operation-context';
import { mayWrite, argsDigest, operationClaimResult } from '../src/utils/operations';
import type { ClaimResult, OperationInput, OperationRecord } from '../src/db/operation-store';
import type { OperationWrite } from '../src/utils/operation-context';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

afterEach(() => jest.restoreAllMocks());

describe('write capture', () => {
  test('parseWrite: entity + id from path, body or create response; child routes keep their parent', () => {
    expect(parseWrite('patch', '/Tickets', { id: 7, status: 5 }, {})).toMatchObject({ method: 'PATCH', entityType: 'ticket', entityId: 7, parentId: null });
    expect(parseWrite('POST', 'https://webservices3.autotask.net/ATServicesRest/v1.0/Tickets/12/Notes?x=1', { title: 't' }, { itemId: 345 }))
      .toMatchObject({ path: '/Tickets/12/Notes', entityType: 'ticketNote', entityId: 345, parentType: 'ticket', parentId: 12 });
    expect(parseWrite('POST', '/TicketNotes', { ticketID: 12 }, { itemId: 346 })).toMatchObject({ entityType: 'ticketNote', entityId: 346, parentType: 'ticket', parentId: 12 });
    expect(parseWrite('PATCH', '/Companies/5/Contacts', { id: 9, isActive: 1 }, {})).toMatchObject({ entityType: 'contact', entityId: 9, parentType: 'company', parentId: 5 });
    expect(parseWrite('DELETE', '/TimeEntries/55', undefined, undefined)).toMatchObject({ entityType: 'timeEntry', entityId: 55 });
    expect(parseWrite('POST', '/Opportunities', {}, { itemId: 3 })).toMatchObject({ entityType: 'Opportunities', entityId: 3 });
  });

  test('writes are captured only inside an operation scope, and concurrent scopes stay apart', async () => {
    noteOperationWrite('PATCH', '/Tickets', { id: 1 }, {}); // outside: ignored
    const a = { operationId: 'a', writes: [] as OperationWrite[] }, b = { operationId: 'b', writes: [] as OperationWrite[] };
    await Promise.all([
      runInOperation(a, async () => { await new Promise((r) => setTimeout(r, 5)); noteOperationWrite('PATCH', '/Tickets', { id: 2 }, {}); }),
      runInOperation(b, async () => { noteOperationWrite('PATCH', '/Tickets', { id: 3 }, {}); }),
    ]);
    expect(a.writes.map((w) => w.entityId)).toEqual([2]);
    expect(b.writes.map((w) => w.entityId)).toEqual([3]);
  });

  test('mayWrite: raw reads and queries never; raw writes, mutating tools and find_or_create yes', () => {
    expect(mayWrite('autotask_raw_request', { method: 'GET', path: '/Tickets/1' })).toBe(false);
    expect(mayWrite('autotask_raw_request', { method: 'POST', path: '/Tickets/query' })).toBe(false);
    expect(mayWrite('autotask_raw_request', { method: 'PUT', path: '/Tickets' })).toBe(true);
    expect(mayWrite('autotask_find_or_create_contact', {})).toBe(true);
    expect(mayWrite('autotask_get_ticket_details', {})).toBe(false);
    expect(mayWrite('autotask_update_ticket', {})).toBe(true);
    expect(argsDigest({ b: 1, a: 2 })).toBe(argsDigest({ a: 2, b: 1 }));
  });

  test('refusals say why and that nothing was done', () => {
    const op: OperationRecord = { operationId: 'o1', correlationId: 'c1', decisionId: null, idempotencyKey: 'k', tool: 'autotask_update_ticket', source: 'n8n', caller: null, refs: null, status: 'partial', startedAt: 's', finishedAt: null, error: 'boom', writes: [] };
    const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
    expect(body(operationClaimResult({ status: 'partial', operation: op }, 'k'))).toMatchObject({ data: { status: 'previous_attempt_partial' }, message: expect.stringMatching(/NOT re-run/) });
    expect(body(operationClaimResult({ status: 'conflict', operation: op }, 'k')).data.status).toBe('idempotency_conflict');
    expect(body(operationClaimResult({ status: 'replay', operation: { ...op, status: 'ok' }, resultText: '{"message":"done","data":7}' }, 'k'))).toMatchObject({ message: 'done', data: 7, _operation: { operationId: 'o1', replayed: true } });
  });
});

/** In-memory twin of OperationStore (same claim rules; the SQL is smoke-tested against Postgres). */
class FakeOps {
  rows = new Map<string, { input: OperationInput; status: string; resultText: string | null; error: string | null; writes: OperationWrite[]; startedAt: number }>();
  rec(r: { input: OperationInput; status: string; error: string | null; writes: OperationWrite[] }): OperationRecord {
    return { operationId: r.input.operationId, correlationId: r.input.correlationId, decisionId: r.input.decisionId ?? null, idempotencyKey: r.input.idempotencyKey ?? null, tool: r.input.tool, source: r.input.source, caller: null, refs: r.input.refs ?? null, status: r.status as never, startedAt: 'x', finishedAt: 'y', error: r.error, writes: r.writes };
  }
  async claim(op: OperationInput & { idempotencyKey: string }): Promise<ClaimResult> {
    const ex = [...this.rows.values()].find((r) => r.input.idempotencyKey === op.idempotencyKey);
    if (ex && ex.status === 'error') this.rows.delete(ex.input.operationId);
    else if (ex) {
      if (ex.input.tool !== op.tool || ex.input.argsDigest !== op.argsDigest) return { status: 'conflict', operation: this.rec(ex) };
      if (ex.status === 'ok') return { status: 'replay', operation: this.rec(ex), resultText: ex.resultText };
      if (ex.status === 'partial') return { status: 'partial', operation: this.rec(ex) };
      return { status: 'in_progress', operation: this.rec(ex) };
    }
    this.rows.set(op.operationId, { input: op, status: 'running', resultText: null, error: null, writes: [], startedAt: Date.now() });
    return { status: 'claimed' };
  }
  async finish(op: OperationInput, out: { status: string; writes: OperationWrite[]; resultText?: string | null; error?: string | null }) {
    this.rows.set(op.operationId, { input: op, status: out.status, resultText: out.resultText ?? null, error: out.error ?? null, writes: out.writes, startedAt: Date.now() });
  }
  async find() { return [...this.rows.values()].map((r) => this.rec(r)); }
  async linkEvents(targets: Array<{ type: string; id: number; at: string }>) {
    const m = new Map<string, OperationRecord>();
    for (const t of targets) for (const r of this.rows.values()) if (r.writes.some((w) => w.entityType === t.type && w.entityId === t.id)) m.set(`${t.type}:${t.id}:${t.at}`, this.rec(r));
    return m;
  }
  async purge() { return 0; }
}

describe('tool calls (handler)', () => {
  const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
  const logger = new Logger('error');
  function setup() {
    const service = new AutotaskService(config, logger);
    const update = jest.spyOn(service, 'updateContact').mockImplementation(async (id: number) => { noteOperationWrite('PATCH', '/Contacts', { id }, {}); });
    const handler = new AutotaskToolHandler(service, logger);
    const ops = new FakeOps();
    (handler as unknown as { operations: unknown }).operations = ops;
    const call = async (args: Record<string, unknown>, meta?: Record<string, unknown>, tool = 'autotask_update_contact') =>
      JSON.parse((await handler.callTool(tool, args, meta)).content[0]!.text as string) as Record<string, any>;
    return { service, update, ops, call };
  }

  test('a write returns _operation (correlation, decision, refs, the writes) and is recorded', async () => {
    const { ops, call } = setup();
    const r = await call({ id: 5, title: 'CTO' }, { source: 'n8n', correlationId: 'corr-1', decisionId: 'hermes-42', workflow: 'Autotask - 5 min Workload', node: 'Apply', executionId: 991 });
    expect(r._operation).toMatchObject({ correlationId: 'corr-1', decisionId: 'hermes-42', refs: { workflow: 'Autotask - 5 min Workload', node: 'Apply', executionId: '991' }, writes: [{ method: 'PATCH', entityType: 'contact', entityId: 5 }] });
    const stored = [...ops.rows.values()][0]!;
    expect(stored).toMatchObject({ status: 'ok', input: { tool: 'autotask_update_contact', correlationId: 'corr-1' } });
    expect(JSON.parse(stored.resultText!)._operation.operationId).toBe(r._operation.operationId);
  });

  test('idempotencyKey: a repeat replays without writing; the same key with a different payload is refused', async () => {
    const { update, call } = setup();
    const first = await call({ id: 5, title: 'CTO' }, { idempotencyKey: 'evt-1' });
    const again = await call({ id: 5, title: 'CTO' }, { idempotencyKey: 'evt-1' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(again._operation).toMatchObject({ operationId: first._operation.operationId, replayed: true });
    const other = await call({ id: 5, title: 'CEO' }, { idempotencyKey: 'evt-1' });
    expect(other.data.status).toBe('idempotency_conflict');
    expect(update).toHaveBeenCalledTimes(1);
  });

  test('a failure AFTER writing is partial and never re-run under the key; a failure BEFORE writing can be retried', async () => {
    const { service, update, call } = setup();
    update.mockImplementationOnce(async (id: number) => { noteOperationWrite('PATCH', '/Contacts', { id }, {}); throw new Error('read-back failed'); });
    await call({ id: 5, title: 'CTO' }, { idempotencyKey: 'evt-2' });
    const retry = await call({ id: 5, title: 'CTO' }, { idempotencyKey: 'evt-2' });
    expect(retry.data.status).toBe('previous_attempt_partial');
    expect(update).toHaveBeenCalledTimes(1);

    jest.spyOn(service, 'updateContact').mockRejectedValueOnce(new Error('validation'));
    await call({ id: 6, title: 'x' }, { idempotencyKey: 'evt-3' });
    const ok = await call({ id: 6, title: 'x' }, { idempotencyKey: 'evt-3' });
    expect(ok._operation).toMatchObject({ idempotencyKey: 'evt-3', writes: [{ entityId: 6 }] });
  });

  test("the MCP's own audit events are linked to the operation that wrote them; others are left alone", async () => {
    const { ops, call } = setup();
    const w = await call({ id: 5, title: 'CTO' }, { correlationId: 'corr-9', decisionId: 'd-9' });
    const h = new AutotaskToolHandler(new AutotaskService(config, logger), logger) as unknown as { operations: unknown; linkOperations: (e: unknown[], t: (x: any) => unknown, a: (x: any, op: any) => unknown) => Promise<any[]> };
    h.operations = ops;
    const events = [
      { entityType: 'contact', entityId: 5, at: '2026-10-09T12:00:00.000Z', actor: 'service_account' },
      { entityType: 'contact', entityId: 5, at: '2026-10-09T12:00:00.000Z', actor: 'human' },
    ];
    const out = await h.linkOperations(events, (e) => (e.actor === 'service_account' ? { type: e.entityType, id: e.entityId, at: e.at } : null), (e, operation) => ({ ...e, operation }));
    expect(out[0].operation).toMatchObject({ operationId: w._operation.operationId, correlationId: 'corr-9', decisionId: 'd-9', tool: 'autotask_update_contact' });
    expect(out[1].operation).toBeUndefined();
  });

  test('reads record nothing and carry no _operation', async () => {
    const { service, ops, call } = setup();
    jest.spyOn(service, 'getContact').mockResolvedValue({ id: 5, firstName: 'A' } as never);
    const r = await call({ contactId: 5 }, { idempotencyKey: 'read-1' }, 'autotask_get_contact');
    expect(r._operation).toBeUndefined();
    expect(ops.rows.size).toBe(0);
  });
});
