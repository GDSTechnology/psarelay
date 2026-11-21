// autotask_notify_ticket / create_ticket_note notify:true — e-mail a note to the ticket contact and
// additional contacts by arming the tenant's trigger UDF, tagging people by contact id or e-mail.
// Asserts what is (and is NOT) written upstream, and in which order.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import { notifyConfig, parseNotifyTags, type NotifyConfig } from '../src/utils/ticket-notify';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const CFG: NotifyConfig = { udf: 'Notify-Trigger', value: 'Send', publish: 1, noteType: 1 };
afterEach(() => { jest.restoreAllMocks(); delete process.env.AUTOTASK_NOTIFY_UDF; });

const TICKET = { id: 500, ticketNumber: 'T20261120.0001', companyID: 10, contactID: 70 };
const C = (id: number, over: Record<string, unknown> = {}) => ({ id, firstName: 'P' + id, lastName: 'Example', emailAddress: `p${id}@example.com`, companyID: 10, isActive: 1, primaryContact: false, ...over });

function setup(opts: { ticket?: any; contacts?: any[]; rows?: Array<{ id: number; ticketID: number; contactID: number }>; notes?: any[]; noteFails?: boolean } = {}) {
  const contacts = opts.contacts ?? [C(70), C(71), C(72, { primaryContact: true })];
  const rows = [...(opts.rows ?? [])];
  const writes: string[] = [];
  const http = {
    get: jest.fn(async (entity: string, id: number) => entity === 'Tickets' ? (opts.ticket === undefined ? TICKET : opts.ticket) : (contacts.find((c) => c.id === id) ?? null)),
    query: jest.fn(async (entity: string, filters: any[]) => {
      const f = (n: string) => filters.find((x) => x.field === n);
      if (entity === 'Contacts') {
        return contacts.filter((c: any) => filters.every((x) => x.op === 'in' ? x.value.includes(c[x.field]) : x.field === 'primaryContact' ? c.primaryContact === x.value : String(c[x.field] ?? '').toLowerCase() === String(x.value).toLowerCase()));
      }
      return rows.filter((r) => r.ticketID === f('ticketID')?.value && (f('contactID') === undefined || r.contactID === f('contactID').value));
    }),
  };
  const svc = new AutotaskService(config, logger);
  jest.spyOn(svc as any, 'ensureClient').mockResolvedValue(http);
  jest.spyOn(svc, 'updateTicket').mockImplementation(async (_id, u: any) => { writes.push(u.userDefinedFields ? `udf=${u.userDefinedFields[0].value}` : `contact=${u.contactID}`); });
  jest.spyOn(svc, 'addTicketAdditionalContact').mockImplementation(async (_t, c) => { writes.push(`add=${c}`); return { status: 'added', contactID: c }; });
  jest.spyOn(svc, 'searchTicketNotes').mockResolvedValue(opts.notes ?? []);
  const note = jest.spyOn(svc, 'createTicketNote').mockImplementation(async (_t, n: any) => { writes.push(`note publish=${n.publish}`); if (opts.noteFails) throw new Error('HTTP 500'); return 9001; });
  return { svc, http, writes, note };
}

describe('config and tags', () => {
  test('no AUTOTASK_NOTIFY_UDF → not configured; defaults Send / publish 1', () => {
    expect(notifyConfig({})).toBeNull();
    expect(notifyConfig({ AUTOTASK_NOTIFY_UDF: 'X' })).toEqual({ udf: 'X', value: 'Send', publish: 1, noteType: 1 });
    expect(notifyConfig({ AUTOTASK_NOTIFY_UDF: 'X', AUTOTASK_NOTIFY_VALUE: 'Go', AUTOTASK_NOTIFY_PUBLISH: '3', AUTOTASK_NOTIFY_NOTE_TYPE: 'x' })).toEqual({ udf: 'X', value: 'Go', publish: 3, noteType: 1 });
  });
  test('tags: ids, addresses, "Name <address>", duplicates once, junk listed', () => {
    expect(parseNotifyTags(['71', 72, 'Pat <PAT@Example.com>', 'pat@example.com', 'bob', ''])).toEqual({
      tags: [{ contactID: 71 }, { contactID: 72 }, { email: 'pat@example.com' }], invalid: ['bob'] });
  });
});

