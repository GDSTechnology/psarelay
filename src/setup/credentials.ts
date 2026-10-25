// The Autotask API user, entered and verified in the console (migration 0020).
//
// TEST before SAVE, and test carefully: every rejected login counts toward Autotask locking the API user (two users
// were locked on 2026-10-07 by repeated failed logins). So a test
//   1. looks up the zone first — unauthenticated, no login attempt: an unknown username stops here;
//   2. makes ONE authenticated call (ThresholdInformation) with a fresh client — never retried;
//   3. names the API user (its resource) on success.
// Tests are limited to 3 per 15 minutes, refused while the live login is paused or held, and a SAVE needs a passing
// test of exactly the same values in the last 10 minutes. A different Autotask database (zoneInformation ci) than the
// one already in use is refused, so the mirror never mixes two tenants.

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { AutotaskHttpClient, authBlockStatus } from '../services/autotask-http.js';
import { decryptSecret, encryptSecret, secretKeyStatus } from '../security/secrets.js';
import type { Logger } from '../utils/logger.js';

export interface AutotaskCredentials { username: string; secret: string; integrationCode: string; apiUrl?: string | undefined }
export interface ZoneInfo { url: string; webUrl: string | null; ci: number | null }
export interface TestStep { step: 'zone' | 'login' | 'identity'; ok: boolean; detail: string }
export interface TestResult { ok: boolean; steps: TestStep[]; zone: ZoneInfo | null; apiUser: { id: number | null; name: string | null } | null }

const ZONE_URL = 'https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation';
const TEST_LIMIT = 3, TEST_WINDOW_MS = 15 * 60_000, PASS_VALID_MS = 10 * 60_000;

export const credentialHash = (c: AutotaskCredentials) => createHash('sha256').update(JSON.stringify([c.username.trim().toLowerCase(), c.secret, c.integrationCode, c.apiUrl ?? ''])).digest('hex');

/** Which Autotask zone (and database) a username belongs to — unauthenticated, so it never counts as a login. */
export async function lookupZone(username: string, fetchImpl: typeof fetch = fetch): Promise<ZoneInfo | null> {
  const r = await fetchImpl(`${ZONE_URL}?user=${encodeURIComponent(username)}`, { headers: { Accept: 'application/json' } });
  if (r.status === 404 || r.status === 400 || r.status === 500) return null;
  if (!r.ok) throw new Error(`zone lookup answered HTTP ${r.status}`);
  const b = await r.json() as { url?: unknown; webUrl?: unknown; ci?: unknown };
  if (typeof b?.url !== 'string' || !b.url) return null;
  return { url: b.url.replace(/\/?$/, '/'), webUrl: typeof b.webUrl === 'string' ? b.webUrl : null, ci: b.ci == null ? null : Number(b.ci) };
}

export interface TesterDeps {
  zone?: (username: string) => Promise<ZoneInfo | null>;
  /** One authenticated call with the candidate credentials (default: ThresholdInformation on a fresh client). */
  login?: (c: AutotaskCredentials, apiUrl: string) => Promise<void>;
  identify?: (c: AutotaskCredentials, apiUrl: string) => Promise<{ id: number | null; name: string | null }>;
  now?: () => number;
}

export class CredentialTester {
  private attempts: number[] = [];
  private passed = new Map<string, { at: number; result: TestResult }>();
  constructor(private readonly logger: Logger, private readonly deps: TesterDeps = {}) {}

  private now() { return this.deps.now?.() ?? Date.now(); }

