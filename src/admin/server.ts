// Admin console: a small web UI + JSON API on its OWN port (MCP_ADMIN_PORT,
// default 8090), separate from /mcp. Point a Cloudflare tunnel (or any reverse
// proxy) at this port only, so publishing the console never publishes the MCP
// endpoint or the webhook receiver.
//
// Requires the Postgres layer (users, sessions, settings and the change log
// live there — migration 0004). Off unless MCP_ADMIN_ENABLED=true.
//
// Security model:
//   - Local console users, scrypt-hashed; roles 'admin' and 'viewer'.
//   - Session cookie: random 256-bit token, HttpOnly, SameSite=Strict, Secure
//     behind HTTPS; only its SHA-256 is stored. 12 h idle / 7 day maximum.
//   - Every state-changing request must carry the `X-PSArelay: 1` header (a
//     cross-site page cannot set it without a CORS preflight this server never
//     approves) and, when the browser sends an Origin, it must be this host.
//   - Failed logins are throttled per IP and per username.
//   - Strict CSP: no inline script, nothing loaded from other origins.
//   - Secrets (API credentials, DB passwords, webhook secret) are never sent to
//     the browser — only whether each is set.

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Pool } from 'pg';
import { Logger } from '../utils/logger.js';
import { getPool, pgHealthCheck } from '../db/pool.js';
import { isPgEnabled, loadPgFlags } from '../db/config.js';
import { getShadowRuntime } from '../db/shadow-runtime.js';
import { lastSetupReport, mcpUrl, runSetupCheck } from '../setup/run.js';
import { MODULES } from '../setup/check.js';
import { entitlementView, lockedReason, MODULE_INFO } from '../entitlements/index.js';
import { usageSnapshot } from '../services/http-cache.js';
import { TOOL_DEFINITIONS } from '../handlers/tool.definitions.js';
import type { AutotaskService } from '../services/autotask.service.js';
import { AdminStore, AdminUser, AdminRole } from './store.js';
import { dummyPasswordHash, generatePassword, passwordProblem, validUsername, verifyPassword } from './passwords.js';
import { SETTINGS, settingDef, settingValue, isOverridden, loadOverrides, setOverride, clearOverride, coerceSetting } from './settings.js';
import { toolAllowed, toolCategoryNames, isWriteTool } from './tool-gate.js';
import { callerSummary, recentToolCalls, recentApiCalls, runJob, entityReadStats, toolGapStats, outsideTraffic, type CallQuery } from '../services/call-log.js';
import { classify, ttlMs, cacheEnabled } from '../services/http-cache.js';
import { shadowEntity } from '../db/shadow-entities.js';
import { authBlockStatus, clearAuthBlock } from '../services/autotask-http.js';
import { recentLogs } from '../utils/logger.js';
import { getNotifier, notify, NOTIFY_EVENTS, type NotifyChannel } from '../services/notifier.js';
import { GapStore, GAP_PRIORITIES, GAP_STATUSES, type GapPriority, type GapStatus } from '../gaps/store.js';
import { BulkStore, type ItemStatus } from '../bulk/store.js';
import { JOB_ACTIONS, jobAction, jobView, startPrepare, startPrepareCompanyContacts, type JobAction } from '../bulk/service.js';
import { activityProfile, DEFAULT_SCHEDULE } from '../bulk/schedule.js';
import { mirrorClassifier, teamActivityHour, teamActivityProfile } from '../bulk/activity.js';
import { hourlyActivity } from '../services/call-log.js';
import { clearTokenCache, tokenStore } from '../security/tokens.js';
import { securityPosture } from '../security/posture.js';
import { CHANNEL_KINDS, ChannelInputError, NOTIFY_SETTING_KEY, channelFromInput, channelLogDetails, channelView, parseStoredChannels } from './notifications.js';

export interface AdminConsoleOptions {
  logger: Logger;
  service: AutotaskService;
  version: string;
  apiUsername?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface AdminConsole { port: number; stop(): Promise<void> }

const boolEnv = (v: string | undefined): boolean => /^(true|1|yes|on)$/i.test(v ?? '');

export function isAdminEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return boolEnv(env.MCP_ADMIN_ENABLED); }

/** Push the effective settings into the running subsystems. */
export function applySettings(): void {
  const rt = getShadowRuntime();
  if (rt) {
    rt.serveReads = settingValue<boolean>('shadow.serveReads');
    rt.maxAgeSeconds = settingValue<number>('shadow.maxAgeSeconds');
    rt.syncEnabled = settingValue<boolean>('shadow.syncEnabled');
    rt.sync.setPauseAtPct(settingValue<number>('shadow.pauseAtPct'));
  }
}

// ── login throttling ───────────────────────────────────────────────────────
const WINDOW_MS = 15 * 60_000;
const MAX_PER_IP = 20, MAX_PER_USER = 6;
const failures = new Map<string, number[]>();
function recentFailures(key: string, now = Date.now()): number[] {
  const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list); else failures.delete(key);
  return list;
}
export function loginThrottled(ip: string, username: string): number | null {
  const a = recentFailures(`ip:${ip}`), b = recentFailures(`user:${username.toLowerCase()}`);
  const blocked = a.length >= MAX_PER_IP ? a : b.length >= MAX_PER_USER ? b : null;
  return blocked ? Math.ceil((blocked[0]! + WINDOW_MS - Date.now()) / 1000) : null;
}
function noteFailure(ip: string, username: string): void {
  const now = Date.now();
  for (const k of [`ip:${ip}`, `user:${username.toLowerCase()}`]) failures.set(k, [...recentFailures(k, now), now]);
}
function clearFailures(username: string): void { failures.delete(`user:${username.toLowerCase()}`); }
export function _resetThrottle(): void { failures.clear(); }

// ── HTTP helpers ───────────────────────────────────────────────────────────
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }

let serverVersion = '';
function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'X-PSArelay-Version': serverVersion, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function sendFile(res: ServerResponse, filename: string, type: string, body: string): void {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.end(body);
}

/** CSV with formula-injection guard (a cell starting with = + - @ is prefixed with '). */
const CSV_COLUMNS: Record<string, string[]> = {
  tools: ['id', 'at', 'tool', 'outcome', 'durationMs', 'source', 'named', 'user', 'ip', 'userAgent', 'error', 'apiCalls', 'cacheHits', 'shadowReads', 'raw'],
  api: ['id', 'at', 'method', 'path', 'status', 'durationMs', 'toolCallId', 'tool', 'job', 'error'],
  logs: ['at', 'level', 'message', 'meta'],
  gaps: ['shape', 'calls', 'errors', 'lastAt', 'lastError', 'callers', 'coveredBy'],
  entities: ['entity', 'upstream', 'cache', 'shadow', 'writes', 'localPct', 'topCallers', 'mirrored', 'servedFromShadow', 'cacheClass', 'cacheTtlSeconds', 'candidate'],
};

