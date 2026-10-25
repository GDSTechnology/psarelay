// Ticket/task time entries require a roleID. resolveWorkTimeEntryRole picks the
// resource's default role, or its sole role, else returns a selection list
// (roleID → canonical name) — never guesses. A caller-chosen roleID is
// VALIDATED against the resource's active roles (GDS 2026-09-28: Engineer vs
// Technician are not interchangeable). Service mocked.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const mk = () => new AutotaskService(config, new Logger('error'));

// Jonathan Fitzgerald's live ResourceRoles shape (2026-09-28): one row per
// department AND per queue, so Engineer appears three times; no default.
const JONATHAN_ROLES = [
  { roleID: 29683386, roleName: 'Administrative', departmentName: 'Administration', isActive: true, isDefaultServiceDeskRole: false },
  { roleID: 112, roleName: null, departmentName: 'Administration', isActive: true, isDefaultServiceDeskRole: false },
  { roleID: 110, roleName: null, departmentName: 'Administration', isActive: true, isDefaultServiceDeskRole: false },
  { roleID: 29683355, roleName: 'Engineer', departmentName: 'Information Technology', isActive: true, isDefaultServiceDeskRole: false },
  { roleID: 29682834, roleName: 'Technician', departmentName: 'Information Technology', isActive: true, isDefaultServiceDeskRole: false },
  { roleID: 29683355, roleName: 'Engineer', queueName: 'Help Desk', isActive: true, isDefaultServiceDeskRole: false },
  { roleID: 29683355, roleName: 'Engineer', queueName: 'Projects', isActive: true, isDefaultServiceDeskRole: false },
];

/** The tool response is { content: [{ text: JSON({ message, data }) }] }. */
const body = (res: any) => JSON.parse(res.content[0].text) as { message: string; data: any };

