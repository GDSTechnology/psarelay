// /mcp sign-in by Microsoft 365 Copilot single sign-on: a verified Entra token → the person's Autotask resource.
// Glue between the token check (entra.ts), the links (m365.ts) and the request (TokenAuth). Short caches keep a
// Copilot conversation from costing a database or Autotask call per tool call; any link change clears them.

import type { Pool } from 'pg';
import { microsoftKeyFetcher, verifyEntraToken, type EntraTrust, type KeyFetcher } from './entra.js';
import { M365Store, resolveM365, type M365Resolution } from './m365.js';
import type { TokenAuth } from './tokens.js';
import { allowedClientKinds } from '../oauth/clients.js';
import { notify } from '../services/notifier.js';

export interface M365AuthDeps {
  pool: Pool;
  findResources: (names: string[]) => Promise<Array<Record<string, any>>>;
  log?: (actor: string | null, action: string, details: Record<string, unknown>) => void;
  keys?: KeyFetcher;
}
export type M365AuthResult = { ok: true; auth: TokenAuth } | { ok: false; reason: string };

const TRUST_MS = 30_000, LINKED_MS = 5 * 60_000, UNLINKED_MS = 60_000;
let trustCache: { at: number; trusts: EntraTrust[] } | null = null;
const resolved = new Map<string, { at: number; r: M365Resolution }>();
let defaultKeys: KeyFetcher | null = null;

/** What the console shows: the last accepted and the last refused Copilot sign-in. */
export const m365Status: { lastOk: { at: string; upn: string } | null; lastRefusal: { at: string; reason: string } | null } = { lastOk: null, lastRefusal: null };

/** Forget cached tenants and links (the console changed one). */
export function clearM365Cache(): void { trustCache = null; resolved.clear(); }

async function trusts(store: M365Store): Promise<EntraTrust[]> {
  if (trustCache && Date.now() - trustCache.at < TRUST_MS) return trustCache.trusts;
  trustCache = { at: Date.now(), trusts: await store.trusts() };
  return trustCache.trusts;
}

/** Whether any Microsoft 365 tenant is set up (so /mcp should try Entra tokens at all). */
export async function m365Configured(pool: Pool): Promise<boolean> {
  return (await trusts(new M365Store(pool)).catch(() => [])).length > 0;
}

/** Check an Entra bearer token and find the person's Autotask resource. */
export async function authenticateM365(token: string, d: M365AuthDeps): Promise<M365AuthResult> {
  const refuse = (reason: string): M365AuthResult => { m365Status.lastRefusal = { at: new Date().toISOString(), reason }; return { ok: false, reason }; };
  if (!allowedClientKinds().includes('copilot')) return refuse('Microsoft 365 Copilot is not allowed to connect (Settings → Security → AI clients allowed to connect)');
  const store = new M365Store(d.pool);
  const list = await trusts(store);
  if (!list.length) return refuse('Microsoft 365 sign-in is not set up on this PSArelay');
  const check = await verifyEntraToken(token, list, d.keys ?? (defaultKeys ??= microsoftKeyFetcher()));
  if (!check.ok) return refuse(check.reason);
  const id = check.identity;
  const key = `${id.tenantId}:${id.oid}`;
  const hit = resolved.get(key);
  let r: M365Resolution;
  if (hit && Date.now() - hit.at < (hit.r.status === 'linked' ? LINKED_MS : UNLINKED_MS)) r = hit.r;
  else {
    r = await resolveM365(id, {
      store, findResources: d.findResources,
      onAutoLinked: (l) => d.log?.(null, 'm365.auto_linked', { upn: l.upn, resourceId: l.resourceId, resourceName: l.resourceName, matchedBy: l.by }),
      onWaiting: (w) => notify({ type: 'm365.link_needed', severity: 'info', title: 'Someone needs to be linked to Autotask',
        detail: `${w.upn} tried to use PSArelay from Microsoft 365 Copilot but ${w.reason === 'several' ? 'more than one Autotask user matches' : 'no Autotask user matches'}. Link them in the console → Microsoft 365.`, dedupeKey: `m365.link_needed:${key}` }),
    });
    if (r.status === 'linked' || r.reason !== 'lookup-failed') resolved.set(key, { at: Date.now(), r });
  }
  const m365 = { tenantId: id.tenantId, oid: id.oid, upn: id.upn };
  if (r.status === 'linked') {
    m365Status.lastOk = { at: new Date().toISOString(), upn: id.upn };
    return { ok: true, auth: { tokenId: -1, tokenName: `Microsoft 365: ${id.upn}`, resourceId: r.resourceId, delegate: false, m365 } };
  }
  // Signed in, but not linked: the request goes through (Copilot can list tools) and every call answers the message.
  m365Status.lastRefusal = { at: new Date().toISOString(), reason: `${id.upn}: not linked (${r.reason})` };
  return { ok: true, auth: { tokenId: -1, tokenName: `Microsoft 365: ${id.upn}`, resourceId: null, delegate: false, m365, unlinkedMessage: r.message } };
}
