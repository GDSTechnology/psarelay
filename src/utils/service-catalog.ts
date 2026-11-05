// Services catalog writes (autotask_create_service / update_service / validate_service).
//
// Why (2026-11-05): a managed-services offering (a base package + a per-user add-on)
// had to be created as Autotask Services — the recurring catalog entries that
// contracts and quotes draw on — and nothing could write them: only Products had
// create / update tools. This module is the pure part: which fields the tenant
// takes, duplicate detection, money checks and the before/after of an update.
// Nothing here calls Autotask.
//
// Field names are checked against the LIVE field list (Services/entityInformation/
// fields), not this file: a field the tenant lacks, or one that is read-only, is
// refused before anything is sent.

import type { FieldInfo } from '../services/picklist.cache.js';
import { findInternalText } from './invoice-text.js';

/** Service fields the tools accept (Autotask names). Others are refused. */
export const SERVICE_INPUT_FIELDS = [
  'name', 'description', 'invoiceDescription', 'unitPrice', 'unitCost', 'periodType', 'billingCodeID',
  'isActive', 'sku', 'catalogNumberPartNumber', 'manufacturerServiceProvider',
  'manufacturerServiceProviderProductNumber', 'serviceLevelAgreementID', 'vendorCompanyID', 'markupRate',
] as const;
export type ServiceInputField = (typeof SERVICE_INPUT_FIELDS)[number];

/** Fields whose change alters what a customer is charged — shown first, called out in the plan. */
export const PRICING_FIELDS: ReadonlySet<string> = new Set(['unitPrice', 'unitCost', 'periodType', 'billingCodeID', 'markupRate']);

/** Text that prints on the customer's quote / invoice. */
const CUSTOMER_TEXT_FIELDS = ['name', 'description', 'invoiceDescription'] as const;

/** Identifier fields a SKU is matched against (whichever the tenant has). */
export const SERVICE_IDENTIFIER_FIELDS = ['sku', 'catalogNumberPartNumber'] as const;

export type ServiceErrorKind = 'validation' | 'duplicate' | 'permission' | 'api' | 'not_found';
export interface ServiceIssue { kind: ServiceErrorKind; field?: string; message: string }

export interface CatalogService {
  id: number;
  name?: string | null;
  sku?: string | null;
  catalogNumberPartNumber?: string | null;
  isActive?: boolean | null;
  unitPrice?: number | null;
  periodType?: number | null;
  [key: string]: unknown;
}

export interface ServiceDuplicate {
  id: number;
  name: string | null;
  sku: string | null;
  catalogNumberPartNumber: string | null;
  isActive: boolean | null;
  unitPrice: number | null;
  periodType: number | null;
  matchedOn: Array<'sku' | 'name'>;
}

