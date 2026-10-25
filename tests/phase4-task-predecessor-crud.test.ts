// TaskPredecessor CRUD completion (plan §7). The scheduler work (#46) shipped
// list/add/remove; this fills get/search/update. Semantics verified against the
// live Autotask TaskPredecessor entity: 4 fields, and predecessorTaskID /
// successorTaskID are readonly — only lagDays is updatable. Mocked http.

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

describe('getTaskPredecessor', () => {
  test('reads a row by id', async () => {
    const get = jest.fn().mockResolvedValue({ id: 4, predecessorTaskID: 17969, successorTaskID: 17978, lagDays: 0 });
    const svc = withHttp({ get });
    expect(await svc.getTaskPredecessor(4)).toMatchObject({ id: 4, predecessorTaskID: 17969, successorTaskID: 17978 });
    expect(get).toHaveBeenCalledWith('TaskPredecessors', 4);
  });

  test('returns null when the row does not exist', async () => {
    const svc = withHttp({ get: jest.fn().mockResolvedValue(null) });
    expect(await svc.getTaskPredecessor(999)).toBeNull();
  });
});

describe('searchTaskPredecessors', () => {
  test('filters by successorTaskID (what a task waits on)', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 4 }]);
    const svc = withHttp({ query });
    const rows = await svc.searchTaskPredecessors({ successorTaskID: 17978 });
    expect(rows).toEqual([{ id: 4 }]);
    expect(query).toHaveBeenCalledWith(
      'TaskPredecessors',
      [{ op: 'eq', field: 'successorTaskID', value: 17978 }],
      expect.objectContaining({ includeFields: ['id', 'predecessorTaskID', 'successorTaskID', 'lagDays'] })
    );
  });

  test('filters by predecessorTaskID (what waits on a task)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = withHttp({ query });
    await svc.searchTaskPredecessors({ predecessorTaskID: 17969 });
    expect(query).toHaveBeenCalledWith(
      'TaskPredecessors',
      [{ op: 'eq', field: 'predecessorTaskID', value: 17969 }],
      expect.anything()
    );
  });

  test('combines both endpoints when given', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const svc = withHttp({ query });
    await svc.searchTaskPredecessors({ successorTaskID: 2, predecessorTaskID: 1 });
    expect(query).toHaveBeenCalledWith(
      'TaskPredecessors',
      [
        { op: 'eq', field: 'successorTaskID', value: 2 },
        { op: 'eq', field: 'predecessorTaskID', value: 1 },
      ],
      expect.anything()
    );
  });

  test('returns [] and does NOT query the whole tenant when unfiltered', async () => {
    const query = jest.fn();
    const svc = withHttp({ query });
    expect(await svc.searchTaskPredecessors({})).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('updateTaskPredecessor', () => {
  test('updates only lagDays (task refs are readonly in Autotask)', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const svc = withHttp({ update });
    await svc.updateTaskPredecessor(4, 3);
    expect(update).toHaveBeenCalledWith('TaskPredecessors', 4, { lagDays: 3 });
  });
});
