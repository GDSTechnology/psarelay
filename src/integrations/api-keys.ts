// Read API keys for other systems (migration 0024): a time module, a CRM module, a report job.
//
// A key (`psk_…`, 256 random bits) opens /api/v1 only. Only its SHA-256 is stored; it is shown once. Each key says
// which mirrored entities it may read, whether a read the mirror can't answer may go to Autotask live, whether it
// may be used from outside the private network, and two hourly caps (all requests / live calls).
//
// Writes (migration 0025): a key may also create / update the entities in its write list (none by default), delete
// them when allowed, within its own hourly write cap. Every write is logged in api_key_write.
//
// Usage is counted in memory per hour and written to `api_key_usage` every 30 s, so a read costs no database write.
// The hourly caps are enforced per process (PSArelay runs one).

import type { Pool } from 'pg';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SHADOW_ENTITIES, shadowEntity } from '../db/shadow-entities.js';

export const API_KEY_PREFIX = 'psk_';

/**
 * Entities a key may be allowed to write. Financial records (contracts, services, charges, invoices) are left out on
 * purpose: they go through the MCP's confirm-gated tools. Child entities can also be written on Autotask's child URLs
 * (/Tickets/{id}/Notes …); WRITE_CHILD maps those URLs to the entity a key needs.
 */
export const WRITABLE_ENTITIES = [
  'TimeEntries', 'Tickets', 'TicketNotes', 'Tasks', 'TaskNotes', 'Projects', 'ProjectNotes', 'ServiceCalls',
  'ServiceCallTickets', 'ServiceCallTicketResources', 'CompanyToDos', 'Companies', 'CompanyNotes', 'Contacts',
  'ConfigurationItems', 'Opportunities',
] as const;
export const WRITE_CHILD: Record<string, string> = {
  'Tickets/Notes': 'TicketNotes', 'Tasks/Notes': 'TaskNotes', 'Projects/Notes': 'ProjectNotes', 'Projects/Tasks': 'Tasks',
  'Companies/Notes': 'CompanyNotes', 'Companies/Contacts': 'Contacts', 'Companies/ConfigurationItems': 'ConfigurationItems',
  'Companies/ToDos': 'CompanyToDos',
};
export const writableEntity = (name: string): string | undefined => WRITABLE_ENTITIES.find((e) => e.toLowerCase() === name.toLowerCase());

export interface ApiKey {
  id: number; name: string; prefix: string; entities: string[]; allowLive: boolean; allowExternal: boolean;
  hourlyLimit: number; liveHourlyLimit: number;
  writeEntities: string[]; allowDelete: boolean; writeHourlyLimit: number;
  createdBy: string; createdAt: string; updatedAt: string | null; updatedBy: string | null; lastUsedAt: string | null;
  expiresAt: string | null; revokedAt: string | null; revokedBy: string | null;
}
/** What a verified key allows (the read API's view of it). */
export type ApiKeyAuth = Pick<ApiKey, 'id' | 'name' | 'entities' | 'allowLive' | 'allowExternal' | 'hourlyLimit' | 'liveHourlyLimit' | 'writeEntities' | 'allowDelete' | 'writeHourlyLimit'>;
export interface ApiKeyPolicy {
  entities: string[]; allowLive: boolean; allowExternal: boolean; hourlyLimit: number; liveHourlyLimit: number;
  writeEntities: string[]; allowDelete: boolean; writeHourlyLimit: number;
}
export interface UsageRow { mirror: number; live: number; refused: number; writes: number }
const ZERO = (): UsageRow => ({ mirror: 0, live: 0, refused: 0, writes: 0 });

/** One logged write (api_key_write). */
export interface ApiWrite {
  id: number; keyId: number; keyName: string | null; at: string; finishedAt: string | null; method: string; path: string; entity: string;
  recordId: number | null; status: 'running' | 'ok' | 'failed' | 'unknown'; httpStatus: number | null; idempotencyKey: string | null; error: string | null;
}
/** Outcome of claiming an Idempotency-Key before a write. */
export type WriteClaim =
  | { kind: 'new'; id: number }
  | { kind: 'replay'; httpStatus: number; response: unknown }
  | { kind: 'busy' }
  | { kind: 'unknown' };

export const hashApiKey = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');
export const newApiKey = () => API_KEY_PREFIX + randomBytes(32).toString('base64url');
export const apiKeyShapeOk = (k: string) => k.startsWith(API_KEY_PREFIX) && /^[A-Za-z0-9_-]{40,60}$/.test(k.slice(API_KEY_PREFIX.length));

/** The entities a key can be given: everything the mirror holds. */
export const mirroredEntityNames = () => SHADOW_ENTITIES.map((e) => e.name);

