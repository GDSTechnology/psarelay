// Ticket audit tools (PR A): ticket-number resolution, full resolved ticket,
// parsed change history with actor attribution, the original email (RFC 822),
// multi-field picklists, and labelled notes. Asserts the filters sent upstream.

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import { actorKind, labelUdfs, normalizeTicketNumber, parseHistoryChange, picklistLabels } from '../src/utils/ticket-audit';
import { decodeEncodedWords, parseAddress, parseAddressList, parseRfc822 } from '../src/utils/rfc822';
import type { McpServerConfig } from '../src/types/mcp';
import { _setShadowRuntime } from '../src/db/shadow-runtime';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const pv = (pairs: Array<[number, string]>) => pairs.map(([value, label]) => ({ value: String(value), label, isDefaultValue: false, sortOrder: 0, isActive: true, isSystem: false }));
const TICKET_FIELDS: any[] = [
  { name: 'status', isPickList: true, picklistValues: pv([[1, 'New'], [5, 'Complete'], [8, 'In Progress'], [47, 'Ready to ship / Release']]) },
  { name: 'priority', isPickList: true, picklistValues: pv([[1, 'High'], [2, 'Medium']]) },
  { name: 'queueID', isPickList: true, picklistValues: pv([[29682833, 'Triage'], [29683480, 'Service Desk']]) },
  { name: 'source', isPickList: true, picklistValues: pv([[4, 'Email'], [2, 'Phone']]) },
  { name: 'creatorType', isPickList: true, picklistValues: pv([[1, 'Resource'], [2, 'Contact']]) },
  { name: 'title', isPickList: false },
];
afterEach(() => jest.restoreAllMocks());

describe('ticket-audit helpers', () => {
  test('normalizeTicketNumber', () => {
    expect(normalizeTicketNumber('t20261005.0123')).toBe('T20261005.0123');
    expect(normalizeTicketNumber(' 20261005.0123 ')).toBe('T20261005.0123');
    expect(normalizeTicketNumber('T2026100.0123')).toBeNull();
    expect(normalizeTicketNumber(undefined)).toBeNull();
  });

  test('parseHistoryChange: simple, [none], and " to " inside a value anchored by known labels', () => {
    expect(parseHistoryChange('Priority changed from Medium to High')).toEqual({ field: 'Priority', from: 'Medium', to: 'High', ambiguous: false });
    expect(parseHistoryChange('Contact changed from jane@x.com, Jane to [none selected]')).toMatchObject({ field: 'Contact', to: null, ambiguous: false });
    const labels = ['New', 'In Progress', 'Ready to ship / Release'];
    expect(parseHistoryChange('Status changed from In Progress to Ready to ship / Release', labels)).toEqual({ field: 'Status', from: 'In Progress', to: 'Ready to ship / Release', ambiguous: false });
    // Two " to " and nothing to anchor on → first split, flagged ambiguous (raw detail stays authoritative).
    expect(parseHistoryChange('Account changed from Back to Basics LLC to Acme Co')).toMatchObject({ field: 'Account', ambiguous: true });
    expect(parseHistoryChange('Ticket Triage Rule Fired')).toBeNull();
  });

  test('actorKind: 4 = system, the MCP API user, a person, unknown', () => {
    expect(actorKind(4, 30683921)).toBe('system');
    expect(actorKind(30683921, 30683921)).toBe('mcp-api-user');
    expect(actorKind(30683880, 30683921)).toBe('resource');
    expect(actorKind(null, 30683921)).toBe('unknown');
  });

  test('picklistLabels + labelUdfs', () => {
    expect(picklistLabels({ status: 8, priority: 2, queueID: null, title: 'x' }, TICKET_FIELDS)).toEqual({ status: 'In Progress', priority: 'Medium' });
    const defs = [{ name: 'BP-Status', isPickList: true, picklistValues: [{ value: '3', label: 'Billed' }] }, { name: 'RMA #' }];
    expect(labelUdfs([{ name: 'BP-Status', value: '3' }, { name: 'RMA #', value: 'R-1' }, { name: 'Empty', value: null }], defs))
      .toEqual([{ name: 'BP-Status', value: '3', label: 'Billed' }, { name: 'RMA #', value: 'R-1' }]);
  });
});

