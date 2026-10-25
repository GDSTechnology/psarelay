// Actionable time-entry write errors (timesheet lock, posted, bad work type,
// completed task, role), work-type pre-flight, per-row failures in the bulk /
// collaboration writers, the ticket-details Autotask link, and role checks on
// service-call resource assignments. Service mocked.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import { classifyTimeEntryWriteError } from '../src/utils/time-entry-errors';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices3.autotask.net/ATServicesRest/' } };
const logger = new Logger('error');
const mk = () => new AutotaskService(config, logger);
const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
const body = (res: any) => JSON.parse(res.content[0].text) as { message: string; data: any };

const ROLES = [
  { roleID: 29683355, roleName: 'Engineer', isActive: true, roleExists: true },
  { roleID: 29682834, roleName: 'Technician', isActive: true, roleExists: true },
];

describe('classifyTimeEntryWriteError', () => {
  test.each([
    ['Cannot add time entries to a timesheet that has been submitted.', 'timesheet_locked'],
    ['The time sheet for this week has been approved.', 'timesheet_locked'],
    ['This time entry has been posted and cannot be modified.', 'billing_posted'],
    ['The given allocation code is not an active general allocation code.', 'invalid_work_type'],
    ['Time cannot be entered against a task that is complete.', 'task_completed'],
    ['A role is required for this resource.', 'role_required'],
  ])('%s -> %s', (msg, status) => {
    const c = classifyTimeEntryWriteError(new Error(msg))!;
    expect(c.status).toBe(status);
    expect(c.autotaskError).toBe(msg);
  });

  test('delete-only states never map on a write', () => {
    expect(classifyTimeEntryWriteError(new Error('You cannot delete time entries that you did not create'))).toBeNull();
    expect(classifyTimeEntryWriteError(new Error('does not have adequate permissions to delete this entity timeEntryType'))).toBeNull();
  });

  test('unrelated errors are not swallowed', () => {
    expect(classifyTimeEntryWriteError(new Error('socket hang up'))).toBeNull();
  });

  test('a timesheet lock says how to fix it (reopen in the UI, re-run, resubmit)', () => {
    const c = classifyTimeEntryWriteError(new Error('time entries that have been submitted'))!;
    expect(c.reason).toMatch(/Reopen .* in the Autotask UI/);
    expect(c.reason).toMatch(/resubmit/);
    expect(c.reason).toMatch(/Nothing was written/);
  });
});

describe('create_time_entry / log_my_time / update_time_entry explain Autotask rejections', () => {
  const base = { resourceID: 30683832, ticketID: 209477, roleID: 29683355, dateWorked: '2026-08-03', hoursWorked: 0.58, summaryNotes: 'GDS Weekly Kickoff' };

  test('create on a locked timesheet → status timesheet_locked with the fix, raw error kept', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(ROLES);
    jest.spyOn(s, 'createTimeEntry').mockRejectedValue(new Error('Cannot add time entries to a timesheet that has been submitted.'));
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', base));
    expect(b.data).toEqual({ status: 'timesheet_locked', autotaskError: 'Cannot add time entries to a timesheet that has been submitted.' });
    expect(b.message).toMatch(/Reopen/);
  });

  test('log_my_time on a locked timesheet → same status', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(ROLES);
    jest.spyOn(s, 'logTimeIdempotent').mockRejectedValue(new Error('timesheet has been approved'));
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_log_my_time', base));
    expect(b.data.status).toBe('timesheet_locked');
  });

  test('update on a posted entry → billing_posted, id included', async () => {
    const s = mk();
    jest.spyOn(s, 'updateTimeEntry').mockRejectedValue(new Error('This time entry has been posted.'));
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_update_time_entry', { id: 7, summaryNotes: 'y' }));
    expect(b.data).toEqual(expect.objectContaining({ id: 7, status: 'billing_posted' }));
  });

  test('an unexplained Autotask error still surfaces as an error', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(ROLES);
    jest.spyOn(s, 'createTimeEntry').mockRejectedValue(new Error('socket hang up'));
    const res = await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', base);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/socket hang up/);
  });
});

