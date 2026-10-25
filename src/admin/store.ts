// Postgres access for the admin console (migration 0004). All admin SQL lives
// here; the HTTP layer and the CLI call these methods.

import { hashPassword, hashToken, newSessionToken } from './passwords.js';

export type AdminRole = 'admin' | 'viewer';

export interface AdminUser {
  id: number;
  username: string;
  role: AdminRole;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: string;
  createdBy: string | null;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  /** The Autotask resource this user is (migration 0019); null = not linked. */
  autotaskResourceId: number | null;
  autotaskResourceName: string | null;
}

export interface AdminEvent { id: number; at: string; actor: string | null; action: string; details: Record<string, unknown>; ip: string | null }

/** The slice of pg's Pool the store needs (lets tests pass a fake). */
type Row = Record<string, unknown>;
export interface Queryable {
  query<R extends Row = Row>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const toUser = (r: Row): AdminUser => ({
  id: Number(r.id), username: String(r.username), role: r.role as AdminRole, mustChangePassword: !!r.must_change_password, disabled: !!r.disabled,
  createdAt: iso(r.created_at)!, createdBy: (r.created_by as string | null) ?? null, passwordChangedAt: iso(r.password_changed_at), lastLoginAt: iso(r.last_login_at),
  autotaskResourceId: r.autotask_resource_id == null ? null : Number(r.autotask_resource_id), autotaskResourceName: (r.autotask_resource_name as string | null) ?? null,
});
const USER_COLS = 'id, username, role, must_change_password, disabled, created_at, created_by, password_changed_at, last_login_at, autotask_resource_id, autotask_resource_name';

export const SESSION_IDLE_HOURS = 12;
export const SESSION_MAX_DAYS = 7;

export class AdminStore {
  constructor(private readonly db: Queryable) {}

  // ── users ────────────────────────────────────────────────────────────────
  async countUsers(): Promise<number> {
    const r = await this.db.query<{ n: string }>('SELECT count(*) AS n FROM admin_user');
    return Number(r.rows[0]?.n ?? 0);
  }

  async listUsers(): Promise<AdminUser[]> {
    const r = await this.db.query(`SELECT ${USER_COLS} FROM admin_user ORDER BY lower(username)`);
    return r.rows.map(toUser);
  }