const CRLF = String.fromCharCode(13, 10);
const SAMPLE = [
  'Return-Path: <bounce@mailer.example>',
  'Authentication-Results: mx.microsoft.com 1; spf=pass smtp.mailfrom=edge.example;',
  ' dkim=pass header.d=edge.example; dmarc=pass action=none',
  'Received-SPF: Pass (protection.outlook.com: domain of edge.example designates 1.2.3.4)',
  'DKIM-Signature: v=1; a=rsa-sha256; d=edge.example; s=sel; h=from:to',
  'From: =?UTF-8?B?RGFuacOrbCBMZWU=?= <Marketing.Edge@Example.com>',
  'Reply-To: "Billing, Dept" <billing@other.example>',
  'To: help@msp.example, "Desk" <desk@msp.example>',
  'Subject: =?utf-8?Q?Invoice_=E2=80=94_overdue?=',
  'Date: Mon, 5 Oct 2026 09:12:00 -0400',
  'Message-ID: <abc@edge.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="OUTER"',
  '',
  '--OUTER',
  'Content-Type: multipart/alternative; boundary="ALT"',
  '',
  '--ALT',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hello caf=C3=A9 team,=',
  ' please pay.',
  '--ALT',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hello</p>',
  '--ALT--',
  '--OUTER',
  'Content-Type: application/pdf; name="inv.pdf"',
  'Content-Disposition: attachment; filename="inv.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQ=',
  '--OUTER--',
  '',
].join(CRLF);

describe('rfc822', () => {
  test('headers unfolded + decoded, addresses parsed, text/plain body (QP, utf-8), parts listed', () => {
    const m = parseRfc822(Buffer.from(SAMPLE, 'latin1'));
    expect(m.header('Subject')).toBe('Invoice — overdue');
    expect(parseAddress(m.header('From'))).toEqual({ name: 'Daniël Lee', address: 'marketing.edge@example.com' });
    expect(parseAddressList(m.header('Reply-To'))).toEqual([{ name: 'Billing, Dept', address: 'billing@other.example' }]);
    expect(parseAddressList(m.header('To')).map((a) => a.address)).toEqual(['help@msp.example', 'desk@msp.example']);
    expect(m.all('Authentication-Results')[0]).toMatch(/spf=pass .* dkim=pass .* dmarc=pass/);
    expect(m.textSource).toBe('text/plain');
    expect(m.textBody).toBe('Hello café team, please pay.');
    expect(m.parts.map((p) => p.contentType)).toEqual(['text/plain', 'text/html', 'application/pdf']);
    expect(m.parts[2]).toMatchObject({ filename: 'inv.pdf', size: 8 });
  });

  test('HTML-only body → text; malformed input never throws', () => {
    const html = ['From: a@b.c', 'Content-Type: text/html; charset=utf-8', '', '<style>x{}</style><p>Line 1</p><p>Line&nbsp;2 &amp; more</p>'].join('\n');
    const m = parseRfc822(html);
    expect(m.textSource).toBe('text/html');
    expect(m.textBody).toBe('Line 1\nLine 2 & more');
    expect(() => parseRfc822('garbage without headers')).not.toThrow();
    expect(decodeEncodedWords('=?utf-8?B?SGk=?= =?utf-8?B?IHRoZXJl?=')).toBe('Hi there');
  });
});

function mkService(http: Record<string, any>) {
  const s = new AutotaskService(config, logger);
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue(http);
  jest.spyOn(s, 'getFieldInfo').mockResolvedValue(TICKET_FIELDS);
  return s;
}

