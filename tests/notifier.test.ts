// Outbound notifications: URL rules per service, the body each service
// expects, event subscription + cooldown, failure recording, generic HMAC.

import { createHmac } from 'node:crypto';
import { Notifier, channelUrlProblem, formatPayload, maskUrl, type NotifyChannel, type NotifyEvent } from '../src/services/notifier';

const EVT: NotifyEvent = { type: 'auth.held', severity: 'critical', title: 'Autotask login HELD', detail: 'Press Retry now @everyone', fields: { failures: '3' }, at: '2026-10-09T12:00:00.000Z' };
const ch = (o: Partial<NotifyChannel> = {}): NotifyChannel => ({ id: 'c1', name: 'Ops', kind: 'discord', url: 'https://discord.com/api/webhooks/1/abc', events: ['auth.held'], enabled: true, ...o });
const okFetch = () => jest.fn(async () => ({ ok: true, status: 204, headers: { get: () => null }, text: async () => '' }));

describe('channel URLs', () => {
  test('https + public + the right service host', () => {
    expect(channelUrlProblem('discord', 'https://discord.com/api/webhooks/1/abc')).toBeNull();
    expect(channelUrlProblem('discord', 'https://example.com/hook')).toMatch(/Discord/);
    expect(channelUrlProblem('slack', 'https://hooks.slack.com/services/T/B/X')).toBeNull();
    expect(channelUrlProblem('teams', 'https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x')).toBeNull();
    expect(channelUrlProblem('teams', 'https://gds.webhook.office.com/webhookb2/x')).toBeNull();
    expect(channelUrlProblem('generic', 'http://example.com/x')).toMatch(/https/);
    expect(channelUrlProblem('generic', 'https://10.0.0.5/x')).toMatch(/public host/);
    expect(channelUrlProblem('generic', 'https://localhost/x')).toMatch(/public host/);
    expect(channelUrlProblem('generic', 'https://u:p@example.com/x')).toMatch(/password/);
    expect(channelUrlProblem('generic', 'not a url')).toMatch(/valid URL/);
  });
  test('masked for display', () => {
    expect(maskUrl('https://discord.com/api/webhooks/123456789/secret-token-xyz')).toBe("https://discord.com/api/webhook…-xyz");
  });
});

describe('payloads', () => {
  test('Discord: embed with colour, fields, footer; mentions disabled', () => {
    const p = formatPayload('discord', EVT, 'Prod MCP') as any;
    expect(p.allowed_mentions).toEqual({ parse: [] });
    expect(p.embeds[0]).toMatchObject({ title: '🚨 Autotask login HELD', color: 0xc62828, fields: [{ name: 'failures', value: '3', inline: true }], footer: { text: 'Prod MCP · auth.held' } });
  });
  test('Teams: an Adaptive Card message (Workflows webhook format)', () => {
    const p = formatPayload('teams', EVT, 'Prod MCP') as any;
    expect(p.type).toBe('message');
    expect(p.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(p.attachments[0].content.body[0]).toMatchObject({ color: 'Attention', weight: 'Bolder' });
    expect(p.attachments[0].content.body[2]).toEqual({ type: 'FactSet', facts: [{ title: 'failures', value: '3' }] });
  });
  test('Slack: text; generic: the raw event', () => {
    expect((formatPayload('slack', EVT, 'S') as any).text).toMatch(/^🚨 \*Autotask login HELD\*\nPress Retry now/);
    expect(formatPayload('generic', EVT, 'S')).toEqual({ event: 'auth.held', severity: 'critical', title: EVT.title, detail: EVT.detail, fields: EVT.fields, at: EVT.at, server: 'S' });
  });
});

describe('Notifier', () => {
  test('sends only to enabled channels subscribed to the event; the same event is held back during the cooldown', async () => {
    const fetch = okFetch();
    const n = new Notifier({ fetch: fetch as never, cooldownMs: 60_000 });
    n.setChannels([ch(), ch({ id: 'c2', events: ['tool.errors'] }), ch({ id: 'c3', enabled: false })]);
    n.emit(EVT); n.emit(EVT);
    await n.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe('https://discord.com/api/webhooks/1/abc');
    n.emit({ ...EVT, dedupeKey: 'other' });
    await n.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(n.channelStatus('c1')).toMatchObject({ sent: 2, lastEvent: 'auth.held', failed: 0 });
  });

  test('a failed send is recorded, never thrown', async () => {
    const fetch = jest.fn(async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => 'Unknown Webhook' }));
    const log = jest.fn();
    const n = new Notifier({ fetch: fetch as never, log });
    const r = await n.send(ch(), EVT);
    expect(r).toEqual({ ok: false, status: 404, error: 'HTTP 404: Unknown Webhook' });
    expect(n.channelStatus('c1')).toMatchObject({ failed: 1, lastError: 'HTTP 404: Unknown Webhook' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/"Ops" \(discord\) failed/));
  });

  test('generic channels sign the body (X-PSArelay-Signature, plus the deprecated X-Atmcp-Signature)', async () => {
    const fetch = okFetch();
    const n = new Notifier({ fetch: fetch as never, server: 'S' });
    await n.send(ch({ kind: 'generic', url: 'https://example.com/hook', secret: 'k' }), EVT);
    const init = (fetch.mock.calls[0] as any)[1];
    expect(init.headers['X-PSArelay-Signature']).toBe(`sha256=${createHmac('sha256', 'k').update(init.body).digest('hex')}`);
    expect(init.headers['X-Atmcp-Signature']).toBe(init.headers['X-PSArelay-Signature']);
  });
});
