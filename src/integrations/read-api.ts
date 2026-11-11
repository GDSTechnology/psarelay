// /api/v1 — the read API other systems (time / CRM modules) call instead of Autotask. Answered from the Postgres
// mirror; a read the mirror can't answer goes to Autotask only when the key allows it, inside its hourly live cap,
// and never while the tenant is under backpressure "stop". Requests and responses use Autotask's REST shapes, so an
// Autotask client only changes its base URL and key:
//
//   GET  /api/v1                       what this key may read, and how fresh each entity's copy is
//   POST /api/v1/{Entity}/query        { filter, MaxRecords?, IncludeFields? } → { items, pageDetails, hasMore }
//   GET  /api/v1/{Entity}/{id}         → { item }  (item null when the record is not there)
//
// Every answer carries X-PSArelay-Source (mirror | live) and, from the mirror, X-PSArelay-Age (seconds). Rows come
// in ascending id order; page with { op: "gt", field: "id", value: <last id> } while hasMore is true.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken } from '../security/tokens.js';
import { isExternalRequest } from '../security/http.js';
import { shadowEntity } from '../db/shadow-entities.js';
import type { MirrorGetResult, MirrorQueryResult } from '../db/shadow-runtime.js';
import type { ShadowFilter } from '../db/shadow-sql.js';
import type { Freshness } from '../db/shadow-store.js';
import type { ApiKeyAuth, ApiKeyStore } from './api-keys.js';
import type { Logger } from '../utils/logger.js';

export const API_BASE = '/api/v1';
const MAX_PAGE = 500;
const BODY_LIMIT = 64 * 1024;
const OPS = new Set(['eq', 'noteq', 'gt', 'gte', 'lt', 'lte', 'beginsWith', 'endsWith', 'contains', 'exist', 'notExist', 'in', 'notIn', 'and', 'or']);
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;

export interface LiveClient {
  rawRequest<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  get<T>(entity: string, id: number): Promise<T | null>;
}
export interface ReadApiDeps {
  keys: Pick<ApiKeyStore, 'verify' | 'current' | 'record'> | null;
  mirror: {
    query(entity: string, filters: ShadowFilter[], limit: number): Promise<MirrorQueryResult<Record<string, unknown>>>;
    get(entity: string, id: number): Promise<MirrorGetResult>;
    freshness(entity: string): Promise<Freshness | null>;
  };
  live: () => Promise<LiveClient>;
  /** The tenant's backpressure verdict (services/backpressure). */
  pressure: () => { level: 'ok' | 'slow' | 'stop'; retryAfterSeconds: number | null };
  logger?: Logger;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}, readonly headers: Record<string, string> = {}) { super(message); }
}

const MISS_TEXT: Record<string, string> = {
  mirror_off: 'the mirror is not running', not_mirrored: 'this entity is not mirrored', not_ready: 'the mirror has not finished its first copy',
  stale: 'the mirror copy is older than its freshness limit', recently_written: 'PSArelay just changed this record; the mirror re-reads it on the next sync',
  outside_window: 'the filter reaches further back than the mirrored history', unknown_field: 'a filter field is not in the mirror',
  error: 'the mirror could not run this filter', not_in_mirror: 'the record is not in the mirror', live_cap: "this key's hourly live-call cap is used up", live_off: 'this key is mirror-only',
  pressure: 'Autotask is under load (backpressure: stop)',
};

/** Validate an Autotask filter: known ops, safe field names, bounded size and depth. */
export function validateFilter(f: unknown): ShadowFilter[] {
  if (f == null) return [];
  if (!Array.isArray(f)) throw new ApiError(400, '"filter" must be an array of Autotask filter objects.');
  let count = 0;
  const walk = (items: unknown[], depth: number): ShadowFilter[] => items.map((x) => {
    if (++count > 100) throw new ApiError(400, 'A filter may have at most 100 conditions.');
    if (depth > 4) throw new ApiError(400, 'Filters nest at most 4 levels deep.');
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new ApiError(400, 'Each filter is an object { op, field, value }.');
    const o = x as Record<string, unknown>;
    const op = String(o.op ?? '');
    if (!OPS.has(op)) throw new ApiError(400, `Unknown filter op "${op}".`);
    if (op === 'and' || op === 'or') {
      if (!Array.isArray(o.items) || !o.items.length) throw new ApiError(400, `"${op}" needs a non-empty "items" array.`);
      return { op, items: walk(o.items, depth + 1) };
    }
    if (typeof o.field !== 'string' || !FIELD.test(o.field)) throw new ApiError(400, 'Each condition needs a "field" (letters, digits, underscore).');
    const out: ShadowFilter = { op, field: o.field };
    if (o.value !== undefined) {
      const v = o.value;
      const scalar = (y: unknown) => y === null || ['string', 'number', 'boolean'].includes(typeof y);
      if (!(scalar(v) || (Array.isArray(v) && v.length <= 500 && v.every(scalar)))) throw new ApiError(400, `Filter value for "${o.field}" must be a string, number, boolean or a list of them.`);
      out.value = v;
    }
    if (o.udf === true) out.udf = true;
    return out;
  });
  return walk(f, 0);
}

