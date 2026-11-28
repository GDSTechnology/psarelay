// Outage alerts: a STOP says what failed (modules, last error), and its all-clear always follows —
// to every channel that heard the STOP, once a call has confirmed Autotask is back, with how long it lasted.

import { checkOnce, initialWatchState, spokenDuration, TEST_WAIT_MS, type WatchSources } from '../src/services/notify-watch';
import { assessBackpressure } from '../src/services/backpressure';
import { Notifier, type NotifyChannel } from '../src/services/notifier';
import { _resetUpstreamGuard, outageStatus, recordSuccess, recordTransientFailure } from '../src/services/upstream-guard';
import type { OutageStatus } from '../src/services/upstream-guard';

const NOW = Date.parse('2026-11-26T19:58:00Z');
const usage = { usedPct: 13.3, used: 1330, limit: 10_000, at: new Date(NOW).toISOString() };
const src = (outage: OutageStatus | null, outageSeconds: number, now: number): WatchSources => ({
  backpressure: () => assessBackpressure({ usage, auth: null, cooldownSeconds: 0, queued: 0, now, outageSeconds, outage }),
  lastRun: () => null, lastVerify: () => null, toolErrors: () => [],
});
const down: OutageStatus = { seconds: 30, awaitingTest: false, since: new Date(NOW).toISOString(), failures: 6, endpoints: ['Tickets', 'Companies', 'TimeEntries'], lastError: 'HTTP 503: Service Unavailable', httpStatuses: [503], networkErrors: 0 };
const waiting: OutageStatus = { ...down, seconds: 0, awaitingTest: true };

beforeEach(() => { process.env.AUTOTASK_OUTAGE_FAILURES = '5'; }); // setup.ts turns the breaker off
afterEach(() => { _resetUpstreamGuard(); process.env.AUTOTASK_OUTAGE_FAILURES = '100'; });

test('the outage breaker reports what failed, and stays "awaiting a test" until a call gets through', () => {
  const t = 'tenant';
  for (const [i, ep] of ['Tickets', 'Tickets', 'Companies', 'TimeEntries', 'Tickets'].entries()) recordTransientFailure(t, ep, `HTTP 503 #${i}`, NOW + i, i === 2 ? undefined : 503);
  const o = outageStatus(t, NOW + 10)!;
  expect(o).toMatchObject({ seconds: 30, awaitingTest: false, failures: 5, endpoints: ['Tickets', 'Companies', 'TimeEntries'], lastError: 'HTTP 503 #4', httpStatuses: [503], networkErrors: 1 });
  expect(outageStatus(t, NOW + 31_000)).toMatchObject({ seconds: 0, awaitingTest: true });
  recordSuccess(t, 'Tickets');
  expect(outageStatus(t, NOW + 32_000)).toBeNull();
});

test('STOP names the failing modules and the last error, and promises a follow-up', () => {
  const r = checkOnce(src(down, 30, NOW), initialWatchState(), NOW);
  const stop = r.events.find((e) => e.type === 'backpressure.stop')!;
  expect(stop.detail).toMatch(/6 network errors \/ 5xx answers within a minute on Tickets, Companies, TimeEntries; last: HTTP 503: Service Unavailable/);
  expect(stop.detail).toMatch(/A message follows when calls flow again/);
  expect(stop.fields).toMatchObject({ failing: 'Tickets, Companies, TimeEntries', 'errors in the last minute': '6', 'last error': 'HTTP 503: Service Unavailable', 'tenant usage': '13.3%' });
});

test('"back" waits for a call to get through, then says how long it was stopped', () => {
  let s = checkOnce(src(down, 30, NOW), initialWatchState(), NOW).state;
  // The pause ran out, but nothing has tested Autotask yet: no all-clear.
  let r = checkOnce(src(waiting, 0, NOW + 40_000), s, NOW + 40_000); s = r.state;
  expect(r.events).toEqual([]);
  // A call got through (breaker cleared).
  r = checkOnce(src(null, 0, NOW + 72_000), s, NOW + 72_000);
  expect(r.events).toHaveLength(1);
  expect(r.events[0]).toMatchObject({ type: 'backpressure.recovered', title: 'Autotask back — calls flowing again', fields: { 'stopped for': '1 min 12 s' }, clears: ['backpressure.stop'] });
  expect(checkOnce(src(null, 0, NOW + 90_000), r.state, NOW + 90_000).events).toEqual([]);
});

test('with no call to test it, the all-clear still comes after the wait — marked untested', () => {
  let s = checkOnce(src(down, 30, NOW), initialWatchState(), NOW).state;
  s = checkOnce(src(waiting, 0, NOW + 30_000), s, NOW + 30_000).state;
  const r = checkOnce(src(waiting, 0, NOW + 30_000 + TEST_WAIT_MS), s, NOW + 30_000 + TEST_WAIT_MS);
  expect(r.events[0]).toMatchObject({ type: 'backpressure.recovered', title: 'Autotask pause over (not yet tested)' });
  expect(r.events[0]!.detail).toMatch(/not confirmed back/);
});

test('the all-clear reaches every channel that heard the STOP — even one that ticked only STOP — past the cooldown', async () => {
  const sent: string[] = [];
  const fetch = jest.fn(async (url: string) => { sent.push(url); return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' }; });
  const n = new Notifier({ fetch: fetch as never, cooldownMs: 15 * 60_000 });
  const ch = (id: string, events: NotifyChannel['events']): NotifyChannel => ({ id, name: id, kind: 'discord', url: `https://discord.com/api/webhooks/${id}/x`, events, enabled: true });
  n.setChannels([ch('stopOnly', ['backpressure.stop']), ch('other', ['tool.errors']), ch('recoveredOnly', ['backpressure.recovered'])]);
  const stop = { type: 'backpressure.stop' as const, severity: 'warning' as const, title: 'STOP', detail: 'x', dedupeKey: 'backpressure.stop' };
  const back = { type: 'backpressure.recovered' as const, severity: 'info' as const, title: 'back', detail: 'y', clears: ['backpressure.stop' as const] };
  n.emit(stop); n.emit(back);
  await n.flush();
  expect(sent).toEqual(['https://discord.com/api/webhooks/stopOnly/x', 'https://discord.com/api/webhooks/stopOnly/x', 'https://discord.com/api/webhooks/recoveredOnly/x']);
  // A second incident inside the cooldown: its STOP is held back, so its all-clear goes only where it is subscribed (and cooled down).
  sent.length = 0;
  n.emit(stop); n.emit(back);
  await n.flush();
  expect(sent).toEqual([]);
});

test('spoken durations', () => {
  expect(spokenDuration(40_000)).toBe('40 s');
  expect(spokenDuration(72_000)).toBe('1 min 12 s');
  expect(spokenDuration(3_840_000)).toBe('1 h 4 min');
});
