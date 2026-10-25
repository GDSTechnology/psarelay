// Corrected delete toolset:
//  - time-entry delete: dry-run-first, only billing-post is pre-detectable
//    (no timesheet entity in the API); owner-only + submitted/approved +
//    owner-permission are enforced at execution and mapped to clear reasons;
//    deletes AS the owner via impersonation.
//  - delete_task: Autotask can't delete tasks via API -> inventory + UI guidance.
//  - delete_task_with_time: clears time (as owner) + optional secondary
//    resources, hands the task deletion to the UI.

import { classifyTimesheetStatusLabel, classifyLockError, isLocked } from '../src/utils/timesheet-lock';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' },
};

function res(status: number, body?: any): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (body !== undefined ? JSON.stringify(body) : '') } as unknown as Response;
}
// Handler dispatch triggers MappingService enrichment — keep it offline.
beforeEach(() => { jest.spyOn(global, 'fetch' as any).mockImplementation(() => Promise.resolve(res(200, { items: [] }))); });
afterEach(() => jest.restoreAllMocks());

function textOf(r: any) { return r.content[0].text as string; }

describe('timesheet-lock util', () => {
  test('classifies status labels', () => {
    expect(classifyTimesheetStatusLabel('Open')).toBe('open');
    expect(classifyTimesheetStatusLabel('Locked waiting for approval')).toBe('timesheet_pending_approval');
    expect(classifyTimesheetStatusLabel('Locked has been approved')).toBe('timesheet_approved');
  });
  test('classifies the real Autotask error messages', () => {
    expect(classifyLockError('You do not have permission to delete time entries that have been submitted.')).toBe('timesheet_pending_approval');
    expect(classifyLockError('You do not have permission to delete time entries that you did not create.')).toBe('not_owner');
    expect(classifyLockError('The logged in Resource does not have the adequate permissions to delete this entity timeEntryType.')).toBe('no_delete_permission');
    expect(classifyLockError('the timesheet has been approved')).toBe('timesheet_approved');
    expect(classifyLockError('This time has been posted')).toBe('billing_posted');
    expect(classifyLockError('some unrelated error')).toBeNull();
  });
  test('isLocked covers ownership + permission states', () => {
    expect(isLocked('open')).toBe(false);
    expect(isLocked('not_owner')).toBe(true);
    expect(isLocked('no_delete_permission')).toBe(true);
    expect(isLocked('billing_posted')).toBe(true);
  });
});

describe('assessTimeEntryLock (pre-flight only sees billing-post)', () => {
  test('posted entry -> billing_posted locked', async () => {
    const svc = new AutotaskService(config, logger);
    const out = await svc.assessTimeEntryLock({ billingApprovalDateTime: '2026-08-13T00:00:00Z' } as any);
    expect(out).toMatchObject({ locked: true, state: 'billing_posted' });
  });
  test('non-posted entry -> open, preflightOnly (further locks only at execution)', async () => {
    const svc = new AutotaskService(config, logger);
    const out = await svc.assessTimeEntryLock({ resourceID: 1, dateWorked: '2026-08-12' } as any);
    expect(out).toEqual({ locked: false, state: 'open', preflightOnly: true });
  });
});

describe('confirm gate exempts dry-run', () => {
  test('delete_time_entry dry-run needs no confirm; execute without confirm is gated', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 54827, resourceID: 1, dateWorked: '2026-08-12' } as any);
    const del = jest.spyOn(svc, 'deleteTimeEntry').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);

    const dry = await handler.callTool('autotask_delete_time_entry', { id: 54827 });
    expect(textOf(dry)).toContain('DRY RUN');
    expect(del).not.toHaveBeenCalled();

    const noConfirm = await handler.callTool('autotask_delete_time_entry', { id: 54827, dryRun: false });
    expect(textOf(noConfirm).toLowerCase()).toContain('confirm');
    expect(del).not.toHaveBeenCalled();
  });
});

describe('delete_time_entry', () => {
  test('dry-run on an open entry: canDelete with the execution caveat', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 54827, resourceID: 1, dateWorked: '2026-08-12' } as any);
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_time_entry', { id: 54827 });
    expect(textOf(r)).toMatch(/only be detected at execution/i);
  });

  test('blocks a posted (billing-approved) entry', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 5, resourceID: 1, dateWorked: '2026-08-12', billingApprovalDateTime: '2026-08-13T00:00:00Z' } as any);
    const del = jest.spyOn(svc, 'deleteTimeEntry').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_time_entry', { id: 5, dryRun: false, confirm: true });
    expect(textOf(r)).toMatch(/posted|billing-approved/i);
    expect(del).not.toHaveBeenCalled();
  });

  test('executes as the owner (impersonation) and verifies removal', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValueOnce({ id: 54827, resourceID: 30683922, dateWorked: '2026-08-12' } as any).mockResolvedValueOnce(null);
    const del = jest.spyOn(svc, 'deleteTimeEntry').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_time_entry', { id: 54827, dryRun: false, confirm: true });
    expect(del).toHaveBeenCalledWith(54827, { asResourceID: 30683922 });
    expect(textOf(r)).toContain('Deleted time entry 54827');
  });

  test.each([
    ['You do not have permission to delete time entries that have been submitted.', /submitted/i],
    ['You do not have permission to delete time entries that you did not create.', /only by the resource who created it|owner/i],
    ['does not have the adequate permissions to delete this entity timeEntryType.', /security level|delete permission|permission to delete/i],
  ])('maps the execution error "%s" to a clear reason', async (errMsg, expected) => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 9, resourceID: 1, dateWorked: '2026-08-12' } as any);
    jest.spyOn(svc, 'deleteTimeEntry').mockRejectedValue(new Error(errMsg));
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_time_entry', { id: 9, dryRun: false, confirm: true });
    expect(textOf(r)).toMatch(expected);
  });

  test('idempotent: missing entry -> already_deleted', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue(null);
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_time_entry', { id: 123, dryRun: false, confirm: true });
    expect(textOf(r)).toContain('already deleted');
  });
});

