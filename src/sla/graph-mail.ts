// Send mail from a Microsoft 365 mailbox through Microsoft Graph (app-only, client credentials).
//
// Needs an Entra app registration with the APPLICATION permission Mail.Send (admin consent), and — so the app can
// send only as this one mailbox — an Exchange application access policy or "RBAC for Applications" scope limited
// to it. The client secret is stored encrypted (MCP_SECRET_KEY). Plain-text body; saved to Sent Items.

export interface GraphMailConfig { tenantId: string; clientId: string; clientSecret: string; sender: string }
export interface MailMessage { to: string[]; cc?: string[]; subject: string; text: string }

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validGuid = (s: string): boolean => GUID.test(s.trim());

const tokens = new Map<string, { token: string; until: number }>();

async function call(f: Fetch, url: string, init: { method: string; headers: Record<string, string>; body: string }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try { return await f(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}

/** Graph's error code + message out of a failed answer, with a hint for the usual setup gaps. */
export function graphProblem(status: number, raw: string): string {
  let code = '', msg = raw.slice(0, 300);
  try { const j = JSON.parse(raw); code = j?.error?.code ?? j?.error ?? ''; msg = j?.error?.message ?? j?.error_description ?? msg; } catch { /* not JSON */ }
  const hint =
    /AADSTS7000215|invalid_client/i.test(`${code} ${msg}`) ? ' — the client secret is wrong or expired; make a new one in Entra and paste it here.'
    : /AADSTS700016|unauthorized_client/i.test(`${code} ${msg}`) ? ' — no app with that client id in that tenant.'
    : /ErrorAccessDenied|Access is denied|Authorization_RequestDenied/i.test(`${code} ${msg}`) ? ' — the app needs the Mail.Send APPLICATION permission with admin consent, and the access policy must include this mailbox.'
    : /ErrorInvalidUser|MailboxNotEnabledForRESTAPI|ResourceNotFound/i.test(`${code} ${msg}`) ? ' — the sender mailbox was not found or has no Exchange Online licence.'
    : '';
  return `HTTP ${status}${code ? ` ${code}` : ''}: ${String(msg).slice(0, 300)}${hint}`;
}

async function token(c: GraphMailConfig, f: Fetch, now: number): Promise<string> {
  const key = `${c.tenantId}|${c.clientId}|${c.clientSecret.slice(-6)}`;
  const hit = tokens.get(key);
  if (hit && hit.until > now) return hit.token;
  const r = await call(f, `https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret, scope: 'https://graph.microsoft.com/.default' }).toString(),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`Microsoft sign-in failed: ${graphProblem(r.status, raw)}`);
  const j = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error('Microsoft sign-in answered without a token.');
  tokens.set(key, { token: j.access_token, until: now + Math.max(60, (j.expires_in ?? 3600) - 120) * 1000 });
  return j.access_token;
}

/** Send one message. Throws an Error with a readable reason; resolves when Graph accepted it (202). */
export async function sendGraphMail(c: GraphMailConfig, m: MailMessage, f: Fetch = globalThis.fetch as unknown as Fetch, now = Date.now()): Promise<void> {
  const t = await token(c, f, now);
  const addr = (a: string) => ({ emailAddress: { address: a } });
  const r = await call(f, `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(c.sender)}/sendMail`, {
    method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { subject: m.subject, body: { contentType: 'Text', content: m.text }, toRecipients: m.to.map(addr), ccRecipients: (m.cc ?? []).map(addr) }, saveToSentItems: true }),
  });
  if (!r.ok) {
    if (r.status === 401) tokens.clear();
    throw new Error(`Microsoft Graph did not send it: ${graphProblem(r.status, await r.text())}`);
  }
}

/** Tests only. */
export function _clearGraphTokens(): void { tokens.clear(); }
