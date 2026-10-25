// Zero trust: access tokens, who a call runs as, CORS, the public health check, and the security posture.

import type { IncomingMessage } from 'node:http';
import { TokenStore, bearerToken, hashToken, newToken, tokenShapeOk, _resetTokenStore } from '../src/security/tokens';
import { allowedOrigin, corsOrigins, isExternalRequest, isPrivateAddress } from '../src/security/http';
import { securityPosture } from '../src/security/posture';
import { runWithRequestContext, getImpersonationResourceId } from '../src/utils/request-context';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { PsarelayServer } from '../src/mcp/server';
import { Logger } from '../src/utils/logger';
import { _resetSettings } from '../src/admin/settings';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const ENVS = ['AUTOTASK_IMPERSONATION_MODE', 'MCP_TRUST_UNVERIFIED_IDENTITY', 'MCP_REQUIRE_TOKEN', 'MCP_CORS_ORIGINS', 'MCP_PG_ENABLED', 'MCP_RAW_ALLOW_DELETE'];
afterEach(() => { jest.restoreAllMocks(); for (const k of ENVS) delete process.env[k]; _resetSettings(); _resetTokenStore(); });

/** A pool that answers the token store's queries from an array. */
function fakePool() {
  const rows: Record<string, any>[] = [];
  let id = 0;
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    if (sql.startsWith('INSERT INTO mcp_token')) {
      const r: Record<string, any> = { id: ++id, name: p[0], token_hash: p[1], token_prefix: p[2], resource_id: p[3], delegate: p[4], created_by: p[5], expires_at: p[6], owner_user_id: p[7], created_at: new Date(), last_used_at: null, revoked_at: null, revoked_by: null };
      // the owner join (admin_user) is simulated on the row itself
      if (r.owner_user_id != null) { r.owner_disabled = false; r.owner_resource_id = r.resource_id; }
      rows.push(r); return { rows: [r], rowCount: 1 };
    }
    if (sql.includes('t.token_hash = $1')) {
      return { rows: rows.filter((r) => r.token_hash === p[0] && !r.revoked_at && (!r.expires_at || Date.parse(r.expires_at) > Date.now())), rowCount: 1 };
    }
    if (sql.startsWith('UPDATE mcp_token SET revoked_at')) {
      const r = rows.find((x) => x.id === p[0] && !x.revoked_at); if (r) { r.revoked_at = new Date(); r.revoked_by = p[1]; }
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as any, rows, query };
}

