// Read-after-write verification wired through the tool handler (plan §2).
//
// Project-Builder create tools (create_project/task/phase) read the just-created
// entity back and attach `verified` (+ `item` when visible) to the normalized
// result. The create's itemId stays authoritative: a read that returns null or
// errors yields verified:false, NEVER a thrown/failed create (which would invite
// a duplicate on rerun, §42). Non-verifyRead creates are byte-for-byte unchanged.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

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

function toolData(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0].text).data;
}

function setup() {
  const service = new AutotaskService(config, logger);
  const handler = new AutotaskToolHandler(service, logger);
  return { service, handler };
}

afterEach(() => jest.restoreAllMocks());

describe('create_task read-after-write verification', () => {
  test('attaches verified:true + item when the entity reads back', async () => {
    const { service, handler } = setup();
    jest.spyOn(service, 'createTask').mockResolvedValue(207193 as any);
    const verify = jest
      .spyOn(service, 'readEntityForVerification')
      .mockResolvedValue({ id: 207193, title: 'Pre-Migration Baseline', projectID: 177, phaseID: 204954 });

    const result = await handler.callTool('autotask_create_task', {
      projectID: 177,
      title: 'Pre-Migration Baseline',
    });

    expect(verify).toHaveBeenCalledWith('Tasks', 207193);
    expect(toolData(result)).toEqual({
      id: 207193,
      entityType: 'Tasks',
      parentType: 'Projects',
      parentId: 177,
      verified: true,
      item: { id: 207193, title: 'Pre-Migration Baseline', projectID: 177, phaseID: 204954 },
    });
  });

  test('returns verified:false (no item, no throw) when the entity is not yet visible', async () => {
    const { service, handler } = setup();
    jest.spyOn(service, 'createTask').mockResolvedValue(207193 as any);
    jest.spyOn(service, 'readEntityForVerification').mockResolvedValue(null);

    const result = await handler.callTool('autotask_create_task', { projectID: 177, title: 'x' });

    expect(toolData(result)).toEqual({
      id: 207193,
      entityType: 'Tasks',
      parentType: 'Projects',
      parentId: 177,
      verified: false,
    });
  });

  test('a read-back error becomes verified:false — the create still succeeds', async () => {
    const { service, handler } = setup();
    jest.spyOn(service, 'createTask').mockResolvedValue(207193 as any);
    jest
      .spyOn(service, 'readEntityForVerification')
      .mockRejectedValue(new Error('response body was not valid JSON — likely truncated'));

    const result = await handler.callTool('autotask_create_task', { projectID: 177, title: 'x' });

    expect(toolData(result)).toMatchObject({ id: 207193, entityType: 'Tasks', verified: false });
    expect('item' in toolData(result)).toBe(false);
  });
});

describe('create_phase / create_project also verify', () => {
  test('create_phase attaches verified + item', async () => {
    const { service, handler } = setup();
    jest.spyOn(service, 'createPhase').mockResolvedValue(207178 as any);
    jest.spyOn(service, 'readEntityForVerification').mockResolvedValue({ id: 207178, title: 'PM & Readiness' });

    const result = await handler.callTool('autotask_create_phase', { projectID: 177, title: 'PM & Readiness' });
    expect(toolData(result)).toMatchObject({ id: 207178, entityType: 'Phases', verified: true, item: { id: 207178 } });
  });

  test('create_project attaches verified + item', async () => {
    const { service, handler } = setup();
    jest.spyOn(service, 'createProject').mockResolvedValue(180 as any);
    jest.spyOn(service, 'readEntityForVerification').mockResolvedValue({ id: 180, projectName: 'New' });

    const result = await handler.callTool('autotask_create_project', { companyID: 1, projectName: 'New' });
    expect(toolData(result)).toMatchObject({ id: 180, entityType: 'Projects', verified: true });
  });
});

describe('non-verifyRead creates are unchanged', () => {
  test('create_contact does not read back and keeps its exact id-only shape', async () => {
    const { service, handler } = setup();
    jest.spyOn(service, 'createContact').mockResolvedValue(555 as any);
    const verify = jest.spyOn(service, 'readEntityForVerification');

    const result = await handler.callTool('autotask_create_contact', {
      companyID: 777,
      firstName: 'Joan',
      lastName: 'Eberly',
    });

    expect(verify).not.toHaveBeenCalled();
    expect(toolData(result)).toEqual({ id: 555, entityType: 'Contacts', parentType: 'Companies', parentId: 777 });
  });
});
