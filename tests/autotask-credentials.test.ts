// The Autotask API user entered in the console: careful tests (failed logins lock the user), encrypted storage.

import { randomBytes } from 'node:crypto';
import { CredentialStore, CredentialTester, type AutotaskCredentials, type TesterDeps } from '../src/setup/credentials';
import { decryptSecret, encryptSecret, secretKeyStatus } from '../src/security/secrets';
import { Logger } from '../src/utils/logger';

const logger = new Logger('error');
const KEY = randomBytes(32).toString('base64');
const env = { MCP_SECRET_KEY: KEY } as NodeJS.ProcessEnv;
const creds: AutotaskCredentials = { username: 'api@example.com', secret: 's3cret', integrationCode: 'CODE' };
const ZONE = { url: 'https://webservices2.autotask.net/ATServicesRest/', webUrl: 'https://ww2.autotask.net/', ci: 111 };

function tester(over: Partial<TesterDeps> = {}) {
  const calls = { zone: 0, login: 0 };
  let t = 0;
  const deps: TesterDeps = {
    zone: async () => { calls.zone++; return ZONE; },
    login: async () => { calls.login++; },
    identify: async () => ({ id: 30683000, name: 'API User' }),
    now: () => t,
    ...over,
  };
  return { t: new CredentialTester(logger, deps), calls, advance: (ms: number) => { t += ms; } };
}

describe('testing credentials', () => {
  test('a passing test: zone, one login, the API user named; save is unlocked for exactly these values', async () => {
    const { t, calls } = tester();
    const r = await t.test(creds);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(['zone', 'login', 'identity']);
    expect(r.apiUser).toEqual({ id: 30683000, name: 'API User' });
    expect(calls).toEqual({ zone: 1, login: 1 });
    expect(t.passedFor(creds)).not.toBeNull();
    expect(t.passedFor({ ...creds, secret: 'other' })).toBeNull();
  });
  test('an unknown username stops at the zone lookup — no login attempt', async () => {
    const { t, calls } = tester({ zone: async () => null });
    const r = await t.test(creds);
    expect(r.ok).toBe(false);
    expect(calls.login).toBe(0);
    expect(r.steps[0]!.detail).toMatch(/No login was attempted/);
  });
  test('a rejected login is reported as one failed login and never retried', async () => {
    const login = jest.fn(async () => { throw new Error('HTTP 401 Unauthorized'); });
    const { t } = tester({ login });
    const r = await t.test(creds);
    expect(r.ok).toBe(false);
    expect(login).toHaveBeenCalledTimes(1);
    expect(r.steps[r.steps.length - 1]!.detail).toMatch(/counted as one failed login/);
    expect(t.passedFor(creds)).toBeNull();
  });
  test('a different Autotask database is refused before any login', async () => {
    const { t, calls } = tester();
    const r = await t.test(creds, { currentCi: 999 });
    expect(r.ok).toBe(false);
    expect(calls.login).toBe(0);
    expect(r.steps[r.steps.length - 1]!.detail).toMatch(/different Autotask database/);
  });
  test('at most 3 login attempts per 15 minutes; zone-only failures do not count', async () => {
    const { t, advance } = tester({ login: async () => { throw new Error('401'); } });
    for (let i = 0; i < 3; i++) await t.test(creds);
    await expect(t.test(creds)).rejects.toThrow(/At most 3 tests per 15 minutes/);
    advance(15 * 60_000 + 1);
    await expect(t.test(creds)).resolves.toMatchObject({ ok: false });
    const z = tester({ zone: async () => null });
    for (let i = 0; i < 5; i++) await z.t.test(creds);
    expect(z.calls.login).toBe(0);
  });
  test('a passing test expires after 10 minutes', async () => {
    const { t, advance } = tester();
    await t.test(creds);
    advance(10 * 60_000 + 1);
    expect(t.passedFor(creds)).toBeNull();
  });
  test('missing fields are refused', async () => {
    await expect(tester().t.test({ ...creds, secret: '' })).rejects.toThrow(/username, secret and integration code/);
  });
});

describe('secrets at rest', () => {
  test('AES-256-GCM round trip; a wrong key or a tampered value fails', () => {
    const sealed = encryptSecret('s3cret', env);
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain('s3cret');
    expect(decryptSecret(sealed, env)).toBe('s3cret');
    expect(() => decryptSecret(sealed, { MCP_SECRET_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)).toThrow();
    const raw = Buffer.from(sealed.slice(3), 'base64'); raw[raw.length - 1]! ^= 1;
    expect(() => decryptSecret('v1:' + raw.toString('base64'), env)).toThrow();
  });
  test('key status', () => {
    expect(secretKeyStatus({} as NodeJS.ProcessEnv).ok).toBe(false);
    expect(secretKeyStatus({ MCP_SECRET_KEY: 'short' } as NodeJS.ProcessEnv).ok).toBe(false);
    expect(secretKeyStatus(env).ok).toBe(true);
    expect(secretKeyStatus({ MCP_SECRET_KEY: randomBytes(32).toString('hex') } as NodeJS.ProcessEnv).ok).toBe(true);
  });
  test('the store writes only ciphertext and refuses without a key', async () => {
    const params: unknown[][] = [];
    const pool = { query: jest.fn(async (_sql: string, p: unknown[] = []) => { params.push(p); return { rows: [], rowCount: 1 }; }) } as any;
    const s = new CredentialStore(pool);
    await s.save(creds, { databaseCi: 111, verifiedAs: 'API User', by: 'admin' }, env);
    expect(JSON.stringify(params)).not.toContain('s3cret');
    expect(JSON.stringify(params)).not.toContain('"CODE"');
    await expect(s.save(creds, { databaseCi: null, verifiedAs: null, by: 'admin' }, {} as NodeJS.ProcessEnv)).rejects.toThrow(/MCP_SECRET_KEY/);
  });
});
