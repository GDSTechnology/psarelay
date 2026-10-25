// Activity without time (leakage audit). Fixture shapes mirror a live GDS week
// (2026-09-22..29): bare "Closed" notes, "Closed - <reason>" close-outs,
// internal-company and alert tickets, mail-loop junk, backlog cleanup.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import { computeActivityWithoutTime, isSubstantiveNote, localDay, AwtTicket } from '../src/utils/activity-without-time';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices3.autotask.net/ATServicesRest/' } };
const logger = new Logger('error');
const TZ = 'America/New_York';
const R = 30683880;

const note = (ticketID: number, at: string, description: string, title = '[External] - x') => ({ ticketID, noteType: 1, title, description, createDateTime: at, creatorResourceID: R });
const tickets = (...t: AwtTicket[]) => new Map(t.map((x) => [x.id, x]));
const run = (input: Partial<Parameters<typeof computeActivityWithoutTime>[1]>, opts: Partial<Parameters<typeof computeActivityWithoutTime>[2]> = {}) =>
  computeActivityWithoutTime(R, { notes: [], completions: [], emails: [], timeEntries: [], tickets: new Map(), ...input }, { timeZone: TZ, from: '2026-09-22', to: '2026-09-29', ...opts }, 'Brian Smith');

describe('isSubstantiveNote', () => {
  test.each([
    [{ title: 'Closed', description: 'Closed' }, false],
    [{ title: 'Closed', description: 'Clsoed' }, false],
    [{ title: 'Closed', description: 'Closed - No further action needed at this time' }, false],
    [{ title: 'Closed', description: 'Resolved: user confirmed printing works' }, false],
    [{ title: 'Re: x', description: 'Automatic reply: Ticket Updated: - PMS is still not fixed' }, false],
    [{ title: 'Closed', description: 'Confirmed Threatlocker installed on computer' }, true],
    [{ title: 'Printer', description: 'Replaced toner' }, true], // short, but a real title
    [{ title: 'Equipment to pick up', description: '- Customer has rented 4 Poly phones' }, true],
  ])('%j -> %s', (n, expected) => {
    expect(isSubstantiveNote(n)).toBe(expected);
  });
});

describe('localDay', () => {
  test('buckets by the tech\'s local day, not UTC', () => {
    expect(localDay('2026-09-23T02:30:00Z', TZ)).toBe('2026-09-22'); // 10:30 pm EDT
    expect(localDay('2026-09-23T13:00:00Z', TZ)).toBe('2026-09-23');
  });
});

