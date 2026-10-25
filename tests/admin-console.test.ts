// Admin console: password hashing, runtime settings, the tool switches (read-only
// mode / disabled groups) as agents see them, and the HTTP API's auth, roles,
// CSRF and last-admin rules against an in-memory store. The real Postgres
// path (migration 0004, CLI init, browser sign-in) was verified on the local dev DB.

import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { hashPassword, verifyPassword, generatePassword, passwordProblem, hashToken, newSessionToken } from '../src/admin/passwords';
import { settingValue, setOverride, loadOverrides, coerceSetting, _resetSettings, settingDef } from '../src/admin/settings';
import { isWriteTool, toolBlockReason, toolCategoryNames } from '../src/admin/tool-gate';
import { adminHandler, applySettings, adminHealth, _resetThrottle } from '../src/admin/server';
import type { AdminStore, AdminUser, AdminRole } from '../src/admin/store';
import { cacheEnabled } from '../src/services/http-cache';
import { _setShadowRuntime } from '../src/db/shadow-runtime';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { Notifier, _setNotifier } from '../src/services/notifier';

const logger = new Logger('error');
afterEach(() => { _resetSettings(); _resetThrottle(); _setShadowRuntime(null); });

describe('passwords', () => {
  test('scrypt round-trip; wrong password and malformed hashes fail', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterY', h)).toBe(false);
    expect(await verifyPassword('x', 'plain')).toBe(false);
  });
  test('generated passwords: 4 groups of 5, no look-alike characters, and they pass the policy', () => {
    const p = generatePassword();
    expect(p).toMatch(/^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/);
    expect(p).not.toMatch(/[01OlI]/);
    expect(passwordProblem(p, 'admin')).toBeNull();
  });
  test('policy: length, username, repetition', () => {
    expect(passwordProblem('short')).toMatch(/12 characters/);
    expect(passwordProblem('my-admin-password!', 'admin')).toMatch(/username/);
    expect(passwordProblem('aaaaaaaaaaaaaaaa')).toMatch(/repetitive/);
  });
  test('session tokens are random; only a hash is stored', () => {
    const t = newSessionToken();
    expect(t).toHaveLength(43);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(newSessionToken()).not.toBe(t);
  });
});

describe('settings', () => {
  test('defaults come from the environment; a saved value overrides it', () => {
    expect(settingValue('shadow.serveReads', { MCP_PG_SHADOW_SERVE_READS: 'true' })).toBe(true);
    expect(settingValue('shadow.pauseAtPct', {})).toBe(85);
    expect(settingValue('cache.enabled', { AUTOTASK_CACHE: 'off' })).toBe(false);
    setOverride('shadow.serveReads', false);
    expect(settingValue('shadow.serveReads', { MCP_PG_SHADOW_SERVE_READS: 'true' })).toBe(false);
  });
  test('validation: types, ranges, known tool groups', () => {
    settingDef('tools.disabledCategories')!.choices = toolCategoryNames();
    expect(() => coerceSetting('shadow.pauseAtPct', 500)).toThrow(/at most 100/);
    expect(() => coerceSetting('tools.writesEnabled', 'false')).toThrow(/true or false/);
    expect(() => coerceSetting('tools.disabledCategories', ['financial', 'nope'])).toThrow(/nope/);
    expect(coerceSetting('tools.disabledCategories', ['tickets', 'financial', 'tickets'])).toEqual(['financial', 'tickets']);
    expect(() => coerceSetting('no.such', 1)).toThrow(/Unknown setting/);
  });
  test('a bad saved value is dropped on load, not fatal', () => {
    expect(loadOverrides({ 'shadow.pauseAtPct': 70, 'shadow.maxAgeSeconds': -1, 'gone.key': 1 })).toEqual(['shadow.maxAgeSeconds', 'gone.key']);
    expect(settingValue('shadow.pauseAtPct')).toBe(70);
  });
  test('the read cache follows the console switch', () => {
    expect(cacheEnabled()).toBe(true);
    setOverride('cache.enabled', false);
    expect(cacheEnabled()).toBe(false);
  });
  test('/health admin block: absent when not configured; flags a console that is configured but not running', () => {
    expect(adminHealth({})).toBeNull();
    expect(adminHealth({ MCP_ADMIN_ENABLED: 'true' })).toEqual({ enabled: true, running: false });
  });
  test('applySettings pushes values into the running shadow', () => {
    const rt: any = { serveReads: false, maxAgeSeconds: 900, syncEnabled: true, sync: { setPauseAtPct: jest.fn() } };
    _setShadowRuntime(rt);
    setOverride('shadow.serveReads', true); setOverride('shadow.syncEnabled', false); setOverride('shadow.pauseAtPct', 30); setOverride('shadow.maxAgeSeconds', 600);
    applySettings();
    expect(rt).toMatchObject({ serveReads: true, syncEnabled: false, maxAgeSeconds: 600 });
    expect(rt.sync.setPauseAtPct).toHaveBeenCalledWith(30);
  });
});

