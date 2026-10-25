// Task read/write/complete + phase association (Phase 4 §4.2/§4.4/§5.3, #45). Mocked.

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

describe('task CRUD', () => {
  test('getTask returns the fetched task', async () => {
    const svc = withHttp({ get: jest.fn().mockResolvedValue({ id: 9, phaseID: 100, title: 'Cabling' }) });
    expect(await svc.getTask(9)).toMatchObject({ id: 9, phaseID: 100 });
  });

  test('createTask forwards phaseID', async () => {
    const childCreate = jest.fn().mockResolvedValue(50);
    const svc = withHttp({ childCreate });
    await svc.createTask({ projectID: 152, title: 'Drop', status: 1, phaseID: 100 } as any);
    expect(childCreate).toHaveBeenCalledWith('Projects', 152, 'Tasks', expect.objectContaining({ phaseID: 100 }));
  });

  test('updateTask requires projectID and PATCHes via the child route', async () => {
    const childUpdate = jest.fn().mockResolvedValue(undefined);
    const svc = withHttp({ childUpdate });
    await svc.updateTask(9, { projectID: 152, phaseID: 101 } as any);
    expect(childUpdate).toHaveBeenCalledWith('Projects', 152, 'Tasks', 9, expect.objectContaining({ phaseID: 101 }));
    await expect(svc.updateTask(9, {} as any)).rejects.toThrow(/projectID/);
  });

  test('completeTask resolves "Complete" from metadata + looks up projectID', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getFieldInfo').mockResolvedValue([
      { name: 'status', label: 'Status', dataType: 'integer', isRequired: false, isReadOnly: false, isQueryable: true, isReference: false, picklistValues: [
        { value: 1, label: 'New', isDefaultValue: true, isActive: true },
        { value: 5, label: 'Complete', isDefaultValue: false, isActive: true },
      ] },
    ] as any);
    jest.spyOn(svc, 'getTask').mockResolvedValue({ id: 9, projectID: 152 } as any);
    const upd = jest.spyOn(svc, 'updateTask').mockResolvedValue(undefined);

    await svc.completeTask(9);
    expect(upd).toHaveBeenCalledWith(9, expect.objectContaining({ projectID: 152, status: 5 }));
    expect(upd.mock.calls[0][1]).toHaveProperty('completedDateTime');
  });

  test('completeTask honors an explicit statusId + projectID (no lookups)', async () => {
    const svc = withHttp({});
    const getTask = jest.spyOn(svc, 'getTask');
    const upd = jest.spyOn(svc, 'updateTask').mockResolvedValue(undefined);
    await svc.completeTask(9, { projectID: 152, statusId: 7 });
    expect(getTask).not.toHaveBeenCalled();
    expect(upd).toHaveBeenCalledWith(9, expect.objectContaining({ status: 7, projectID: 152 }));
  });
});