describe('access tokens', () => {
  test('random, recognisable, stored only as a hash', async () => {
    const a = newToken(), b = newToken();
    expect(a).not.toBe(b);
    expect(tokenShapeOk(a)).toBe(true);
    expect(tokenShapeOk('psr_short')).toBe(false);
    const { pool, rows } = fakePool();
    const { token, item } = await new TokenStore(pool).create({ name: 'n8n', by: 'admin' });
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(item.prefix).toBe(token.slice(0, 10));
  });
  test('verify: valid → its identity; unknown, malformed or revoked → null (revoke applies at once)', async () => {
    const { pool } = fakePool();
    const s = new TokenStore(pool);
    const { token, item } = await s.create({ name: 'Jane', resourceId: 42, by: 'admin' });
    expect(await s.verify(token)).toEqual({ tokenId: item.id, tokenName: 'Jane', resourceId: 42, delegate: false, audience: null });
    expect(await s.verify(newToken())).toBeNull();
    expect(await s.verify('not-a-token')).toBeNull();
    await s.revoke(item.id, 'admin');
    expect(await s.verify(token)).toBeNull();
  });
  test('a self-service token stops when its owner is disabled or linked to another Autotask user', async () => {
    const { pool, rows } = fakePool();
    const s = new TokenStore(pool);
    const a = await s.create({ name: 'mine', resourceId: 42, ownerUserId: 5, by: 'jane' });
    expect(await s.verify(a.token)).toMatchObject({ resourceId: 42 });
    rows[0]!.owner_resource_id = 43; s.clearCache();
    expect(await s.verify(a.token)).toBeNull();
    rows[0]!.owner_resource_id = 42; rows[0]!.owner_disabled = true; s.clearCache();
    expect(await s.verify(a.token)).toBeNull();
  });
  test('expired tokens are refused', async () => {
    const { pool } = fakePool();
    const s = new TokenStore(pool);
    const { token } = await s.create({ name: 'old', expiresAt: new Date(Date.now() - 1000).toISOString(), by: 'admin' });
    expect(await s.verify(token)).toBeNull();
  });
  test('bearer header parsing', () => {
    expect(bearerToken('Bearer psr_abc')).toBe('psr_abc');
    expect(bearerToken('bearer   psr_abc  ')).toBe('psr_abc');
    expect(bearerToken('Basic xyz')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('network exposure', () => {
  const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers } as unknown as IncomingMessage);
  test('private vs public addresses', () => {
    for (const a of ['10.0.0.1', '172.18.0.5', '192.168.1.9', '127.0.0.1', '::1', '::ffff:172.20.0.3', 'fd00::1']) expect(isPrivateAddress(a)).toBe(true);
    for (const a of ['203.0.113.9', '172.32.0.1', '8.8.8.8', '2001:db8::1']) expect(isPrivateAddress(a)).toBe(false);
  });
  test('a request relayed by a tunnel or proxy is external even from a private relay', () => {
    expect(isExternalRequest(req('172.18.0.9'))).toBe(false);
    expect(isExternalRequest(req('172.18.0.9', { 'cf-connecting-ip': '203.0.113.9' }))).toBe(true);
    expect(isExternalRequest(req('172.18.0.9', { 'x-forwarded-for': '203.0.113.9' }))).toBe(true);
    expect(isExternalRequest(req('203.0.113.9'))).toBe(true);
  });
  test('CORS: known AI clients by default, never *, configurable, "none" switches it off', () => {
    expect(allowedOrigin('https://claude.ai')).toBe('https://claude.ai');
    expect(allowedOrigin('https://evil.example')).toBeNull();
    process.env.MCP_CORS_ORIGINS = 'https://inspector.example/';
    expect(allowedOrigin('https://inspector.example')).toBe('https://inspector.example');
    expect(allowedOrigin('https://claude.ai')).toBeNull();
    process.env.MCP_CORS_ORIGINS = 'none';
    expect(corsOrigins()).toEqual([]);
  });
});

describe('who a call runs as', () => {
  const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
  const setup = () => {
    process.env.AUTOTASK_IMPERSONATION_MODE = 'caller';
    const service = new AutotaskService(config, logger);
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue({});
    const handler = new AutotaskToolHandler(service, logger);
    const resolve = jest.spyOn(handler as any, 'resolveCaller').mockResolvedValue({ status: 'resolved', resource: { id: 7, name: 'Claimed' } });
    const seen: Array<number | undefined> = [];
    jest.spyOn(service, 'createTicket').mockImplementation(async () => { seen.push(getImpersonationResourceId()); return 1; });
    const call = (auth?: { resourceId: number | null; delegate: boolean }) => {
      const run = () => handler.callTool('autotask_create_ticket', { companyID: 1, title: 'T', description: 'D', _context: { source: 'chatgpt', requestingUserEmail: 'ceo@example.com' } });
      return auth ? runWithRequestContext({ auth: { tokenId: 1, tokenName: 'x', ...auth } }, run) : run();
    };
    return { call, seen, resolve };
  };
  test('no token: a declared email never picks who writes (runs as the API user)', async () => {
    const { call, seen, resolve } = setup();
    await call();
    expect(resolve).not.toHaveBeenCalled();
    expect(seen).toEqual([undefined]);
  });
  test('explicit opt-in restores the old trust in declared emails', async () => {
    process.env.MCP_TRUST_UNVERIFIED_IDENTITY = 'true';
    const { call, seen } = setup();
    await call();
    expect(seen).toEqual([7]);
  });
  test('a token naming a person writes as that person, whatever the client claims', async () => {
    const { call, seen, resolve } = setup();
    await call({ resourceId: 42, delegate: false });
    expect(seen).toEqual([42]);
    expect(resolve).not.toHaveBeenCalled();
  });
  test('a person token writes as that person even when impersonation is off (no API-user escalation)', async () => {
    const { call, seen } = setup();
    process.env.AUTOTASK_IMPERSONATION_MODE = 'off';
    await call({ resourceId: 42, delegate: false });
    expect(seen).toEqual([42]);
  });
  test('a service token drops declared identities', async () => {
    const { call, seen, resolve } = setup();
    await call({ resourceId: null, delegate: false });
    expect(resolve).not.toHaveBeenCalled();
    expect(seen).toEqual([undefined]);
  });
  test('a delegate token vouches for the person the client names', async () => {
    const { call, seen } = setup();
    await call({ resourceId: null, delegate: true });
    expect(seen).toEqual([7]);
  });
});

describe('HTTP endpoint', () => {
  let server: PsarelayServer; let port: number;
  const start = async () => {
    port = 40000 + Math.floor(Math.random() * 1000);
    server = new PsarelayServer({ name: 'psarelay-test', version: '0' } as McpServerConfig, logger, { autotask: { username: 'api@example.com' }, server: { name: 'psarelay-test', version: '0.0.0-test' }, transport: { type: 'http', port, host: '127.0.0.1' }, logging: { level: 'error', format: 'simple' } });
    await server.start();
  };
  afterEach(async () => { await server?.stop(); });
  const init = (headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });

  test('tokens required → a call without one is refused (fails closed without Postgres)', async () => {
    process.env.MCP_REQUIRE_TOKEN = 'true';
    await start();
    const r = await init();
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error.message).toMatch(/Postgres/);
  });
  test('a presented token is checked even when tokens are optional', async () => {
    await start();
    expect((await init({ Authorization: `Bearer ${newToken()}` })).status).toBe(503);
    expect((await init()).status).toBe(200);
  });
  test('/health: full on the private network, status + version only through a tunnel', async () => {
    await start();
    const inside = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as any;
    expect(inside).toHaveProperty('mcpTransport');
    const outside = (await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } })).json()) as any;
    expect(Object.keys(outside).sort()).toEqual(['status', 'version']);
  });
});

describe('security posture', () => {
  test('an open endpoint and trusted declared identities are flagged first', () => {
    process.env.AUTOTASK_IMPERSONATION_MODE = 'caller';
    process.env.MCP_TRUST_UNVERIFIED_IDENTITY = 'true';
    const c = securityPosture({ pgEnabled: true, activeTokens: 0 });
    expect(c[0]!.status).toBe('bad');
    expect(c.filter((x) => x.status === 'bad').map((x) => x.id).sort()).toEqual(['identity', 'mcp-token']);
  });
  test('tokens required + verified identities → no exposure', () => {
    process.env.MCP_REQUIRE_TOKEN = 'true';
    const c = securityPosture({ pgEnabled: true, activeTokens: 3 });
    expect(c.some((x) => x.status === 'bad')).toBe(false);
    expect(c.find((x) => x.id === 'mcp-token')!.detail).toContain('3 active');
  });
  test('tokens required without Postgres is flagged (every call refused)', () => {
    process.env.MCP_REQUIRE_TOKEN = 'true';
    expect(securityPosture({ pgEnabled: false, activeTokens: null }).some((x) => x.id === 'mcp-token-pg')).toBe(true);
  });
});
