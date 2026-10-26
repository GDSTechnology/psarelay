// Storage for the AI-client sign-in (migration 0021): registered clients, one-time codes, rotating refresh tokens.
// Only SHA-256 hashes of codes and tokens are stored.

import type { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** How a client proves itself at the token endpoint (migration 0022). 'auto' = it did not say: a secret was issued and is checked when sent. */
export type TokenAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic' | 'auto';
export interface OAuthClient { clientId: string; clientName: string; redirectUris: string[]; createdAt: string; lastUsedAt: string | null; tokenAuthMethod: TokenAuthMethod; secretHash: string | null }
export interface OAuthCode { clientId: string; userId: number; redirectUri: string; codeChallenge: string; resource: string }
export interface RefreshRow { family: string; clientId: string; userId: number; resource: string; used: boolean; revoked: boolean; expired: boolean }

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export class OAuthStore {
  constructor(private readonly pool: Pool) {}

  /** Register a client; a confidential one gets a secret, returned only here. */
  async registerClient(name: string, redirectUris: string[], ip: string | null, method: TokenAuthMethod = 'none'): Promise<OAuthClient & { secret: string | null }> {
    const id = 'psr_client_' + randomToken(18);
    const secret = method === 'none' ? null : 'psr_cs_' + randomToken(32);
    const r = await this.pool.query('INSERT INTO oauth_client (client_id, client_name, redirect_uris, created_ip, token_auth_method, client_secret_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [id, name, JSON.stringify(redirectUris), ip, method, secret ? sha256(secret) : null]);
    return { ...this.client(r.rows[0]), secret };
  }
  async getClient(id: string): Promise<OAuthClient | null> {
    const r = await this.pool.query('SELECT * FROM oauth_client WHERE client_id = $1', [id]);
    return r.rows[0] ? this.client(r.rows[0]) : null;
  }
  private client(x: Record<string, any>): OAuthClient {
    return { clientId: x.client_id, clientName: x.client_name, redirectUris: Array.isArray(x.redirect_uris) ? x.redirect_uris : JSON.parse(x.redirect_uris), createdAt: iso(x.created_at)!, lastUsedAt: iso(x.last_used_at),
      tokenAuthMethod: (x.token_auth_method ?? 'none') as TokenAuthMethod, secretHash: x.client_secret_hash ?? null };
  }
  /** Registrations from one address in the last hour (dynamic registration is open by design — keep it bounded). */
  async recentRegistrations(ip: string): Promise<number> {
    return Number((await this.pool.query(`SELECT count(*) AS n FROM oauth_client WHERE created_ip = $1 AND created_at > now() - interval '1 hour'`, [ip])).rows[0]?.n ?? 0);
  }

  async createCode(c: OAuthCode): Promise<string> {
    const code = randomToken(32);
    await this.pool.query(`INSERT INTO oauth_code (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '2 minutes')`,
      [sha256(code), c.clientId, c.userId, c.redirectUri, c.codeChallenge, c.resource]);
    return code;
  }
  /** Redeem a code once: returns it and marks it used; null when unknown, used or expired. */
  async redeemCode(code: string): Promise<OAuthCode | null> {
    const r = await this.pool.query(`UPDATE oauth_code SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *`, [sha256(code)]);
    const x = r.rows[0];
    return x ? { clientId: x.client_id, userId: Number(x.user_id), redirectUri: x.redirect_uri, codeChallenge: x.code_challenge, resource: x.resource } : null;
  }

  async createRefresh(o: { family: string; clientId: string; userId: number; resource: string; days: number }): Promise<string> {
    const t = 'psr_rt_' + randomToken(32);
    await this.pool.query(`INSERT INTO oauth_refresh (token_hash, family, client_id, user_id, resource, expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)`,
      [sha256(t), o.family, o.clientId, o.userId, o.resource, String(o.days)]);
    return t;
  }
  async findRefresh(t: string): Promise<RefreshRow | null> {
    const x = (await this.pool.query('SELECT *, expires_at < now() AS expired FROM oauth_refresh WHERE token_hash = $1', [sha256(t)])).rows[0];
    return x ? { family: x.family, clientId: x.client_id, userId: Number(x.user_id), resource: x.resource, used: !!x.used_at, revoked: !!x.revoked_at, expired: !!x.expired } : null;
  }
  async markRefreshUsed(t: string): Promise<boolean> {
    return ((await this.pool.query('UPDATE oauth_refresh SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL', [sha256(t)])).rowCount ?? 0) > 0;
  }
  /** End one sign-in: its refresh tokens and its access tokens. */
  async revokeFamily(family: string, by: string): Promise<void> {
    await this.pool.query('UPDATE oauth_refresh SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL', [family]);
    await this.pool.query('UPDATE mcp_token SET revoked_at = now(), revoked_by = $2 WHERE oauth_family = $1 AND revoked_at IS NULL', [family, by]);
  }
  async touchClient(id: string): Promise<void> { await this.pool.query('UPDATE oauth_client SET last_used_at = now() WHERE client_id = $1', [id]); }

  /** A person's AI-client sign-ins (one per family), for Account → Connect your AI. */
  async connectionsOf(userId: number): Promise<Array<{ family: string; clientName: string; since: string; lastUsedAt: string | null; expiresAt: string }>> {
    const r = await this.pool.query(`SELECT r.family, c.client_name, min(r.created_at) AS since, max(r.created_at) AS last, max(r.expires_at) AS expires
      FROM oauth_refresh r JOIN oauth_client c ON c.client_id = r.client_id
      WHERE r.user_id = $1 AND r.revoked_at IS NULL GROUP BY r.family, c.client_name HAVING max(r.expires_at) > now() ORDER BY last DESC`, [userId]);
    return r.rows.map((x) => ({ family: x.family, clientName: x.client_name, since: iso(x.since)!, lastUsedAt: iso(x.last), expiresAt: iso(x.expires)! }));
  }
  async familyOwner(family: string): Promise<number | null> {
    const x = (await this.pool.query('SELECT user_id FROM oauth_refresh WHERE family = $1 LIMIT 1', [family])).rows[0];
    return x ? Number(x.user_id) : null;
  }
  /** Drop what has expired (codes, refresh tokens a month past expiry). */
  async sweep(): Promise<void> {
    await this.pool.query(`DELETE FROM oauth_code WHERE expires_at < now() - interval '1 hour'`);
    await this.pool.query(`DELETE FROM oauth_refresh WHERE expires_at < now() - interval '30 days'`);
  }
}