describe('resolveWorkTimeEntryRole', () => {
  test('uses the default service-desk role when the resource has one', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([
      { roleID: 10, roleName: 'Tech', isDefaultServiceDeskRole: false },
      { roleID: 20, roleName: 'Lead', isDefaultServiceDeskRole: true },
    ]);
    expect(await s.resolveWorkTimeEntryRole(1)).toEqual({ roleID: 20, roleName: 'Lead', source: 'default' });
  });

  test('uses the sole role when there is only one (no default flagged)', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([{ roleID: 10, roleName: 'Tech', isDefaultServiceDeskRole: false }]);
    expect(await s.resolveWorkTimeEntryRole(1)).toEqual({ roleID: 10, roleName: 'Tech', source: 'sole' });
  });

  test('returns a selection list when multiple roles and no default — never guesses', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([
      { roleID: 10, roleName: 'Tech', isDefaultServiceDeskRole: false },
      { roleID: 20, roleName: 'Lead', isDefaultServiceDeskRole: false },
    ]);
    const r = await s.resolveWorkTimeEntryRole(1) as any;
    expect(r.needsSelection).toEqual([
      { roleID: 10, roleName: 'Tech', isDefault: false },
      { roleID: 20, roleName: 'Lead', isDefault: false },
    ]);
    expect(r.roleID).toBeUndefined();
  });

  test('errors (does not guess) when the resource has no roles', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([]);
    const r = await s.resolveWorkTimeEntryRole(1) as any;
    expect(r.error).toMatch(/no active roles assigned/);
  });

  test('an inactive role row is not a valid role (the sole ACTIVE role wins)', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([
      { roleID: 10, roleName: 'Tech', isActive: false },
      { roleID: 20, roleName: 'Lead', isActive: true },
    ]);
    expect(await s.resolveWorkTimeEntryRole(1)).toEqual({ roleID: 20, roleName: 'Lead', source: 'sole' });
  });

  test('validates an explicit roleID the resource holds (Jonathan → Engineer)', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(JONATHAN_ROLES);
    expect(await s.resolveWorkTimeEntryRole(30683829, 29683355)).toEqual({ roleID: 29683355, roleName: 'Engineer', source: 'explicit' });
  });

  test('rejects an explicit roleID the resource does not hold, with deduped choices', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(JONATHAN_ROLES);
    const r = await s.resolveWorkTimeEntryRole(30683829, 999) as any;
    expect(r.invalidRole).toBe(999);
    expect(r.validRoles.map((c: any) => c.roleID)).toEqual([29683386, 112, 110, 29683355, 29682834]);
    expect(r.validRoles.find((c: any) => c.roleID === 29683355)).toEqual({
      roleID: 29683355, roleName: 'Engineer', isDefault: false,
      departments: ['Information Technology'], queues: ['Help Desk', 'Projects'],
    });
  });

  // 110/112: hidden system roles (Roles entity doesn't return them; unnamed,
  // held by ~9 resources in Administration, never used for time — live 2026-09-29).
  const withSystemRoles = JONATHAN_ROLES.map((r) => ({ ...r, roleExists: r.roleID !== 110 && r.roleID !== 112 }));

  test('hidden system roles are left out of the pick list', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(withSystemRoles);
    const r = await s.resolveWorkTimeEntryRole(30683829) as any;
    expect(r.needsSelection.map((c: any) => c.roleID)).toEqual([29683386, 29683355, 29682834]);
  });

  test('an explicit hidden system roleID is rejected', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(withSystemRoles);
    const r = await s.resolveWorkTimeEntryRole(30683829, 112) as any;
    expect(r.invalidRole).toBe(112);
    expect(r.validRoles.map((c: any) => c.roleID)).not.toContain(112);
  });

  test('roleExists unknown (null — lookup failed) does NOT hide a role', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([{ roleID: 42, roleName: null, roleExists: null, isActive: true }]);
    expect(await s.resolveWorkTimeEntryRole(1)).toEqual({ roleID: 42, roleName: null, source: 'sole' });
  });

  test('a resource holding ONLY system roles gets the no-roles error, not a system role', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([{ roleID: 110, roleName: null, roleExists: false, isActive: true }]);
    const r = await s.resolveWorkTimeEntryRole(1) as any;
    expect(r.error).toMatch(/no active roles/);
  });

  test('an explicit roleID on an inactive role row is rejected', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([
      { roleID: 10, roleName: 'Tech', isActive: false },
      { roleID: 20, roleName: 'Lead', isActive: true },
    ]);
    const r = await s.resolveWorkTimeEntryRole(1, 10) as any;
    expect(r.invalidRole).toBe(10);
  });
});

