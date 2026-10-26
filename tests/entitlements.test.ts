// Entitlements: signed licences, module mapping, the locked-tool message, and the tool gate.

import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetEntitlements, entitlementView, lockedReason, moduleOf, planWriteLock, readLicense, resolveEntitlements, type LicensePayload } from '../src/entitlements/index';
import { toolBlockReason, toolListed, toolLockedReason } from '../src/admin/tool-gate';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = (p: Partial<LicensePayload>, key = privateKey) => {
  const body = b64u(Buffer.from(JSON.stringify({ customer: 'Example MSP', plan: 'starter', planName: 'Starter', modules: ['contracts'], expiresAt: '2027-01-01T00:00:00Z', upgradeUrl: 'https://example.com/upgrade', offers: { cleanup: { includedIn: ['Pro', 'MSP'], addon: 'Data cleanup' } }, ...p })));
  return `${body}.${b64u(sign(null, Buffer.from(body), key))}`;
};
const NOW = Date.parse('2026-10-25T00:00:00Z');
const env = (t: string, pub = PUB) => ({ PSARELAY_LICENSE: t, PSARELAY_LICENSE_PUBLIC_KEY: pub }) as NodeJS.ProcessEnv;

describe('licences', () => {
  test('no licence → self-hosted, everything unlocked', () => {
    const e = resolveEntitlements({} as NodeJS.ProcessEnv, NOW);
    expect(e.mode).toBe('self-hosted');
    expect(e.modules).toBe('all');
    expect(lockedReason('cleanup', e)).toBeNull();
    expect(entitlementView(e).modules.every((m) => m.included)).toBe(true);
  });
  test('a valid licence gives its modules plus core', () => {
    const e = resolveEntitlements(env(token({})), NOW);
    expect(e.mode).toBe('licensed');
    expect([...(e.modules as Set<string>)].sort()).toEqual(['contracts', 'core']);
    expect(readLicense(token({}), PUB).plan).toBe('starter');
  });
  test('a PEM with escaped newlines (as in .env files) still verifies', () => {
    expect(resolveEntitlements(env(token({}), PUB.replace(/\n/g, '\\n')), NOW).mode).toBe('licensed');
  });
  test('expired: grace for 7 days, then core only', () => {
    const t = token({ expiresAt: '2026-10-20T00:00:00Z' });
    const g = resolveEntitlements(env(t), NOW);
    expect(g.mode).toBe('grace');
    expect((g.modules as Set<string>).has('contracts')).toBe(true);
    const x = resolveEntitlements(env(t), Date.parse('2026-11-01T00:00:00Z'));
    expect(x.mode).toBe('expired');
    expect([...(x.modules as Set<string>)]).toEqual(['core']);
  });
  test('forged, malformed or keyless licences → invalid, core only', () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    for (const e of [env(token({}, other)), env('not-a-licence'), env(token({}), '')]) {
      const r = resolveEntitlements(e, NOW);
      expect(r.mode).toBe('invalid');
      expect([...(r.modules as Set<string>)]).toEqual(['core']);
    }
    // A tampered payload with the original signature fails too.
    const [, sig] = token({}).split('.');
    const body = b64u(Buffer.from(JSON.stringify({ plan: 'msp', modules: ['cleanup', 'commerce'], expiresAt: '2030-01-01' })));
    expect(resolveEntitlements(env(`${body}.${sig}`), NOW).mode).toBe('invalid');
  });
});

describe('modules and the locked message', () => {
  test('tools map to modules by name and category', () => {
    expect(moduleOf('autotask_merge_discover', ['companies'])).toBe('cleanup');
    expect(moduleOf('autotask_bulk_inactivate', ['contacts'])).toBe('cleanup');
    expect(moduleOf('autotask_report_unbilled_time', ['time_and_billing'])).toBe('reports');
    expect(moduleOf('autotask_report_gap', ['utility'])).toBe('platform');
    expect(moduleOf('autotask_create_time_entry', ['time_and_billing'])).toBe('core');
    expect(moduleOf('autotask_search_billing_items', ['time_and_billing'])).toBe('billing');
    expect(moduleOf('autotask_search_contracts', ['financial'])).toBe('contracts');
    expect(moduleOf('autotask_search_tickets', ['tickets'])).toBe('core');
    expect(moduleOf('autotask_something_new', [])).toBe('platform');
  });
  test('the message names the plan, where the module is included, the add-on and where to ask', () => {
    const e = resolveEntitlements(env(token({})), NOW);
    const r = lockedReason('cleanup', e)!;
    expect(r).toContain('Merges & bulk cleanup is not on this account (your plan: Starter)');
    expect(r).toContain('included in the Pro / MSP plans');
    expect(r).toContain('"Data cleanup" add-on');
    expect(r).toContain('https://example.com/upgrade');
    expect(lockedReason('contracts', e)).toBeNull();
    expect(lockedReason('platform', e)).toBeNull();
    const v = entitlementView(e);
    expect(v.modules.find((m) => m.id === 'cleanup')).toMatchObject({ included: false, offer: { addon: 'Data cleanup' } });
  });
});

