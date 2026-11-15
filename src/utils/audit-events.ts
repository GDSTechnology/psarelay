// Normalized Autotask audit events for resource activity / daily labor
// reconciliation. Pure mappers from each evidence source into ONE shape, so
// the reports (and n8n / agents downstream) consume a single event stream.
//
// "Touched" = attributable evidence the resource ACTED (created, changed,
// noted, logged time, completed, scheduled, deleted). Being assigned is not an
// action, and nothing here infers work from assignment.

import { createHash } from 'crypto';
import { NOISE_HISTORY_ACTIONS, SYSTEM_RESOURCE_ID, parseHistoryChange } from './ticket-audit';
import { dayIn } from './staff-tools';

export type AuditAction = 'create' | 'update' | 'delete' | 'complete' | 'reopen' | 'assign' | 'note' | 'time' | 'cancel';
export type AuditEntityType =
  | 'ticket' | 'ticketNote' | 'taskNote' | 'projectNote' | 'timeEntry' | 'task' | 'project'
  | 'serviceCall' | 'todo' | 'appointment' | 'ticketCharge' | 'company' | 'contact' | 'configurationItem';
export type AuditSource = 'ticket_history' | 'record' | 'webhook' | 'row_diff' | 'delete_log';

export interface AuditEvent {
  eventId: string;
  timestamp: string;
  resourceId: number | null;
  resourceName?: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: number;
  entityReference?: string | null;
  parentEntityType?: AuditEntityType | null;
  parentEntityId?: number | null;
  parentReference?: string | null;
  companyId?: number | null;
  companyName?: string | null;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  source: AuditSource;
  systemGenerated: boolean;
  /** Source-specific extras (note type/visibility, hours, …). */
  details?: Record<string, unknown>;
}

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** A TicketHistory row → an event (null for timestamp-only noise). */
/**
 * The ledger key of a TicketHistory row. The rows of ONE save (several fields changed at once) share a TicketHistory
 * id and a timestamp (issue #210: 10 rows live, 3 kept), so the id alone keeps only the first. The key adds a short
 * hash of what the row says, built only from what the ledger stores, so migration 0026 can re-key old rows in SQL:
 * md5(historyAction | field | old | new | unparsed detail), first 12 hex characters.
 */
export function historyEventKey(historyId: unknown, e: { field?: string | null | undefined; oldValue?: string | null | undefined; newValue?: string | null | undefined; details?: Record<string, unknown> | null | undefined }): string {
  const d = e.details ?? {};
  const s = [d.historyAction, e.field, e.oldValue, e.newValue, d.detail].map((v) => (v == null ? '' : String(v))).join('|');
  return `th:${historyId}:${createHash('md5').update(s, 'utf8').digest('hex').slice(0, 12)}`;
}
/** The TicketHistory id inside a ledger key ("th:123" before migration 0026, "th:123:<hash>" after). */
export const historyIdOfKey = (key: string): number => Number(String(key).split(':')[1]);

export function historyEvent(
  row: { id: number; action?: string; date?: string; detail?: string | null; resourceID?: number | null },
  ticket: { id: number; ticketNumber?: string | null; companyID?: number | null },
  labelsFor: (field: string) => string[] = () => [],
): AuditEvent | null {
  const actionText = String(row.action ?? '');
  if (NOISE_HISTORY_ACTIONS.has(actionText)) return null;
  const ts = iso(row.date);
  if (!ts) return null;
  const detail = row.detail ? String(row.detail) : '';
  const change = detail ? parseHistoryChange(detail, labelsFor(detail.split(/ changed from /i)[0] ?? '')) : null;
  const field = change?.field ?? (actionText.replace(/ Changed$/i, '') || null);
  let action: AuditAction = 'update';
  if (/^created$/i.test(actionText)) action = 'create';
  else if (/^status$/i.test(field ?? '') && /^complete$/i.test(change?.to ?? '')) action = 'complete';
  else if (/^status$/i.test(field ?? '') && /^complete$/i.test(change?.from ?? '')) action = 'reopen';
  else if (/resource/i.test(field ?? '') && !/role/i.test(field ?? '')) action = 'assign';
  const rid = num(row.resourceID);
  const oldValue = change?.from ?? null;
  const newValue = change?.to ?? null;
  const details = { historyAction: actionText, ...(detail && !change ? { detail } : {}), ...(change?.ambiguous ? { parseAmbiguous: true } : {}) };
  return {
    eventId: historyEventKey(row.id, { field, oldValue, newValue, details }),
    timestamp: ts,
    resourceId: rid,
    action,
    entityType: 'ticket',
    entityId: ticket.id,
    entityReference: ticket.ticketNumber ?? null,
    companyId: num(ticket.companyID),
    field,
    oldValue,
    newValue,
    source: 'ticket_history',
    systemGenerated: rid === SYSTEM_RESOURCE_ID || /rule fired/i.test(actionText),
    details,
  };
}

