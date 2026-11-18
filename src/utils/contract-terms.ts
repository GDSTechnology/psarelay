// Contract terms (#22): the per-contract child records that set how labour is
// billed — prepaid blocks, block-hour factors, role rates, role costs,
// exclusions, retainers and ticket purchases. One tool family covers them all
// (autotask_list / create / update / delete_contract_term) with `kind` picking
// the entity; this module is the pure part: which entity, which operations,
// which contract types, and the field plan checked against the LIVE field list.

import type { FieldInfo } from '../services/picklist.cache.js';
import { matchPicklistExact } from './staff-tools.js';

export type ContractTermKind =
  | 'block'
  | 'blockHourFactor'
  | 'rate'
  | 'roleCost'
  | 'exclusionBillingCode'
  | 'exclusionRole'
  | 'retainer'
  | 'ticketPurchase';

export type ContractTermOp = 'create' | 'update' | 'delete';

export interface ContractTermSpec {
  /** Autotask entity name (query / entityInformation). */
  entity: string;
  /** Child route under /Contracts/{id}/… for writes. */
  child: string;
  label: string;
  ops: ContractTermOp[];
  /** Contract types this kind belongs to (Contracts.contractType); undefined = any. */
  contractTypes?: number[];
  /** Fields that make two rows "the same" (a re-run would duplicate). */
  sameKey: string[];
  /** Short field guide for the tool description / errors. */
  hint: string;
}

/** Contracts.contractType values (Autotask standard picklist). */
export const CONTRACT_TYPE_LABELS: Record<number, string> = {
  1: 'Time & Materials', 3: 'Fixed Price', 4: 'Block Hours', 6: 'Retainer', 7: 'Recurring Service', 8: 'Per Ticket',
};

// Operations per the Autotask REST reference (entityInformation can/canUpdate/canDelete).
export const CONTRACT_TERMS: Record<ContractTermKind, ContractTermSpec> = {
  block: {
    entity: 'ContractBlocks', child: 'Blocks', label: 'prepaid hour block', ops: ['create', 'update'], contractTypes: [4],
    sameKey: ['startDate', 'endDate', 'hours'],
    hint: 'datePurchased, startDate, endDate, hours, hourlyRate, isPaid, status, paymentType, paymentNumber, invoiceNumber',
  },
  blockHourFactor: {
    entity: 'ContractBlockHourFactors', child: 'BlockHourFactors', label: 'block-hour factor', ops: ['create', 'update', 'delete'], contractTypes: [4],
    sameKey: ['roleID'],
    hint: 'roleID, blockHourMultiplier (hours drawn from the block per hour worked in that role)',
  },
  rate: {
    entity: 'ContractRates', child: 'Rates', label: 'role rate', ops: ['create', 'update', 'delete'],
    sameKey: ['roleID'],
    hint: 'roleID, contractHourlyRate (overrides the role\'s standard rate on this contract)',
  },
  roleCost: {
    entity: 'ContractRoleCosts', child: 'RoleCosts', label: 'role cost', ops: ['create', 'update'],
    sameKey: ['resourceID', 'roleID'],
    hint: 'resourceID, roleID, rate (internal cost of that resource in that role on this contract)',
  },
  exclusionBillingCode: {
    entity: 'ContractExclusionBillingCodes', child: 'ExclusionBillingCodes', label: 'excluded work type', ops: ['create', 'delete'],
    sameKey: ['billingCodeID'],
    hint: 'billingCodeID (work type / billing code NOT covered by this contract — billed separately)',
  },
  exclusionRole: {
    entity: 'ContractExclusionRoles', child: 'ExclusionRoles', label: 'excluded role', ops: ['create', 'delete'],
    sameKey: ['roleID'],
    hint: 'roleID (role NOT covered by this contract — billed separately)',
  },
  retainer: {
    entity: 'ContractRetainers', child: 'Retainers', label: 'retainer purchase', ops: ['create', 'update'], contractTypes: [6],
    sameKey: ['startDate', 'endDate', 'amount'],
    hint: 'datePurchased, startDate, endDate, amount, isPaid, status, paymentType, paymentNumber, invoiceNumber',
  },
  ticketPurchase: {
    entity: 'ContractTicketPurchases', child: 'TicketPurchases', label: 'ticket purchase', ops: ['create', 'update'], contractTypes: [8],
    sameKey: ['startDate', 'endDate', 'ticketsPurchased'],
    hint: 'datePurchased, startDate, endDate, ticketsPurchased, perTicketRate, isPaid, status, paymentType, paymentNumber, invoiceNumber',
  },
};

export const CONTRACT_TERM_KINDS = Object.keys(CONTRACT_TERMS) as ContractTermKind[];

export function isContractTermKind(v: unknown): v is ContractTermKind {
  return typeof v === 'string' && (CONTRACT_TERM_KINDS as string[]).includes(v);
}

