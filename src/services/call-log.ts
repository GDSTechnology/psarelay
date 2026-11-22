// Recent-calls log for diagnostics (admin console "Calls" page): the last tool
// calls (who called, outcome, duration, how many Autotask calls each made) and
// the last Autotask API calls (status, duration, which tool call caused them —
// or which background job).
//
// In memory only, bounded ring buffers (reset on restart). Never records tool
// arguments or response bodies: tool name, caller, outcome, timings, and a
// truncated error message only. Autotask paths are logged without host or
// query string.

import { AsyncLocalStorage } from 'node:async_hooks';
import { settingValue } from '../admin/settings.js';

export interface ToolCallRecord {
  id: number;
  at: string;
  tool: string;
  /** 'running' until the call finishes. */
  outcome: string;
  durationMs: number | null;
  /** Declared source, or the console's caller name for an undeclared client (see named). */
  source: string | null;
  /** True when source came from a "Caller names" rule rather than the client itself. */
  named?: boolean;
  user: string | null;
  ip: string | null;
  userAgent: string | null;
  error: string | null;
  /** Autotask calls this tool call sent upstream / answered from the read cache / from the Postgres shadow. */
  apiCalls: number;
  cacheHits: number;
  shadowReads: number;
  /** For autotask_raw_request: what it did, e.g. "POST /Tickets/query". */
  raw?: string;
}

export interface ApiCallRecord {
  id: number;
  at: string;
  method: string;
  path: string;
  /** HTTP status; 0 = network error / timeout. */
  status: number | null;
  durationMs: number | null;
  /** The tool call that caused it, if any. */
  toolCallId: number | null;
  tool: string | null;
  /** Background job that caused it (e.g. "shadow sync"), when not a tool call. */
  job: string | null;
  error: string | null;
}

const MAX_TOOLS = 500;
const MAX_API = 2000;
const tools: ToolCallRecord[] = [];
const api: ApiCallRecord[] = [];
let nextTool = 1, nextApi = 1;

type Scope = { tool?: ToolCallRecord; job?: string };
const scope = new AsyncLocalStorage<Scope>();

/** Who is calling, for the per-caller concurrency cap: the tool call's source + user; null for background work. */
export function currentCaller(): string | null {
  const t = scope.getStore()?.tool;
  if (!t) return null;
  return `${t.source ?? 'unknown'}|${t.user ?? t.ip ?? ''}`;
}

const push = <T>(arr: T[], v: T, max: number) => { arr.push(v); if (arr.length > max) arr.splice(0, arr.length - max); };
const clip = (s: string | undefined | null, n = 300): string | null => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

/** Autotask path for the log: no host, no zone prefix, no query string. */
export function cleanPath(path: string): string {
  let p = path;
  if (p.startsWith('http')) { try { p = new URL(p).pathname; } catch { /* keep */ } }
  p = p.split('?')[0]!.replace(/^.*?\/v1\.0/i, '');
  return p.startsWith('/') ? p : `/${p}`;
}

