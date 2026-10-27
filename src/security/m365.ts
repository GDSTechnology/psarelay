// Microsoft 365 person → Autotask resource (Copilot single sign-on, migration 0023).
//
// Fails closed and never guesses:
//   1. a stored link — by Entra object id, or a preload an administrator made by sign-in name (UPN);
//   2. else an automatic link when EXACTLY ONE active Autotask resource matches: email / email2 / email3 equal to the
//      person's sign-in name or email first; only if none, userName equal to the sign-in name or its part before @
//      (some Autotask logins are not the person's email);
//   3. else the person is told, plainly, that their system administrator has to link them — and is listed under
//      "Waiting to be linked" in the console. Nothing runs as anyone else (never as the API user).

import type { Pool } from 'pg';
import type { EntraIdentity, EntraTrust } from './entra.js';

export interface M365Tenant { tenantId: string; label: string; clientId: string; audiences: string[]; scope: string; enabled: boolean; createdAt: string; updatedAt: string }
export interface M365Link { id: number; tenantId: string; oid: string | null; upn: string; resourceId: number; resourceName: string; matchedBy: string; linkedBy: string | null; linkedAt: string; lastUsedAt: string | null }
export interface M365Waiting { tenantId: string; oid: string; upn: string; name: string; reason: 'no-match' | 'several'; candidates: Array<{ id: number; name: string }>; firstAt: string; lastAt: string; attempts: number }

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validTenantId = (t: unknown): t is string => typeof t === 'string' && GUID.test(t.trim());

export const resourceName = (r: Record<string, any>) => [r.firstName, r.lastName].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ') || String(r.email ?? '') || `Resource ${r.id}`;

/** Resources.licenseType 7 = "API User" (verified live 2026-10-26: 29 of 45 active resources, random usernames, shared emails). */
export const API_USER_LICENSE = 7;
/** Resource 4 = "Autotask Administrator", the built-in system account. */
export const SYSTEM_RESOURCE_ID = 4;
/** A resource a person may never be linked to: an API user or the built-in administrator. */
export const notAPerson = (r: Record<string, any>) => Number(r.id) === SYSTEM_RESOURCE_ID || Number(r.licenseType) === API_USER_LICENSE;

/** Which resources match a person, and how (pure — the rules above, step 2). API users and the system account never match. */
export function matchResources(identity: Pick<EntraIdentity, 'upn' | 'email'>, all: Array<Record<string, any>>): { by: 'email' | 'username' | null; matches: Array<Record<string, any>> } {
  const rows = all.filter((r) => !notAPerson(r));
  const lc = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const names = new Set([identity.upn, identity.email].map(lc).filter(Boolean));
  const local = lc(identity.upn).split('@')[0] ?? '';
  const byEmail = rows.filter((r) => ['email', 'email2', 'email3'].some((f) => names.has(lc(r[f]))));
  if (byEmail.length) return { by: 'email', matches: byEmail };
  const byUser = rows.filter((r) => { const u = lc(r.userName); return !!u && (names.has(u) || u === local); });
  return byUser.length ? { by: 'username', matches: byUser } : { by: null, matches: [] };
}

/** What the person sees when they can't be linked (no other people's names). */
export function unlinkedMessage(upn: string, reason: 'no-match' | 'several' | 'lookup-failed'): string {
  if (reason === 'lookup-failed') return `PSArelay couldn't look up your Autotask user just now (Autotask didn't answer). Nothing was changed — try again in a minute.`;
  const why = reason === 'several'
    ? 'more than one Autotask user matches it, so PSArelay won\'t guess'
    : 'no active Autotask user has that email address or username';
  return `Your Microsoft 365 account (${upn}) isn't linked to an Autotask user in PSArelay yet — ${why}. Ask your system administrator to link it (PSArelay console → Microsoft 365). Nothing was changed.`;
}

export class M365Store {
  constructor(private readonly pool: Pool) {}