/** Why this kind doesn't fit the contract's type, or null when it does. */
export function contractTypeProblem(kind: ContractTermKind, contractType: unknown): string | null {
  const allowed = CONTRACT_TERMS[kind].contractTypes;
  if (!allowed) return null;
  const t = Number(contractType);
  if (allowed.includes(t)) return null;
  const want = allowed.map((a) => `${CONTRACT_TYPE_LABELS[a] ?? a} (${a})`).join(' / ');
  return `a ${CONTRACT_TERMS[kind].label} belongs on a ${want} contract; this contract is ${CONTRACT_TYPE_LABELS[t] ?? 'type'} (${Number.isFinite(t) ? t : 'unknown'})`;
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  const da = String(a), db = String(b);
  // Dates: compare the day when either side is a bare date.
  if (/^\d{4}-\d{2}-\d{2}/.test(da) && /^\d{4}-\d{2}-\d{2}/.test(db) && (da.length === 10 || db.length === 10)) return da.slice(0, 10) === db.slice(0, 10);
  return da === db;
};

/** Existing rows that match the planned row on the kind's identity fields. */
export function findSameTerm(kind: ContractTermKind, body: Record<string, unknown>, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const key = CONTRACT_TERMS[kind].sameKey;
  if (!key.every((k) => body[k] !== undefined)) return [];
  return rows.filter((r) => key.every((k) => sameValue(r[k], body[k])));
}

export interface TermPlan {
  ok: boolean;
  body: Record<string, unknown>;
  errors: string[];
  warnings: string[];
  /** Picklist labels resolved to ids. */
  resolved: Array<{ field: string; requested: unknown; value: number; label: string }>;
  /** Update only: field → { before, after } for what actually changes. */
  changes?: Record<string, { before: unknown; after: unknown }>;
}

/**
 * Check the fields for a create / update against the live field list:
 * unknown and read-only fields are refused (listing the writable ones),
 * picklist labels resolve to ids (an ambiguous or unknown label is refused with
 * the choices), a create must carry every required field, and an update keeps
 * only what differs from `existing`. contractID / id are set by the caller.
 */
export function planContractTermFields(
  op: 'create' | 'update',
  fields: Record<string, unknown>,
  fieldInfo: FieldInfo[],
  existing?: Record<string, unknown> | null,
): TermPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved: TermPlan['resolved'] = [];
  const byName = new Map(fieldInfo.map((f) => [f.name.toLowerCase(), f]));
  const writable = fieldInfo.filter((f) => !f.isReadOnly && f.name !== 'id' && f.name !== 'contractID').map((f) => f.name);
  const body: Record<string, unknown> = {};

  for (const [rawName, value] of Object.entries(fields ?? {})) {
    if (rawName === 'id' || rawName === 'contractID') continue;
    if (value === undefined) continue;
    const f = byName.get(rawName.toLowerCase());
    if (!f) { errors.push(`unknown field "${rawName}" (writable: ${writable.join(', ') || 'none'})`); continue; }
    if (f.isReadOnly) { errors.push(`"${f.name}" is read-only`); continue; }
    if (f.isPickList && value !== null && typeof value === 'string' && !/^\d+$/.test(value.trim())) {
      const m = matchPicklistExact(f.picklistValues, value);
      if (!m.ok) {
        errors.push(`"${f.name}": ${m.reason === 'ambiguous' ? 'ambiguous' : 'unknown'} value "${value}" (choices: ${m.choices.map((c) => `${c.value} ${c.label}`).join('; ') || 'none'})`);
        continue;
      }
      resolved.push({ field: f.name, requested: value, value: m.value, label: m.label });
      body[f.name] = m.value;
      continue;
    }
    body[f.name] = f.isPickList && typeof value === 'string' ? Number(value) : value;
  }

  if (op === 'create') {
    const missing = fieldInfo
      .filter((f) => f.isRequired && f.name !== 'id' && f.name !== 'contractID' && body[f.name] === undefined)
      .map((f) => f.name);
    if (missing.length) errors.push(`missing required field(s): ${missing.join(', ')}`);
    return { ok: errors.length === 0, body, errors, warnings, resolved };
  }

  const changes: Record<string, { before: unknown; after: unknown }> = {};
  const changed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    const before = existing?.[k];
    if (existing && sameValue(before, v)) continue;
    changes[k] = { before: before ?? null, after: v };
    changed[k] = v;
  }
  if (!Object.keys(body).length && !errors.length) errors.push('no fields to change');
  else if (!Object.keys(changed).length && !errors.length) warnings.push('every field already has that value');
  return { ok: errors.length === 0, body: changed, errors, warnings, resolved, changes };
}

/** Fields the write asked for that the read-back doesn't show. */
export function termNotApplied(body: Record<string, unknown>, record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  return Object.keys(body).filter((k) => !sameValue(record[k], body[k]));
}