describe('resolveTicketRef', () => {
  test('number (normalised) → exact eq query; ambiguity and not-found are explicit', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 11, ticketNumber: 'T20261005.0123' }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const s = mkService({ query });
    expect(await s.resolveTicketRef({ ticketNumber: 't20261005.0123' })).toEqual({ id: 11, ticketNumber: 'T20261005.0123' });
    expect(query.mock.calls[0]![1]).toEqual([{ op: 'eq', field: 'ticketNumber', value: 'T20261005.0123' }]);
    expect(await s.resolveTicketRef({ ticketNumber: 'T20261005.0999' })).toEqual({ error: 'No ticket T20261005.0999 found.' });
    expect('error' in await s.resolveTicketRef({ ticketNumber: 'T20261005.0001' })).toBe(true);
    expect(await s.resolveTicketRef({ ticketID: 42 })).toEqual({ id: 42 });
    expect(await s.resolveTicketRef({ ticketNumber: 'nope' })).toMatchObject({ error: expect.stringMatching(/ticket number like/) });
  });
});

describe('getTicketFull', () => {
  test('labels picklists, names references (in parallel — the per-endpoint gate caps threads), labels UDFs, links', async () => {
    let inFlight = 0, max = 0;
    const ticket = { id: 7, ticketNumber: 'T1', title: 'Help', status: 8, priority: 1, queueID: 29682833, source: 4, creatorType: 2,
      companyID: 100, contactID: 200, createdByContactID: 200, assignedResourceID: 300, creatorResourceID: 4, assignedResourceRoleID: 9, contractID: 55,
      userDefinedFields: [{ name: 'BP-Status', value: '3' }] };
    const rowsBy: Record<string, any[]> = {
      Contacts: [{ id: 200, firstName: 'Dan', lastName: 'Lee', emailAddress: 'dan@x.com', companyID: 100, isActive: true }],
      Roles: [{ id: 9, name: 'Tech' }], Contracts: [{ id: 55, contractName: 'MSA' }],
    };
    const http = {
      get: jest.fn(async () => ticket),
      query: jest.fn(async (e: string) => { inFlight++; max = Math.max(max, inFlight); await new Promise((r) => setTimeout(r, 1)); inFlight--; return rowsBy[e] ?? []; }),
      udfInfo: jest.fn(async () => ({ fields: [{ name: 'BP-Status', isPickList: true, picklistValues: [{ value: '3', label: 'Billed' }] }] })),
    };
    const s = mkService(http);
    jest.spyOn(s, 'getCompanyNamesByIds').mockResolvedValue([{ id: 100, companyName: 'Edge Estimates' }]);
    jest.spyOn(s, 'getResourceNames').mockResolvedValue(new Map([[300, 'Tech One']]));
    jest.spyOn(s, 'getTicketWebUrl').mockReturnValue('https://ww/x?TicketID=7');
    const r: any = await s.getTicketFull(7);
    expect(max).toBeGreaterThan(1); // lookups run together (different endpoints)
    expect(r.labels).toMatchObject({ status: 'In Progress', priority: 'High', queueID: 'Triage', source: 'Email', creatorType: 'Contact' });
    expect(r.names.companyID).toEqual({ id: 100, name: 'Edge Estimates' });
    expect(r.names.contactID).toMatchObject({ id: 200, name: 'Dan Lee', email: 'dan@x.com' });
    expect(r.names.assignedResourceID).toEqual({ id: 300, name: 'Tech One' });
    expect(r.names.creatorResourceID).toEqual({ id: 4, name: 'Autotask Administrator (system)' });
    expect(r.names.assignedResourceRoleID).toEqual({ id: 9, name: 'Tech' });
    expect(r.names.contractID).toEqual({ id: 55, contractName: 'MSA' });
    expect(r.udfs).toEqual([{ name: 'BP-Status', value: '3', label: 'Billed' }]);
    expect(r.ticket.userDefinedFields).toBeUndefined();
    expect(r.ticketUrl).toMatch(/TicketID=7/);
    expect(r.errors).toBeUndefined();
    // A caller that already holds the row (get_ticket_by_number) skips the GET.
    http.get.mockClear();
    await s.getTicketFull(7, ticket as any);
    expect(http.get).not.toHaveBeenCalled();
  });
});