function includeFields(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v) || v.length > 200 || !v.every((x) => typeof x === 'string' && FIELD.test(x))) throw new ApiError(400, '"IncludeFields" must be a list of field names.');
  return v.length ? (v as string[]) : undefined;
}
const project = (rows: Array<Record<string, unknown>>, fields?: string[]) => {
  if (!fields) return rows;
  const keep = new Set([...fields, 'id']);
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))));
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_LIMIT) throw new ApiError(413, `The request body is limited to ${BODY_LIMIT / 1024} KB.`);
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error();
    return b as Record<string, unknown>;
  } catch { throw new ApiError(400, 'The body must be a JSON object.'); }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}
const secondsToNextHour = () => 3600 - Math.floor((Date.now() % 3_600_000) / 1000);

export async function handleReadApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: ReadApiDeps): Promise<void> {
  let key: ApiKeyAuth | null = null;
  try {
    if (!deps.keys) throw new ApiError(503, 'The integration API needs the Postgres layer (MCP_PG_ENABLED).');
    const presented = bearerToken(req.headers.authorization);
    key = presented ? await deps.keys.verify(presented) : null;
    if (!key) throw new ApiError(401, 'Send a valid API key: Authorization: Bearer psk_… (Admin console → Integrations).', {}, { 'WWW-Authenticate': 'Bearer realm="psarelay-api"' });
    if (!key.allowExternal && isExternalRequest(req)) throw new ApiError(403, 'This key is limited to the private network. Allow outside use on the Integrations page if that is intended.');
    if (deps.keys.current(key.id).total >= key.hourlyLimit) {
      const wait = secondsToNextHour();
      throw new ApiError(429, `This key's hourly cap (${key.hourlyLimit} requests) is used up.`, { retryAfterSeconds: wait }, { 'Retry-After': String(wait) });
    }

    const path = url.pathname.replace(/\/+$/, '');
    const method = req.method ?? 'GET';
    if (path === API_BASE && method === 'GET') return await info(res, key, deps);
    const q = /^\/api\/v1\/([A-Za-z]+)\/query$/.exec(path);
    const g = /^\/api\/v1\/([A-Za-z]+)\/(\d{1,15})$/.exec(path);
    if (!q && !g) throw new ApiError(404, `Not found. Endpoints: GET ${API_BASE}, POST ${API_BASE}/{Entity}/query, GET ${API_BASE}/{Entity}/{id}.`);
    if (q && method !== 'POST') throw new ApiError(405, 'Queries are POST, with an Autotask filter body.', {}, { Allow: 'POST' });
    if (g && method !== 'GET') throw new ApiError(405, 'This API is read-only.', {}, { Allow: 'GET' });
    const def = shadowEntity((q ?? g)![1]!);
    if (!def || !key.entities.includes(def.name)) throw new ApiError(403, `This key may not read "${(q ?? g)![1]}". It may read: ${key.entities.join(', ')}.`);
    return q ? await query(req, res, key, def.name, deps) : await getOne(res, key, def.name, Number(g![2]), deps);
  } catch (err) {
    if (key) deps.keys?.record(key.id, 'refused');
    if (err instanceof ApiError) return send(res, err.status, { error: err.message, ...err.extra }, err.headers);
    deps.logger?.error('Integration API request failed', err);
    return send(res, 500, { error: 'Internal error.' });
  }
}

async function info(res: ServerResponse, key: ApiKeyAuth, deps: ReadApiDeps): Promise<void> {
  const entities = await Promise.all(key.entities.map(async (name) => {
    const f = await deps.mirror.freshness(name).catch(() => null);
    return { name, ready: !!f?.ready, ageSeconds: f?.ageSeconds ?? null, rows: f?.rows ?? null, historyFrom: f?.windowFrom ?? null };
  }));
  deps.keys!.record(key.id, 'mirror');
  send(res, 200, { key: { name: key.name, allowLive: key.allowLive, hourlyLimit: key.hourlyLimit, liveHourlyLimit: key.liveHourlyLimit, usedThisHour: deps.keys!.current(key.id) }, entities });
}

