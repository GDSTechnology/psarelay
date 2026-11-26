// get_ticket_details and the other get / search tools carry picklist labels and
// names next to ids (same record shape), and their replies say what the record
// IS instead of "retrieved successfully". Service mocked.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const body = (res: any) => JSON.parse(res.content[0].text) as { message: string; data: any };
afterEach(() => jest.restoreAllMocks());

const pv = (pairs: Array<[number, string]>) => pairs.map(([value, label]) => ({ value: String(value), label, isActive: true }));
const FIELDS: Record<string, any[]> = {
  Tickets: [
    { name: 'status', picklistValues: pv([[1, 'New'], [8, 'In Progress']]) },
    { name: 'priority', picklistValues: pv([[2, 'High']]) },
    { name: 'queueID', picklistValues: pv([[300, 'Tier 1 Support']]) },
    { name: 'issueType', picklistValues: pv([[12, 'Printing']]) },
  ],
  Tasks: [{ name: 'status', picklistValues: pv([[1, 'New']]) }],
  Projects: [{ name: 'status', picklistValues: pv([[2, 'Active']]) }],
  ServiceCalls: [{ name: 'status', picklistValues: pv([[2, 'Scheduled']]) }],
  Contracts: [{ name: 'status', picklistValues: pv([[1, 'Active']]) }],
  CompanyToDos: [{ name: 'actionType', picklistValues: pv([[3, 'Phone Call']]) }],
};
const ROWS: Record<string, Array<Record<string, any>>> = {
  Roles: [{ id: 7, name: 'Engineer' }],
  Contacts: [{ id: 330001, firstName: 'Alex', lastName: 'Kim' }],
  Projects: [{ id: 880001, projectName: 'Mail migration' }],
};

function mk() {
  const s = new AutotaskService(config, logger);
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue({
    queryByIds: jest.fn(async (entity: string, _f: string, ids: number[]) => ({ items: (ROWS[entity] ?? []).filter((r) => ids.includes(r.id)), failedChunks: [] })),
    query: jest.fn(async () => []),
  });
  jest.spyOn(s, 'getFieldInfo').mockImplementation(async (e: string) => FIELDS[e] ?? []);
  jest.spyOn(s, 'getResourceNames').mockImplementation(async (ids: unknown[]) => new Map(ids.map(Number).map((i) => [i, i === 1001 ? 'Pat Lee' : `Person ${i}`] as [number, string])));
  jest.spyOn(s, 'getCompanyNamesByIds').mockResolvedValue([{ id: 44, companyName: 'Acme Dental' }]);
  jest.spyOn(s, 'getTicketWebUrl').mockReturnValue('https://ww.example/ticket');
  return { s, h: new AutotaskToolHandler(s, logger) };
}

describe('get / search carry names and labels', () => {
  test('get_ticket_details: labels + names on the same record, and a spoken summary', async () => {
    const { s, h } = mk();
    jest.spyOn(s, 'getTicket').mockResolvedValue({ id: 555001, ticketNumber: 'T20261124.0042', title: 'Printer offline', status: 8, priority: 2, queueID: 300, issueType: 12, companyID: 44, contactID: 330001, assignedResourceID: 1001, assignedResourceRoleID: 7 } as any);
    const b = body(await h.callTool('autotask_get_ticket_details', { ticketID: 555001 }));
    expect(b.data).toEqual(expect.objectContaining({ status: 8, statusLabel: 'In Progress', priorityLabel: 'High', queueLabel: 'Tier 1 Support', issueTypeLabel: 'Printing', company: 'Acme Dental', contactName: 'Alex Kim', assignedTo: 'Pat Lee', roleName: 'Engineer' }));
    expect(b.message).toBe('T20261124.0042 — Printer offline: status In Progress, priority High, queue Tier 1 Support, company Acme Dental, contact Alex Kim, assigned to Pat Lee (Engineer), issue Printing. Open in Autotask: https://ww.example/ticket');
  });

  test('get_project / get_contract / get_service_call / get_company_todo say what the record is', async () => {
    const { s, h } = mk();
    jest.spyOn(s, 'getProject').mockResolvedValue({ id: 880001, projectName: 'Mail migration', status: 2, companyID: 44 } as any);
    expect(body(await h.callTool('autotask_get_project', { id: 880001 })).message).toBe('Project Mail migration — Active, Acme Dental');
    jest.spyOn(s, 'getContract').mockResolvedValue({ id: 9, contractName: 'Managed Services', contractType: 7, status: 1, companyID: 44 } as any);
    expect(body(await h.callTool('autotask_get_contract', { id: 9 })).message).toBe('Contract Managed Services — Recurring Service, Active, Acme Dental');
    jest.spyOn(s, 'getServiceCall').mockResolvedValue({ id: 5, startDateTime: '2026-11-24T14:00:00Z', status: 2, companyID: 44, description: 'Swap printer' } as any);
    expect(body(await h.callTool('autotask_get_service_call', { serviceCallId: 5 })).message).toBe('Service call 2026-11-24 14:00 for Acme Dental — Scheduled: Swap printer');
    jest.spyOn(s, 'getCompanyToDo').mockResolvedValue({ id: 6, actionType: 3, companyID: 44, assignedToResourceID: 1001, activityDescription: 'Call back' } as any);
    expect(body(await h.callTool('autotask_get_company_todo', { id: 6 })).message).toBe('To-Do (Phone Call) for Acme Dental, assigned to Pat Lee: Call back');
  });

  test('search_tasks keeps statusLabel and projectName in the compact rows', async () => {
    const { s, h } = mk();
    jest.spyOn(s, 'searchTasks').mockResolvedValue({ items: [{ id: 1, title: 'Migrate', status: 1, projectID: 880001 }], hasMore: false, page: 1, pageSize: 25 } as any);
    const b = JSON.parse((await h.callTool('autotask_search_tasks', {})).content[0].text);
    const rows = b.items;
    expect(rows[0]).toEqual(expect.objectContaining({ statusLabel: 'New', projectName: 'Mail migration' }));
  });
});
