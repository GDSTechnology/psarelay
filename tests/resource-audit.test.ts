// Resource activity / daily labor audit (P0): event mappers, after-hours,
// webhook → events with old values, row diffs, the daily-audit sections, the
// collector against a fake Autotask (filters sent upstream, budget, cache),
// and the signed webhook ingest.

import { createHmac } from 'crypto';
import { historyEvent, noteEvent, timeEntryEvent, webhookEvents, rowDiffEvents, isAfterHours, localClock } from '../src/utils/audit-events';
import { buildDailyAudit } from '../src/utils/daily-audit';
import { collectAuditEvents } from '../src/db/audit-collector';
import { verifyAutotaskSignature, ingestAutotaskWebhook } from '../src/db/webhook-ingest';
import { _setShadowRuntime } from '../src/db/shadow-runtime';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const TZ = 'America/New_York';
afterEach(() => { _setShadowRuntime(null); jest.restoreAllMocks(); });

describe('event mappers', () => {
  const ticket = { id: 210436, ticketNumber: 'T20261005.0099', companyID: 123 };
  test('history: status → Complete is "complete", from Complete is "reopen", resource change "assign", noise dropped, system flagged', () => {
    expect(historyEvent({ id: 1, action: 'Status Changed', date: '2026-10-06T18:37:22Z', detail: 'Status changed from In Progress to Complete', resourceID: 5 }, ticket))
      .toMatchObject({ eventId: 'th:1', action: 'complete', field: 'Status', oldValue: 'In Progress', newValue: 'Complete', entityReference: 'T20261005.0099', companyId: 123, source: 'ticket_history', systemGenerated: false });
    expect(historyEvent({ id: 2, action: 'Status Changed', date: '2026-10-06T19:00:00Z', detail: 'Status changed from Complete to Re-Opened', resourceID: 5 }, ticket)!.action).toBe('reopen');
    expect(historyEvent({ id: 3, action: 'Primary Resource Changed', date: '2026-10-06T19:00:00Z', detail: 'Primary Resource changed from A to B', resourceID: 5 }, ticket)!.action).toBe('assign');
    expect(historyEvent({ id: 4, action: 'Last Activity Date Changed', date: '2026-10-06T19:00:00Z', resourceID: 5 }, ticket)).toBeNull();
    expect(historyEvent({ id: 5, action: 'Ticket Triage Rule Fired', date: '2026-10-06T19:00:00Z', resourceID: 4 }, ticket)!.systemGenerated).toBe(true);
  });
  test('note: creator, parent ticket, visibility labels, body', () => {
    expect(noteEvent('ticketNote', { id: 987654, createDateTime: '2026-10-06T19:14:02Z', creatorResourceID: 5, title: 'Fixed', description: 'Replaced PSU', noteType: 1, publish: 2 }, { type: 'ticket', id: 210436, reference: 'T1', companyId: 123 }, { noteType: 'Task Summary', publish: 'Internal Project Team' }))
      .toMatchObject({ eventId: 'ticketNote:987654', action: 'note', resourceId: 5, parentEntityId: 210436, parentReference: 'T1', details: { publish: 'Internal Project Team', body: 'Replaced PSU' } });
  });
  test('time entry: worked vs entered, entered late, entered/edited by someone else', () => {
    const ev = timeEntryEvent({ id: 9, resourceID: 5, creatorUserID: 7, lastModifiedUserID: 5, dateWorked: '2026-10-05T00:00:00Z', createDateTime: '2026-10-07T05:00:00Z', hoursWorked: 1.5 }, { type: 'ticket', id: 1 }, TZ)!;
    expect(ev.details).toMatchObject({ dateWorked: '2026-10-05', hoursWorked: 1.5, enteredLate: true, enteredByResourceID: 7 });
    expect(ev.details).not.toHaveProperty('lastModifiedByResourceID');
  });
  test('after hours: local clock, weekends', () => {
    expect(localClock('2026-10-07T00:13:00Z', TZ).hm).toBe('20:13'); // Tue 8:13 pm EDT
    expect(isAfterHours('2026-10-07T00:13:00Z', TZ)).toBe(true);
    expect(isAfterHours('2026-10-06T14:00:00Z', TZ)).toBe(false); // 10 am Tue
    expect(isAfterHours('2026-10-04T14:00:00Z', TZ)).toBe(true);  // Sunday
  });
  test('webhook: PersonID is the actor; new values from the callout, OLD values from the mirrored row', () => {
    const ev = webhookEvents({ Action: 'Update', Guid: 'g1', EntityType: 'ConfigurationItem', Id: 77, EventTime: '2026-10-06T15:00:00Z', PersonID: 5, Fields: { serialNumber: 'NEW', LastModifiedTime: 'x' } }, { serialNumber: 'OLD', companyID: 9 });
    expect(ev).toEqual([expect.objectContaining({ eventId: 'wh:g1:serialNumber', resourceId: 5, entityType: 'configurationItem', entityId: 77, field: 'serialNumber', oldValue: 'OLD', newValue: 'NEW', companyId: 9, source: 'webhook' })]);
    expect(webhookEvents({ Action: 'Delete', Guid: 'g2', EntityType: 'Contact', Id: 3, PersonID: 5 }, null)[0]).toMatchObject({ action: 'delete', entityType: 'contact' });
    expect(webhookEvents({ Action: 'Update', Guid: 'g3', EntityType: 'Opportunity', Id: 1 }, null)).toEqual([]); // not audited
  });
  test('row diff: one event per changed field; cancel recognised; editor unknown unless given', () => {
    const ev = rowDiffEvents('serviceCall', 4, { startDateTime: 'a', canceledDateTime: null }, { startDateTime: 'b', canceledDateTime: '2026-10-06T15:00:00Z' }, ['startDateTime', 'canceledDateTime'], '2026-10-06T15:00:00Z', null);
    expect(ev.map((e) => [e.field, e.action, e.resourceId])).toEqual([['startDateTime', 'update', null], ['canceledDateTime', 'cancel', null]]);
    expect(ev[0]!.details).toMatchObject({ editor: expect.stringMatching(/unknown/) });
  });
});

