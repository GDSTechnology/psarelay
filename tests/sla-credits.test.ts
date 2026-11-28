// SLA credits: the claim built from a month of logged outages, its settings, the Microsoft Graph sender, the
// outage recorder and the monthly draft gate.

import { buildClaim, DEFAULT_SLA_SETTINGS, duration, settingsFromInput, type OutageRow } from '../src/sla/claim';
import { _clearGraphTokens, graphProblem, sendGraphMail } from '../src/sla/graph-mail';
import { monthlyDraftTick, recordOutageTick, SlaStore } from '../src/sla/store';

const row = (o: Partial<OutageRow> & { startedAt: string }): OutageRow => ({
  id: 1, endedAt: null, lastSeenAt: o.startedAt, confirmedBack: true, endedReason: 'back', failures: 6,
  endpoints: ['Tickets', 'Companies', 'TimeEntries'], httpStatuses: [503], networkErrors: 0, lastError: 'HTTP 503', ...o,
});
const S = { ...DEFAULT_SLA_SETTINGS, to: ['support@example.com'], thresholdMinutes: 5, reference: 'Example MSP — account 12345', committedUptimePct: 99.9 };
const DEC1 = Date.parse('2026-12-01T07:00:00Z');

describe('buildClaim', () => {
  const rows = [
    row({ id: 1, startedAt: '2026-11-26T19:58:00Z', endedAt: '2026-11-26T19:59:12Z' }), // 72 s
    row({ id: 2, startedAt: '2026-11-26T20:17:00Z', endedAt: '2026-11-26T20:27:00Z' }), // 600 s
    row({ id: 3, startedAt: '2026-11-26T20:20:00Z', endedAt: '2026-11-26T20:30:00Z' }), // overlaps #2 → +180 s
    row({ id: 4, startedAt: '2026-11-27T03:00:00Z', endedAt: '2026-11-27T03:30:00Z', httpStatuses: [], networkErrors: 7, lastError: 'fetch failed' }), // not counted
    row({ id: 5, startedAt: '2026-10-31T23:58:00Z', endedAt: '2026-11-01T00:02:00Z' }), // clipped: 120 s in November
  ];
  const c = buildClaim(rows, '2026-11', S, DEC1);

  test('counts 5xx outages, merges overlaps, clips to the month, leaves no-answer ones out', () => {
    expect(c.downtimeSeconds).toBe(72 + 600 + 180 + 120);
    expect(c.countedIncidents).toBe(4);
    expect(c.incidents.find((i) => i.id === 4)).toMatchObject({ counted: false, note: expect.stringMatching(/our connection/) });
    expect(c.incidents.find((i) => i.id === 5)).toMatchObject({ start: '2026-11-01T00:00:00.000Z', seconds: 120 });
    expect(c.uptimePct).toBeCloseTo(100 * (1 - 972 / (30 * 86400)), 3);
    expect(c.qualifies).toBe(true);
  });

  test('the email: month, reference, total, agreement uptime, a UTC line per outage, the uncounted one apart', () => {
    expect(c.subject).toBe('SLA credit request — Autotask PSA downtime, November 2026');
    expect(c.bodyText).toMatch(/for November 2026\./);
    expect(c.bodyText).toMatch(/Example MSP — account 12345/);
    expect(c.bodyText).toMatch(/recorded 4 periods in November 2026 .* totalling 16 min 12 s/);
    expect(c.bodyText).toMatch(/against the 99\.9% in our agreement/);
    expect(c.bodyText).toMatch(/2026-11-26 19:58:00 – 19:59:12 {2}1 min 12 s +HTTP 503 {2}Tickets, Companies, TimeEntries/);
    expect(c.bodyText).toMatch(/not counted above \(no HTTP answer[\s\S]*2026-11-27 03:00:00/);
  });

  test('under the threshold: no claim; counting no-answer outages is a setting', () => {
    expect(buildClaim([rows[0]!], '2026-11', S, DEC1).qualifies).toBe(false);
    expect(buildClaim([], '2026-11', { ...S, thresholdMinutes: 0 }, DEC1).qualifies).toBe(false);
    expect(buildClaim([rows[3]!], '2026-11', { ...S, includeNetworkOnly: true }, DEC1).downtimeSeconds).toBe(1800);
  });

  test('a still-open outage runs to now; an outage cut by a restart says so', () => {
    const now = Date.parse('2026-11-28T10:10:00Z');
    const open = buildClaim([row({ startedAt: '2026-11-28T10:00:00Z', endedAt: null, lastSeenAt: '2026-11-28T10:05:00Z' })], '2026-11', S, now);
    expect(open.downtimeSeconds).toBe(600);
    expect(open.incidents[0]!.note).toMatch(/still open/);
    const cut = buildClaim([row({ startedAt: '2026-11-28T10:00:00Z', endedAt: '2026-11-28T10:05:00Z', endedReason: 'restart' })], '2026-11', S, now);
    expect(cut.incidents[0]!.note).toMatch(/restart/);
  });

  test('durations', () => {
    expect(duration(40)).toBe('40 s');
    expect(duration(3840)).toBe('1 h 4 min');
  });
});

describe('settings', () => {
  test('addresses checked, monthly claims need a To, uptime % in range', () => {
    expect(settingsFromInput({ to: 'a@example.com; b@example.com', enabled: true }, DEFAULT_SLA_SETTINGS)).toMatchObject({ to: ['a@example.com', 'b@example.com'], enabled: true });
    expect(() => settingsFromInput({ to: 'not-an-address' }, DEFAULT_SLA_SETTINGS)).toThrow(/not an email/);
    expect(() => settingsFromInput({ enabled: true }, DEFAULT_SLA_SETTINGS)).toThrow(/address/);
    expect(() => settingsFromInput({ committedUptimePct: 120 }, DEFAULT_SLA_SETTINGS)).toThrow(/between 90 and 100/);
    expect(settingsFromInput({ committedUptimePct: '' }, { ...DEFAULT_SLA_SETTINGS, committedUptimePct: 99.9 }).committedUptimePct).toBeNull();
  });
});

describe('Microsoft Graph sender', () => {
  const cfg = { tenantId: '11111111-1111-1111-1111-111111111111', clientId: '22222222-2222-2222-2222-222222222222', clientSecret: 'sek', sender: 'support@example.com' };
  beforeEach(() => _clearGraphTokens());

  test('client-credentials token, then sendMail from the sender as plain text, saved to Sent Items', async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const f = jest.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: init.body, headers: init.headers });
      return url.includes('/token') ? { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3599 }) } : { ok: true, status: 202, text: async () => '' };
    });
    await sendGraphMail(cfg, { to: ['kaseya@example.com'], cc: ['me@example.com'], subject: 'S', text: 'T' }, f as never);
    expect(calls[0]!.url).toBe(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`);
    expect(calls[0]!.body).toMatch(/grant_type=client_credentials/);
    expect(calls[0]!.body).toMatch(/scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
    expect(calls[1]!.url).toBe('https://graph.microsoft.com/v1.0/users/support%40example.com/sendMail');
    expect(calls[1]!.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[1]!.body)).toEqual({ message: { subject: 'S', body: { contentType: 'Text', content: 'T' }, toRecipients: [{ emailAddress: { address: 'kaseya@example.com' } }], ccRecipients: [{ emailAddress: { address: 'me@example.com' } }] }, saveToSentItems: true });
    await sendGraphMail(cfg, { to: ['kaseya@example.com'], subject: 'S', text: 'T' }, f as never);
    expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(1); // token cached
  });

  test('errors say what to fix', async () => {
    const f = jest.fn(async (url: string) => url.includes('/token')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3599 }) }
      : { ok: false, status: 403, text: async () => JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }) });
    await expect(sendGraphMail(cfg, { to: ['k@example.com'], subject: 'S', text: 'T' }, f as never)).rejects.toThrow(/Mail\.Send APPLICATION permission/);
    expect(graphProblem(401, JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }))).toMatch(/client secret is wrong or expired/);
  });
});

describe('outage recorder', () => {
  const fakeDb = () => {
    const q: Array<{ sql: string; params: unknown[] }> = [];
    return { q, db: { query: jest.fn(async (sql: string, params: unknown[] = []) => { q.push({ sql, params }); return { rows: [{ id: '42' }], rowCount: 1 }; }) } };
  };
  const status = { seconds: 20, awaitingTest: false, since: '2026-11-26T19:58:00.000Z', failures: 6, endpoints: ['Tickets', 'Companies'], lastError: 'HTTP 503', httpStatuses: [503], networkErrors: 0 };

  test('an open outage is upserted by its start; when the breaker closes the row is ended as confirmed back', async () => {
    const { q, db } = fakeDb();
    const now = Date.parse('2026-11-26T19:58:20Z');
    const id = await recordOutageTick(db as never, 't', null, now, status);
    expect(id).toBe(42);
    expect(q[0]!.sql).toMatch(/INSERT INTO autotask_outage[\s\S]*ON CONFLICT \(tenant, started_at\)/);
    expect(q[0]!.params).toEqual(['t', status.since, new Date(now).toISOString(), 6, ['Tickets', 'Companies'], [503], 0, 'HTTP 503']);
    expect(await recordOutageTick(db as never, 't', 42, now + 60_000, null)).toBeNull();
    expect(q[1]!.sql).toMatch(/SET ended_at = \$2, confirmed_back = true, ended_reason = 'back'/);
    expect(q[1]!.params).toEqual([42, new Date(now + 60_000).toISOString()]);
    expect(await recordOutageTick(db as never, 't', null, now, null)).toBeNull();
    expect(q).toHaveLength(2); // nothing open, nothing to do
  });
});

describe('monthly draft', () => {
  const store = (o: { enabled?: boolean; existing?: string[] } = {}) => {
    const s = Object.create(SlaStore.prototype) as SlaStore;
    Object.assign(s, {
      load: async () => ({ settings: { ...S, enabled: o.enabled ?? true }, mail: null }),
      claims: async () => (o.existing ?? []).map((month) => ({ month })),
      draftFor: jest.fn(async () => buildClaim([row({ startedAt: '2026-11-26T20:17:00Z', endedAt: '2026-11-26T20:27:00Z' })], '2026-11', S, DEC1)),
      saveDraft: jest.fn(async (d: { month: string }) => ({ id: 1, month: d.month })),
    });
    return s;
  };

  test('only on the 1st from 06:00 UTC, when on, once per month', async () => {
    expect(await monthlyDraftTick(store(), Date.parse('2026-11-30T12:00:00Z'))).toBeNull();
    expect(await monthlyDraftTick(store(), Date.parse('2026-12-01T05:00:00Z'))).toBeNull();
    expect(await monthlyDraftTick(store({ enabled: false }), DEC1)).toBeNull();
    expect(await monthlyDraftTick(store({ existing: ['2026-11-01'] }), DEC1)).toBeNull();
    const s = store();
    expect(await monthlyDraftTick(s, DEC1)).toMatchObject({ month: '2026-11-01' });
    expect((s as unknown as { draftFor: jest.Mock }).draftFor.mock.calls[0]![0]).toEqual(new Date('2026-11-01T00:00:00Z'));
  });
});