/** Run one tool call with its log record in scope. */
export async function runToolCall<T extends { isError?: boolean }>(tool: string, fn: () => Promise<T>): Promise<T> {
  const rec: ToolCallRecord = { id: nextTool++, at: new Date().toISOString(), tool, outcome: 'running', durationMs: null, source: null, user: null, ip: null, userAgent: null, error: null, apiCalls: 0, cacheHits: 0, shadowReads: 0 };
  push(tools, rec, MAX_TOOLS);
  const started = Date.now();
  try {
    const r = await scope.run({ tool: rec }, fn);
    if (rec.outcome === 'running') rec.outcome = r?.isError ? 'error' : 'ok';
    return r;
  } catch (err) {
    rec.outcome = 'error';
    rec.error ??= clip(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    rec.durationMs ??= Date.now() - started;
    if (rec.raw) noteGap(rec);
  }
}

// ── tool gaps: raw_request use and fallbacks ────────────────────────────────
// autotask_raw_request is the escape hatch: a caller reaches for it when no
// tool does the job, or after a tool failed. Tallied per request shape for 24 h
// (who, how often, failures), plus "fallbacks": a tool failed and the same
// caller used raw_request within FALLBACK_WINDOW_MS — a strong sign that tool
// is missing something.

/** Request shape: method + path with ids generalised and no query string — "PATCH /Tickets", "GET /Tickets/{id}/Notes". */
export function rawShape(method: string, path: string): string {
  const p = cleanPath(String(path ?? '')).split('/').filter(Boolean).map((s) => (/^\d+$/.test(s) ? '{id}' : s)).join('/');
  return `${String(method ?? '').toUpperCase()} /${p}`;
}

/** Called by the raw_request tool before it runs. */
export function noteRawRequest(method: string, path: string): void {
  const r = scope.getStore()?.tool;
  if (r) r.raw = rawShape(method, path);
}

const FALLBACK_WINDOW_MS = 10 * 60_000;
interface GapCounts { calls: number; errors: number; callers: Map<string, number>; lastAt: string; lastError: string | null }
interface FallbackCounts { count: number; lastAt: string; lastError: string | null }
const gapBuckets = new Map<number, Map<string, GapCounts>>();
const fallbackBuckets = new Map<number, Map<string, FallbackCounts>>();
const callerKey = (r: ToolCallRecord) => `${r.source ?? 'unknown'}|${r.ip ?? ''}|${r.userAgent ?? ''}`;
const callerLabel = (r: ToolCallRecord) => [r.source ?? 'unknown', r.ip, r.userAgent].filter(Boolean).join(' · ');

function hourBucket<T>(buckets: Map<number, Map<string, T>>): Map<string, T> {
  const hour = Math.floor(Date.now() / 3_600_000);
  let b = buckets.get(hour);
  if (!b) { b = new Map(); buckets.set(hour, b); for (const h of buckets.keys()) if (h <= hour - HOURS) buckets.delete(h); }
  return b;
}

function noteGap(rec: ToolCallRecord): void {
  const shape = rec.raw!;
  const failed = isErr(rec.outcome);
  const g = hourBucket(gapBuckets);
  const c = g.get(shape) ?? { calls: 0, errors: 0, callers: new Map(), lastAt: rec.at, lastError: null };
  c.calls++; if (failed) { c.errors++; c.lastError = rec.error; }
  c.lastAt = rec.at;
  const who = callerLabel(rec);
  c.callers.set(who, (c.callers.get(who) ?? 0) + 1);
  g.set(shape, c);
  // Fallback: the same caller's most recent failed (non-raw) tool call, shortly before.
  const key = callerKey(rec), at = Date.parse(rec.at);
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i]!;
    if (t.id >= rec.id) continue;
    if (at - Date.parse(t.at) > FALLBACK_WINDOW_MS) break;
    if (callerKey(t) !== key) continue;
    if (t.raw) break; // that earlier raw_request already answered for any failure before it
    if (isErr(t.outcome)) {
      const f = hourBucket(fallbackBuckets);
      const fk = `${t.tool}|${shape}`;
      const fc = f.get(fk) ?? { count: 0, lastAt: rec.at, lastError: null };
      fc.count++; fc.lastAt = rec.at; fc.lastError = t.error;
      f.set(fk, fc);
    }
    break; // only the call right before counts
  }
}

export interface ToolGapStats {
  since: string;
  raw: Array<{ shape: string; calls: number; errors: number; lastAt: string; lastError: string | null; callers: Array<{ caller: string; count: number }> }>;
  fallbacks: Array<{ failedTool: string; thenRaw: string; count: number; lastAt: string; lastError: string | null }>;
}

