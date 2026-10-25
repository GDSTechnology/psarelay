// Raw-request gatekeeping (Expansion Spec §3.4, issue #17). administrator-only
// under permissions, DELETE disabled by default, production read-only switch.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import { evaluateRawRequest } from '../src/utils/raw-gate';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' },
};

function toolData(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0].text).data;
}

afterEach(() => {
  delete process.env.MCP_PERMISSIONS_ENABLED;
  delete process.env.AUTOTASK_ROLE_MAP;
  delete process.env.MCP_RAW_ALLOW_DELETE;
  delete process.env.MCP_RAW_READONLY;
  jest.restoreAllMocks();
});

describe('evaluateRawRequest', () => {
  test('permissions off: GET/POST allowed for anyone', () => {
    expect(evaluateRawRequest({ method: 'GET', permissionsEnabled: false, env: {} as any }).allowed).toBe(true);
    expect(evaluateRawRequest({ method: 'POST', permissionsEnabled: false, env: {} as any }).allowed).toBe(true);
  });

  test('permissions on: administrator required', () => {
    expect(evaluateRawRequest({ method: 'GET', role: 'staff', permissionsEnabled: true, env: {} as any }).allowed).toBe(false);
    expect(evaluateRawRequest({ method: 'GET', role: 'administrator', permissionsEnabled: true, env: {} as any }).allowed).toBe(true);
  });

  test('DELETE disabled by default, allowed with MCP_RAW_ALLOW_DELETE=true', () => {
    expect(evaluateRawRequest({ method: 'DELETE', permissionsEnabled: false, env: {} as any }).allowed).toBe(false);
    expect(evaluateRawRequest({ method: 'DELETE', permissionsEnabled: false, env: { MCP_RAW_ALLOW_DELETE: 'true' } as any }).allowed).toBe(true);
  });

  test('MCP_RAW_READONLY blocks mutating methods, allows GET', () => {
    const env = { MCP_RAW_READONLY: 'true' } as any;
    expect(evaluateRawRequest({ method: 'POST', permissionsEnabled: false, env }).allowed).toBe(false);
    expect(evaluateRawRequest({ method: 'PATCH', permissionsEnabled: false, env }).allowed).toBe(false);
    expect(evaluateRawRequest({ method: 'GET', permissionsEnabled: false, env }).allowed).toBe(true);
  });

  test('admin check precedes method checks', () => {
    // A non-admin DELETE is denied for being non-admin, regardless of DELETE policy.
    const d = evaluateRawRequest({ method: 'DELETE', role: 'staff', permissionsEnabled: true, env: { MCP_RAW_ALLOW_DELETE: 'true' } as any });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/administrator-only/i);
  });
});

describe('raw gate in callTool', () => {
  test('DELETE via raw_request is denied by default; service not called', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'rawRequest').mockResolvedValue({} as any);
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool('autotask_raw_request', { method: 'DELETE', path: '/Tickets/1' });

    expect(toolData(result)).toMatchObject({ status: 'raw_request_denied', method: 'DELETE' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('GET via raw_request passes the gate and reaches the service', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'rawRequest').mockResolvedValue({ ok: true } as any);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool('autotask_raw_request', { method: 'GET', path: '/Tickets/1' });
    expect(spy).toHaveBeenCalledWith('GET', '/Tickets/1', undefined, undefined);
  });

  test('permissions on: non-admin raw_request denied before dispatch', async () => {
    process.env.MCP_PERMISSIONS_ENABLED = 'true';
    process.env.AUTOTASK_ROLE_MAP = 'staff@gds.com=staff';
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'rawRequest').mockResolvedValue({} as any);
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool(
      'autotask_raw_request',
      { method: 'GET', path: '/Tickets/1' },
      { source: 'hermes-teams', requestingUserEmail: 'staff@gds.com' }
    );

    expect(toolData(result)).toMatchObject({ status: 'raw_request_denied' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('permissions on: administrator raw_request allowed', async () => {
    process.env.MCP_PERMISSIONS_ENABLED = 'true';
    process.env.AUTOTASK_ROLE_MAP = 'admin@gds.com=administrator';
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'rawRequest').mockResolvedValue({ ok: true } as any);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool(
      'autotask_raw_request',
      { method: 'GET', path: '/Tickets/1' },
      { source: 'hermes-teams', requestingUserEmail: 'admin@gds.com' }
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
