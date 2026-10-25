// Time-entry completeness (brief §4.8): get + update, fractional hours,
// actual vs billing-rounded hours distinguishable on readback.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
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
function mockRoutes(routes: Array<{ method: string; path: RegExp; response: { status: number; body?: any } }>): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string; const init = (args[1] || {}) as RequestInit;
    const m = routes.find(r => r.method === (init.method || 'GET') && r.path.test(url));
    return Promise.resolve(m ? res(m.response.status, m.response.body) : res(599, { errors: [`unexpected ${init.method} ${url}`] }));
  });
}
function bodyAt(mock: jest.SpyInstance, i: number): any { return JSON.parse((mock.mock.calls[i][1] as RequestInit).body as string); }

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('time-entry get/update (§4.8)', () => {
  test('getTimeEntry returns both actual and billing-rounded hours', async () => {
    mockRoutes([{ method: 'GET', path: /\/TimeEntries\/500$/, response: { status: 200, body: { item: { id: 500, hoursWorked: 0.1, hoursToBill: 0.25 } } } }]);
    const entry = await new AutotaskService(config, logger).getTimeEntry(500);
    expect(entry).toMatchObject({ hoursWorked: 0.1, hoursToBill: 0.25 });
    expect(entry!.hoursWorked).not.toBe(entry!.hoursToBill);
  });

  test('updateTimeEntry uses collection PATCH /TimeEntries with fractional hours', async () => {
    const mock = mockRoutes([{ method: 'PATCH', path: /\/TimeEntries$/, response: { status: 200, body: { itemId: 500 } } }]);
    await new AutotaskService(config, logger).updateTimeEntry(500, { hoursWorked: 0.1 } as any);
    expect(mock.mock.calls.map((c: any[]) => new URL(c[0] as string).pathname)).toEqual(['/ATServicesRest/v1.0/TimeEntries']);
    expect(bodyAt(mock, 0)).toEqual({ id: 500, hoursWorked: 0.1 });
  });

  test('create posts a ticket time entry to top-level /TimeEntries with ticketID in the body (#72)', async () => {
    const mock = mockRoutes([{ method: 'POST', path: /\/TimeEntries$/, response: { status: 200, body: { itemId: 700 } } }]);
    const id = await new AutotaskService(config, logger).createTimeEntry({
      ticketID: 204722, hoursWorked: 0.1, showOnInvoice: false, summaryNotes: 'Sales', billingCodeID: 42,
    } as any);
    expect(id).toBe(700);
    expect(new URL(mock.mock.calls[0][0] as string).pathname).toBe('/ATServicesRest/v1.0/TimeEntries');
    const body = bodyAt(mock, 0);
    expect(body).toMatchObject({ ticketID: 204722, hoursWorked: 0.1, showOnInvoice: false, billingCodeID: 42 });
  });

  test('create drops projectID and rejects a project-only time entry (#72)', async () => {
    await expect(
      new AutotaskService(config, logger).createTimeEntry({ projectID: 9, hoursWorked: 1, summaryNotes: 'x' } as any)
    ).rejects.toThrow(/project TASK/i);
  });

  test('create posts a task time entry to top-level /TimeEntries with taskID (projectID dropped) (#72)', async () => {
    const mock = mockRoutes([{ method: 'POST', path: /\/TimeEntries$/, response: { status: 200, body: { itemId: 701 } } }]);
    const id = await new AutotaskService(config, logger).createTimeEntry({
      taskID: 55, projectID: 9, hoursWorked: 2, summaryNotes: 'work',
    } as any);
    expect(id).toBe(701);
    const body = bodyAt(mock, 0);
    expect(body).toMatchObject({ taskID: 55, hoursWorked: 2 });
    expect(body).not.toHaveProperty('projectID');
  });

  test('update tool dispatches through the handler', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'updateTimeEntry').mockResolvedValue(undefined as any);
    const handler = new AutotaskToolHandler(service, logger);
    await handler.callTool('autotask_update_time_entry', { id: 500, hoursWorked: 0.25, showOnInvoice: true });
    expect(spy.mock.calls[0][0]).toBe(500);
    expect(spy.mock.calls[0][1]).toEqual(expect.objectContaining({ hoursWorked: 0.25, showOnInvoice: true }));
  });

  test('both new tools are defined', () => {
    const names = new Set(TOOL_DEFINITIONS.map(t => t.name));
    expect(names.has('autotask_get_time_entry')).toBe(true);
    expect(names.has('autotask_update_time_entry')).toBe(true);
  });
});
