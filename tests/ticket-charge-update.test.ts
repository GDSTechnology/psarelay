// Ticket charge corrections.
// (1) Updates go through the ticket: PATCH /Tickets/{id}/Charges. TicketCharges has no
//     top-level update route — PATCH /TicketCharges 404'd and the fallback PUT
//     /TicketCharges/{id} answered HTTP 405 (live, 2026-11-05), so a wrong invoice
//     description could not be corrected.
// (2) Name / description print on the invoice: cost, markup, supplier / pickup and
//     serial notes are refused before anything is written.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import { findInternalText, internalTextProblem } from '../src/utils/invoice-text';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

const BAD = 'Supply house pickup - SW-8; no serial number. Cost $30.23, 30% markup.';
const GOOD = '8-Port Gigabit Desktop Ethernet Switch - unmanaged, 8 x 10/100/1000 Mbps RJ45 ports, fanless metal enclosure.';

describe('invoice text guard', () => {
  test('flags purchasing notes, cost and markup; passes a product description', () => {
    expect(findInternalText(BAD)).toEqual(expect.arrayContaining(['markup', 'a cost figure', 'supplier / purchasing details', 'pickup instructions', 'serial-number notes']));
    expect(findInternalText(GOOD)).toEqual([]);
    expect(findInternalText('Cat6 Patch Cable 3ft, blue')).toEqual([]);
    expect(findInternalText('Low-cost replacement keyboard')).toEqual([]); // "cost" without a figure is fine
    expect(internalTextProblem({ name: 'Switch', description: GOOD })).toBeNull();
    expect(internalTextProblem({ description: BAD })).toMatch(/description contains .*markup/);
  });
});

function mk(charge: Record<string, unknown>) {
  const s = new AutotaskService(config, logger);
  let row = { ...charge };
  const childUpdate = jest.fn(async (_p: string, _pid: number, _c: string, _id: number, body: Record<string, unknown>) => { row = { ...row, ...body }; });
  const update = jest.fn();
  const query = jest.fn(async () => [{ ...row }]);
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query, childUpdate, update, request: jest.fn() });
  return { h: new AutotaskToolHandler(s, logger), childUpdate, update, query };
}
const call = async (h: AutotaskToolHandler, name: string, args: Record<string, unknown>) => JSON.parse((await h.callTool(name, args)).content[0]!.text);
const CHARGE = { id: 900001, ticketID: 42, name: 'Switch', description: BAD, unitQuantity: 1, unitCost: 30.23, unitPrice: 39.3, status: 1 };

describe('autotask_update_ticket_charge', () => {
  test('corrects name + description through the ticket, PATCHing only those fields; quantity / cost / price kept', async () => {
    const { h, childUpdate, update } = mk(CHARGE);
    const r = await call(h, 'autotask_update_ticket_charge', { chargeId: 900001, name: 'Acme SW-8 8-Port Gigabit Desktop Switch', description: GOOD, confirm: true });
    expect(update).not.toHaveBeenCalled(); // never the top-level route (404 → PUT 405)
    expect(childUpdate).toHaveBeenCalledWith('Tickets', 42, 'Charges', 900001, { name: 'Acme SW-8 8-Port Gigabit Desktop Switch', description: GOOD });
    expect(r.message).toMatch(/^Updated ticket charge 900001 on ticket 42 \(verified/);
    expect(r.message).toMatch(/Unchanged: unitQuantity 1, unitCost 30\.23, unitPrice 39\.3/);
    expect(r.data?.after ?? r.result?.after ?? r).toBeTruthy();
  });

  test('refuses internal text on the invoice before writing; allowInternalText overrides', async () => {
    const { h, childUpdate } = mk(CHARGE);
    const r = await call(h, 'autotask_update_ticket_charge', { chargeId: 900001, description: BAD, confirm: true });
    expect(r.message).toMatch(/^NOTHING WRITTEN — .*invoice/);
    expect(childUpdate).not.toHaveBeenCalled();
    await call(h, 'autotask_update_ticket_charge', { chargeId: 900001, description: 'Pickup truck bed liner', allowInternalText: true, confirm: true });
    expect(childUpdate).toHaveBeenCalledTimes(1);
  });

  test('still needs confirm (financial)', async () => {
    const { h, childUpdate } = mk(CHARGE);
    const r = await call(h, 'autotask_update_ticket_charge', { chargeId: 900001, description: GOOD });
    expect(JSON.stringify(r)).toMatch(/confirm/i);
    expect(childUpdate).not.toHaveBeenCalled();
  });

  test('a value Autotask did not apply is reported, not claimed', async () => {
    const s = new AutotaskService(config, logger);
    const childUpdate = jest.fn();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: jest.fn(async () => [{ ...CHARGE }]), childUpdate });
    const r = await call(new AutotaskToolHandler(s, logger), 'autotask_update_ticket_charge', { chargeId: 900001, description: GOOD, confirm: true });
    expect(r.message).toMatch(/WARNING: Autotask did not apply description/);
  });

  test('create_ticket_charge refuses cost / markup in the description', async () => {
    const s = new AutotaskService(config, logger);
    const created = jest.spyOn(s, 'createTicketCharge').mockResolvedValue(1);
    const r = await call(new AutotaskToolHandler(s, logger), 'autotask_create_ticket_charge', { ticketID: 42, name: 'Switch', description: BAD, chargeType: 1, confirm: true });
    expect(r.message).toMatch(/^NOTHING WRITTEN/);
    expect(created).not.toHaveBeenCalled();
  });
});
