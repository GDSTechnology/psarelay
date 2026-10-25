// Permission gating (Expansion Spec §4.2, issue #15). Effective permission =
// caller's functional role ∩ tool risk. Disabled unless MCP_PERMISSIONS_ENABLED.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import {
  parseRoleMap,
  resolveRole,
  evaluatePermission,
  isPermissionsEnabled,
} from '../src/utils/permissions';
import type { CallerContext } from '../src/types/context';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' },
};

const ctxWith = (over: Partial<CallerContext> = {}): CallerContext => ({
  source: 'hermes-teams', correlationId: 'c1', timestamp: new Date().toISOString(), ...over,
});

function toolData(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0].text).data;
}

afterEach(() => {
  delete process.env.MCP_PERMISSIONS_ENABLED;
  delete process.env.AUTOTASK_ROLE_MAP;
  delete process.env.AUTOTASK_DEFAULT_ROLE;
  jest.restoreAllMocks();
});

describe('role map + resolution', () => {
  test('parses email/teams/resource keys, skips invalid roles, normalizes case & separators', () => {
    const map = parseRoleMap('JF@gds.com=Administrator; dispatch@gds.com=dispatcher\n5=project_manager; bad@x.com=wizard');
    expect(map.get('jf@gds.com')).toBe('administrator');
    expect(map.get('dispatch@gds.com')).toBe('dispatcher');
    expect(map.get('5')).toBe('project-manager');
    expect(map.has('bad@x.com')).toBe(false);
  });

  test('resolveRole prefers email, falls back to AUTOTASK_DEFAULT_ROLE', () => {
    const map = parseRoleMap('jf@gds.com=finance');
    expect(resolveRole(ctxWith({ requestingUserEmail: 'JF@gds.com' }), map)).toBe('finance');
    expect(resolveRole(ctxWith({ requestingUserEmail: 'nobody@x.com' }), map)).toBeUndefined();
    expect(resolveRole(ctxWith({ requestingUserEmail: 'nobody@x.com' }), map, { AUTOTASK_DEFAULT_ROLE: 'staff' } as any)).toBe('staff');
  });
});

describe('permission evaluation', () => {
  test('reads are always allowed, even without a role', () => {
    expect(evaluatePermission(undefined, 'read-only').allowed).toBe(true);
  });

  test('unmapped caller cannot mutate', () => {
    const d = evaluatePermission(undefined, 'reversible-update');
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/no functional role/i);
  });

  test('staff can do reversible updates but not financial or destructive', () => {
    expect(evaluatePermission('staff', 'reversible-update').allowed).toBe(true);
    expect(evaluatePermission('staff', 'financial').allowed).toBe(false);
    expect(evaluatePermission('staff', 'destructive').allowed).toBe(false);
  });

  test('finance can do financial; only administrator can do destructive', () => {
    expect(evaluatePermission('finance', 'financial').allowed).toBe(true);
    expect(evaluatePermission('finance', 'destructive').allowed).toBe(false);
    expect(evaluatePermission('administrator', 'destructive').allowed).toBe(true);
  });
});

describe('isPermissionsEnabled', () => {
  test('off by default, on only for "true"', () => {
    expect(isPermissionsEnabled({} as any)).toBe(false);
    expect(isPermissionsEnabled({ MCP_PERMISSIONS_ENABLED: 'false' } as any)).toBe(false);
    expect(isPermissionsEnabled({ MCP_PERMISSIONS_ENABLED: 'TRUE' } as any)).toBe(true);
  });
});

describe('permission gate in callTool', () => {
  const META = { source: 'hermes-teams', requestingUserEmail: 'staff@gds.com' };

  test('disabled by default: staff can invoke a financial tool (no gating)', async () => {
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service as any, 'createContracts').mockResolvedValue([{ index: 0, success: true, id: 1 }]);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool('autotask_create_contracts_bulk', { contracts: [{ companyID: 1 }], confirm: true }, META);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('enabled: staff is denied a financial tool before dispatch', async () => {
    process.env.MCP_PERMISSIONS_ENABLED = 'true';
    process.env.AUTOTASK_ROLE_MAP = 'staff@gds.com=staff';
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service as any, 'createContracts').mockResolvedValue([{ index: 0, success: true, id: 1 }]);
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool('autotask_create_contracts_bulk', { contracts: [{ companyID: 1 }], confirm: true }, META);

    expect(toolData(result)).toMatchObject({ status: 'permission_denied', role: 'staff', riskLevel: 'financial' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('enabled: finance is allowed the same financial tool', async () => {
    process.env.MCP_PERMISSIONS_ENABLED = 'true';
    process.env.AUTOTASK_ROLE_MAP = 'fin@gds.com=finance';
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service as any, 'createContracts').mockResolvedValue([{ index: 0, success: true, id: 1 }]);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool(
      'autotask_create_contracts_bulk',
      { contracts: [{ companyID: 1 }], confirm: true },
      { source: 'hermes-teams', requestingUserEmail: 'fin@gds.com' }
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('enabled: reads are allowed for an unmapped caller', async () => {
    process.env.MCP_PERMISSIONS_ENABLED = 'true';
    const service = new AutotaskService(config, logger);
    const spy = jest.spyOn(service, 'getContract').mockResolvedValue({ id: 55 } as any);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool('autotask_get_contract', { id: 55 }, { source: 'hermes-teams', requestingUserEmail: 'ghost@x.com' });
    expect(spy).toHaveBeenCalledWith(55);
  });
});