describe('getTicketHistoryEvents', () => {
  test('oldest first, timestamp noise hidden + counted, actors classified and named', async () => {
    const rows = [
      { id: 3, date: '2026-10-05T10:02:00Z', action: 'Account Changed', detail: 'Account changed from Unknown Sorting to Edge Estimates', resourceID: 30683921 },
      { id: 1, date: '2026-10-05T10:00:00Z', action: 'Created', detail: '', resourceID: 31685309 },
      { id: 2, date: '2026-10-05T10:01:00Z', action: 'Queue Changed', detail: 'Queue changed from Triage to Service Desk', resourceID: 4 },
      { id: 4, date: '2026-10-05T10:03:00Z', action: 'Last Activity Date Changed', detail: 'x', resourceID: 4 },
    ];
    const query = jest.fn(async () => rows.map((r) => ({ ...r })));
    const s = mkService({ query });
    jest.spyOn(s, 'resolveApiUserResourceId').mockResolvedValue(30683921);
    jest.spyOn(s, 'getResourceNames').mockResolvedValue(new Map([[30683921, 'Nexus Z - API']]));
    const r: any = await s.getTicketHistoryEvents(7);
    expect(query.mock.calls[0]).toEqual(['TicketHistory', [{ op: 'eq', field: 'ticketID', value: 7 }], { maxRecords: 500 }]);
    expect(r.events.map((e: any) => e.id)).toEqual([1, 2, 3]);
    expect(r.events[1]).toMatchObject({ field: 'Queue', from: 'Triage', to: 'Service Desk', actor: { kind: 'system', name: 'Autotask Administrator (system)' } });
    expect(r.events[2]).toMatchObject({ field: 'Account', from: 'Unknown Sorting', to: 'Edge Estimates', actor: { kind: 'mcp-api-user', name: 'Nexus Z - API' } });
    expect(r.counts).toEqual({ events: 3, hiddenTimestampOnly: 1, byActorKind: { resource: 1, system: 1, 'mcp-api-user': 1 }, byActorType: { unknown: 1, system: 1, service_account: 1 } }); // no resource record → unknown, never assumed human
    expect((await s.getTicketHistoryEvents(7, { includeNoise: true }) as any).events).toHaveLength(4);
  });

  describe('history index (MCP-004)', () => {
    const HIST = [
      { id: 1, date: '2026-10-05T10:00:00Z', action: 'Created', detail: '', resourceID: 31685309 },
      { id: 2, date: '2026-10-05T10:01:00Z', action: 'Queue Changed', detail: 'Queue changed from Triage to Service Desk', resourceID: 4 },
    ];
    /** Fake runtime: Tickets mirror (fresh unless stale), a ledger that really stores, a sync that can mark the ticket dirty. */
    function rt(o: { lastMod?: string; stale?: boolean; dirty?: boolean } = {}) {
      const stored: any[] = []; const fetched = new Map<number, Date>();
      return {
        stored, fetched,
        runtime: {
          maxAgeSeconds: 900,
          sync: { isDirty: () => !!o.dirty },
          store: {
            freshness: async () => ({ ready: true, ageSeconds: o.stale ? 5000 : 30 }),
            query: async () => ({ rows: [{ id: 7, ticketNumber: 'T7', companyID: 9, lastTrackedModificationDateTime: o.lastMod ?? '2026-10-05T10:01:00Z' }] }),
          },
          ledger: {
            insert: async (evs: any[]) => { for (const e of evs) if (!stored.some((x) => x.eventId === e.eventId)) stored.push(e); return evs.length; },
            markHistoryFetched: async (id: number, at: Date) => { fetched.set(id, at); },
            historyFetched: async (ids: number[]) => new Map([...fetched].filter(([k]) => ids.includes(k))),
            query: async () => stored,
          },
        },
      };
    }
    afterEach(() => _setShadowRuntime(null));

    test('a live read is indexed; the next read comes from the index (0 calls) with the same events', async () => {
      const r = rt(); _setShadowRuntime(r.runtime as never);
      const query = jest.fn(async (e: string) => (e === 'TicketHistory' ? HIST.map((x) => ({ ...x })) : []));
      const histCalls = () => query.mock.calls.filter((c) => c[0] === 'TicketHistory').length;
      const s = mkService({ query });
      jest.spyOn(s, 'resolveApiUserResourceId').mockResolvedValue(30683921);
      const first: any = await s.getTicketHistoryEvents(7);
      expect(first.source).toEqual({ from: 'live' });
      expect(r.stored.map((e) => [e.eventId, e.entityReference])).toEqual([['th:1', 'T7'], ['th:2', 'T7']]);
      const second: any = await s.getTicketHistoryEvents(7);
      expect(histCalls()).toBe(1);
      expect(second.source).toMatchObject({ from: 'index', ticketLastModified: '2026-10-05T10:01:00.000Z' });
      expect(second.events.map((e: any) => [e.id, e.action, e.field ?? null, e.from ?? null, e.to ?? null])).toEqual(first.events.map((e: any) => [e.id, e.action, e.field ?? null, e.from ?? null, e.to ?? null]));
      expect(second.counts.hiddenTimestampOnly).toBeNull();
    });

    test('changed since indexed, stale mirror, written ticket, live:true or includeNoise → live', async () => {
      for (const [o, args] of [[{ lastMod: '2099-01-01T00:00:00Z' }, {}], [{ stale: true }, {}], [{ dirty: true }, {}], [{}, { live: true }], [{}, { includeNoise: true }]] as const) {
        const r = rt(o); _setShadowRuntime(r.runtime as never);
        r.fetched.set(7, new Date('2026-10-06T00:00:00Z'));
        const query = jest.fn(async (e: string) => (e === 'TicketHistory' ? HIST.map((x) => ({ ...x })) : []));
      const histCalls = () => query.mock.calls.filter((c) => c[0] === 'TicketHistory').length;
        const s = mkService({ query });
        jest.spyOn(s, 'resolveApiUserResourceId').mockResolvedValue(null);
        const out: any = await s.getTicketHistoryEvents(7, args);
        expect(out.source.from).toBe('live');
        expect(histCalls()).toBe(1);
      }
    });
  });
});