/** raw_request use and fallbacks over the last `hours` (max 24). */
export function toolGapStats(hours = 24): ToolGapStats {
  const h = Math.min(Math.max(Math.floor(hours), 1), HOURS);
  const now = Math.floor(Date.now() / 3_600_000);
  const raw = new Map<string, GapCounts>();
  for (const [hour, b] of gapBuckets) {
    if (hour <= now - h) continue;
    for (const [shape, c] of b) {
      const a = raw.get(shape) ?? { calls: 0, errors: 0, callers: new Map(), lastAt: c.lastAt, lastError: null };
      a.calls += c.calls; a.errors += c.errors;
      if (c.lastAt >= a.lastAt) { a.lastAt = c.lastAt; a.lastError = c.lastError ?? a.lastError; }
      for (const [k, v] of c.callers) a.callers.set(k, (a.callers.get(k) ?? 0) + v);
      raw.set(shape, a);
    }
  }
  const fb = new Map<string, FallbackCounts>();
  for (const [hour, b] of fallbackBuckets) {
    if (hour <= now - h) continue;
    for (const [k, c] of b) {
      const a = fb.get(k) ?? { count: 0, lastAt: c.lastAt, lastError: null };
      a.count += c.count; if (c.lastAt >= a.lastAt) { a.lastAt = c.lastAt; a.lastError = c.lastError; }
      fb.set(k, a);
    }
  }
  return {
    since: new Date((now - h + 1) * 3_600_000).toISOString(),
    raw: [...raw.entries()].map(([shape, c]) => ({ shape, calls: c.calls, errors: c.errors, lastAt: c.lastAt, lastError: c.lastError,
      callers: [...c.callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([caller, count]) => ({ caller, count })) })).sort((a, b) => b.calls - a.calls),
    fallbacks: [...fb.entries()].map(([k, c]) => { const [failedTool, thenRaw] = k.split('|'); return { failedTool: failedTool!, thenRaw: thenRaw!, count: c.count, lastAt: c.lastAt, lastError: c.lastError }; }).sort((a, b) => b.count - a.count),
  };
}

// ── tenant traffic NOT through this MCP ────────────────────────────────────
// Autotask's ThresholdInformation counts the whole database's requests in its
// current window (all integrations); this MCP counts its own upstream calls.
// The difference estimates traffic that never went through the MCP (e.g. n8n
// nodes with their own Autotask credentials). Sampled whenever usage is read
// (the shadow does so every run), kept for 24 h.
interface UsageSample { at: number; tenantUsed: number; limit: number | null; windowMinutes: number | null; mcp: number; mcpSince?: number }
const usageSamples: UsageSample[] = [];

export function noteTenantUsage(s: { tenantUsed: number | null; limit: number | null; windowMinutes: number | null; mcpLastHour: number; mcpCountingSince?: number }): void {
  if (s.tenantUsed == null) return;
  usageSamples.push({ at: Date.now(), tenantUsed: s.tenantUsed, limit: s.limit, windowMinutes: s.windowMinutes, mcp: s.mcpLastHour, ...(s.mcpCountingSince ? { mcpSince: s.mcpCountingSince } : {}) });
  const cutoff = Date.now() - 24 * 3_600_000;
  while (usageSamples.length && usageSamples[0]!.at < cutoff) usageSamples.shift();
}

/** The most recent tenant usage reading (taken whenever usage is read — the shadow sync does so every run). No Autotask call. */
export function latestTenantUsage(): { at: string; used: number; limit: number | null; usedPct: number | null; windowMinutes: number | null } | null {
  const s = usageSamples[usageSamples.length - 1];
  if (!s) return null;
  return { at: new Date(s.at).toISOString(), used: s.tenantUsed, limit: s.limit, usedPct: s.limit ? Math.round((s.tenantUsed / s.limit) * 1000) / 10 : null, windowMinutes: s.windowMinutes };
}

export interface OutsideTraffic { at: string; tenantCalls: number; mcpCalls: number; otherCalls: number; otherPct: number; windowMinutes: number | null; samples24h: number; otherMax24h: number; otherAvg24h: number;
  /** The MCP started counting less than one window ago (restart): its count is incomplete, the estimate reads high. */
  partial: boolean }