describe('daily audit', () => {
  const R = 5, D = '2026-10-06';
  const ev = (o: Partial<any>) => ({ eventId: Math.random().toString(), resourceId: R, source: 'record', systemGenerated: false, ...o }) as any;
  test('sections: time, touched, no-time (closed → reopen), after-hours, late, mismatches', () => {
    const events = [
      ev({ entityType: 'ticket', entityId: 1, entityReference: 'T1', action: 'update', field: 'Status', oldValue: 'New', newValue: 'In Progress', timestamp: '2026-10-06T14:22:00Z' }),
      ev({ entityType: 'ticketNote', entityId: 50, parentEntityType: 'ticket', parentEntityId: 1, parentReference: 'T1', action: 'note', timestamp: '2026-10-06T14:31:00Z', details: { publish: 'Internal Project Team' } }),
      ev({ entityType: 'ticket', entityId: 2, entityReference: 'T2', action: 'complete', field: 'Status', oldValue: 'In Progress', newValue: 'Complete', timestamp: '2026-10-07T00:11:00Z' }), // 8:11 pm
      ev({ entityType: 'timeEntry', entityId: 900, parentEntityType: 'ticket', parentEntityId: 1, parentReference: 'T1', action: 'time', timestamp: '2026-10-06T15:00:00Z', details: { dateWorked: D, hoursWorked: 0.5, startDateTime: '2026-10-06T14:00:00Z' } }),
      ev({ entityType: 'timeEntry', entityId: 901, parentEntityType: 'ticket', parentEntityId: 3, parentReference: 'T3', action: 'time', timestamp: '2026-10-08T05:00:00Z', details: { dateWorked: D, hoursWorked: 1, enteredLate: true } }),
      ev({ entityType: 'ticket', entityId: 4, resourceId: 99, action: 'update', timestamp: '2026-10-06T15:00:00Z' }), // someone else
      // An automation completing the resource's To-Do at 3:17 am: shown, never counted.
      ev({ entityType: 'todo', entityId: 70, parentEntityType: 'ticket', parentEntityId: 5, action: 'complete', timestamp: '2026-10-06T07:17:00Z', details: { weakAttribution: true } }),
    ];
    const a = buildDailyAudit({ id: R, name: 'Brian' }, events, new Map([[2, { status: 5, ticketNumber: 'T2' }]]), { date: D, timeZone: TZ, businessHoursStart: '08:00', businessHoursEnd: '17:00' });
    expect(a.summary).toMatchObject({ hoursEntered: 1.5, timeEntries: 2, ticketsTouched: 2, itemsWithoutTime: 1, closedItemsMissingLabor: 1, afterHoursEvents: 1, lateEntries: 1 });
    expect(a.ticketsTouched.find((t: any) => t.ticketNumber === 'T1')).toMatchObject({ hasTimeEntry: true, firstActivity: '10:22', lastActivity: '10:31', activityCount: 2 });
    expect(a.closedItemsWithPossibleMissingLabor).toEqual([expect.objectContaining({ ticketNumber: 'T2', requiresReopenForBackfill: true, lastActivity: '20:11' })]);
    expect(a.afterHoursActivity[0]).toMatchObject({ time: '20:11', reference: 'T2' });
    expect(a.potentialTimeEntryMismatches).toEqual([expect.objectContaining({ timeEntryId: 901, note: expect.stringMatching(/no other activity/) })]);
    expect(a.timesheet.status).toBe('unknown');
    expect(a.crmAdminActivity).toEqual([expect.objectContaining({ entityType: 'todo', attribution: expect.stringMatching(/not counted/) })]);
  });
});