describe('tool switches', () => {
  test('write classification: name verbs catch writes with read-looking prefixes; readOnlyHint is trusted', () => {
    for (const t of ['create_ticket', 'update_ticket', 'delete_time_entry', 'find_or_create_contact', 'raw_request', 'set_ticket_contract', 'log_my_time', 'complete_company_todo']) expect(isWriteTool(`autotask_${t}`)).toBe(true);
    // delete_task only inspects (Autotask can't delete tasks via the API); get_complete_* only matches "complete".
    for (const t of ['search_tickets', 'get_ticket_details', 'report_unbilled', 'shadow_sync', 'shadow_query', 'list_queues', 'get_api_usage', 'delete_task', 'get_complete_project_context']) expect(isWriteTool(`autotask_${t}`)).toBe(false);
  });
  test('read-only mode blocks writes only; meta tools always stay on', () => {
    setOverride('tools.writesEnabled', false);
    expect(toolBlockReason('autotask_create_ticket')).toMatch(/read-only mode/);
    expect(toolBlockReason('autotask_search_tickets')).toBeNull();
    expect(toolBlockReason('autotask_execute_tool')).toBeNull();
  });
  test('a disabled group blocks its tools', () => {
    settingDef('tools.disabledCategories')!.choices = toolCategoryNames();
    setOverride('tools.disabledCategories', ['financial']);
    expect(toolBlockReason('autotask_search_contracts')).toMatch(/"financial" tool group/);
    expect(toolBlockReason('autotask_search_tickets')).toBeNull();
  });
  test('agents: hidden from tools/list, refused on call and through execute_tool', async () => {
    const cfg: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
    const h = new AutotaskToolHandler(new AutotaskService(cfg, logger), logger);
    const before = (await h.listTools()).length;
    setOverride('tools.writesEnabled', false);
    const names = (await h.listTools()).map((t) => t.name);
    expect(names).not.toContain('autotask_create_ticket');
    expect(names).toContain('autotask_search_tickets');
    expect(names.length).toBeLessThan(before);
    const direct = await h.callTool('autotask_create_ticket', { title: 'x' });
    expect(direct.isError).toBe(true);
    expect(direct.content[0]!.text).toMatch(/read-only mode/);
    const viaMeta = await h.callTool('autotask_execute_tool', { toolName: 'autotask_create_ticket', arguments: { title: 'x' } });
    expect(viaMeta.content[0]!.text).toMatch(/read-only mode/);
  });
});

