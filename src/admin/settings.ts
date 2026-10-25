// Runtime settings the admin console can change without a restart.
//
// Each setting's DEFAULT comes from the environment (so a server without the
// console behaves exactly as configured); a value saved in the console
// (admin_setting) overrides it until it is reset. Pure in-memory registry — no
// database or runtime imports here, so the hot paths (tool dispatch, the HTTP
// cache) can read settings cheaply. admin/apply.ts pushes values into the
// shadow runtime.

import { companyCreateDefaults, companyDefaultLineProblem } from '../utils/company-defaults.js';
import { registryLineProblem, referenceLineProblem } from '../utils/actor-classify.js';

export type SettingType = 'boolean' | 'integer' | 'string[]' | 'lines';

export interface SettingDef {
  key: string;
  group: 'Security' | 'Tools' | 'Defaults' | 'Postgres shadow' | 'Autotask API' | 'Diagnostics' | 'Actors';
  label: string;
  description: string;
  type: SettingType;
  min?: number;
  max?: number;
  /** Allowed values for string[] settings (filled in by the console at startup). */
  choices?: string[];
  /** For 'lines' settings: why a line is invalid, or null (default: pattern=name). */
  lineProblem?: (line: string) => string | null;
  /** Only meaningful when this subsystem is running. */
  requires?: 'shadow';
  envDefault: (env: NodeJS.ProcessEnv) => unknown;
}

const boolEnv = (v: string | undefined, d: boolean): boolean => (v == null || v === '' ? d : /^(true|1|yes|on)$/i.test(v));
const intEnv = (v: string | undefined, d: number): number => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };

export const SETTINGS: SettingDef[] = [
  {
    key: 'security.requireMcpToken', group: 'Security', type: 'boolean', label: 'Require an access token on /mcp',
    description: 'On = every MCP call must carry a valid access token (Authorization: Bearer psr_…, created on the Access page); anything else gets HTTP 401. Off = anyone who can reach the MCP port can use every tool — only the network (tunnel, firewall) protects it. Create tokens for n8n and your other clients first, then turn this on. Needs Postgres.',
    envDefault: (env) => boolEnv(env.MCP_REQUIRE_TOKEN, false),
  },
  {
    key: 'security.trustUnverifiedIdentity', group: 'Security', type: 'boolean', label: 'Trust identities a client declares without a token',
    description: 'Off (recommended) = a call that is not backed by a token naming a person (or a delegate token) runs as the API user: the email a client puts in its request is recorded but never used to write as that person (Autotask impersonation) — any client could claim to be anyone. On = the old behaviour: caller-mode impersonation trusts the declared email.',
    envDefault: (env) => boolEnv(env.MCP_TRUST_UNVERIFIED_IDENTITY, false),
  },
  {
    key: 'tools.writesEnabled', group: 'Tools', type: 'boolean', label: 'Allow write tools',
    description: 'Off = read-only MCP: every tool that creates, updates or deletes Autotask data is hidden and refused. Reads keep working.',
    envDefault: () => true,
  },
  {
    key: 'entitlements.showLockedTools', group: 'Tools', type: 'boolean', label: 'Show tools that need an upgrade',
    description: 'Hosted plans: list the tools of modules not on the account (marked as locked, answering which plan or add-on unlocks them) so AI clients can say what an upgrade adds. Off hides them. Self-hosted instances have no locked tools.',
    envDefault: () => true,
  },
  {
    key: 'tools.disabledCategories', group: 'Tools', type: 'string[]', label: 'Disabled tool groups',
    description: 'Tool groups hidden from agents and refused if called. A tool listed in several groups is disabled when any of them is.',
    envDefault: () => [],
  },
  {
    key: 'shadow.syncEnabled', group: 'Postgres shadow', type: 'boolean', requires: 'shadow', label: 'Scheduled sync',
    description: 'Off pauses the background sync (no Autotask calls). The mirror goes stale; once it is older than the max age, reads fall back to the live API.',
    envDefault: () => true,
  },
  {
    key: 'shadow.serveReads', group: 'Postgres shadow', type: 'boolean', requires: 'shadow', label: 'Serve searches from the shadow',
    description: 'Answer search tools from Postgres instead of the Autotask API while the mirror is fresh.',
    envDefault: (env) => boolEnv(env.MCP_PG_SHADOW_SERVE_READS, false),
  },
  {
    key: 'shadow.maxAgeSeconds', group: 'Postgres shadow', type: 'integer', min: 60, max: 86_400, requires: 'shadow', label: 'Max mirror age (seconds)',
    description: 'Searches use the shadow only while its last sync is at most this old.',
    envDefault: (env) => intEnv(env.MCP_PG_SHADOW_MAX_AGE_SECONDS, 900),
  },
  {
    key: 'shadow.pauseAtPct', group: 'Postgres shadow', type: 'integer', min: 1, max: 100, requires: 'shadow', label: 'Pause sync at API usage %',
    description: "Skip a sync run while the tenant's hourly Autotask API usage is at or above this percentage. Keep it high (85): a run costs at most 100 calls, while a stale mirror sends every read to Autotask live.",
    envDefault: (env) => intEnv(env.MCP_PG_SHADOW_PAUSE_AT_PCT, 85),
  },
  {
    key: 'companies.createDefaults', group: 'Defaults', type: 'lines', label: 'New company defaults',
    description: 'Set on every company PSArelay creates (AI, imports, orders) unless the request gives its own value — otherwise Autotask applies its defaults. One per line, field=value with this tenant\'s Autotask ids: invoiceTemplateID, quoteTemplateID, taxRegionID, invoiceEmailMessageID, quoteEmailMessageID, currencyID, billToAddressToUse, isTaxExempt (true/false). Example: invoiceTemplateID=12.',
    lineProblem: companyDefaultLineProblem,
    envDefault: (env) => (env.MCP_COMPANY_DEFAULTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  {
    key: 'callers.labels', group: 'Diagnostics', type: 'lines', label: 'Caller names',
    description: 'Names for clients that do not say who they are (shown as "unknown"). One rule per line, pattern=name. The pattern matches the IP address exactly, or appears in the client name (user agent). First match wins. Example: 172.19.0.3=n8n, Python-urllib=cron, Go-http-client=ChatGPT.',
    envDefault: (env) => (env.MCP_CALLER_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  {
    key: 'actors.registry', group: 'Actors', type: 'lines', label: 'Actor registry',
    description: 'Overrides for who an Autotask resource is, used by ticket history and the activity feed. One per line: resourceId=type or resourceId=type:label, type = human, service_account, integration, system or unknown (e.g. 512=integration:Datto RMM). Use it to confirm accounts the automatic rules mark unknown.',
    lineProblem: registryLineProblem,
    envDefault: (env) => (env.MCP_ACTOR_REGISTRY ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  {
    key: 'actors.reference', group: 'Actors', type: 'lines', label: 'Reference technicians',
    description: 'People whose ticket work is the trusted standard to learn from (always human). One per line: resourceId or resourceId=name. Automation — including this MCP\'s own n8n/Nexus writes — is never a reference.',
    lineProblem: referenceLineProblem,
    envDefault: (env) => (env.MCP_ACTOR_REFERENCE ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  {
    key: 'cache.enabled', group: 'Autotask API', type: 'boolean', label: 'Read cache',
    description: 'Short-lived cache of Autotask reads (writes always clear it). Off sends every read to Autotask.',
    envDefault: (env) => !/^(off|false|0|no)$/i.test(env.AUTOTASK_CACHE ?? ''),
  },
];

const byKey = new Map(SETTINGS.map((s) => [s.key, s]));
let overrides = new Map<string, unknown>();

export function settingDef(key: string): SettingDef | undefined { return byKey.get(key); }

/** The effective value: the console's saved value, else the env default. */
export function settingValue<T = unknown>(key: string, env: NodeJS.ProcessEnv = process.env): T {
  if (overrides.has(key)) return overrides.get(key) as T;
  const def = byKey.get(key);
  if (!def) throw new Error(`Unknown setting ${key}`);
  return def.envDefault(env) as T;
}

export function isOverridden(key: string): boolean { return overrides.has(key); }

/** Validate and normalise a value for a setting; throws with a user-facing message. */
export function coerceSetting(key: string, value: unknown): unknown {
  const def = byKey.get(key);
  if (!def) throw new Error(`Unknown setting "${key}".`);
  switch (def.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${def.label} must be true or false.`);
      return value;
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(n)) throw new Error(`${def.label} must be a whole number.`);
      if (def.min != null && n < def.min) throw new Error(`${def.label} must be at least ${def.min}.`);
      if (def.max != null && n > def.max) throw new Error(`${def.label} must be at most ${def.max}.`);
      return n;
    }
    case 'lines': {
      const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n|,/) : null;
      if (!list || list.some((v) => typeof v !== 'string')) throw new Error(`${def.label} must be a list of lines.`);
      const lines = list.map((v) => v.trim()).filter(Boolean);
      if (lines.length > 200) throw new Error(`${def.label}: at most 200 lines.`);
      for (const l of lines) {
        if (def.lineProblem) { const p = def.lineProblem(l); if (p) throw new Error(`${def.label}: ${p}.`); continue; }
        const i = l.indexOf('=');
        if (i < 1 || i === l.length - 1) throw new Error(`${def.label}: "${l}" must look like pattern=name.`);
        if (l.length - i - 1 > 40) throw new Error(`${def.label}: the name in "${l}" is longer than 40 characters.`);
      }
      return lines;
    }
    case 'string[]': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`${def.label} must be a list.`);
      const bad = def.choices ? value.filter((v) => !def.choices!.includes(v)) : [];
      if (bad.length) throw new Error(`Unknown value(s) for ${def.label}: ${bad.join(', ')}.`);
      return [...new Set(value)].sort();
    }
  }
}

/**
 * Replace every override from a saved map (database load). Invalid saved
 * values (e.g. a category that no longer exists) are dropped, not fatal.
 */
export function loadOverrides(saved: Record<string, unknown>): string[] {
  const next = new Map<string, unknown>();
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(saved)) {
    try { next.set(k, coerceSetting(k, v)); } catch { dropped.push(k); }
  }
  overrides = next;
  return dropped;
}

export function setOverride(key: string, value: unknown): unknown {
  const v = coerceSetting(key, value);
  overrides.set(key, v);
  return v;
}

export function clearOverride(key: string): void { overrides.delete(key); }

/** Tests only. */
export function _resetSettings(): void { overrides = new Map(); }

/** The tenant's new-company defaults (Settings → Defaults), as company fields. */
export const tenantCompanyDefaults = (): Record<string, number | boolean> => companyCreateDefaults(settingValue<string[]>('companies.createDefaults') ?? []);