  async getUser(id: number): Promise<AdminUser | null> {
    const r = await this.db.query(`SELECT ${USER_COLS} FROM admin_user WHERE id = $1`, [id]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  /** The user plus their password hash, for login. */
  async findForLogin(username: string): Promise<(AdminUser & { passwordHash: string }) | null> {
    const r = await this.db.query(`SELECT ${USER_COLS}, password_hash FROM admin_user WHERE lower(username) = lower($1)`, [username]);
    return r.rows[0] ? { ...toUser(r.rows[0]), passwordHash: String(r.rows[0].password_hash) } : null;
  }

  async passwordHashOf(id: number): Promise<string | null> {
    const r = await this.db.query<{ password_hash: string }>('SELECT password_hash FROM admin_user WHERE id = $1', [id]);
    return r.rows[0]?.password_hash ?? null;
  }

  /** Create a user. `mustChange` forces a new password at first login (true for generated passwords). */
  async createUser(username: string, password: string, role: AdminRole, createdBy: string | null, mustChange = true): Promise<AdminUser> {
    const hash = await hashPassword(password);
    const r = await this.db.query(
      `INSERT INTO admin_user (username, password_hash, role, must_change_password, created_by, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING ${USER_COLS}`,
      [username, hash, role, mustChange, createdBy],
    );
    return toUser(r.rows[0]!);
  }

  /** Set a password. Signs the user out everywhere except `keepSessionHash`. */
  async setPassword(id: number, password: string, mustChange: boolean, keepSessionHash?: string): Promise<void> {
    const hash = await hashPassword(password);
    await this.db.query('UPDATE admin_user SET password_hash = $2, must_change_password = $3, password_changed_at = now() WHERE id = $1', [id, hash, mustChange]);
    await this.db.query('DELETE FROM admin_session WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2', [id, keepSessionHash ?? null]);
  }

  async updateUser(id: number, patch: { role?: AdminRole; disabled?: boolean }): Promise<AdminUser | null> {
    const sets: string[] = [], params: unknown[] = [id];
    if (patch.role) { params.push(patch.role); sets.push(`role = $${params.length}`); }
    if (patch.disabled !== undefined) { params.push(patch.disabled); sets.push(`disabled = $${params.length}`); }
    if (!sets.length) return this.getUser(id);
    const r = await this.db.query(`UPDATE admin_user SET ${sets.join(', ')} WHERE id = $1 RETURNING ${USER_COLS}`, params);
    if (patch.disabled) await this.db.query('DELETE FROM admin_session WHERE user_id = $1', [id]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  /** Link (or unlink, with null) the Autotask resource this user is. Tokens bound to the old link stop working. */
  async setAutotaskLink(id: number, link: { id: number; name: string } | null): Promise<AdminUser | null> {
    const r = await this.db.query(`UPDATE admin_user SET autotask_resource_id = $2, autotask_resource_name = $3 WHERE id = $1 RETURNING ${USER_COLS}`, [id, link?.id ?? null, link?.name ?? null]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async deleteUser(id: number): Promise<boolean> {
    const r = await this.db.query('DELETE FROM admin_user WHERE id = $1', [id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Active admins other than `exceptId` — the console must never lose its last admin. */
  async otherActiveAdmins(exceptId: number): Promise<number> {
    const r = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM admin_user WHERE role = 'admin' AND NOT disabled AND id <> $1`, [exceptId]);
    return Number(r.rows[0]?.n ?? 0);
  }

  async recordLogin(id: number): Promise<void> {
    await this.db.query('UPDATE admin_user SET last_login_at = now() WHERE id = $1', [id]);
  }

  // ── sessions ─────────────────────────────────────────────────────────────
  /** Start a session; returns the cookie token (only its hash is stored). */
  async createSession(userId: number, ip: string | null, userAgent: string | null): Promise<{ token: string; tokenHash: string }> {
    const token = newSessionToken();
    const tokenHash = hashToken(token);
    await this.db.query(
      `INSERT INTO admin_session (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
      [tokenHash, userId, SESSION_MAX_DAYS, ip, userAgent?.slice(0, 300) ?? null],
    );
    // Opportunistic cleanup of expired sessions.
    await this.db.query(`DELETE FROM admin_session WHERE expires_at < now() OR last_seen_at < now() - make_interval(hours => $1)`, [SESSION_IDLE_HOURS]);
    return { token, tokenHash };
  }

  /** The signed-in user for a cookie token, or null (expired, idle too long, disabled). Touches last_seen. */
  async sessionUser(token: string): Promise<{ user: AdminUser; tokenHash: string } | null> {
    const tokenHash = hashToken(token);
    const r = await this.db.query(
      `UPDATE admin_session s SET last_seen_at = now()
         FROM admin_user u
        WHERE s.token_hash = $1 AND u.id = s.user_id AND NOT u.disabled
          AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(hours => $2)
      RETURNING ${USER_COLS.split(', ').map((c) => `u.${c}`).join(', ')}`,
      [tokenHash, SESSION_IDLE_HOURS],
    );
    return r.rows[0] ? { user: toUser(r.rows[0]), tokenHash } : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM admin_session WHERE token_hash = $1', [tokenHash]);
  }

  async deleteSessionsOf(userId: number): Promise<void> {
    await this.db.query('DELETE FROM admin_session WHERE user_id = $1', [userId]);
  }

  // ── settings ─────────────────────────────────────────────────────────────
  async loadSettings(): Promise<Record<string, unknown>> {
    const r = await this.db.query<{ key: string; value: unknown }>('SELECT key, value FROM admin_setting');
    return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  }

  async saveSetting(key: string, value: unknown, by: string): Promise<void> {
    await this.db.query(
      `INSERT INTO admin_setting (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), by],
    );
  }

  async clearSetting(key: string): Promise<void> {
    await this.db.query('DELETE FROM admin_setting WHERE key = $1', [key]);
  }

  // ── change log ───────────────────────────────────────────────────────────
  async logEvent(actor: string | null, action: string, details: Record<string, unknown> = {}, ip: string | null = null): Promise<void> {
    await this.db.query('INSERT INTO admin_event (actor, action, details, ip) VALUES ($1, $2, $3::jsonb, $4)', [actor, action, JSON.stringify(details), ip]);
  }

  async listEvents(limit = 200, beforeId?: number): Promise<AdminEvent[]> {
    const r = await this.db.query(
      `SELECT id, at, actor, action, details, ip FROM admin_event ${beforeId ? 'WHERE id < $2' : ''} ORDER BY id DESC LIMIT $1`,
      beforeId ? [Math.min(limit, 1000), beforeId] : [Math.min(limit, 1000)],
    );
    return r.rows.map((x) => ({ id: Number(x.id), at: iso(x.at)!, actor: (x.actor as string | null) ?? null, action: String(x.action), details: (x.details as Record<string, unknown> | null) ?? {}, ip: (x.ip as string | null) ?? null }));
  }
}