/** Latest estimate of calls on the tenant that did not come from this MCP, or null before the first sample. */
export function outsideTraffic(): OutsideTraffic | null {
  const last = usageSamples[usageSamples.length - 1];
  if (!last) return null;
  const other = (s: UsageSample) => Math.max(0, s.tenantUsed - s.mcp);
  const others = usageSamples.map(other);
  return {
    at: new Date(last.at).toISOString(), tenantCalls: last.tenantUsed, mcpCalls: last.mcp, otherCalls: other(last),
    otherPct: last.tenantUsed ? Math.round((other(last) / last.tenantUsed) * 1000) / 10 : 0,
    windowMinutes: last.windowMinutes, samples24h: usageSamples.length,
    otherMax24h: Math.max(...others), otherAvg24h: Math.round(others.reduce((a, b) => a + b, 0) / others.length),
    partial: last.mcpSince != null && last.at - last.mcpSince < (last.windowMinutes ?? 60) * 60_000,
  };
}

/** Run background work (e.g. the shadow sync) so its Autotask calls are labelled. */
export function runJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
  return scope.run({ job }, fn);
}

/** "Caller names" rule for an undeclared client: IP equal to the pattern, or the pattern inside the user agent. */
export function callerName(ip?: string, userAgent?: string): string | null {
  let rules: string[];
  try { rules = settingValue<string[]>('callers.labels'); } catch { return null; }
  const ua = (userAgent ?? '').toLowerCase();
  for (const r of rules) {
    const i = r.indexOf('=');
    const pattern = r.slice(0, i).trim(), name = r.slice(i + 1).trim();
    if (!pattern || !name) continue;
    if ((ip && ip === pattern) || (ua && ua.includes(pattern.toLowerCase()))) return name;
  }
  return null;
}

/** Fill the current tool call's caller + outcome (from the audit record). */
export function noteToolAudit(info: { outcome: string; durationMs: number; source?: string; user?: string | undefined; ip?: string | undefined; userAgent?: string | undefined; error?: string | undefined }): void {
  const rec = scope.getStore()?.tool;
  if (!rec) return;
  rec.outcome = info.outcome;
  rec.durationMs = info.durationMs;
  const declared = info.source && info.source !== 'unknown' ? info.source : null;
  const name = declared ? null : callerName(info.ip, info.userAgent);
  rec.source = declared ?? name ?? info.source ?? null;
  if (name) rec.named = true;
  rec.user = info.user ?? null;
  rec.ip = info.ip ?? null;
  rec.userAgent = clip(info.userAgent, 120);
  rec.error = clip(info.error);
}

export function noteCacheHit(path?: string): void { const r = scope.getStore()?.tool; if (r) r.cacheHits++; if (path) noteRead(entityOfPath(path), 'cache'); }
export function noteShadowRead(entity?: string): void { const r = scope.getStore()?.tool; if (r) r.shadowReads++; if (entity) noteRead(entity, 'shadow'); }

// ── reads by entity: where each read was answered (cache candidates) ────────
// Hourly buckets for the last 24 h: per entity, how many reads went to Autotask
// vs were answered by the read cache or the Postgres shadow, plus writes, and
// which callers (tool or background job) caused the Autotask reads. Lets an
// operator see what is read heavily but never cached — candidates to mirror.

type ReadSource = 'upstream' | 'cache' | 'shadow' | 'write';
interface EntityCounts { upstream: number; cache: number; shadow: number; write: number; callers: Map<string, number> }
/** Hourly read / gap counts kept: 7 days (persisted in Postgres so they survive restarts — db/call-stats-store.ts). */
const HOURS = 168;
const buckets = new Map<number, Map<string, EntityCounts>>();

/** Top-level entity of an Autotask path ("/Tickets/5/Notes/query" → "Tickets"). */
export function entityOfPath(path: string): string {
  return cleanPath(path).split('/').filter(Boolean)[0] ?? '?';
}

/** A read: GET, or a query POST (incl. continuation pages). */
function isReadCall(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || (m === 'POST' && /\/query(\/|\?|$)/i.test(path));
}