export class ApiKeyInputError extends Error {}

/** Validate a policy from the console; entity names are normalised to the mirror's spelling. */
export function coercePolicy(b: Record<string, unknown>, base?: ApiKeyPolicy): ApiKeyPolicy {
  const raw = b.entities === undefined ? base?.entities : b.entities;
  if (!Array.isArray(raw)) throw new ApiKeyInputError('"entities" must be a list.');
  const entities = [...new Set(raw.map((n) => {
    const d = shadowEntity(String(n));
    if (!d) throw new ApiKeyInputError(`"${String(n)}" is not a mirrored entity.`);
    return d.name;
  }))].sort();
  const wraw = b.writeEntities === undefined ? base?.writeEntities ?? [] : b.writeEntities;
  if (!Array.isArray(wraw)) throw new ApiKeyInputError('"writeEntities" must be a list.');
  const writeEntities = [...new Set(wraw.map((n) => {
    const w = writableEntity(String(n));
    if (!w) throw new ApiKeyInputError(`"${String(n)}" can't be written through the API. Writable: ${WRITABLE_ENTITIES.join(', ')}.`);
    return w;
  }))].sort();
  if (!entities.length && !writeEntities.length) throw new ApiKeyInputError('Choose at least one entity the key may read or write.');
  const bool = (k: 'allowLive' | 'allowExternal' | 'allowDelete') => {
    const v = b[k] === undefined ? base?.[k] ?? false : b[k];
    if (typeof v !== 'boolean') throw new ApiKeyInputError(`${k} must be true or false.`);
    return v;
  };
  const int = (k: 'hourlyLimit' | 'liveHourlyLimit' | 'writeHourlyLimit', d: number, max: number) => {
    const v = b[k] === undefined || b[k] === '' ? base?.[k] ?? d : Number(b[k]);
    if (!Number.isInteger(v) || v < 0 || v > max) throw new ApiKeyInputError(`${k} must be a whole number from 0 to ${max}.`);
    return v;
  };
  return { entities, allowLive: bool('allowLive'), allowExternal: bool('allowExternal'), hourlyLimit: int('hourlyLimit', 3600, 1_000_000), liveHourlyLimit: int('liveHourlyLimit', 100, 5000),
    writeEntities, allowDelete: writeEntities.length ? bool('allowDelete') : false, writeHourlyLimit: int('writeHourlyLimit', 200, 5000) };
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const row = (x: Record<string, any>): ApiKey => ({
  id: Number(x.id), name: x.name, prefix: x.token_prefix, entities: [...(x.entities ?? [])], allowLive: !!x.allow_live, allowExternal: !!x.allow_external,
  hourlyLimit: Number(x.hourly_limit), liveHourlyLimit: Number(x.live_hourly_limit),
  writeEntities: [...(x.write_entities ?? [])], allowDelete: !!x.allow_delete, writeHourlyLimit: Number(x.write_hourly_limit ?? 200),
  createdBy: x.created_by, createdAt: iso(x.created_at)!, updatedAt: iso(x.updated_at), updatedBy: x.updated_by ?? null, lastUsedAt: iso(x.last_used_at),
  expiresAt: iso(x.expires_at), revokedAt: iso(x.revoked_at), revokedBy: x.revoked_by ?? null,
});
const auth = (k: ApiKey): ApiKeyAuth => ({ id: k.id, name: k.name, entities: k.entities, allowLive: k.allowLive, allowExternal: k.allowExternal, hourlyLimit: k.hourlyLimit, liveHourlyLimit: k.liveHourlyLimit, writeEntities: k.writeEntities, allowDelete: k.allowDelete, writeHourlyLimit: k.writeHourlyLimit });

const CACHE_MS = 30_000;
const TOUCH_MS = 5 * 60_000;
const FLUSH_MS = 30_000;
export const hourStart = (t = Date.now()) => Math.floor(t / 3_600_000) * 3_600_000;

export class ApiKeyStore {
  private cache = new Map<string, { at: number; auth: ApiKeyAuth | null }>();
  private touched = new Map<number, number>();
  /** This hour's counts per key (rate limits), and what is not yet written to api_key_usage. */
  private hour = new Map<number, { hour: number; total: number; live: number; writes: number }>();
  private pending = new Map<string, UsageRow>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly pool: Pool) {}

  async create(o: { name: string; policy: ApiKeyPolicy; expiresAt: string | null; by: string }): Promise<{ key: string; item: ApiKey }> {
    const key = newApiKey();
    const p = o.policy;
    const r = await this.pool.query(
      `INSERT INTO api_key (name, token_hash, token_prefix, entities, allow_live, allow_external, hourly_limit, live_hourly_limit, created_by, expires_at,
                            write_entities, allow_delete, write_hourly_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [o.name, hashApiKey(key), key.slice(0, API_KEY_PREFIX.length + 6), p.entities, p.allowLive, p.allowExternal, p.hourlyLimit, p.liveHourlyLimit, o.by, o.expiresAt,
       p.writeEntities, p.allowDelete, p.writeHourlyLimit]);
    return { key, item: row(r.rows[0]) };
  }
  async list(): Promise<ApiKey[]> { return (await this.pool.query('SELECT * FROM api_key ORDER BY revoked_at NULLS FIRST, created_at DESC')).rows.map(row); }
  async get(id: number): Promise<ApiKey | null> { const r = await this.pool.query('SELECT * FROM api_key WHERE id = $1', [id]); return r.rows[0] ? row(r.rows[0]) : null; }
  async update(id: number, p: ApiKeyPolicy, by: string): Promise<ApiKey | null> {
    const r = await this.pool.query(
      `UPDATE api_key SET entities = $2, allow_live = $3, allow_external = $4, hourly_limit = $5, live_hourly_limit = $6, updated_at = now(), updated_by = $7,
         write_entities = $8, allow_delete = $9, write_hourly_limit = $10
       WHERE id = $1 AND revoked_at IS NULL RETURNING *`, [id, p.entities, p.allowLive, p.allowExternal, p.hourlyLimit, p.liveHourlyLimit, by, p.writeEntities, p.allowDelete, p.writeHourlyLimit]);
    this.cache.clear(); // a narrowed key applies at once
    return r.rows[0] ? row(r.rows[0]) : null;
  }
  async revoke(id: number, by: string): Promise<boolean> {
    const r = await this.pool.query('UPDATE api_key SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL', [id, by]);
    this.cache.clear();
    return (r.rowCount ?? 0) > 0;
  }

  /** The key a presented value stands for, or null (unknown, revoked or expired). */
  async verify(key: string): Promise<ApiKeyAuth | null> {
    if (!apiKeyShapeOk(key)) return null;
    const h = hashApiKey(key);
    const hit = this.cache.get(h);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.auth;
    const r = await this.pool.query('SELECT * FROM api_key WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())', [h]);
    const x = r.rows[0];
    const a = x && timingSafeEqual(Buffer.from(String(x.token_hash)), Buffer.from(h)) ? auth(row(x)) : null;
    this.cache.set(h, { at: Date.now(), auth: a });
    if (a && Date.now() - (this.touched.get(a.id) ?? 0) > TOUCH_MS) {
      this.touched.set(a.id, Date.now());
      void this.pool.query('UPDATE api_key SET last_used_at = now() WHERE id = $1', [a.id]).catch(() => undefined);
    }
    return a;
  }

  /** This hour's counts for a key (for the caps). */
  current(id: number): { total: number; live: number; writes: number } {
    const c = this.hour.get(id);
    return c && c.hour === hourStart() ? { total: c.total, live: c.live, writes: c.writes } : { total: 0, live: 0, writes: 0 };
  }
  /** Count one request: `mirror` / `live` served, `writes` sent to Autotask, or `refused`. */
  record(id: number, outcome: keyof UsageRow): void {
    const hs = hourStart();
    let c = this.hour.get(id);
    if (!c || c.hour !== hs) { c = { hour: hs, total: 0, live: 0, writes: 0 }; this.hour.set(id, c); }
    c.total++;
    if (outcome === 'live') c.live++;
    if (outcome === 'writes') c.writes++;
    const k = `${id}:${hs}`;
    const p = this.pending.get(k) ?? ZERO();
    p[outcome]++;
    this.pending.set(k, p);
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, FLUSH_MS); this.timer.unref?.(); }
  }
  /** Write pending counts (adds to the hour's row). Kept for the next flush if the database is unavailable. */
  async flush(): Promise<void> {
    const batch = [...this.pending.entries()];
    this.pending.clear();
    for (const [k, u] of batch) {
      const [id, hs] = k.split(':').map(Number) as [number, number];
      try {
        await this.pool.query(
          `INSERT INTO api_key_usage (key_id, hour, mirror, live, refused, writes) VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6)
           ON CONFLICT (key_id, hour) DO UPDATE SET mirror = api_key_usage.mirror + EXCLUDED.mirror, live = api_key_usage.live + EXCLUDED.live,
             refused = api_key_usage.refused + EXCLUDED.refused, writes = api_key_usage.writes + EXCLUDED.writes`,
          [id, hs, u.mirror, u.live, u.refused, u.writes]);
      } catch {
        const p = this.pending.get(k) ?? ZERO();
        this.pending.set(k, { mirror: p.mirror + u.mirror, live: p.live + u.live, refused: p.refused + u.refused, writes: p.writes + u.writes });
      }
    }
  }
  /** Last 24 hours per key (written counts plus what is still pending). */
  async usage24h(): Promise<Map<number, UsageRow>> {
    const out = new Map<number, UsageRow>();
    const add = (id: number, u: UsageRow) => { const o = out.get(id) ?? ZERO(); out.set(id, { mirror: o.mirror + u.mirror, live: o.live + u.live, refused: o.refused + u.refused, writes: o.writes + u.writes }); };
    const r = await this.pool.query(`SELECT key_id, sum(mirror)::int AS mirror, sum(live)::int AS live, sum(refused)::int AS refused, sum(writes)::int AS writes FROM api_key_usage WHERE hour > now() - interval '24 hours' GROUP BY key_id`);
    for (const x of r.rows) add(Number(x.key_id), { mirror: Number(x.mirror), live: Number(x.live), refused: Number(x.refused), writes: Number(x.writes ?? 0) });
    for (const [k, u] of this.pending) add(Number(k.split(':')[0]), u);
    return out;
  }

  // ── write log (api_key_write) ──

  /**
   * Log a write before it runs. With an Idempotency-Key the key is claimed here: a finished one is replayed, a running
   * one is "busy", an "unknown" one (sent, no answer) is never re-run, and a failed one is claimed again (nothing was
   * written). The same key on a different method / path is refused as busy.
   */
  async claimWrite(o: { keyId: number; method: string; path: string; entity: string; recordId: number | null; idempotencyKey: string | null }): Promise<WriteClaim> {
    const r = await this.pool.query(
      `INSERT INTO api_key_write (key_id, method, path, entity, record_id, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (key_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
      [o.keyId, o.method, o.path, o.entity, o.recordId, o.idempotencyKey]);
    if (r.rows[0]) return { kind: 'new', id: Number(r.rows[0].id) };
    const cur = (await this.pool.query('SELECT id, status, http_status, response, method, path FROM api_key_write WHERE key_id = $1 AND idempotency_key = $2', [o.keyId, o.idempotencyKey])).rows[0];
    if (!cur || cur.method !== o.method || cur.path !== o.path) return { kind: 'busy' };
    if (cur.status === 'ok') return { kind: 'replay', httpStatus: Number(cur.http_status ?? 200), response: cur.response };
    if (cur.status === 'unknown') return { kind: 'unknown' };
    if (cur.status === 'failed') {
      const again = await this.pool.query(
        `UPDATE api_key_write SET status = 'running', at = now(), finished_at = NULL, error = NULL, http_status = NULL, response = NULL, record_id = $3
         WHERE id = $1 AND key_id = $2 AND status = 'failed' RETURNING id`, [cur.id, o.keyId, o.recordId]);
      if (again.rows[0]) return { kind: 'new', id: Number(again.rows[0].id) };
    }
    return { kind: 'busy' };
  }
  async finishWrite(id: number, o: { status: 'ok' | 'failed' | 'unknown'; httpStatus: number; recordId?: number | null; response?: unknown; error?: string | null }): Promise<void> {
    await this.pool.query(
      `UPDATE api_key_write SET status = $2, http_status = $3, record_id = COALESCE($4, record_id), response = $5, error = $6, finished_at = now() WHERE id = $1`,
      [id, o.status, o.httpStatus, o.recordId ?? null, o.response === undefined ? null : JSON.stringify(o.response), o.error ? o.error.slice(0, 1000) : null]);
  }
  async recentWrites(limit = 50): Promise<ApiWrite[]> {
    const r = await this.pool.query(
      `SELECT w.*, k.name AS key_name FROM api_key_write w LEFT JOIN api_key k ON k.id = w.key_id ORDER BY w.at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 500)]);
    return r.rows.map((x: Record<string, any>) => ({
      id: Number(x.id), keyId: Number(x.key_id), keyName: x.key_name ?? null, at: iso(x.at)!, finishedAt: iso(x.finished_at), method: x.method, path: x.path,
      entity: x.entity, recordId: x.record_id == null ? null : Number(x.record_id), status: x.status, httpStatus: x.http_status == null ? null : Number(x.http_status),
      idempotencyKey: x.idempotency_key ?? null, error: x.error ?? null,
    }));
  }
}

let store: ApiKeyStore | null = null;
/** The shared store (one per process: the caps and the verify cache live in it). */
export function apiKeyStore(pool: Pool | null): ApiKeyStore | null {
  if (!pool) return null;
  if (!store) store = new ApiKeyStore(pool);
  return store;
}
export const _resetApiKeyStore = () => { store = null; };