describe('computeActivityWithoutTime', () => {
  const client = { id: 1, ticketNumber: 'T20260924.0068', title: 'Pickup Phone Equipment', companyName: 'Reece Hoopes & Fincher, Inc.', ticketUrl: 'https://ww3.autotask.net/x', createDate: '2026-09-24T12:00:00Z' };

  test('a substantive note with no time → HIGH gap with evidence, ticket context and link', () => {
    const r = run({
      notes: [note(1, '2026-09-24T15:00:00Z', '- Customer has rented 4 Poly phones', 'Equipment to pick up')],
      emails: [{ ticketID: 1, notificationSentTime: '2026-09-24T15:00:05Z', templateName: 'Ticket - Forwarded', recipientEmailAddress: 'tricia@x' }],
      tickets: tickets(client),
    });
    expect(r.counts.high).toBe(1);
    expect(r.gaps[0]).toEqual(expect.objectContaining({
      ticketID: 1, ticketNumber: 'T20260924.0068', company: 'Reece Hoopes & Fincher, Inc.', ticketUrl: 'https://ww3.autotask.net/x',
      day: '2026-09-24', confidence: 'high', otherTime: { hours: 0, days: [] },
    }));
    expect(r.gaps[0]!.evidence.map((e) => e.kind)).toEqual(['note', 'email']);
  });

  test('a completed client ticket with only a bare "Closed" note → MEDIUM', () => {
    const r = run({ notes: [note(1, '2026-09-24T15:00:00Z', 'Closed', 'Closed')], completions: [{ id: 1, completedDate: '2026-09-24T15:00:01Z' }], tickets: tickets(client) });
    expect(r.gaps.map((g) => g.confidence)).toEqual(['medium']);
    expect(r.gaps[0]!.evidence.map((e) => e.kind)).toEqual(['close_note', 'completed']);
  });

  test('support-only evidence (close note / e-mail alone) never creates a gap', () => {
    const r = run({
      notes: [note(1, '2026-09-24T15:00:00Z', 'Closed - No action needed', 'Closed')],
      emails: [{ ticketID: 1, notificationSentTime: '2026-09-24T16:00:00Z', templateName: 'Ticket Ready to Bill' }],
      tickets: tickets(client),
    });
    expect(r.gaps).toEqual([]);
  });

  test('time the same day covers it; time within toleranceDays counts as nearby cover', () => {
    const base = { notes: [note(1, '2026-09-24T15:00:00Z', 'Replaced the switch in the MDF closet')], tickets: tickets(client) };
    expect(run({ ...base, timeEntries: [{ ticketID: 1, dateWorked: '2026-09-24T00:00:00Z', hoursWorked: 1 }] }).counts.coveredByTime).toBe(1);
    const nearby = run({ ...base, timeEntries: [{ ticketID: 1, dateWorked: '2026-09-25T00:00:00Z', hoursWorked: 1 }] });
    expect(nearby.counts.coveredByNearbyTime).toBe(1);
    expect(nearby.gaps).toEqual([]);
    const strict = run({ ...base, timeEntries: [{ ticketID: 1, dateWorked: '2026-09-25T00:00:00Z', hoursWorked: 1 }] }, { toleranceDays: 0 });
    expect(strict.gaps[0]!.otherTime).toEqual({ hours: 1, days: ['2026-09-25'] });
  });

  test('an e-mail sent from a time entry is not evidence of missing time', () => {
    const r = run({
      completions: [{ id: 1, completedDate: '2026-09-24T15:00:00Z' }],
      emails: [{ ticketID: 1, timeEntryID: 55513, notificationSentTime: '2026-09-24T15:00:05Z', templateName: 'Time entry' }],
      tickets: tickets(client),
    });
    expect(r.gaps[0]!.evidence.map((e) => e.kind)).toEqual(['completed']);
  });

  test('exclusions are counted by reason: internal, junk, monitoring, backlog cleanup', () => {
    const r = run({
      notes: [note(2, '2026-09-22T14:00:00Z', 'Temp artifact generated by browser update, approved')],
      completions: [
        { id: 3, completedDate: '2026-09-22T14:00:00Z' },
        { id: 4, completedDate: '2026-09-22T14:00:00Z' },
        { id: 5, completedDate: '2026-09-24T14:00:00Z' },
      ],
      tickets: tickets(
        { id: 2, title: 'ThreatLocker Application Request', isInternal: true },
        { id: 3, title: 'Automatic reply: Hey Kate Price How did we do?' },
        { id: 4, title: 'UPS Firmware Version Out of Date', isMonitoring: true },
        { id: 5, title: 'Anodet TOS and onboarding document', createDate: '2026-06-16T12:00:00Z' },
      ),
    });
    expect(r.gaps).toEqual([]);
    expect(r.excluded).toEqual({ internal: 1, monitoring: 1, junk: 1, backlogCleanup: 1 });
  });

  test('includeInternal / includeMonitoring bring them back; a substantive note on an old ticket is still HIGH', () => {
    const r = run({
      notes: [note(6, '2026-09-25T14:00:00Z', 'Confirmed Threatlocker installed on computer', 'Closed')],
      completions: [{ id: 6, completedDate: '2026-09-25T14:00:01Z' }, { id: 4, completedDate: '2026-09-22T14:00:00Z' }],
      tickets: tickets({ id: 6, title: 'Install Threatlocker on laptop', createDate: '2026-05-04T12:00:00Z' }, { id: 4, title: 'UPS on Battery', isMonitoring: true, isInternal: true }),
    }, { includeInternal: true, includeMonitoring: true });
    expect(r.gaps.map((g) => `${g.ticketID}:${g.confidence}`)).toEqual(['6:high', '4:medium']);
  });

  test('minConfidence:high drops medium; evidence outside the window is ignored; high sorts first', () => {
    const r = run({
      notes: [note(1, '2026-09-24T15:00:00Z', 'Replaced the switch in the MDF closet'), note(9, '2026-09-20T15:00:00Z', 'Out-of-window work')],
      completions: [{ id: 7, completedDate: '2026-09-23T15:00:00Z' }],
      tickets: tickets(client, { id: 7, title: 'Client ticket' }, { id: 9, title: 'Earlier' }),
    });
    expect(r.gaps.map((g) => `${g.ticketID}:${g.confidence}`)).toEqual(['1:high', '7:medium']);
    const high = run({ notes: [note(1, '2026-09-24T15:00:00Z', 'Replaced the switch')], completions: [{ id: 7, completedDate: '2026-09-23T15:00:00Z' }], tickets: tickets(client, { id: 7, title: 'x' }) }, { minConfidence: 'high' });
    expect(high.gaps.map((g) => g.ticketID)).toEqual([1]);
  });

  test('Autotask/integration bookkeeping notes are not evidence', () => {
    const r = run({ notes: [{ ticketID: 1, noteType: 2, title: 'Nexus auto-closure audit note', description: 'Nexus auto-closed this ticket after verification', createDateTime: '2026-09-24T15:00:00Z', creatorResourceID: R }], tickets: tickets(client) });
    expect(r.gaps).toEqual([]);
  });
});

