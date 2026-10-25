// #42 slice 1 — role resolution + currentUser ticket assignment + role auto-fill.
// Autotask role model verified live: Resources.defaultServiceDeskRoleID, the
// ResourceRoles association, and the Roles entity. Mocked http / service.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { ACTING_RESOURCE_TOOLS, ACTING_ROLE_FIELDS } from '../src/utils/caller-resolution';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };

function withHttp(fake: any) {
  const service = new AutotaskService(config, logger);
  jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fake);
  return service;
}
const findTool = (name: string) => TOOL_DEFINITIONS.find((t) => t.name === name);
afterEach(() => jest.restoreAllMocks());

describe('role service methods (#42)', () => {
  test('searchRoles filters by name/isActive', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 1, name: 'Technician' }]);
    const svc = withHttp({ query });
    await svc.searchRoles({ searchTerm: 'Tech', isActive: true });
    const filters = query.mock.calls[0][1] as any[];
    expect(query.mock.calls[0][0]).toBe('Roles');
    expect(filters).toContainEqual({ op: 'eq', field: 'isActive', value: true });
    expect(filters).toContainEqual({ op: 'contains', field: 'name', value: 'Tech' });
  });

  test('resolveResourceDefaultRole returns defaultServiceDeskRoleID, or null', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getResource').mockResolvedValueOnce({ id: 5, defaultServiceDeskRoleID: 99 } as any);
    expect(await svc.resolveResourceDefaultRole(5)).toBe(99);
    jest.spyOn(svc, 'getResource').mockResolvedValueOnce({ id: 6 } as any);
    expect(await svc.resolveResourceDefaultRole(6)).toBeNull();
  });

  test('resolveResourceDefaultRole is best-effort (null on error)', async () => {
    const svc = withHttp({});
    jest.spyOn(svc, 'getResource').mockRejectedValue(new Error('boom'));
    expect(await svc.resolveResourceDefaultRole(5)).toBeNull();
  });

  // Route the mocked http.query by entity; `roles` answers the Roles lookup.
  const rolesHttp = (links: any[], roles: any[] | Error) => jest.fn(async (entity: string, _filter?: unknown, _opts?: unknown) => {
    if (entity === 'ResourceRoles') return links;
    if (entity === 'Roles') { if (roles instanceof Error) throw roles; return roles; }
    return [];
  });

  test('getResourceRoles enriches names and flags the default role', async () => {
    const svc = withHttp({});
    const query = rolesHttp([{ id: 1, resourceID: 5, roleID: 99 }, { id: 2, resourceID: 5, roleID: 42 }], [{ id: 99, name: 'Technician' }, { id: 42, name: 'Engineer' }]);
    jest.spyOn(svc as any, 'ensureClient').mockResolvedValue({ query });
    jest.spyOn(svc, 'getResource').mockResolvedValue({ id: 5, defaultServiceDeskRoleID: 99 } as any);
    const roles = await svc.getResourceRoles(5);
    expect(roles).toEqual([
      expect.objectContaining({ roleID: 99, roleName: 'Technician', roleExists: true, isDefaultServiceDeskRole: true }),
      expect.objectContaining({ roleID: 42, roleName: 'Engineer', roleExists: true, isDefaultServiceDeskRole: false }),
    ]);
    // Names come from an exact `in` lookup of THIS resource's roleIDs — no page cap.
    const rolesCall = query.mock.calls.find((c: any[]) => c[0] === 'Roles')!;
    expect(rolesCall[1]).toEqual([{ op: 'in', field: 'id', value: [99, 42] }]);
  });

  test('a roleID the Roles entity does not return is a hidden system role (roleExists:false)', async () => {
    const svc = withHttp({});
    jest.spyOn(svc as any, 'ensureClient').mockResolvedValue({ query: rolesHttp([{ id: 1, resourceID: 5, roleID: 29683355 }, { id: 2, resourceID: 5, roleID: 110 }], [{ id: 29683355, name: 'Engineer' }]) });
    jest.spyOn(svc, 'getResource').mockResolvedValue({ id: 5 } as any);
    const roles = await svc.getResourceRoles(5);
    expect(roles.find((r) => r.roleID === 110)).toEqual(expect.objectContaining({ roleName: null, roleExists: false }));
  });

  test('a FAILED Roles lookup leaves roleExists unknown (null), never false', async () => {
    const svc = withHttp({});
    jest.spyOn(svc as any, 'ensureClient').mockResolvedValue({ query: rolesHttp([{ id: 1, resourceID: 5, roleID: 42 }], new Error('boom')) });
    jest.spyOn(svc, 'getResource').mockResolvedValue({ id: 5 } as any);
    const roles = await svc.getResourceRoles(5);
    expect(roles[0]).toEqual(expect.objectContaining({ roleID: 42, roleName: null, roleExists: null }));
  });
});

