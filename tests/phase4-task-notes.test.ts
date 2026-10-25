// Task notes (Phase 4 §5.6, #45) — child of Tasks via the note-impl pattern. Mocked.

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

describe('task notes', () => {
  test('searchTaskNotes queries the Tasks/Notes child route', async () => {
    const childQuery = jest.fn().mockResolvedValue([{ id: 1, description: 'hi' }]);
    const svc = withHttp({ childQuery });
    const r = await svc.searchTaskNotes(42);
    expect(childQuery).toHaveBeenCalledWith('Tasks', 42, 'Notes', expect.anything(), expect.anything());
    expect(r).toHaveLength(1);
  });

  test('getTaskNote reads via Tasks/Notes child route', async () => {
    const childGet = jest.fn().mockResolvedValue({ id: 9, description: 'note' });
    const svc = withHttp({ childGet });
    await svc.getTaskNote(42, 9);
    expect(childGet).toHaveBeenCalledWith('Tasks', 42, 'Notes', 9);
  });

  test('createTaskNote posts to Tasks/Notes with taskID stamped', async () => {
    const childCreate = jest.fn().mockResolvedValue(100);
    const svc = withHttp({ childCreate });
    const id = await svc.createTaskNote(42, { description: 'progress' });
    expect(id).toBe(100);
    expect(childCreate).toHaveBeenCalledWith('Tasks', 42, 'Notes', expect.objectContaining({ description: 'progress', taskID: 42 }));
  });
});