describe('reportActivityWithoutTime — filters sent upstream', () => {
  test('every source is scoped to the resource and a padded UTC window; time to ± tolerance', async () => {
    const s = new AutotaskService(config, logger);
    const query = jest.fn(async (_entity: string, _filter: unknown, _opts?: unknown) => [] as unknown[]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([] as any);
    jest.spyOn(s, 'getResourceNames').mockResolvedValue(new Map([[R, 'Brian Smith']]));
    const r = await s.reportActivityWithoutTime({ resourceIDs: [R], from: '2026-09-22', to: '2026-09-29', timeZone: TZ, toleranceDays: 2 });
    const filterFor = (entity: string) => query.mock.calls.find((c) => c[0] === entity)![1];
    expect(filterFor('TicketNotes')).toEqual([
      { op: 'eq', field: 'creatorResourceID', value: R },
      { op: 'gte', field: 'createDateTime', value: '2026-09-21T00:00:00Z' },
      { op: 'lt', field: 'createDateTime', value: '2026-10-01T00:00:00Z' },
    ]);
    expect(filterFor('Tickets')).toEqual(expect.arrayContaining([{ op: 'eq', field: 'completedByResourceID', value: R }]));
    expect(filterFor('NotificationHistory')).toEqual(expect.arrayContaining([{ op: 'eq', field: 'initiatingResourceID', value: R }]));
    expect(filterFor('TimeEntries')).toEqual([
      { op: 'eq', field: 'resourceID', value: R },
      { op: 'gte', field: 'dateWorked', value: '2026-09-20' },
      { op: 'lte', field: 'dateWorked', value: '2026-10-01' },
    ]);
    expect(r.resources[0]).toEqual(expect.objectContaining({ resourceID: R, resourceName: 'Brian Smith', timeZone: TZ, gaps: [] }));
  });

  test('a window over 31 days is refused', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: jest.fn(async () => []) });
    await expect(s.reportActivityWithoutTime({ resourceIDs: [R], from: '2026-08-01', to: '2026-09-29' })).rejects.toThrow(/0–31 days/);
  });
});

describe('autotask_report_activity_without_time handler', () => {
  const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
  test('requires a resource', async () => {
    const res = await new AutotaskToolHandler(new AutotaskService(config, logger), logger).callTool('autotask_report_activity_without_time', {});
    expect(JSON.parse(res.content[0].text).message).toMatch(/resourceID .* is required/);
  });
  test('merges resourceID + resourceIDs, dedupes, caps at 10', async () => {
    const s = new AutotaskService(config, logger);
    const spy = jest.spyOn(s, 'reportActivityWithoutTime').mockResolvedValue({ from: 'a', to: 'b', resources: [], totals: { high: 0, medium: 0, resources: 0 }, notes: [] });
    await new AutotaskToolHandler(s, logger).callTool('autotask_report_activity_without_time', { resourceID: 1, resourceIDs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
    expect(spy.mock.calls[0]![0].resourceIDs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
