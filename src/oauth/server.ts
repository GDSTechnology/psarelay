// Sign-in for AI clients: an OAuth 2.1 authorization server inside the instance (MCP authorization spec 2025-06-18).
//
//   /.well-known/oauth-protected-resource   RFC 9728 — which authorization server protects /mcp
//   /.well-known/oauth-authorization-server RFC 8414 — the endpoints below
//   POST /oauth/register                     RFC 7591 — dynamic client registration (ChatGPT, Claude, Codex do this)
//   GET|POST /oauth/authorize                the person signs in with their console login and approves the client
//   POST /oauth/token                        code (+ PKCE S256) → access token; refresh tokens rotate
//
// Zero trust: only a console user LINKED to an Autotask resource can approve, so the access token is a person token
// — writes run as them and Autotask applies their own security level. Access tokens live 1 hour and are bound to
// this server's MCP URL (audience). Codes are single-use (2 min); a reused refresh token revokes the whole sign-in.
// Needs MCP_PUBLIC_URL on https (the address the AI clients use) and the Postgres layer.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { AdminStore } from '../admin/store.js';
import { dummyPasswordHash, validUsername, verifyPassword } from '../admin/passwords.js';
import { clearLoginFailures, loginThrottled, noteLoginFailure } from '../admin/server.js';
import { tokenStore } from '../security/tokens.js';
import { OAuthStore, randomToken } from './store.js';
import type { Logger } from '../utils/logger.js';

export const ACCESS_TOKEN_SECONDS = 3600;
export const REFRESH_TOKEN_DAYS = 30;

