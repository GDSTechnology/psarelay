// SLA credits: the outage log (written while an outage is open), the monthly claim drafts, the settings and the
// Microsoft 365 mail app — all in Postgres (migration 0027 + admin_setting 'sla.config').

import type { Queryable } from '../admin/store.js';
import { decryptSecret, encryptSecret, secretKeyStatus } from '../security/secrets.js';
import { outageStatus } from '../services/upstream-guard.js';
import { notify } from '../services/notifier.js';
import { buildClaim, DEFAULT_SLA_SETTINGS, monthStart, previousMonth, type ClaimDraft, type OutageRow, type SlaSettings, validEmail } from './claim.js';
import { sendGraphMail, validGuid, type GraphMailConfig } from './graph-mail.js';

export const SLA_SETTING_KEY = 'sla.config';

export interface StoredMail { tenantId: string; clientId: string; secretEnc: string | null; sender: string }
export interface StoredSla { settings: SlaSettings; mail: StoredMail | null }
export interface MailView { tenantId: string; clientId: string; sender: string; hasSecret: boolean }

export interface ClaimRow {
  id: number; month: string; status: 'draft' | 'sending' | 'sent' | 'dismissed'; downtimeSeconds: number; incidents: number; uptimePct: number;
  to: string[]; cc: string[]; subject: string; bodyText: string; createdAt: string; updatedAt: string;
  sentAt: string | null; sentBy: string | null; sentFrom: string | null; dismissedBy: string | null;
}

type Row = Record<string, any>;
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const toOutage = (r: Row): OutageRow => ({
  id: Number(r.id), startedAt: iso(r.started_at)!, endedAt: iso(r.ended_at), lastSeenAt: iso(r.last_seen_at)!, confirmedBack: !!r.confirmed_back,
  endedReason: r.ended_reason ?? null, failures: Number(r.failures), endpoints: r.endpoints ?? [], httpStatuses: (r.http_statuses ?? []).map(Number),
  networkErrors: Number(r.network_errors), lastError: r.last_error ?? null,
});
const toClaim = (r: Row): ClaimRow => ({
  id: Number(r.id), month: iso(r.month)!.slice(0, 10), status: r.status, downtimeSeconds: Number(r.downtime_seconds), incidents: Number(r.incidents),
  uptimePct: Number(r.uptime_pct), to: r.to_addresses ?? [], cc: r.cc_addresses ?? [], subject: r.subject, bodyText: r.body_text,
  createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, sentAt: iso(r.sent_at), sentBy: r.sent_by ?? null, sentFrom: r.sent_from ?? null, dismissedBy: r.dismissed_by ?? null,
});

export class SlaInputError extends Error {}

