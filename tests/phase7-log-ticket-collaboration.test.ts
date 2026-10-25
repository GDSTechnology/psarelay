// log_ticket_collaboration (rebuilt on the current stack): capture a Teams triage
// thread on a TICKET as one ticket time entry per contributing tech + an optional
// ticket note. Dry-run-first, resolve by id/name/email, role auto-resolve,
// idempotent time + note, validate-all-before-write.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' },
};

function res(status: number, body?: any): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (body !== undefined ? JSON.stringify(body) : '') } as unknown as Response;
}
function mockDay(rows: any[]): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    if (/\/TimeEntries\/query$/.test(url)) return Promise.resolve(res(200, { items: rows }));
    return Promise.resolve(res(200, { items: [] }));
  });
}
function svcWithResolvers() {
  const svc = new AutotaskService(config, logger);
  jest.spyOn(svc, 'resolveResourceByEmail').mockImplementation(async (email: string) => {
    const map: Record<string, number> = { 'jf@gds.com': 100, 'cg@gds.com': 200 };
    return map[email] ? { id: map[email], firstName: 'X', lastName: 'Y' } : null;
  });
  jest.spyOn(svc, 'resolveResourceByName').mockImplementation(async (name: string) => (name === 'Jonathan Fitzgerald' ? { id: 100, firstName: 'Jonathan', lastName: 'Fitzgerald' } : null));
  jest.spyOn(svc, 'resolveWorkTimeEntryRole').mockResolvedValue({ roleID: 999 } as any);
  return svc;
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

const base = {
  ticketID: 204722,
  dateWorked: '2026-09-24',
  participants: [
    { email: 'jf@gds.com', hoursWorked: 0.5, summaryNotes: 'Led triage' },
    { resourceName: 'Jonathan Fitzgerald', hoursWorked: 0.25, summaryNotes: 'Follow-up' }, // resolves to 100 too, distinct summary
    { email: 'cg@gds.com', hoursWorked: 0.5, summaryNotes: 'Network check' },
  ],
};

describe('logTicketCollaboration', () => {
  test('dry-run resolves everyone (email + name), writes nothing', async () => {
    const svc = svcWithResolvers();
    const log = jest.spyOn(svc, 'logTimeIdempotent');
    mockDay([]);
    const out = await svc.logTicketCollaboration({ ...base, dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.written).toBe(false);
    expect(out.wouldCreate).toBe(3);
    expect(out.results.every((r) => r.status === 'would_create' && r.resourceID != null && r.roleID === 999)).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  test('commit writes ticket time per participant (idempotent) + the note last', async () => {
    const svc = svcWithResolvers();
    const log = jest.spyOn(svc, 'logTimeIdempotent')
      .mockResolvedValueOnce({ created: true, id: 1 })
      .mockResolvedValueOnce({ created: true, id: 2 })
      .mockResolvedValueOnce({ created: true, id: 3 });
    const note = jest.spyOn(svc, 'createTicketNoteIdempotent').mockResolvedValue({ created: true, noteId: 700, idempotencyKey: 'k' });
    mockDay([]);
    const out = await svc.logTicketCollaboration({ ...base, note: { description: 'How we fixed it', noteType: 1, publish: 1, idempotencyKey: 'TRIAGE:204722:t1' }, dryRun: false });
    expect(out.written).toBe(true);
    expect(out.created).toBe(3);
    expect(log).toHaveBeenCalledTimes(3);
    // ticket time (not task) with role
    expect((log.mock.calls[0][0] as any).ticketID).toBe(204722);
    expect((log.mock.calls[0][0] as any).roleID).toBe(999);
    expect(out.note).toEqual({ status: 'created', noteId: 700 });
    expect(note).toHaveBeenCalled();
  });

  test('validate-all-before-write: an unresolved participant blocks ALL writes + the note', async () => {
    const svc = svcWithResolvers();
    const log = jest.spyOn(svc, 'logTimeIdempotent');
    const note = jest.spyOn(svc, 'createTicketNoteIdempotent').mockResolvedValue({ created: true, noteId: 1 });
    mockDay([]);
    const out = await svc.logTicketCollaboration({
      ticketID: 204722, dateWorked: '2026-09-24', dryRun: false,
      participants: [
        { email: 'jf@gds.com', hoursWorked: 1, summaryNotes: 'a' },
        { email: 'ghost@nowhere.com', hoursWorked: 1, summaryNotes: 'b' },
      ],
      note: { description: 'x' },
    });
    expect(out.errors).toBe(1);
    expect(out.written).toBe(false);
    expect(out.created).toBe(0);
    expect(log).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(out.note).toEqual({ status: 'would_create' }); // planned, not written
  });

  test('billingTreatment is applied per participant', async () => {
    const svc = svcWithResolvers();
    const log = jest.spyOn(svc, 'logTimeIdempotent').mockResolvedValue({ created: true, id: 1 });
    mockDay([]);
    await svc.logTicketCollaboration({
      ticketID: 204722, dateWorked: '2026-09-24', dryRun: false,
      participants: [{ email: 'cg@gds.com', hoursWorked: 0.5, summaryNotes: 'sales oversight', billingTreatment: 'non_billable' }],
    });
    const sent = log.mock.calls[0][0] as any;
    expect(sent.isNonBillable).toBe(true);
    expect(sent.showOnInvoice).toBe(false);
  });

  test('duplicate detection from existing ticket time for the day', async () => {
    const svc = svcWithResolvers();
    mockDay([{ id: 55, resourceID: 100, summaryNotes: 'Led triage' }]);
    const out = await svc.logTicketCollaboration({ ...base, dryRun: true });
    const dup = out.results.find((r) => r.duplicateOf === 55);
    expect(dup?.status).toBe('duplicate');
  });
});

describe('autotask_log_ticket_collaboration tool', () => {
  test('defaults to dry-run and guards inputs', async () => {
    const svc = new AutotaskService(config, logger);
    const spy = jest.spyOn(svc, 'logTicketCollaboration').mockResolvedValue({
      ticketID: 204722, dateWorked: '2026-09-24', dryRun: true, planned: 1, wouldCreate: 1, duplicates: 0, errors: 0, created: 0, written: false, results: [],
    });
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_log_ticket_collaboration', { ticketID: 204722, dateWorked: '2026-09-24', participants: [{ hoursWorked: 1, summaryNotes: 'x' }] });
    expect((spy.mock.calls[0][0] as any).dryRun).toBe(true);
    expect(r.content[0].text).toContain('DRY RUN');

    const bad = await handler.callTool('autotask_log_ticket_collaboration', { ticketID: 204722, dateWorked: '2026-09-24', participants: [] });
    expect(bad.content[0].text).toContain('participants[] is required');
  });
});
