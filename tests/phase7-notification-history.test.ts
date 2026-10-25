// Notification history: rows (one per recipient) grouped into SENDS, newest
// first, paged by send; filters asserted on the payload sent upstream. Shapes
// mirror live rows (2026-09-30) — incl. "Name <addr>" recipients.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import { groupNotificationSends, emailDomain, NotificationRow } from '../src/utils/notification-history';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices3.autotask.net/ATServicesRest/' } };
const logger = new Logger('error');

let seq = 1;
const row = (at: string, over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: seq++, notificationSentTime: at, notificationHistoryTypeID: 4, templateName: 'Ticket Time Entry - Created or Edited',
  initiatingResourceID: 30683880, ticketID: 209613, timeEntryID: 55513, entityNumber: 'T20260929.0062', entityTitle: 'Remote Support\n- Remotely accessed',
  recipientEmailAddress: 'x@rpoperations.com', ...over,
});

describe('emailDomain', () => {
  test.each([
    ['a@gdstech.tech', 'gdstech.tech'],
    ['Kaden Hausinger <kaden.hausinger@GDSTech.tech>', 'gdstech.tech'],
    ['600 Security <600Security@rpoperations.com>', 'rpoperations.com'],
    ['no-address', null],
    [null, null],
  ])('%j -> %j', (raw, dom) => expect(emailDomain(raw)).toBe(dom));
});

describe('groupNotificationSends', () => {
  const names = new Map([[30683880, 'Brian Smith']]);
  const types = new Map([[4, 'Tickets']]);

  test('seven recipient rows a second apart are ONE send (the UI time-entry notify)', () => {
    const rcpts = ['cain@gdstech.tech', 'brian@gdstech.tech', '600Security@rpoperations.com', 'jm@rpoperations.com', 'bb@rpoperations.com', 'ak@rpoperations.com', 'tp@rpoperations.com'];
    const rows = rcpts.map((e, i) => row(`2026-09-29T14:05:${String(15 + i).padStart(2, '0')}Z`, { recipientEmailAddress: e }));
    const sends = groupNotificationSends(rows, { typeLabels: types, resourceNames: names, internalDomains: ['gdstech.tech'] });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual(expect.objectContaining({
      type: 'Tickets', template: 'Ticket Time Entry - Created or Edited', initiatedBy: 'Brian Smith', initiatingResourceID: 30683880,
      recipientCount: 7, toExternal: true,
      subject: { ticketID: 209613, timeEntryID: 55513, number: 'T20260929.0062', title: 'Remote Support - Remotely accessed' },
    }));
  });

  test('different template, subject, or a >60s gap starts a new send; newest first', () => {
    const sends = groupNotificationSends([
      row('2026-09-29T14:05:00Z'),
      row('2026-09-29T14:05:02Z', { templateName: 'Ticket Ready to Bill', recipientEmailAddress: 'accounting@gdstech.tech' }),
      row('2026-09-29T14:05:03Z', { timeEntryID: 55515 }),
      row('2026-09-29T14:07:00Z'),
    ]);
    expect(sends.map((s) => `${s.sentAt.slice(11, 19)} ${s.template} ${s.subject.timeEntryID}`)).toEqual([
      '14:07:00 Ticket Time Entry - Created or Edited 55513',
      '14:05:03 Ticket Time Entry - Created or Edited 55515',
      '14:05:02 Ticket Ready to Bill 55513',
      '14:05:00 Ticket Time Entry - Created or Edited 55513',
    ]);
  });

  test('initiator labels: tech, contact, or Autotask for workflow/system e-mails', () => {
    const sends = groupNotificationSends([
      row('2026-09-29T11:15:00Z', { initiatingResourceID: null, templateName: 'Ticket - Created or Edited' }),
      row('2026-09-29T22:43:00Z', { initiatingResourceID: null, initiatingContactID: 31684660, templateName: 'Incoming Email Processing' }),
      row('2026-09-29T22:50:00Z', { initiatingResourceID: 30683898, templateName: 'Incoming Email Processing' }),
    ]);
    expect(sends.map((s) => s.initiatedBy)).toEqual(['Resource 30683898', 'Contact 31684660', 'Autotask (workflow/system)']);
  });

  test('a display-name internal address is NOT external; duplicate recipient rows are merged', () => {
    const sends = groupNotificationSends([
      row('2026-09-29T22:50:00Z', { recipientEmailAddress: 'Kaden Hausinger <kaden.hausinger@gdstech.tech>' }),
      row('2026-09-29T22:50:01Z', { recipientEmailAddress: 'Kaden Hausinger <kaden.hausinger@gdstech.tech>' }),
    ], { internalDomains: ['@GDSTech.tech'] });
    expect(sends[0]!.recipientCount).toBe(1);
    expect(sends[0]!.toExternal).toBe(false);
  });

  test('toExternal is omitted when no internal domain is known', () => {
    expect(groupNotificationSends([row('2026-09-29T14:05:00Z')])[0]).not.toHaveProperty('toExternal');
  });
});