describe('delete_task (API cannot delete tasks — inventory + UI guidance)', () => {
  test('never attempts a delete; returns ui_delete_required with attached counts', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'inspectTaskForDelete').mockResolvedValue({
      task: { id: 191111, taskNumber: 'T20260407.0062', title: 'RPO Meeting', projectID: 169 } as any,
      timeEntries: [{ id: 54827 }, { id: 54981 }], notes: [{ id: 1 }], attachments: [], secondaryResources: [{ id: 7 }, { id: 8 }, { id: 9 }], dependencies: [],
    });
    const del = jest.spyOn(svc, 'deleteTaskById').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_task', { id: 191111 });
    expect(textOf(r)).toMatch(/does not allow deleting a project task via the API|Autotask UI/i);
    expect(textOf(r)).toContain('2 time entr');
    expect(del).not.toHaveBeenCalled();
  });
});

describe('delete_task_with_time (clear time as owner, hand task to UI)', () => {
  const invOpen = {
    task: { id: 191111, taskNumber: 'T20260407.0062', title: 'RPO Meeting', projectID: 169 } as any,
    timeEntries: [{ id: 54827, resourceID: 30683922, dateWorked: '2026-08-12', hoursWorked: 0.6667 }, { id: 54981, resourceID: 30683880, dateWorked: '2026-08-24', hoursWorked: 0.6667 }],
    notes: [{ id: 1 }], attachments: [], secondaryResources: [{ id: 7 }], dependencies: [],
  };

  test('dry-run: plan only, no deletes, task marked not API-deletable', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'inspectTaskForDelete').mockResolvedValue(invOpen);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 0, resourceID: 1, dateWorked: '2026-08-12' } as any);
    const delTE = jest.spyOn(svc, 'deleteTimeEntry').mockResolvedValue();
    const delTask = jest.spyOn(svc, 'deleteTaskById').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_task_with_time', { taskId: 191111 });
    expect(textOf(r)).toContain('DRY RUN');
    expect(delTE).not.toHaveBeenCalled();
    expect(delTask).not.toHaveBeenCalled();
  });

  test('execute: deletes both entries AS owners, never calls task delete, status time_cleared', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'inspectTaskForDelete')
      .mockResolvedValueOnce(invOpen)
      .mockResolvedValueOnce({ ...invOpen, timeEntries: [] });
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 0, resourceID: 1, dateWorked: '2026-08-12' } as any);
    const delTE = jest.spyOn(svc, 'deleteTimeEntry').mockResolvedValue();
    const delTask = jest.spyOn(svc, 'deleteTaskById').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_task_with_time', { taskId: 191111, dryRun: false, confirm: true });
    expect(delTE).toHaveBeenCalledWith(54827, { asResourceID: 30683922 });
    expect(delTE).toHaveBeenCalledWith(54981, { asResourceID: 30683880 });
    expect(delTask).not.toHaveBeenCalled();
    expect(textOf(r)).toMatch(/Deleted 2 time entr/);
    expect(textOf(r)).toMatch(/UI/i);
  });

  test('execute: an execution lock error -> partial, task not touched', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'inspectTaskForDelete').mockResolvedValue(invOpen);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 0, resourceID: 1, dateWorked: '2026-08-12' } as any);
    jest.spyOn(svc, 'deleteTimeEntry')
      .mockResolvedValueOnce(undefined as any)
      .mockRejectedValueOnce(new Error('You do not have permission to delete time entries that have been submitted.'));
    const delTask = jest.spyOn(svc, 'deleteTaskById').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_task_with_time', { taskId: 191111, dryRun: false, confirm: true });
    expect(textOf(r)).toMatch(/Partial/i);
    expect(textOf(r)).toMatch(/submitted/i);
    expect(delTask).not.toHaveBeenCalled();
  });

  test('removeSecondaryResources: also removes crew rows', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'inspectTaskForDelete')
      .mockResolvedValueOnce(invOpen)
      .mockResolvedValueOnce({ ...invOpen, timeEntries: [] });
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 0, resourceID: 1, dateWorked: '2026-08-12' } as any);
    jest.spyOn(svc, 'deleteTimeEntry').mockResolvedValue();
    const rmRes = jest.spyOn(svc, 'removeTaskResource').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_task_with_time', { taskId: 191111, dryRun: false, confirm: true, removeSecondaryResources: true });
    expect(rmRes).toHaveBeenCalledWith(7);
    expect(textOf(r)).toMatch(/secondary resource/i);
  });
});
