// Backpressure (MCP-008): the ok / slow / stop verdict from usage, login
// protection, 429 cooldown and queue depth — and the tool reading live state.

import { assessBackpressure } from '../src/services/backpressure';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const usage = (usedPct: number, ageMin = 2) => ({ usedPct, used: usedPct * 100, limit: 10_000, at: new Date(NOW - ageMin * 60_000).toISOString() });
const auth = (o: Partial<{ held: boolean; blockedUntil: string | null; probing: boolean }> = {}) => ({ tenant: 't', since: 'x', failures: 2, lastError: '401', blockedUntil: null, probing: false, held: false, ...o });

describe('assessBackpressure', () => {
  test('quiet tenant → ok, no wait', () => {
    const b = assessBackpressure({ usage: usage(20), auth: null, cooldownSeconds: 0, queued: 0, now: NOW });
    expect(b).toMatchObject({ level: 'ok', reasons: [], retryAfterSeconds: null, autotask: { latencyTier: 'none', readingAgeSeconds: 120 } });
  });
  test('usage tiers: 50% slow (+0.5 s), 75% slow (+1 s), 90% stop', () => {
    expect(assessBackpressure({ usage: usage(55), auth: null, cooldownSeconds: 0, queued: 0, now: NOW })).toMatchObject({ level: 'slow', autotask: { latencyTier: '+0.5s' } });
    expect(assessBackpressure({ usage: usage(80), auth: null, cooldownSeconds: 0, queued: 0, now: NOW })).toMatchObject({ level: 'slow', autotask: { latencyTier: '+1s' } });
    expect(assessBackpressure({ usage: usage(92), auth: null, cooldownSeconds: 0, queued: 0, now: NOW })).toMatchObject({ level: 'stop', retryAfterSeconds: 300 });
  });
  test('login paused → stop for the remaining pause; held → stop with no fixed wait', () => {
    const paused = assessBackpressure({ usage: usage(10), auth: auth({ blockedUntil: new Date(NOW + 90_000).toISOString() }), cooldownSeconds: 0, queued: 0, now: NOW });
    expect(paused).toMatchObject({ level: 'stop', retryAfterSeconds: 90 });
    const held = assessBackpressure({ usage: usage(10), auth: auth({ held: true }), cooldownSeconds: 0, queued: 0, now: NOW });
    expect(held).toMatchObject({ level: 'stop', retryAfterSeconds: null });
    expect(held.reasons[0]).toMatch(/HELD/);
    expect(held.advice).toMatch(/until the login is fixed/);
  });
  test('429 cooldown → stop for the cooldown; the longest wait wins', () => {
    expect(assessBackpressure({ usage: usage(10), auth: null, cooldownSeconds: 45, queued: 0, now: NOW })).toMatchObject({ level: 'stop', retryAfterSeconds: 45 });
    expect(assessBackpressure({ usage: usage(95), auth: null, cooldownSeconds: 45, queued: 0, now: NOW }).retryAfterSeconds).toBe(300);
  });
  test('deep queue → slow; a stale reading is flagged, not guessed', () => {
    expect(assessBackpressure({ usage: usage(10), auth: null, cooldownSeconds: 0, queued: 12, now: NOW }).level).toBe('slow');
    const stale = assessBackpressure({ usage: usage(10, 45), auth: null, cooldownSeconds: 0, queued: 0, now: NOW });
    expect(stale.level).toBe('ok');
    expect(stale.reasons.join()).toMatch(/45 min old/);
    expect(assessBackpressure({ usage: null, auth: null, cooldownSeconds: 0, queued: 0, now: NOW })).toMatchObject({ level: 'ok', autotask: { usedPct: null, readingAt: null } });
  });
});

describe('autotask_get_backpressure (tool)', () => {
  test('no Autotask call unless refresh', async () => {
    const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'bp-test@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
    const service = new AutotaskService(config, new Logger('error'));
    const usageSpy = jest.spyOn(service, 'getApiUsage').mockResolvedValue({ server: {} as never, autotask: { error: 'x' } });
    const handler = new AutotaskToolHandler(service, new Logger('error'));
    const r = JSON.parse((await handler.callTool('autotask_get_backpressure', {})).content[0]!.text as string);
    expect(r.data.level).toBe('ok');
    expect(usageSpy).not.toHaveBeenCalled();
    await handler.callTool('autotask_get_backpressure', { refresh: true });
    expect(usageSpy).toHaveBeenCalledTimes(1);
  });
});