export class SlaStore {
  constructor(private readonly db: Queryable, private readonly tenant: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  // ── settings + mail app ──
  async load(): Promise<StoredSla> {
    const r = await this.db.query<{ value: any }>('SELECT value FROM admin_setting WHERE key = $1', [SLA_SETTING_KEY]);
    const v = r.rows[0]?.value ?? {};
    return { settings: { ...DEFAULT_SLA_SETTINGS, ...(v.settings ?? {}) }, mail: v.mail ?? null };
  }
  private async save(s: StoredSla, by: string): Promise<void> {
    await this.db.query(
      `INSERT INTO admin_setting (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [SLA_SETTING_KEY, JSON.stringify(s), by],
    );
  }
  async saveSettings(settings: SlaSettings, by: string): Promise<void> { const s = await this.load(); await this.save({ ...s, settings }, by); }

  static mailView(m: StoredMail | null): MailView | null { return m ? { tenantId: m.tenantId, clientId: m.clientId, sender: m.sender, hasSecret: !!m.secretEnc } : null; }

  /** Save the mail app. An empty clientSecret keeps the stored one; null clears the whole app. */
  async saveMail(b: Record<string, unknown> | null, by: string): Promise<void> {
    const s = await this.load();
    if (b === null) { await this.save({ ...s, mail: null }, by); return; }
    const str = (k: string) => String(b[k] ?? '').trim();
    const tenantId = str('tenantId'), clientId = str('clientId'), sender = str('sender'), secret = str('clientSecret');
    if (!validGuid(tenantId)) throw new SlaInputError('Tenant ID must be the directory (tenant) GUID from Entra.');
    if (!validGuid(clientId)) throw new SlaInputError('Client ID must be the application (client) GUID from Entra.');
    if (!validEmail(sender)) throw new SlaInputError('Sender must be the mailbox address the claims are sent from.');
    let secretEnc = s.mail?.secretEnc ?? null;
    if (secret) {
      const k = secretKeyStatus(this.env);
      if (!k.ok) throw new SlaInputError(k.detail);
      secretEnc = encryptSecret(secret, this.env);
    }
    if (!secretEnc) throw new SlaInputError('Paste the client secret.');
    await this.save({ ...s, mail: { tenantId, clientId, sender, secretEnc } }, by);
  }

  async mailConfig(): Promise<GraphMailConfig> {
    const m = (await this.load()).mail;
    if (!m?.secretEnc) throw new SlaInputError('Set up the Microsoft 365 mailbox first (SLA credits → Mail).');
    return { tenantId: m.tenantId, clientId: m.clientId, sender: m.sender, clientSecret: decryptSecret(m.secretEnc, this.env) };
  }

  // ── outage log ──
  async outages(fromIso: string, toIso: string): Promise<OutageRow[]> {
    const r = await this.db.query(
      `SELECT * FROM autotask_outage WHERE tenant = $1 AND started_at < $3 AND COALESCE(ended_at, last_seen_at, now()) >= $2 ORDER BY started_at`,
      [this.tenant, fromIso, toIso],
    );
    return r.rows.map(toOutage);
  }

  // ── claims ──
  async claims(limit = 24): Promise<ClaimRow[]> {
    const r = await this.db.query('SELECT * FROM sla_claim WHERE tenant = $1 ORDER BY month DESC LIMIT $2', [this.tenant, limit]);
    return r.rows.map(toClaim);
  }
  async claim(id: number): Promise<ClaimRow | null> {
    const r = await this.db.query('SELECT * FROM sla_claim WHERE tenant = $1 AND id = $2', [this.tenant, id]);
    return r.rows[0] ? toClaim(r.rows[0]) : null;
  }

  /** Draft for a month from its outages (now). */
  async draftFor(month: string | Date, now = Date.now()): Promise<ClaimDraft> {
    const from = monthStart(month);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const { settings } = await this.load();
    return buildClaim(await this.outages(from.toISOString(), to.toISOString()), from, settings, now);
  }

  /**
   * Save (or refresh) the month's draft. A sent claim is never touched; a dismissed one only when `force`.
   * Returns null when nothing qualifies and `force` is off.
   */
  async saveDraft(d: ClaimDraft, opts: { force?: boolean } = {}): Promise<ClaimRow | null> {
    if (!d.qualifies && !opts.force) return null;
    const { settings } = await this.load();
    const r = await this.db.query(
      `INSERT INTO sla_claim (tenant, month, status, downtime_seconds, incidents, uptime_pct, to_addresses, cc_addresses, subject, body_text)
       VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant, month) DO UPDATE SET status = 'draft', downtime_seconds = EXCLUDED.downtime_seconds, incidents = EXCLUDED.incidents,
         uptime_pct = EXCLUDED.uptime_pct, to_addresses = EXCLUDED.to_addresses, cc_addresses = EXCLUDED.cc_addresses,
         subject = EXCLUDED.subject, body_text = EXCLUDED.body_text, updated_at = now(), dismissed_by = NULL
       WHERE sla_claim.status = 'draft' OR (sla_claim.status = 'dismissed' AND $10)
       RETURNING *`,
      [this.tenant, d.month, d.downtimeSeconds, d.countedIncidents, d.uptimePct, settings.to, settings.cc, d.subject, d.bodyText, !!opts.force],
    );
    return r.rows[0] ? toClaim(r.rows[0]) : null;
  }

  async editDraft(id: number, b: { subject?: unknown; bodyText?: unknown; to?: string[]; cc?: string[] }): Promise<ClaimRow> {
    const c = await this.claim(id);
    if (!c) throw new SlaInputError('No such claim.');
    if (c.status !== 'draft') throw new SlaInputError(`This claim is ${c.status}; only a draft can be changed.`);
    const subject = b.subject != null ? String(b.subject).trim().slice(0, 250) : c.subject;
    const body = b.bodyText != null ? String(b.bodyText).slice(0, 20_000) : c.bodyText;
    if (!subject || !body.trim()) throw new SlaInputError('Subject and text can\'t be empty.');
    const r = await this.db.query(
      `UPDATE sla_claim SET subject = $3, body_text = $4, to_addresses = $5, cc_addresses = $6, updated_at = now() WHERE tenant = $1 AND id = $2 AND status = 'draft' RETURNING *`,
      [this.tenant, id, subject, body, b.to ?? c.to, b.cc ?? c.cc],
    );
    return toClaim(r.rows[0]);
  }

  async dismiss(id: number, by: string): Promise<void> {
    const r = await this.db.query(`UPDATE sla_claim SET status = 'dismissed', dismissed_by = $3, updated_at = now() WHERE tenant = $1 AND id = $2 AND status = 'draft'`, [this.tenant, id, by]);
    if (!r.rowCount) throw new SlaInputError('Only a draft can be dismissed.');
  }

  /**
   * Email the draft to Kaseya from the configured mailbox, then mark it sent. The row is claimed first
   * (status 'sending' guard via the WHERE) so two clicks can't send it twice.
   */
  async send(id: number, by: string, sendMail: typeof sendGraphMail = sendGraphMail): Promise<ClaimRow> {
    const c = await this.claim(id);
    if (!c) throw new SlaInputError('No such claim.');
    if (c.status !== 'draft') throw new SlaInputError(`This claim is already ${c.status}.`);
    if (!c.to.length) throw new SlaInputError('The claim has no recipient — add Kaseya\'s address in the settings, then Rebuild.');
    const mail = await this.mailConfig();
    const lock = await this.db.query(`UPDATE sla_claim SET status = 'sending', updated_at = now() WHERE tenant = $1 AND id = $2 AND status = 'draft'`, [this.tenant, id]);
    if (!lock.rowCount) throw new SlaInputError('This claim is being sent already.');
    try {
      await sendMail(mail, { to: c.to, cc: c.cc, subject: c.subject, text: c.bodyText });
    } catch (e) {
      await this.db.query(`UPDATE sla_claim SET status = 'draft', updated_at = now() WHERE tenant = $1 AND id = $2 AND status = 'sending'`, [this.tenant, id]);
      throw e;
    }
    const r = await this.db.query(
      `UPDATE sla_claim SET status = 'sent', sent_at = now(), sent_by = $3, sent_from = $4, updated_at = now() WHERE tenant = $1 AND id = $2 RETURNING *`,
      [this.tenant, id, by, mail.sender],
    );
    return toClaim(r.rows[0]);
  }
}

// ── runtime: the outage recorder (every 20 s) and the monthly draft (on the 1st) ──

/** One recorder step. Returns the open row id (null when no outage is open). */
export async function recordOutageTick(db: Queryable, tenant: string, openId: number | null, now = Date.now(), status = outageStatus(tenant, now)): Promise<number | null> {
  if (status) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO autotask_outage (tenant, started_at, last_seen_at, failures, endpoints, http_statuses, network_errors, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant, started_at) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
         failures = GREATEST(autotask_outage.failures, EXCLUDED.failures),
         endpoints = ARRAY(SELECT DISTINCT unnest(autotask_outage.endpoints || EXCLUDED.endpoints)),
         http_statuses = ARRAY(SELECT DISTINCT unnest(autotask_outage.http_statuses || EXCLUDED.http_statuses) ORDER BY 1),
         network_errors = GREATEST(autotask_outage.network_errors, EXCLUDED.network_errors),
         last_error = COALESCE(NULLIF(EXCLUDED.last_error, ''), autotask_outage.last_error)
       RETURNING id`,
      [tenant, status.since, new Date(now).toISOString(), status.failures, status.endpoints, status.httpStatuses, status.networkErrors, status.lastError],
    );
    return Number(r.rows[0]!.id);
  }
  if (openId != null) {
    await db.query(`UPDATE autotask_outage SET ended_at = $2, confirmed_back = true, ended_reason = 'back' WHERE id = $1 AND ended_at IS NULL`, [openId, new Date(now).toISOString()]);
  }
  return null;
}