describe('create_time_entry handler role wiring', () => {
  const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
  const stub = (s: AutotaskService, stored: Record<string, any> = {}) => {
    jest.spyOn(s, 'getTimeEntry').mockResolvedValue({ id: 555, resourceID: 30683829, ticketID: 209477, dateWorked: '2026-09-28', hoursWorked: 0.1, summaryNotes: 'x', ...stored } as any);
    jest.spyOn(s, 'getResource').mockResolvedValue({ id: 30683829, firstName: 'Jonathan', lastName: 'Fitzgerald' } as any);
  };

  test('auto-fills the default role for a ticket time entry, then creates', async () => {
    const s = mk();
    jest.spyOn(s, 'resolveWorkTimeEntryRole').mockResolvedValue({ roleID: 20, roleName: 'Lead', source: 'default' });
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(555 as any);
    stub(s, { roleID: 20 });
    const h = new AutotaskToolHandler(s, new Logger('error'));
    const res = await h.callTool('autotask_create_time_entry', { resourceID: 1, ticketID: 204722, dateWorked: '2026-09-22', hoursWorked: 0.25, summaryNotes: 'x' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toEqual(expect.objectContaining({ roleID: 20, ticketID: 204722 }));
    expect(body(res).data).toEqual(expect.objectContaining({ roleID: 20, roleName: 'Lead', roleSource: 'default' }));
  });

  test('returns a pick (no write) when the resource has multiple roles', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(JONATHAN_ROLES);
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(555 as any);
    const h = new AutotaskToolHandler(s, new Logger('error'));
    const res = await h.callTool('autotask_create_time_entry', { resourceID: 30683829, ticketID: 209477, hoursWorked: 0.1 });
    expect(create).not.toHaveBeenCalled();
    const b = body(res);
    expect(b.data.status).toBe('role_required');
    expect(b.message).toMatch(/29683355 = Engineer \[Information Technology\]/);
    expect(b.message).toMatch(/29682834 = Technician/);
    expect(b.message).toMatch(/Nothing was written/);
  });

  test('explicit Engineer role for Jonathan is validated, sent, and reported (GDS T20260928.0084)', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(JONATHAN_ROLES);
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(555 as any);
    stub(s, { roleID: 29683355 });
    const h = new AutotaskToolHandler(s, new Logger('error'));
    const res = await h.callTool('autotask_create_time_entry', {
      resourceID: 30683829, ticketID: 209477, roleID: 29683355, dateWorked: '2026-09-28', hoursWorked: 0.1,
      summaryNotes: 'x', internalNotes: 'Backfilled',
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toEqual(expect.objectContaining({ roleID: 29683355, ticketID: 209477, resourceID: 30683829 }));
    const b = body(res);
    expect(b.data).toEqual(expect.objectContaining({
      id: 555, ticketID: 209477, resourceID: 30683829, resourceName: 'Jonathan Fitzgerald',
      roleID: 29683355, roleName: 'Engineer', roleSource: 'explicit', hoursWorked: 0.1, summaryNotes: 'x',
    }));
    expect(b.message).toMatch(/for Jonathan Fitzgerald as Engineer \(29683355\)/);
  });

  test('an explicit roleID that is not the resource\'s fails cleanly, writes nothing, lists valid roles', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(JONATHAN_ROLES);
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(555 as any);
    const h = new AutotaskToolHandler(s, new Logger('error'));
    const res = await h.callTool('autotask_create_time_entry', { resourceID: 30683829, ticketID: 209477, roleID: 99, hoursWorked: 0.1, summaryNotes: 'x', dateWorked: '2026-09-28' });
    expect(create).not.toHaveBeenCalled();
    const b = body(res);
    expect(b.data).toEqual(expect.objectContaining({ status: 'invalid_role', requestedRoleID: 99 }));
    expect(b.message).toMatch(/roleID 99 is not an active role for resource 30683829/);
    expect(b.message).toMatch(/29683355 = Engineer/);
  });

  test('if the role lookup itself fails, an explicit roleID is kept and flagged unverified', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockRejectedValue(new Error('boom'));
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(556 as any);
    stub(s, { id: 556, roleID: 99 });
    const h = new AutotaskToolHandler(s, new Logger('error'));
    const res = await h.callTool('autotask_create_time_entry', { resourceID: 1, ticketID: 204722, roleID: 99, hoursWorked: 0.25, summaryNotes: 'x', dateWorked: '2026-09-28' });
    expect(create.mock.calls[0]![0]).toEqual(expect.objectContaining({ roleID: 99 }));
    expect(body(res).data.roleSource).toBe('explicit_unverified');
  });

  test('update_time_entry validates a role change against the entry OWNER', async () => {
    const s = mk();
    jest.spyOn(s, 'getTimeEntry').mockResolvedValue({ id: 7, resourceID: 30683829, ticketID: 209477 } as any);
    const roles = jest.spyOn(s, 'getResourceRoles').mockResolvedValue(JONATHAN_ROLES);
    const update = jest.spyOn(s, 'updateTimeEntry').mockResolvedValue(undefined as any);
    const h = new AutotaskToolHandler(s, new Logger('error'));
    const res = await h.callTool('autotask_update_time_entry', { id: 7, roleID: 99 });
    expect(roles).toHaveBeenCalledWith(30683829);
    expect(update).not.toHaveBeenCalled();
    expect(body(res).data.status).toBe('invalid_role');
  });
});