const norm = (v: unknown): string => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Only the accepted Service fields that were actually given (zero and false are values; blank strings are not). */
export function pickServiceFields(input: Record<string, unknown>): Partial<Record<ServiceInputField, unknown>> {
  const out: Partial<Record<ServiceInputField, unknown>> = {};
  for (const f of SERVICE_INPUT_FIELDS) {
    const v = input[f];
    if (v === undefined) continue;
    out[f] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

/**
 * Services with the same SKU / catalog number (exact, case-insensitive, either
 * identifier field) or the same name. Inactive services count: re-creating one
 * that was retired is the same offering twice; reactivate it instead.
 */
export function findServiceDuplicates(catalog: CatalogService[], probe: { name?: unknown; sku?: unknown; catalogNumberPartNumber?: unknown; excludeId?: number }): ServiceDuplicate[] {
  const ids = [probe.sku, probe.catalogNumberPartNumber].map(norm).filter(Boolean);
  const name = norm(probe.name);
  const out: ServiceDuplicate[] = [];
  for (const s of catalog) {
    if (probe.excludeId !== undefined && Number(s.id) === probe.excludeId) continue;
    const matchedOn: Array<'sku' | 'name'> = [];
    if (ids.length && SERVICE_IDENTIFIER_FIELDS.some((f) => { const v = norm(s[f]); return !!v && ids.includes(v); })) matchedOn.push('sku');
    if (name && norm(s.name) === name) matchedOn.push('name');
    if (!matchedOn.length) continue;
    out.push({
      id: Number(s.id), name: (s.name as string) ?? null, sku: (s.sku as string) ?? null, catalogNumberPartNumber: (s.catalogNumberPartNumber as string) ?? null,
      isActive: s.isActive == null ? null : s.isActive === true || (s.isActive as unknown) === 1,
      unitPrice: s.unitPrice == null ? null : Number(s.unitPrice), periodType: s.periodType == null ? null : Number(s.periodType), matchedOn,
    });
  }
  // SKU hits first: an identifier is a stronger claim than a name.
  return out.sort((a, b) => Number(b.matchedOn.includes('sku')) - Number(a.matchedOn.includes('sku')) || a.id - b.id);
}

/**
 * Check the given fields against the tenant's live Services field list: unknown
 * and read-only fields are refused; on create, required fields must be present.
 * Money must be a finite number ≥ 0 — and 0 IS a value (a $0 cost is real).
 */
export function checkServiceInput(fields: FieldInfo[], input: Partial<Record<ServiceInputField, unknown>>, mode: 'create' | 'update', opts: { allowInternalText?: boolean } = {}): { errors: ServiceIssue[]; warnings: string[] } {
  const errors: ServiceIssue[] = [];
  const warnings: string[] = [];
  const byName = new Map(fields.map((f) => [f.name, f]));
  for (const [k, v] of Object.entries(input)) {
    const f = byName.get(k);
    if (!f) { errors.push({ kind: 'validation', field: k, message: `this tenant's Services entity has no field "${k}"` }); continue; }
    if (f.isReadOnly) errors.push({ kind: 'validation', field: k, message: `${k} is read-only in Autotask` });
    if (typeof f.length === 'number' && f.length > 0 && typeof v === 'string' && v.length > f.length) errors.push({ kind: 'validation', field: k, message: `${k} is ${v.length} characters; Autotask allows ${f.length}` });
  }
  if (mode === 'create') {
    for (const f of fields) {
      if (!f.isRequired || f.isReadOnly || f.name === 'id') continue;
      if (isBlank(input[f.name as ServiceInputField])) errors.push({ kind: 'validation', field: f.name, message: `${f.name} is required to create a Service` });
    }
  }
  if (mode === 'update' && 'name' in input && isBlank(input.name)) errors.push({ kind: 'validation', field: 'name', message: 'name cannot be blank' });
  for (const k of ['unitPrice', 'unitCost', 'markupRate'] as const) {
    if (input[k] === undefined) continue;
    const n = input[k];
    if (n === null || n === '' || typeof n === 'boolean' || !Number.isFinite(Number(n))) errors.push({ kind: 'validation', field: k, message: `${k} must be a number (0 is allowed)` });
    else if (Number(n) < 0) errors.push({ kind: 'validation', field: k, message: `${k} cannot be negative` });
  }
  for (const k of ['billingCodeID', 'periodType', 'serviceLevelAgreementID', 'vendorCompanyID'] as const) {
    const n = input[k];
    if (n === undefined || n === null || typeof n === 'string') continue; // periodType may be a label; resolved later
    if (!Number.isInteger(Number(n))) errors.push({ kind: 'validation', field: k, message: `${k} must be a whole-number id` });
  }
  if (input.isActive !== undefined && typeof input.isActive !== 'boolean') errors.push({ kind: 'validation', field: 'isActive', message: 'isActive must be true or false' });
  if (!opts.allowInternalText) {
    for (const k of CUSTOMER_TEXT_FIELDS) {
      const found = findInternalText(typeof input[k] === 'string' ? (input[k] as string) : '');
      if (found.length) errors.push({ kind: 'validation', field: k, message: `${k} contains ${found.join(', ')} — it shows on customer quotes and invoices; keep cost and margin in unitCost, or pass allowInternalText` });
    }
  }
  const price = input.unitPrice === undefined ? undefined : Number(input.unitPrice);
  const cost = input.unitCost === undefined ? undefined : Number(input.unitCost);
  if (price !== undefined && cost !== undefined && Number.isFinite(price) && Number.isFinite(cost) && cost > price) warnings.push(`unitCost ${cost} is above unitPrice ${price} — this service sells at a loss`);
  if (mode === 'create' && input.unitCost === undefined) warnings.push('unitCost not given — Autotask will store no cost, and margin reports will treat the whole price as profit; pass the real cost (0 if there is none)');
  if (mode === 'create' && input.unitPrice !== undefined && Number(input.unitPrice) === 0) warnings.push('unitPrice is 0 — the service will bill nothing unless a contract overrides it');
  return { errors, warnings };
}

export interface ServiceChange { field: string; from: unknown; to: unknown; pricing: boolean }

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) return true;
  if (typeof a === 'number' || typeof b === 'number') return a !== null && b !== null && a !== '' && b !== '' && Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return (a === true || a === 1) === (b === true || b === 1);
  return String(a ?? '').trim() === String(b ?? '').trim();
};

