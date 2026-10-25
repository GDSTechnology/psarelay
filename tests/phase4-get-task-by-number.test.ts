// autotask_get_task_by_number: resolve a human-facing task number
// ("T20260922.0189") to the FULL task object in one call. Exact match on
// taskNumber; >1 hit is ambiguous, 0 is not-found, blank short-circuits.

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

/** Mock POST /Tasks/query (returns `queryRows`) and GET /Tasks/{id} (returns `full`). */
function mockTasks(queryRows: any[], full?: any): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    const init = (args[1] || {}) as RequestInit;
    if (init.method === 'POST' && /\/Tasks\/query$/.test(url)) {
      return Promise.resolve(res(200, { items: queryRows }));
    }
    if ((!init.method || init.method === 'GET') && /\/Tasks\/\d+$/.test(url)) {
      return Promise.resolve(res(200, { item: full ?? null }));
    }
    return Promise.resolve(res(599, { errors: [`unexpected ${init.method} ${url}`] }));
  });
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('AutotaskService.getTaskByNumber', () => {
  test('single match -> found, returns the full task via by-id GET', async () => {
    const full = { id: 208749, taskNumber: 'T20260922.0189', title: 'RPO Meeting', projectID: 181, status: 1 };
    const fetchMock = mockTasks([{ id: 208749, taskNumber: 'T20260922.0189', title: 'RPO Meeting' }], full);
    const out = await new AutotaskService(config, logger).getTaskByNumber('T20260922.0189');
    expect(out).toEqual({ status: 'found', taskNumber: 'T20260922.0189', task: full });
    // proves it did the second by-id GET, not just the query row
    const paths = fetchMock.mock.calls.map((c: any[]) => new URL(c[0] as string).pathname);
    expect(paths).toEqual(expect.arrayContaining([
      '/ATServicesRest/v1.0/Tasks/query',
      '/ATServicesRest/v1.0/Tasks/208749',
    ]));
  });

  test('trims the input before matching', async () => {
    const full = { id: 208749, taskNumber: 'T20260922.0189', title: 'RPO Meeting' };
    mockTasks([{ id: 208749, taskNumber: 'T20260922.0189' }], full);
    const out = await new AutotaskService(config, logger).getTaskByNumber('  T20260922.0189  ');
    expect(out.status).toBe('found');
    expect(out.taskNumber).toBe('T20260922.0189');
  });

  test('no hits -> not-found (no by-id GET)', async () => {
    const fetchMock = mockTasks([]);
    const out = await new AutotaskService(config, logger).getTaskByNumber('T20260922.9999');
    expect(out).toEqual({ status: 'not-found', taskNumber: 'T20260922.9999' });
    const paths = fetchMock.mock.calls.map((c: any[]) => new URL(c[0] as string).pathname);
    expect(paths).not.toContain(expect.stringMatching(/\/Tasks\/\d+$/));
  });

  test('more than one hit -> ambiguous with matches, no task fetched', async () => {
    mockTasks([
      { id: 1, taskNumber: 'T1.1', title: 'A' },
      { id: 2, taskNumber: 'T1.1', title: 'B' },
    ]);
    const out = await new AutotaskService(config, logger).getTaskByNumber('T1.1');
    expect(out.status).toBe('ambiguous');
    expect(out.task).toBeUndefined();
    expect(out.matches?.map((m) => m.id).sort()).toEqual([1, 2]);
  });

  test('blank input short-circuits without querying', async () => {
    const fetchMock = mockTasks([]);
    const out = await new AutotaskService(config, logger).getTaskByNumber('   ');
    expect(out).toEqual({ status: 'not-found', taskNumber: '' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('autotask_get_task_by_number tool', () => {
  test('found -> human message names the resolved id', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'getTaskByNumber').mockResolvedValue({
      status: 'found',
      taskNumber: 'T20260922.0189',
      task: { id: 208749 } as any,
    });
    const handler = new AutotaskToolHandler(service, logger);
    const result = await handler.callTool('autotask_get_task_by_number', { taskNumber: 'T20260922.0189' });
    expect(result.content[0].text).toContain('208749');
  });

  test('ambiguous -> message lists the candidate ids', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'getTaskByNumber').mockResolvedValue({
      status: 'ambiguous',
      taskNumber: 'T1.1',
      matches: [{ id: 1 }, { id: 2 }],
    });
    const handler = new AutotaskToolHandler(service, logger);
    const result = await handler.callTool('autotask_get_task_by_number', { taskNumber: 'T1.1' });
    expect(result.content[0].text).toContain('1, 2');
  });
});