describe('getTicketEmailContext', () => {
  const ticket = { id: 7, ticketNumber: 'T1', title: 'Invoice', source: 4, creatorType: 2, createdByContactID: 200, createDate: '2026-10-05T13:12:00Z' };
  const mk = (atts: any[], data?: string) => {
    const http = {
      get: jest.fn(async (e: string) => (e === 'Tickets' ? ticket : { id: 900, ticketID: 7, data })),
      query: jest.fn(async (e: string) => (e === 'TicketAttachments' ? atts : e === 'Contacts' ? [{ id: 200, firstName: 'Dan', lastName: 'Lee', emailAddress: 'dan@x.com' }] : [])),
    };
    return { s: mkService(http), http };
  };

  test('parses the Originating Email attachment; flags a Reply-To that differs from From', async () => {
    const { s, http } = mk([{ id: 901, title: 'logo.eml', contentType: 'message/rfc822', fileSize: 10, attachDate: '2026-10-05T13:13:00Z' }, { id: 900, title: 'Originating Email', contentType: 'message/rfc822', fileSize: 2000, attachDate: '2026-10-05T13:12:00Z' }],
      Buffer.from(SAMPLE, 'latin1').toString('base64'));
    const r: any = await s.getTicketEmailContext(7);
    expect(http.get).toHaveBeenCalledWith('TicketAttachments', 900); // the Originating Email, preferred
    expect(r.status).toBe('ok');
    expect(r.source).toEqual({ value: 4, label: 'Email', isEmail: true });
    expect(r.creator).toMatchObject({ type: 'Contact', contact: { id: 200, name: 'Dan Lee', email: 'dan@x.com' } });
    expect(r.originalEmail).toMatchObject({
      fromAddress: 'marketing.edge@example.com', fromDisplayName: 'Daniël Lee', replyToDiffersFromFrom: true,
      subject: 'Invoice — overdue', messageId: '<abc@edge.example>', dkimDomains: ['edge.example'], textBody: 'Hello café team, please pay.',
    });
    expect(r.originalEmail.authenticationResults).toHaveLength(1);
    expect(r.notExposedByApi).toHaveLength(2);
  });

  test('email source but no attached message → explicit status, no guess', async () => {
    const { s } = mk([]);
    const r: any = await s.getTicketEmailContext(7);
    expect(r.status).toBe('no_original_email');
    expect(r.message).toMatch(/came in by email but has no original-message attachment/);
  });
});

