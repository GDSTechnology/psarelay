// Replies are read ALOUD by voice assistants (ChatGPT / Copilot voice): they name
// tickets by number + title, tasks by title + project, people by name — never an
// internal id (ids stay in `result` for the next call). Service mocked.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const body = (res: any) => JSON.parse(res.content[0].text) as { message: string; data: any };
afterEach(() => jest.restoreAllMocks());

const TICKET = { id: 555001, ticketNumber: 'T20261124.0042', title: 'Printer offline', companyID: 0 };
const TASK = { id: 777001, title: 'Migrate mailboxes', projectID: 880001 };

function mk() {
  const s = new AutotaskService(config, logger);
  jest.spyOn(s, 'getTicket').mockResolvedValue(TICKET as any);
  jest.spyOn(s, 'getTask').mockResolvedValue(TASK as any);
  jest.spyOn(s, 'getProject').mockResolvedValue({ id: 880001, projectName: 'Mail migration' } as any);
  jest.spyOn(s, 'getResourceNames').mockImplementation(async (ids: unknown[]) => new Map(ids.map(Number).map((i) => [i, i === 1001 ? 'Pat Lee' : i === 1002 ? 'Sam Roe' : `Person ${i}`] as [number, string])));
  jest.spyOn(s, 'getResourceRoles').mockResolvedValue([{ roleID: 7, roleName: 'Engineer', isActive: true, roleExists: true }] as any);
  jest.spyOn(s, 'getWorkTypes').mockResolvedValue([{ id: 101, name: 'Remote Support', active: true }]);
  jest.spyOn(s, 'getBillingCode').mockResolvedValue({ id: 101, name: 'Remote Support', useType: 1, isActive: true } as any);
  jest.spyOn(s, 'getRegularTimeCategories').mockResolvedValue([{ id: 201, name: 'Internal Meeting', active: true }]);
  jest.spyOn(s, 'getResource').mockResolvedValue(null);
  return { s, h: new AutotaskToolHandler(s, logger) };
}
const noIds = (msg: string, ...ids: number[]) => { for (const id of ids) expect(msg).not.toContain(String(id)); };

describe('spoken replies name things', () => {
  test('create_time_entry: hours, ticket number + title, person, role, work type — no ids', async () => {
    const { s, h } = mk();
    jest.spyOn(s, 'createTimeEntry').mockResolvedValue(990001 as any);
    jest.spyOn(s, 'getTimeEntry').mockResolvedValue({ id: 990001, ticketID: 555001, resourceID: 1001, roleID: 7, hoursWorked: 1.5, billingCodeID: 101 } as any);
    const b = body(await h.callTool('autotask_create_time_entry', { ticketID: 555001, resourceID: 1001, roleID: 7, billingCodeID: 101, hoursWorked: 1.5, dateWorked: '2026-11-24', summaryNotes: 'x' }));
    expect(b.message).toContain('Logged 1.5 hours on T20261124.0042 — Printer offline');
    expect(b.message).toContain('as Engineer');
    expect(b.message).toContain('work type Remote Support');
    noIds(b.message, 990001, 555001, 7, 101);
    expect(b.data.id).toBe(990001); // the id is still there for the next call
  });

  test('log_my_time on a task: task title and project', async () => {
    const { s, h } = mk();
    jest.spyOn(s, 'logTimeIdempotent').mockResolvedValue({ created: true, id: 990002 } as any);
    const b = body(await h.callTool('autotask_log_my_time', { taskID: 777001, resourceID: 1001, roleID: 7, billingCodeID: 101, hoursWorked: 2, dateWorked: '2026-11-24', summaryNotes: 'x' }));
    expect(b.message).toContain('Logged 2 hours on task "Migrate mailboxes" on project Mail migration');
    noIds(b.message, 990002, 777001);
  });

  test('Regular Time says the category by name', async () => {
    const { s, h } = mk();
    jest.spyOn(s, 'logTimeIdempotent').mockResolvedValue({ created: true, id: 990003 } as any);
    const b = body(await h.callTool('autotask_log_my_time', { internalBillingCodeID: 201, resourceID: 1001, hoursWorked: 1, dateWorked: '2026-11-24', summaryNotes: 'x' }));
    expect(b.message).toContain('as Regular Time: Internal Meeting');
    noIds(b.message, 201, 990003);
  });

  test('update_ticket: people by name, plain field words', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([]);
    let written = false;
    jest.spyOn(s, 'updateTicket').mockImplementation(async () => { written = true; });
    jest.spyOn(s, 'getTicket').mockImplementation(async () => ({ ...TICKET, assignedResourceID: written ? 1002 : 1001 }) as any);
    jest.spyOn(s, 'getResourceNames').mockResolvedValue(new Map([[1001, 'Pat Lee'], [1002, 'Sam Roe']]));
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([] as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_update_ticket', { ticketId: 555001, assignedResourceID: 1002 }));
    expect(b.message).toContain('Updated T20261124.0042 — Printer offline');
    expect(b.message).toContain('Sam Roe');
    noIds(b.message, 1002, 555001);
  });

  test('tasks: get / complete name the task', async () => {
    const { s, h } = mk();
    expect(body(await h.callTool('autotask_get_task', { id: 777001 })).message).toBe('Task "Migrate mailboxes" on project Mail migration');
    jest.spyOn(s, 'completeTask').mockResolvedValue(undefined as any);
    expect(body(await h.callTool('autotask_complete_task', { id: 777001 })).message).toBe('Marked task "Migrate mailboxes" on project Mail migration complete');
  });

  test('a ticket note and a service-call link name the ticket and the person', async () => {
    const { s, h } = mk();
    jest.spyOn(s, 'createTicketNote').mockResolvedValue(66001 as any);
    expect(body(await h.callTool('autotask_create_ticket_note', { ticketId: 555001, description: 'x', title: 'y', noteType: 1, publish: 1 })).message).toBe('Added a note to T20261124.0042 — Printer offline');
    jest.spyOn(s, 'createServiceCallTicket').mockResolvedValue(66002 as any);
    expect(body(await h.callTool('autotask_create_service_call_ticket', { serviceCallID: 5, ticketID: 555001 })).message).toBe('Added T20261124.0042 — Printer offline to the service call');
    jest.spyOn(s, 'createServiceCallTicketResource').mockResolvedValue(66003 as any);
    expect(body(await h.callTool('autotask_create_service_call_ticket_resource', { serviceCallTicketID: 66002, resourceID: 1001 })).message).toBe('Assigned Pat Lee to the service call ticket');
  });

  test('a lookup that fails still answers (falls back to "ticket <id>")', async () => {
    const { s, h } = mk();
    (s.getTicket as jest.Mock).mockRejectedValue(new Error('down'));
    jest.spyOn(s, 'createTicketNote').mockResolvedValue(66001 as any);
    expect(body(await h.callTool('autotask_create_ticket_note', { ticketId: 555001, description: 'x', title: 'y', noteType: 1, publish: 1 })).message).toBe('Added a note to ticket 555001');
  });

  test('the server instructions tell the assistant to speak numbers and names', () => {
    const { PsarelayServer } = require('../src/mcp/server');
    const text: string = PsarelayServer.prototype.getServerInstructions.call({});
    expect(text).toContain('Speaking to people');
    expect(text).toContain('ticket number and title');
    expect(text).not.toContain('39 total');
  });
});