// hoursToBill is read-only in the Autotask API (live entry 55508: an update to
// 0.1 "succeeded" while Autotask kept 0.25). The tools must not imply otherwise.
describe('hoursToBill is read-only', () => {
  const { AutotaskToolHandler } = require('../src/handlers/tool.handler');

  test('update of ONLY hoursToBill writes nothing and says why', async () => {
    const s = mk();
    const update = jest.spyOn(s, 'updateTimeEntry').mockResolvedValue(undefined as any);
    const h = new AutotaskToolHandler(s, new Logger('error'));
    const b = body(await h.callTool('autotask_update_time_entry', { id: 55508, hoursToBill: 0.1 }));
    expect(update).not.toHaveBeenCalled();
    expect(b.data).toEqual({ id: 55508, status: 'not_writable', field: 'hoursToBill' });
    expect(b.message).toMatch(/Nothing was written: hoursToBill is read-only/);
  });

  test('update with other fields proceeds and warns when stored hoursToBill differs', async () => {
    const s = mk();
    const update = jest.spyOn(s, 'updateTimeEntry').mockResolvedValue(undefined as any);
    jest.spyOn(s, 'getTimeEntry').mockResolvedValue({ id: 55508, hoursToBill: 0.25 } as any);
    const h = new AutotaskToolHandler(s, new Logger('error'));
    const b = body(await h.callTool('autotask_update_time_entry', { id: 55508, hoursToBill: 0.1, summaryNotes: 'y' }));
    expect(update).toHaveBeenCalledWith(55508, { summaryNotes: 'y' });
    expect(b.data.warnings.join(' ')).toMatch(/requested 0.1, Autotask stored 0.25/);
  });

  test('create drops hoursToBill and warns when Autotask stored something else', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(JONATHAN_ROLES);
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(555 as any);
    jest.spyOn(s, 'getTimeEntry').mockResolvedValue({ id: 555, resourceID: 30683829, ticketID: 209477, roleID: 29683355, hoursWorked: 0.1, hoursToBill: 0.25 } as any);
    jest.spyOn(s, 'getResource').mockResolvedValue({ id: 30683829, firstName: 'Jonathan', lastName: 'Fitzgerald' } as any);
    const h = new AutotaskToolHandler(s, new Logger('error'));
    const b = body(await h.callTool('autotask_create_time_entry', { resourceID: 30683829, ticketID: 209477, roleID: 29683355, dateWorked: '2026-09-28', hoursWorked: 0.1, hoursToBill: 0.1, summaryNotes: 'x' }));
    expect(create.mock.calls[0]![0]).not.toHaveProperty('hoursToBill');
    expect(b.data.hoursToBill).toBe(0.25);
    expect(b.data.warnings.join(' ')).toMatch(/hoursToBill is read-only/);
  });

  test('no time-entry write schema advertises hoursToBill as an input', () => {
    for (const name of ['autotask_create_time_entry', 'autotask_log_my_time', 'autotask_update_time_entry']) {
      const props = (TOOL_DEFINITIONS.find((t) => t.name === name)!.inputSchema as any).properties;
      expect(props).not.toHaveProperty('hoursToBill');
    }
  });
});

// GDS 2026-09-28 reported "the error handler asks for roleID but the published
// schema doesn't expose it". Pin that every labour-entry tool that can answer
// role_required ADVERTISES roleID, so the retry the message asks for is possible.
describe('roleID is exposed on every labour-entry schema', () => {
  const schema = (name: string) => TOOL_DEFINITIONS.find((t) => t.name === name)!.inputSchema as any;
  test.each(['autotask_create_time_entry', 'autotask_log_my_time', 'autotask_update_time_entry'])('%s', (name) => {
    expect(schema(name).properties.roleID).toEqual(expect.objectContaining({ type: 'number' }));
  });
  test('bulk task entries[] and ticket collaboration participants[]', () => {
    expect(schema('autotask_create_task_time_entries_bulk').properties.entries.items.properties.roleID).toBeDefined();
    expect(schema('autotask_log_ticket_collaboration').properties.participants.items.properties.roleID).toBeDefined();
  });
});
