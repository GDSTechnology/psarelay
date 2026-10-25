// Autotask's own bookkeeping notes (workflow-rule, Service Desk Notification,
// forward/modify) are hidden from user-facing note views by default. Shapes
// below mirror T20260928.0084's live notes (2026-09-29): 24 notes, 15 system.

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import { buildTicketCard, headline } from '../src/handlers/card.builder';
import { isSystemTicketNote, partitionTicketNotes } from '../src/utils/ticket-note-kind';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const logger = new Logger('error');

const human = (id: number, at: string, title = '[External] -  - Shippan Landing =-290 EV Chargers') =>
  ({ id, noteType: 1, publish: 2, title, description: `human ${id}`, createDateTime: at });
const notif = (id: number, at: string) =>
  ({ id, noteType: 2, publish: 4, title: 'Service Desk Notification', description: 'kaden.hausinger@gdstech.tech', createDateTime: at });
const workflow = (id: number, at: string) =>
  ({ id, noteType: 13, publish: 1, title: 'Workflow Rule "Note from End User" fired.', description: 'When a ticket is:', createDateTime: at });

describe('isSystemTicketNote', () => {
  test.each([
    [{ noteType: 13, title: 'Workflow Rule "Route Ticket to T1 Que" fired.' }, true],
    [{ noteType: 91, title: 'x' }, true],
    [{ noteType: 92, title: 'x' }, true],
    [{ noteType: 2, title: 'Service Desk Notification' }, true],
    [{ noteType: 2, title: '  service desk notification ' }, true],
    // T20260921.0086 (live 2026-09-29) — each of these reached the card before:
    [{ noteType: 1, creatorResourceID: 4, title: 'Notification sent via Workflow Rule "Ticket Closed - Billing Cross Check"' }, true],
    [{ noteType: 2, creatorResourceID: 30683889, title: 'TimeZest Appointment Scheduled' }, true],
    [{ noteType: 94, creatorResourceID: 30683890, title: 'This ticket absorbed ticket(s)' }, true],
    [{ noteType: 94, creatorResourceID: 30683890, title: 'Absorbed Ticket Description (T20260917.0047)' }, true],
    [{ noteType: 2, creatorResourceID: 30683921, title: 'Nexus auto-closure audit note' }, true],
    [{ noteType: 93, title: 'Merged Into Ticket' }, true],
    [{ noteType: 95, title: 'Copied to Project' }, true],
    [{ noteType: 1, creatorResourceID: 4, title: 'anything by Autotask Administrator' }, true],
    // What people write stays:
    [{ noteType: 1, creatorResourceID: 30683898, title: '- Shippan Landing =-290 EV Chargers' }, false],
    [{ noteType: 1, creatorResourceID: 30683880, title: 'Closed' }, false],
    [{ noteType: 3, creatorResourceID: 30683921, title: 'Weekly Kickoff Follow-up - 9/28/2026' }, false],
    [{ noteType: 18, title: 'Client Portal Note' }, false],
    [{ noteType: 99, title: 'RMM alert' }, false], // diagnostics stay visible
  ])('%j -> %s', (note, expected) => {
    expect(isSystemTicketNote(note)).toBe(expected);
  });

  test('partition counts what it hid', () => {
    const r = partitionTicketNotes([human(1, 'a'), notif(2, 'b'), workflow(3, 'c')]);
    expect(r.human.map((n) => n.id)).toEqual([1]);
    expect(r.systemHidden).toBe(2);
  });
});

