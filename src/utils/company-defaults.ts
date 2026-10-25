// Tenant defaults for new companies (console → Settings → Defaults → New company defaults).
//
// Autotask gives a new company its own defaults (invoice / quote template, tax region, invoice and quote emails),
// which are rarely the ones a tenant uses: Hermes used to set them on every new account. They are set once in the
// console, per tenant (never in code — IDs differ per tenant), as "field=value" lines, and applied by every company
// create; a value the caller gives wins. Pure (no settings import): admin/settings.ts supplies the lines.

/** Company fields a default may set: the billing / document setup Autotask otherwise defaults. */
export const COMPANY_DEFAULT_FIELDS: Record<string, 'id' | 'boolean'> = {
  invoiceTemplateID: 'id', quoteTemplateID: 'id', taxRegionID: 'id',
  invoiceEmailMessageID: 'id', quoteEmailMessageID: 'id', currencyID: 'id',
  billToAddressToUse: 'id', isTaxExempt: 'boolean',
};
const canonical = (f: string) => Object.keys(COMPANY_DEFAULT_FIELDS).find((k) => k.toLowerCase() === f.trim().toLowerCase());

/** Why a "field=value" line is invalid, or null. */
export function companyDefaultLineProblem(line: string): string | null {
  const i = line.indexOf('=');
  if (i < 1) return 'Use field=value, e.g. invoiceTemplateID=12.';
  const f = canonical(line.slice(0, i));
  if (!f) return `Unknown field — one of ${Object.keys(COMPANY_DEFAULT_FIELDS).join(', ')}.`;
  const v = line.slice(i + 1).trim();
  if (COMPANY_DEFAULT_FIELDS[f] === 'boolean') return /^(true|false)$/i.test(v) ? null : `${f} is true or false.`;
  return /^\d+$/.test(v) && Number(v) >= 0 ? null : `${f} is an Autotask id (a whole number).`;
}

/** The configured defaults as company fields. */
export function companyCreateDefaults(lines: string[]): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const line of lines) {
    if (companyDefaultLineProblem(line)) continue;
    const i = line.indexOf('=');
    const f = canonical(line.slice(0, i))!, v = line.slice(i + 1).trim();
    out[f] = COMPANY_DEFAULT_FIELDS[f] === 'boolean' ? /^true$/i.test(v) : Number(v);
  }
  return out;
}

/** The company to create: defaults first, the caller's values on top. Also says which defaults were used. */
export function withCompanyDefaults<T extends Record<string, unknown>>(company: T, defaults: Record<string, number | boolean>): { company: T; applied: string[] } {
  const applied = Object.keys(defaults).filter((k) => company[k] === undefined);
  return { company: { ...Object.fromEntries(applied.map((k) => [k, defaults[k]])), ...company } as T, applied };
}
