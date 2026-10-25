// Entitlements: which modules this instance may use.
//
// SELF-HOSTED (no licence configured): everything is unlocked — the AGPL edition has no gates.
// HOSTED: the control plane gives each instance a LICENCE — a token it signs with its private key; the instance
// verifies it with the public key (PSARELAY_LICENSE_PUBLIC_KEY), so it can't be forged locally:
//   PSARELAY_LICENSE = base64url(JSON payload) + "." + base64url(Ed25519 signature of the payload part)
//   payload: { customer, plan, planName, modules: [...], expiresAt, upgradeUrl?, offers?: { module: { includedIn: [...], addon? } } }
// A locked tool is refused with a message that says which plan or add-on unlocks it (and where to ask), so an AI
// client can explain it instead of failing. An expired licence keeps working for a 7-day grace period, then falls back
// to the core module; an invalid one gives core only (and the console says why).

import { createPublicKey, verify } from 'node:crypto';

export type Mode = 'self-hosted' | 'licensed' | 'grace' | 'expired' | 'invalid';
export interface Offer { includedIn?: string[]; addon?: string }
export interface LicensePayload { customer: string; plan: string; planName?: string; modules: string[]; expiresAt: string; upgradeUrl?: string; offers?: Record<string, Offer> }
export interface Entitlements { mode: Mode; modules: Set<string> | 'all'; license: LicensePayload | null; detail: string }

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
  const token = String(env.PSARELAY_LICENSE ?? '').trim();
  if (!token) return { mode: 'self-hosted', modules: 'all', license: null, detail: 'Self-hosted: every module is unlocked.' };
  const key = String(env.PSARELAY_LICENSE_PUBLIC_KEY ?? '').replace(/\\n/g, '\n').trim();
  let lic: LicensePayload;
  try {
    if (!key) throw new Error('PSARELAY_LICENSE_PUBLIC_KEY is not set');
    lic = readLicense(token, key);
  } catch (e) {
    return { mode: 'invalid', modules: new Set([CORE_MODULE]), license: null, detail: `Licence not valid (${(e as Error).message}) — only the core module is available.` };
  }
  const exp = Date.parse(lic.expiresAt);
  const modules = new Set([CORE_MODULE, ...lic.modules]);
  if (Number.isFinite(exp) && now > exp) {
    if (now <= exp + GRACE_DAYS * 86_400_000) return { mode: 'grace', modules, license: lic, detail: `Licence expired ${lic.expiresAt.slice(0, 10)} — working for a ${GRACE_DAYS}-day grace period; renew to keep your modules.` };
    return { mode: 'expired', modules: new Set([CORE_MODULE]), license: lic, detail: `Licence expired ${lic.expiresAt.slice(0, 10)} — only the core module is available until it is renewed.` };
  }
  return { mode: 'licensed', modules, license: lic, detail: `${lic.planName ?? lic.plan} plan.` };
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
    expiresAt: e.license?.expiresAt ?? null, upgradeUrl: e.license?.upgradeUrl ?? null,
    modules: Object.entries(MODULE_INFO).map(([id, m]) => ({ id, ...m, included: e.modules === 'all' || e.modules.has(id), offer: e.license?.offers?.[id] ?? null })),
  };
}

/** Why a module is locked, worded for a person or an AI client — or null when it is available. */
export function lockedReason(module: string, e: Entitlements = entitlements()): string | null {
  if (module === 'platform' || e.modules === 'all' || e.modules.has(module)) return null;
  const info = MODULE_INFO[module]; const name = info?.name ?? module;
  const offer = e.license?.offers?.[module];
  const where = [offer?.includedIn?.length ? `included in the ${offer.includedIn.join(' / ')} plan${offer.includedIn.length > 1 ? 's' : ''}` : null, offer?.addon ? `available as the "${offer.addon}" add-on` : null].filter(Boolean).join(', or ');
  const plan = e.license ? ` (your plan: ${e.license.planName ?? e.license.plan})` : '';
  const ask = e.license?.upgradeUrl ? ` Ask your administrator, or request it at ${e.license.upgradeUrl}.` : ' Ask your administrator to add it.';
  return `🔒 ${name} is not on this account${plan}${where ? ` — it is ${where}` : ''}.${ask}${e.mode === 'invalid' || e.mode === 'expired' ? ` (${e.detail})` : ''}`;
}