/** Hour (UTC) on the 1st when last month's claim is drafted. */
export const SLA_DRAFT_HOUR_UTC = 6;

/** Draft last month's claim when it is due (the 1st, from SLA_DRAFT_HOUR_UTC) and none exists yet. */
export async function monthlyDraftTick(store: SlaStore, now = Date.now()): Promise<ClaimRow | null> {
  const d = new Date(now);
  if (d.getUTCDate() !== 1 || d.getUTCHours() < SLA_DRAFT_HOUR_UTC) return null;
  const { settings } = await store.load();
  if (!settings.enabled) return null;
  const month = previousMonth(d);
  if ((await store.claims(3)).some((c) => c.month === month.toISOString().slice(0, 10))) return null;
  const draft = await store.draftFor(month, now);
  const row = await store.saveDraft(draft);
  if (row) {
    notify({
      type: 'sla.claim_ready', severity: 'info', title: `SLA credit claim ready — ${draft.monthLabel}`,
      detail: `Autotask was down ${draft.countedIncidents} time(s) in ${draft.monthLabel}, ${Math.round(draft.downtimeSeconds / 60)} min in all (${draft.uptimePct.toFixed(3)}% up). Review and send it on the console's SLA credits page.`,
      fields: { downtime: `${Math.round(draft.downtimeSeconds / 60)} min`, outages: String(draft.countedIncidents) }, dedupeKey: `sla.claim_ready:${draft.month}`,
    });
  }
  return row;
}

