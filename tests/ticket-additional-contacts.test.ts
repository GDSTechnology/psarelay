// TicketAdditionalContacts (#266): list / add / remove a ticket's additional contacts.
// Mocked http — asserts what is (and is NOT) written upstream.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const toolData = (result: { content: Array<{ text: string }> }): any => JSON.parse(result.content[0].text).data;
const findTool = (name: string) => TOOL_DEFINITIONS.find((t) => t.name === name);
afterEach(() => jest.restoreAllMocks());

const TICKET = { id: 500, ticketNumber: 'T20261118.0001', companyID: 10, contactID: 70 };
const contact = (over: Record<string, unknown> = {}) => ({ id: 71, firstName: 'Pat', lastName: 'Example', emailAddress: 'pat@example.com', companyID: 10, isActive: 1, ...over });

/** Fake http: Tickets / Contacts by id, TicketAdditionalContacts rows in memory. */
function fakeHttp(opts: { ticket?: any; contacts?: Record<number, any>; rows?: Array<{ id: number; ticketID: number; contactID: number }> } = {}) {
  const rows = [...(opts.rows ?? [])];
  const contacts = opts.contacts ?? { 71: contact() };
  const http = {
    get: jest.fn(async (entity: string, id: number) => entity === 'Tickets' ? (opts.ticket === undefined ? TICKET : opts.ticket) : (contacts[id] ?? null)),
    query: jest.fn(async (entity: string, filters: any[]) => {
      if (entity === 'Contacts') {
        const ids = filters.find((f) => f.field === 'id')?.value ?? [];
        return ids.map((i: number) => contacts[i]).filter(Boolean);
      }
      const t = filters.find((f) => f.field === 'ticketID')?.value;
      const c = filters.find((f) => f.field === 'contactID')?.value;
      return rows.filter((r) => r.ticketID === t && (c === undefined || r.contactID === c));
    }),
    childCreate: jest.fn(async (_p: string, ticketID: number, _c: string, body: any) => { const id = 9000 + rows.length; rows.push({ id, ticketID, contactID: body.contactID }); return id; }),
    childDelete: jest.fn(async (_p: string, _t: number, _c: string, id: number) => { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); }),
    rows,
  };
  return http;
}
function service(http: any) {
  const svc = new AutotaskService(config, logger);
  jest.spyOn(svc as any, 'ensureClient').mockResolvedValue(http);
  return svc;
}