describe('collector', () => {
  const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
  test('live path: candidate tickets → history per ticket; notes by creator for all resources in ONE query; budget honoured', async () => {
    const calls: Array<{ e: string; f: any }> = [];
    const http = { query: jest.fn(async (e: string, f: any) => {
      calls.push({ e, f });
      if (e === 'Tickets') return [{ id: 1, ticketNumber: 'T1', companyID: 9, status: 5, lastTrackedModificationDateTime: '2026-10-06T20:00:00Z' }, { id: 2, ticketNumber: 'T2', companyID: 9, status: 1, lastTrackedModificationDateTime: '2026-10-06T21:00:00Z' }];
      if (e === 'TicketHistory') return f[0].value === 1 ? [{ id: 11, action: 'Status Changed', date: '2026-10-06T19:00:00Z', detail: 'Status changed from New to Complete', resourceID: 5 }, { id: 12, action: 'Status Changed', date: '2026-10-06T19:05:00Z', detail: 'Status changed from A to B', resourceID: 8 }] : [];
      if (e === 'TicketNotes') return [{ id: 50, ticketID: 1, createDateTime: '2026-10-06T19:10:00Z', creatorResourceID: 6, noteType: 1, publish: 2 }];
      return [];
    }) };
    const s = new AutotaskService(config, new Logger('error'));
    jest.spyOn(s, 'httpClient').mockResolvedValue(http as any);
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([]);
    jest.spyOn(s, 'getPicklistValues').mockResolvedValue([]);
    jest.spyOn(s, 'getResourceNames').mockResolvedValue(new Map([[5, 'Brian'], [6, 'Tricia']]));
    jest.spyOn(s, 'getCompanyNamesByIds').mockResolvedValue([{ id: 9, companyName: 'Acme' }]);
    const r = await collectAuditEvents(s, { resourceIds: [5, 6], start: '2026-10-06T04:00:00.000Z', end: '2026-10-07T04:00:00.000Z', timeZone: TZ });
    expect(calls.filter((c) => c.e === 'TicketHistory').map((c) => c.f)).toEqual([[{ op: 'eq', field: 'ticketID', value: 1 }], [{ op: 'eq', field: 'ticketID', value: 2 }]]);
    expect(calls.find((c) => c.e === 'TicketNotes')!.f).toEqual([{ op: 'in', field: 'creatorResourceID', value: [5, 6] }, { op: 'gte', field: 'createDateTime', value: '2026-10-06T04:00:00.000Z' }, { op: 'lt', field: 'createDateTime', value: '2026-10-07T04:00:00.000Z' }]);
    expect(r.events.map((e) => `${e.resourceName}:${e.entityType}:${e.action}`)).toEqual(['Brian:ticket:complete', 'Tricia:ticketNote:note']); // resource 8 filtered out
    expect(r.events[0]).toMatchObject({ companyName: 'Acme', entityReference: 'T1' });
    expect(r.meta.historyFetched).toBe(2);

    calls.length = 0;
    const tight = await collectAuditEvents(s, { resourceIds: [5], start: '2026-10-06T04:00:00.000Z', end: '2026-10-07T04:00:00.000Z', timeZone: TZ, maxApiCalls: 10, entityTypes: ['ticket'] });
    expect(tight.meta.apiCallsUsed).toBeLessThanOrEqual(10);
  });

  test('ledger cache: a ticket fetched after its last change is NOT re-read', async () => {
    const http = { query: jest.fn(async (e: string) => (e === 'Tickets' ? [{ id: 1, ticketNumber: 'T1', lastTrackedModificationDateTime: '2026-10-06T20:00:00Z' }] : [])) };
    const ledger = { historyFetched: jest.fn(async () => new Map([[1, new Date('2026-10-06T21:00:00Z')]])), query: jest.fn(async () => [{ eventId: 'th:11', timestamp: '2026-10-06T19:00:00.000Z', resourceId: 5, action: 'update', entityType: 'ticket', entityId: 1, source: 'ticket_history', systemGenerated: false }]), insert: jest.fn(), markHistoryFetched: jest.fn() };
    _setShadowRuntime({ store: { freshness: async () => ({ ready: false }) }, ledger } as any);
    const s = new AutotaskService(config, new Logger('error'));
    jest.spyOn(s, 'httpClient').mockResolvedValue(http as any);
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([]);
    jest.spyOn(s, 'getResourceNames').mockResolvedValue(new Map());
    jest.spyOn(s, 'getCompanyNamesByIds').mockResolvedValue([]);
    const r = await collectAuditEvents(s, { resourceIds: [5], start: '2026-10-06T04:00:00.000Z', end: '2026-10-07T04:00:00.000Z', timeZone: TZ, entityTypes: ['ticket'] });
    expect(http.query.mock.calls.map((c) => c[0])).toEqual(['Tickets', 'DeletedTicketLogs']); // no TicketHistory call; only the ticket delete log
    expect(r.meta).toMatchObject({ historyFromCache: 1, historyFetched: 0 });
    expect(r.events.map((e) => e.eventId)).toEqual(['th:11']);
  });
});