function noteRead(entity: string, source: ReadSource): void {
  if (!entity || entity === '?') return;
  const hour = Math.floor(Date.now() / 3_600_000);
  let b = buckets.get(hour);
  if (!b) {
    b = new Map(); buckets.set(hour, b);
    for (const h of buckets.keys()) if (h <= hour - HOURS) buckets.delete(h);
  }
  let c = b.get(entity);
  if (!c) { c = { upstream: 0, cache: 0, shadow: 0, write: 0, callers: new Map() }; b.set(entity, c); }
  c[source]++;
  if (source === 'upstream') {
    const s = scope.getStore();
    const who = s?.tool?.tool ?? (s?.job ? `job: ${s.job}` : 'other background');
    c.callers.set(who, (c.callers.get(who) ?? 0) + 1);
  }
}

export interface EntityReadStats {
  entity: string;
  /** Reads sent to Autotask. */
  upstream: number;
  /** Reads answered by the read cache (incl. shared in-flight reads). */
  cache: number;
  /** Reads answered by the Postgres shadow. */
  shadow: number;
  writes: number;
  /** Share of reads answered without Autotask, %. */
  localPct: number | null;
  /** Who caused the Autotask reads, busiest first. */
  topCallers: Array<{ caller: string; count: number }>;
}

/** This MCP's Autotask traffic per clock hour (epoch hour), the last 7 days: reads sent upstream and writes. */
export function hourlyActivity(): Array<{ hour: number; upstream: number; writes: number; byTools: number }> {
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([hour, m]) => {
    let upstream = 0, writes = 0, byTools = 0;
    for (const c of m.values()) {
      upstream += c.upstream; writes += c.write;
      // Reads caused by tool calls (people, n8n, agents) — not the mirror sync / verify jobs.
      for (const [who, n] of c.callers) if (!who.startsWith('job: ') && who !== 'other background') byTools += n;
    }
    return { hour, upstream, writes, byTools };
  });
}

/** Reads per entity over the last `hours` (max 168), busiest-upstream first. */
export function entityReadStats(hours = 24): { since: string; entities: EntityReadStats[] } {
  const h = Math.min(Math.max(Math.floor(hours), 1), HOURS);
  const now = Math.floor(Date.now() / 3_600_000);
  const agg = new Map<string, EntityCounts>();
  for (const [hour, b] of buckets) {
    if (hour <= now - h) continue;
    for (const [e, c] of b) {
      const a = agg.get(e) ?? { upstream: 0, cache: 0, shadow: 0, write: 0, callers: new Map() };
      a.upstream += c.upstream; a.cache += c.cache; a.shadow += c.shadow; a.write += c.write;
      for (const [k, v] of c.callers) a.callers.set(k, (a.callers.get(k) ?? 0) + v);
      agg.set(e, a);
    }
  }
  const entities = [...agg.entries()].map(([entity, c]) => {
    const reads = c.upstream + c.cache + c.shadow;
    return {
      entity, upstream: c.upstream, cache: c.cache, shadow: c.shadow, writes: c.write,
      localPct: reads ? Math.round(((c.cache + c.shadow) / reads) * 1000) / 10 : null,
      topCallers: [...c.callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([caller, count]) => ({ caller, count })),
    };
  }).sort((a, b) => b.upstream - a.upstream || b.cache + b.shadow - (a.cache + a.shadow));
  return { since: new Date((now - h + 1) * 3_600_000).toISOString(), entities };
}

/** Start an upstream Autotask call; call the returned function when it ends. */
export function startApiCall(method: string, path: string): (status: number, error?: string) => void {
  const s = scope.getStore();
  const rec: ApiCallRecord = { id: nextApi++, at: new Date().toISOString(), method: method.toUpperCase(), path: cleanPath(path), status: null, durationMs: null, toolCallId: s?.tool?.id ?? null, tool: s?.tool?.tool ?? null, job: s?.job ?? null, error: null };
  push(api, rec, MAX_API);
  if (s?.tool) s.tool.apiCalls++;
  noteRead(entityOfPath(path), isReadCall(method, path) ? 'upstream' : 'write');
  const started = Date.now();
  return (status, error) => { rec.status = status; rec.durationMs = Date.now() - started; rec.error = clip(error, 200); };
}