describe('addTicketAdditionalContact', () => {
  test('adds through /Tickets/{id}/AdditionalContacts and verifies by read-back', async () => {
    const http = fakeHttp();
    const r = await service(http).addTicketAdditionalContact(500, 71);
    expect(http.childCreate).toHaveBeenCalledWith('Tickets', 500, 'AdditionalContacts', { ticketID: 500, contactID: 71 });
    expect(r).toMatchObject({ status: 'added', verified: true, associationID: 9000, email: 'pat@example.com', contactName: 'Pat Example' });
  });

  test('already there → nothing written', async () => {
    const http = fakeHttp({ rows: [{ id: 1, ticketID: 500, contactID: 71 }] });
    const r = await service(http).addTicketAdditionalContact(500, 71);
    expect(r).toMatchObject({ status: 'already_there', associationID: 1 });
    expect(http.childCreate).not.toHaveBeenCalled();
  });

  test("refuses another company's contact — nothing written", async () => {
    const http = fakeHttp({ contacts: { 71: contact({ companyID: 11 }) } });
    const r = await service(http).addTicketAdditionalContact(500, 71);
    expect(r).toMatchObject({ status: 'refused', reason: 'company_mismatch', ticketCompanyID: 10, contactCompanyID: 11 });
    expect(http.childCreate).not.toHaveBeenCalled();
  });

  test('company 0 (the tenant itself) matches company 0, not a missing company', async () => {
    const http = fakeHttp({ ticket: { ...TICKET, companyID: 0 }, contacts: { 71: contact({ companyID: 0 }), 72: contact({ id: 72, companyID: null }) } });
    expect((await service(http).addTicketAdditionalContact(500, 71)).status).toBe('added');
    expect(await service(http).addTicketAdditionalContact(500, 72)).toMatchObject({ status: 'refused', reason: 'company_mismatch' });
  });

  test.each([[0], [false], ['0']])('refuses an inactive contact (isActive %p)', async (isActive) => {
    const http = fakeHttp({ contacts: { 71: contact({ isActive }) } });
    const r = await service(http).addTicketAdditionalContact(500, 71);
    expect(r).toMatchObject({ status: 'refused', reason: 'inactive' });
    expect(http.childCreate).not.toHaveBeenCalled();
  });

  test('the Ticket Contact is not added (Autotask would clear the Ticket Contact field)', async () => {
    const http = fakeHttp({ contacts: { 70: contact({ id: 70 }) } });
    const r = await service(http).addTicketAdditionalContact(500, 70);
    expect(r.status).toBe('already_ticket_contact');
    expect(http.childCreate).not.toHaveBeenCalled();
  });

  test('refuses a 31st contact', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, ticketID: 500, contactID: 100 + i }));
    const http = fakeHttp({ rows });
    expect(await service(http).addTicketAdditionalContact(500, 71)).toMatchObject({ status: 'refused', reason: 'limit' });
    expect(http.childCreate).not.toHaveBeenCalled();
  });

  test('missing ticket / contact → nothing written', async () => {
    expect((await service(fakeHttp({ ticket: null })).addTicketAdditionalContact(500, 71)).status).toBe('not_found');
    expect((await service(fakeHttp({ contacts: {} })).addTicketAdditionalContact(500, 71)).status).toBe('contact_not_found');
  });

  test('a create that errors but landed is reported as added; one that did not land throws', async () => {
    const landed = fakeHttp();
    landed.childCreate.mockImplementationOnce(async () => { landed.rows.push({ id: 42, ticketID: 500, contactID: 71 }); throw new Error('HTTP 500'); });
    expect(await service(landed).addTicketAdditionalContact(500, 71)).toMatchObject({ status: 'added', associationID: 42, verified: true });
    const failed = fakeHttp();
    failed.childCreate.mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(service(failed).addTicketAdditionalContact(500, 71)).rejects.toThrow('HTTP 500');
  });
});

describe('list / remove', () => {
  test('list returns id, name and e-mail of each contact', async () => {
    const http = fakeHttp({ rows: [{ id: 1, ticketID: 500, contactID: 71 }] });
    const r = await service(http).listTicketAdditionalContacts(500);
    expect(r).toMatchObject({ status: 'ok', count: 1, companyID: 10, ticketContactID: 70 });
    expect(r.contacts[0]).toEqual({ associationID: 1, contactID: 71, name: 'Pat Example', email: 'pat@example.com', isActive: true });
  });

  test('remove deletes the link by its row id under the ticket, verified', async () => {
    const http = fakeHttp({ rows: [{ id: 1, ticketID: 500, contactID: 71 }] });
    const r = await service(http).removeTicketAdditionalContact(500, 71);
    expect(http.childDelete).toHaveBeenCalledWith('Tickets', 500, 'AdditionalContacts', 1);
    expect(r).toMatchObject({ status: 'removed', verified: true });
  });

  test('remove of a contact not on the ticket writes nothing', async () => {
    const http = fakeHttp();
    expect((await service(http).removeTicketAdditionalContact(500, 71)).status).toBe('not_there');
    expect(http.childDelete).not.toHaveBeenCalled();
  });
});

describe('search_contacts primaryContact (#266)', () => {
  test('{companyID, primaryContact: true} sends the filter upstream; every item carries a boolean primaryContact', async () => {
    const svc = new AutotaskService(config, logger);
    const qp = jest.spyOn(svc as any, 'queryPaged').mockResolvedValue({ items: [{ id: 1, companyID: 10, primaryContact: 1 }, { id: 2, companyID: 10 }], page: 1, pageSize: 25, hasMore: false });
    const r = await svc.searchContacts({ companyID: 10, primaryContact: true });
    expect(qp.mock.calls[0]![1]).toEqual(expect.arrayContaining([{ op: 'eq', field: 'companyID', value: 10 }, { op: 'eq', field: 'primaryContact', value: true }]));
    expect(r.items.map((c: any) => c.primaryContact)).toEqual([true, false]);
  });

  test('plain-mode tool output keeps primaryContact (false included)', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc as any, 'queryPaged').mockResolvedValue({ items: [{ id: 1, firstName: 'A', companyID: 10, primaryContact: true }, { id: 2, firstName: 'B', companyID: 10, primaryContact: false }], page: 1, pageSize: 25, hasMore: false });
    const handler = new AutotaskToolHandler(svc, logger);
    const result = await handler.callTool('autotask_search_contacts', { companyID: 10 });
    const body = JSON.parse(result.content[0]!.text);
    const items = body.items ?? body.data?.items ?? body.data;
    expect(items.map((c: any) => c.primaryContact)).toEqual([true, false]);
  });
});