describe('role auto-fill on assignment / time entries (#42)', () => {
  test('explicit assignedResourceID with no role → role auto-filled from default', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'resolveResourceDefaultRole').mockResolvedValue(99);
    const create = jest.spyOn(service, 'createTicket').mockResolvedValue(1);
    const handler = new AutotaskToolHandler(service, logger);
    await handler.callTool('autotask_create_ticket', { companyID: 1, title: 'T', description: 'D', assignedResourceID: 5 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ assignedResourceID: 5, assignedResourceRoleID: 99 }));
  });

  test('explicit role is not overwritten by auto-fill', async () => {
    const service = new AutotaskService(config, logger);
    const resolve = jest.spyOn(service, 'resolveResourceDefaultRole').mockResolvedValue(99);
    const create = jest.spyOn(service, 'createTicket').mockResolvedValue(1);
    const handler = new AutotaskToolHandler(service, logger);
    await handler.callTool('autotask_create_ticket', { companyID: 1, title: 'T', description: 'D', assignedResourceID: 5, assignedResourceRoleID: 7 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ assignedResourceRoleID: 7 }));
    expect(resolve).not.toHaveBeenCalled();
  });

  test('currentUser assigns the caller and auto-fills their role', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'resolveResourceDefaultRole').mockResolvedValue(99);
    const create = jest.spyOn(service, 'createTicket').mockResolvedValue(1);
    const handler = new AutotaskToolHandler(service, logger);
    jest.spyOn(handler as any, 'resolveCaller').mockResolvedValue({ status: 'resolved', resource: { id: 5, name: 'Me' } });
    await handler.callTool('autotask_create_ticket', { companyID: 1, title: 'T', description: 'D', currentUser: true });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ assignedResourceID: 5, assignedResourceRoleID: 99 }));
    // currentUser is stripped from the payload
    expect(create.mock.calls[0][0]).not.toHaveProperty('currentUser');
  });
});

describe('tool surface (#42)', () => {
  test('tickets wired for act-as + role auto-fill', () => {
    expect(ACTING_RESOURCE_TOOLS.autotask_create_ticket).toBe('assignedResourceID');
    expect(ACTING_ROLE_FIELDS.autotask_create_ticket).toEqual({ resourceField: 'assignedResourceID', roleField: 'assignedResourceRoleID' });
    expect(ACTING_ROLE_FIELDS.autotask_create_time_entry).toEqual({ resourceField: 'resourceID', roleField: 'roleID' });
  });

  test('role-discovery tools exist, read-only, and categorized', () => {
    expect((findTool('autotask_search_roles') as any).annotations.readOnlyHint).toBe(true);
    expect(findTool('autotask_get_resource_roles')!.inputSchema.required).toEqual(['resourceID']);
    const categorized = new Set(Object.values(TOOL_CATEGORIES).flatMap((c: any) => c.tools));
    expect(categorized.has('autotask_search_roles')).toBe(true);
    expect(categorized.has('autotask_get_resource_roles')).toBe(true);
  });

  test('create_ticket accepts currentUser', () => {
    expect((findTool('autotask_create_ticket')!.inputSchema.properties as any).currentUser.type).toBe('boolean');
  });
});
