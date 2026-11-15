// Autotask webhook entity catalog (#23 §16). Pure — no I/O.
//
// Autotask supports outbound webhooks on a LIMITED set of entities. Each webhook-
// capable entity has a parent `<Entity>Webhooks` record plus three child
// collections: the standard FIELDS to monitor, the USER-DEFINED fields, and the
// EXCLUDED RESOURCES — resources whose changes do NOT fire the webhook. That last
// one is the loop-prevention hook: exclude the MCP's own integration resource so
// the MCP's own writes don't trigger the webhook back into itself.
//
// This catalog maps a friendly entity name → the REST entity names, so the tools
// take `entity: "tickets"` instead of making callers memorize "TicketWebhooks".

export interface WebhookEntityMap {
  /** friendly key used by the tools */
  key: string;
  /** the business entity the webhook watches */
  targetEntity: string;
  /** parent webhook record entity */
  parent: string;
  /** child: standard fields monitored */
  fields: string;
  /** child: user-defined fields monitored */
  udfFields: string;
  /** child: resources whose changes are excluded (loop prevention) */
  excludedResources: string;
}

// The webhook-capable entities in Autotask. (Autotask exposes webhooks for this
// limited set; if a tenant surfaces more, add them here.)
export const WEBHOOK_ENTITIES: Record<string, WebhookEntityMap> = {
  tickets: { key: 'tickets', targetEntity: 'Tickets', parent: 'TicketWebhooks', fields: 'TicketWebhookFields', udfFields: 'TicketWebhookUdfFields', excludedResources: 'TicketWebhookExcludedResources' },
  companies: { key: 'companies', targetEntity: 'Companies', parent: 'CompanyWebhooks', fields: 'CompanyWebhookFields', udfFields: 'CompanyWebhookUdfFields', excludedResources: 'CompanyWebhookExcludedResources' },
  contacts: { key: 'contacts', targetEntity: 'Contacts', parent: 'ContactWebhooks', fields: 'ContactWebhookFields', udfFields: 'ContactWebhookUdfFields', excludedResources: 'ContactWebhookExcludedResources' },
  configurationItems: { key: 'configurationItems', targetEntity: 'ConfigurationItems', parent: 'ConfigurationItemWebhooks', fields: 'ConfigurationItemWebhookFields', udfFields: 'ConfigurationItemWebhookUdfFields', excludedResources: 'ConfigurationItemWebhookExcludedResources' },
  ticketNotes: { key: 'ticketNotes', targetEntity: 'TicketNotes', parent: 'TicketNoteWebhooks', fields: 'TicketNoteWebhookFields', udfFields: 'TicketNoteWebhookUdfFields', excludedResources: 'TicketNoteWebhookExcludedResources' },
};

export const WEBHOOK_ENTITY_KEYS = Object.keys(WEBHOOK_ENTITIES);

/** Resolve a friendly key (case-insensitive; a few aliases) to its entity map. */
export function resolveWebhookEntity(name: string | undefined | null): WebhookEntityMap | null {
  if (!name) return null;
  const n = String(name).trim().toLowerCase().replace(/\s+/g, '');
  const alias: Record<string, string> = {
    ticket: 'tickets', tickets: 'tickets',
    company: 'companies', companies: 'companies', account: 'companies', accounts: 'companies',
    contact: 'contacts', contacts: 'contacts',
    configurationitem: 'configurationItems', configurationitems: 'configurationItems', ci: 'configurationItems', asset: 'configurationItems', assets: 'configurationItems',
    ticketnote: 'ticketNotes', ticketnotes: 'ticketNotes',
  };
  const key = alias[n];
  return key ? WEBHOOK_ENTITIES[key] : null;
}

/** The child-collection foreign key back to the parent webhook. */
export const WEBHOOK_PARENT_FK = 'webhookID';

// NOTE: field shapes verified against the live Autotask schema 2026-09-22.
// TicketWebhooks required on create: name, webhookUrl, deactivationUrl, secretKey,
// isActive, sendThresholdExceededNotification. ownerResourceID is READ-ONLY
// (Autotask sets it to the API user), so it is NOT writable. Child WebhookFields
// use isSubscribedField (+ isDisplayAlwaysField), not isSubscribedToDisplayValueChanges.
export interface WebhookParams {
  name?: string | undefined;
  webhookUrl?: string | undefined;
  /** URL Autotask calls if it auto-deactivates the webhook — REQUIRED on create */
  deactivationUrl?: string | undefined;
  isActive?: boolean | undefined;
  subscribeCreate?: boolean | undefined;
  subscribeUpdate?: boolean | undefined;
  subscribeDelete?: boolean | undefined;
  sendThresholdExceededNotification?: boolean | undefined;
  notificationEmailAddress?: string | undefined;
  /** payload-signing secret — REQUIRED on create */
  secretKey?: string | undefined;
}

// Friendly param → Autotask field name. Kept in one place so the create/update
// mapping is testable without hitting the API. (ownerResourceID omitted — read-only.)
const FIELD_MAP: Array<[keyof WebhookParams, string]> = [
  ['name', 'name'],
  ['webhookUrl', 'webhookUrl'],
  ['deactivationUrl', 'deactivationUrl'],
  ['isActive', 'isActive'],
  ['subscribeCreate', 'isSubscribedToCreateEvents'],
  ['subscribeUpdate', 'isSubscribedToUpdateEvents'],
  ['subscribeDelete', 'isSubscribedToDeleteEvents'],
  ['sendThresholdExceededNotification', 'sendThresholdExceededNotification'],
  ['notificationEmailAddress', 'notificationEmailAddress'],
  ['secretKey', 'secretKey'],
];