describe('tool gate', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; _resetEntitlements(); });
  test('self-hosted: nothing is plan-locked', () => {
    delete process.env.PSARELAY_LICENSE; _resetEntitlements();
    expect(toolLockedReason('autotask_merge_discover')).toBeNull();
  });
  test('licensed: locked tools are refused with the upgrade message but still listed; always-on tools stay open', () => {
    // Far-future expiry: the gate reads the real clock.
    process.env.PSARELAY_LICENSE = token({ expiresAt: '2099-01-01T00:00:00Z' });
    process.env.PSARELAY_LICENSE_PUBLIC_KEY = PUB;
    _resetEntitlements();
    expect(toolBlockReason('autotask_merge_discover')).toMatch(/^🔒 Merges & bulk cleanup/);
    expect(toolListed('autotask_merge_discover')).toBe(true);
    expect(toolBlockReason('autotask_search_tickets')).toBeNull();
    expect(toolBlockReason('autotask_report_gap')).toBeNull();
    expect(toolBlockReason('autotask_list_categories')).toBeNull();
  });
});

describe('trials and read-only plans', () => {
  test('a trial is read-only by default and says how long is left', () => {
    const e = resolveEntitlements(env(token({ trial: true, plan: 'pro', planName: 'Pro', modules: ['contracts', 'reports'], expiresAt: '2026-11-08T00:00:00Z' })), NOW);
    expect(e).toMatchObject({ mode: 'licensed', trial: true, readOnly: true });
    expect(e.detail).toBe('Free trial: 14 days left (ends 2026-11-08), read-only.');
    expect((e.modules as Set<string>).has('reports')).toBe(true);
    expect(planWriteLock('autotask_update_ticket', e)).toMatch(/^🔒 autotask_update_ticket changes Autotask data, and this free trial is read-only\. Choose a plan/);
    expect(entitlementView(e)).toMatchObject({ trial: true, readOnly: true });
  });
  test('a trial can allow writes explicitly; a paid plan can be read-only', () => {
    expect(resolveEntitlements(env(token({ trial: true, readOnly: false })), NOW).readOnly).toBe(false);
    const p = resolveEntitlements(env(token({ readOnly: true })), NOW);
    expect(p).toMatchObject({ trial: false, readOnly: true });
    expect(planWriteLock(undefined, p)).toContain('your plan (Starter) is read-only');
    expect(planWriteLock(undefined, resolveEntitlements(env(token({})), NOW))).toBeNull();
  });
  test('an ended trial locks every module at once (no grace period)', () => {
    const e = resolveEntitlements(env(token({ trial: true, expiresAt: '2026-10-24T00:00:00Z' })), NOW);
    expect(e.mode).toBe('expired');
    expect([...(e.modules as Set<string>)]).toEqual([]);
    expect(e.readOnly).toBe(true);
    expect(lockedReason('core', e)).toMatch(/^🔒 Your free trial ended 2026-10-24\. .*Choose a plan at https:\/\/example\.com\/upgrade/);
    expect(lockedReason('platform', e)).toBeNull();
  });
  test('the licence can come from a file (re-read, no restart); an unreadable file is never "self-hosted"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psr-lic-'));
    const f = join(dir, 'licence');
    writeFileSync(f, token({ plan: 'pro', planName: 'Pro' }) + '\n');
    expect(resolveEntitlements({ PSARELAY_LICENSE_FILE: f, PSARELAY_LICENSE_PUBLIC_KEY: PUB } as NodeJS.ProcessEnv, NOW).license?.plan).toBe('pro');
    // The file wins over the environment variable.
    expect(resolveEntitlements({ PSARELAY_LICENSE_FILE: f, PSARELAY_LICENSE: token({}), PSARELAY_LICENSE_PUBLIC_KEY: PUB } as NodeJS.ProcessEnv, NOW).license?.plan).toBe('pro');
    const missing = resolveEntitlements({ PSARELAY_LICENSE_FILE: join(dir, 'nope'), PSARELAY_LICENSE_PUBLIC_KEY: PUB } as NodeJS.ProcessEnv, NOW);
    expect(missing.mode).toBe('invalid');
    expect(missing.detail).toContain('ENOENT');
    writeFileSync(f, '');
    expect(resolveEntitlements({ PSARELAY_LICENSE_FILE: f, PSARELAY_LICENSE_PUBLIC_KEY: PUB } as NodeJS.ProcessEnv, NOW).mode).toBe('invalid');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('tool gate on a read-only trial', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; _resetEntitlements(); });
  test('writes are refused with the upgrade message and listed as locked; reads still run', () => {
    process.env.PSARELAY_LICENSE = token({ trial: true, modules: ['contracts'], expiresAt: '2099-01-01T00:00:00Z' });
    process.env.PSARELAY_LICENSE_PUBLIC_KEY = PUB;
    _resetEntitlements();
    expect(toolBlockReason('autotask_update_ticket')).toMatch(/this free trial is read-only/);
    expect(toolLockedReason('autotask_update_ticket')).toMatch(/^🔒/);
    expect(toolListed('autotask_update_ticket')).toBe(true);
    expect(toolBlockReason('autotask_search_tickets')).toBeNull();
    expect(toolBlockReason('autotask_raw_request')).toMatch(/read-only/);
  });
  test('an ended trial refuses reads too, but discovery tools stay open', () => {
    process.env.PSARELAY_LICENSE = token({ trial: true, expiresAt: '2020-01-01T00:00:00Z' });
    process.env.PSARELAY_LICENSE_PUBLIC_KEY = PUB;
    _resetEntitlements();
    expect(toolBlockReason('autotask_search_tickets')).toMatch(/Your free trial ended/);
    expect(toolBlockReason('autotask_whoami')).toBeNull();
  });
});