/** Whether a mirror miss may go to Autotask; throws the 503 the caller gets when it may not. */
function mayGoLive(key: ApiKeyAuth, miss: string, deps: ReadApiDeps): void {
  const refuse = (why: string, wait: number) => {
    throw new ApiError(503, `The mirror can't answer this (${MISS_TEXT[miss] ?? miss}) and it was not sent to Autotask: ${MISS_TEXT[why]}.`, { reason: miss, live: why, retryAfterSeconds: wait }, { 'Retry-After': String(wait), 'X-PSArelay-Mirror-Miss': miss });
  };
  if (!key.allowLive) refuse('live_off', 60);
  if (deps.keys!.current(key.id).live >= key.liveHourlyLimit) refuse('live_cap', secondsToNextHour());
  const p = deps.pressure();
  if (p.level === 'stop') refuse('pressure', p.retryAfterSeconds ?? 60);
}

async function liveCall<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ApiError(/429|rate.?limit|cooldown/i.test(msg) ? 503 : 502, `Autotask answered with an error: ${msg.slice(0, 300)}`, {}, { 'X-PSArelay-Source': 'live' });
  }
}

async function query(req: IncomingMessage, res: ServerResponse, key: ApiKeyAuth, entity: string, deps: ReadApiDeps): Promise<void> {
  const b = await readBody(req);
  const filter = validateFilter(b.filter);
  const fields = includeFields(b.IncludeFields ?? b.includeFields);
  const raw = b.MaxRecords ?? b.maxRecords;
  const limit = raw == null ? MAX_PAGE : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new ApiError(400, `MaxRecords is 1–${MAX_PAGE}.`);

  const m = await deps.mirror.query(entity, filter, limit + 1);
  if (m.ok) {
    const hasMore = m.rows.length > limit;
    const items = project(m.rows.slice(0, limit), fields);
    deps.keys!.record(key.id, 'mirror');
    return send(res, 200, { items, pageDetails: { count: items.length, requestCount: limit, prevPageUrl: null, nextPageUrl: null }, hasMore },
      { 'X-PSArelay-Source': 'mirror', 'X-PSArelay-Age': String(m.ageSeconds) });
  }
  mayGoLive(key, m.reason, deps);
  const http = await deps.live();
  deps.keys!.record(key.id, 'live'); // counted before the call: a failed Autotask call still spent the budget
  const r = await liveCall(() => http.rawRequest<{ items?: Array<Record<string, unknown>>; pageDetails?: { nextPageUrl?: string | null } }>('POST', `/${entity}/query`,
    { filter: filter.length ? filter : [{ op: 'gte', field: 'id', value: 0 }], MaxRecords: limit, ...(fields ? { IncludeFields: fields } : {}) }));
  const items = project(r?.items ?? [], fields);
  send(res, 200, { items, pageDetails: { count: items.length, requestCount: limit, prevPageUrl: null, nextPageUrl: null }, hasMore: !!r?.pageDetails?.nextPageUrl },
    { 'X-PSArelay-Source': 'live', 'X-PSArelay-Mirror-Miss': m.reason });
}

async function getOne(res: ServerResponse, key: ApiKeyAuth, entity: string, id: number, deps: ReadApiDeps): Promise<void> {
  const m = await deps.mirror.get(entity, id);
  // Not in the mirror: with live allowed, ask Autotask (the row may be newer than the last sync); otherwise say so.
  if (m.ok && (m.row != null || !key.allowLive)) {
    deps.keys!.record(key.id, 'mirror');
    return send(res, 200, { item: m.row }, { 'X-PSArelay-Source': 'mirror', 'X-PSArelay-Age': String(m.ageSeconds) });
  }
  const reason = m.ok ? 'not_in_mirror' : m.reason;
  mayGoLive(key, reason, deps);
  const http = await deps.live();
  deps.keys!.record(key.id, 'live');
  const item = await liveCall(() => http.get<Record<string, unknown>>(entity, id));
  send(res, 200, { item: item ?? null }, { 'X-PSArelay-Source': 'live', 'X-PSArelay-Mirror-Miss': reason });
}
