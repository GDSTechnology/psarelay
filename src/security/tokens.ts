// Access tokens for the /mcp endpoint (migration 0018).
//
// Zero trust: a call is only as trusted as the token it carries. The token is random (32 bytes), shown once; only its
// SHA-256 is stored, so a database leak does not leak usable tokens. A verified token decides WHO the caller is —
// client-declared identities (`requestingUserEmail`, `autotaskResourceId` in _meta) are then ignored unless the token
// is a delegate (see migration 0018).

import type { Pool } from 'pg';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_PREFIX = 'psr_';

export interface AccessToken {
  id: number; name: string; prefix: string; resourceId: number | null; delegate: boolean;
  createdBy: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; revokedBy: string | null;
}
/** What a verified token tells the request about its caller. */
export interface TokenAuth { tokenId: number; tokenName: string; resourceId: number | null; delegate: boolean }

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
/** A new random token: `psr_` + 43 base64url characters (256 bits). */
export const newToken = () => TOKEN_PREFIX + randomBytes(32).toString('base64url');
/** Looks like one of ours (cheap pre-check before a lookup). */
export const tokenShapeOk = (t: string) => t.startsWith(TOKEN_PREFIX) && /^[A-Za-z0-9_-]{40,60}$/.test(t.slice(TOKEN_PREFIX.length));

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const row = (x: Record<string, any>): AccessToken => ({
  id: Number(x.id), name: x.name, prefix: x.token_prefix, resourceId: x.resource_id == null ? null : Number(x.resource_id), delegate: !!x.delegate,
  createdBy: x.created_by, createdAt: iso(x.created_at)!, lastUsedAt: iso(x.last_used_at), expiresAt: iso(x.expires_at), revokedAt: iso(x.revoked_at), revokedBy: x.revoked_by ?? null,
});

const CACHE_MS = 60_000;
const TOUCH_MS = 5 * 60_000;

export class TokenStore {
  private cache = new Map<string, { at: number; auth: TokenAuth | null }>();
  private touched = new Map<number, number>();
  constructor(private readonly pool: Pool) {}

  async create(o: { name: string; resourceId?: number | null; delegate?: boolean; expiresAt?: string | null; by: string }): Promise<{ token: string; item: AccessToken }> {
    const token = newToken();
    const r = await this.pool.query(
      `INSERT INTO mcp_token (name, token_hash, token_prefix, resource_id, delegate, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [o.name, hashToken(token), token.slice(0, TOKEN_PREFIX.length + 6), o.resourceId ?? null, !!o.delegate, o.by, o.expiresAt ?? null]);
    return { token, item: row(r.rows[0]) };
  }
  async list(): Promise<AccessToken[]> { return (await this.pool.query('SELECT * FROM mcp_token ORDER BY revoked_at NULLS FIRST, created_at DESC')).rows.map(row); }
  async activeCount(): Promise<number> { return Number((await this.pool.query(`SELECT count(*) AS n FROM mcp_token WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`)).rows[0]?.n ?? 0); }
  async revoke(id: number, by: string): Promise<boolean> {
    const r = await this.pool.query('UPDATE mcp_token SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL', [id, by]);
    this.cache.clear(); // a revoke applies at once, not after the cache minute
    return (r.rowCount ?? 0) > 0;
  }

  /** The caller a presented token stands for, or null (unknown, revoked or expired). */
  async verify(token: string): Promise<TokenAuth | null> {
    if (!tokenShapeOk(token)) return null;
    const h = hashToken(token);
    const hit = this.cache.get(h);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.auth;
    const r = await this.pool.query(`SELECT * FROM mcp_token WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [h]);
    const x = r.rows[0];
    // Constant-time re-check of the stored hash (the index lookup itself is by exact value).
    const auth = x && timingSafeEqual(Buffer.from(String(x.token_hash)), Buffer.from(h))
      ? { tokenId: Number(x.id), tokenName: String(x.name), resourceId: x.resource_id == null ? null : Number(x.resource_id), delegate: !!x.delegate }
      : null;
    this.cache.set(h, { at: Date.now(), auth });
    if (auth && Date.now() - (this.touched.get(auth.tokenId) ?? 0) > TOUCH_MS) {
      this.touched.set(auth.tokenId, Date.now());
      void this.pool.query('UPDATE mcp_token SET last_used_at = now() WHERE id = $1', [auth.tokenId]).catch(() => undefined);
    }
    return auth;
  }
}

let store: TokenStore | null = null;
/** The shared store (one per process, so revokes clear the one cache that verifies). */
export function tokenStore(pool: Pool | null): TokenStore | null {
  if (!pool) return null;
  if (!store) store = new TokenStore(pool);
  return store;
}
export const _resetTokenStore = () => { store = null; };

/** The bearer token from an Authorization header, or null. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(h ?? '');
  return m ? m[1]! : null;
}