describe('work-type pre-flight', () => {
  const base = { resourceID: 30683829, ticketID: 209477, roleID: 29683355, dateWorked: '2026-09-29', hoursWorked: 0.25, summaryNotes: 'x' };
  const workTypes = [{ id: 29683610, name: 'CT - Standard', active: true }, { id: 29683611, name: 'CT - Emergency', active: true }, { id: 1, name: 'Old', active: false }];

  test.each([
    [null, 'not_found', /does not exist/],
    [{ id: 5, name: 'Legacy Onsite', useType: 1, isActive: false }, 'inactive', /is inactive \("Legacy Onsite"\)/],
    [{ id: 6, name: 'Internal Meeting', useType: 3, isActive: true }, 'not_a_work_type', /Regular Time category; pass it as `category`/],
  ])('billing code %j → %s, nothing written, active choices listed', async (code, reason, msg) => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(ROLES);
    jest.spyOn(s, 'getBillingCode').mockResolvedValue(code as any);
    jest.spyOn(s, 'getWorkTypes').mockResolvedValue(workTypes);
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(1 as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, billingCodeID: 99 }));
    expect(create).not.toHaveBeenCalled();
    expect(b.data).toEqual(expect.objectContaining({ status: 'invalid_work_type', billingCodeID: 99, reason }));
    expect(b.data.validWorkTypes).toEqual([{ id: 29683610, name: 'CT - Standard' }, { id: 29683611, name: 'CT - Emergency' }]);
    expect(b.message).toMatch(msg);
    expect(b.message).toMatch(/29683610 = CT - Standard/);
  });

  test('an active work type passes through to the create', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(ROLES);
    jest.spyOn(s, 'getBillingCode').mockResolvedValue({ id: 29683610, name: 'CT - Standard', useType: 1, isActive: true } as any);
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(1 as any);
    jest.spyOn(s, 'getTimeEntry').mockResolvedValue(null);
    jest.spyOn(s, 'getResource').mockResolvedValue(null);
    await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, billingCodeID: 29683610 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ billingCodeID: 29683610 }));
  });

  test('a failed work-type lookup does not block (Autotask still enforces)', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue(ROLES);
    jest.spyOn(s, 'getBillingCode').mockRejectedValue(new Error('boom'));
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(1 as any);
    jest.spyOn(s, 'getTimeEntry').mockResolvedValue(null);
    jest.spyOn(s, 'getResource').mockResolvedValue(null);
    await new AutotaskToolHandler(s, logger).callTool('autotask_create_time_entry', { ...base, billingCodeID: 29683610 });
    expect(create).toHaveBeenCalled();
  });
});

describe('bulk / collaboration writers: one row failing does not abort the rest', () => {
  test('bulk task time: the locked attendee is an error row with the reason; others are created', async () => {
    const s = mk();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: jest.fn().mockResolvedValue([]) });
    jest.spyOn(s, 'resolveWorkTimeEntryRole').mockResolvedValue({ roleID: 29683355, roleName: 'Engineer', source: 'sole' });
    jest.spyOn(s, 'logTimeIdempotent')
      .mockResolvedValueOnce({ created: true, id: 101 } as any)
      .mockRejectedValueOnce(new Error('Cannot add time entries to a timesheet that has been submitted.'))
      .mockResolvedValueOnce({ created: true, id: 103 } as any);
    const r = await s.createTaskTimeEntriesBulk({
      taskID: 7591, dateWorked: '2026-08-03', dryRun: false,
      entries: [30683829, 30683832, 30683833].map((resourceID) => ({ resourceID, hoursWorked: 0.58, summaryNotes: 'GDS Weekly Kickoff' })),
    } as any);
    expect(r.results.map((x: any) => x.status)).toEqual(['created', 'error', 'created']);
    expect(r.results[1]!.error).toMatch(/timesheet .* submitted/);
    expect(r.created).toBe(2);
    expect(r.errors).toBe(1);
  });

  test('ticket collaboration: a failed row skips the summary note (re-run after fixing)', async () => {
    const s = mk();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: jest.fn().mockResolvedValue([]) });
    jest.spyOn(s, 'resolveWorkTimeEntryRole').mockResolvedValue({ roleID: 29683355, roleName: 'Engineer', source: 'sole' });
    jest.spyOn(s, 'logTimeIdempotent').mockRejectedValue(new Error('timesheet has been approved'));
    const note = jest.spyOn(s, 'createTicketNote').mockResolvedValue(1 as any);
    const r = await s.logTicketCollaboration({
      ticketID: 209477, dateWorked: '2026-09-28', dryRun: false,
      participants: [{ resourceID: 30683829, hoursWorked: 0.1, summaryNotes: 'x' }],
      note: { description: 'Collab summary' },
    } as any);
    expect(r.results[0]!.status).toBe('error');
    expect(note).not.toHaveBeenCalled();
    expect(r.note).toEqual({ status: 'skipped' });
  });
});