  private tenant(x: Record<string, any>): M365Tenant {
    return { tenantId: x.tenant_id, label: x.label, clientId: x.client_id, audiences: Array.isArray(x.audiences) ? x.audiences : JSON.parse(x.audiences ?? '[]'), scope: x.scope, enabled: !!x.enabled, createdAt: iso(x.created_at)!, updatedAt: iso(x.updated_at)! };
  }
  async listTenants(): Promise<M365Tenant[]> { return (await this.pool.query('SELECT * FROM m365_tenant ORDER BY created_at')).rows.map((x) => this.tenant(x)); }
  async upsertTenant(t: { tenantId: string; label: string; clientId: string; audiences: string[]; scope: string; enabled: boolean }, by: string): Promise<M365Tenant> {
    const r = await this.pool.query(`INSERT INTO m365_tenant (tenant_id, label, client_id, audiences, scope, enabled, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (tenant_id) DO UPDATE SET label = EXCLUDED.label, client_id = EXCLUDED.client_id, audiences = EXCLUDED.audiences, scope = EXCLUDED.scope, enabled = EXCLUDED.enabled, updated_at = now() RETURNING *`,
      [t.tenantId.toLowerCase(), t.label, t.clientId, JSON.stringify(t.audiences), t.scope, t.enabled, by]);
    return this.tenant(r.rows[0]);
  }
  async deleteTenant(tenantId: string): Promise<boolean> { return ((await this.pool.query('DELETE FROM m365_tenant WHERE tenant_id = $1', [tenantId.toLowerCase()])).rowCount ?? 0) > 0; }
  /** The enabled tenants as token-check trust entries. */
  async trusts(): Promise<EntraTrust[]> {
    return (await this.listTenants()).filter((t) => t.enabled).map((t) => ({ tenantId: t.tenantId, audiences: t.audiences, scope: t.scope }));
  }