export interface CallQuery { limit?: number; beforeId?: number; tool?: string; source?: string; errorsOnly?: boolean; toolCallId?: number }

const isErr = (o: string) => o !== 'ok' && o !== 'running' && o !== 'idempotent-replay';

/** Newest first. */
export function recentToolCalls(q: CallQuery = {}): ToolCallRecord[] {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), MAX_TOOLS);
  const tool = q.tool?.toLowerCase();
  const out: ToolCallRecord[] = [];
  for (let i = tools.length - 1; i >= 0 && out.length < limit; i--) {
    const r = tools[i]!;
    if (q.beforeId && r.id >= q.beforeId) continue;
    if (tool && !r.tool.toLowerCase().includes(tool)) continue;
    if (q.source && (r.source ?? 'unknown') !== q.source) continue;
    if (q.errorsOnly && !isErr(r.outcome)) continue;
    out.push({ ...r });
  }
  return out;
}

export function recentApiCalls(q: CallQuery = {}): ApiCallRecord[] {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), MAX_API);
  const tool = q.tool?.toLowerCase();
  const out: ApiCallRecord[] = [];
  for (let i = api.length - 1; i >= 0 && out.length < limit; i--) {
    const r = api[i]!;
    if (q.beforeId && r.id >= q.beforeId) continue;
    if (q.toolCallId && r.toolCallId !== q.toolCallId) continue;
    if (tool && !(r.tool ?? r.job ?? '').toLowerCase().includes(tool) && !r.path.toLowerCase().includes(tool)) continue;
    if (q.errorsOnly && !(r.status === 0 || (r.status != null && r.status >= 400))) continue;
    out.push({ ...r });
  }
  return out;
}

export interface CallerSummary {
  caller: string; source: string; ip: string | null; userAgent: string | null; calls: number;
  /** Real failures. A search that found nothing is counted in notFound, not here. */
  errors: number; notFound: number;
  apiCalls: number; lastAt: string; lastTool: string;
}

/** Who has been calling in the last `minutes`, grouped by declared source + origin. */
export function callerSummary(minutes = 60): { callers: CallerSummary[]; background: Array<{ job: string; apiCalls: number; errors: number; lastAt: string }>; since: string; oldest: string | null } {
  const since = Date.now() - minutes * 60_000;
  const m = new Map<string, CallerSummary>();
  for (const r of tools) {
    if (Date.parse(r.at) < since) continue;
    const source = r.source ?? 'unknown';
    const key = `${source}|${r.ip ?? ''}|${r.userAgent ?? ''}`;
    const c = m.get(key) ?? { caller: key, source, ip: r.ip, userAgent: r.userAgent, calls: 0, errors: 0, notFound: 0, apiCalls: 0, lastAt: r.at, lastTool: r.tool };
    c.calls++; c.apiCalls += r.apiCalls;
    if (r.outcome === 'not-found') c.notFound++; else if (isErr(r.outcome)) c.errors++;
    if (r.at >= c.lastAt) { c.lastAt = r.at; c.lastTool = r.tool; }
    m.set(key, c);
  }
  const bg = new Map<string, { job: string; apiCalls: number; errors: number; lastAt: string }>();
  for (const r of api) {
    if (r.toolCallId || Date.parse(r.at) < since) continue;
    const job = r.job ?? 'other background';
    const b = bg.get(job) ?? { job, apiCalls: 0, errors: 0, lastAt: r.at };
    b.apiCalls++; if (r.status === 0 || (r.status ?? 0) >= 400) b.errors++; if (r.at > b.lastAt) b.lastAt = r.at;
    bg.set(job, b);
  }
  return {
    callers: [...m.values()].sort((a, b) => b.calls - a.calls),
    background: [...bg.values()].sort((a, b) => b.apiCalls - a.apiCalls),
    since: new Date(since).toISOString(),
    oldest: tools[0]?.at ?? null,
  };
}

/** Tests only. */
// ── persistence of the hourly counts (db/call-stats-store.ts) ───────────────

