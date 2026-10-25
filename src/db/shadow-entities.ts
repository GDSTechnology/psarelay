// Which Autotask entities the Postgres shadow mirrors, and how each stays fresh.
// Verified live (2026-10-06): every entity pages in ascending id order (so a
// backfill can walk `id > cursor`), and these are the queryable change fields.

export type ShadowEntityName = 'Tickets' | 'TimeEntries' | 'Tasks' | 'Projects' | 'ServiceCalls' | 'CompanyToDos' | 'Companies' | 'Contacts' | 'Contracts' | 'ContractServices' | 'ContractBlocks' | 'Resources'
  | 'Invoices' | 'BillingItems' | 'TicketCharges' | 'ProjectCharges' | 'ContractCharges' | 'TicketNotes'
  | 'ExpenseItems' | 'Opportunities' | 'ConfigurationItems';

import type { ShadowFilter } from './shadow-sql.js';

export interface ShadowEntity {
  name: ShadowEntityName;
  /** Queryable last-modified field for incremental sync; null = small table, refreshed in full. */
  watermarkField: string | null;
  /** Creation field, OR-ed into the incremental filter in case a new row has no modified stamp yet. */
  createField: string | null;
  /** Full refresh interval for entities without a watermark. */
  fullEveryMinutes?: number;
  /**
   * History window for the backfill (big transactional tables only): the rows
   * worth mirroring when work is about the last N months. Absent = everything.
   */
  window?: (cutoffDay: string) => ShadowFilter;
  /** Whether a query's filters stay inside the window (otherwise it must go live). */
  windowCovers?: (filters: ShadowFilter[], cutoffDay: string) => boolean;
  /**
   * Row-diff audit: when an already-mirrored row changes, these fields are
   * compared old → new and recorded as audit events (the editor is unknown —
   * these entities aren't webhook-capable and don't record who changed them).
   */
  diff?: { type: 'serviceCall' | 'todo'; fields: string[]; actorField?: (field: string) => string | null };
  /**
   * Not verified on every tenant: possible last-modified fields, resolved at
   * sync start from the entity's field list (the first that exists and is
   * queryable becomes the watermark). None found → "window refresh" mode.
   */
  watermarkCandidates?: string[];
  /** Fields the window filter needs; when one is missing on this tenant the entity is not mirrored (clear error, no failing queries). */
  requiredFields?: string[];
  /**
   * Window refresh (entities with a window but no watermark — e.g. Invoices,
   * which get paid/voided after creation): every run reads NEW rows (id above
   * the highest mirrored); every this-many minutes it re-reads the recent part
   * of the window (MCP_PG_SHADOW_REFRESH_DAYS, default 30) to pick up edits;
   * once a day the whole window. Default 60.
   */
  refreshEveryMinutes?: number;
}

const lowerBoundAtLeast = (filters: ShadowFilter[], fields: string[], cutoffDay: string): boolean =>
  filters.some((f) => (f.op === 'gte' || f.op === 'gt') && fields.includes(String(f.field)) && String(f.value ?? '').slice(0, 10) >= cutoffDay);

