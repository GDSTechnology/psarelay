// set_ticket_contract (financial, dry-run first) + the contract filters on
// search_tickets / search_time_entries. Live case it models: T20260714.0198 on
// inactive 29685471 should be on 29685345; its time entries carried their own
// contractIDs (two on 29685471, three on none), so moving the ticket alone
// would not fix the labor.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import { planContractMove } from '../src/utils/ticket-contract';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
afterEach(() => jest.restoreAllMocks());

const OLD = { id: 29685471, companyID: 1, contractNumber: 'GDSQ3283-01', status: 0, startDate: '2026-07-14', endDate: '2026-08-21' };
const TARGET = { id: 29685345, companyID: 1, contractNumber: 'GDSQ3201-01', status: 1, startDate: '2026-04-24', endDate: '2026-10-16' };
const ENTRIES = [
  { id: 54339, contractID: 29685471, dateWorked: '2026-07-17', hoursWorked: 0.15, isNonBillable: true },
  { id: 54883, contractID: 29685471, dateWorked: '2026-08-17', hoursWorked: 3 },
  { id: 54956, contractID: null, dateWorked: '2026-08-21', hoursWorked: 6 },
  { id: 55178, contractID: null, dateWorked: '2026-09-10', hoursWorked: 0.5 },
];

describe('planContractMove', () => {
  test('default old_or_none: ticket + entries on the old contract or none move; posted and third-contract entries are left', () => {
    const p = planContractMove({ id: 200523, companyID: 1, contractID: 29685471, contractServiceID: 77 }, TARGET,
      [...ENTRIES, { id: 1, contractID: 999, dateWorked: '2026-08-01' }, { id: 2, contractID: null, dateWorked: '2026-08-02', billingApprovalDateTime: '2026-09-01' }], 'old_or_none');
    expect(p.errors).toEqual([]);
    expect(p.ticketPatch).toEqual({ contractID: 29685345, contractServiceID: null });
    expect(p.entries.map((e) => `${e.id}:${e.action}`)).toEqual(['54339:move', '54883:move', '54956:move', '55178:move', '1:skip_other_contract', '2:skip_posted']);
    expect(p.warnings.join(' ')).toMatch(/contractServiceID 77 .* cleared.*POSTED.*\(2\).*third contract/);
  });

  test('ticket ALREADY on the target (moved in the UI): old contract must be named via fromContractID', () => {
    const t = { id: 200523, companyID: 1, contractID: 29685345 };
    const blind = planContractMove(t, TARGET, ENTRIES, 'old_or_none');
    expect(blind.ticketPatch).toBeNull();
    expect(blind.counts).toMatchObject({ move: 2, skip_other_contract: 2 });
    expect(blind.warnings[0]).toMatch(/already on contract 29685345, .* pass fromContractID \(e\.g\. 29685471\)/);
    const named = planContractMove(t, TARGET, ENTRIES, 'old_or_none', { fromContractID: 29685471 });
    expect(named.counts).toMatchObject({ move: 4, skip_other_contract: 0 });
  });

  test('refuses: other company, inactive target (unless allowInactive); flags entries outside the contract dates', () => {
    expect(planContractMove({ id: 1, companyID: 2, contractID: null }, TARGET, [], 'none').errors[0]).toMatch(/belongs to company 1, the ticket to company 2/);
    expect(planContractMove({ id: 1, companyID: 1, contractID: 29685345 }, OLD, [], 'none').errors[0]).toMatch(/INACTIVE/);
    expect(planContractMove({ id: 1, companyID: 1, contractID: 29685345 }, OLD, [], 'none', { allowInactive: true }).errors).toEqual([]);
    const late = planContractMove({ id: 1, companyID: 1, contractID: 29685471 }, TARGET, [{ id: 9, contractID: null, dateWorked: '2026-11-02' }], 'old_or_none');
    expect(late.warnings[0]).toMatch(/outside contract 29685345's dates .* 9 on 2026-11-02/);
  });
});

describe('setTicketContract (service)', () => {
  function mk(entriesAfter?: any[]) {
    const s = new AutotaskService(config, logger);
    let ticket: any = { id: 200523, ticketNumber: 'T20260714.0198', companyID: 1, contractID: 29685471 };
    const http = {
      get: jest.fn(async () => ({ ...ticket })),
      query: jest.fn(async (e: string) => (e === 'Contracts' ? [OLD, TARGET] : (entriesAfter && ticket.contractID === 29685345 ? entriesAfter : ENTRIES))),
    };
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue(http);
    const upT = jest.spyOn(s, 'updateTicket').mockImplementation(async (_id, p: any) => { ticket = { ...ticket, ...p }; });
    const upE = jest.spyOn(s, 'updateTimeEntry').mockResolvedValue(undefined);
    return { s, http, upT, upE };
  }

  test('dry run (default) writes nothing', async () => {
    const { s, upT, upE } = mk();
    const r: any = await s.setTicketContract({ ticketID: 200523, contractID: 29685345 });
    expect(r.status).toBe('dry_run');
    expect(upT).not.toHaveBeenCalled(); expect(upE).not.toHaveBeenCalled();
  });

  test('execute: ticket, then each entry; verified from a re-read', async () => {
    const { s, upT, upE } = mk(ENTRIES.map((e) => ({ id: e.id, contractID: 29685345 })));
    const r: any = await s.setTicketContract({ ticketID: 200523, contractID: 29685345, dryRun: false });
    expect(upT).toHaveBeenCalledWith(200523, { contractID: 29685345 });
    expect(upE.mock.calls.map((c) => c[0])).toEqual([54339, 54883, 54956, 55178]);
    expect(upE).toHaveBeenCalledWith(54956, { contractID: 29685345 });
    expect(r.status).toBe('updated');
    expect(r.verified).toMatchObject({ ticketOk: true, entriesNotMoved: [] });
  });

  test('a re-read that disagrees → partial, naming the entries that did not move', async () => {
    const { s } = mk(ENTRIES.map((e) => ({ id: e.id, contractID: e.id === 54956 ? null : 29685345 })));
    const r: any = await s.setTicketContract({ ticketID: 200523, contractID: 29685345, dryRun: false });
    expect(r.status).toBe('partial');
    expect(r.verified.entriesNotMoved).toEqual([54956]);
  });
});

describe('handler: financial + dry-run first', () => {
  test('a dry run needs no confirm; executing without confirm:true is refused', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'resolveTicketRef').mockResolvedValue({ id: 200523, ticketNumber: 'T20260714.0198' });
    const run = jest.spyOn(s, 'setTicketContract').mockResolvedValue({ status: 'dry_run', ticketNumber: 'T20260714.0198', from: { id: 29685471, number: 'GDSQ3283-01' }, to: { id: 29685345, number: 'GDSQ3201-01' }, plan: { errors: [], warnings: [], counts: { move: 4 } } });
    const h = new AutotaskToolHandler(s, logger);
    const dry = JSON.parse((await h.callTool('autotask_set_ticket_contract', { ticketNumber: 'T20260714.0198', contractID: 29685345 })).content[0].text);
    expect(dry.message).toMatch(/^DRY RUN \(nothing written\) — T20260714\.0198: contract 29685471 \(GDSQ3283-01\) → 29685345 \(GDSQ3201-01\); time entries: 4 to move/);
    const noConfirm = JSON.parse((await h.callTool('autotask_set_ticket_contract', { ticketNumber: 'T20260714.0198', contractID: 29685345, dryRun: false })).content[0].text);
    expect(noConfirm.data.status).toBe('confirmation_required');
    expect(run).toHaveBeenCalledTimes(1);
    await h.callTool('autotask_set_ticket_contract', { ticketNumber: 'T20260714.0198', contractID: 29685345, fromContractID: 29685471, dryRun: false, confirm: true });
    expect(run).toHaveBeenLastCalledWith({ ticketID: 200523, contractID: 29685345, fromContractID: 29685471, entries: 'old_or_none', allowInactive: false, dryRun: false });
  });
});

