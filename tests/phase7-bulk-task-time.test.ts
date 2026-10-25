// autotask_create_task_time_entries_bulk: one time entry per attendee against a
// single project task, dry-run first, rerun-safe (idempotent), and
// validate-all-before-write. Result is verification-shaped for a closeout gate.

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

/** Mock the TimeEntries/query probe (the only raw fetch the method makes directly). */
function mockDayEntries(rows: any[]): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    if (/\/TimeEntries\/query$/.test(url)) return Promise.resolve(res(200, { items: rows }));
    return Promise.resolve(res(599, { errors: [`unexpected ${url}`] }));
  });
}

function svcWithResolvers() {
  const svc = new AutotaskService(config, logger);
  jest.spyOn(svc, 'resolveResourceByName').mockImplementation(async (name: string) => {
    const map: Record<string, number> = { 'Jonathan Fitzgerald': 100, 'Cain Gillespie': 200 };
    return map[name] ? { id: map[name], firstName: name.split(' ')[0], lastName: name.split(' ')[1] } : null;
  });
  jest.spyOn(svc, 'resolveWorkTimeEntryRole').mockResolvedValue({ roleID: 999 } as any);
  return svc;
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('createTaskTimeEntriesBulk', () => {
  const base = {
    taskID: 208749,
    dateWorked: '2026-09-23',
    entries: [
      { resourceName: 'Jonathan Fitzgerald', hoursWorked: 0.87, summaryNotes: 'Led the RPO review' },
      { resourceName: 'Cain Gillespie', hoursWorked: 0.5, summaryNotes: 'Covered network items' },
    ],
  };

  test('dry-run (default): plans, resolves, writes nothing', async () => {
    const svc = svcWithResolvers();
    const log = jest.spyOn(svc, 'logTimeIdempotent');
    mockDayEntries([]);

    const out = await svc.createTaskTimeEntriesBulk({ ...base, dryRun: true });

    expect(out.dryRun).toBe(true);
    expect(out.written).toBe(false);
    expect(out.wouldCreate).toBe(2);
    expect(out.created).toBe(0);
    expect(out.results.every((r) => r.status === 'would_create')).toBe(true);
    expect(out.results[0].resourceID).toBe(100);
    expect(out.results[0].roleID).toBe(999);
    expect(log).not.toHaveBeenCalled();
  });

  test('dry-run flags an existing entry as duplicate (resource + summary match)', async () => {
    const svc = svcWithResolvers();
    mockDayEntries([{ id: 55000, resourceID: 100, summaryNotes: 'Led the RPO review' }]);

    const out = await svc.createTaskTimeEntriesBulk({ ...base, dryRun: true });

    const jf = out.results.find((r) => r.resourceID === 100)!;
    expect(jf.status).toBe('duplicate');
    expect(jf.duplicateOf).toBe(55000);
    expect(out.duplicates).toBe(1);
    expect(out.wouldCreate).toBe(1);
  });

  test('commit (dryRun:false): writes via the idempotent path, reports created ids', async () => {
    const svc = svcWithResolvers();
    const log = jest.spyOn(svc, 'logTimeIdempotent')
      .mockResolvedValueOnce({ created: true, id: 60001 })
      .mockResolvedValueOnce({ created: true, id: 60002 });
    mockDayEntries([]);

    const out = await svc.createTaskTimeEntriesBulk({ ...base, dryRun: false });

    expect(out.written).toBe(true);
    expect(out.created).toBe(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(out.results.map((r) => r.id).sort()).toEqual([60001, 60002]);
    // idempotent path received taskID + roleID
    expect((log.mock.calls[0][0] as any).taskID).toBe(208749);
    expect((log.mock.calls[0][0] as any).roleID).toBe(999);
  });

  test('validate-all-before-write: an unresolved name blocks ALL writes even on commit', async () => {
    const svc = svcWithResolvers();
    const log = jest.spyOn(svc, 'logTimeIdempotent');
    mockDayEntries([]);

    const out = await svc.createTaskTimeEntriesBulk({
      taskID: 208749,
      dateWorked: '2026-09-23',
      dryRun: false,
      entries: [
        { resourceName: 'Jonathan Fitzgerald', hoursWorked: 1, summaryNotes: 'x' },
        { resourceName: 'Nobody McGhost', hoursWorked: 1, summaryNotes: 'y' },
      ],
    });

    expect(out.errors).toBe(1);
    expect(out.written).toBe(false);
    expect(out.created).toBe(0);
    expect(log).not.toHaveBeenCalled(); // atomic gate
    expect(out.results.find((r) => r.resourceName === 'Nobody McGhost')!.error).toMatch(/No active resource/);
  });

  test('role needs selection -> that entry errors with choices', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'resolveResourceByName').mockResolvedValue({ id: 100, firstName: 'J', lastName: 'F' });
    jest.spyOn(svc, 'resolveWorkTimeEntryRole').mockResolvedValue({ needsSelection: [{ roleID: 1, roleName: 'Consultant' }, { roleID: 2, roleName: 'Engineer' }] } as any);
    mockDayEntries([]);

    const out = await svc.createTaskTimeEntriesBulk({
      taskID: 208749, dateWorked: '2026-09-23', dryRun: true,
      entries: [{ resourceName: 'Someone Multi', hoursWorked: 1, summaryNotes: 'z' }],
    });

    expect(out.errors).toBe(1);
    expect(out.results[0].needsSelection).toHaveLength(2);
  });
});

describe('autotask_create_task_time_entries_bulk tool', () => {
  test('defaults to dry-run and reports the plan', async () => {
    const svc = new AutotaskService(config, logger);
    const spy = jest.spyOn(svc, 'createTaskTimeEntriesBulk').mockResolvedValue({
      taskID: 208749, dateWorked: '2026-09-23', dryRun: true, planned: 2, wouldCreate: 2,
      duplicates: 0, errors: 0, created: 0, written: false, results: [],
    });
    const handler = new AutotaskToolHandler(svc, logger);
    const result = await handler.callTool('autotask_create_task_time_entries_bulk', {
      taskID: 208749, dateWorked: '2026-09-23', entries: [{ hoursWorked: 1, summaryNotes: 'x' }],
    });
    expect((spy.mock.calls[0][0] as any).dryRun).toBe(true); // default
    expect(result.content[0].text).toContain('DRY RUN');
  });

  test('missing entries -> guardrail message', async () => {
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);
    const result = await handler.callTool('autotask_create_task_time_entries_bulk', { taskID: 1, dateWorked: '2026-09-23', entries: [] });
    expect(result.content[0].text).toContain('entries[] is required');
  });
});