/** Start the recorder + monthly draft (http transport with Postgres). Returns a stop function. */
export function startSlaRuntime(o: { tenant: string; getPool: () => Queryable | null; logger: { warn(m: string): void; info(m: string): void }; intervalMs?: number }): () => void {
  const tenant = o.tenant.toLowerCase();
  let openId: number | null = null;
  let started = false;
  let lastDraftCheck = 0;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    const db = o.getPool();
    if (!db) return;
    busy = true;
    try {
      if (!started) {
        // A restart cut any open outage's watch short: it ended no later than it was last seen.
        await db.query(`UPDATE autotask_outage SET ended_at = last_seen_at, ended_reason = 'restart' WHERE tenant = $1 AND ended_at IS NULL`, [tenant]);
        started = true;
      }
      openId = await recordOutageTick(db, tenant, openId);
      if (Date.now() - lastDraftCheck > 10 * 60_000) {
        lastDraftCheck = Date.now();
        await monthlyDraftTick(new SlaStore(db, tenant));
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (!/autotask_outage|sla_claim/.test(m)) o.logger.warn(`SLA credits: ${m}`);
    } finally { busy = false; }
  };
  void tick();
  const t = setInterval(() => { void tick(); }, o.intervalMs ?? 20_000);
  t.unref?.();
  o.logger.info('SLA credits: logging Autotask outages; last month\'s claim is drafted on the 1st');
  return () => clearInterval(t);
}
