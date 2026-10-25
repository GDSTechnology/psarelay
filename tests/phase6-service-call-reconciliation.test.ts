// Weekly billing-leakage sweep — reconciliation rules + history-based assignee
// recovery. Modeled on live ticket 200510. Pure functions; service sweep mocked.

import { reconcileServiceCall, recoverAssignees } from '../src/utils/service-call-reconciliation';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const NOW = new Date('2026-09-18T00:00:00Z');
const base = {
  ticketId: 200510, ticketNumber: 'T20260714.0185', now: NOW,
  timeEntries: [], charges: [], history: [],
};

describe('reconcileServiceCall (pure)', () => {
  test('done-not-closed: open, past window, time logged in window', () => {
    const r = reconcileServiceCall({
      ...base,
      serviceCall: { id: 4688, isComplete: 0, status: 1, startDateTime: '2026-08-10T15:00:00Z', endDateTime: '2026-08-10T18:00:00Z' },
      timeEntries: [
        { resourceID: 30683890, dateWorked: '2026-08-10T00:00:00Z', hoursWorked: 2.93 },
        { resourceID: 30683832, dateWorked: '2026-08-10T00:00:00Z', hoursWorked: 3.03 },
      ],
    });
    expect(r.flags.doneNotClosed).toBe(true);
    expect(r.flags.noTimeLogged).toBe(false);
    expect(r.hoursInWindow).toBe(5.96);
    expect(r.issues).toContain('done_not_closed');
  });

  test('no-time-logged: open, past window, nothing in window', () => {
    const r = reconcileServiceCall({
      ...base,
      serviceCall: { id: 1, isComplete: 0, startDateTime: '2026-08-10T15:00:00Z', endDateTime: '2026-08-10T18:00:00Z' },
      timeEntries: [{ dateWorked: '2026-07-01T00:00:00Z', hoursWorked: 4 }], // outside window
    });
    expect(r.flags.noTimeLogged).toBe(true);
    expect(r.flags.doneNotClosed).toBe(false);
  });

  test('completed service call is never flagged done/no-time', () => {
    const r = reconcileServiceCall({
      ...base,
      serviceCall: { id: 1, isComplete: 1, status: 2, startDateTime: '2026-08-10T15:00:00Z', endDateTime: '2026-08-10T18:00:00Z' },
    });
    expect(r.flags.doneNotClosed).toBe(false);
    expect(r.flags.noTimeLogged).toBe(false);
  });

  test('future window is not "in past"', () => {
    const r = reconcileServiceCall({
      ...base,
      serviceCall: { id: 1, isComplete: 0, startDateTime: '2026-10-01T15:00:00Z', endDateTime: '2026-10-01T18:00:00Z' },
    });
    expect(r.window.inPast).toBe(false);
    expect(r.flags.noTimeLogged).toBe(false);
  });

  test('unfulfilled parts: only status 3 counts, with $ value; delivered/canceled ignored', () => {
    const r = reconcileServiceCall({
      ...base,
      serviceCall: { id: 1, isComplete: 0, startDateTime: '2026-08-10T15:00:00Z', endDateTime: '2026-08-10T18:00:00Z' },
      charges: [
        { id: 1, name: 'Cat6-Bulk', status: 3, unitQuantity: 600, unitPrice: 0.25 }, // 150
        { id: 2, name: 'Keystone', status: 3, unitQuantity: 4, unitPrice: 1.09 },     // 4.36
        { id: 3, name: 'Delivered', status: 7, unitQuantity: 2, unitPrice: 99 },       // ignored
        { id: 4, name: 'Canceled', status: 8, unitQuantity: 1, unitPrice: 2550 },      // ignored
      ],
    });
    expect(r.flags.unfulfilledParts.count).toBe(2);
    expect(r.flags.unfulfilledParts.value).toBe(154.36);
    expect(r.atRiskPartsValue).toBe(154.36);
    expect(r.issues).toContain('parts_unfulfilled');
  });

  test('unbilled time: billable & unapproved counted; non-billable / approved excluded', () => {
    const r = reconcileServiceCall({
      ...base,
      serviceCall: { id: 1, isComplete: 1, startDateTime: '2026-08-10T15:00:00Z', endDateTime: '2026-08-10T18:00:00Z' },
      timeEntries: [
        { hoursWorked: 3, hoursToBill: 3, isNonBillable: false, billingApprovalDateTime: null },        // counted
        { hoursWorked: 2, isNonBillable: false, billingApprovalDateTime: '2026-08-11T00:00:00Z' },       // approved → no
        { hoursWorked: 1, isNonBillable: true, billingApprovalDateTime: null },                          // non-billable → no
      ],
    });
    expect(r.flags.unbilledTime.count).toBe(1);
    expect(r.flags.unbilledTime.hours).toBe(3);
    expect(r.issues).toContain('unbilled_time');
  });
});

