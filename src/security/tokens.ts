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
  id: number; name: string; prefix: string; resourceId: number | null; delegate: boolean; ownerUserId: number | null; ownerUsername: string | null;
  createdBy: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; revokedBy: string | null;
}
/** What a verified token tells the request about its caller. */
export interface TokenAuth {
  tokenId: number; tokenName: string; resourceId: number | null; delegate: boolean;
  /** Sign-in (OAuth) tokens: the MCP URL they were issued for — accepted only there. */
  audience?: string | null;
  /** Microsoft 365 Copilot single sign-on: the verified person (migration 0023). */
  m365?: { tenantId: string; oid: string; upn: string };
  /** Set when that person is not linked to an Autotask resource: every tool call answers this and runs nothing. */
  unlinkedMessage?: string;
}

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
/** A new random token: `psr_` + 43 base64url characters (256 bits). */
export const newToken = () => TOKEN_PREFIX + randomBytes(32).toString('base64url');
/** Looks like one of ours (cheap pre-check before a lookup). */
export const tokenShapeOk = (t: string) => t.startsWith(TOKEN_PREFIX) && /^[A-Za-z0-9_-]{40,60}$/.test(t.slice(TOKEN_PREFIX.length));

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const row = (x: Record<string, any>): AccessToken => ({
  id: Number(x.id), name: x.name, prefix: x.token_prefix, resourceId: x.resource_id == null ? null : Number(x.resource_id), delegate: !!x.delegate, ownerUserId: x.owner_user_id == null ? null : Number(x.owner_user_id), ownerUsername: x.owner_username ?? null,
  createdBy: x.created_by, createdAt: iso(x.created_at)!, lastUsedAt: iso(x.last_used_at), expiresAt: iso(x.expires_at), revokedAt: iso(x.revoked_at), revokedBy: x.revoked_by ?? null,
});

const CACHE_MS = 60_000;
const TOUCH_MS = 5 * 60_000;

export class TokenStore {
  private cache = new Map<string, { at: number; auth: TokenAuth | null }>();
  private touched = new Map<number, number>();
  constructor(private readonly pool: Pool) {}

  async create(o: { name: string; resourceId?: number | null; delegate?: boolean; expiresAt?: string | null; by: string; ownerUserId?: number | null; oauthClientId?: string; audience?: string; oauthFamily?: string }): Promise<{ token: string; item: AccessToken }> {
    const token = newToken();
    const r = await this.pool.query(
      `INSERT INTO mcp_token (name, token_hash, token_prefix, resource_id, delegate, created_by, expires_at, owner_user_id, oauth_client_id, audience, oauth_family) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [o.name, hashToken(token), token.slice(0, TOKEN_PREFIX.length + 6), o.resourceId ?? null, !!o.delegate, o.by, o.expiresAt ?? null, o.ownerUserId ?? null, o.oauthClientId ?? null, o.audience ?? null, o.oauthFamily ?? null]);
    return { token, item: row(r.rows[0]) };
  }
  async list(): Promise<AccessToken[]> { return (await this.pool.query('SELECT t.*, u.username AS owner_username FROM mcp_token t LEFT JOIN admin_user u ON u.id = t.owner_user_id ORDER BY t.revoked_at NULLS FIRST, t.created_at DESC')).rows.map(row); }
  /** A user's own tokens (self-service). */
  async listOwned(userId: number): Promise<AccessToken[]> { return (await this.pool.query('SELECT * FROM mcp_token WHERE owner_user_id = $1 AND oauth_client_id IS NULL ORDER BY revoked_at NULLS FIRST, created_at DESC', [userId])).rows.map(row); }
  async activeCount(): Promise<number> { return Number((await this.pool.query(`SELECT count(*) AS n FROM mcp_token WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`)).rows[0]?.n ?? 0); }
  /** Revoke a token; with `ownerUserId`, only if that user owns it (self-service). */
  async revoke(id: number, by: string, ownerUserId?: number): Promise<boolean> {
    const r = ownerUserId == null
      ? await this.pool.query('UPDATE mcp_token SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL', [id, by])
      : await this.pool.query('UPDATE mcp_token SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND owner_user_id = $3 AND revoked_at IS NULL', [id, by, ownerUserId]);
    this.cache.clear(); // a revoke applies at once, not after the cache minute
    return (r.rowCount ?? 0) > 0;
  }

  clearCache(): void { this.cache.clear(); }

  /** The caller a presented token stands for, or null (unknown, revoked or expired). */
  async verify(token: string): Promise<TokenAuth | null> {
    if (!tokenShapeOk(token)) return null;
    const h = hashToken(token);
    const hit = this.cache.get(h);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.auth;
    // A self-service token lives only while its owner is enabled and still linked to the same Autotask resource.
    const r = await this.pool.query(`SELECT t.*, u.disabled AS owner_disabled, u.autotask_resource_id AS owner_resource_id FROM mcp_token t LEFT JOIN admin_user u ON u.id = t.owner_user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())`, [h]);
    const found = r.rows[0];
    const ownerOk = !found || found.owner_user_id == null || (found.owner_disabled === false && found.owner_resource_id != null && Number(found.owner_resource_id) === Number(found.resource_id));
    const x = ownerOk ? found : undefined;
    // Constant-time re-check of the stored hash (the index lookup itself is by exact value).
    const auth = x && timingSafeEqual(Buffer.from(String(x.token_hash)), Buffer.from(h))
      ? { tokenId: Number(x.id), tokenName: String(x.name), resourceId: x.resource_id == null ? null : Number(x.resource_id), delegate: !!x.delegate, audience: x.audience ?? null }
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

/** Forget cached verifications (a user was disabled, unlinked or relinked). */
export function clearTokenCache(): void { store?.clearCache(); }

/** The bearer token from an Authorization header, or null. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(h ?? '');
  return m ? m[1]! : null;
}