export const SHADOW_ENTITIES: ShadowEntity[] = [
  {
    name: 'Tickets', watermarkField: 'lastTrackedModificationDateTime', createField: 'createDate',
    // Active or created in the window, plus EVERY open ticket however old.
    window: (c) => ({ op: 'or', items: [{ op: 'gte', field: 'lastActivityDate', value: c }, { op: 'gte', field: 'createDate', value: c }, { op: 'noteq', field: 'status', value: 5 }] }),
    windowCovers: (fs, c) => lowerBoundAtLeast(fs, ['lastActivityDate', 'createDate'], c) || fs.some((f) =>
      (f.op === 'noteq' && f.field === 'status' && Number(f.value) === 5) ||
      (f.op === 'eq' && f.field === 'status' && f.value != null && Number(f.value) !== 5) ||
      (f.op === 'in' && f.field === 'status' && Array.isArray(f.value) && f.value.length > 0 && !f.value.map(Number).includes(5))),
  },
  {
    name: 'TimeEntries', watermarkField: 'lastModifiedDateTime', createField: 'createDateTime',
    window: (c) => ({ op: 'gte', field: 'dateWorked', value: c }),
    windowCovers: (fs, c) => lowerBoundAtLeast(fs, ['dateWorked'], c),
  },
  // Project work: small (≈1.9k tasks / 160 projects at GDS) — mirrored whole, no window.
  { name: 'Tasks', watermarkField: 'lastActivityDateTime', createField: 'createDateTime' },
  { name: 'Projects', watermarkField: 'lastActivityDateTime', createField: 'createDateTime' },
  // Scheduling + CRM admin work (≈4.5k service calls / ≈12.8k To-Dos at GDS): whole, with row diffs.
  {
    name: 'ServiceCalls', watermarkField: 'lastModifiedDateTime', createField: 'createDateTime',
    diff: { type: 'serviceCall', fields: ['startDateTime', 'endDateTime', 'duration', 'status', 'isComplete', 'description', 'canceledDateTime', 'companyID', 'companyLocationID'],
      actorField: (f) => (f === 'canceledDateTime' ? 'canceledByResourceID' : null) },
  },
  {
    name: 'CompanyToDos', watermarkField: 'lastModifiedDate', createField: 'createDateTime',
    diff: { type: 'todo', fields: ['startDateTime', 'endDateTime', 'completedDate', 'assignedToResourceID', 'actionType', 'activityDescription', 'ticketID', 'contactID'] },
  },
  { name: 'Companies', watermarkField: 'lastTrackedModifiedDateTime', createField: 'createDate' },
  { name: 'Contacts', watermarkField: 'lastModifiedDate', createField: 'createDate' },
  { name: 'Contracts', watermarkField: 'lastModifiedDateTime', createField: null },
  { name: 'ContractServices', watermarkField: null, createField: null, fullEveryMinutes: 60 },
  { name: 'ContractBlocks', watermarkField: null, createField: null, fullEveryMinutes: 60 },
  { name: 'Resources', watermarkField: null, createField: null, fullEveryMinutes: 60 },

  // ── Ticket notes (2026-10-09, gap register MCP-004) ────────────────────
  // The activity feed and note reads come from here (0 calls). Windowed by
  // creation: a note created before the window on an old open ticket is not
  // mirrored (those reads go live). lastActivityDate is the documented
  // last-modified field — resolved from the tenant's field list; without it the
  // entity runs in window-refresh mode.
  {
    name: 'TicketNotes', watermarkField: null, createField: 'createDateTime', requiredFields: ['createDateTime'],
    watermarkCandidates: ['lastActivityDate', 'lastModifiedDateTime'], refreshEveryMinutes: 60,
    window: (c) => ({ op: 'gte', field: 'createDateTime', value: c }),
    windowCovers: (fs, c) => lowerBoundAtLeast(fs, ['createDateTime'], c),
  },

  // ── Billing / financial review (2026-10-08) ─────────────────────────────
  // Windowed by their own date; no confirmed last-modified field, so they run
  // in window-refresh mode unless the tenant's field list offers one.
  {
    name: 'Invoices', watermarkField: null, createField: 'createDateTime', requiredFields: ['invoiceDateTime'],
    watermarkCandidates: ['lastModifiedDateTime', 'lastModifiedDate'], refreshEveryMinutes: 60,
    window: (c) => ({ op: 'gte', field: 'invoiceDateTime', value: c }),
    windowCovers: (fs, c) => lowerBoundAtLeast(fs, ['invoiceDateTime'], c),
  },
  {
    name: 'BillingItems', watermarkField: null, createField: null, requiredFields: ['itemDate'],
    watermarkCandidates: ['lastModifiedDateTime', 'lastModifiedDate'], refreshEveryMinutes: 60,
    window: (c) => ({ op: 'gte', field: 'itemDate', value: c }),
    windowCovers: (fs, c) => lowerBoundAtLeast(fs, ['itemDate'], c),
  },
  ...(['TicketCharges', 'ProjectCharges', 'ContractCharges'] as const).map((name): ShadowEntity => ({
    name, watermarkField: null, createField: null, requiredFields: ['datePurchased'],
    watermarkCandidates: ['lastModifiedDateTime', 'lastModifiedDate'], refreshEveryMinutes: 60,
    window: (c) => ({ op: 'gte', field: 'datePurchased', value: c }),
    windowCovers: (fs, c) => lowerBoundAtLeast(fs, ['datePurchased'], c),
  })),
  // Expense lines (2026-10-25: billing checks read them live): windowed by the expense date, like the charges.
  {
    name: 'ExpenseItems', watermarkField: null, createField: null, requiredFields: ['expenseDate'],
    watermarkCandidates: ['lastModifiedDateTime', 'lastModifiedDate'], refreshEveryMinutes: 60,
    window: (c) => ({ op: 'gte', field: 'expenseDate', value: c }),
    windowCovers: (fs, c) => lowerBoundAtLeast(fs, ['expenseDate'], c),
  },
  // Sales pipeline: mirrored whole; incremental when the tenant has a modified stamp, else refreshed hourly.
  { name: 'Opportunities', watermarkField: null, createField: 'createDate', watermarkCandidates: ['lastModifiedDateTime', 'lastModifiedDate', 'lastActivity'], fullEveryMinutes: 60 },
  // Assets (UPS / firewall alerts look them up by serial number): mirrored whole; incremental when possible,
  // otherwise a full refresh every 6 hours (CIs are many and change rarely).
  { name: 'ConfigurationItems', watermarkField: null, createField: 'createDate', watermarkCandidates: ['lastModifiedTime', 'lastModifiedDateTime', 'lastActivityDate'], fullEveryMinutes: 360 },
];

export const shadowEntity = (name: string): ShadowEntity | undefined =>
  SHADOW_ENTITIES.find((e) => e.name.toLowerCase() === String(name).toLowerCase());

/** Re-read this far behind the watermark: Autotask stamps can land slightly out of order. */
export const WATERMARK_OVERLAP_MS = 2 * 60_000;

/** The record's modified stamp (or creation stamp) as a Date, for the row's modified_at and the next watermark. */
export function modifiedAt(e: ShadowEntity, row: Record<string, unknown>): Date | null {
  for (const f of [e.watermarkField, e.createField]) {
    const v = f ? row[f] : null;
    if (typeof v === 'string' && v) { const d = new Date(v); if (!Number.isNaN(d.getTime())) return d; }
  }
  return null;
}