/** The public MCP URL and its origin, or null when sign-in can't be offered (no https MCP_PUBLIC_URL). */
export function oauthBase(env: NodeJS.ProcessEnv = process.env): { origin: string; resource: string } | null {
  const raw = String(env.MCP_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const resource = /\/mcp$/.test(u.pathname) ? `${u.origin}${u.pathname}` : `${u.origin}${u.pathname.replace(/\/$/, '')}/mcp`;
  return { origin: u.origin, resource };
}
export const resourceMetadataUrl = (b: { origin: string }) => `${b.origin}/.well-known/oauth-protected-resource`;

/** Redirect URIs a client may register: https, or a loopback address (native apps like Codex). Never fragments. */
export function redirectUriOk(u: string): boolean {
  let x: URL;
  try { x = new URL(u); } catch { return false; }
  if (x.hash) return false;
  if (x.protocol === 'https:') return true;
  return x.protocol === 'http:' && (x.hostname === '127.0.0.1' || x.hostname === 'localhost' || x.hostname === '[::1]');
}
/** PKCE S256: base64url(sha256(verifier)) === challenge, compared in constant time. */
export function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash('sha256').update(verifier).digest('base64url')), b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
const sameResource = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
};
function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...extra });
  res.end(JSON.stringify(body));
}
const oauthError = (res: ServerResponse, status: number, error: string, description: string) => json(res, status, { error, error_description: description });
async function body(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > limit) throw new Error('too large'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function page(res: ServerResponse, status: number, title: string, inner: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · PSArelay</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e7e9ee}
@media (prefers-color-scheme:light){body{background:#f4f5f7;color:#16181d}.card{background:#fff!important;border-color:#dfe2e8!important}input{background:#fff!important;color:#16181d!important}}
.card{width:min(420px,calc(100vw - 32px));background:#171a21;border:1px solid #2a2f3a;border-radius:12px;padding:28px}h1{font-size:20px;margin:0 0 6px}
p{margin:8px 0}.muted{opacity:.75;font-size:13px}label{display:block;font-size:13px;margin:14px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #3a4150;background:#0f1115;color:#e7e9ee;font-size:15px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:15px;font-weight:600;cursor:pointer}.err{color:#f87171}.host{font-family:ui-monospace,monospace}</style></head>
<body><main class="card"><p class="muted">PSArelay</p>${inner}</main></body></html>`);
}

export interface OAuthDeps { pool: Pool | null; logger: Logger; env?: NodeJS.ProcessEnv }
const clientIp = (req: IncomingMessage) => String(req.headers['cf-connecting-ip'] ?? (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0] ?? req.socket.remoteAddress ?? '').trim();

/** Handle the sign-in endpoints; false when the path is not one of them. */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL, deps: OAuthDeps): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/.well-known/oauth-') && !p.startsWith('/oauth/')) return false;
  const base = oauthBase(deps.env);
  const store = deps.pool ? new OAuthStore(deps.pool) : null;
  if (!base || !store) { json(res, 404, { error: 'not_available', error_description: 'Sign-in needs MCP_PUBLIC_URL (https) and the Postgres layer on this server.' }); return true; }

  // ── discovery ──
  if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') {
    json(res, 200, { resource: base.resource, authorization_servers: [base.origin], bearer_methods_supported: ['header'], scopes_supported: ['mcp'], resource_name: 'PSArelay' });
    return true;
  }
  if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/oauth-authorization-server/mcp') {
    json(res, 200, {
      issuer: base.origin, authorization_endpoint: `${base.origin}/oauth/authorize`, token_endpoint: `${base.origin}/oauth/token`, registration_endpoint: `${base.origin}/oauth/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
    });
    return true;
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); res.end(); return true; }

  // ── dynamic client registration ──
  if (p === '/oauth/register' && req.method === 'POST') {
    const ip = clientIp(req);
    if (await store.recentRegistrations(ip) >= 20) { oauthError(res, 429, 'too_many_requests', 'Too many client registrations from this address — try again in an hour.'); return true; }
    let b: Record<string, unknown>;
    try { b = JSON.parse(await body(req)); } catch { oauthError(res, 400, 'invalid_client_metadata', 'Send the registration as JSON.'); return true; }
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10 || !uris.every(redirectUriOk)) { oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be 1–10 https URLs (or loopback http for apps on this computer).'); return true; }
    const name = String(b.client_name ?? 'AI client').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'AI client';
    const c = await store.registerClient(name, uris, ip);
    deps.logger.info(`OAuth client registered: ${name} (${c.clientId}) → ${uris.map((u) => new URL(u).host).join(', ')}`);
    json(res, 201, { client_id: c.clientId, client_name: c.clientName, redirect_uris: c.redirectUris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(Date.parse(c.createdAt) / 1000) });
    return true;
  }

  // ── sign in and approve ──
  if (p === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
    const q = req.method === 'POST' ? new URLSearchParams(await body(req)) : url.searchParams;
    const clientId = q.get('client_id') ?? '', redirectUri = q.get('redirect_uri') ?? '', state = q.get('state') ?? '';
    const client = clientId ? await store.getClient(clientId) : null;
    // Never redirect to an unregistered address: errors before this point are shown here, not sent back.
    if (!client) { page(res, 400, 'Unknown client', '<h1>Unknown client</h1><p>This sign-in link is not from a registered client. Start again from your AI client.</p>'); return true; }
    if (!client.redirectUris.includes(redirectUri)) { page(res, 400, 'Wrong return address', '<h1>Wrong return address</h1><p>The client asked to return to an address it did not register. Nothing was sent.</p>'); return true; }
    const back = (params: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries({ ...params, ...(state ? { state } : {}), iss: base.origin })) u.searchParams.set(k, v);
      res.writeHead(302, { Location: u.toString(), ...SECURITY }); res.end();
    };
    if (q.get('response_type') !== 'code') { back({ error: 'unsupported_response_type', error_description: 'Only response_type=code.' }); return true; }
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) { back({ error: 'invalid_request', error_description: 'PKCE with S256 is required.' }); return true; }
    const resource = q.get('resource') || base.resource;
    if (!sameResource(resource, base.resource)) { back({ error: 'invalid_target', error_description: `This server issues tokens only for ${base.resource}.` }); return true; }

    const host = esc(new URL(redirectUri).host);
    const hidden = ['client_id', 'redirect_uri', 'state', 'response_type', 'code_challenge', 'code_challenge_method', 'resource', 'scope']
      .map((k) => (q.get(k) != null ? `<input type="hidden" name="${k}" value="${esc(q.get(k)!)}">` : '')).join('');
    const form = (err = '', username = '') => page(res, err ? 401 : 200, 'Sign in', `<h1>Connect ${esc(client.clientName)}</h1>
<p>Sign in with your PSArelay console login to let <strong>${esc(client.clientName)}</strong> use Autotask through PSArelay <strong>as you</strong> — with your own Autotask permissions.</p>
<p class="muted">After signing in you are sent back to <span class="host">${host}</span>. Only continue if that is the AI client you are connecting.</p>
${err ? `<p class="err">${esc(err)}</p>` : ''}
<form method="post" action="/oauth/authorize">${hidden}<label for="u">Username</label><input id="u" name="username" autocomplete="username" required value="${esc(username)}">
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in and allow</button></form>
<p class="muted">You can disconnect it any time: console → Account → Connect your AI.</p>`);
    if (req.method === 'GET') { form(); return true; }

    const username = (q.get('username') ?? '').trim(), password = q.get('password') ?? '';
    const ip = clientIp(req);
    const wait = loginThrottled(ip, username);
    if (wait) { form(`Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minute(s).`, username); return true; }
    const admin = new AdminStore(deps.pool!);
    const u = validUsername(username) ? await admin.findForLogin(username) : null;
    const ok = await verifyPassword(password, u?.passwordHash ?? await dummyPasswordHash());
    if (!u || !ok || u.disabled) { noteLoginFailure(ip, username); void admin.logEvent(username || null, 'login.failed', { reason: 'oauth sign-in', client: client.clientName }, ip).catch(() => undefined); form('Wrong username or password.', username); return true; }
    clearLoginFailures(username);
    if (u.mustChangePassword) { form('Set your own password in the PSArelay console first (your current one is temporary), then connect again.', username); return true; }
    const full = await admin.getUser(u.id);
    if (full?.autotaskResourceId == null) { form('Your login is not linked to an Autotask user yet — ask an administrator to link it (console → Users), then connect again.', username); return true; }
    const code = await store.createCode({ clientId: client.clientId, userId: u.id, redirectUri, codeChallenge: challenge, resource: base.resource });
    void admin.logEvent(u.username, 'oauth.approved', { client: client.clientName, clientId: client.clientId, redirectHost: new URL(redirectUri).host }, ip).catch(() => undefined);
    back({ code });
    return true;
  }

  // ── tokens ──
  if (p === '/oauth/token' && req.method === 'POST') {
    let q: URLSearchParams;
    try { const raw = await body(req); q = (req.headers['content-type'] ?? '').includes('application/json') ? new URLSearchParams(JSON.parse(raw)) : new URLSearchParams(raw); }
    catch { oauthError(res, 400, 'invalid_request', 'Malformed token request.'); return true; }
    const clientId = q.get('client_id') ?? '';
    const client = clientId ? await store.getClient(clientId) : null;
    if (!client) { oauthError(res, 401, 'invalid_client', 'Unknown client.'); return true; }
    const resource = q.get('resource');
    if (resource && !sameResource(resource, base.resource)) { oauthError(res, 400, 'invalid_target', `Tokens are issued only for ${base.resource}.`); return true; }
    const admin = new AdminStore(deps.pool!);
    const tokens = tokenStore(deps.pool)!;

    const issue = async (userId: number, family: string) => {
      const u = await admin.getUser(userId);
      if (!u || u.disabled || u.autotaskResourceId == null) return null;
      const access = await tokens.create({ name: `${client.clientName} (sign-in)`, resourceId: u.autotaskResourceId, ownerUserId: u.id, by: u.username,
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_SECONDS * 1000).toISOString(), oauthClientId: client.clientId, audience: base.resource, oauthFamily: family });
      const refresh = await store.createRefresh({ family, clientId: client.clientId, userId: u.id, resource: base.resource, days: REFRESH_TOKEN_DAYS });
      void store.touchClient(client.clientId).catch(() => undefined);
      return { access_token: access.token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh, scope: 'mcp' };
    };

    if (q.get('grant_type') === 'authorization_code') {
      const code = await store.redeemCode(q.get('code') ?? '');
      if (!code || code.clientId !== client.clientId) { oauthError(res, 400, 'invalid_grant', 'The code is unknown, used or expired.'); return true; }
      if (code.redirectUri !== (q.get('redirect_uri') ?? '')) { oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request.'); return true; }
      if (!pkceOk(q.get('code_verifier') ?? '', code.codeChallenge)) { oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.'); return true; }
      const out = await issue(code.userId, randomToken(16));
      if (!out) { oauthError(res, 400, 'invalid_grant', 'The person is disabled or no longer linked to an Autotask user.'); return true; }
      json(res, 200, out);
      return true;
    }
    if (q.get('grant_type') === 'refresh_token') {
      const t = q.get('refresh_token') ?? '';
      const row = await store.findRefresh(t);
      if (!row || row.clientId !== client.clientId) { oauthError(res, 400, 'invalid_grant', 'Unknown refresh token.'); return true; }
      if (row.used || row.revoked) {
        // A refresh token used twice means it leaked: end the whole sign-in.
        await store.revokeFamily(row.family, 'refresh-token reuse');
        tokens.clearCache();
        deps.logger.warn(`OAuth refresh token reused for ${client.clientName} — sign-in revoked`);
        oauthError(res, 400, 'invalid_grant', 'This refresh token was already used; the connection was revoked for safety. Connect again.');
        return true;
      }
      if (row.expired || !(await store.markRefreshUsed(t))) { oauthError(res, 400, 'invalid_grant', 'The refresh token has expired. Connect again.'); return true; }
      const out = await issue(row.userId, row.family);
      if (!out) { oauthError(res, 400, 'invalid_grant', 'The person is disabled or no longer linked to an Autotask user.'); return true; }
      json(res, 200, out);
      return true;
    }
    oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    return true;
  }

  json(res, 404, { error: 'not_found' });
  return true;
}
