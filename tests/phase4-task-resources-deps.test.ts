// Task secondary resources + predecessors (Phase 4 §5.4/§5.5, #45). Mocked http.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
function withHttp(fake: any) {
  const service = new AutotaskService(config, logger);
  jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fake);
  return service;
}
afterEach(() => jest.restoreAllMocks());

describe('task secondary resources', () => {
  test('list queries by taskID', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 1, resourceID: 5, roleID: 9 }]);
    const svc = withHttp({ query });
    const r = await svc.listTaskResources(42);
    expect(query).toHaveBeenCalledWith('TaskSecondaryResources', [{ op: 'eq', field: 'taskID', value: 42 }], expect.anything());
    expect(r).toHaveLength(1);
  });
  test('add creates a row with taskID/resourceID(+role)', async () => {
    const create = jest.fn().mockResolvedValue(77);
    const svc = withHttp({ create });
    expect(await svc.addTaskResource(42, 5, 9)).toBe(77);
    expect(create).toHaveBeenCalledWith('TaskSecondaryResources', { taskID: 42, resourceID: 5, roleID: 9 });
  });
  test('remove deletes by row id', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    const svc = withHttp({ delete: del });
    await svc.removeTaskResource(77);
    expect(del).toHaveBeenCalledWith('TaskSecondaryResources', 77);
  });
});

describe('task predecessors', () => {
  test('list queries by successorTaskID', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 3, predecessorTaskID: 10, successorTaskID: 20, lagDays: 0 }]);
    const svc = withHttp({ query });
    await svc.listTaskPredecessors(20);
    expect(query).toHaveBeenCalledWith('TaskPredecessors', [{ op: 'eq', field: 'successorTaskID', value: 20 }], expect.anything());
  });
  test('add links predecessor → successor with lag', async () => {
    const create = jest.fn().mockResolvedValue(88);
    const svc = withHttp({ create });
    expect(await svc.addTaskPredecessor(20, 10, 2)).toBe(88);
    expect(create).toHaveBeenCalledWith('TaskPredecessors', { successorTaskID: 20, predecessorTaskID: 10, lagDays: 2 });
  });
  test('remove deletes by row id', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    const svc = withHttp({ delete: del });
    await svc.removeTaskPredecessor(88);
    expect(del).toHaveBeenCalledWith('TaskPredecessors', 88);
  });
});
