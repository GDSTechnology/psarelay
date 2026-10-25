// Ticket-anchored billing-gaps sweep — the reviewable weekly report. Pure rules
// + service sweep (union of open + completed tickets). Mocked service.

import { analyzeTicketBillingGaps } from '../src/utils/ticket-billing-gaps';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const t = (over: any = {}) => ({ id: 1, ticketNumber: 'T1', status: 1, completedDate: null, contractType: null, ...over });

describe('analyzeTicketBillingGaps (pure)', () => {
  test('work-not-logged: completed ticket with zero time', () => {
    const r = analyzeTicketBillingGaps({ ticket: t({ status: 5 }), timeEntries: [], notes: [] });
    expect(r.flags.workNotLogged).toBe(true);
    expect(r.issues).toContain('work_not_logged');
  });

  test('work-not-logged: tech email note but no time', () => {
    const r = analyzeTicketBillingGaps({
      ticket: t(), timeEntries: [],
      notes: [{ creatorResourceID: 30683881, createdByContactID: null, noteType: 101, createDateTime: '2026-08-10T12:00:00Z' }],
    });
    expect(r.flags.workNotLogged).toBe(true);
  });

  test('note-without-time: tech email note with no same-day time by that tech', () => {
    const r = analyzeTicketBillingGaps({
      ticket: t(),
      timeEntries: [{ resourceID: 999, dateWorked: '2026-08-10T00:00:00Z', hoursWorked: 1 }], // different tech
      notes: [{ creatorResourceID: 30683881, createdByContactID: null, noteType: 101, createDateTime: '2026-08-10T12:00:00Z' }],
    });
    expect(r.flags.notesWithoutTime.count).toBe(1);
    expect(r.flags.notesWithoutTime.noteTypes).toEqual([101]);
    expect(r.issues).toContain('note_without_time');
    expect(r.flags.workNotLogged).toBe(false); // there IS time on the ticket
  });

  test('note WITH same-day time by same tech is not flagged; customer email ignored', () => {
    const r = analyzeTicketBillingGaps({
      ticket: t(),
      timeEntries: [{ resourceID: 30683881, dateWorked: '2026-08-10T00:00:00Z', hoursWorked: 1 }],
      notes: [
        { creatorResourceID: 30683881, createdByContactID: null, noteType: 101, createDateTime: '2026-08-10T12:00:00Z' }, // captured
        { creatorResourceID: null, createdByContactID: 555, noteType: 101, createDateTime: '2026-08-11T09:00:00Z' },      // customer → ignored
      ],
    });
    expect(r.flags.notesWithoutTime.count).toBe(0);
  });

  test('billable-marked-nonbillable: work_type_billable signal', () => {
    const r = analyzeTicketBillingGaps({
      ticket: t(),
      timeEntries: [{ resourceID: 1, dateWorked: '2026-08-10T00:00:00Z', hoursWorked: 3, isNonBillable: true, workTypeUseType: 1, workTypeBillingCodeType: 0, workTypeName: 'Onsite Support' }],
      notes: [],
    });
    const s = r.flags.nonbillableSuspect;
    expect(s.count).toBe(1);
    expect(s.hours).toBe(3);
    expect(s.items[0].signals).toContain('work_type_billable');
    expect(s.items[0].workTypeName).toBe('Onsite Support');
  });

  test('designated Non-Billable work type is never flagged, even on T&M + mixed', () => {
    const r = analyzeTicketBillingGaps({
      ticket: t({ contractType: 1 }), // T&M
      timeEntries: [
        { isNonBillable: false, hoursWorked: 2 },                                            // billable → mixed
        { isNonBillable: true, hoursWorked: 2, workTypeUseType: 3, workTypeBillingCodeType: 2, workTypeName: 'General Administration (non-billable)' },
      ],
      notes: [],
    });
    expect(r.flags.nonbillableSuspect.count).toBe(0); // gated out — intentionally non-billable
  });

  test('contract_tm and mixed_on_ticket signals (normal work type, non-billable flag suspect)', () => {
    const r = analyzeTicketBillingGaps({
      ticket: t({ contractType: 1 }), // T&M
      timeEntries: [
        { isNonBillable: false, hoursWorked: 2 },                                            // billable → mixed
        { isNonBillable: true, hoursWorked: 1, workTypeUseType: 3, workTypeBillingCodeType: 0 }, // normal code (not designated non-billable), internal useType
      ],
      notes: [],
    });
    const item = r.flags.nonbillableSuspect.items[0];
    expect(item.signals).toEqual(expect.arrayContaining(['contract_tm', 'mixed_on_ticket']));
    expect(item.signals).not.toContain('work_type_billable'); // useType 3, not 1
  });
});

describe('reportTicketBillingGaps (sweep, mocked)', () => {
  const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };

  test('unions open + completed tickets and aggregates gaps', async () => {
    const s = new AutotaskService(config, new Logger('error'));
    // open sweep returns ticket 1; completed sweep returns ticket 2
    jest.spyOn(s, 'searchTickets').mockImplementation(async (o: any) =>
      (o.status === 5
        ? { items: [{ id: 2, ticketNumber: 'T2', status: 5, completedDate: '2026-08-12T00:00:00Z' }] }
        : { items: [{ id: 1, ticketNumber: 'T1', status: 1 }] }) as any);
    jest.spyOn(s, 'getTicket').mockImplementation(async (id: number) =>
      (id === 1 ? { id: 1, ticketNumber: 'T1', status: 1, contractID: null }
                : { id: 2, ticketNumber: 'T2', status: 5, completedDate: '2026-08-12T00:00:00Z', contractID: null }) as any);
    // ticket 1: tech email note, no time → work_not_logged + note_without_time
    // ticket 2: completed, no time → work_not_logged
    jest.spyOn(s, 'searchTimeEntries').mockResolvedValue({ items: [] } as any);
    jest.spyOn(s, 'searchTicketNotes').mockImplementation(async (id: number) =>
      (id === 1 ? [{ creatorResourceID: 30683881, createdByContactID: null, noteType: 101, createDateTime: '2026-08-10T12:00:00Z' }] : []) as any);

    const r = await s.reportTicketBillingGaps({ lookbackDays: 30 });
    expect(r.scanned).toBe(2);                 // open + completed unioned
    expect(r.flagged).toBe(2);
    expect(r.totals.workNotLogged).toBe(2);
    expect(r.totals.noteWithoutTime).toBe(1);
    expect(r.totals.uncapturedNotes).toBe(1);
  });
});