export function toCsv(rows: Array<Record<string, unknown>>, emptyColumns: string[] = []): string {
  // An empty export still gets its header row, so it reads as "no rows" rather than a broken file.
  if (!rows.length) return emptyColumns.length ? `${emptyColumns.join(',')}\r\n` : '';
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown): string => {
    let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request too large.');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch { throw new HttpError(400, 'Body must be a JSON object.'); }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = header(req, 'cf-connecting-ip');
    if (cf) return cf.trim();
    const xff = header(req, 'x-forwarded-for');
    if (xff) return xff.split(',')[0]!.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function isHttps(req: IncomingMessage, mode: string): boolean {
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  return header(req, 'x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
}

const COOKIE_SECURE = '__Host-psarelay_session';
const COOKIE_PLAIN = 'psarelay_session';

function readCookie(req: IncomingMessage): string | null {
  for (const part of (header(req, 'cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k === COOKIE_SECURE || k === COOKIE_PLAIN) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function sessionCookie(token: string | null, secure: boolean): string {
  const name = secure ? COOKIE_SECURE : COOKIE_PLAIN;
  const base = `${name}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return token ? base : `${base}; Max-Age=0`;
}

/** Reject cross-site state changes: custom header + same-origin Origin (when sent). */
export function csrfProblem(req: IncomingMessage): string | null {
  if (header(req, 'x-psarelay') !== '1') return 'Missing X-PSArelay header.';
  const origin = header(req, 'origin');
  if (origin && origin !== 'null') {
    const host = header(req, 'x-forwarded-host') ?? header(req, 'host');
    let originHost: string;
    try { originHost = new URL(origin).host; } catch { return 'Bad Origin.'; }
    if (!host || originHost.toLowerCase() !== host.split(',')[0]!.trim().toLowerCase()) return 'Cross-origin request refused.';
  }
  return null;
}

// ── static UI ──────────────────────────────────────────────────────────────
const STATIC: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css', '/favicon.svg': 'favicon.svg',
};
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };

export function uiDir(): string {
  // dist/admin/server.js → repo root → admin-ui/
  return resolve(__dirname, '..', '..', 'admin-ui');
}

function loadStatic(dir: string): Map<string, { body: Buffer; type: string }> {
  const m = new Map<string, { body: Buffer; type: string }>();
  for (const [route, file] of Object.entries(STATIC)) {
    const p = join(dir, file);
    if (existsSync(p)) m.set(route, { body: readFileSync(p), type: TYPES[file.split('.').pop()!]! });
  }
  return m;
}

// ── the console ────────────────────────────────────────────────────────────
type Ctx = { req: IncomingMessage; res: ServerResponse; ip: string; secure: boolean; user: AdminUser | null; sessionHash: string | null };

export interface AdminDeps { store: AdminStore; pool: Pool | null; opts: AdminConsoleOptions; startedAt: number }

const publicUser = (u: AdminUser) => ({ id: u.id, username: u.username, role: u.role, mustChangePassword: u.mustChangePassword, disabled: u.disabled, createdAt: u.createdAt, createdBy: u.createdBy, passwordChangedAt: u.passwordChangedAt, lastLoginAt: u.lastLoginAt, autotaskResourceId: u.autotaskResourceId, autotaskResourceName: u.autotaskResourceName });

let thresholdCache: { at: number; value: unknown } | null = null;

/** Autotask reads at/above this per 24 h, mostly not answered locally, mark an entity as a mirroring candidate. */
const CANDIDATE_MIN_UPSTREAM = 50;

/**
 * Reads per entity with how each is kept locally: mirrored in the Postgres shadow
 * (and whether searches are served from it), the read-cache class + TTL, and a
 * "candidate" flag for heavy, mostly-uncached entities worth mirroring next.
 */
export function readSourceReport(hours = 24): Record<string, unknown> {
  const { since, entities } = entityReadStats(hours);
  const rt = getShadowRuntime();
  const h = Math.min(Math.max(Math.floor(hours), 1), 168);
  const scale = 24 / h; // the candidate rule is per 24 h
  return {
    since,
    hours: h,
    candidateRule: `≥ ${CANDIDATE_MIN_UPSTREAM} Autotask reads per 24 h, under 50% answered locally, not mirrored`,
    entities: entities.map((e) => {
      const mirrored = !!shadowEntity(e.entity);
      const cls = classify(`/${e.entity}`);
      const ttl = cacheEnabled() ? Math.round(ttlMs(cls) / 1000) : 0;
      return {
        ...e,
        mirrored,
        servedFromShadow: mirrored && !!rt?.serveReads,
        cacheClass: cls, cacheTtlSeconds: ttl,
        candidate: !mirrored && e.upstream * scale >= CANDIDATE_MIN_UPSTREAM && (e.localPct ?? 0) < 50,
      };
    }),
  };
}

// ── tool gaps: which existing tool covers a raw request ─────────────────────
const toolNames = new Map(TOOL_DEFINITIONS.map((t) => [t.name.replace(/_/g, '').toLowerCase(), t.name]));
const singular = (w: string) => w.replace(/ies$/i, 'y').replace(/(ch|sh|x|ss)es$/i, '$1').replace(/s$/i, '');

/**
 * The tool that already does what a raw request does, by naming convention:
 * POST /X/query → search_x, GET /X/{id} → get_<x>, POST /X → create_<x>,
 * PATCH|PUT /X → update_<x>, DELETE /X/{id} → delete_<x>; child routes
 * (/Tickets/{id}/Notes) use parent + child (search_ticket_notes,
 * create_ticket_note). Null = no tool covers it — a candidate to build.
 */
export function coveringTool(shape: string): string | null {
  const [method, path] = shape.split(' ');
  const seg = (path ?? '').split('/').filter(Boolean);
  if (!seg.length) return null;
  let entity = seg[0]!, rest = seg.slice(1);
  if (rest[0] === '{id}' && rest[1] && rest[1] !== 'query') { entity = singular(seg[0]!) + rest[1]; rest = rest.slice(2); } // child route
  const plural = entity.toLowerCase(), one = singular(entity).toLowerCase();
  const verbs: string[] = [];
  if (method === 'POST' && rest[0] === 'query') verbs.push(`search${plural}`, `list${plural}`);
  else if (method === 'GET' && rest[0] === '{id}') verbs.push(`get${one}`, `get${one}details`);
  else if (method === 'GET' && rest[0] === 'entityInformation') verbs.push('getfieldinfo', 'getpicklists');
  else if (method === 'POST' && !rest.length) verbs.push(`create${one}`, `add${one}`);
  else if ((method === 'PATCH' || method === 'PUT') && (!rest.length || rest[0] === '{id}')) verbs.push(`update${one}`);
  else if (method === 'DELETE') verbs.push(`delete${one}`, `remove${one}`);
  for (const v of verbs) { const t = toolNames.get(`autotask${v}`); if (t) return t; }
  return null;
}

/** raw_request use with the covering tool (or none), fallbacks, and outside-MCP traffic. */
export function toolGapReport(hours = 24): Record<string, unknown> {
  const g = toolGapStats(hours);
  return {
    since: g.since,
    raw: g.raw.map((r) => ({ ...r, coveredBy: coveringTool(r.shape) })),
    fallbacks: g.fallbacks,
    outside: outsideTraffic(),
  };
}

/**
 * The Overview's view of THIS MCP's traffic (not the tenant's other
 * integrations): reads Autotask answered live — what to cache or mirror next —
 * and raw_request calls no tool covers — what to build next.
 */
export function mcpTrafficSummary(hours = 24): Record<string, unknown> {
  const r = readSourceReport(hours) as { since: string; entities: Array<{ entity: string; upstream: number; cache: number; shadow: number; localPct: number | null; mirrored: boolean; servedFromShadow: boolean; cacheTtlSeconds: number; candidate: boolean; topCallers: Array<{ caller: string; count: number }> }> };
  const upstream = r.entities.reduce((s, e) => s + e.upstream, 0);
  const local = r.entities.reduce((s, e) => s + e.cache + e.shadow, 0);
  const g = toolGapReport(hours) as { raw: Array<{ shape: string; calls: number; errors: number; coveredBy: string | null; callers: Array<{ caller: string; count: number }> }> };
  const uncovered = g.raw.filter((x) => !x.coveredBy), covered = g.raw.filter((x) => x.coveredBy);
  return {
    since: r.since, hours: Math.min(Math.max(Math.floor(hours), 1), 168),
    reads: {
      live: upstream, local, localPct: upstream + local ? Math.round((local / (upstream + local)) * 1000) / 10 : null,
      top: r.entities.filter((e) => e.upstream > 0 && !e.servedFromShadow).slice(0, 4).map((e) => ({ entity: e.entity, live: e.upstream, localPct: e.localPct, candidate: e.candidate, cached: e.cacheTtlSeconds > 0, mirrored: e.mirrored, topCaller: e.topCallers[0]?.caller ?? null })),
    },
    gaps: {
      uncoveredShapes: uncovered.length, uncoveredCalls: uncovered.reduce((s, x) => s + x.calls, 0),
      coveredShapes: covered.length, coveredCalls: covered.reduce((s, x) => s + x.calls, 0),
      top: uncovered.slice(0, 4).map((x) => ({ shape: x.shape, calls: x.calls, errors: x.errors, caller: x.callers[0]?.caller ?? null })),
    },
  };
}

/** Build the request handler (exported for tests). */
export function adminHandler(deps: AdminDeps) {
  const { store, opts } = deps;
  const env = opts.env ?? process.env;
  const trustProxy = env.MCP_ADMIN_TRUST_PROXY == null ? true : boolEnv(env.MCP_ADMIN_TRUST_PROXY);
  const cookieMode = (env.MCP_ADMIN_COOKIE_SECURE ?? 'auto').toLowerCase();
  const statics = loadStatic(env.MCP_ADMIN_UI_DIR || uiDir());
  serverVersion = opts.version;
  // Tie the page's scripts to this release: a deploy changes the URLs, so a
  // browser (or proxy) can never keep running the previous release's code.
  for (const route of ['/', '/index.html']) {
    const page = statics.get(route);
    if (page) {
      const v = encodeURIComponent(opts.version);
      const html = page.body.toString('utf8')
        .replace('src="/app.js"', `src="/app.js?v=${v}"`).replace('href="/app.css"', `href="/app.css?v=${v}"`)
        .replace('<head>', `<head>\n  <meta name="psarelay-version" content="${opts.version.replace(/[^\w.+-]/g, '')}">`);
      statics.set(route, { ...page, body: Buffer.from(html, 'utf8') });
    }
  }
  const log = (ctx: Ctx, action: string, details: Record<string, unknown> = {}) =>
    store.logEvent(ctx.user?.username ?? null, action, details, ctx.ip).catch((e) => opts.logger.warn('admin: change log write failed', e));

  const requireUser = (ctx: Ctx, role?: AdminRole): AdminUser => {
    if (!ctx.user) throw new HttpError(401, 'Sign in first.', 'unauthenticated');
    if (ctx.user.mustChangePassword) throw new HttpError(403, 'Choose a new password first.', 'password_change_required');
    if (role === 'admin' && ctx.user.role !== 'admin') throw new HttpError(403, 'Administrators only.', 'forbidden');
    return ctx.user;
  };

  const settingsView = () => {
    const shadowOn = !!getShadowRuntime();
    return SETTINGS.map((d) => ({
      key: d.key, group: d.group, label: d.label, description: d.description, type: d.type,
      ...(d.min != null ? { min: d.min } : {}), ...(d.max != null ? { max: d.max } : {}), ...(d.choices ? { choices: d.choices } : {}),
      value: settingValue(d.key, env), default: d.envDefault(env), overridden: isOverridden(d.key),
      available: d.requires === 'shadow' ? shadowOn : true,
    }));
  };

  const status = async () => {
    const rt = getShadowRuntime();
    const tenant = opts.apiUsername?.toLowerCase();
    // Autotask's own counter costs an API call — refresh at most every 5 minutes.
    // Errors are kept only a minute, so a fixed account shows up quickly.
    const ttl = thresholdCache && (thresholdCache.value as { error?: unknown } | null)?.error ? 60_000 : 300_000;
    if (tenant && (!thresholdCache || Date.now() - thresholdCache.at > ttl)) {
      const u = await runJob('admin console', () => opts.service.getApiUsage()).catch((e) => ({ autotask: { error: String(e) } }));
      thresholdCache = { at: Date.now(), value: u.autotask };
    }
    const pg = await pgHealthCheck(opts.logger, env);
    const states = rt ? await rt.store.allStates().catch(() => []) : [];
    const last = rt?.lastRun() ?? null;
    let audit: unknown = null;
    if (deps.pool) {
      try {
        const has = await deps.pool.query<{ t: string | null }>(`SELECT to_regclass('audit_event')::text AS t`);
        if (has.rows[0]?.t) {
          const r = await deps.pool.query<{ source: string; n: string }>(`SELECT source, count(*) AS n FROM audit_event WHERE occurred_at > now() - interval '24 hours' GROUP BY source ORDER BY source`);
          audit = { last24h: Object.fromEntries(r.rows.map((x) => [x.source, Number(x.n)])) };
        }
      } catch { /* the ledger is optional */ }
    }
    const enabledTools = TOOL_DEFINITIONS.filter((t) => toolAllowed(t.name));
    return {
      version: opts.version,
      startedAt: new Date(deps.startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      node: process.version,
      autotaskAuth: tenant ? authBlockStatus(tenant) : null,
      outsideTraffic: tenant ? outsideTraffic() : null,
      mcpTraffic: mcpTrafficSummary(24),
      api: tenant ? { server: usageSnapshot(tenant, 15), autotask: thresholdCache?.value ?? null, autotaskCheckedAt: thresholdCache ? new Date(thresholdCache.at).toISOString() : null } : null,
      postgres: { enabled: pg.enabled, ok: pg.ok, latencyMs: pg.latencyMs ?? null, error: pg.error ?? null },
      shadow: rt ? {
        verify: rt.lastVerify() ?? (await rt.store.verifyRuns(1).then((r) => (r[0]?.report as Record<string, unknown> | undefined) ?? null).catch(() => null)),
        enabled: true, serveReads: rt.serveReads, syncEnabled: rt.syncEnabled, maxAgeSeconds: rt.maxAgeSeconds, pauseAtPct: rt.sync.pauseAtPct, pendingRowRefreshes: rt.sync.dirtyCount(),
        lastRun: last ? { at: last.at, calls: last.report.calls, skipped: last.report.skipped ?? null, entities: last.report.entities } : null,
        entities: states.map((s) => {
          const times = [s.last_incremental_at, s.last_full_at, s.last_backfill_at].filter(Boolean).map((d) => new Date(d as Date).getTime());
          const at = times.length ? Math.max(...times) : null;
          return { entity: s.entity, rows: s.row_count, ready: s.backfill_done, lastSyncedAt: at ? new Date(at).toISOString() : null, ageSeconds: at ? Math.round((Date.now() - at) / 1000) : null,
            windowFrom: s.window_from ? new Date(s.window_from).toISOString().slice(0, 10) : null, apiCallsTotal: s.api_calls_total, lastError: s.last_error, lastErrorAt: s.last_error_at ? new Date(s.last_error_at).toISOString() : null };
        }),
      } : { enabled: false, flag: loadPgFlags(env).shadow },
      tools: {
        total: TOOL_DEFINITIONS.length, enabled: enabledTools.length,
        writeTools: TOOL_DEFINITIONS.filter((t) => isWriteTool(t.name)).length,
        writesEnabled: settingValue<boolean>('tools.writesEnabled', env), disabledCategories: settingValue<string[]>('tools.disabledCategories', env),
      },
      secrets: {
        autotaskCredentials: !!(env.AUTOTASK_USERNAME && env.AUTOTASK_SECRET && env.AUTOTASK_INTEGRATION_CODE),
        webhookSecret: !!env.AUTOTASK_WEBHOOK_SECRET,
      },
      audit,
    };
  };

  const idParam = (s: string | undefined): number => { const n = Number(s); if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Not found.'); return n; };

  async function api(ctx: Ctx, method: string, path: string): Promise<void> {
    const { req, res } = ctx;
    if (method !== 'GET' && method !== 'HEAD') {
      const bad = csrfProblem(req);
      if (bad) throw new HttpError(403, bad, 'csrf');
    }

    // ── session ──
    if (path === '/api/login' && method === 'POST') {
      const b = await readJson(req, 8 * 1024);
      const username = String(b.username ?? '').trim(), password = String(b.password ?? '');
      const wait = loginThrottled(ctx.ip, username);
      if (wait) throw new HttpError(429, `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minute(s).`, 'throttled');
      const u = validUsername(username) ? await store.findForLogin(username) : null;
      const ok = await verifyPassword(password, u?.passwordHash ?? await dummyPasswordHash());
      if (!u || !ok || u.disabled) {
        noteFailure(ctx.ip, username);
        void store.logEvent(username || null, 'login.failed', { reason: !u ? 'unknown user' : u.disabled ? 'disabled' : 'wrong password' }, ctx.ip).catch(() => undefined);
        throw new HttpError(401, 'Wrong username or password.', 'bad_credentials');
      }
      clearFailures(username);
      const s = await store.createSession(u.id, ctx.ip, header(req, 'user-agent') ?? null);
      await store.recordLogin(u.id);
      ctx.user = u;
      void log(ctx, 'login');
      const { passwordHash: _h, ...user } = u;
      return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(s.token, ctx.secure) });
    }
    if (path === '/api/logout' && method === 'POST') {
      if (ctx.sessionHash) await store.deleteSession(ctx.sessionHash);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(null, ctx.secure) });
    }
    if (path === '/api/me' && method === 'GET') {
      if (!ctx.user) throw new HttpError(401, 'Sign in first.', 'unauthenticated');
      return send(res, 200, { user: publicUser(ctx.user) });
    }
    if (path === '/api/me/password' && method === 'POST') {
      if (!ctx.user) throw new HttpError(401, 'Sign in first.', 'unauthenticated');
      const b = await readJson(req, 8 * 1024);
      const current = String(b.currentPassword ?? ''), next = b.newPassword;
      const hash = await store.passwordHashOf(ctx.user.id);
      if (!hash || !(await verifyPassword(current, hash))) throw new HttpError(400, 'Your current password is wrong.', 'bad_credentials');
      const problem = passwordProblem(next, ctx.user.username);
      if (problem) throw new HttpError(400, problem, 'weak_password');
      if (next === current) throw new HttpError(400, 'Choose a password different from the current one.', 'weak_password');
      await store.setPassword(ctx.user.id, next as string, false, ctx.sessionHash ?? undefined);
      void log(ctx, 'password.changed');
      return send(res, 200, { user: publicUser({ ...ctx.user, mustChangePassword: false }) });
    }

    // ── read-only (viewer and admin) ──
    if (path === '/api/status' && method === 'GET') { requireUser(ctx); return send(res, 200, await status()); }
    if (path === '/api/settings' && method === 'GET') { requireUser(ctx); return send(res, 200, { settings: settingsView() }); }
    if (path.startsWith('/api/calls') && method === 'GET') {
      requireUser(ctx);
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const num = (k: string) => { const n = Number(q.get(k)); return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined; };
      const query: CallQuery = {};
      const limit = num('limit'), before = num('before'), toolCallId = num('toolCallId');
      if (limit) query.limit = limit;
      if (before) query.beforeId = before;
      if (toolCallId) query.toolCallId = toolCallId;
      if (q.get('tool')) query.tool = q.get('tool')!.slice(0, 100);
      if (q.get('source')) query.source = q.get('source')!.slice(0, 40);
      if (q.get('errors') === '1') query.errorsOnly = true;
      if (path === '/api/calls/summary') return send(res, 200, callerSummary(Math.min(num('minutes') ?? 60, 24 * 60)));
      if (path === '/api/calls/entities') return send(res, 200, readSourceReport(num('hours') ?? 24));
      if (path === '/api/calls/gaps') return send(res, 200, toolGapReport(num('hours') ?? 24));
      if (path === '/api/calls/tools') return send(res, 200, { calls: recentToolCalls(query) });
      if (path === '/api/calls/api') return send(res, 200, { calls: recentApiCalls(query) });
    }

    if (path === '/api/shadow/verify' && method === 'GET') {
      requireUser(ctx);
      const rt = getShadowRuntime();
      return send(res, 200, { runs: rt ? await rt.store.verifyRuns(14).catch(() => []) : [] });
    }
    if (path === '/api/actors' && method === 'GET') {
      requireUser(ctx);
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      try {
        return send(res, 200, await opts.service.getActorRoster({ includeInactive: q.get('inactive') === '1' }));
      } catch (e) { throw new HttpError(502, `Could not load the resource roster: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (path === '/api/logs' && method === 'GET') {
      requireUser(ctx);
      const n = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit')) || 200;
      return send(res, 200, { logs: recentLogs(n) });
    }
    if (path === '/api/export' && method === 'GET') {
      const u = requireUser(ctx);
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const kind = q.get('kind') ?? 'bundle', format = q.get('format') === 'csv' && kind !== 'bundle' ? 'csv' : 'json';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let rows: Array<Record<string, unknown>>;
      if (kind === 'tools') rows = recentToolCalls({ limit: 10_000 }) as unknown as Array<Record<string, unknown>>;
      else if (kind === 'api') rows = recentApiCalls({ limit: 10_000 }) as unknown as Array<Record<string, unknown>>;
      else if (kind === 'logs') rows = recentLogs() as unknown as Array<Record<string, unknown>>;
      else if (kind === 'gaps') rows = (toolGapReport(24).raw as Array<Record<string, unknown>>).map((r) => ({ ...r, callers: (r.callers as Array<{ caller: string; count: number }>).map((c) => `${c.caller} x${c.count}`).join('; ') }));
      else if (kind === 'entities') rows = (readSourceReport(24).entities as Array<Record<string, unknown>>).map((e) => ({ ...e, topCallers: (e.topCallers as Array<{ caller: string; count: number }>).map((c) => `${c.caller} x${c.count}`).join('; ') }));
      else if (kind === 'bundle') {
        const bundle = {
          exportedAt: new Date().toISOString(), exportedBy: u.username,
          note: 'PSArelay diagnostics. Contains no credentials, tool arguments or response bodies.',
          status: await status(), settings: settingsView(), callers: callerSummary(24 * 60),
          readsByEntity: readSourceReport(24),
          toolGaps: toolGapReport(24),
          toolCalls: recentToolCalls({ limit: 10_000 }), apiCalls: recentApiCalls({ limit: 10_000 }), serverLog: recentLogs(),
          ...(u.role === 'admin' ? { consoleActivity: await store.listEvents(500) } : {}),
        };
        void log(ctx, 'export', { kind });
        return sendFile(res, `psarelay-diagnostics-${stamp}.json`, 'application/json; charset=utf-8', JSON.stringify(bundle, null, 2));
      } else throw new HttpError(400, 'kind must be tools, api, entities, gaps, logs or bundle.');
      void log(ctx, 'export', { kind, format });
      return format === 'csv'
        ? sendFile(res, `psarelay-${kind}-${stamp}.csv`, 'text/csv; charset=utf-8', toCsv(rows, CSV_COLUMNS[kind] ?? []))
        : sendFile(res, `psarelay-${kind}-${stamp}.json`, 'application/json; charset=utf-8', JSON.stringify(rows, null, 2));
    }

    // ── admin ──
    const settingMatch = /^\/api\/settings\/([A-Za-z0-9_.]+)$/.exec(path);
    if (settingMatch && method === 'PUT') {
      requireUser(ctx, 'admin');
      const key = settingMatch[1]!;
      const def = settingDef(key);
      if (!def) throw new HttpError(404, `Unknown setting "${key}".`);
      const b = await readJson(req);
      const before = settingValue(key, env);
      if (b.reset === true) {
        await store.clearSetting(key);
        clearOverride(key);
      } else {
        let v: unknown;
        try { v = coerceSetting(key, b.value); } catch (e) { throw new HttpError(400, (e as Error).message, 'invalid'); }
        await store.saveSetting(key, v, ctx.user!.username);
        setOverride(key, v);
      }
      applySettings();
      const after = settingValue(key, env);
      void log(ctx, b.reset === true ? 'setting.reset' : 'setting.changed', { key, from: before, to: after });
      return send(res, 200, { settings: settingsView() });
    }

    if (path === '/api/actions/auth-retry' && method === 'POST') {
      requireUser(ctx, 'admin');
      const tenant = opts.apiUsername?.toLowerCase();
      const cleared = tenant ? clearAuthBlock(tenant) : false;
      thresholdCache = null; // re-check usage (the probe) on the next dashboard refresh
      void log(ctx, 'action.auth_retry', { cleared });
      return send(res, 200, { ok: true, message: cleared ? 'Pause cleared. The next Autotask call will test the credentials. Watch the Calls page for a 200.' : 'There was no pause to clear.' });
    }
    if (path === '/api/actions/shadow-verify' && method === 'POST') {
      requireUser(ctx, 'admin');
      const rt = getShadowRuntime();
      if (!rt) throw new HttpError(409, 'The Postgres shadow is not running on this server.');
      void log(ctx, 'action.shadow_verify');
      void rt.verify({ trigger: `manual (${ctx.user!.username})` }).catch((e) => opts.logger.error('admin: shadow verify failed', e));
      return send(res, 202, { ok: true, message: 'Mirror check started (about 2 Autotask calls per entity). The result appears on the dashboard in a minute.' });
    }
    if (path === '/api/actions/shadow-sync' && method === 'POST') {
      requireUser(ctx, 'admin');
      const rt = getShadowRuntime();
      if (!rt) throw new HttpError(409, 'The Postgres shadow is not running on this server.');
      void log(ctx, 'action.shadow_sync');
      void rt.runNow().catch((e) => opts.logger.error('admin: manual shadow sync failed', e));
      return send(res, 202, { ok: true, message: 'Sync started. Refresh the status in a minute to see the result.' });
    }

    // ── notifications (Discord / Teams / Slack / JSON webhooks) ──
    if (path === '/api/notifications' && method === 'GET') {
      requireUser(ctx);
      const n = getNotifier();
      return send(res, 200, {
        channels: n.getChannels().map((c) => channelView(c, n.channelStatus(c.id))),
        events: NOTIFY_EVENTS, kinds: CHANNEL_KINDS,
      });
    }
    const saveChannels = async (list: NotifyChannel[]) => {
      await store.saveSetting(NOTIFY_SETTING_KEY, list, ctx.user!.username);
      getNotifier().setChannels(list);
    };
    if (path === '/api/notifications' && method === 'POST') {
      requireUser(ctx, 'admin');
      const list = getNotifier().getChannels();
      let c: NotifyChannel;
      try { c = channelFromInput(await readJson(req), null, list.length); } catch (e) { if (e instanceof ChannelInputError) throw new HttpError(400, e.message, 'invalid'); throw e; }
      await saveChannels([...list, c]);
      void log(ctx, 'notify.channel_added', channelLogDetails(c));
      return send(res, 200, { ok: true, id: c.id });
    }
    const chMatch = /^\/api\/notifications\/([0-9a-f-]{36})(\/test)?$/.exec(path);
    if (chMatch) {
      requireUser(ctx, 'admin');
      const list = getNotifier().getChannels();
      const existing = list.find((c) => c.id === chMatch[1]);
      if (!existing) throw new HttpError(404, 'No such channel.');
      if (chMatch[2] && method === 'POST') {
        const r = await getNotifier().send(existing, {
          type: 'test', severity: 'info', title: 'Test notification from the PSArelay',
          detail: `Sent from the admin console by ${ctx.user!.username}. If you can read this, "${existing.name}" is set up correctly.`,
          fields: { events: existing.events.length ? existing.events.join(', ') : 'none selected yet' },
        });
        void log(ctx, 'notify.channel_tested', { id: existing.id, name: existing.name, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
        return send(res, 200, r.ok ? { ok: true, message: `Test sent to "${existing.name}".` } : { ok: false, message: `The test did not go through: ${r.error}` });
      }
      if (!chMatch[2] && method === 'PUT') {
        let c: NotifyChannel;
        try { c = channelFromInput(await readJson(req), existing, list.length); } catch (e) { if (e instanceof ChannelInputError) throw new HttpError(400, e.message, 'invalid'); throw e; }
        await saveChannels(list.map((x) => (x.id === c.id ? c : x)));
        void log(ctx, 'notify.channel_changed', channelLogDetails(c));
        return send(res, 200, { ok: true });
      }
      if (!chMatch[2] && method === 'DELETE') {
        await saveChannels(list.filter((x) => x.id !== existing.id));
        void log(ctx, 'notify.channel_removed', channelLogDetails(existing));
        return send(res, 200, { ok: true });
      }
    }

    // ── access: tokens for /mcp, and the security posture (zero trust) ──
    if (path === '/api/security' && method === 'GET') {
      requireUser(ctx);
      const store = tokenStore(deps.pool);
      const activeTokens = store ? await store.activeCount().catch(() => null) : null;
      return send(res, 200, { checks: securityPosture({ pgEnabled: !!deps.pool, activeTokens }) });
    }
    if (path === '/api/access-tokens' && method === 'GET') {
      requireUser(ctx, 'admin');
      const store = tokenStore(deps.pool);
      if (!store) return send(res, 200, { available: false, tokens: [], required: settingValue<boolean>('security.requireMcpToken') === true });
      return send(res, 200, { available: true, tokens: await store.list(), required: settingValue<boolean>('security.requireMcpToken') === true });
    }
    if (path === '/api/access-tokens' && method === 'POST') {
      requireUser(ctx, 'admin');
      const store = tokenStore(deps.pool);
      if (!store) throw new HttpError(409, 'Access tokens need the Postgres layer (MCP_PG_ENABLED).', 'unavailable');
      const b = await readJson(req, 4 * 1024);
      const name = String(b.name ?? '').trim().slice(0, 80);
      if (!name) throw new HttpError(400, 'Give the token a name (who or what uses it, e.g. "n8n").', 'invalid');
      const rid = b.resourceId == null || b.resourceId === '' ? null : Number(b.resourceId);
      if (rid != null && (!Number.isInteger(rid) || rid <= 0)) throw new HttpError(400, 'The Autotask resource id must be a whole number.', 'invalid');
      const delegate = b.delegate === true;
      if (rid != null && delegate) throw new HttpError(400, 'A token is either for one person or a delegate, not both.', 'invalid');
      const days = b.expiresInDays == null || b.expiresInDays === '' ? null : Number(b.expiresInDays);
      if (days != null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new HttpError(400, 'Expiry is 1–3650 days, or empty for none.', 'invalid');
      const r = await store.create({ name, resourceId: rid, delegate, expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null, by: ctx.user!.username });
      void log(ctx, 'access.token_created', { id: r.item.id, name, resourceId: rid, delegate, expiresInDays: days });
      return send(res, 200, { token: r.token, item: r.item });
    }
    // Self-service: every console user manages their OWN tokens — always bound to the Autotask resource an
    // administrator linked them to, so a token never carries more than that person's own Autotask rights.
    if (path === '/api/me/tokens' && method === 'GET') {
      const u = requireUser(ctx);
      const store = tokenStore(deps.pool);
      const full = await deps.store.getUser(u.id);
      return send(res, 200, { available: !!store, linked: full?.autotaskResourceId != null ? { id: full.autotaskResourceId, name: full.autotaskResourceName } : null, tokens: store ? await store.listOwned(u.id) : [], mcpUrl: mcpUrl() });
    }
    if (path === '/api/me/tokens' && method === 'POST') {
      const u = requireUser(ctx);
      const store = tokenStore(deps.pool);
      if (!store) throw new HttpError(409, 'Access tokens need the Postgres layer (MCP_PG_ENABLED).', 'unavailable');
      const full = await deps.store.getUser(u.id);
      if (full?.autotaskResourceId == null) throw new HttpError(409, 'Your console user is not linked to an Autotask user yet — ask an administrator to link it (Users page).', 'not_linked');
      const b = await readJson(req, 4 * 1024);
      const name = String(b.name ?? '').trim().slice(0, 80) || 'My AI';
      const days = b.expiresInDays == null || b.expiresInDays === '' ? 180 : Number(b.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'Your own tokens last 1–365 days.', 'invalid');
      const r = await store.create({ name, resourceId: full.autotaskResourceId, ownerUserId: u.id, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(), by: u.username });
      void log(ctx, 'access.own_token_created', { id: r.item.id, name, resourceId: full.autotaskResourceId, expiresInDays: days });
      return send(res, 200, { token: r.token, item: r.item, mcpUrl: mcpUrl() });
    }
    const ownTok = /^\/api\/me\/tokens\/(\d+)\/revoke$/.exec(path);
    if (ownTok && method === 'POST') {
      const u = requireUser(ctx);
      const store = tokenStore(deps.pool);
      if (!store) throw new HttpError(409, 'Access tokens need the Postgres layer (MCP_PG_ENABLED).', 'unavailable');
      const ok = await store.revoke(Number(ownTok[1]), u.username, u.id);
      void log(ctx, 'access.own_token_revoked', { id: Number(ownTok[1]), ok });
      return send(res, 200, { ok, message: ok ? 'Revoked.' : 'Not one of your active tokens.' });
    }
    const tokMatch = /^\/api\/access-tokens\/(\d+)\/revoke$/.exec(path);
    if (tokMatch && method === 'POST') {
      requireUser(ctx, 'admin');
      const store = tokenStore(deps.pool);
      if (!store) throw new HttpError(409, 'Access tokens need the Postgres layer (MCP_PG_ENABLED).', 'unavailable');
      const ok = await store.revoke(Number(tokMatch[1]), ctx.user!.username);
      void log(ctx, 'access.token_revoked', { id: Number(tokMatch[1]), ok });
      return send(res, 200, { ok, message: ok ? 'Revoked. Calls with this token are refused from now on.' : 'That token was already revoked.' });
    }

    // ── plan: modules on the account, and upgrade requests (to the control plane, via notifications) ──
    if (path === '/api/plan' && method === 'GET') {
      requireUser(ctx);
      return send(res, 200, entitlementView());
    }
    if (path === '/api/plan/request' && method === 'POST') {
      const u = requireUser(ctx);
      const b = await readJson(req, 4 * 1024);
      const module = String(b.module ?? '');
      if (!MODULE_INFO[module]) throw new HttpError(400, 'Unknown module.', 'invalid');
      const v = entitlementView();
      if (v.modules.find((m) => m.id === module)?.included) throw new HttpError(409, 'That module is already on your plan.', 'included');
      const note = String(b.note ?? '').slice(0, 500);
      notify({ type: 'platform.upgrade_requested', severity: 'info', title: `Upgrade requested: ${MODULE_INFO[module]!.name}`, detail: `${u.username} asked for ${MODULE_INFO[module]!.name}${v.customer ? ` (${v.customer}, plan ${v.planName})` : ''}.${note ? ` Note: ${note}` : ''}`, fields: { module, customer: v.customer ?? '', plan: v.plan ?? '', by: u.username }, dedupeKey: `upgrade:${module}:${u.username}:${new Date().toISOString().slice(0, 10)}` });
      void log(ctx, 'plan.upgrade_requested', { module, note: note ? 'yes' : 'no' });
      return send(res, 200, { ok: true, message: v.upgradeUrl ? `Request sent. You can also see plans at ${v.upgradeUrl}.` : 'Request sent to your provider.' });
    }

    // ── setup check: connection, API-user permissions per module, mirror progress, how to connect clients ──
    if (path === '/api/setup' && method === 'GET') {
      requireUser(ctx);
      return send(res, 200, { report: lastSetupReport(), modules: MODULES.map((m) => ({ id: m.id, name: m.name })) });
    }
    if (path === '/api/setup/run' && method === 'POST') {
      const u = requireUser(ctx, 'admin');
      const report = await runSetupCheck(opts.service);
      void log(ctx, 'setup.check', { by: u.username, connected: report.connection.ok, blocked: report.modules.filter((m) => m.status === 'blocked').map((m) => m.id) });
      return send(res, 200, { report });
    }

    // ── bulk jobs: mass changes staged in Postgres, pushed by the worker at a set pace ──
    if (path === '/api/bulk-jobs' && method === 'GET') {
      requireUser(ctx);
      { const locked = lockedReason('cleanup'); if (locked) return send(res, 200, { jobs: [], available: true, locked: { module: 'cleanup', reason: locked } }); }
      if (!deps.pool) return send(res, 200, { jobs: [], available: false });
      const st = new BulkStore(deps.pool);
      const showArchived = new URL(req.url ?? '/', 'http://x').searchParams.get('archived') === '1';
      const jobs = await st.list(30, { archived: showArchived }).catch((e) => { if (/bulk_job/.test(String(e))) throw new HttpError(503, 'The bulk job tables are missing — run the migrations (0015).', 'migration'); throw e; });
      return send(res, 200, { jobs: await Promise.all(jobs.map((j) => jobView(st, j))), available: true, defaults: DEFAULT_SCHEDULE, archivedCount: await st.archivedCount() });
    }
    if (path === '/api/bulk-jobs/activity' && method === 'GET') {
      requireUser(ctx);
      const tz = new URL(req.url ?? '/', 'http://x').searchParams.get('tz') || DEFAULT_SCHEDULE.tz;
      // When the TEAM works (mirror: time entries + notes by people); this MCP's traffic only without Postgres.
      const hourParam = new URL(req.url ?? '/', 'http://x').searchParams.get('hour');
      if (hourParam != null && hourParam !== '') {
        if (!deps.pool) throw new HttpError(503, 'Needs the Postgres mirror.');
        return send(res, 200, await teamActivityHour(deps.pool, tz, Number(hourParam), await mirrorClassifier(deps.pool)));
      }
      if (deps.pool) { try { return send(res, 200, await teamActivityProfile(deps.pool, tz, await mirrorClassifier(deps.pool))); } catch { /* mirror tables missing — fall back */ } }
      return send(res, 200, activityProfile(hourlyActivity(), tz));
    }
    if (path === '/api/bulk-jobs' && method === 'POST') {
      const u = requireUser(ctx, 'admin');
      if (!deps.pool) throw new HttpError(503, 'Needs Postgres.');
      const b = await readJson(req, 256 * 1024);
      let job;
      const sched = b.businessHours === false ? { businessHours: false as const } : b.businessHours && typeof b.businessHours === 'object' ? { businessHours: b.businessHours as Record<string, unknown> } : {};
      try {
        if (b.companyId != null && b.companyId !== '') job = await startPrepareCompanyContacts(opts.service, new BulkStore(deps.pool), {
          companyId: Number(b.companyId), contactIds: (b.contactIds ?? null) as never, keepDomains: (b.keepDomains ?? null) as never, onlyDomains: (b.onlyDomains ?? null) as never,
          includeNoEmail: b.includeNoEmail === true, ticketsOk: b.ticketsOk === true, createdFrom: b.createdFrom ? String(b.createdFrom) : null, createdTo: b.createdTo ? String(b.createdTo) : null,
          ratePerHour: Number(b.ratePerHour) || 3000, canary: Number(b.canary) || 25, ...sched, quietHours: (b.quietHours ?? null) as never,
        }, u.username);
        else job = await startPrepare(opts.service, new BulkStore(deps.pool), {
          companyName: String(b.companyName ?? ''), createdByResourceId: b.createdByResourceId != null && b.createdByResourceId !== '' ? Number(b.createdByResourceId) : null,
          createdFrom: b.createdFrom ? String(b.createdFrom) : null, createdTo: b.createdTo ? String(b.createdTo) : null, includeContacts: b.includeContacts !== false,
          ratePerHour: Number(b.ratePerHour) || 3000, canary: Number(b.canary) || 50, quietHours: (b.quietHours ?? null) as never, excludeEmails: (b.excludeEmails ?? null) as never, junkEmails: (b.junkEmails ?? null) as never,
          ...(b.businessHours === false ? { businessHours: false as const } : b.businessHours && typeof b.businessHours === 'object' ? { businessHours: b.businessHours as Record<string, unknown> } : {}),
        }, u.username);
      } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e), 'invalid'); }
      void log(ctx, 'bulk.prepared', { id: job.id, title: job.title });
      return send(res, 200, { ok: true, id: job.id });
    }
    const bulkItems = /^\/api\/bulk-jobs\/([0-9a-f-]{36})\/items$/.exec(path);
    if (bulkItems && method === 'GET') {
      requireUser(ctx);
      if (!deps.pool) throw new HttpError(503, 'Needs Postgres.');
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const status = (['done', 'pending', 'skipped', 'failed', 'excluded'].includes(q.get('status') ?? '') ? q.get('status') : 'done') as ItemStatus;
      const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 500);
      const st = new BulkStore(deps.pool);
      const items = status === 'done' || status === 'skipped' ? await st.recentItems(bulkItems[1]!, status, limit) : await st.items(bulkItems[1]!, status, limit);
      return send(res, 200, { status, items: items.map((x) => ({ ...x, link: opts.service.getRecordWebUrl(x.entity === 'Companies' ? 'company' : 'contact', x.recordId) })) });
    }
    const bulkAct = /^\/api\/bulk-jobs\/([0-9a-f-]{36})\/([a-z_]+)$/.exec(path);
    if (bulkAct && method === 'POST' && (JOB_ACTIONS as string[]).includes(bulkAct[2]!)) {
      const u = requireUser(ctx, 'admin');
      if (!deps.pool) throw new HttpError(503, 'Needs Postgres.');
      const st = new BulkStore(deps.pool);
      const j = await st.get(bulkAct[1]!);
      if (!j) throw new HttpError(404, 'No such job.');
      const b = await readJson(req, 4 * 1024);
      const r = await jobAction(st, j, bulkAct[2] as JobAction, { hash: b.hash != null ? String(b.hash) : undefined, by: u.username });
      void log(ctx, `bulk.${bulkAct[2]}`, { id: j.id, ok: r.ok, status: r.status });
      if (!r.ok) throw new HttpError(409, r.message, r.status);
      return send(res, 200, { ok: true, status: r.status, message: r.message });
    }

    // ── requests: capabilities the MCP is missing (agents, people, auto-captured) ──
    if (path === '/api/gaps' && method === 'GET') {
      requireUser(ctx);
      if (!deps.pool) return send(res, 200, { gaps: [], counts: {}, uncovered: [], available: false });
      const url = new URL(req.url ?? '/', 'http://x');
      const status = (url.searchParams.get('status') ?? '').split(',').filter((x) => (GAP_STATUSES as readonly string[]).includes(x));
      const st = new GapStore(deps.pool);
      const [gaps, counts] = await Promise.all([st.list({ ...(status.length ? { status } : {}), ...(url.searchParams.get('q') ? { search: url.searchParams.get('q')! } : {}) }), st.counts()]).catch((e) => {
        if (/capability_gap/.test(String(e))) throw new HttpError(503, 'The Requests table is missing — run the migrations (0014).', 'migration');
        throw e;
      });
      // raw_request shapes no tool covers (last 7 days) — candidates the server saw but nobody reported.
      const g = toolGapReport(168) as { raw: Array<{ shape: string; calls: number; errors: number; coveredBy: string | null; lastAt: string; callers: Array<{ caller: string; count: number }> }> };
      return send(res, 200, { gaps, counts, uncovered: g.raw.filter((r) => !r.coveredBy).slice(0, 25), statuses: GAP_STATUSES, priorities: GAP_PRIORITIES, available: true });
    }
    if (path === '/api/gaps' && method === 'POST') {
      const u = requireUser(ctx);
      if (!deps.pool) throw new HttpError(503, 'Needs Postgres.');
      const b = await readJson(req, 16 * 1024);
      const title = String(b.title ?? '').trim();
      if (title.length < 8) throw new HttpError(400, 'Say in one line what is missing (at least 8 characters).', 'invalid');
      const priority = (GAP_PRIORITIES as readonly string[]).includes(String(b.priority)) ? String(b.priority) as GapPriority : 'normal';
      const r = await new GapStore(deps.pool).report({ title, detail: b.detail ? String(b.detail) : null, source: 'console', reporter: u.username, toolTried: b.toolTried ? String(b.toolTried) : null, priority, ...(b.dedupeKey ? { dedupeKey: String(b.dedupeKey).slice(0, 200) } : {}) });
      void log(ctx, 'gap.reported', { id: r.gap.id, title: r.gap.title, created: r.created });
      return send(res, 200, { ok: true, id: r.gap.id, created: r.created });
    }
    const gapMatch = /^\/api\/gaps\/(\d+)$/.exec(path);
    if (gapMatch && method === 'PATCH') {
      requireUser(ctx, 'admin');
      if (!deps.pool) throw new HttpError(503, 'Needs Postgres.');
      const b = await readJson(req, 16 * 1024);
      if (b.status != null && !(GAP_STATUSES as readonly string[]).includes(String(b.status))) throw new HttpError(400, `status: ${GAP_STATUSES.join(' | ')}`, 'invalid');
      if (b.priority != null && !(GAP_PRIORITIES as readonly string[]).includes(String(b.priority))) throw new HttpError(400, `priority: ${GAP_PRIORITIES.join(' | ')}`, 'invalid');
      const g = await new GapStore(deps.pool).update(Number(gapMatch[1]), {
        ...(b.status != null ? { status: String(b.status) as GapStatus } : {}), ...(b.priority != null ? { priority: String(b.priority) as GapPriority } : {}),
        ...(b.resolution !== undefined ? { resolution: b.resolution == null ? null : String(b.resolution) } : {}), by: ctx.user!.username,
      });
      if (!g) throw new HttpError(404, 'No such request.');
      void log(ctx, 'gap.updated', { id: g.id, status: g.status, priority: g.priority });
      return send(res, 200, { ok: true, gap: g });
    }

    if (path === '/api/users' && method === 'GET') { requireUser(ctx, 'admin'); return send(res, 200, { users: (await store.listUsers()).map(publicUser) }); }
    if (path === '/api/users' && method === 'POST') {
      requireUser(ctx, 'admin');
      const b = await readJson(req, 8 * 1024);
      const username = String(b.username ?? '').trim(), role = b.role;
      if (!validUsername(username)) throw new HttpError(400, 'Usernames are 2–64 characters: letters, digits, dot, dash, underscore or @.', 'invalid');
      if (role !== 'admin' && role !== 'viewer') throw new HttpError(400, 'Role must be admin or viewer.', 'invalid');
      if (await store.findForLogin(username)) throw new HttpError(409, `User "${username}" already exists.`, 'exists');
      const password = generatePassword();
      const u = await store.createUser(username, password, role, ctx.user!.username, true);
      void log(ctx, 'user.created', { username, role });
      return send(res, 201, { user: publicUser(u), password });
    }
    const userMatch = /^\/api\/users\/(\d+)(\/reset-password|\/sign-out|\/autotask)?$/.exec(path);
    if (userMatch) {
      const me = requireUser(ctx, 'admin');
      const id = idParam(userMatch[1]);
      const target = await store.getUser(id);
      if (!target) throw new HttpError(404, 'No such user.');
      const action = userMatch[2];
      if (action === '/reset-password' && method === 'POST') {
        const password = generatePassword();
        await store.setPassword(id, password, true, id === me.id ? ctx.sessionHash ?? undefined : undefined);
        void log(ctx, 'user.password_reset', { username: target.username });
        return send(res, 200, { user: publicUser({ ...target, mustChangePassword: true }), password });
      }
      if (action === '/autotask' && method === 'PUT') {
        // Link the console user to the Autotask resource they are (by email or id), or unlink. Their own access tokens
        // follow the link: a token for the old resource stops working at once.
        const b = await readJson(req, 4 * 1024);
        let link: { id: number; name: string } | null = null;
        if (b.unlink !== true) {
          const email = String(b.email ?? '').trim(), rid = b.resourceId == null || b.resourceId === '' ? null : Number(b.resourceId);
          const nameOf = (r: { firstName?: string; lastName?: string; email?: string; id: number }) => [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email || `Resource ${r.id}`;
          if (rid != null) {
            if (!Number.isInteger(rid) || rid <= 0) throw new HttpError(400, 'The Autotask resource id must be a whole number.', 'invalid');
            const r = await runJob('admin console', () => opts.service.getResource(rid));
            if (!r || (r as { isActive?: boolean }).isActive === false) throw new HttpError(404, `No active Autotask resource #${rid}.`, 'not_found');
            link = { id: rid, name: nameOf(r as never) };
          } else if (email) {
            const found = await runJob('admin console', () => opts.service.searchResourcesByEmail(email));
            if (found.length !== 1) throw new HttpError(found.length ? 409 : 404, found.length ? `${found.length} active Autotask resources have that email — link by resource id.` : 'No active Autotask resource has that email.', found.length ? 'ambiguous' : 'not_found');
            link = { id: found[0]!.id, name: nameOf(found[0]!) };
          } else throw new HttpError(400, 'Give the Autotask email or resource id (or unlink).', 'invalid');
        }
        const u = await store.setAutotaskLink(id, link);
        clearTokenCache();
        void log(ctx, link ? 'user.autotask_linked' : 'user.autotask_unlinked', { username: target.username, ...(link ? { resourceId: link.id } : {}) });
        return send(res, 200, { user: publicUser(u!) });
      }
      if (action === '/sign-out' && method === 'POST') {
        await store.deleteSessionsOf(id);
        void log(ctx, 'user.signed_out', { username: target.username });
        return send(res, 200, { ok: true });
      }
      if (!action && method === 'PATCH') {
        const b = await readJson(req, 8 * 1024);
        const patch: { role?: AdminRole; disabled?: boolean } = {};
        if (b.role !== undefined) { if (b.role !== 'admin' && b.role !== 'viewer') throw new HttpError(400, 'Role must be admin or viewer.', 'invalid'); patch.role = b.role; }
        if (b.disabled !== undefined) { if (typeof b.disabled !== 'boolean') throw new HttpError(400, 'disabled must be true or false.', 'invalid'); patch.disabled = b.disabled; }
        const losesAdmin = target.role === 'admin' && !target.disabled && ((patch.role && patch.role !== 'admin') || patch.disabled === true);
        if (losesAdmin && (await store.otherActiveAdmins(id)) === 0) throw new HttpError(409, 'This is the last active administrator. Make someone else an administrator first.', 'last_admin');
        if (id === me.id && patch.disabled) throw new HttpError(409, 'You cannot disable your own account.', 'self');
        const u = await store.updateUser(id, patch);
        if (patch.disabled !== undefined) clearTokenCache(); // a disabled user's own tokens stop at once
        void log(ctx, 'user.updated', { username: target.username, ...patch });
        return send(res, 200, { user: u ? publicUser(u) : null });
      }
      if (!action && method === 'DELETE') {
        if (id === me.id) throw new HttpError(409, 'You cannot delete your own account.', 'self');
        if (target.role === 'admin' && !target.disabled && (await store.otherActiveAdmins(id)) === 0) throw new HttpError(409, 'This is the last active administrator.', 'last_admin');
        await store.deleteUser(id);
        void log(ctx, 'user.deleted', { username: target.username });
        return send(res, 200, { ok: true });
      }
    }

    if (path === '/api/events' && method === 'GET') {
      requireUser(ctx, 'admin');
      const u = new URL(req.url ?? '/', 'http://x');
      const before = Number(u.searchParams.get('before')) || undefined;
      return send(res, 200, { events: await store.listEvents(Number(u.searchParams.get('limit')) || 200, before) });
    }

    throw new HttpError(404, 'Not found.');
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://admin.local');
    const method = (req.method ?? 'GET').toUpperCase();
    const ctx: Ctx = { req, res, ip: clientIp(req, trustProxy), secure: isHttps(req, cookieMode), user: null, sessionHash: null };
    try {
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (url.pathname.startsWith('/api/')) {
        const token = readCookie(req);
        if (token) {
          const s = await store.sessionUser(token);
          if (s) { ctx.user = s.user; ctx.sessionHash = s.tokenHash; }
        }
        return await api(ctx, method, url.pathname);
      }
      const file = statics.get(url.pathname);
      if (file && (method === 'GET' || method === 'HEAD')) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': file.type, 'Cache-Control': url.pathname === '/' || url.pathname.endsWith('.html') ? 'no-store' : 'no-cache' });
        res.end(method === 'HEAD' ? undefined : file.body);
        return;
      }
      if (!statics.size && url.pathname === '/') return send(res, 500, { error: 'Admin UI files are missing from this build (admin-ui/).' });
      send(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
      const msg = err instanceof Error ? err.message : String(err);
      // Most likely cause on a fresh install: migration 0004 not applied yet.
      if (/relation "admin_/.test(msg)) return send(res, 503, { error: 'The admin tables are missing — run the database migrations (node dist/db/migrate.js).', code: 'migrations' });
      opts.logger.error('admin console error', err);
      send(res, 500, { error: 'Internal error.' });
    }
  };
}

// What /health reports about the console, so a deploy can confirm it survived.
let state: { port: number; schemaReady: boolean; lastLoadError: string | null } | null = null;

/** Compact console status for /health: null when the console is not configured. */
export function adminHealth(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (!isAdminEnabled(env)) return null;
  if (!state) return { enabled: true, running: false };
  return { enabled: true, running: true, port: state.port, schemaReady: state.schemaReady, ...(state.lastLoadError ? { error: state.lastLoadError } : {}) };
}

/** Start the console listener (no-op unless MCP_ADMIN_ENABLED=true and Postgres is configured). */
export async function startAdminConsole(opts: AdminConsoleOptions): Promise<AdminConsole | null> {
  const env = opts.env ?? process.env;
  if (!isAdminEnabled(env)) return null;
  if (!isPgEnabled(env)) {
    opts.logger.error('MCP_ADMIN_ENABLED=true but the Postgres layer is off (MCP_PG_ENABLED) — the admin console needs it for users and settings. Console not started.');
    return null;
  }
  const pool = getPool(opts.logger, env);
  if (!pool) return null;
  const store = new AdminStore(pool);
  // The tool-group setting can only name groups that exist.
  const cats = settingDef('tools.disabledCategories');
  if (cats) cats.choices = toolCategoryNames();

  const reload = async () => {
    try {
      const saved = await store.loadSettings();
      // Notification channels live beside the settings but aren't one (their URLs are secrets).
      getNotifier().setChannels(parseStoredChannels(saved[NOTIFY_SETTING_KEY]));
      delete saved[NOTIFY_SETTING_KEY];
      const dropped = loadOverrides(saved);
      if (dropped.length) opts.logger.warn(`admin: ignored invalid saved setting(s): ${dropped.join(', ')}`);
      applySettings();
      if (state) { state.schemaReady = true; state.lastLoadError = null; }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (state) { state.schemaReady = !/relation "admin_/.test(msg); state.lastLoadError = /relation "admin_/.test(msg) ? 'admin tables missing: run the migrations' : msg; }
      opts.logger.warn(/relation "admin_/.test(msg) ? 'admin: settings table missing — run the database migrations' : `admin: could not load settings (${msg})`);
    }
  };
  state = { port: Number(env.MCP_ADMIN_PORT) || 8090, schemaReady: false, lastLoadError: null };
  await reload();
  // Pick up changes made by the CLI or another instance.
  const timer = setInterval(() => { void reload(); }, 60_000);
  timer.unref?.();

  const handler = adminHandler({ store, pool, opts, startedAt: Date.now() });
  const server: HttpServer = createServer((req, res) => { void handler(req, res); });
  const port = Number(env.MCP_ADMIN_PORT) || 8090;
  const host = env.MCP_ADMIN_HOST || '0.0.0.0';
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, host, () => ok()); });
  const users = await store.countUsers().catch(() => null);
  opts.logger.info(`Admin console listening on http://${host}:${port}/` + (users === 0 ? ' — no users yet: run `node dist/admin/cli.js init` to create the first administrator' : ''));
  return {
    port,
    stop: () => new Promise<void>((ok) => { clearInterval(timer); state = null; server.close(() => ok()); }),
  };
}