/** A ticket / task / project note → a 'note' event on its parent. */
export function noteEvent(
  kind: 'ticketNote' | 'taskNote' | 'projectNote',
  n: Record<string, unknown>,
  parent: { type: AuditEntityType; id: number; reference?: string | null; companyId?: number | null },
  labels: { noteType?: string | null; publish?: string | null } = {},
): AuditEvent | null {
  const ts = iso(n.createDateTime);
  if (!ts) return null;
  const body = str(n.description) ?? '';
  return {
    eventId: `${kind}:${n.id}`,
    timestamp: ts,
    resourceId: num(n.creatorResourceID),
    action: 'note',
    entityType: kind,
    entityId: Number(n.id),
    parentEntityType: parent.type,
    parentEntityId: parent.id,
    parentReference: parent.reference ?? null,
    companyId: parent.companyId ?? null,
    source: 'record',
    systemGenerated: num(n.creatorResourceID) === SYSTEM_RESOURCE_ID,
    details: {
      title: str(n.title),
      noteType: labels.noteType ?? num(n.noteType),
      publish: labels.publish ?? num(n.publish),
      ...(num(n.createdByContactID) != null ? { createdByContactID: num(n.createdByContactID) } : {}),
      body: body.length > 2000 ? `${body.slice(0, 2000)}…` : body,
    },
  };
}

/**
 * A time entry → a 'time' event at its creation, with the facts an auditor
 * needs: date worked vs date entered/modified, who entered / last modified it
 * (when not the owner), and whether it was entered after the day it covers.
 */
export function timeEntryEvent(
  e: Record<string, unknown>,
  parent: { type: AuditEntityType | null; id: number | null; reference?: string | null; companyId?: number | null },
  timeZone: string,
): AuditEvent | null {
  const created = iso(e.createDateTime);
  const worked = str(e.dateWorked)?.slice(0, 10) ?? null;
  const ts = created ?? (worked ? `${worked}T12:00:00.000Z` : null);
  if (!ts) return null;
  const owner = num(e.resourceID);
  const creator = num(e.creatorUserID);
  const modifier = num(e.lastModifiedUserID);
  const enteredLocal = created ? dayIn(new Date(created), timeZone) : null;
  return {
    eventId: `te:${e.id}`,
    timestamp: ts,
    resourceId: owner,
    action: 'time',
    entityType: 'timeEntry',
    entityId: Number(e.id),
    parentEntityType: parent.type,
    parentEntityId: parent.id,
    parentReference: parent.reference ?? null,
    companyId: parent.companyId ?? null,
    source: 'record',
    systemGenerated: false,
    details: {
      dateWorked: worked,
      startDateTime: iso(e.startDateTime),
      endDateTime: iso(e.endDateTime),
      hoursWorked: num(e.hoursWorked),
      hoursToBill: num(e.hoursToBill),
      nonBillable: e.isNonBillable === true,
      roleID: num(e.roleID),
      billingCodeID: num(e.billingCodeID),
      internalBillingCodeID: num(e.internalBillingCodeID),
      contractID: num(e.contractID),
      summary: str(e.summaryNotes)?.slice(0, 300) ?? null,
      enteredAt: created,
      lastModifiedAt: iso(e.lastModifiedDateTime),
      ...(creator != null && owner != null && creator !== owner ? { enteredByResourceID: creator } : {}),
      ...(modifier != null && owner != null && modifier !== owner ? { lastModifiedByResourceID: modifier } : {}),
      approved: !!e.billingApprovalDateTime,
      enteredLate: !!(enteredLocal && worked && enteredLocal > worked),
    },
  };
}

/** Field name match ignoring case (webhook Fields vs API record keys). */
function keyIn(obj: Record<string, unknown> | null | undefined, field: string): string | undefined {
  if (!obj) return undefined;
  if (field in obj) return field;
  const lf = field.toLowerCase();
  return Object.keys(obj).find((k) => k.toLowerCase() === lf);
}

