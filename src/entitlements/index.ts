// Entitlements: which modules this instance may use.
//
// SELF-HOSTED (no licence configured): everything is unlocked — the AGPL edition has no gates.
// HOSTED: the control plane gives each instance a LICENCE — a token it signs with its private key; the instance
// verifies it with the public key (PSARELAY_LICENSE_PUBLIC_KEY), so it can't be forged locally:
//   PSARELAY_LICENSE = base64url(JSON payload) + "." + base64url(Ed25519 signature of the payload part)
//   payload: { customer, plan, planName, modules: [...], expiresAt, upgradeUrl?, offers?: { module: { includedIn: [...], addon? } },
//              trial?, readOnly? }
// The licence comes from PSARELAY_LICENSE, or from the file named by PSARELAY_LICENSE_FILE (the control plane rewrites
// it; it is re-read every minute, so a new licence applies without a restart).
// READ-ONLY plans (readOnly: true; a trial is read-only unless it says readOnly: false) lock every tool that changes
// Autotask, whatever the console's "Allow write tools" switch says. A TRIAL has no grace period: once it ends, every
// module is locked (the instance and its settings are kept) until a plan is chosen.
// A locked tool is refused with a message that says which plan or add-on unlocks it (and where to ask), so an AI
// client can explain it instead of failing. An expired licence keeps working for a 7-day grace period, then falls back
// to the core module; an invalid one gives core only (and the console says why).

import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type Mode = 'self-hosted' | 'licensed' | 'grace' | 'expired' | 'invalid';
export interface Offer { includedIn?: string[]; addon?: string }
export interface LicensePayload { customer: string; plan: string; planName?: string; modules: string[]; expiresAt: string; upgradeUrl?: string; offers?: Record<string, Offer>; trial?: boolean; readOnly?: boolean }
export interface Entitlements { mode: Mode; modules: Set<string> | 'all'; license: LicensePayload | null; detail: string; trial: boolean; readOnly: boolean }

/** The modules a plan can unlock (platform tools are always on). */
export const MODULE_INFO: Record<string, { name: string; description: string }> = {
  core: { name: 'Service desk & time', description: 'Tickets, notes, time, companies, contacts, projects, CIs, dispatch, to-dos.' },
  contracts: { name: 'Contracts & financial', description: 'Contracts, services, quotes, opportunities, products and the service catalog.' },
  billing: { name: 'Billing', description: 'Billing items, invoices, charges, expenses.' },
  reports: { name: 'Reports & audit', description: 'Unbilled work, SLA, utilisation, project P&L, recurring revenue, ticket history and activity audits.' },
  vendor: { name: 'Vendor billing reconciliation', description: 'Vendor invoices against what customers are billed, pricing policy, fixes as reviewed plans.' },
  cleanup: { name: 'Merges & bulk cleanup', description: 'Duplicate discovery, safe merges, paced bulk cleanup jobs.' },
  commerce: { name: 'Commerce', description: 'Sell through Autotask: offerings, orders, subscription changes, tracking to payment.' },
  webhooks: { name: 'Webhooks & automation', description: 'Autotask webhooks for n8n and other automation.' },
};
export const CORE_MODULE = 'core';

const CATEGORY_MODULE: Record<string, string> = {
  companies: 'core', contacts: 'core', tickets: 'core', projects: 'core', resources: 'core', configuration_items: 'core', company_notes: 'core',
  service_calls: 'core', company_todos: 'core', financial: 'contracts', products_and_services: 'contracts', time_and_billing: 'billing',
  vendor_billing: 'vendor', commerce: 'commerce', webhooks: 'webhooks', utility: 'platform',
};