describe('recoverAssignees (history)', () => {
  const history = [
    { date: '2026-08-10T14:19:53Z', action: 'Primary Resource Changed', detail: 'Primary Resource changed from [none selected] to Bright, John' },
    { date: '2026-08-10T14:19:53Z', action: 'Secondary Resources Added', detail: 'Secondary Resources changed from [Blank] to Stives, Travis' },
    { date: '2026-09-18T23:03:49Z', action: 'Primary Resource Changed', detail: 'Primary Resource changed from Bright, John to [none selected]' },
    { date: '2026-09-18T23:03:49Z', action: 'Secondary Resources Removed', detail: 'Secondary Resources changed from Stives, Travis to [Blank]' },
  ];

  test('as of the work date, recovers both techs (before the later clear)', () => {
    const asOf = Math.floor(Date.parse('2026-08-10T18:00:00Z') / 86_400_000);
    expect(recoverAssignees(history, asOf).sort()).toEqual(['Bright, John', 'Stives, Travis']);
  });

  test('as of today (after the clear), assignment is empty', () => {
    const asOf = Math.floor(Date.parse('2026-09-18T23:59:00Z') / 86_400_000);
    expect(recoverAssignees(history, asOf)).toEqual([]);
  });

  test('reconcile surfaces recovered assignees on the done-not-closed call', () => {
    const r = reconcileServiceCall({
      ...base, history,
      serviceCall: { id: 4688, isComplete: 0, startDateTime: '2026-08-10T15:00:00Z', endDateTime: '2026-08-10T18:00:00Z' },
      timeEntries: [{ resourceID: 30683890, dateWorked: '2026-08-10T00:00:00Z', hoursWorked: 3 }],
    });
    expect(r.recoveredAssignees.sort()).toEqual(['Bright, John', 'Stives, Travis']);
    expect(r.flags.doneNotClosed).toBe(true);
  });
});

describe('reportServiceCallLeakage (sweep, mocked)', () => {
  const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };

  test('scans only open calls and aggregates flagged issues', async () => {
    const s = new AutotaskService(config, new Logger('error'));
    jest.spyOn(s, 'searchServiceCalls').mockResolvedValue({ items: [
      { id: 4688, isComplete: 0, status: 1, startDateTime: '2026-08-10T15:00:00Z', endDateTime: '2026-08-10T18:00:00Z' },
      { id: 999, isComplete: 1, status: 2, startDateTime: '2026-08-01T15:00:00Z', endDateTime: '2026-08-01T18:00:00Z' }, // complete → skipped
    ] } as any);
    jest.spyOn(s, 'searchServiceCallTickets').mockResolvedValue([{ id: 5167, serviceCallID: 4688, ticketID: 200510 }] as any);
    jest.spyOn(s, 'searchTimeEntries').mockResolvedValue({ items: [{ dateWorked: '2026-08-10T00:00:00Z', hoursWorked: 3, isNonBillable: false, billingApprovalDateTime: null }] } as any);
    jest.spyOn(s, 'searchTicketCharges').mockResolvedValue([{ id: 1, name: 'Cat6', status: 3, unitQuantity: 600, unitPrice: 0.25 }] as any);
    jest.spyOn(s, 'searchTicketHistory').mockResolvedValue([] as any);
    jest.spyOn(s, 'getTicket').mockResolvedValue({ ticketNumber: 'T20260714.0185' } as any);

    const r = await s.reportServiceCallLeakage({ lookbackDays: 45 });
    expect(r.scanned).toBe(1);                 // the completed one was filtered out
    expect(r.scannedOpen).toBe(1);
    expect(r.scannedCompleted).toBe(0);
    expect(r.flagged).toBe(1);
    expect(r.totals.doneNotClosed).toBe(1);
    expect(r.totals.partsUnfulfilled).toBe(1);
    expect(r.totals.atRiskPartsValue).toBe(150);
    expect(r.totals.unbilledTime).toBe(1);
    expect(r.items[0].ticketNumber).toBe('T20260714.0185');
  });

  test('includeCompleted also scans closed calls for parts/unbilled (recovery), skips canceled', async () => {
    const s = new AutotaskService(config, new Logger('error'));
    jest.spyOn(s, 'searchServiceCalls').mockResolvedValue({ items: [
      { id: 4688, isComplete: 0, status: 1, startDateTime: '2026-08-10T15:00:00Z', endDateTime: '2026-08-10T18:00:00Z' },  // open
      { id: 999, isComplete: 1, status: 2, startDateTime: '2026-08-01T15:00:00Z', endDateTime: '2026-08-01T18:00:00Z' },   // completed, still has unfulfilled parts
      { id: 777, status: 101, startDateTime: '2026-08-02T15:00:00Z', endDateTime: '2026-08-02T18:00:00Z' },                 // canceled → always skipped
    ] } as any);
    jest.spyOn(s, 'searchServiceCallTickets').mockImplementation(async (o: any) =>
      [{ id: 1, serviceCallID: o.serviceCallId, ticketID: 500 + o.serviceCallId }] as any);
    jest.spyOn(s, 'searchTimeEntries').mockResolvedValue({ items: [] } as any);
    jest.spyOn(s, 'searchTicketCharges').mockResolvedValue([{ id: 1, name: 'Cat6', status: 3, unitQuantity: 100, unitPrice: 1 }] as any); // $100 unfulfilled
    jest.spyOn(s, 'searchTicketHistory').mockResolvedValue([] as any);
    jest.spyOn(s, 'getTicket').mockResolvedValue({ ticketNumber: 'T' } as any);

    const withCompleted = await s.reportServiceCallLeakage({ lookbackDays: 45, includeCompleted: true });
    expect(withCompleted.scanned).toBe(2);            // open + completed, canceled excluded
    expect(withCompleted.scannedCompleted).toBe(1);
    expect(withCompleted.totals.partsUnfulfilled).toBe(2); // both the open and the completed call
    expect(withCompleted.totals.atRiskPartsValue).toBe(200);

    const openOnly = await s.reportServiceCallLeakage({ lookbackDays: 45 });
    expect(openOnly.scanned).toBe(1);                 // completed call excluded by default
    expect(openOnly.totals.partsUnfulfilled).toBe(1);
  });
});
