// Outbound notifications (admin console → Notifications): when something
// trips — the Autotask login is paused or held, Autotask says stop, a 429,
// the mirror fails a sync or its consistency check, a write fails half-way,
// a burst of tool errors — post it to Discord, Microsoft Teams, Slack or any
// JSON webhook. Channels and their event choices are managed in the console.
//
// Delivery is best-effort and never blocks or fails the code that raised the
// event: sends are queued, time out after 10 s, are not retried (except one
// wait on a Discord/Slack 429), and the same event (dedupeKey) is sent to a
// channel at most once per cooldown so a flapping condition doesn't spam.

import { createHmac } from 'node:crypto';

export type NotifyEventType =
  | 'test'
  | 'auth.paused' | 'auth.held' | 'auth.cleared'
  | 'backpressure.stop' | 'backpressure.recovered'
  | 'ratelimit.hit'
  | 'shadow.sync_error' | 'shadow.verify_failed'
  | 'operation.partial'
  | 'tool.errors'
  | 'sync.drift' | 'reconcile.critical'
  | 'vendor.import_stale' | 'vendor.renewal' | 'vendor.contract_ending'
  | 'vendor.exception_overdue' | 'vendor.notice_due'
  | 'bulk.paused' | 'bulk.done'
  | 'commerce.order_ready' | 'commerce.order_invoiced' | 'commerce.order_paid' | 'commerce.order_failed' | 'commerce.subscription_changed'
  | 'platform.upgrade_requested'
  | 'platform.plan_requested';

export const NOTIFY_EVENTS: Array<{ type: Exclude<NotifyEventType, 'test'>; label: string; severity: NotifySeverity }> = [
  { type: 'auth.held', label: 'Autotask login HELD (needs Retry now)', severity: 'critical' },
  { type: 'auth.paused', label: 'Autotask login paused after a failed login', severity: 'warning' },
  { type: 'auth.cleared', label: 'Autotask login working again', severity: 'info' },
  { type: 'backpressure.stop', label: 'Backpressure: stop (usage ≥ 90%, 429, login)', severity: 'warning' },
  { type: 'backpressure.recovered', label: 'Backpressure back to ok', severity: 'info' },
  { type: 'ratelimit.hit', label: 'Autotask 429 (threshold exceeded)', severity: 'warning' },
  { type: 'shadow.sync_error', label: 'Mirror sync error on an entity', severity: 'warning' },
  { type: 'shadow.verify_failed', label: 'Mirror consistency check failed', severity: 'warning' },
  { type: 'operation.partial', label: 'A write failed after writing (partial)', severity: 'critical' },
  { type: 'tool.errors', label: 'Burst of tool errors (5+ in 5 min)', severity: 'warning' },
  { type: 'sync.drift', label: 'An approved price / catalog change was overwritten (sync drift)', severity: 'critical' },
  { type: 'reconcile.critical', label: 'Vendor reconciliation found critical exceptions (below cost / not billed)', severity: 'warning' },
  { type: 'vendor.import_stale', label: 'No vendor invoice imported for over a month', severity: 'warning' },
  { type: 'vendor.renewal', label: 'Vendor subscriptions renewing within 30 days', severity: 'info' },
  { type: 'vendor.contract_ending', label: 'A contract holding vendor products ends within 45 days', severity: 'warning' },
  { type: 'vendor.exception_overdue', label: 'Reconciliation exceptions past their due date, still undecided', severity: 'warning' },
  { type: 'bulk.paused', label: 'A bulk job paused (canary done, login problem, repeated failures)', severity: 'warning' },
  { type: 'bulk.done', label: 'A bulk job finished', severity: 'info' },
  { type: 'commerce.order_ready', label: 'An order is set up in Autotask and waits for its invoice', severity: 'info' },
  { type: 'commerce.order_invoiced', label: 'An order was invoiced', severity: 'info' },
  { type: 'commerce.order_paid', label: 'An order was paid (build the account, start onboarding)', severity: 'info' },
  { type: 'commerce.order_failed', label: 'An order failed to set up in Autotask', severity: 'warning' },
  { type: 'commerce.subscription_changed', label: 'A subscription changed (upgrade, add-on, seats, downgrade, cancel)', severity: 'info' },
  { type: 'platform.upgrade_requested', label: 'A user asked for a module that is not on the plan', severity: 'info' },
  { type: 'platform.plan_requested', label: 'A user asked to choose a plan (free trial or read-only plan)', severity: 'info' },
  { type: 'vendor.notice_due', label: 'A customer price change takes effect within 30 days with no notice recorded', severity: 'warning' },
];