describe('webhook ingest', () => {
  const SECRET = 'e48eee6c-test-secret-0123456789abcdef';
  const body = Buffer.from(JSON.stringify({ Action: 'Update', Guid: 'abc', EntityType: 'Company', Id: 9, EventTime: '2026-10-06T15:00:00Z', PersonID: 5, Fields: { phone: '555-0100' } }));
  const sig = 'sha1=' + createHmac('sha1', SECRET).update(body).digest('base64');
  test('signature: valid / tampered / missing', () => {
    expect(verifyAutotaskSignature(body, sig, SECRET)).toBe(true);
    expect(verifyAutotaskSignature(Buffer.from(body.toString().replace('555', '556')), sig, SECRET)).toBe(false);
    expect(verifyAutotaskSignature(body, undefined, SECRET)).toBe(false);
  });
  test('valid callout → events with old value from the shadow, row queued for refresh; bad signature 401; no secret 503', async () => {
    const insert = jest.fn(async (evs: any[]) => evs.length);
    const markDirty = jest.fn();
    _setShadowRuntime({ store: { getRow: async () => ({ phone: '555-0199' }) }, ledger: { insert }, sync: { markDirty } } as any);
    const r = await ingestAutotaskWebhook(body, sig, { AUTOTASK_WEBHOOK_SECRET: SECRET });
    expect(r).toEqual({ status: 200, body: { ok: true, events: 1, stored: 1, duplicate: false } });
    expect(insert.mock.calls[0]![0][0]).toMatchObject({ resourceId: 5, entityType: 'company', field: 'phone', oldValue: '555-0199', newValue: '555-0100' });
    expect(markDirty).toHaveBeenCalledWith('Companies', 9);
    expect((await ingestAutotaskWebhook(body, 'sha1=bogus', { AUTOTASK_WEBHOOK_SECRET: SECRET })).status).toBe(401);
    expect((await ingestAutotaskWebhook(body, sig, {})).status).toBe(503);
  });
});