/** Field-by-field changes an update would make (unchanged fields left out). */
export function diffService(before: Record<string, unknown>, updates: Record<string, unknown>): ServiceChange[] {
  const changes = Object.entries(updates)
    .filter(([k, v]) => !same(before[k], v))
    .map(([field, to]) => ({ field, from: before[field] ?? null, to, pricing: PRICING_FIELDS.has(field) }));
  return changes.sort((a, b) => Number(b.pricing) - Number(a.pricing));
}

/** The fields an update must re-send when the tenant only takes a full PUT (writable fields of the merged record). */
export function fullWritableRecord(fields: FieldInfo[], before: Record<string, unknown>, updates: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...before, ...updates };
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.isReadOnly || f.name === 'id') continue;
    if (merged[f.name] !== undefined) out[f.name] = merged[f.name];
  }
  return out;
}

export interface ServicePlan {
  mode: 'create' | 'update';
  valid: boolean;
  status: 'ready' | 'unchanged' | 'validation_failed' | 'duplicate' | 'not_found';
  serviceId?: number;
  errors: ServiceIssue[];
  warnings: string[];
  duplicates: ServiceDuplicate[];
  /** What would be sent: every given field on create; only the changed ones on update. */
  body: Record<string, unknown>;
  changes: ServiceChange[];
  resolved: { periodType?: { value: number; label: string }; billingCode?: { id: number; name: string | null; useType: number | null } };
  before?: Record<string, unknown>;
  billingCodeSuggestions?: Array<{ id: number; name: string | null; useType: number | null; isActive: boolean | null; usedBy: number }>;
}

export interface ServiceWriteResult {
  operation: 'dry_run' | 'created' | 'updated' | 'unchanged' | 'rejected' | 'failed';
  /** Quote this when troubleshooting: it is in the server log with the write. */
  correlationId: string;
  plan: ServicePlan;
  serviceId?: number;
  record?: Record<string, unknown> | null;
  verified?: boolean;
  notApplied?: string[];
  note?: string;
  error?: ServiceIssue & { status?: number };
}

/** An Autotask write error as a structured issue: permission (401/403) or api, the message without credentials. */
export function describeServiceError(error: unknown): ServiceIssue & { status?: number } {
  const status = (error as { status?: number })?.status;
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/(secret|password|apiintegrationcode|username)\s*[:=]\s*\S+/gi, '$1=[redacted]').slice(0, 800);
  const kind: ServiceErrorKind = status === 401 || status === 403 || /HTTP 40[13]\b|permission|not authori[sz]ed/i.test(raw) ? 'permission' : 'api';
  return { kind, message, ...(status !== undefined ? { status } : {}) };
}
