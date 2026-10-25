// Phase read/write + nested-phase support (Phase 4 §4.1/§5.2, #45). Mocked http.

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

describe('phase CRUD', () => {
  test('getPhase returns the fetched phase', async () => {
    const svc = withHttp({ get: jest.fn().mockResolvedValue({ id: 5, title: 'Rough In', parentPhaseID: null }) });
    expect(await svc.getPhase(5)).toMatchObject({ id: 5, title: 'Rough In' });
  });

  test('updatePhase PATCHes only provided fields', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const svc = withHttp({ update });
    await svc.updatePhase(5, { title: 'Renamed', parentPhaseID: 9 } as any);
    expect(update).toHaveBeenCalledWith('Phases', 5, expect.objectContaining({ title: 'Renamed', parentPhaseID: 9 }));
  });

  test('createPhase forwards parentPhaseID (nested phases)', async () => {
    const childCreate = jest.fn().mockResolvedValue(101);
    const svc = withHttp({ childCreate });
    const id = await svc.createPhase({ projectID: 152, title: 'Level 1', parentPhaseID: 100 } as any);
    expect(id).toBe(101);
    expect(childCreate).toHaveBeenCalledWith('Projects', 152, 'Phases', expect.objectContaining({ parentPhaseID: 100 }));
  });

  test('createPhase requires projectID', async () => {
    const svc = withHttp({ childCreate: jest.fn() });
    await expect(svc.createPhase({ title: 'x' } as any)).rejects.toThrow(/projectID/);
  });
});