/** One persisted hourly counter: kind read = per entity, gap = per raw_request shape, fallback = per tool→raw pair. */
export interface StatRow { hour: number; kind: 'read' | 'gap' | 'fallback'; key: string; data: Record<string, unknown> }

const obj = (m: Map<string, number>) => Object.fromEntries(m);
const map = (o: unknown) => new Map(Object.entries((o as Record<string, number>) ?? {}).map(([k, v]) => [k, Number(v)]));

/** The hourly counts from `fromHour` on, as rows to upsert. */
export function snapshotStats(fromHour: number): StatRow[] {
  const out: StatRow[] = [];
  for (const [hour, b] of buckets) if (hour >= fromHour) for (const [key, c] of b) out.push({ hour, kind: 'read', key, data: { upstream: c.upstream, cache: c.cache, shadow: c.shadow, write: c.write, callers: obj(c.callers) } });
  for (const [hour, b] of gapBuckets) if (hour >= fromHour) for (const [key, c] of b) out.push({ hour, kind: 'gap', key, data: { calls: c.calls, errors: c.errors, callers: obj(c.callers), lastAt: c.lastAt, lastError: c.lastError } });
  for (const [hour, b] of fallbackBuckets) if (hour >= fromHour) for (const [key, c] of b) out.push({ hour, kind: 'fallback', key, data: { count: c.count, lastAt: c.lastAt, lastError: c.lastError } });
  return out;
}

/**
 * Add persisted counts back after a restart. Counts ADD to whatever arrived
 * since the process started (run it once, at start), so the current hour
 * keeps both the persisted and the new calls.
 */
export function restoreStats(rows: StatRow[]): number {
  const oldest = Math.floor(Date.now() / 3_600_000) - HOURS;
  let n = 0;
  const bucketOf = <T>(m: Map<number, Map<string, T>>, hour: number) => { let b = m.get(hour); if (!b) { b = new Map(); m.set(hour, b); } return b; };
  const addCallers = (into: Map<string, number>, from: unknown) => { for (const [k, v] of map(from)) into.set(k, (into.get(k) ?? 0) + v); };
  for (const r of rows) {
    if (r.hour <= oldest) continue;
    const d = r.data as Record<string, any>;
    if (r.kind === 'read') {
      const b = bucketOf(buckets, r.hour);
      const c = b.get(r.key) ?? { upstream: 0, cache: 0, shadow: 0, write: 0, callers: new Map() };
      c.upstream += Number(d.upstream ?? 0); c.cache += Number(d.cache ?? 0); c.shadow += Number(d.shadow ?? 0); c.write += Number(d.write ?? 0); addCallers(c.callers, d.callers);
      b.set(r.key, c);
    } else if (r.kind === 'gap') {
      const b = bucketOf(gapBuckets, r.hour);
      const c = b.get(r.key) ?? { calls: 0, errors: 0, callers: new Map(), lastAt: String(d.lastAt ?? ''), lastError: null };
      c.calls += Number(d.calls ?? 0); c.errors += Number(d.errors ?? 0); addCallers(c.callers, d.callers);
      if (String(d.lastAt ?? '') > c.lastAt) { c.lastAt = String(d.lastAt); c.lastError = d.lastError ?? c.lastError; } else c.lastError ??= d.lastError ?? null;
      b.set(r.key, c);
    } else if (r.kind === 'fallback') {
      const b = bucketOf(fallbackBuckets, r.hour);
      const c = b.get(r.key) ?? { count: 0, lastAt: String(d.lastAt ?? ''), lastError: null };
      c.count += Number(d.count ?? 0);
      if (String(d.lastAt ?? '') >= c.lastAt) { c.lastAt = String(d.lastAt); c.lastError = d.lastError ?? null; }
      b.set(r.key, c);
    } else continue;
    n++;
  }
  return n;
}

export function _resetCallLog(): void { tools.length = 0; api.length = 0; nextTool = 1; nextApi = 1; buckets.clear(); gapBuckets.clear(); fallbackBuckets.clear(); usageSamples.length = 0; }
