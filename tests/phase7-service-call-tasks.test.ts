// Service calls on TASKS (parallel to the ticket side): a service call can attach
// to a project task so scheduled work carries its resources onto the calendar.
// Child routes: POST /ServiceCalls/{id}/Tasks and
// POST /ServiceCallTasks/{id}/Resources (root collections don't exist → 404).

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'integration-code', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' },
};

function res(spec: { status: number; body?: any; text?: string }): Response {
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    headers: { get: () => null },
    text: async () => (spec.text !== undefined ? spec.text : spec.body !== undefined ? JSON.stringify(spec.body) : ''),
  } as unknown as Response;
}
function mockFetchRoutes(routes: Array<{ method: string; path: RegExp; response: { status: number; body?: any } }>): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    const init = (args[1] || {}) as RequestInit;
    const match = routes.find((r) => r.method === (init.method || 'GET') && r.path.test(url));
    if (!match) return Promise.resolve(res({ status: 599, text: `unexpected: ${init.method} ${url}` }));
    return Promise.resolve(res(match.response));
  });
}
const calledRoutes = (m: jest.SpyInstance): string[] =>
  m.mock.calls.map((c: any[]) => `${(c[1] as RequestInit).method} ${new URL(c[0] as string).pathname}`);

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('createServiceCallTask() child route', () => {
  test('creates via POST /ServiceCalls/{serviceCallID}/Tasks', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'POST', path: /\/ServiceCalls\/4733\/Tasks$/, response: { status: 200, body: { itemId: 8801 } } },
    ]);
    const service = new AutotaskService(config, logger);
    const id = await service.createServiceCallTask({ serviceCallID: 4733, taskID: 177001 });
    expect(id).toBe(8801);
    expect(calledRoutes(fetchMock)).toEqual(['POST /ATServicesRest/v1.0/ServiceCalls/4733/Tasks']);
    expect(calledRoutes(fetchMock)).not.toContain('POST /ATServicesRest/v1.0/ServiceCallTasks');
  });

  test('throws without hitting the API when serviceCallID is missing', async () => {
    const fetchMock = mockFetchRoutes([]);
    const service = new AutotaskService(config, logger);
    await expect(service.createServiceCallTask({ taskID: 177001 })).rejects.toThrow(/serviceCallID is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createServiceCallTaskResource() child route', () => {
  test('creates via POST /ServiceCallTasks/{serviceCallTaskID}/Resources', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'POST', path: /\/ServiceCallTasks\/8801\/Resources$/, response: { status: 200, body: { itemId: 9902 } } },
    ]);
    const service = new AutotaskService(config, logger);
    const id = await service.createServiceCallTaskResource({ serviceCallTaskID: 8801, resourceID: 29682885 });
    expect(id).toBe(9902);
    expect(calledRoutes(fetchMock)).toEqual(['POST /ATServicesRest/v1.0/ServiceCallTasks/8801/Resources']);
    expect(calledRoutes(fetchMock)).not.toContain('POST /ATServicesRest/v1.0/ServiceCallTaskResources');
  });

  test('throws without hitting the API when serviceCallTaskID is missing', async () => {
    const fetchMock = mockFetchRoutes([]);
    const service = new AutotaskService(config, logger);
    await expect(service.createServiceCallTaskResource({ resourceID: 29682885 })).rejects.toThrow(/serviceCallTaskID is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('searchServiceCallTasks() filters', () => {
  test('filters by taskId against ServiceCallTasks (POST /query, filter in body)', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'POST', path: /\/ServiceCallTasks\/query$/, response: { status: 200, body: { items: [{ id: 1, serviceCallID: 4733, taskID: 177001 }] } } },
    ]);
    const service = new AutotaskService(config, logger);
    const rows = await service.searchServiceCallTasks({ taskId: 177001 } as any);
    expect(rows).toHaveLength(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.filter).toEqual([{ op: 'eq', field: 'taskID', value: 177001 }]);
  });
});

describe('delete task-side associations', () => {
  test('deleteServiceCallTask DELETEs the root record by id', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'DELETE', path: /\/ServiceCallTasks\/8801$/, response: { status: 200, body: {} } },
    ]);
    const service = new AutotaskService(config, logger);
    await service.deleteServiceCallTask(8801);
    expect(calledRoutes(fetchMock)).toEqual(['DELETE /ATServicesRest/v1.0/ServiceCallTasks/8801']);
  });

  test('deleteServiceCallTaskResource DELETEs the root record by id', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'DELETE', path: /\/ServiceCallTaskResources\/9902$/, response: { status: 200, body: {} } },
    ]);
    const service = new AutotaskService(config, logger);
    await service.deleteServiceCallTaskResource(9902);
    expect(calledRoutes(fetchMock)).toEqual(['DELETE /ATServicesRest/v1.0/ServiceCallTaskResources/9902']);
  });
});