describe('ticket card — summary of what has been done', () => {
  const picklists = { getPicklistValues: jest.fn(async () => []) };
  const ticket = { id: 209477, ticketNumber: 'T20260928.0084', title: 'Shippan Landing =-290 EV Chargers' };
  // Names come from ONE batched lookup (getResourceNames); tests describe them
  // with a per-id getResource and the helper derives the batch from it.
  const svc = (over: Record<string, any>) => {
    const getResource = over.getResource ?? jest.fn(async () => null);
    return {
      searchTicketNotes: jest.fn(async () => []),
      searchTimeEntries: jest.fn(async () => ({ items: [] })),
      getTicketWebUrl: jest.fn(() => null),
      getResourceNames: jest.fn(async (ids: unknown[]) => {
        const m = new Map<number, string>();
        for (const id of new Set(ids.map(Number))) {
          const r = await getResource(id);
          if (r) m.set(id, [r.firstName, r.lastName].filter(Boolean).join(' '));
        }
        return m;
      }),
      ...over,
    };
  };

  test('tech names are ONE batched lookup, never a GET per tech', async () => {
    const getResourceNames = jest.fn(async () => new Map([[30683890, 'Travis Stives']]));
    const getResource = jest.fn();
    const service = svc({ getResource, getResourceNames, searchTimeEntries: jest.fn(async () => ({ items: [{ resourceID: 30683890, hoursWorked: 1, summaryNotes: 'x', startDateTime: '2026-09-22T14:00:00Z' }, { resourceID: 30683890, hoursWorked: 1, summaryNotes: 'y', startDateTime: '2026-09-23T14:00:00Z' }] })) });
    const card = await buildTicketCard(ticket, picklists as never, service as never, logger);
    expect(getResourceNames).toHaveBeenCalledTimes(1);
    expect(getResource).not.toHaveBeenCalled();
    expect(card!.summary.techs).toEqual(['Travis Stives']);
  });

  test('activity keeps the NEWEST 5 human notes, oldest→newest, system notes dropped and counted', async () => {
    const notes = [
      workflow(1, '2026-09-28T13:00:00Z'), notif(2, '2026-09-28T13:00:01Z'),
      human(3, '2026-09-28T13:05:00Z'), notif(4, '2026-09-28T13:05:01Z'),
      human(5, '2026-09-28T14:00:00Z'), workflow(6, '2026-09-28T14:00:01Z'),
      human(7, '2026-09-28T15:00:00Z'), human(8, '2026-09-28T16:00:00Z'),
      notif(9, '2026-09-28T16:00:01Z'), human(10, '2026-09-28T17:00:00Z'),
      human(11, '2026-09-28T18:00:00Z'), human(12, '2026-09-28T19:00:00Z'),
    ];
    const card = await buildTicketCard(ticket, picklists as never, svc({ searchTicketNotes: jest.fn(async () => notes) }) as never, logger);
    expect(card!.activity.map((a) => a.text)).toEqual(['human 7', 'human 8', 'human 10', 'human 11', 'human 12']);
    expect(card!.summary.systemNotesHidden).toBe(5);
  });

  // T20260921.0086 shape: every note is system; the tech work is in time entries.
  const pennantNotes = [
    { id: 1, noteType: 13, creatorResourceID: 4, title: 'Workflow Rule "Route Ticket to T1 Que" fired.', description: 'x', createDateTime: '2026-09-21T19:01:00Z' },
    { id: 2, noteType: 2, creatorResourceID: 30683889, title: 'TimeZest Appointment Scheduled', description: 'x', createDateTime: '2026-09-21T19:04:00Z' },
    { id: 3, noteType: 94, creatorResourceID: 30683890, title: 'This ticket absorbed ticket(s)', description: 'x', createDateTime: '2026-09-29T12:51:00Z' },
    { id: 4, noteType: 1, creatorResourceID: 4, title: 'Notification sent via Workflow Rule "Ticket Closed - Billing Cross Check"', description: 'x', createDateTime: '2026-09-29T13:10:00Z' },
  ];
  const pennantTime = [
    { id: 55351, resourceID: 30683917, dateWorked: '2026-09-21T00:00:00Z', startDateTime: '2026-09-21T19:00:00Z', hoursWorked: 0.0833, summaryNotes: '- Confirmed sitewalk with Varden via email\n- Assigned to Travis and scheduled through TimeZest' },
    { id: 55322, resourceID: 30683890, dateWorked: '2026-09-22T00:00:00Z', startDateTime: '2026-09-22T14:00:00Z', hoursWorked: 1.3167, summaryNotes: 'Arrived on site\nChecked in with Varden' },
    { id: 55512, resourceID: 30683890, dateWorked: '2026-09-29T00:00:00Z', startDateTime: '2026-09-29T13:00:00Z', hoursWorked: 0.3667, summaryNotes: 'Quoting to continue on T20260929.0078' },
  ];
  const names: Record<number, any> = { 30683917: { firstName: 'Tricia', lastName: 'Clearman' }, 30683890: { firstName: 'Travis', lastName: 'Stives' } };
  const nameOf = jest.fn(async (id: number) => names[id] ?? null);

  test('Pennant Park: summary totals + one-line tech work, no system notes, plus the Autotask link', async () => {
    const url = 'https://ww3.autotask.net/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketID=208520';
    const service = svc({
      searchTicketNotes: jest.fn(async () => pennantNotes),
      searchTimeEntries: jest.fn(async () => ({ items: pennantTime })),
      getResource: nameOf,
      getTicketWebUrl: jest.fn(() => url),
    });
    const card = await buildTicketCard(ticket, picklists as never, service as never, logger);
    expect(service.searchTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ ticketId: 209477 }));
    expect(card!.summary).toEqual({
      hoursLogged: 1.77, timeEntries: 3, techs: ['Travis Stives', 'Tricia Clearman'],
      lastActivity: '2026-09-29T13:00:00Z', systemNotesHidden: 4,
    });
    expect(card!.activity).toEqual([
      { kind: 'time', who: 'Tricia Clearman', hours: 0.08, when: '2026-09-21T19:00:00Z', text: 'Confirmed sitewalk with Varden via email · Assigned to Travis and scheduled through TimeZest' },
      { kind: 'time', who: 'Travis Stives', hours: 1.32, when: '2026-09-22T14:00:00Z', text: 'Arrived on site · Checked in with Varden' },
      { kind: 'time', who: 'Travis Stives', hours: 0.37, when: '2026-09-29T13:00:00Z', text: 'Quoting to continue on T20260929.0078' },
    ]);
    expect(card!.ticketUrl).toBe(url);
  });

  test('notes and time interleave by time, newest 5; contact notes are labelled', async () => {
    const contactNote = { ...human(11, '2026-09-30T09:00:00Z'), creatorResourceID: null, createdByContactID: 31684660 };
    const service = svc({
      searchTicketNotes: jest.fn(async () => [human(10, '2026-09-21T20:00:00Z'), contactNote, human(12, '2026-09-30T10:00:00Z')]),
      searchTimeEntries: jest.fn(async () => ({ items: pennantTime })),
      getResource: nameOf,
    });
    const card = await buildTicketCard(ticket, picklists as never, service as never, logger);
    expect(card!.activity.map((a) => `${a.kind}:${a.text.split(' · ')[0]}`)).toEqual([
      'note:human 10', 'time:Arrived on site', 'time:Quoting to continue on T20260929.0078', 'note:human 11', 'note:human 12',
    ]);
    expect(card!.activity[3]!.who).toBe('Client contact');
    expect(card!.summary.hoursLogged).toBe(1.77); // totals cover ALL entries, not just the 5 shown
  });

  test('one source failing never blanks the other; a missing link just omits it', async () => {
    const notesOnly = svc({ searchTicketNotes: jest.fn(async () => [human(1, '2026-09-21T20:00:00Z')]), searchTimeEntries: jest.fn(async () => { throw new Error('boom'); }), getTicketWebUrl: jest.fn(() => { throw new Error('no zone'); }) });
    const a = (await buildTicketCard(ticket, picklists as never, notesOnly as never, logger))!;
    expect(a.activity.map((x) => x.text)).toEqual(['human 1']);
    expect(a.summary.timeEntries).toBe(0);
    expect(a.ticketUrl).toBeUndefined();
    const timeOnly = svc({ searchTicketNotes: jest.fn(async () => { throw new Error('boom'); }), searchTimeEntries: jest.fn(async () => ({ items: pennantTime.slice(0, 1) })) });
    const b = (await buildTicketCard(ticket, picklists as never, timeOnly as never, logger))!;
    expect(b.activity[0]).toEqual(expect.objectContaining({ kind: 'time', hours: 0.08 }));
    expect(b.activity[0]!.who).toBeUndefined(); // unknown name is omitted, not invented
    expect(b.summary.techs).toEqual(['Resource 30683917']);
  });

  test('a ticket with only system notes and no time: empty activity, zero totals', async () => {
    const card = await buildTicketCard(ticket, picklists as never, svc({ searchTicketNotes: jest.fn(async () => [workflow(1, 'a'), notif(2, 'b')]) }) as never, logger);
    expect(card!.activity).toEqual([]);
    expect(card!.summary).toEqual({ hoursLogged: 0, timeEntries: 0, techs: [], systemNotesHidden: 2 });
  });
});