export type NotifySeverity = 'info' | 'warning' | 'critical';
export type ChannelKind = 'discord' | 'teams' | 'slack' | 'generic';

export interface NotifyEvent {
  type: NotifyEventType;
  severity: NotifySeverity;
  title: string;
  detail: string;
  fields?: Record<string, string>;
  at?: string;
  /** Same key within the cooldown is sent once per channel. Default: type. */
  dedupeKey?: string;
}

export interface NotifyChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  url: string;
  events: NotifyEventType[];
  enabled: boolean;
  /** generic only: HMAC-SHA256 key for the X-PSArelay-Signature header (also sent as the deprecated X-Atmcp-Signature until the next major release). */
  secret?: string;
}

export interface ChannelStatus { lastSentAt: string | null; lastEvent: string | null; lastError: string | null; lastErrorAt: string | null; sent: number; failed: number }

// ----------------------------------------------------------- validation

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i;

/** A channel URL problem (null = fine): https only, no internal / private addresses. */
export function channelUrlProblem(kind: ChannelKind, raw: string): string | null {
  let u: URL;
  try { u = new URL(String(raw ?? '').trim()); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'https:') return 'must be an https:// URL';
  if (u.username || u.password) return 'must not contain a username or password';
  if (PRIVATE_HOST.test(u.hostname)) return 'must be a public host (internal / private addresses are not allowed)';
  const h = u.hostname.toLowerCase();
  if (kind === 'discord' && !(/(^|\.)discord(app)?\.com$/.test(h) && u.pathname.startsWith('/api/webhooks/'))) return 'a Discord webhook URL looks like https://discord.com/api/webhooks/…';
  if (kind === 'slack' && h !== 'hooks.slack.com') return 'a Slack webhook URL looks like https://hooks.slack.com/services/…';
  if (kind === 'teams' && !/(\.webhook\.office\.com|\.logic\.azure\.com|\.powerplatform\.com|\.environment\.api\.powerplatform\.com)$/.test(h)) return 'a Teams URL comes from a Teams Workflow ("When a Teams webhook request is received") — *.logic.azure.com / *.powerplatform.com — or a legacy *.webhook.office.com connector';
  return null;
}

/** Show a stored URL without its secret path (for the console list). */
export function maskUrl(raw: string): string {
  try { const u = new URL(raw); const p = u.pathname; return `${u.protocol}//${u.host}${p.length > 16 ? `${p.slice(0, 12)}…${p.slice(-4)}` : p}${u.search ? '?…' : ''}`; } catch { return '…'; }
}

// ----------------------------------------------------------- formatting

const COLOR = { info: 0x2e7d32, warning: 0xf9a825, critical: 0xc62828 } as const;
const TEAMS_COLOR = { info: 'Good', warning: 'Warning', critical: 'Attention' } as const;
const ICON = { info: 'ℹ️', warning: '⚠️', critical: '🚨' } as const;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The request body each service expects. */
export function formatPayload(kind: ChannelKind, e: NotifyEvent, server: string): Record<string, unknown> {
  const at = e.at ?? new Date().toISOString();
  const fields = Object.entries(e.fields ?? {}).slice(0, 20);
  if (kind === 'discord') {
    return {
      username: 'PSArelay',
      allowed_mentions: { parse: [] }, // never @everyone / @here from event text
      embeds: [{
        title: clip(`${ICON[e.severity]} ${e.title}`, 256), description: clip(e.detail, 4000), color: COLOR[e.severity], timestamp: at,
        fields: fields.map(([name, value]) => ({ name: clip(name, 256), value: clip(value || '—', 1024), inline: true })),
        footer: { text: clip(`${server} · ${e.type}`, 2048) },
      }],
    };
  }
  if (kind === 'teams') {
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
          body: [
            { type: 'TextBlock', size: 'Medium', weight: 'Bolder', color: TEAMS_COLOR[e.severity], text: clip(`${ICON[e.severity]} ${e.title}`, 300), wrap: true },
            { type: 'TextBlock', text: clip(e.detail, 4000), wrap: true },
            ...(fields.length ? [{ type: 'FactSet', facts: fields.map(([title, value]) => ({ title: clip(title, 100), value: clip(value || '—', 500) })) }] : []),
            { type: 'TextBlock', text: `${server} · ${e.type} · ${at}`, isSubtle: true, size: 'Small', wrap: true },
          ],
        },
      }],
    };
  }
  if (kind === 'slack') {
    const lines = fields.map(([k, v]) => `• *${k}:* ${v || '—'}`).join('\n');
    return { text: clip(`${ICON[e.severity]} *${e.title}*\n${e.detail}${lines ? `\n${lines}` : ''}\n_${server} · ${e.type} · ${at}_`, 3900) };
  }
  return { event: e.type, severity: e.severity, title: e.title, detail: e.detail, fields: e.fields ?? {}, at, server };
}

