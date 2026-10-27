// Microsoft 365 Copilot single sign-on: the Entra token check and the person → Autotask resource rules.
// Tokens are signed here with a generated RSA key standing in for Microsoft's published keys.

import { createSign, generateKeyPairSync } from 'node:crypto';
import { COPILOT_TOKEN_STORE_CLIENT_ID, looksLikeJwt, microsoftKeyFetcher, unverifiedTenant, verifyEntraToken, type EntraTrust, type Jwk, type KeyFetcher } from '../src/security/entra';
import { matchResources, resolveM365, unlinkedMessage, type M365Link } from '../src/security/m365';

const TID = '11111111-2222-3333-4444-555555555555', OTHER = '99999999-2222-3333-4444-555555555555';
const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const AUD = 'api://auth-0f0f0f0f-1111-2222-3333-444444444444';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k1' };
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function sign(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: typeof privateKey } = {}): string {
  const head = Buffer.from(JSON.stringify({ typ: 'JWT', alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(opts.key ?? privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const now = Math.floor(Date.now() / 1000);
const good = (over: Record<string, unknown> = {}) => ({
  iss: `https://sts.windows.net/${TID}/`, aud: AUD, appid: COPILOT_TOKEN_STORE_CLIENT_ID, tid: TID, oid: OID, upn: 'jane@example.com', name: 'Jane Doe',
  scp: 'access_as_user', iat: now, nbf: now - 10, exp: now + 3600, ...over,
});
const trusts: EntraTrust[] = [{ tenantId: TID, audiences: [AUD], scope: 'access_as_user' }];
const keys = (list: Jwk[][] = [[jwk]]): KeyFetcher & { calls: boolean[] } => {
  const calls: boolean[] = [];
  const f = (async (_t: string, refresh: boolean) => { calls.push(refresh); return list[Math.min(calls.length - 1, list.length - 1)]!; }) as KeyFetcher & { calls: boolean[] };
  f.calls = calls;
  return f;
};

describe('Copilot SSO: the Entra token check', () => {
  test('a good v1 and v2 token are accepted, with the person in them', async () => {
    const r1 = await verifyEntraToken(sign(good()), trusts, keys());
    expect(r1).toEqual({ ok: true, identity: { tenantId: TID, oid: OID, upn: 'jane@example.com', name: 'Jane Doe', email: null } });
    const r2 = await verifyEntraToken(sign(good({ iss: `https://login.microsoftonline.com/${TID}/v2.0`, appid: undefined, azp: COPILOT_TOKEN_STORE_CLIENT_ID, upn: undefined, preferred_username: 'jane@example.com' })), trusts, keys());
    expect(r2.ok).toBe(true);
  });

  test.each([
    ['tenant not trusted', { tid: OTHER, iss: `https://sts.windows.net/${OTHER}/` }],
    ['wrong issuer', { iss: 'https://evil.example/' }],
    ['wrong audience', { aud: 'api://someone-else' }],
    ['not from Microsoft 365 Copilot', { appid: '00000000-0000-0000-0000-000000000001' }],
    ['expired', { exp: now - 3600 }],
    ['not yet valid', { nbf: now + 3600 }],
    ['scope missing', { scp: 'User.Read' }],
    ['guest accounts are not accepted', { idp: 'live.com' }],
    ['guest accounts are not accepted', { upn: 'jane_gmail.com#EXT#@example.onmicrosoft.com' }],
    ['no person in the token', { oid: undefined }],
  ])('refused: %s', async (reason, over) => {
    expect(await verifyEntraToken(sign(good(over)), trusts, keys())).toEqual({ ok: false, reason });
  });

  test('a signature by any other key, or a tampered body, is refused', async () => {
    expect(await verifyEntraToken(sign(good(), { key: other.privateKey }), trusts, keys())).toEqual({ ok: false, reason: 'bad signature' });
    const t = sign(good()).split('.');
    t[1] = Buffer.from(JSON.stringify(good({ upn: 'boss@example.com' }))).toString('base64url');
    expect(await verifyEntraToken(t.join('.'), trusts, keys())).toEqual({ ok: false, reason: 'bad signature' });
    expect(await verifyEntraToken(sign(good(), { alg: 'HS256' }), trusts, keys())).toEqual({ ok: false, reason: 'unsupported token type' });
  });

  test('a key Microsoft rotated in is fetched once; an unknown key is refused', async () => {
    const k = keys([[], [jwk]]);
    expect((await verifyEntraToken(sign(good()), trusts, k)).ok).toBe(true);
    expect(k.calls).toEqual([false, true]);
    expect(await verifyEntraToken(sign(good(), { kid: 'nope' }), trusts, keys())).toEqual({ ok: false, reason: 'unknown signing key' });
  });

  test('an untrusted tenant never makes PSArelay fetch keys', async () => {
    const k = keys();
    await verifyEntraToken(sign(good({ tid: OTHER })), trusts, k);
    expect(k.calls).toEqual([]);
  });

  test('JWTs are told apart from psr_ tokens; the claimed tenant is readable for routing', () => {
    const t = sign(good());
    expect(looksLikeJwt(t)).toBe(true);
    expect(looksLikeJwt('psr_' + 'a'.repeat(43))).toBe(false);
    expect(unverifiedTenant(t)).toBe(TID);
    expect(unverifiedTenant('x.y.z')).toBeNull();
  });

  test('Microsoft keys: cached; a refresh within 5 minutes reuses the copy; the tenant id must be a GUID', async () => {
    let n = 0;
    const f = microsoftKeyFetcher((async () => { n++; return { ok: true, json: async () => ({ keys: [jwk] }) }; }) as unknown as typeof fetch);
    expect(await f(TID, false)).toEqual([jwk]);
    await f(TID, false); await f(TID, true);
    expect(n).toBe(1);
    await expect(f('not-a-guid', false)).rejects.toThrow();
  });
});

describe('Copilot SSO: who the person is in Autotask', () => {
  const r = (id: number, f: Record<string, unknown>) => ({ id, firstName: 'P', lastName: String(id), ...f });

  test('email fields first; userName (whole sign-in name or the part before @) only when no email matches', () => {
    const me = { upn: 'Jane.Doe@example.com', email: null };
    expect(matchResources(me, [r(1, { email: 'jane.doe@example.com' })])).toMatchObject({ by: 'email', matches: [{ id: 1 }] });
    expect(matchResources(me, [r(1, { email3: 'JANE.DOE@example.com' })]).by).toBe('email');
    expect(matchResources(me, [r(1, { userName: 'jane.doe' })])).toMatchObject({ by: 'username', matches: [{ id: 1 }] });
    expect(matchResources(me, [r(1, { userName: 'jane.doe' }), r(2, { email2: 'jane.doe@example.com' })])).toMatchObject({ by: 'email', matches: [{ id: 2 }] });
    expect(matchResources(me, [r(1, { email: 'someone@example.com', userName: 'jdoe' })]).matches).toEqual([]);
    expect(matchResources({ upn: 'jane@example.com', email: 'j.doe@example.com' }, [r(1, { email: 'j.doe@example.com' })]).matches).toHaveLength(1);
  });

  const id = { tenantId: TID, oid: OID, upn: 'jane@example.com', name: 'Jane', email: null };
  const fakeStore = (link: Partial<M365Link> | null = null) => {
    const saved: unknown[] = [], waiting: unknown[] = [];
    return { saved, waiting, store: {
      findLink: async () => (link ? { id: 7, tenantId: TID, oid: OID, upn: id.upn, resourceId: 42, resourceName: 'Jane Doe', matchedBy: 'admin', linkedBy: 'x', linkedAt: '', lastUsedAt: null, ...link } : null),
      saveLink: async (l: any) => { saved.push(l); return { id: 9, ...l, linkedAt: '', lastUsedAt: null }; },
      noteWaiting: async (w: any) => { waiting.push(w); return waiting.length === 1; },
      touchLink: async () => undefined,
    } };
  };

  test('a stored link wins and Autotask is not asked', async () => {
    const s = fakeStore({});
    const res = await resolveM365(id, { store: s.store, findResources: async () => { throw new Error('must not be called'); } });
    expect(res).toMatchObject({ status: 'linked', resourceId: 42, autoLinked: false });
  });

  test('exactly one match links automatically (and is reported)', async () => {
    const s = fakeStore(); const seen: unknown[] = [];
    const res = await resolveM365(id, { store: s.store, findResources: async (names) => { expect(names).toEqual(['jane@example.com', 'jane']); return [r(5, { email: 'jane@example.com' })]; }, onAutoLinked: (l) => seen.push(l) });
    expect(res).toMatchObject({ status: 'linked', resourceId: 5, matchedBy: 'auto:email', autoLinked: true });
    expect(s.saved).toEqual([expect.objectContaining({ oid: OID, resourceId: 5, matchedBy: 'auto:email', linkedBy: null })]);
    expect(seen).toHaveLength(1);
  });

  test('no match or several: a clean message, the person waits, an admin is told once', async () => {
    const s = fakeStore(); const told: unknown[] = [];
    const none = await resolveM365(id, { store: s.store, findResources: async () => [], onWaiting: (w) => told.push(w) });
    expect(none).toEqual({ status: 'unlinked', reason: 'no-match', message: unlinkedMessage(id.upn, 'no-match') });
    expect(none.status === 'unlinked' && none.message).toMatch(/Ask your system administrator to link it/);
    const several = await resolveM365(id, { store: s.store, findResources: async () => [r(1, { email: 'jane@example.com' }), r(2, { email2: 'jane@example.com' })], onWaiting: (w) => told.push(w) });
    expect(several).toMatchObject({ status: 'unlinked', reason: 'several' });
    // The person never sees who else matched.
    expect(several.status === 'unlinked' && several.message).not.toMatch(/P 1|P 2/);
    expect(s.waiting[1]).toMatchObject({ reason: 'several', candidates: [{ id: 1 }, { id: 2 }] });
    expect(told).toHaveLength(1);
    expect(s.saved).toEqual([]);
  });

  test('Autotask not answering is not a "no match" (nothing recorded, try again)', async () => {
    const s = fakeStore();
    const res = await resolveM365(id, { store: s.store, findResources: async () => { throw new Error('429'); } });
    expect(res).toMatchObject({ status: 'unlinked', reason: 'lookup-failed' });
    expect(s.waiting).toEqual([]);
  });
});
