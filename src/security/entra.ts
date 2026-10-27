// Microsoft Entra access tokens (Microsoft 365 Copilot single sign-on, migration 0023).
//
// Copilot's "Microsoft Entra SSO" plugin scheme gets a token for the signed-in person from Microsoft's Enterprise
// token store and sends it as the Bearer on every /mcp call. PSArelay checks it itself — zero trust, nothing taken on
// faith — against Microsoft's published signing keys: no client secret exists, so nothing expires. Microsoft rotates
// the keys; they are fetched per tenant, cached, and fetched again when a token names a key not seen yet.
//
// Accepted only when ALL hold: RS256 signature by a current Microsoft key, issuer = a trusted tenant (v1 or v2 form),
// audience = one of that tenant's configured audiences, the client is Microsoft's Enterprise token store (Copilot),
// not expired / not yet valid, the configured scope present, and the person is a member of the tenant (no guests).

import { createPublicKey, createVerify } from 'node:crypto';

/** One signing key from Microsoft's JWKS. */
export interface Jwk { kid?: string; kty?: string; n?: string; e?: string; [k: string]: unknown }

/** The client id of the Microsoft Enterprise token store — the only client whose Entra tokens are accepted (Copilot). */
export const COPILOT_TOKEN_STORE_CLIENT_ID = 'ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b';

export interface EntraTrust { tenantId: string; audiences: string[]; scope: string }
export interface EntraIdentity { tenantId: string; oid: string; upn: string; name: string; email: string | null }
export type EntraCheck = { ok: true; identity: EntraIdentity } | { ok: false; reason: string };
/** The signing keys of a tenant (JWKS `keys`); `refresh` asks for a fresh copy (a key id was not found). */
export type KeyFetcher = (tenantId: string, refresh: boolean) => Promise<Jwk[]>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKEW_S = 300;

/** Three base64url parts — a JWT, not one of PSArelay's own psr_ tokens. */
export const looksLikeJwt = (t: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t) && !t.startsWith('psr_');

function part(s: string): Record<string, any> | null {
  try { const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
/** The tenant a token claims, read WITHOUT verification — only to pick its trust entry and keys (and for routing). */
export function unverifiedTenant(token: string): string | null {
  const p = token.split('.');
  const tid = p.length === 3 ? part(p[1]!)?.tid : null;
  return typeof tid === 'string' && GUID.test(tid) ? tid.toLowerCase() : null;
}

/** Verify a Copilot SSO token against the trusted tenants. Never throws. */
export async function verifyEntraToken(token: string, trusts: EntraTrust[], keys: KeyFetcher, nowMs = Date.now()): Promise<EntraCheck> {
  const p = token.split('.');
  if (p.length !== 3) return { ok: false, reason: 'not a token' };
  const header = part(p[0]!), c = part(p[1]!);
  if (!header || !c) return { ok: false, reason: 'unreadable token' };
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'unsupported token type' };
  const tid = typeof c.tid === 'string' ? c.tid.toLowerCase() : '';
  const trust = trusts.find((t) => t.tenantId.toLowerCase() === tid);
  if (!trust) return { ok: false, reason: 'tenant not trusted' };

  // Signature first: nothing else in the token means anything until Microsoft is shown to have issued it.
  let jwk: Jwk | undefined;
  try {
    jwk = (await keys(tid, false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await keys(tid, true)).find((k) => k.kid === header.kid);
  } catch { return { ok: false, reason: 'signing keys unavailable' }; }
  if (!jwk || (jwk.kty && jwk.kty !== 'RSA')) return { ok: false, reason: 'unknown signing key' };
  const signed = (): boolean => {
    try { return createVerify('RSA-SHA256').update(`${p[0]}.${p[1]}`).verify(createPublicKey({ key: jwk, format: 'jwk' } as Parameters<typeof createPublicKey>[0]), Buffer.from(p[2]!, 'base64url')); } catch { return false; }
  };
  if (!signed()) return { ok: false, reason: 'bad signature' };

  if (c.iss !== `https://sts.windows.net/${tid}/` && c.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) return { ok: false, reason: 'wrong issuer' };
  const auds = trust.audiences.map((a) => a.trim().toLowerCase()).filter(Boolean);
  const tokenAuds = (Array.isArray(c.aud) ? c.aud : [c.aud]).filter((a): a is string => typeof a === 'string').map((a) => a.toLowerCase());
  if (!auds.length || !tokenAuds.some((a) => auds.includes(a))) return { ok: false, reason: 'wrong audience' };
  if ((c.azp ?? c.appid) !== COPILOT_TOKEN_STORE_CLIENT_ID) return { ok: false, reason: 'not from Microsoft 365 Copilot' };
  const now = Math.floor(nowMs / 1000);
  if (typeof c.exp !== 'number' || c.exp + SKEW_S < now) return { ok: false, reason: 'expired' };
  if (typeof c.nbf === 'number' && c.nbf - SKEW_S > now) return { ok: false, reason: 'not yet valid' };
  if (trust.scope && !String(c.scp ?? '').split(' ').includes(trust.scope)) return { ok: false, reason: 'scope missing' };

  const upn = String(c.preferred_username ?? c.upn ?? c.unique_name ?? '').trim();
  const oid = typeof c.oid === 'string' ? c.oid.toLowerCase() : '';
  // A guest's token carries the home directory as `idp`; guest sign-in names contain #EXT#.
  if ((c.idp && c.idp !== `https://sts.windows.net/${tid}/`) || /#EXT#/i.test(upn)) return { ok: false, reason: 'guest accounts are not accepted' };
  if (!GUID.test(oid) || !upn) return { ok: false, reason: 'no person in the token' };
  const email = typeof c.email === 'string' && c.email.trim() ? c.email.trim() : null;
  return { ok: true, identity: { tenantId: tid, oid, upn, name: String(c.name ?? '').trim(), email } };
}

/** Microsoft's published keys for a tenant, cached a day; a refresh is honoured at most every 5 minutes per tenant. */
export function microsoftKeyFetcher(fetchImpl: typeof fetch = fetch): KeyFetcher {
  const cache = new Map<string, { at: number; keys: Jwk[] }>();
  return async (tenantId, refresh) => {
    const hit = cache.get(tenantId);
    const fresh = hit && Date.now() - hit.at < 24 * 3600_000;
    if (hit && fresh && (!refresh || Date.now() - hit.at < 5 * 60_000)) return hit.keys;
    if (!GUID.test(tenantId)) throw new Error('bad tenant id');
    const r = await fetchImpl(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) { if (hit) return hit.keys; throw new Error(`keys HTTP ${r.status}`); }
    const j = (await r.json()) as { keys?: Jwk[] };
    const keys = Array.isArray(j.keys) ? j.keys : [];
    cache.set(tenantId, { at: Date.now(), keys });
    return keys;
  };
}