// ── HTTP API against an in-memory store ────────────────────────────────────
class FakeStore {
  users: Array<AdminUser & { passwordHash: string }> = [];
  sessions = new Map<string, number>();
  settings: Record<string, unknown> = {};
  events: Array<{ action: string; actor: string | null }> = [];
  private nextId = 1;
  async countUsers() { return this.users.length; }
  async listUsers() { return this.users.map(({ passwordHash: _p, ...u }) => u); }
  async getUser(id: number) { const u = this.users.find((x) => x.id === id); if (!u) return null; const { passwordHash: _p, ...r } = u; return r; }
  async findForLogin(name: string) { return this.users.find((u) => u.username.toLowerCase() === name.toLowerCase()) ?? null; }
  async passwordHashOf(id: number) { return this.users.find((u) => u.id === id)?.passwordHash ?? null; }
  async createUser(username: string, password: string, role: AdminRole, by: string | null, mustChange = true) {
    const u = { id: this.nextId++, username, role, mustChangePassword: mustChange, disabled: false, createdAt: new Date().toISOString(), createdBy: by, passwordChangedAt: null, lastLoginAt: null, passwordHash: await hashPassword(password) };
    this.users.push(u);
    return (await this.getUser(u.id))!;
  }
  async setPassword(id: number, password: string, mustChange: boolean, keep?: string) {
    const u = this.users.find((x) => x.id === id)!; u.passwordHash = await hashPassword(password); u.mustChangePassword = mustChange;
    for (const [h, uid] of this.sessions) if (uid === id && h !== keep) this.sessions.delete(h);
  }
  async updateUser(id: number, patch: { role?: AdminRole; disabled?: boolean }) { const u = this.users.find((x) => x.id === id)!; Object.assign(u, patch); if (patch.disabled) await this.deleteSessionsOf(id); return this.getUser(id); }
  async deleteUser(id: number) { this.users = this.users.filter((u) => u.id !== id); return true; }
  async otherActiveAdmins(id: number) { return this.users.filter((u) => u.role === 'admin' && !u.disabled && u.id !== id).length; }
  async recordLogin() { /* no-op */ }
  async createSession(userId: number) { const token = newSessionToken(); this.sessions.set(hashToken(token), userId); return { token, tokenHash: hashToken(token) }; }
  async sessionUser(token: string) { const id = this.sessions.get(hashToken(token)); const u = id ? await this.getUser(id) : null; return u && !u.disabled ? { user: u, tokenHash: hashToken(token) } : null; }
  async deleteSession(h: string) { this.sessions.delete(h); }
  async deleteSessionsOf(id: number) { for (const [h, uid] of this.sessions) if (uid === id) this.sessions.delete(h); }
  async loadSettings() { return this.settings; }
  async saveSetting(k: string, v: unknown) { this.settings[k] = v; }
  async clearSetting(k: string) { delete this.settings[k]; }
  async logEvent(actor: string | null, action: string) { this.events.push({ actor, action }); }
  async listEvents() { return []; }
}