describe('get_ticket_details carries an Open-in-Autotask link', () => {
  test('ticketUrl on the result and in the message', async () => {
    const s = mk();
    jest.spyOn(s, 'getTicket').mockResolvedValue({ id: 208520, ticketNumber: 'T20260921.0086', title: 'x' } as any);
    const h = new AutotaskToolHandler(s, logger);
    jest.spyOn(h as any, 'enhanceItems').mockImplementation(async (x: any) => x);
    const b = body(await h.callTool('autotask_get_ticket_details', { ticketID: 208520 }));
    const url = 'https://ww3.autotask.net/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketID=208520';
    expect(b.data.ticketUrl).toBe(url);
    expect(b.message).toContain(`open in Autotask: ${url}`);
  });
});

// ServiceCallTicketResources / ServiceCallTaskResources have exactly resourceID
// + the parent id — NO roleID (live entityInformation, 2026-09-30; asking the
// API for roleID returns "Unable to find roleID in the ServiceCallTicketResource
// Entity"). A roleID from a caller must never be sent.
describe('service-call resource assignment sends no role (the entity has none)', () => {
  test.each([
    ['ServiceCallTickets', 'createServiceCallTicketResource', { serviceCallTicketID: 11 }, { resourceID: 30683829, serviceCallTicketID: 11 }],
    ['ServiceCallTasks', 'createServiceCallTaskResource', { serviceCallTaskID: 22 }, { resourceID: 30683829, serviceCallTaskID: 22 }],
  ])('%s child create body is exactly resourceID + parent id', async (parent, method, ids, expectedBody) => {
    const s = mk();
    const childCreate = jest.fn().mockResolvedValue(9);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ childCreate });
    await (s as any)[method]({ ...ids, resourceID: 30683829, roleID: 29683355 });
    expect(childCreate).toHaveBeenCalledWith(parent, Object.values(ids)[0], 'Resources', expectedBody);
  });

  test.each(['autotask_create_service_call_ticket_resource', 'autotask_create_service_call_task_resource'])(
    '%s: a passed roleID is ignored and the result says so', async (tool) => {
      const s = mk();
      jest.spyOn(s, 'createServiceCallTicketResource').mockResolvedValue(9 as any);
      jest.spyOn(s, 'createServiceCallTaskResource').mockResolvedValue(9 as any);
      const b = body(await new AutotaskToolHandler(s, logger).callTool(tool, { serviceCallTicketID: 11, serviceCallTaskID: 22, resourceID: 30683829, roleID: 112 }));
      expect(b.data?.id ?? b.data).toBe(9);
      expect(b.message).toMatch(/roleID 112 ignored/);
    });

  test('the schemas no longer advertise roleID', () => {
    const { TOOL_DEFINITIONS } = require('../src/handlers/tool.definitions');
    for (const name of ['autotask_create_service_call_ticket_resource', 'autotask_create_service_call_task_resource']) {
      expect(TOOL_DEFINITIONS.find((t: any) => t.name === name).inputSchema.properties).not.toHaveProperty('roleID');
    }
  });
});