describe('tools', () => {
  test('definitions: shapes and risk annotations', () => {
    expect(findTool('autotask_list_ticket_additional_contacts')!.inputSchema.required).toEqual(['ticketID']);
    expect((findTool('autotask_list_ticket_additional_contacts') as any).annotations.readOnlyHint).toBe(true);
    expect(findTool('autotask_add_ticket_additional_contact')!.inputSchema.required).toEqual(['ticketID', 'contactID']);
    const remove = findTool('autotask_remove_ticket_additional_contact') as any;
    expect(remove.inputSchema.required).toEqual(['ticketID', 'contactID']);
    expect(remove.annotations.destructiveHint).toBe(true);
  });

  test("add tool refuses another company's contact end to end", async () => {
    const http = fakeHttp({ contacts: { 71: contact({ companyID: 11 }) } });
    const handler = new AutotaskToolHandler(service(http), logger);
    const result = await handler.callTool('autotask_add_ticket_additional_contact', { ticketID: 500, contactID: 71 });
    expect(toolData(result)).toMatchObject({ status: 'refused', reason: 'company_mismatch' });
    expect(http.childCreate).not.toHaveBeenCalled();
  });

  test('remove needs confirm:true', async () => {
    const http = fakeHttp({ rows: [{ id: 1, ticketID: 500, contactID: 71 }] });
    const handler = new AutotaskToolHandler(service(http), logger);
    const first = await handler.callTool('autotask_remove_ticket_additional_contact', { ticketID: 500, contactID: 71 });
    expect(toolData(first)).toMatchObject({ status: 'confirmation_required' });
    expect(http.childDelete).not.toHaveBeenCalled();
    const second = await handler.callTool('autotask_remove_ticket_additional_contact', { ticketID: 500, contactID: 71, confirm: true });
    expect(toolData(second)).toMatchObject({ status: 'removed' });
  });

  test('create_ticket no longer sends ticketAdditionalContacts to Tickets; it adds them after the create', async () => {
    const svc = new AutotaskService(config, logger);
    const create = jest.spyOn(svc, 'createTicket').mockResolvedValue(500);
    const add = jest.spyOn(svc, 'addTicketAdditionalContact').mockResolvedValue({ status: 'added', contactID: 71 });
    const handler = new AutotaskToolHandler(svc, logger);
    const result = await handler.callTool('autotask_create_ticket', { companyID: 10, title: 'T', description: 'D', ticketAdditionalContacts: [71] });
    expect(create.mock.calls[0]![0]).not.toHaveProperty('ticketAdditionalContacts');
    expect(add).toHaveBeenCalledWith(500, 71);
    expect(toolData(result)).toMatchObject({ id: 500, additionalContacts: [{ status: 'added', contactID: 71 }] });
  });

  test('update_ticket with only ticketAdditionalContacts adds them and writes no ticket field', async () => {
    const svc = new AutotaskService(config, logger);
    const update = jest.spyOn(svc, 'updateTicket').mockResolvedValue(undefined);
    const add = jest.spyOn(svc, 'addTicketAdditionalContact').mockResolvedValue({ status: 'already_there', contactID: 71 });
    const handler = new AutotaskToolHandler(svc, logger);
    const result = await handler.callTool('autotask_update_ticket', { ticketId: 500, ticketAdditionalContacts: [71] });
    expect(update).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(500, 71);
    expect(toolData(result)).toMatchObject({ additionalContacts: [{ status: 'already_there' }] });
  });
});