// ----------------------------------------------------------- delivery

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;

export class Notifier {
  private channels: NotifyChannel[] = [];
  private status = new Map<string, ChannelStatus>();
  private lastSent = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: { server?: string; cooldownMs?: number; fetch?: Fetch; log?: (msg: string) => void } = {},
  ) {}

  setChannels(channels: NotifyChannel[]): void { this.channels = channels; }
  getChannels(): NotifyChannel[] { return this.channels; }
  channelStatus(id: string): ChannelStatus {
    return this.status.get(id) ?? { lastSentAt: null, lastEvent: null, lastError: null, lastErrorAt: null, sent: 0, failed: 0 };
  }

  /** Raise an event: queued to every enabled channel subscribed to it. Never throws. */
  emit(e: NotifyEvent): void {
    const now = Date.now();
    const cooldown = this.opts.cooldownMs ?? 15 * 60_000;
    for (const c of this.channels) {
      if (!c.enabled || !c.events.includes(e.type)) continue;
      const key = `${c.id}|${e.dedupeKey ?? e.type}`;
      const last = this.lastSent.get(key);
      if (last !== undefined && now - last < cooldown) continue;
      this.lastSent.set(key, now);
      this.queue = this.queue.then(() => this.send(c, e).then(() => undefined, () => undefined));
    }
  }

  /** Send one event to one channel now (console "Send test"); resolves with the outcome. */
  async send(c: NotifyChannel, e: NotifyEvent): Promise<{ ok: boolean; status?: number; error?: string }> {
    const st = this.channelStatus(c.id);
    const body = JSON.stringify(formatPayload(c.kind, { ...e, at: e.at ?? new Date().toISOString() }, this.opts.server ?? 'PSArelay'));
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'psarelay-notifier' };
    if (c.kind === 'generic' && c.secret) {
      const sig = `sha256=${createHmac('sha256', c.secret).update(body).digest('hex')}`;
      headers['X-PSArelay-Signature'] = sig;
      headers['X-Atmcp-Signature'] = sig; // deprecated name, kept so existing receivers keep verifying
    }
    const doFetch: Fetch = this.opts.fetch ?? (globalThis.fetch as unknown as Fetch);
    const attempt = async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10_000);
      try { return await doFetch(c.url, { method: 'POST', headers, body, signal: ctl.signal }); } finally { clearTimeout(t); }
    };
    let out: { ok: boolean; status?: number; error?: string };
    try {
      let r = await attempt();
      if (r.status === 429 && (c.kind === 'discord' || c.kind === 'slack')) {
        const wait = Math.min(Number(r.headers.get('retry-after')) || 2, 30);
        await new Promise((res) => setTimeout(res, wait * 1000));
        r = await attempt();
      }
      out = r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: `HTTP ${r.status}: ${clip((await r.text().catch(() => '')).trim(), 200)}` };
    } catch (err) {
      out = { ok: false, error: err instanceof Error ? (err.name === 'AbortError' ? 'timed out after 10 s' : err.message) : String(err) };
    }
    const now = new Date().toISOString();
    this.status.set(c.id, out.ok
      ? { ...st, lastSentAt: now, lastEvent: e.type, sent: st.sent + 1 }
      : { ...st, lastError: out.error ?? 'failed', lastErrorAt: now, failed: st.failed + 1 });
    if (!out.ok) this.opts.log?.(`notification to "${c.name}" (${c.kind}) failed: ${out.error}`);
    return out;
  }

  /** Wait for queued sends (tests). */
  flush(): Promise<void> { return this.queue; }
}

/** Process-wide notifier: hooks call notify(); the admin console sets the channels. */
let instance: Notifier | null = null;
export function getNotifier(): Notifier {
  if (!instance) instance = new Notifier({ server: process.env.MCP_NOTIFY_SERVER_NAME || 'PSArelay' });
  return instance;
}
export function notify(e: NotifyEvent): void {
  try { getNotifier().emit(e); } catch { /* notifications must never break the caller */ }
}
export function _setNotifier(n: Notifier | null): void { instance = n; }