describe('admin HTTP API', () => {
  let server: Server, base: string, store: FakeStore;
  beforeEach(async () => {
    store = new FakeStore();
    await store.createUser('admin', 'initial-temp-password', 'admin', 'cli', true);
    const handler = adminHandler({ store: store as unknown as AdminStore, pool: null, startedAt: Date.now(),
      opts: { logger, service: {} as any, version: 't', env: { MCP_ADMIN_UI_DIR: resolve(__dirname, '..', 'admin-ui') } } });
    server = createServer((q, r) => { void handler(q, r); });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

  const call = async (method: string, path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { 'X-Atmcp': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) as any, cookie: r.headers.get('set-cookie') };
  };
  const login = async (u: string, p: string) => { const r = await call('POST', '/api/login', { username: u, password: p }); return { ...r, jar: r.cookie?.split(';')[0] }; };

  test('serves the UI with a strict CSP', async () => {
    const r = await fetch(base + '/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
    expect(await r.text()).toMatch(/<script src="\/app.js\?v=t"/); // versioned per release (opts.version 't')
  });

  test('CSRF: state changes need the custom header and a same-host Origin', async () => {
    const noHeader = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(noHeader.status).toBe(403);
    expect((await call('POST', '/api/login', {}, undefined, { Origin: 'https://evil.example' })).status).toBe(403);
  });

  test('first sign-in forces a password change; then the viewer/admin split holds', async () => {
    const a = await login('admin', 'initial-temp-password');
    expect(a.status).toBe(200);
    expect(a.cookie).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await call('GET', '/api/status', undefined, a.jar)).body.code).toBe('password_change_required');
    expect((await call('POST', '/api/me/password', { currentPassword: 'initial-temp-password', newPassword: 'short' }, a.jar)).status).toBe(400);
    expect((await call('POST', '/api/me/password', { currentPassword: 'initial-temp-password', newPassword: 'a-much-better-passphrase' }, a.jar)).status).toBe(200);

    const created = await call('POST', '/api/users', { username: 'viewer1', role: 'viewer' }, a.jar);
    expect(created.status).toBe(201);
    expect(passwordProblem(created.body.password)).toBeNull();
    const v = await login('viewer1', created.body.password);
    await call('POST', '/api/me/password', { currentPassword: created.body.password, newPassword: 'viewer-passphrase-ok' }, v.jar);
    expect((await call('GET', '/api/settings', undefined, v.jar)).status).toBe(200);
    expect((await call('PUT', '/api/settings/tools.writesEnabled', { value: false }, v.jar)).status).toBe(403);
    expect((await call('GET', '/api/users', undefined, v.jar)).status).toBe(403);

    const put = await call('PUT', '/api/settings/tools.writesEnabled', { value: false }, a.jar);
    expect(put.status).toBe(200);
    expect(store.settings['tools.writesEnabled']).toBe(false);
    expect(settingValue('tools.writesEnabled')).toBe(false);
    expect((await call('PUT', '/api/settings/tools.writesEnabled', { reset: true }, a.jar)).status).toBe(200);
    expect(settingValue('tools.writesEnabled')).toBe(true);
    expect(store.events.map((e) => e.action)).toEqual(expect.arrayContaining(['login', 'password.changed', 'user.created', 'setting.changed', 'setting.reset']));
  });

  test('never lose the last admin; disabling signs a user out', async () => {
    const a = await login('admin', 'initial-temp-password');
    await call('POST', '/api/me/password', { currentPassword: 'initial-temp-password', newPassword: 'a-much-better-passphrase' }, a.jar);
    expect((await call('PATCH', '/api/users/1', { role: 'viewer' }, a.jar)).body.code).toBe('last_admin');
    expect((await call('DELETE', '/api/users/1', undefined, a.jar)).body.code).toBe('self');
    const v = await call('POST', '/api/users', { username: 'v2', role: 'viewer' }, a.jar);
    const vs = await login('v2', v.body.password);
    expect((await call('PATCH', `/api/users/${v.body.user.id}`, { disabled: true }, a.jar)).status).toBe(200);
    expect((await call('GET', '/api/me', undefined, vs.jar)).status).toBe(401);
  });

  test('notifications: admins add / test / change / delete channels; the URL never reaches the browser or the logs', async () => {
    const sent: Array<{ url: string; body: string }> = [];
    _setNotifier(new Notifier({ fetch: (async (url: string, init: { body: string }) => { sent.push({ url, body: init.body }); return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' }; }) as never }));
    try {
      const a = await login('admin', 'initial-temp-password');
      await call('POST', '/api/me/password', { currentPassword: 'initial-temp-password', newPassword: 'a-much-better-passphrase' }, a.jar);
      const URL_ = 'https://discord.com/api/webhooks/123456789/very-secret-token';
      expect((await call('POST', '/api/notifications', { name: 'Ops', kind: 'discord', url: 'https://evil.example/x', events: ['auth.held'] }, a.jar)).body.code).toBe('invalid');
      const add = await call('POST', '/api/notifications', { name: 'Ops', kind: 'discord', url: URL_, events: ['auth.held', 'operation.partial'] }, a.jar);
      expect(add.status).toBe(200);
      expect(store.settings['notify.channels']).toEqual([expect.objectContaining({ name: 'Ops', url: URL_ })]);

      const list = await call('GET', '/api/notifications', undefined, a.jar);
      expect(JSON.stringify(list.body)).not.toContain('very-secret-token');
      expect(list.body.channels[0]).toMatchObject({ name: 'Ops', kind: 'discord', events: ['auth.held', 'operation.partial'], enabled: true });
      expect(list.body.events.length).toBeGreaterThan(5);
      expect(JSON.stringify((await call('GET', '/api/settings', undefined, a.jar)).body)).not.toContain('very-secret-token');

      const test = await call('POST', `/api/notifications/${add.body.id}/test`, {}, a.jar);
      expect(test.body).toMatchObject({ ok: true });
      expect(sent[0]!.url).toBe(URL_);
      expect(JSON.parse(sent[0]!.body).embeds[0].title).toMatch(/Test notification/);

      expect((await call('PUT', `/api/notifications/${add.body.id}`, { events: ['tool.errors'], enabled: false }, a.jar)).status).toBe(200);
      expect((store.settings['notify.channels'] as unknown[])[0]).toMatchObject({ url: URL_, events: ['tool.errors'], enabled: false }); // URL kept when not resent
      expect((await call('DELETE', `/api/notifications/${add.body.id}`, undefined, a.jar)).status).toBe(200);
      expect(store.settings['notify.channels']).toEqual([]);
      expect(store.events.map((e) => e.action)).toEqual(expect.arrayContaining(['notify.channel_added', 'notify.channel_tested', 'notify.channel_changed', 'notify.channel_removed']));

      const v = await call('POST', '/api/users', { username: 'v3', role: 'viewer' }, a.jar);
      const vs = await login('v3', v.body.password);
      await call('POST', '/api/me/password', { currentPassword: v.body.password, newPassword: 'viewer-passphrase-ok' }, vs.jar);
      expect((await call('GET', '/api/notifications', undefined, vs.jar)).status).toBe(200);
      expect((await call('POST', '/api/notifications', { name: 'x', kind: 'discord', url: URL_, events: [] }, vs.jar)).status).toBe(403);
    } finally { _setNotifier(null); }
  });

  test('failed sign-ins are throttled per username', async () => {
    for (let i = 0; i < 6; i++) expect((await login('admin', 'wrong-password-123')).status).toBe(401);
    expect((await login('admin', 'initial-temp-password')).status).toBe(429);
  });

  test('cookie is Secure (__Host-) behind an HTTPS proxy', async () => {
    const r = await call('POST', '/api/login', { username: 'admin', password: 'initial-temp-password' }, undefined, { 'X-Forwarded-Proto': 'https' });
    expect(r.cookie).toMatch(/^__Host-atmcp_session=.*; Secure$/);
  });
});

describe('read-source report', () => {
  test('flags heavy, mostly-uncached, unmirrored entities as candidates; mirrored ones never', async () => {
    const { runToolCall, startApiCall, _resetCallLog } = await import('../src/services/call-log');
    const { readSourceReport } = await import('../src/admin/server');
    _resetCallLog();
    await runToolCall('autotask_search_opportunities', async () => { for (let i = 0; i < 60; i++) startApiCall('POST', '/Opportunities/query')(200); return {}; });
    await runToolCall('autotask_search_tickets', async () => { for (let i = 0; i < 60; i++) startApiCall('POST', '/Tickets/query')(200); return {}; });
    const r = readSourceReport(24) as { entities: Array<{ entity: string; candidate: boolean; mirrored: boolean; cacheClass: string }> };
    expect(r.entities.find((e) => e.entity === 'Opportunities')).toMatchObject({ candidate: true, mirrored: false, cacheClass: 'volatile' });
    expect(r.entities.find((e) => e.entity === 'Tickets')).toMatchObject({ candidate: false, mirrored: true });
  });
});