  private link(x: Record<string, any>): M365Link {
    return { id: Number(x.id), tenantId: x.tenant_id, oid: x.oid ?? null, upn: x.upn, resourceId: Number(x.resource_id), resourceName: x.resource_name, matchedBy: x.matched_by, linkedBy: x.linked_by ?? null, linkedAt: iso(x.linked_at)!, lastUsedAt: iso(x.last_used_at) };
  }
  async listLinks(): Promise<M365Link[]> { return (await this.pool.query('SELECT * FROM m365_link ORDER BY lower(upn)')).rows.map((x) => this.link(x)); }
  /** The link for a person: by object id, else a preload by sign-in name (which then gets the object id). */
  async findLink(id: Pick<EntraIdentity, 'tenantId' | 'oid' | 'upn'>): Promise<M365Link | null> {
    const byOid = (await this.pool.query('SELECT * FROM m365_link WHERE tenant_id = $1 AND oid = $2', [id.tenantId, id.oid])).rows[0];
    if (byOid) return this.link(byOid);
    const pre = (await this.pool.query('UPDATE m365_link SET oid = $3 WHERE tenant_id = $1 AND lower(upn) = lower($2) AND oid IS NULL RETURNING *', [id.tenantId, id.upn, id.oid])).rows[0];
    return pre ? this.link(pre) : null;
  }
  /** Create or replace the link for a person (by object id when known, else by sign-in name). */
  async saveLink(l: { tenantId: string; oid: string | null; upn: string; resourceId: number; resourceName: string; matchedBy: string; linkedBy: string | null }): Promise<M365Link> {
    if (l.oid) await this.pool.query('DELETE FROM m365_link WHERE tenant_id = $1 AND oid = $2', [l.tenantId, l.oid]);
    await this.pool.query('DELETE FROM m365_link WHERE tenant_id = $1 AND lower(upn) = lower($2)', [l.tenantId, l.upn]);
    const r = await this.pool.query('INSERT INTO m365_link (tenant_id, oid, upn, resource_id, resource_name, matched_by, linked_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [l.tenantId, l.oid, l.upn, l.resourceId, l.resourceName, l.matchedBy, l.linkedBy]);
    if (l.oid) await this.pool.query('DELETE FROM m365_waiting WHERE tenant_id = $1 AND oid = $2', [l.tenantId, l.oid]);
    await this.pool.query('DELETE FROM m365_waiting WHERE tenant_id = $1 AND lower(upn) = lower($2)', [l.tenantId, l.upn]);
    return this.link(r.rows[0]);
  }
  async deleteLink(id: number): Promise<M365Link | null> { const x = (await this.pool.query('DELETE FROM m365_link WHERE id = $1 RETURNING *', [id])).rows[0]; return x ? this.link(x) : null; }
  async touchLink(id: number): Promise<void> { await this.pool.query(`UPDATE m365_link SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`, [id]); }

  /** Record a person who could not be linked; true the first time (or first time today) — worth telling an admin. */
  async noteWaiting(w: { tenantId: string; oid: string; upn: string; name: string; reason: 'no-match' | 'several'; candidates: Array<{ id: number; name: string }> }): Promise<boolean> {
    const r = await this.pool.query(`INSERT INTO m365_waiting (tenant_id, oid, upn, name, reason, candidates) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (tenant_id, oid) DO UPDATE SET upn = EXCLUDED.upn, name = EXCLUDED.name, reason = EXCLUDED.reason, candidates = EXCLUDED.candidates, last_at = now(), attempts = m365_waiting.attempts + 1
      RETURNING (xmax = 0) AS inserted, first_at, (SELECT last_at FROM m365_waiting o WHERE o.tenant_id = $1 AND o.oid = $2) AS prev_last`,
      [w.tenantId, w.oid, w.upn, w.name, w.reason, JSON.stringify(w.candidates)]);
    const x = r.rows[0];
    return !!x?.inserted || (x?.prev_last != null && Date.now() - new Date(x.prev_last).getTime() > 24 * 3600_000);
  }
  async listWaiting(): Promise<M365Waiting[]> {
    return (await this.pool.query('SELECT * FROM m365_waiting ORDER BY last_at DESC')).rows.map((x) => ({
      tenantId: x.tenant_id, oid: x.oid, upn: x.upn, name: x.name, reason: x.reason, candidates: Array.isArray(x.candidates) ? x.candidates : JSON.parse(x.candidates ?? '[]'),
      firstAt: iso(x.first_at)!, lastAt: iso(x.last_at)!, attempts: Number(x.attempts),
    }));
  }
  async deleteWaiting(tenantId: string, oid: string): Promise<boolean> { return ((await this.pool.query('DELETE FROM m365_waiting WHERE tenant_id = $1 AND oid = $2', [tenantId, oid])).rowCount ?? 0) > 0; }
}

export type M365Resolution =
  | { status: 'linked'; resourceId: number; resourceName: string; linkId: number; matchedBy: string; autoLinked: boolean }
  | { status: 'unlinked'; reason: 'no-match' | 'several' | 'lookup-failed'; message: string };

export interface ResolveDeps {
  store: Pick<M365Store, 'findLink' | 'saveLink' | 'noteWaiting'>;
  /** Active resources whose email / email2 / email3 / userName is one of these names. */
  findResources: (names: string[]) => Promise<Array<Record<string, any>>>;
  /** Told once per person per day when someone is waiting to be linked. */
  onWaiting?: (w: { upn: string; reason: 'no-match' | 'several' }) => void;
  onAutoLinked?: (l: { upn: string; resourceId: number; resourceName: string; by: string }) => void;
}

/** Resolve a verified Microsoft 365 person to their Autotask resource (rules at the top of this file). */
export async function resolveM365(id: EntraIdentity, d: ResolveDeps): Promise<M365Resolution> {
  const existing = await d.store.findLink(id);
  if (existing) {
    return { status: 'linked', resourceId: existing.resourceId, resourceName: existing.resourceName, linkId: existing.id, matchedBy: existing.matchedBy, autoLinked: false };
  }
  let rows: Array<Record<string, any>>;
  const local = id.upn.split('@')[0] ?? '';
  try { rows = await d.findResources([id.upn, ...(id.email ? [id.email] : []), ...(local && local !== id.upn ? [local] : [])]); }
  catch { return { status: 'unlinked', reason: 'lookup-failed', message: unlinkedMessage(id.upn, 'lookup-failed') }; }
  const m = matchResources(id, rows);
  if (m.matches.length === 1) {
    const r = m.matches[0]!, name = resourceName(r), by = `auto:${m.by}`;
    const l = await d.store.saveLink({ tenantId: id.tenantId, oid: id.oid, upn: id.upn, resourceId: Number(r.id), resourceName: name, matchedBy: by, linkedBy: null });
    d.onAutoLinked?.({ upn: id.upn, resourceId: l.resourceId, resourceName: name, by });
    return { status: 'linked', resourceId: l.resourceId, resourceName: name, linkId: l.id, matchedBy: by, autoLinked: true };
  }
  const reason = m.matches.length > 1 ? 'several' : 'no-match';
  const first = await d.store.noteWaiting({ tenantId: id.tenantId, oid: id.oid, upn: id.upn, name: id.name, reason, candidates: m.matches.slice(0, 10).map((r) => ({ id: Number(r.id), name: resourceName(r) })) });
  if (first) d.onWaiting?.({ upn: id.upn, reason });
  return { status: 'unlinked', reason, message: unlinkedMessage(id.upn, reason) };
}