/** Build the Autotask webhook payload from friendly params (only provided keys). */
export function buildWebhookPayload(p: WebhookParams): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, field] of FIELD_MAP) {
    if (p[k] !== undefined) out[field] = p[k];
  }
  return out;
}

const isHttps = (u: string) => /^https:\/\//i.test(u.trim());

/** Validate create params against the live required-field set. Empty = valid. */
export function validateWebhookCreate(p: WebhookParams): string[] {
  const errors: string[] = [];
  if (!p.name || !p.name.trim()) errors.push('name is required');
  if (!p.webhookUrl || !p.webhookUrl.trim()) errors.push('webhookUrl is required');
  else if (!isHttps(p.webhookUrl)) errors.push('webhookUrl must be an https:// URL');
  if (!p.deactivationUrl || !p.deactivationUrl.trim()) errors.push('deactivationUrl is required (Autotask calls it if the webhook is auto-deactivated)');
  else if (!isHttps(p.deactivationUrl)) errors.push('deactivationUrl must be an https:// URL');
  if (!p.secretKey || !p.secretKey.trim()) errors.push('secretKey is required (used to sign the webhook payload)');
  if (!p.subscribeCreate && !p.subscribeUpdate && !p.subscribeDelete) {
    errors.push('subscribe to at least one event (subscribeCreate / subscribeUpdate / subscribeDelete)');
  }
  return errors;
}

/** Child WebhookField row shape (verified live): isSubscribedField + isDisplayAlwaysField. */
export interface WebhookFieldSpec { fieldID: number; isSubscribedField?: boolean | undefined; isDisplayAlwaysField?: boolean | undefined }
export function buildWebhookFieldRow(webhookID: number, f: WebhookFieldSpec): Record<string, any> {
  return { [WEBHOOK_PARENT_FK]: webhookID, fieldID: f.fieldID, isSubscribedField: f.isSubscribedField ?? true, isDisplayAlwaysField: f.isDisplayAlwaysField ?? false };
}

/**
 * A user-defined field to monitor (child `<Entity>WebhookUdfFields`): by `udfFieldID`, or by the UDF's `name`,
 * resolved from that child's `udfFieldID` picklist (labels = UDF names).
 */
export interface WebhookUdfFieldSpec { udfFieldID?: number | undefined; name?: string | undefined; isSubscribedField?: boolean | undefined; isDisplayAlwaysField?: boolean | undefined }
export function buildWebhookUdfFieldRow(webhookID: number, udfFieldID: number, f: WebhookUdfFieldSpec): Record<string, any> {
  return { [WEBHOOK_PARENT_FK]: webhookID, udfFieldID, isSubscribedField: f.isSubscribedField ?? true, isDisplayAlwaysField: f.isDisplayAlwaysField ?? false };
}

export interface ResolvedUdfField { udfFieldID: number; name?: string; spec: WebhookUdfFieldSpec }
/**
 * Resolve UDF specs to ids. `choices` is the udfFieldID picklist (null when it could not be read). A name matches a
 * label exactly, ignoring case. Errors say what is wrong; nothing is guessed. Duplicates are dropped.
 */
export function resolveWebhookUdfFields(specs: WebhookUdfFieldSpec[], choices: Array<{ value: string; label: string }> | null): { rows: ResolvedUdfField[]; errors: string[] } {
  const rows: ResolvedUdfField[] = [];
  const errors: string[] = [];
  for (const s of specs) {
    if (s.udfFieldID != null) {
      if (!Number.isInteger(s.udfFieldID) || s.udfFieldID <= 0) { errors.push(`udfFields: udfFieldID ${s.udfFieldID} is not a positive integer`); continue; }
      const label = choices?.find((c) => Number(c.value) === s.udfFieldID)?.label;
      rows.push({ udfFieldID: s.udfFieldID, ...(label ? { name: label } : {}), spec: s });
      continue;
    }
    const name = String(s.name ?? '').trim();
    if (!name) { errors.push('udfFields: each entry needs udfFieldID or name'); continue; }
    if (!choices) { errors.push(`udfFields: the UDF list could not be read, so "${name}" can't be looked up; pass its udfFieldID`); continue; }
    const hit = choices.filter((c) => c.label.trim().toLowerCase() === name.toLowerCase());
    if (hit.length !== 1) {
      const names = choices.map((c) => c.label).slice(0, 40).join(', ');
      errors.push(hit.length ? `udfFields: "${name}" matches ${hit.length} UDFs; pass its udfFieldID` : `udfFields: no UDF named "${name}". Available: ${names || '(none)'}`);
      continue;
    }
    rows.push({ udfFieldID: Number(hit[0]!.value), name: hit[0]!.label, spec: s });
  }
  const seen = new Set<number>();
  return { rows: rows.filter((r) => (seen.has(r.udfFieldID) ? false : (seen.add(r.udfFieldID), true))), errors };
}
