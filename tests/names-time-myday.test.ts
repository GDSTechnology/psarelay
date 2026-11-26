// Time entries and My day carry NAMES next to ids (voice reads them back):
// person, work type, Regular Time category, role, ticket number + title, task
// title + project, company, contact; picklist labels for task status, To-Do type
// and service-call status. Service mocked.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const body = (res: any) => JSON.parse(res.content[0].text) as { message: string; data: any };
afterEach(() => jest.restoreAllMocks());

const ROWS: Record<string, Array<Record<string, any>>> = {
  Roles: [{ id: 7, name: 'Engineer' }],
  Tickets: [{ id: 555001, ticketNumber: 'T20261124.0042', title: 'Printer offline' }],
  Tasks: [{ id: 777001, title: 'Migrate mailboxes', projectID: 880001 }],
  Projects: [{ id: 880001, projectName: 'Mail migration' }],
  Contacts: [{ id: 330001, firstName: 'Alex', lastName: 'Kim' }],
};
const pv = (pairs: Array<[number, string]>) => pairs.map(([value, label]) => ({ value: String(value), label, isActive: true }));

function mk() {
  const s = new AutotaskService(config, logger);
  const queryByIds = jest.fn(async (entity: string, _f: string, ids: number[]) => ({ items: (ROWS[entity] ?? []).filter((r) => ids.includes(r.id)), failedChunks: [] }));
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ queryByIds, query: jest.fn(async () => []) });
  jest.spyOn(s, 'getResourceNames').mockImplementation(async (ids: unknown[]) => new Map(ids.map(Number).map((i) => [i, i === 1001 ? 'Pat Lee' : `Person ${i}`] as [number, string])));
  jest.spyOn(s, 'getWorkTypes').mockResolvedValue([{ id: 101, name: 'Remote Support', active: true }]);
  jest.spyOn(s, 'getRegularTimeCategories').mockResolvedValue([{ id: 201, name: 'Internal Meeting', active: true }]);
  jest.spyOn(s, 'getCompanyNamesByIds').mockResolvedValue([{ id: 0, companyName: 'Own Company' }, { id: 44, companyName: 'Acme Dental' }]);
  jest.spyOn(s, 'getFieldInfo').mockImplementation(async (entity: string) => ({
    Tasks: [{ name: 'status', picklistValues: pv([[1, 'New'], [5, 'Complete']]) }],
    CompanyToDos: [{ name: 'actionType', picklistValues: pv([[3, 'Phone Call']]) }],
    ServiceCalls: [{ name: 'status', picklistValues: pv([[1, 'New'], [2, 'Scheduled']]) }],
  } as Record<string, any>)[entity] ?? []);
  return { s, queryByIds };
}

describe('nameRefs / labelPicklistFields', () => {
  test('names every reference kind in one batched pass', async () => {
    const { s, queryByIds } = mk();
    const rows: Array<Record<string, any>> = [
      { id: 1, resourceID: 1001, billingCodeID: 101, roleID: 7, ticketID: 555001 },
      { id: 2, resourceID: 1001, internalBillingCodeID: 201 },
      { id: 3, taskID: 777001, companyID: 0, contactID: 330001, assignedToResourceID: 1001 },
    ];
    await s.nameRefs(rows);
    expect(rows[0]).toEqual(expect.objectContaining({ resourceName: 'Pat Lee', workTypeName: 'Remote Support', roleName: 'Engineer', ticketNumber: 'T20261124.0042', ticketTitle: 'Printer offline' }));
    expect(rows[1]).toEqual(expect.objectContaining({ categoryName: 'Internal Meeting' }));
    expect(rows[2]).toEqual(expect.objectContaining({ taskTitle: 'Migrate mailboxes', projectName: 'Mail migration', company: 'Own Company', contactName: 'Alex Kim', assignedTo: 'Pat Lee' }));
    expect(queryByIds.mock.calls.filter((c) => c[0] === 'Tickets')).toHaveLength(1); // batched, not per row
  });

  test('never overwrites, and a failed kind leaves the ids alone', async () => {
    const { s } = mk();
    (s.getWorkTypes as jest.Mock).mockRejectedValue(new Error('down'));
    const row: Record<string, any> = { billingCodeID: 101, resourceID: 1001, resourceName: 'Given' };
    await s.nameRefs([row]);
    expect(row.resourceName).toBe('Given');
    expect(row.workTypeName).toBeUndefined();
    expect(row.billingCodeID).toBe(101);
  });

  test('picklist labels next to the value, inactive values included', async () => {
    const { s } = mk();
    const tasks: Array<Record<string, any>> = [{ status: 5 }, { status: 99 }];
    await s.labelPicklistFields('Tasks', tasks, ['status']);
    expect(tasks[0]!.statusLabel).toBe('Complete');
    expect(tasks[1]!.statusLabel).toBeUndefined();
  });
});

describe('tools', () => {
  test('get_time_entry speaks the entry by names', async () => {
    const { s } = mk();
    jest.spyOn(s, 'getTimeEntry').mockResolvedValue({ id: 990001, ticketID: 555001, resourceID: 1001, roleID: 7, billingCodeID: 101, hoursWorked: 1.5, dateWorked: '2026-11-24T00:00:00' } as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_get_time_entry', { id: 990001 }));
    expect(b.message).toBe('1.5 hour(s) on 2026-11-24 on T20261124.0042 — Printer offline by Pat Lee as Engineer — work type Remote Support');
    expect(b.data.workTypeName).toBe('Remote Support');
  });

  test('get_my_day names time, tasks, To-Dos and service calls; gaps by ticket number', async () => {
    const { s } = mk();
    jest.spyOn(s, 'getMyDay').mockResolvedValue({
      date: '2026-11-24',
      assignedTickets: [],
      timeEntries: [{ id: 1, resourceID: 1001, billingCodeID: 101, ticketID: 555001, hoursWorked: 1 }],
      openTasks: [{ id: 777001, title: 'Migrate mailboxes', status: 1, projectID: 880001 }],
      openTodos: [{ id: 9, actionType: 3, assignedToResourceID: 1001, companyID: 44, contactID: 330001 }],
      serviceCalls: [{ serviceCallID: 5, status: 2, companyID: 44, ticketIDs: [555001] }],
      missingTime: [{ ticketID: 555001, serviceCallID: 5 }],
      totals: { assignedTickets: 0, serviceCalls: 1, openTodos: 1, timeEntries: 1, hoursLogged: 1, missingTime: 1 },
    } as any);
    jest.spyOn(s, 'searchTickets').mockResolvedValue({ items: [] } as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_get_my_day', { resourceID: 1001 }));
    expect(b.data.timeEntries[0]).toEqual(expect.objectContaining({ workTypeName: 'Remote Support', ticketNumber: 'T20261124.0042' }));
    expect(b.data.openTasks[0]).toEqual(expect.objectContaining({ statusLabel: 'New', projectName: 'Mail migration' }));
    expect(b.data.openTodos[0]).toEqual(expect.objectContaining({ actionTypeLabel: 'Phone Call', assignedTo: 'Pat Lee', company: 'Acme Dental', contactName: 'Alex Kim' }));
    expect(b.data.serviceCalls[0]).toEqual(expect.objectContaining({ statusLabel: 'Scheduled', company: 'Acme Dental', tickets: [{ id: 555001, ticketNumber: 'T20261124.0042', title: 'Printer offline' }] }));
  });
});