describe('notifyTicket', () => {
  test('not configured → nothing read or written', async () => {
    const { svc, http, writes } = setup();
    const r = await svc.notifyTicket({ ticketID: 500, description: 'Hi', config: null });
    expect(r.status).toBe('not_configured');
    expect(http.get).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  test('dry run (default) lists recipients and writes nothing', async () => {
    const { svc, writes } = setup({ rows: [{ id: 1, ticketID: 500, contactID: 71 }] });
    const r = await svc.notifyTicket({ ticketID: 500, description: 'Fixed', tag: ['p72@example.com'], config: CFG });
    expect(r.status).toBe('dry_run');
    expect(r.recipients.map((p: any) => [p.contactID, p.as])).toEqual([[70, 'ticket contact'], [71, 'additional contact'], [72, 'additional contact']]);
    expect(r.addAdditionalContacts).toEqual([72]);
    expect(writes).toEqual([]);
  });

  test('send: people added, THEN trigger armed, THEN the client-visible note', async () => {
    const { svc, writes } = setup();
    const r = await svc.notifyTicket({ ticketID: 500, description: 'Fixed', tag: ['71'], tagPrimaryContact: true, config: CFG, dryRun: false });
    expect(r).toMatchObject({ status: 'sent', noteId: 9001 });
    expect(writes).toEqual(['add=71', 'add=72', 'udf=Send', 'note publish=1']);
  });

  test('no Ticket Contact: the first tagged person becomes it', async () => {
    const { svc, writes } = setup({ ticket: { ...TICKET, contactID: null } });
    const r = await svc.notifyTicket({ ticketID: 500, description: 'Hi', tag: ['71', '72'], config: CFG, dryRun: false });
    expect(r.setTicketContact).toBe(71);
    expect(writes).toEqual(['contact=71', 'add=72', 'udf=Send', 'note publish=1']);
  });

  test('no Ticket Contact and nobody tagged → refused', async () => {
    const { svc, writes } = setup({ ticket: { ...TICKET, contactID: null } });
    expect((await svc.notifyTicket({ ticketID: 500, description: 'Hi', config: CFG, dryRun: false })).reason).toBe('no_recipient');
    expect(writes).toEqual([]);
  });

  test('one bad tag refuses the whole call — other company, inactive, unknown address, ambiguous', async () => {
    const { svc, writes } = setup({ contacts: [C(70), C(71), C(80, { companyID: 11 }), C(81, { isActive: 0 }), C(82, { emailAddress: 'dup@example.com' }), C(83, { emailAddress2: 'dup@example.com' })] });
    for (const tag of [['80'], ['81'], ['nobody@example.com'], ['dup@example.com'], ['71', 'bob']]) {
      const r = await svc.notifyTicket({ ticketID: 500, description: 'Hi', tag, config: CFG, dryRun: false });
      expect(r.status).toBe('validation_failed');
    }
    expect(writes).toEqual([]);
  });

  test('company 0 (the tenant itself) is a real company', async () => {
    const { svc } = setup({ ticket: { ...TICKET, companyID: 0 }, contacts: [C(70, { companyID: 0 }), C(71, { companyID: 0 })] });
    expect((await svc.notifyTicket({ ticketID: 500, description: 'Hi', tag: ['p71@example.com'], config: CFG })).status).toBe('dry_run');
  });

  test('a publish other than the rule\'s refuses; idempotencyKey already used → duplicate, trigger NOT armed', async () => {
    const { svc, writes } = setup({ notes: [{ id: 5, description: 'x [MCP-ID:k1]' }] });
    expect((await svc.notifyTicket({ ticketID: 500, description: 'Hi', publish: 2, config: CFG, dryRun: false })).status).toBe('validation_failed');
    expect((await svc.notifyTicket({ ticketID: 500, description: 'Hi', idempotencyKey: 'k1', config: CFG, dryRun: false })).status).toBe('duplicate');
    expect(writes).toEqual([]);
  });

  test('the note fails → the trigger is disarmed again', async () => {
    const { svc, writes } = setup({ noteFails: true });
    await expect(svc.notifyTicket({ ticketID: 500, description: 'Hi', config: CFG, dryRun: false })).rejects.toThrow('HTTP 500');
    expect(writes).toEqual(['udf=Send', 'note publish=1', 'udf=']);
  });
});

describe('tools', () => {
  const handler = (svc: AutotaskService) => { const h = new AutotaskToolHandler(svc, logger); return h; };
  const data = (r: any) => JSON.parse(r.content[0].text);

  test('notify_ticket is listed, defaults to a dry run, and sends with dryRun:false', async () => {
    process.env.AUTOTASK_NOTIFY_UDF = 'Notify-Trigger';
    expect(TOOL_DEFINITIONS.find((t) => t.name === 'autotask_notify_ticket')).toBeDefined();
    const { svc, writes } = setup();
    const h = handler(svc);
    const dry = data(await h.callTool('autotask_notify_ticket', { ticketID: 500, message: 'Fixed', tag: ['71'] }));
    expect(dry.data.status).toBe('dry_run');
    expect(writes).toEqual([]);
    const sent = data(await h.callTool('autotask_notify_ticket', { ticketID: 500, message: 'Fixed', tag: ['71'], dryRun: false }));
    expect(sent.data.status).toBe('sent');
    expect(sent.message).toContain('p71@example.com');
    expect(writes).toEqual(['add=71', 'udf=Send', 'note publish=1']);
  });

  test('create_ticket_note notify:true sends; without notify it still needs noteType and publish', async () => {
    process.env.AUTOTASK_NOTIFY_UDF = 'Notify-Trigger';
    const { svc, writes } = setup();
    const h = handler(svc);
    expect(data(await h.callTool('autotask_create_ticket_note', { ticketId: 500, description: 'Fixed', noteType: 1, publish: 1, notify: true })).data.status).toBe('sent');
    expect(writes).toEqual(['udf=Send', 'note publish=1']);
    const plain = await h.callTool('autotask_create_ticket_note', { ticketId: 500, description: 'x' });
    expect(plain.content[0].text).toContain('noteType is required');
  });
});