/** The module a tool belongs to ('platform' = always on). Name patterns refine the category. */
export function moduleOf(tool: string, categories: string[]): string {
  if (/^autotask_(merge_|bulk_inactivate|find_duplicate)/.test(tool)) return 'cleanup';
  if (/^autotask_report_|_audit|activity_feed|ticket_history|change_history|backfill_history/.test(tool) && tool !== 'autotask_report_gap') return 'reports';
  // Technicians' own time is core, not billing.
  if (/time_entr|log_my_time|my_day|log_ticket_collaboration/.test(tool)) return 'core';
  if (/^autotask_(change_plan|pricing_|catalog_|contract_plan|vendor_|reconcile_|billing_preinvoice)/.test(tool)) return 'vendor';
  for (const c of categories) if (CATEGORY_MODULE[c]) return CATEGORY_MODULE[c]!;
  return 'platform';
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Verify and read a licence token. Throws a reason when it is not valid. */
export function readLicense(token: string, publicKeyPem: string): LicensePayload {
  const [body, sig] = token.trim().split('.');
  if (!body || !sig) throw new Error('the licence is not in the expected form (payload.signature)');
  const ok = verify(null, Buffer.from(body), createPublicKey(publicKeyPem), b64(sig));
  if (!ok) throw new Error('the licence signature does not verify — it was not issued for this public key');
  const p = JSON.parse(b64(body).toString('utf8')) as LicensePayload;
  if (!p || typeof p.plan !== 'string' || !Array.isArray(p.modules) || typeof p.expiresAt !== 'string') throw new Error('the licence payload is missing plan, modules or expiresAt');
  return p;
}

export const GRACE_DAYS = 7;

/** What this instance may use, from the environment (no licence → self-hosted, everything). */
export function resolveEntitlements(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Entitlements {
  const file = String(env.PSARELAY_LICENSE_FILE ?? '').trim();
  let token = String(env.PSARELAY_LICENSE ?? '').trim();
  let fileError: string | null = null;
  if (file) {
    try { token = readFileSync(file, 'utf8').trim(); } catch (e) { fileError = `PSARELAY_LICENSE_FILE could not be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`; }
  }
  // A configured licence file that is missing, unreadable or empty never falls back to "self-hosted" (that would unlock everything).
  if (!token && !file) return { mode: 'self-hosted', modules: 'all', license: null, detail: 'Self-hosted: every module is unlocked.', trial: false, readOnly: false };
  const key = String(env.PSARELAY_LICENSE_PUBLIC_KEY ?? '').replace(/\\n/g, '\n').trim();
  let lic: LicensePayload;
  try {
    if (fileError) throw new Error(fileError);
    if (!token) throw new Error('the licence file is empty');
    if (!key) throw new Error('PSARELAY_LICENSE_PUBLIC_KEY is not set');
    lic = readLicense(token, key);
  } catch (e) {
    return { mode: 'invalid', modules: new Set([CORE_MODULE]), license: null, detail: `Licence not valid (${(e as Error).message}) — only the core module is available.`, trial: false, readOnly: false };
  }
  const exp = Date.parse(lic.expiresAt);
  const modules = new Set([CORE_MODULE, ...lic.modules]);
  const trial = lic.trial === true;
  const readOnly = typeof lic.readOnly === 'boolean' ? lic.readOnly : trial;
  if (trial && Number.isFinite(exp) && now > exp) {
    return { mode: 'expired', modules: new Set(), license: lic, detail: `Your free trial ended ${lic.expiresAt.slice(0, 10)}. PSARelay is locked until a plan is chosen; your setup and settings are kept.`, trial, readOnly: true };
  }
  if (Number.isFinite(exp) && now > exp) {
    if (now <= exp + GRACE_DAYS * 86_400_000) return { mode: 'grace', modules, license: lic, detail: `Licence expired ${lic.expiresAt.slice(0, 10)} — working for a ${GRACE_DAYS}-day grace period; renew to keep your modules.`, trial, readOnly };
    return { mode: 'expired', modules: new Set([CORE_MODULE]), license: lic, detail: `Licence expired ${lic.expiresAt.slice(0, 10)} — only the core module is available until it is renewed.`, trial, readOnly };
  }
  const days = Number.isFinite(exp) ? Math.max(0, Math.ceil((exp - now) / 86_400_000)) : null;
  const detail = trial
    ? `Free trial${days !== null ? `: ${days} day${days === 1 ? '' : 's'} left (ends ${lic.expiresAt.slice(0, 10)})` : ''}${readOnly ? ', read-only' : ''}.`
    : `${lic.planName ?? lic.plan} plan${readOnly ? ' (read-only)' : ''}.`;
  return { mode: 'licensed', modules, license: lic, detail, trial, readOnly };
}

let cached: { at: number; e: Entitlements } | null = null;
/** Current entitlements (re-read every minute so a new licence applies without a restart where env is reloaded). */
export function entitlements(): Entitlements {
  if (!cached || Date.now() - cached.at > 60_000) cached = { at: Date.now(), e: resolveEntitlements() };
  return cached.e;
}
export const _resetEntitlements = () => { cached = null; };

/** The account's plan for the console: mode, plan, and every module with whether it is included and how to get it. */
export function entitlementView(e: Entitlements = entitlements()) {
  return {
    mode: e.mode, detail: e.detail, plan: e.license?.plan ?? null, planName: e.license?.planName ?? e.license?.plan ?? null, customer: e.license?.customer ?? null,
    expiresAt: e.license?.expiresAt ?? null, upgradeUrl: e.license?.upgradeUrl ?? null, trial: e.trial, readOnly: e.readOnly, writeLock: planWriteLock(undefined, e),
    modules: Object.entries(MODULE_INFO).map(([id, m]) => ({ id, ...m, included: e.modules === 'all' || e.modules.has(id), offer: e.license?.offers?.[id] ?? null })),
  };
}

const askFor = (e: Entitlements) => (e.license?.upgradeUrl ? ` Ask your administrator, or request it at ${e.license.upgradeUrl}.` : ' Ask your administrator to add it.');

/** Why the plan doesn't allow changes to Autotask (read-only plan or trial), or null. */
export function planWriteLock(tool?: string, e: Entitlements = entitlements()): string | null {
  if (!e.readOnly) return null;
  const what = tool ? `${tool} changes Autotask data, and ` : '';
  const why = e.trial ? 'this free trial is read-only' : `your plan${e.license ? ` (${e.license.planName ?? e.license.plan})` : ''} is read-only`;
  const ask = e.license?.upgradeUrl ? ` Choose a plan to turn on changes: ask your administrator, or go to ${e.license.upgradeUrl}.` : ' Choose a plan to turn on changes: ask your administrator.';
  return `🔒 ${what}${why}.${ask}`;
}

/** Why a module is locked, worded for a person or an AI client — or null when it is available. */
export function lockedReason(module: string, e: Entitlements = entitlements()): string | null {
  if (module === 'platform' || e.modules === 'all' || e.modules.has(module)) return null;
  if (e.trial && e.mode === 'expired') return `🔒 ${e.detail}${e.license?.upgradeUrl ? ` Choose a plan at ${e.license.upgradeUrl}, or ask your administrator.` : ' Ask your administrator to choose a plan.'}`;
  const info = MODULE_INFO[module]; const name = info?.name ?? module;
  const offer = e.license?.offers?.[module];
  const where = [offer?.includedIn?.length ? `included in the ${offer.includedIn.join(' / ')} plan${offer.includedIn.length > 1 ? 's' : ''}` : null, offer?.addon ? `available as the "${offer.addon}" add-on` : null].filter(Boolean).join(', or ');
  const plan = e.license ? ` (your plan: ${e.license.planName ?? e.license.plan})` : '';
  const ask = askFor(e);
  return `🔒 ${name} is not on this account${plan}${where ? ` — it is ${where}` : ''}.${ask}${e.mode === 'invalid' || e.mode === 'expired' ? ` (${e.detail})` : ''}`;
}