describe('contract filters sent upstream', () => {
  function mkQ() {
    const s = new AutotaskService(config, logger);
    const query = jest.fn(async () => []);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    return { s, query };
  }
  test('search_tickets: contractID / noContract / includeCompleted', async () => {
    const { s, query } = mkQ();
    await s.searchTickets({ contractID: 29685345, includeCompleted: true } as any);
    expect((query.mock.calls[0] as any[])[1]).toEqual([{ op: 'eq', field: 'contractID', value: 29685345 }]);
    await s.searchTickets({ companyID: 1, noContract: true } as any);
    expect((query.mock.calls[1] as any[])[1]).toEqual([{ op: 'noteq', field: 'status', value: 5 }, { op: 'eq', field: 'companyID', value: 1 }, { op: 'notExist', field: 'contractID' }]);
  });
  test('search_time_entries: contractID / noContract', async () => {
    const { s, query } = mkQ();
    await s.searchTimeEntries({ ticketId: 200523, noContract: true } as any);
    expect((query.mock.calls[0] as any[])[1]).toEqual([{ op: 'eq', field: 'ticketID', value: 200523 }, { op: 'notExist', field: 'contractID' }]);
    await s.searchTimeEntries({ contractID: 29685345 } as any);
    expect((query.mock.calls[1] as any[])[1]).toEqual([{ op: 'eq', field: 'contractID', value: 29685345 }]);
  });
});
