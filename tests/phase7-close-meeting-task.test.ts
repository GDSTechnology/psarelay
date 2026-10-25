// autotask_verify_task_time_entries + autotask_close_meeting_task:
// gate a meeting-task closeout on all attendees' time being logged, then close
// the task safely (dry-run first, refuse-if-incomplete, idempotent note,
// already-complete = no-op).

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server',
  version: '0.0.0',
  autotask: {
    username: 'user@example.com',
    secret: 'secret',
    integrationCode: 'integration-code',
    apiUrl: 'https://webservices2.autotask.net/ATServicesRest/',
  },
};

function res(status: number, body?: any): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (body !== undefined ? JSON.stringify(body) : ''),
  } as unknown as Response;
}

/** Route the TimeEntries/query (verification) and Tickets/query (related) probes. */
function mockProbes(opts: { timeEntries?: any[]; tickets?: any[] } = {}): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    if (/\/TimeEntries\/query$/.test(url)) return Promise.resolve(res(200, { items: opts.timeEntries ?? [] }));
    if (/\/Tickets\/query$/.test(url)) return Promise.resolve(res(200, { items: opts.tickets ?? [] }));
    return Promise.resolve(res(599, { errors: [`unexpected ${url}`] }));
  });
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('verifyTaskTimeEntries', () => {
  test('reports missing and duplicate expected resources', async () => {
    const svc = new AutotaskService(config, logger);
    mockProbes({ timeEntries: [
      { id: 1, resourceID: 100 },
      { id: 2, resourceID: 100 }, // duplicate for 100
      { id: 3, resourceID: 200 },
    ] });
    const out = await svc.verifyTaskTimeEntries(208749, '2026-09-23', [100, 200, 300]);
    expect(out.expected).toBe(3);
    expect(out.found).toBe(2);
    expect(out.missingResourceIDs).toEqual([300]);
    expect(out.duplicateResourceIDs).toEqual([100]);
  });
});

describe('closeMeetingTask', () => {
  const openTask = { id: 208749, projectID: 181, completedDateTime: null, title: 'RPO Meeting' };

  test('already-complete task -> no-op recognized', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTask').mockResolvedValue({ ...openTask, completedDateTime: '2026-09-23T14:00:00Z' } as any);
    const complete = jest.spyOn(svc, 'completeTask').mockResolvedValue();
    const out = await svc.closeMeetingTask({ taskID: 208749, dryRun: false });
    expect(out.status).toBe('already_complete');
    expect(complete).not.toHaveBeenCalled();
  });

  test('dry-run with a missing attendee -> would NOT close, lists blocker, no writes', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTask').mockResolvedValue(openTask as any);
    const complete = jest.spyOn(svc, 'completeTask').mockResolvedValue();
    mockProbes({ timeEntries: [{ id: 1, resourceID: 100 }] }); // 200 missing

    const out = await svc.closeMeetingTask({
      taskID: 208749, dateWorked: '2026-09-23', expectedResourceIDs: [100, 200],
      requireTimeEntries: true, dryRun: true,
    });

    expect(out.status).toBe('dry_run');
    expect(out.wouldClose).toBe(false);
    expect(out.blockers.join(' ')).toMatch(/missing time entries.*200/);
    expect(complete).not.toHaveBeenCalled();
  });

  test('commit but blocked (requireCloseoutNote, none given) -> not closed', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTask').mockResolvedValue(openTask as any);
    const complete = jest.spyOn(svc, 'completeTask').mockResolvedValue();
    mockProbes({ timeEntries: [{ id: 1, resourceID: 100 }, { id: 2, resourceID: 200 }] });

    const out = await svc.closeMeetingTask({
      taskID: 208749, dateWorked: '2026-09-23', expectedResourceIDs: [100, 200],
      requireTimeEntries: true, requireCloseoutNote: true, dryRun: false,
    });

    expect(out.status).toBe('blocked');
    expect(out.blockers.join(' ')).toMatch(/requireCloseoutNote/);
    expect(complete).not.toHaveBeenCalled();
  });

  test('related ticket not found -> blocked', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTask').mockResolvedValue(openTask as any);
    jest.spyOn(svc, 'completeTask').mockResolvedValue();
    mockProbes({ timeEntries: [{ id: 1, resourceID: 100 }], tickets: [{ id: 208824 }] }); // 199634 missing

    const out = await svc.closeMeetingTask({
      taskID: 208749, dateWorked: '2026-09-23', expectedResourceIDs: [100],
      requireTimeEntries: true, relatedTicketIDs: [208824, 199634], dryRun: false,
    });

    expect(out.status).toBe('blocked');
    expect(out.missingRelatedTicketIDs).toEqual([199634]);
  });

  test('clean commit -> writes idempotent closeout note and completes', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTask')
      .mockResolvedValueOnce(openTask as any)                                   // initial read
      .mockResolvedValueOnce({ ...openTask, completedDateTime: '2026-09-23T15:00:00Z' } as any); // read-back
    jest.spyOn(svc, 'searchTaskNotes').mockResolvedValue([]); // no prior closeout note
    const createNote = jest.spyOn(svc, 'createTaskNote').mockResolvedValue(7001);
    const complete = jest.spyOn(svc, 'completeTask').mockResolvedValue();
    mockProbes({ timeEntries: [{ id: 1, resourceID: 100 }, { id: 2, resourceID: 200 }] });

    const out = await svc.closeMeetingTask({
      taskID: 208749, projectID: 181, dateWorked: '2026-09-23', expectedResourceIDs: [100, 200],
      requireTimeEntries: true, closeoutNote: 'Meeting reconciled.', dryRun: false,
    });

    expect(out.status).toBe('closed');
    expect(out.noteId).toBe(7001);
    expect(complete).toHaveBeenCalledWith(208749, { projectID: 181 });
    // marker appended for idempotency
    expect((createNote.mock.calls[0][1] as any).description).toContain('[MCP-ID:CLOSEOUT:208749]');
  });

  test('re-run finds the marker -> reuses the prior note, still completes', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTask').mockResolvedValue(openTask as any);
    jest.spyOn(svc, 'searchTaskNotes').mockResolvedValue([{ id: 42, description: `x\n\n[MCP-ID:CLOSEOUT:208749]` }]);
    const createNote = jest.spyOn(svc, 'createTaskNote').mockResolvedValue(999);
    jest.spyOn(svc, 'completeTask').mockResolvedValue();
    mockProbes({ timeEntries: [{ id: 1, resourceID: 100 }] });

    const out = await svc.closeMeetingTask({
      taskID: 208749, dateWorked: '2026-09-23', expectedResourceIDs: [100],
      requireTimeEntries: true, closeoutNote: 'again', dryRun: false,
    });

    expect(out.status).toBe('closed');
    expect(out.noteId).toBe(42);
    expect(createNote).not.toHaveBeenCalled();
  });
});

describe('tools', () => {
  test('close_meeting_task defaults to dry-run', async () => {
    const svc = new AutotaskService(config, logger);
    const spy = jest.spyOn(svc, 'closeMeetingTask').mockResolvedValue({ status: 'dry_run', taskID: 1, wouldClose: true, blockers: [] });
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_close_meeting_task', { taskID: 1 });
    expect((spy.mock.calls[0][0] as any).dryRun).toBe(true);
    expect(r.content[0].text).toContain('DRY RUN');
  });

  test('verify_task_time_entries requires dateWorked', async () => {
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);
    const r = await handler.callTool('autotask_verify_task_time_entries', { taskID: 1 });
    expect(r.content[0].text).toContain('dateWorked');
  });
});