describe('getPicklists + handler', () => {
  test('several fields in one call; unknown and non-picklist reported', async () => {
    const s = mkService({});
    const r = await s.getPicklists('Tickets', ['status', 'QUEUEID', 'title', 'bogus']);
    expect(Object.keys(r.picklists)).toEqual(['status', 'queueID']);
    expect(r.unknownFields).toEqual(['bogus']);
    expect(r.notPicklists).toEqual(['title']);
  });

  test('get_ticket_by_number handler: number → full ticket, summary message', async () => {
    const s = mkService({});
    jest.spyOn(s, 'resolveTicketRef').mockResolvedValue({ id: 7, ticketNumber: 'T1' });
    jest.spyOn(s, 'getTicketFull').mockResolvedValue({ ticket: { ticketNumber: 'T1', title: 'Help' }, labels: { status: 'New', queueID: 'Triage' }, names: { companyID: { id: 1, name: 'Edge' }, contactID: { id: 2, name: 'Dan', email: 'd@x.com' } }, udfs: [], ticketUrl: 'https://u' });
    const res = await new AutotaskToolHandler(s, logger).callTool('autotask_get_ticket_by_number', { ticketNumber: 'T1' });
    const msg = JSON.parse(res.content[0].text).message;
    expect(msg).toMatch(/T1 — Help: status New, queue Triage, company Edge, contact Dan <d@x.com>\. Open: https:\/\/u/);
  });
});

describe('labelTicketNotes', () => {
  test('adds author (resource / contact / system) and labels without touching existing fields', async () => {
    const query = jest.fn(async () => [{ id: 200, firstName: 'Dan', lastName: 'Lee', emailAddress: 'dan@x.com' }]);
    const s = mkService({ query });
    jest.spyOn(s, 'getPicklistValues').mockImplementation(async (_e: string, f: string) => (f === 'noteType' ? pv([[1, 'Task Summary']]) : pv([[2, 'Internal Project Team']])) as any);
    jest.spyOn(s, 'getResourceNames').mockResolvedValue(new Map([[300, 'Tech One']]));
    const out = await s.labelTicketNotes([
      { id: 1, noteType: 1, publish: 2, creatorResourceID: 300 },
      { id: 2, noteType: 1, publish: 2, createdByContactID: 200 },
      { id: 3, noteType: 1, publish: 2, creatorResourceID: 4 },
    ]);
    expect(out[0]).toMatchObject({ id: 1, authorKind: 'resource', authorName: 'Tech One', noteTypeLabel: 'Task Summary', publishLabel: 'Internal Project Team' });
    expect(out[1]).toMatchObject({ authorKind: 'contact', authorName: 'Dan Lee <dan@x.com>' });
    expect(out[2]).toMatchObject({ authorKind: 'system', authorName: 'Autotask Administrator (system)' });
  });
});
