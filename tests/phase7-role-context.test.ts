// Role context for LLM selection: getResourceRoles enriches with role/department/
// queue names; resolveWorkTimeEntryRole returns DEDUPED role choices with that
// context when a resource has multiple roles and no API-visible default.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' },
};

function res(status: number, body?: any): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (body !== undefined ? JSON.stringify(body) : '') } as unknown as Response;
}

// Jonathan's real-shape data (from the live probe): 7 ResourceRoles rows, roles
// Administrative(29683386)/Technician(29682834)/Engineer(29683355), depts 2=Admin,
// 29683396=Information Technology; Resources.defaultServiceDeskRoleID = null.
function mockRoleWorld(): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    if (/\/ResourceRoles\/query$/.test(url)) return Promise.resolve(res(200, { items: [
      { id: 5, departmentID: 2, isActive: true, queueID: null, resourceID: 30683829, roleID: 29683386 },
      { id: 20, departmentID: 29683396, isActive: true, queueID: null, resourceID: 30683829, roleID: 29683355 },
      { id: 21, departmentID: 29683396, isActive: true, queueID: null, resourceID: 30683829, roleID: 29682834 },
      { id: 99, departmentID: null, isActive: true, queueID: 8, resourceID: 30683829, roleID: 29683355 }, // dup Engineer, via queue
    ] }));
    if (/\/Resources\/30683829$/.test(url)) return Promise.resolve(res(200, { item: { id: 30683829, defaultServiceDeskRoleID: null } }));
    if (/\/Roles\/query$/.test(url)) return Promise.resolve(res(200, { items: [
      { id: 29683386, name: 'Administrative' }, { id: 29683355, name: 'Engineer' }, { id: 29682834, name: 'Technician' },
    ] }));
    if (/\/Departments\/query$/.test(url)) return Promise.resolve(res(200, { items: [
      { id: 2, name: 'Administration' }, { id: 29683396, name: 'Information Technology' },
    ] }));
    if (/\/Tickets\/entityInformation\/fields$/.test(url)) return Promise.resolve(res(200, { fields: [
      { name: 'queueID', isPickList: true, picklistValues: [{ value: '8', label: 'Triage', isActive: true }] },
    ] }));
    return Promise.resolve(res(200, { items: [] }));
  });
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('getResourceRoles enrichment', () => {
  test('adds roleName, departmentName, queueName per row', async () => {
    mockRoleWorld();
    const rows = await new AutotaskService(config, logger).getResourceRoles(30683829);
    const eng = rows.find((r) => r.roleID === 29683355 && r.departmentID === 29683396)!;
    expect(eng.roleName).toBe('Engineer');
    expect(eng.departmentName).toBe('Information Technology');
    const admin = rows.find((r) => r.roleID === 29683386)!;
    expect(admin.roleName).toBe('Administrative');
    expect(admin.departmentName).toBe('Administration');
    const viaQueue = rows.find((r) => r.queueID === 8)!;
    expect(viaQueue.queueName).toBe('Triage');
  });
});

describe('resolveWorkTimeEntryRole selection context', () => {
  test('multiple roles, no default -> deduped needsSelection with dept/queue context', async () => {
    mockRoleWorld();
    const out = await new AutotaskService(config, logger).resolveWorkTimeEntryRole(30683829) as { needsSelection: any[] };
    expect(out.needsSelection).toBeDefined();
    // 3 distinct roles (Engineer deduped from its 2 rows)
    expect(out.needsSelection.map((r) => r.roleID).sort()).toEqual([29682834, 29683355, 29683386]);
    const eng = out.needsSelection.find((r) => r.roleID === 29683355)!;
    expect(eng.roleName).toBe('Engineer');
    expect(eng.departments).toContain('Information Technology');
    expect(eng.queues).toContain('Triage'); // aggregated across its rows
  });

  test('a real default (defaultServiceDeskRoleID set) resolves directly', async () => {
    jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
      const url = args[0] as string;
      if (/\/ResourceRoles\/query$/.test(url)) return Promise.resolve(res(200, { items: [
        { id: 1, resourceID: 5, roleID: 111, isActive: true }, { id: 2, resourceID: 5, roleID: 222, isActive: true },
      ] }));
      if (/\/Resources\/5$/.test(url)) return Promise.resolve(res(200, { item: { id: 5, defaultServiceDeskRoleID: 222 } }));
      if (/\/Roles\/query$/.test(url)) return Promise.resolve(res(200, { items: [{ id: 111, name: 'Tech' }, { id: 222, name: 'Lead' }] }));
      return Promise.resolve(res(200, { items: [] }));
    });
    const out = await new AutotaskService(config, logger).resolveWorkTimeEntryRole(5);
    expect(out).toEqual(expect.objectContaining({ roleID: 222, source: "default" }));
  });

  test('single distinct role resolves without a pick', async () => {
    jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
      const url = args[0] as string;
      if (/\/ResourceRoles\/query$/.test(url)) return Promise.resolve(res(200, { items: [
        { id: 1, resourceID: 6, roleID: 111, isActive: true, departmentID: 2 },
        { id: 2, resourceID: 6, roleID: 111, isActive: true, queueID: 8 }, // same role, different assoc
      ] }));
      if (/\/Resources\/6$/.test(url)) return Promise.resolve(res(200, { item: { id: 6, defaultServiceDeskRoleID: null } }));
      if (/\/Roles\/query$/.test(url)) return Promise.resolve(res(200, { items: [{ id: 111, name: 'Tech' }] }));
      return Promise.resolve(res(200, { items: [] }));
    });
    const out = await new AutotaskService(config, logger).resolveWorkTimeEntryRole(6);
    expect(out).toEqual(expect.objectContaining({ roleID: 111, source: "sole" }));
  });
});