const WEBHOOK_ENTITY: Record<string, { type: AuditEntityType; shadow: string | null }> = {
  ticket: { type: 'ticket', shadow: 'Tickets' },
  ticketnote: { type: 'ticketNote', shadow: 'TicketNotes' },
  company: { type: 'company', shadow: 'Companies' },
  account: { type: 'company', shadow: 'Companies' },
  contact: { type: 'contact', shadow: 'Contacts' },
  configurationitem: { type: 'configurationItem', shadow: 'ConfigurationItems' },
  installedproduct: { type: 'configurationItem', shadow: 'ConfigurationItems' },
};
export function webhookEntity(entityType: unknown): { type: AuditEntityType; shadow: string | null } | null {
  return WEBHOOK_ENTITY[String(entityType ?? '').replace(/[^a-z]/gi, '').toLowerCase()] ?? null;
}

export interface WebhookPayload { Action?: string; Guid?: string; EntityType?: string; Id?: number; Fields?: Record<string, unknown>; EventTime?: string; SequenceNumber?: number; PersonID?: number | null }

/**
 * An Autotask webhook callout → events. The callout carries only NEW values
 * (for an update, only the changed fields); the mirrored row before the
 * change supplies the OLD values. PersonID is the resource who acted in the UI.
 */
export function webhookEvents(p: WebhookPayload, oldRow: Record<string, unknown> | null): AuditEvent[] {
  const ent = webhookEntity(p.EntityType);
  const id = num(p.Id);
  const ts = iso(p.EventTime) ?? new Date().toISOString();
  if (!ent || id == null || !p.Guid) return [];
  const fields = p.Fields ?? {};
  const pick = (f: string) => { const k = keyIn(fields, f) ?? keyIn(oldRow, f); return k ? (fields[k] ?? oldRow?.[k]) : undefined; };
  const base = {
    timestamp: ts, resourceId: num(p.PersonID), entityType: ent.type, entityId: id,
    entityReference: str(pick('ticketNumber') ?? pick('companyName') ?? null),
    companyId: num(pick('companyID') ?? (ent.type === 'company' ? id : null)),
    source: 'webhook' as const, systemGenerated: num(p.PersonID) === SYSTEM_RESOURCE_ID,
  };
  const action = String(p.Action ?? '').toLowerCase();
  if (action === 'create') return [{ ...base, eventId: `wh:${p.Guid}`, action: 'create', details: { fields } }];
  if (action === 'delete') return [{ ...base, eventId: `wh:${p.Guid}`, action: 'delete' }];
  if (action !== 'update') return [];
  const out: AuditEvent[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (/^(lastActivityDate|lastTrackedModificationDateTime|lastTrackedModifiedDateTime|lastModifiedDate|lastModifiedDateTime|lastModifiedTime)$/i.test(k)) continue;
    const ok = keyIn(oldRow, k);
    const old = ok ? oldRow![ok] : undefined;
    if (ok && JSON.stringify(old) === JSON.stringify(v)) continue;
    out.push({ ...base, eventId: `wh:${p.Guid}:${k}`, action: 'update', field: k, oldValue: old === undefined ? null : str(old), newValue: str(v) });
  }
  return out.length ? out : [{ ...base, eventId: `wh:${p.Guid}`, action: 'update' }];
}

/** A mirrored row changed between syncs: one event per watched field. The editor is unknown unless given. */
export function rowDiffEvents(
  type: AuditEntityType, id: number, oldData: Record<string, unknown>, newData: Record<string, unknown>,
  fields: string[], at: string, by: number | null = null, ctx: { reference?: string | null; companyId?: number | null } = {},
): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (const f of fields) {
    const a = oldData[f], b = newData[f];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    out.push({
      eventId: `rd:${type}:${id}:${f}:${at}`, timestamp: at, resourceId: by,
      action: f === 'canceledDateTime' && b ? 'cancel' : f === 'completedDate' && b ? 'complete' : 'update',
      entityType: type, entityId: id, entityReference: ctx.reference ?? null, companyId: ctx.companyId ?? null,
      field: f, oldValue: str(a), newValue: str(b), source: 'row_diff', systemGenerated: false,
      details: by == null ? { editor: 'unknown — Autotask does not record who changed this' } : {},
    });
  }
  return out;
}

/** Local clock HH:MM of an instant in a timezone. */
export function localClock(isoTs: string, timeZone: string): { hm: string; weekday: number } {
  const d = new Date(isoTs);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hm = `${get('hour').replace(/^24$/, '00')}:${get('minute')}`;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { hm, weekday };
}

/** Outside business hours (local), or on a weekend. Evidence only — billing policy is the caller's. */
export function isAfterHours(isoTs: string, timeZone: string, start = '08:00', end = '17:00'): boolean {
  const { hm, weekday } = localClock(isoTs, timeZone);
  return weekday === 0 || weekday === 6 || hm < start || hm >= end;
}