describe('searchNotificationHistory — filters sent upstream + paging by send', () => {
  const mk = (rows: NotificationRow[], resources: any[] = []) => {
    const s = new AutotaskService(config, logger);
    const query = jest.fn(async (entity: string, _f: unknown, _o?: unknown) => (entity === 'NotificationHistory' ? rows : entity === 'Resources' ? resources : []));
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query });
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([{ name: 'notificationHistoryTypeID', picklistValues: [{ value: '4', label: 'Tickets' }] }] as any);
    return { s, query };
  };

  test('every scope filter reaches Autotask; `to` date is inclusive', async () => {
    const { s, query } = mk([]);
    await s.searchNotificationHistory({ ticketID: 209613, timeEntryID: 55513, taskID: 7591, projectID: 12, initiatingResourceID: 30683880, recipientEmail: 'rpoperations.com', templateName: 'Ready to Bill', from: '2026-09-01', to: '2026-09-29' });
    expect(query.mock.calls[0]![0]).toBe('NotificationHistory');
    expect(query.mock.calls[0]![1]).toEqual([
      { op: 'eq', field: 'ticketID', value: 209613 },
      { op: 'eq', field: 'timeEntryID', value: 55513 },
      { op: 'eq', field: 'taskID', value: 7591 },
      { op: 'eq', field: 'projectID', value: 12 },
      { op: 'eq', field: 'initiatingResourceID', value: 30683880 },
      { op: 'contains', field: 'recipientEmailAddress', value: 'rpoperations.com' },
      { op: 'contains', field: 'templateName', value: 'Ready to Bill' },
      { op: 'gte', field: 'notificationSentTime', value: '2026-09-01T00:00:00Z' },
      { op: 'lt', field: 'notificationSentTime', value: '2026-09-30T00:00:00.000Z' },
    ]);
  });

  test('unscoped: a window of ≤31 days is required', async () => {
    const { s } = mk([]);
    await expect(s.searchNotificationHistory({})).rejects.toThrow(/Scope the search/);
    await expect(s.searchNotificationHistory({ from: '2026-08-01', to: '2026-09-29' })).rejects.toThrow(/Scope the search/);
    await expect(s.searchNotificationHistory({ from: '2026-09-01', to: '2026-09-29' })).resolves.toEqual(expect.objectContaining({ totalSends: 0 }));
  });

  test('pages by SEND (a send never splits); hasMore; internal domain learned from the initiator', async () => {
    const rows = [0, 1, 2].flatMap((m) => [row(`2026-09-2${m + 1}T14:00:00Z`), row(`2026-09-2${m + 1}T14:00:01Z`, { recipientEmailAddress: 'brian@gdstech.tech' })]);
    const { s } = mk(rows, [{ id: 30683880, firstName: 'Brian', lastName: 'Smith', email: 'brian.smith@gdstech.tech' }]);
    const p1 = await s.searchNotificationHistory({ ticketID: 209613, pageSize: 2 });
    expect(p1.sends.map((x) => x.sentAt.slice(0, 10))).toEqual(['2026-09-23', '2026-09-22']);
    expect(p1.sends.every((x) => x.recipientCount === 2 && x.initiatedBy === 'Brian Smith')).toBe(true);
    expect(p1).toEqual(expect.objectContaining({ totalSends: 3, rowsScanned: 6, hasMore: true, internalDomains: ['gdstech.tech'] }));
    const p2 = await s.searchNotificationHistory({ ticketID: 209613, pageSize: 2, page: 2 });
    expect(p2.sends.map((x) => x.sentAt.slice(0, 10))).toEqual(['2026-09-21']);
    expect(p2.hasMore).toBe(false);
  });
});

describe('autotask_search_notification_history handler', () => {
  const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
  test('empty result says the API cannot send notifications', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'searchNotificationHistory').mockResolvedValue({ sends: [], page: 1, pageSize: 25, hasMore: false, totalSends: 0, rowsScanned: 0, truncated: false, internalDomains: [] });
    const res = await new AutotaskToolHandler(s, logger).callTool('autotask_search_notification_history', { ticketID: 1 });
    expect(JSON.parse(res.content[0].text).message).toMatch(/Autotask sent nothing matching/);
  });
});