describe('headline', () => {
  test.each([
    ['Remote Support\n- Remotely accessed parking booth computer\n- Uninstalled KB5129195', 'Remote Support · Remotely accessed parking booth computer · Uninstalled KB5129195'],
    ['  * one\r\n\r\n• two  ', 'one · two'],
    ['', ''],
    [null, ''],
  ])('%j', (input, expected) => {
    expect(headline(input)).toBe(expected);
  });
  test('caps at 160 chars with an ellipsis', () => {
    const out = headline('x'.repeat(400));
    expect(out.length).toBe(160);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('resolveAutotaskWebUrl / ticket link', () => {
  const { resolveAutotaskWebUrl, _resetZoneUrlCache } = require('../src/utils/config');
  afterEach(() => { delete process.env.AUTOTASK_WEB_URL; _resetZoneUrlCache(); });

  test('derives wwN from the webservicesN API host', () => {
    expect(resolveAutotaskWebUrl('u@e.com', 'https://webservices3.autotask.net/ATServicesRest/')).toBe('https://ww3.autotask.net/');
  });
  test('AUTOTASK_WEB_URL override wins (slash normalised)', () => {
    process.env.AUTOTASK_WEB_URL = 'https://ww14.autotask.net';
    expect(resolveAutotaskWebUrl('u@e.com', 'https://webservices3.autotask.net/ATServicesRest/')).toBe('https://ww14.autotask.net/');
  });
  test('unknown host → null (no guessed link)', () => {
    expect(resolveAutotaskWebUrl('u@e.com', 'https://example.test/api/')).toBeNull();
  });
  test('service builds the AutotaskExtend OpenTicketDetail deep link', () => {
    const s = new AutotaskService(config, logger); // config apiUrl = webservices2
    expect(s.getTicketWebUrl(208520)).toBe('https://ww2.autotask.net/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketID=208520');
  });
});

describe('autotask_search_ticket_notes', () => {
  const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
  const body = (res: any) => JSON.parse(res.content[0].text) as { message: string; data: any };
  const notes = [workflow(1, 'a'), human(2, 'b'), notif(3, 'c'), human(4, 'd'), notif(5, 'e')];

  test('hides system notes by default and says how many', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'searchTicketNotes').mockResolvedValue(notes as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_search_ticket_notes', { ticketId: 209477 }));
    expect(b.message).toMatch(/Found 2 ticket notes \(3 system note\(s\) hidden/);
    expect(b.message).toMatch(/includeSystemNotes:true/);
  });

  test('pageSize counts HUMAN notes (a full page is read before filtering)', async () => {
    const s = new AutotaskService(config, logger);
    const search = jest.spyOn(s, 'searchTicketNotes').mockResolvedValue(notes as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_search_ticket_notes', { ticketId: 209477, pageSize: 1 }));
    expect(search).toHaveBeenCalledWith(209477, { pageSize: 500 });
    expect(b.message).toMatch(/^Found 1 ticket notes/);
  });

  test('includeSystemNotes:true returns the raw stream', async () => {
    const s = new AutotaskService(config, logger);
    const search = jest.spyOn(s, 'searchTicketNotes').mockResolvedValue(notes as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_search_ticket_notes', { ticketId: 209477, includeSystemNotes: true }));
    expect(search).toHaveBeenCalledWith(209477, { pageSize: 25 });
    expect(b.message).toMatch(/Found 5 ticket notes \(system notes included\)/);
  });
});