  /** Run a test. Throws (with a message for the person) when a test may not run right now. */
  async test(c: AutotaskCredentials, o: { currentCi?: number | null } = {}): Promise<TestResult> {
    const username = c.username.trim();
    if (!username || !c.secret || !c.integrationCode) throw new Error('Give the API username, secret and integration code.');
    const now = this.now();
    this.attempts = this.attempts.filter((t) => now - t < TEST_WINDOW_MS);
    if (this.attempts.length >= TEST_LIMIT) throw new Error(`At most ${TEST_LIMIT} tests per 15 minutes — every rejected login counts toward Autotask locking the API user. Try again in ${Math.ceil((TEST_WINDOW_MS - (now - this.attempts[0]!)) / 60_000)} min.`);
    const block = authBlockStatus(username);
    if (block) throw new Error(`Autotask logins for ${username} are ${block.held ? 'HELD' : 'paused'} after failed logins. Fix the API user in Autotask, press Retry now on the Overview, then test.`);

    const steps: TestStep[] = [];
    // 1. Zone — no login attempt.
    let zone: ZoneInfo | null;
    try { zone = c.apiUrl ? { url: c.apiUrl.replace(/\/?$/, '/'), webUrl: null, ci: null } : await (this.deps.zone ?? lookupZone)(username); }
    catch (e) { steps.push({ step: 'zone', ok: false, detail: `Could not reach Autotask's zone lookup: ${(e as Error).message}. Nothing was sent with the password.` }); return { ok: false, steps, zone: null, apiUser: null }; }
    if (!zone) { steps.push({ step: 'zone', ok: false, detail: `Autotask does not know the username "${username}" — check it (it is the API user's email). No login was attempted.` }); return { ok: false, steps, zone: null, apiUser: null }; }
    steps.push({ step: 'zone', ok: true, detail: `Zone ${zone.url}` });
    if (o.currentCi != null && zone.ci != null && zone.ci !== o.currentCi) {
      steps.push({ step: 'zone', ok: false, detail: `This user belongs to a different Autotask database (${zone.ci}, this server mirrors ${o.currentCi}). Refused, so the mirror never mixes two tenants. No login was attempted.` });
      return { ok: false, steps, zone, apiUser: null };
    }
    // 2. One login — counted, never retried.
    this.attempts.push(now);
    try { await (this.deps.login ?? defaultLogin)(c, zone.url); }
    catch (e) {
      const m = (e as Error).message;
      const rejected = /\b401\b|unauthori[sz]ed|authentication/i.test(m);
      steps.push({ step: 'login', ok: false, detail: rejected ? 'Autotask rejected the secret or integration code. This counted as one failed login for the API user — check the values before testing again.' : `The login call failed: ${m.slice(0, 200)}` });
      return { ok: false, steps, zone, apiUser: null };
    }
    steps.push({ step: 'login', ok: true, detail: 'Signed in.' });
    // 3. Who it is.
    let apiUser: TestResult['apiUser'] = null;
    try { apiUser = await (this.deps.identify ?? defaultIdentify)(c, zone.url); steps.push({ step: 'identity', ok: true, detail: apiUser.name ? `API user: ${apiUser.name}${apiUser.id != null ? ` (#${apiUser.id})` : ''}` : 'Signed in (the API user\'s resource could not be named).' }); }
    catch { steps.push({ step: 'identity', ok: true, detail: 'Signed in (the API user\'s resource could not be named).' }); }
    const result: TestResult = { ok: true, steps, zone, apiUser };
    this.passed.set(credentialHash(c), { at: now, result });
    this.logger.info(`Autotask credentials test passed for ${username}`);
    return result;
  }

  /** The passing test of exactly these values in the last 10 minutes, if any. */
  passedFor(c: AutotaskCredentials): TestResult | null {
    const p = this.passed.get(credentialHash(c));
    return p && this.now() - p.at < PASS_VALID_MS ? p.result : null;
  }
}

async function defaultLogin(c: AutotaskCredentials, apiUrl: string): Promise<void> {
  const http = new AutotaskHttpClient(c.username.trim(), c.secret, c.integrationCode, apiUrl, quietLogger());
  await http.thresholdInformation();
}
async function defaultIdentify(c: AutotaskCredentials, apiUrl: string): Promise<{ id: number | null; name: string | null }> {
  const http = new AutotaskHttpClient(c.username.trim(), c.secret, c.integrationCode, apiUrl, quietLogger());
  const rows = await http.query<Record<string, unknown>>('Resources', [{ op: 'eq', field: 'email', value: c.username.trim() }] as never, { maxRecords: 2, includeFields: ['id', 'firstName', 'lastName'], noCache: true });
  const r = rows.length === 1 ? rows[0]! : null;
  return { id: r ? Number(r.id) : null, name: r ? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || null : null };
}
const quietLogger = () => ({ info() {}, warn() {}, error() {}, debug() {} }) as unknown as Logger;

export interface StoredCredential extends AutotaskCredentials { databaseCi: number | null; verifiedAs: string | null; verifiedAt: string; updatedBy: string; updatedAt: string }

export class CredentialStore {
  constructor(private readonly pool: Pool) {}
  /** The stored credentials, decrypted; null when none. Throws when they can't be decrypted (wrong / missing key). */
  async get(env: NodeJS.ProcessEnv = process.env): Promise<StoredCredential | null> {
    const r = await this.pool.query('SELECT * FROM autotask_credential WHERE id = 1');
    const x = r.rows[0];
    if (!x) return null;
    return {
      username: x.username, secret: decryptSecret(x.secret_enc, env), integrationCode: decryptSecret(x.integration_code_enc, env), apiUrl: x.api_url ?? undefined,
      databaseCi: x.database_ci == null ? null : Number(x.database_ci), verifiedAs: x.verified_as ?? null, verifiedAt: new Date(x.verified_at).toISOString(), updatedBy: x.updated_by, updatedAt: new Date(x.updated_at).toISOString(),
    };
  }
  /** Who / when, without decrypting (for the console). */
  async summary(): Promise<{ username: string; apiUrl: string | null; databaseCi: number | null; verifiedAs: string | null; verifiedAt: string; updatedBy: string; updatedAt: string } | null> {
    const x = (await this.pool.query('SELECT username, api_url, database_ci, verified_as, verified_at, updated_by, updated_at FROM autotask_credential WHERE id = 1')).rows[0];
    return x ? { username: x.username, apiUrl: x.api_url ?? null, databaseCi: x.database_ci == null ? null : Number(x.database_ci), verifiedAs: x.verified_as ?? null, verifiedAt: new Date(x.verified_at).toISOString(), updatedBy: x.updated_by, updatedAt: new Date(x.updated_at).toISOString() } : null;
  }
  async save(c: AutotaskCredentials, meta: { databaseCi: number | null; verifiedAs: string | null; by: string }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (!secretKeyStatus(env).ok) throw new Error(secretKeyStatus(env).detail);
    await this.pool.query(`INSERT INTO autotask_credential (id, username, secret_enc, integration_code_enc, api_url, database_ci, verified_as, verified_at, updated_by, updated_at)
      VALUES (1, $1, $2, $3, $4, $5, $6, now(), $7, now())
      ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, secret_enc = EXCLUDED.secret_enc, integration_code_enc = EXCLUDED.integration_code_enc, api_url = EXCLUDED.api_url,
        database_ci = EXCLUDED.database_ci, verified_as = EXCLUDED.verified_as, verified_at = now(), updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [c.username.trim(), encryptSecret(c.secret, env), encryptSecret(c.integrationCode, env), c.apiUrl ?? null, meta.databaseCi, meta.verifiedAs, meta.by]);
  }
  async clear(): Promise<boolean> { return ((await this.pool.query('DELETE FROM autotask_credential WHERE id = 1')).rowCount ?? 0) > 0; }
}

// Where the running server's credentials came from (set at startup and on a console save).
let source: { from: 'environment' | 'console'; problem: string | null } = { from: 'environment', problem: null };
export function setCredentialSource(from: 'environment' | 'console', problem: string | null = null): void { source = { from, problem }; }
export const credentialSource = () => source;

let tester: CredentialTester | null = null;
/** The process-wide tester (its rate limit and passed tests must be shared by every request). */
export function credentialTester(logger: Logger): CredentialTester { return (tester ??= new CredentialTester(logger)); }
export const _resetCredentialTester = () => { tester = null; };
