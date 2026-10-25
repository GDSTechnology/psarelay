// Setup check: live read probes per entity (never the mirror), per-module status, connection details.

import { MODULES, classifyProbeError, connectionGuide, moduleResults, probeEntities } from '../src/setup/check';
import { mcpUrl, runSetupCheck, setupSummary } from '../src/setup/run';

describe('probe errors', () => {
  test('permission → denied; 404 → unavailable; 401 / 429 stop the run', () => {
    expect(classifyProbeError(Object.assign(new Error('HTTP 403: you do not have permission'), { status: 403 }))).toMatchObject({ outcome: 'denied' });
    expect(classifyProbeError(new Error('The security level of this resource does not allow access'))).toMatchObject({ outcome: 'denied' });
    expect(classifyProbeError(Object.assign(new Error('not found'), { status: 404 }))).toMatchObject({ outcome: 'unavailable' });
    expect(classifyProbeError(Object.assign(new Error('HTTP 401'), { status: 401 }))).toMatchObject({ outcome: 'error', stop: true });
    expect(classifyProbeError(new Error('Autotask API threshold exceeded (HTTP 429)'))).toMatchObject({ stop: true });
  });
});

describe('probing and module results', () => {
  test('each entity once; a denied entity blocks every module that reads it; writes are listed', async () => {
    const asked: string[] = [];
    const { probes, stopped } = await probeEntities(async (e) => { asked.push(e); if (e === 'Invoices') throw Object.assign(new Error('HTTP 403 permission'), { status: 403 }); });
    expect(stopped).toBeUndefined();
    expect(asked.length).toBe(new Set(asked).size); // Companies etc. are needed by several modules but probed once
    const res = Object.fromEntries(moduleResults(probes).map((m) => [m.id, m]));
    expect(res.billing).toMatchObject({ status: 'blocked', denied: [{ entity: 'Invoices' }] });
    expect(res.commerce!.status).toBe('blocked');
    expect(res.core!.status).toBe('ready');
    expect(res.core!.writes).toEqual(expect.arrayContaining([{ entity: 'Tickets', ops: ['create', 'update'], why: 'search, create and update tickets' }]));
    expect(res.cleanup!.writes.map((w) => w.entity)).toEqual(['Companies', 'Contacts']);
  });
  test('a login problem stops probing at once; the rest is "not checked"', async () => {
    let n = 0;
    const { probes, stopped } = await probeEntities(async () => { n++; if (n === 2) throw Object.assign(new Error('HTTP 401'), { status: 401 }); });
    expect(stopped).toMatch(/login rejected/);
    expect(probes.size).toBe(2);
    expect(moduleResults(probes).find((m) => m.id === 'core')!.status).toBe('unknown');
  });
});

describe('the full check', () => {
  const fakeService = (o: { failLogin?: boolean; deny?: string[] } = {}) => {
    const calls: Array<{ entity: string; opts: Record<string, unknown> }> = [];
    const http = { query: async (entity: string, _f: unknown, opts: Record<string, unknown>) => { calls.push({ entity, opts }); if (o.deny?.includes(entity)) throw Object.assign(new Error('permission denied'), { status: 403 }); return [{ id: 1 }]; }, get: async () => ({ firstName: 'PSArelay', lastName: 'API' }) };
    const s = {
      httpClient: async () => http,
      getApiUsage: async () => (o.failLogin ? { server: {}, autotask: { error: 'login rejected (401)' } } : { server: {}, autotask: { used: 1500, limit: 10000, windowMinutes: 60, usedPct: 15 } }),
      resolveApiUserResourceId: async () => 4242,
      getRecordWebUrl: () => 'https://autotask.example/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenAccount&AccountID=0',
    };
    return { s: s as never, calls };
  };
  test('connected: names the API user, probes live (noCache) — never the mirror — and summarises', async () => {
    const { s, calls } = fakeService({ deny: ['Products'] });
    const r = await runSetupCheck(s);
    expect(r.connection).toMatchObject({ ok: true, apiUser: { id: 4242, name: 'PSArelay API' }, usage: { usedPct: 15 } });
    expect(calls.every((c) => c.opts.noCache === true && c.opts.maxRecords === 1)).toBe(true);
    expect(r.modules.find((m) => m.id === 'vendor')!.status).toBe('blocked');
    expect(setupSummary(r)).toMatch(/Connected as PSArelay API.*BLOCKED \(no read access\): Vendor billing reconciliation/);
  });
  test('not connected: says why and probes nothing', async () => {
    const { s, calls } = fakeService({ failLogin: true });
    const r = await runSetupCheck(s);
    expect(r.connection).toMatchObject({ ok: false, detail: expect.stringMatching(/login rejected/) });
    expect(calls).toHaveLength(0);
    expect(setupSummary(r)).toMatch(/^Not connected/);
  });
  test('the MCP endpoint and client instructions', () => {
    expect(mcpUrl({ MCP_PUBLIC_URL: 'https://mcp.example.com/' })).toBe('https://mcp.example.com/mcp');
    expect(mcpUrl({ MCP_PUBLIC_URL: 'https://mcp.example.com/mcp' })).toBe('https://mcp.example.com/mcp');
    expect(mcpUrl({ MCP_HTTP_PORT: '9000' })).toBe('http://<this-host>:9000/mcp');
    expect(connectionGuide('https://x/mcp').map((c) => c.client)).toEqual(['ChatGPT', 'Claude Code', 'Claude Desktop / claude.ai', 'n8n']);
    expect(MODULES.map((m) => m.id)).toEqual(['core', 'contracts', 'billing', 'vendor', 'cleanup', 'commerce']);
  });
});
