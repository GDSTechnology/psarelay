// Autotask Service Layer
// Talks to the Autotask REST API via AutotaskHttpClient (native fetch).
//
// This file used to wrap the autotask-node SDK. The SDK gets multiple URL
// shapes wrong (PATCH /{Entity}/{id} → 405, several GETs → 404, list()
// silently drops filters), so we now bypass it entirely. Zero new runtime
// deps — only Node 18+ built-in `fetch` via AutotaskHttpClient.

import { resolveAutotaskApiUrl, resolveAutotaskWebUrl } from '../utils/config';
import { AutotaskHttpClient, QueryFilter } from './autotask-http';
import { usageSnapshot, ApiUsageSnapshot } from './http-cache';
import { classifyActor, parseRegistry, parseReference, type ActorRecord, type ClassifyContext } from '../utils/actor-classify.js';
import { settingValue, tenantCompanyDefaults } from '../admin/settings.js';
import { noteTenantUsage } from './call-log.js';
import {
  classifyReferenceMatches,
  ReferenceCandidate,
  RecordReferenceResult,
} from '../utils/reference.resolver';
import { checkProtectedCompanyMutation, isUnsafeCompanyName } from '../utils/company-guard';
import { resolveActionType } from '../utils/company-todo';
import { buildContactSearchFilter, normalizeContactNote } from '../utils/contact';
import { resolveCompanyOwnerResourceID } from '../utils/company-owner';
import { computeBlockHourUsage } from '../utils/block-hours';
import { computeRecurringRevenue, RecurringRevenue, RecurringLine } from '../utils/recurring-revenue';
import {
  computeReorder, computeCloseouts, computeStaleStock, classifyStaleLines, StaleBucket,
  InvProductRow, ProductRow, LocationRow, OpenChargeRow, StockedItemRow,
} from '../utils/inventory-reports';
import { summarizeTicketCharges, ChargeRow } from '../utils/charge-report';
import { summarizeUnbilled, UnbilledItem } from '../utils/unbilled-report';
import { buildProjectHierarchy } from '../utils/project-structure';
import { summarizeProjectLabor } from '../utils/project-labor';
import { toProjectBlueprint } from '../utils/project-blueprint';
import { WritePlan, WritePlanResult } from '../utils/write-plan';
import { ProjectBuildPlan, validateBuildPlan } from '../utils/project-plan';
import { planProjectBuild, buildMarker, hasBuildMarker } from '../utils/project-build';
import { reconcileServiceCall as reconcileServiceCallPure, SCReconResult } from '../utils/service-call-reconciliation';
import { analyzeTicketBillingGaps as analyzeTicketBillingGapsPure, TBGResult, TBGTimeEntry, COMPLETE_TICKET_STATUS } from '../utils/ticket-billing-gaps';
import {
  buildCategoryTree, findCatalogGaps, findDuplicateProducts, matchProducts,
  planBulkProductUpdate, planProductMerge,
  CatalogGapsResult, ProductLite, SearchableProduct,
} from '../utils/catalog-hygiene';
import { computeProjectPL, ProjectPLResult } from '../utils/project-pl';
import { computeSlaCompliance, SlaComplianceResult } from '../utils/sla-compliance';
import {
  classifyContractSlaCoverage, planContractSlaAssignment, activeStatusValues,
  SlaCoverageResult, PicklistOption, AssignInput, ContractLite,
} from '../utils/contract-sla';
import { computeTimeEntryCompliance, TimeEntryComplianceResult } from '../utils/time-entry-compliance';
import { groupNotificationSends, emailDomain, NotificationRow, NotificationSend } from '../utils/notification-history';
import { resolveWebhookSecret, secretErrors, secretWarnings, maskSecret, buildExclusions, SecretSource, WEBHOOK_SECRET_ENV } from '../utils/webhook-safety';
import { computeActivityWithoutTime, AwtNote, AwtCompletion, AwtEmail, AwtTimeEntry, AwtTicket, AwtResourceResult, GapConfidence } from '../utils/activity-without-time';
import { computeTicketsNeedingScheduling, TicketsNeedingSchedulingResult, ServiceCallLite } from '../utils/tickets-needing-scheduling';
import { computeTicketThroughput, TicketThroughputResult } from '../utils/ticket-throughput';
import { resolveWebhookEntity, WEBHOOK_ENTITIES, WEBHOOK_PARENT_FK, buildWebhookPayload, validateWebhookCreate, buildWebhookFieldRow, WebhookParams, WebhookFieldSpec } from '../utils/webhook-entities';
import { computeRequestSegmentation, RequestSegmentationResult, SegmentRule } from '../utils/request-segmentation';
import { defaultTimeZone, normalizeTimestamp, validTimeZone } from '../utils/timezone';
import {
  actorKind, HISTORY_FIELD_PICKLIST, isEmailSource, labelUdfs, NOISE_HISTORY_ACTIONS, normalizeTicketNumber,
  parseHistoryChange, picklistLabels, SYSTEM_RESOURCE_ID, TICKET_CONTACT_FIELDS, TICKET_RESOURCE_FIELDS,
  AttachmentRow, ContactRow, contactName, HistoryRow,
} from '../utils/ticket-audit';
import { parseAddress, parseAddressList, parseRfc822 } from '../utils/rfc822';
import {
  clusters, companyClusterKeys, CompanyCriteria, companyEvidence, CompanyRow, companySearchToken, Conflict, contactClusterKeys,
  ContactCriteria, contactEmails, contactEvidence, ContactRow as ContactRowFull, domainOf, Evidence, fullName, isFreeMailDomain,
  normalizePhone, score, splitPersonName, verdict,
} from '../utils/identity-match';
import { windowsToIana } from '../utils/windows-timezones';
import { TimeEntryLockState, lockReason } from '../utils/timesheet-lock';
import { RoleChoice, RoleSource } from '../utils/time-entry-role';
import { classifyTimeEntryWriteError } from '../utils/time-entry-errors';
import { ContractRow, EntryRow, EntryScope, planContractMove, TicketContractRow } from '../utils/ticket-contract';
import { shadowRead } from '../db/shadow-runtime';
import { withCompanyDefaults } from '../utils/company-defaults';
import { runWithRequestContext, getRequestOrigin } from '../utils/request-context';
import { applyBillingTreatment, BillingTreatment } from '../utils/billing-treatment';
import { summarizeUnbilledTime, UnbilledTimeEntry, UnbilledTimeSummary } from '../utils/unbilled-time';
import { classifyContractLabourBilling, LabourBasis } from '../utils/contract-labour';
import {
  AutotaskCompany,
  AutotaskContact,
  AutotaskTicket,
  AutotaskTimeEntry,
  AutotaskProject,
  AutotaskResource,
  AutotaskConfigurationItem,
  AutotaskContract,
  AutotaskInvoice,
  AutotaskTask,
  AutotaskQueryOptions,
  PagedResult,
  AutotaskTicketNote,
  AutotaskProjectNote,
  AutotaskCompanyNote,
  AutotaskTicketAttachment,
  AutotaskProjectAttachment,
  AutotaskTaskAttachment,
  AutotaskAttachmentCreateRequest,
  AutotaskTicketChecklistItem,
  AutotaskTicketAttachmentCreateRequest,
  AutotaskExpenseReport,
  AutotaskExpenseItem,
  AutotaskQuote,
  AutotaskQuoteItem,
  AutotaskOpportunity,
  AutotaskProduct,
  AutotaskServiceEntity,
  AutotaskServiceBundle,
  AutotaskCompanyToDo,
  AutotaskCompanyLocation,
  AutotaskBillingCode,
  AutotaskDepartment,
  AutotaskQueryOptionsExtended,
  AutotaskBillingItem,
  AutotaskBillingItemApprovalLevel,
  AutotaskTicketCharge,
  AutotaskTicketHistory,
  AutotaskServiceCall,
  AutotaskServiceCallTicket,
  AutotaskServiceCallTicketResource,
  AutotaskServiceCallTask,
  AutotaskServiceCallTaskResource,
  AutotaskPhase
} from '../types/autotask';
import { McpServerConfig } from '../types/mcp';
import { Logger } from '../utils/logger';
import { getShadowRuntime } from '../db/shadow-runtime.js';
import { historyEvent } from '../utils/audit-events.js';
import { FieldInfo, PicklistValue } from './picklist.cache';
import {
  findDuplicateNote, formatChoices, hoursBetween, HUMAN_NOTE_TYPE_LABEL, matchPicklist, MyServiceCall,
  NoteVisibility, PicklistChoice, PUBLISH_LABELS, ServiceCallRow, serviceCallTimeGaps, StartWorkResult,
  TODO_WINDOW_DAYS, addDays, dayIn, localDayWindow,
} from '../utils/staff-tools';

/**
 * Default "match all" filter required by Autotask for unconstrained queries.
 */
export const MATCH_ALL: QueryFilter[] = [{ op: 'gte', field: 'id', value: 0 }];

/**
 * Push an `eq` filter only when `value` is not `undefined`. Replaces the
 * `if (options.X !== undefined) filters.push({ op: 'eq', field: 'X', value: options.X })`
 * pattern that was previously duplicated across every search method.
 */
function pushEq(filters: QueryFilter[], field: string, value: unknown): void {
  if (value !== undefined) {
    filters.push({ op: 'eq', field, value });
  }
}

/**
 * Merge the `options.filter` escape hatch (array of QueryFilter or a flat
 * `field → value` object) into the in-progress filters list. Previously
 * inlined as a 7-line block in every search method.
 */
function mergeFilterEscapeHatch(
  filters: QueryFilter[],
  raw: QueryFilter[] | Record<string, unknown> | undefined,
): void {
  if (!raw) return;
  if (Array.isArray(raw)) {
    if (raw.length > 0) filters.push(...raw);
    return;
  }
  for (const [field, value] of Object.entries(raw)) {
    filters.push({ op: 'eq', field, value });
  }
}

export class AutotaskService {
  private http: AutotaskHttpClient | null = null;
  private logger: Logger;
  private config: McpServerConfig;
  private initializationPromise: Promise<void> | null = null;

  constructor(config: McpServerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Swap the Autotask credentials (entered and verified in the console). The next call builds a fresh client;
   * calls already running finish on the old one.
   */
  reconfigure(c: { username: string; secret: string; integrationCode: string; apiUrl?: string | undefined }): void {
    const autotask: McpServerConfig['autotask'] = { username: c.username, secret: c.secret, integrationCode: c.integrationCode };
    if (c.apiUrl) autotask.apiUrl = c.apiUrl;
    this.config = { ...this.config, autotask };
    this.http = null;
    this.initializationPromise = null;
  }

  /**
   * Stable identity of the tenant these credentials belong to (lowercased
   * API username), used to key per-tenant caches that outlive a single
   * request. Null when credentials aren't configured.
   */
  getTenantKey(): string | null {
    const username = this.config.autotask.username;
    return username ? username.toLowerCase() : null;
  }

  /**
   * Initialize the Autotask HTTP client with credentials.
   *
   * We only validate credentials here — the zone-resolved URL is fetched
   * lazily inside AutotaskHttpClient on the first actual request, so the
   * server starts cleanly even if the zone info endpoint is unreachable.
   */
  async initialize(): Promise<void> {
    try {
      const { username, secret, integrationCode, apiUrl } = this.config.autotask;

      if (!username || !secret || !integrationCode) {
        throw new Error('Missing required Autotask credentials: username, secret, and integrationCode are required');
      }

      this.logger.info('Initializing Autotask HTTP client...');
      this.http = new AutotaskHttpClient(username, secret, integrationCode, apiUrl, this.logger);
      this.logger.info('Autotask HTTP client initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Autotask HTTP client:', error);
      throw error;
    }
  }

  /**
   * Ensure HTTP client is initialized (with lazy initialization).
   */
  private async ensureClient(): Promise<AutotaskHttpClient> {
    if (!this.http) {
      await this.ensureInitialized();
    }
    return this.http!;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }
    if (this.http) return;
    this.initializationPromise = this.initialize();
    await this.initializationPromise;
  }

  // =====================================================
  // Companies (Autotask entity: Companies)
  // =====================================================

  // ---- Identity (read-only): full company/contact records, bounded identity
  // search with evidence, candidate resolution, duplicates around a record.
  // NEVER creates or updates anything. Queries are sequential and capped.

  private static readonly IDENTITY_CAP = 200;
  private static readonly COMPANY_ID_FIELDS = ['id', 'companyName', 'webAddress', 'phone', 'alternatePhone1', 'alternatePhone2', 'fax', 'isActive', 'companyType', 'companyNumber', 'ownerResourceID', 'createDate', 'createdByResourceID', 'parentCompanyID'];
  private static readonly CONTACT_ID_FIELDS = ['id', 'firstName', 'lastName', 'emailAddress', 'emailAddress2', 'emailAddress3', 'phone', 'mobilePhone', 'alternatePhone', 'companyID', 'isActive', 'createDate', 'title'];

  /** A full record by id with picklists labelled, referenced resources/companies named, and UDFs labelled. */
  private async getRecordFull(entity: 'Companies' | 'Contacts', id: number, resourceFields: string[], companyFields: string[]): Promise<Record<string, unknown> | null> {
    const http = await this.ensureClient();
    const raw = await http.get<Record<string, unknown>>(entity, id);
    if (!raw) return null;
    const { userDefinedFields, ...record } = raw;
    const errors: Array<{ section: string; error: string }> = [];
    const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try { return await fn(); } catch (e) { errors.push({ section: name, error: e instanceof Error ? e.message : String(e) }); return undefined; }
    };
    const labels = (await section('labels', async () => picklistLabels(record, await this.getFieldInfo(entity)))) ?? {};
    const names: Record<string, Record<string, unknown>> = {};
    const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
    const rids = resourceFields.map((f) => num(record[f])).filter((x): x is number => x != null);
    if (rids.length) {
      const m = await section('resources', () => this.getResourceNames(rids));
      for (const f of resourceFields) { const r = num(record[f]); if (r != null) names[f] = { id: r, name: m?.get(r) ?? (r === SYSTEM_RESOURCE_ID ? 'Autotask Administrator (system)' : null) }; }
    }
    const cids = companyFields.map((f) => num(record[f])).filter((x): x is number => x != null);
    if (cids.length) {
      const rows = await section('companies', () => this.getCompanyNamesByIds(cids));
      for (const f of companyFields) { const c = num(record[f]); if (c != null) names[f] = { id: c, name: rows?.find((x) => x.id === c)?.companyName ?? null }; }
    }
    const udfs = await section('udfs', async () => labelUdfs(userDefinedFields, (await http.udfInfo(entity)).fields));
    return { [entity === 'Companies' ? 'company' : 'contact']: record, labels, names, udfs: udfs ?? [], ...(errors.length ? { errors } : {}) };
  }

  /** Full company record (read-only): labels, owner/creator/parent named, UDFs. */
  async getCompanyFull(id: number): Promise<Record<string, unknown> | null> {
    return this.getRecordFull('Companies', id, ['ownerResourceID', 'createdByResourceID', 'impersonatorCreatorResourceID'], ['parentCompanyID']);
  }

  /** Full contact record (read-only): labels, company named, UDFs. */
  async getContactFull(id: number): Promise<Record<string, unknown> | null> {
    return this.getRecordFull('Contacts', id, ['impersonatorCreatorResourceID'], ['companyID']);
  }

  /**
   * Companies matching ANY of: normalized name (bounded `contains` on its most
   * distinctive word, compared normalized), web domain, contacts' email
   * domain (skipped for consumer domains like gmail.com), phone (last-4
   * `contains`, compared on normalized digits), companyNumber. Every row with
   * evidence is returned, ranked — never one silently picked. Inactive
   * companies are INCLUDED unless isActive is given.
   */
  async findCompanies(q: CompanyCriteria & { companyType?: number; isActive?: boolean; excludeIDs?: number[] }): Promise<Record<string, unknown>> {
    const http = await this.ensureClient();
    const cap = AutotaskService.IDENTITY_CAP;
    const scope: QueryFilter[] = [
      ...(q.companyType != null ? [{ op: 'eq', field: 'companyType', value: q.companyType } as QueryFilter] : []),
      ...(q.isActive != null ? [{ op: 'eq', field: 'isActive', value: q.isActive } as QueryFilter] : []),
    ];
    const rows = new Map<number, CompanyRow>();
    const extra = new Map<number, Evidence[]>();
    const queries: string[] = [];
    const add = (rs: CompanyRow[]) => { for (const r of rs) rows.set(Number(r.id), r); };
    const fetch = (filter: QueryFilter[]) => http.query<CompanyRow>('Companies', [...filter, ...scope], { maxRecords: cap, includeFields: AutotaskService.COMPANY_ID_FIELDS });

    if (q.name) {
      const token = companySearchToken(q.name);
      add(await fetch([token ? { op: 'contains', field: 'companyName', value: token } : { op: 'eq', field: 'companyName', value: q.name.trim() }]));
      queries.push(`name ${token ? `contains "${token}"` : 'eq'}`);
    }
    const domain = domainOf(q.domain);
    const freeMail = isFreeMailDomain(domain);
    if (domain && !freeMail) {
      add(await fetch([{ op: 'contains', field: 'webAddress', value: domain }]));
      const viaContacts = await http.query<{ id: number; companyID?: number }>('Contacts', [{ op: 'endsWith', field: 'emailAddress', value: `@${domain}` }], { maxRecords: cap, includeFields: ['id', 'companyID'] });
      const counts = new Map<number, number>();
      for (const c of viaContacts) if (c.companyID != null) counts.set(Number(c.companyID), (counts.get(Number(c.companyID)) ?? 0) + 1);
      const ids = [...counts.keys()];
      for (let i = 0; i < ids.length; i += cap) add(await fetch([{ op: 'in', field: 'id', value: ids.slice(i, i + cap) }]));
      for (const [cid, n] of counts) extra.set(cid, [...(extra.get(cid) ?? []), { kind: 'contact_email_domain', strength: 'medium', detail: `${n} contact(s) with @${domain} email` }]);
      queries.push(`webAddress contains "${domain}"`, `contacts email endsWith "@${domain}"`);
    }
    const phone = normalizePhone(q.phone);
    if (phone) {
      add(await fetch([{ op: 'or', items: ['phone', 'alternatePhone1', 'alternatePhone2'].map((f) => ({ op: 'contains', field: f, value: phone.slice(-4) })) }]));
      queries.push(`phone contains "…${phone.slice(-4)}"`);
    }
    if (q.companyNumber) { add(await fetch([{ op: 'eq', field: 'companyNumber', value: q.companyNumber.trim() }])); queries.push('companyNumber eq'); }

    const exclude = new Set(q.excludeIDs ?? []);
    const scored = [...rows.values()].filter((r) => !exclude.has(Number(r.id))).map((r) => {
      const { evidence, conflicts } = companyEvidence(r, q, extra.get(Number(r.id)));
      return { row: r, evidence, conflicts, score: score(evidence) };
    }).filter((x) => x.evidence.length)
      .sort((a, b) => b.score - a.score || String(b.row.createDate ?? '').localeCompare(String(a.row.createDate ?? '')));

    let typeLabels: PicklistValue[] = [];
    try { typeLabels = await this.getPicklistValues('Companies', 'companyType'); } catch { /* ids only */ }
    let owners = new Map<number, string>();
    try { owners = await this.getResourceNames(scored.flatMap((x) => [x.row.ownerResourceID, x.row.createdByResourceID]).filter((v) => v != null)); } catch { /* ids only */ }
    const candidates = scored.map(({ row: r, evidence, conflicts, score: s }) => ({
      id: Number(r.id), companyName: r.companyName ?? null, webAddress: r.webAddress ?? null, phone: r.phone ?? null,
      companyType: { value: r.companyType ?? null, label: typeLabels.find((t) => String(t.value) === String(r.companyType))?.label ?? null },
      companyNumber: r.companyNumber ?? null, isActive: r.isActive ?? null, parentCompanyID: r.parentCompanyID ?? null,
      owner: { id: r.ownerResourceID ?? null, name: r.ownerResourceID != null ? owners.get(Number(r.ownerResourceID)) ?? null : null },
      createDate: r.createDate ?? null, createdBy: { id: r.createdByResourceID ?? null, name: r.createdByResourceID != null ? owners.get(Number(r.createdByResourceID)) ?? null : null },
      score: s, evidence, conflicts,
    }));
    return {
      candidates,
      clusters: clusters(scored.map((x) => x.row), companyClusterKeys),
      ...(domain ? { domain: { value: domain, freeMail, ...(freeMail ? { note: `${domain} is a consumer mailbox provider — not used to match companies` } : {}) } } : {}),
      queries, truncatedAt: [...rows.values()].length >= cap ? cap : null,
    };
  }

  /**
   * Contacts matching ANY of: exact email (primary/2nd/3rd — EVERY duplicate
   * returned), name (last name eq + first-initial, compared normalized),
   * phone (phone/mobile/alternate, normalized), or all contacts of companyID.
   * Inactive contacts are INCLUDED unless isActive is given.
   */
  async findContacts(q: ContactCriteria & { companyID?: number; isActive?: boolean; excludeIDs?: number[] }): Promise<Record<string, unknown>> {
    const http = await this.ensureClient();
    const cap = AutotaskService.IDENTITY_CAP;
    const scope: QueryFilter[] = [
      ...(q.companyID != null ? [{ op: 'eq', field: 'companyID', value: q.companyID } as QueryFilter] : []),
      ...(q.isActive != null ? [{ op: 'eq', field: 'isActive', value: q.isActive ? 1 : 0 } as QueryFilter] : []),
    ];
    const rows = new Map<number, ContactRowFull>();
    const queries: string[] = [];
    const fetch = async (filter: QueryFilter[]) => { for (const r of await http.query<ContactRowFull>('Contacts', [...filter, ...scope], { maxRecords: cap, includeFields: AutotaskService.CONTACT_ID_FIELDS })) rows.set(Number(r.id), r); };

    const email = String(q.email ?? '').trim().toLowerCase();
    if (email) { await fetch([{ op: 'or', items: ['emailAddress', 'emailAddress2', 'emailAddress3'].map((f) => ({ op: 'eq', field: f, value: email })) }]); queries.push('email eq (all 3 email fields)'); }
    const name = q.name ? splitPersonName(q.name) : null;
    if (name) { await fetch([{ op: 'eq', field: 'lastName', value: name.last }, { op: 'beginsWith', field: 'firstName', value: name.first.slice(0, 1) }]); queries.push(`lastName eq "${name.last}" + firstName beginsWith "${name.first.slice(0, 1)}"`); }
    const phone = normalizePhone(q.phone);
    if (phone) { await fetch([{ op: 'or', items: ['phone', 'mobilePhone', 'alternatePhone'].map((f) => ({ op: 'contains', field: f, value: phone.slice(-4) })) }]); queries.push(`phone contains "…${phone.slice(-4)}"`); }
    if (!email && !name && !phone && q.companyID != null) { await fetch([]); queries.push(`all contacts of company ${q.companyID}`); }

    const exclude = new Set(q.excludeIDs ?? []);
    const companyOnly = !email && !name && !phone;
    const scored = [...rows.values()].filter((r) => !exclude.has(Number(r.id))).map((r) => {
      const { evidence, conflicts } = contactEvidence(r, q);
      return { row: r, evidence, conflicts, score: score(evidence) };
    }).filter((x) => companyOnly || x.evidence.length)
      .sort((a, b) => b.score - a.score || String(b.row.createDate ?? '').localeCompare(String(a.row.createDate ?? '')));
    let companyNames: Array<{ id: number; companyName: string }> = [];
    try { companyNames = await this.getCompanyNamesByIds(scored.map((x) => Number(x.row.companyID)).filter((n) => Number.isFinite(n))); } catch { /* ids only */ }
    const candidates = scored.map(({ row: r, evidence, conflicts, score: s }) => ({
      id: Number(r.id), name: fullName(r), firstName: r.firstName ?? null, lastName: r.lastName ?? null, title: r.title ?? null,
      emails: contactEmails(r), phones: { phone: r.phone ?? null, mobilePhone: r.mobilePhone ?? null, alternatePhone: r.alternatePhone ?? null },
      company: { id: r.companyID ?? null, name: companyNames.find((c) => c.id === Number(r.companyID))?.companyName ?? null },
      isActive: r.isActive === true || r.isActive === 1, createDate: r.createDate ?? null,
      score: s, evidence, conflicts,
    }));
    return { candidates, clusters: clusters(scored.map((x) => x.row), contactClusterKeys), queries, truncatedAt: rows.size >= cap ? cap : null };
  }

  /**
   * "Which company and contact is this?" — read-only. Runs the bounded contact
   * and company searches, links them (a contact's company becomes a company
   * candidate; a contact inside a candidate company gains evidence), and
   * returns ranked candidates with evidence, conflicts, duplicate clusters and
   * a verdict (matched / ambiguous / unmatched) for each side. NEVER creates.
   */
  async findCompanyContactCandidates(input: { companyName?: string; contactName?: string; email?: string; phone?: string; domain?: string }): Promise<Record<string, unknown>> {
    const emailDomain = domainOf(input.email);
    const companyDomain = domainOf(input.domain) ?? (isFreeMailDomain(emailDomain) ? null : emailDomain);
    const notes: string[] = [];
    if (emailDomain && isFreeMailDomain(emailDomain)) notes.push(`${emailDomain} is a consumer mailbox — the email identifies the PERSON, not the company; company matching uses name/phone only.`);

    const contactQ: ContactCriteria = { email: input.email, name: input.contactName, phone: input.phone };
    const firstPass = await this.findContacts(contactQ) as { candidates: Array<{ id: number; company: { id: number | null }; evidence: Evidence[] }> };
    const companies = await this.findCompanies({ name: input.companyName, domain: companyDomain ?? undefined, phone: input.phone }) as { candidates: Array<{ id: number; evidence: Evidence[]; conflicts: Conflict[]; score: number }>; clusters: unknown[]; queries: string[] };

    // Companies reached only through a matched contact: add them with that link as evidence.
    const linked = new Map<number, Evidence>();
    for (const c of firstPass.candidates) {
      if (c.company.id == null) continue;
      const strong = c.evidence.some((e) => e.kind === 'email_exact');
      const prev = linked.get(c.company.id);
      if (!prev || (strong && prev.strength !== 'strong')) linked.set(c.company.id, { kind: 'linked_contact', strength: strong ? 'strong' : 'weak', detail: `contact ${c.id} (${c.evidence.map((e) => e.kind).join('+')}) belongs to it` });
    }
    for (const cand of companies.candidates) { const ev = linked.get(cand.id); if (ev) { cand.evidence.push(ev); cand.score = score(cand.evidence); linked.delete(cand.id); } }
    if (linked.size) {
      const extraRows = await this.getCompanyNamesByIds([...linked.keys()]);
      for (const [cid, ev] of linked) companies.candidates.push({ id: cid, companyName: extraRows.find((r) => r.id === cid)?.companyName ?? null, evidence: [ev], conflicts: input.companyName ? [{ field: 'companyName', detail: `does not match "${input.companyName}"` }] : [], score: score([ev]) } as never);
    }
    companies.candidates.sort((a, b) => b.score - a.score);

    // Second look at contacts, now knowing the candidate companies.
    const companyIDs = companies.candidates.map((c) => c.id);
    const contacts = (companyIDs.length ? await this.findContacts({ ...contactQ, companyIDs }) : firstPass) as { candidates: Array<{ evidence: Evidence[]; conflicts: Conflict[] }>; clusters: unknown[]; queries: string[] };

    return {
      readOnly: true,
      input,
      emailDomain: emailDomain ? { value: emailDomain, freeMail: isFreeMailDomain(emailDomain) } : null,
      contact: { ...verdict(contacts.candidates), candidates: contacts.candidates, duplicateClusters: contacts.clusters },
      company: { ...verdict(companies.candidates), candidates: companies.candidates, duplicateClusters: companies.clusters },
      notes,
    };
  }

  /** Likely duplicates of one company (name / web domain / phone / companyNumber), inactive included. */
  async findDuplicateCompanies(companyID: number): Promise<Record<string, unknown>> {
    const http = await this.ensureClient();
    const c = await http.get<CompanyRow>('Companies', companyID);
    if (!c) return { companyID, status: 'not_found' };
    const r = await this.findCompanies({ name: c.companyName, domain: c.webAddress ?? undefined, phone: c.phone ?? undefined, companyNumber: c.companyNumber ?? undefined, excludeIDs: [companyID] });
    return { subject: { id: companyID, companyName: c.companyName ?? null, webAddress: c.webAddress ?? null, phone: c.phone ?? null, isActive: c.isActive ?? null, createDate: c.createDate ?? null }, ...r };
  }

  /** Likely duplicates of one contact (any of its emails / name / phones), across ALL companies, inactive included. */
  async findDuplicateContacts(contactID: number): Promise<Record<string, unknown>> {
    const http = await this.ensureClient();
    const c = await http.get<ContactRowFull>('Contacts', contactID);
    if (!c) return { contactID, status: 'not_found' };
    const emails = contactEmails(c);
    const merged = new Map<number, Record<string, unknown>>();
    const queries: string[] = [];
    // One pass per email (a duplicate may share only a secondary address), plus name + phone once.
    const passes: ContactCriteria[] = emails.length ? emails.map((e, i) => ({ email: e, ...(i === 0 ? { name: fullName(c), phone: c.phone ?? c.mobilePhone ?? undefined } : {}) })) : [{ name: fullName(c), phone: c.phone ?? c.mobilePhone ?? undefined }];
    for (const p of passes) {
      const r = await this.findContacts({ ...p, excludeIDs: [contactID] }) as { candidates: Array<{ id: number; score: number }>; queries: string[] };
      queries.push(...r.queries);
      for (const cand of r.candidates) { const prev = merged.get(cand.id) as { score: number } | undefined; if (!prev || cand.score > prev.score) merged.set(cand.id, cand); }
    }
    const candidates = [...merged.values()].sort((a, b) => Number(b.score) - Number(a.score));
    return { subject: { id: contactID, name: fullName(c), emails, companyID: c.companyID ?? null, isActive: c.isActive ?? null, createDate: c.createDate ?? null }, candidates, queries };
  }

  async getCompany(id: number): Promise<AutotaskCompany | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting company with ID: ${id}`);
      return await http.get<AutotaskCompany>('Companies', id);
    } catch (error) {
      this.logger.error(`Failed to get company ${id}:`, error);
      throw error;
    }
  }

  /**
   * Fetch one offset-style page on top of Autotask's cursor-only pagination.
   *
   * Autotask's REST API paginates by following `pageDetails.nextPageUrl`; there
   * is no offset/skip parameter. To honor a caller's `page` we therefore fetch
   * up to `page * pageSize` records and slice out the requested window. That is
   * wasteful at high page numbers, but it is the only way to give offset-style
   * semantics on top of a cursor API.
   *
   * One extra record beyond the window is requested so `hasMore` reflects
   * whether another page actually exists, rather than the
   * `items.length >= pageSize` guess that reports a full final page as "more".
   */
  private async paginate<T>(
    label: string,
    fetch: (limit: number) => Promise<T[]>,
    options: AutotaskQueryOptions,
    limits: { defaultPageSize?: number; maxPageSize: number }
  ): Promise<PagedResult<T>> {
    const page = Math.max(1, options.page || 1);
    const pageSize = Math.min(options.pageSize || limits.defaultPageSize || 25, limits.maxPageSize);
    const targetEnd = page * pageSize;

    const fetched = await fetch(targetEnd + 1);
    const items = fetched.slice((page - 1) * pageSize, targetEnd);
    const hasMore = fetched.length > targetEnd;

    this.logger.info(
      `Retrieved ${items.length} ${label} (page ${page}, pageSize ${pageSize}, hasMore ${hasMore})`
    );
    return { items, page, pageSize, hasMore };
  }

  /** `paginate` over a top-level `POST /{Entity}/query`. */
  private async queryPaged<T>(
    entity: string,
    filters: QueryFilter[],
    options: AutotaskQueryOptions,
    limits: { defaultPageSize?: number; maxPageSize: number }
  ): Promise<PagedResult<T>> {
    const http = await this.ensureClient();
    // Served from the Postgres shadow when it mirrors this entity, is fresh,
    // and MCP_PG_SHADOW_SERVE_READS is on — 0 Autotask calls. Anything the
    // shadow can't answer (not ready, stale, unsupported filter) goes live.
    let servedFrom: { source: 'shadow'; ageSeconds: number } | undefined;
    const r = await this.paginate<T>(
      entity,
      async (limit) => {
        const s = await shadowRead<T>(entity, filters, limit);
        if (s) { servedFrom = { source: 'shadow', ageSeconds: s.ageSeconds }; return s.rows; }
        return http.query<T>(entity, filters.length > 0 ? filters : MATCH_ALL, { maxRecords: limit });
      },
      options,
      limits
    );
    return servedFrom ? { ...r, servedFrom } : r;
  }

  /** The raw Autotask HTTP client (the Postgres shadow sync reads through it). */
  async httpClient(): Promise<AutotaskHttpClient> {
    return this.ensureClient();
  }

  async searchCompanies(options: AutotaskQueryOptions & { classification?: number; companyType?: number } = {}): Promise<PagedResult<AutotaskCompany>> {
    try {
      this.logger.debug('Searching companies with options:', options);

      const filters: QueryFilter[] = [];
      if (options.searchTerm) {
        filters.push({ op: 'contains', field: 'companyName', value: options.searchTerm });
      }
      if (options.isActive !== undefined) {
        filters.push({ op: 'eq', field: 'isActive', value: options.isActive });
      }
      // Picklist ids, resolved by the caller (0 is never a valid picklist value, but check != null anyway).
      if (options.classification != null) filters.push({ op: 'eq', field: 'classification', value: options.classification });
      if (options.companyType != null) filters.push({ op: 'eq', field: 'companyType', value: options.companyType });

      return await this.queryPaged<AutotaskCompany>('Companies', filters, options, { maxPageSize: 200 });
    } catch (error) {
      this.logger.error('Failed to search companies:', error);
      throw error;
    }
  }

  /**
   * Bulk-load every company in the tenant, intended for cache pre-warm paths
   * like `MappingService.refreshCompanyCache`. Distinct from `searchCompanies`
   * because: (a) we don't want a small default pageSize, (b) we don't want any
   * filtering, (c) we don't want offset-style slicing. `http.query` walks
   * `pageDetails.nextPageUrl` transparently until either all records are
   * fetched or `maxRecords` is hit.
   *
   * The hard cap of 20_000 is a tenant-size safety net — anything beyond that
   * suggests the cache pre-warm is the wrong tool. Logs a warning if hit.
   */
  async listAllCompanies(maxRecords: number = 20_000): Promise<AutotaskCompany[]> {
    const http = await this.ensureClient();
    const companies = await http.query<AutotaskCompany>('Companies', MATCH_ALL, { maxRecords });
    if (companies.length === maxRecords) {
      this.logger.warn(
        `listAllCompanies: hit maxRecords cap (${maxRecords}). Some companies may be missing from downstream consumers (cache pre-warm, etc.).`
      );
    }
    this.logger.info(`Retrieved ${companies.length} companies via listAllCompanies`);
    return companies;
  }

  /**
   * Company names for just these ids — one `in` LIST query per 200, sequential
   * (the same list endpoint as the full walk, so names agree with it, unlike a
   * single-record GET for merged/renamed companies). Replaces walking every
   * company (~4.5k at GDS = 9+ calls) to name the handful in a result.
   */
  async getCompanyNamesByIds(ids: number[]): Promise<Array<{ id: number; companyName: string }>> {
    const http = await this.ensureClient();
    const unique = [...new Set(ids.filter((x) => Number.isFinite(x)))];
    const out: Array<{ id: number; companyName: string }> = [];
    for (let i = 0; i < unique.length; i += 200) {
      const rows = await http.query<{ id: number; companyName?: string }>('Companies', [{ op: 'in', field: 'id', value: unique.slice(i, i + 200) }], { includeFields: ['id', 'companyName'], maxRecords: 500 });
      for (const r of rows) if (r.companyName) out.push({ id: r.id, companyName: r.companyName });
    }
    return out;
  }

  async createCompany(company: Partial<AutotaskCompany>): Promise<number> {
    const http = await this.ensureClient();
    // Hard gate (brief §7.31): refuse to create a company from a value that
    // cannot plausibly be a company name (bare webmail provider, greeting, CTA
    // text, sentence-like prose). Stops a bad parse from spawning junk
    // companies regardless of caller; the richer classification stays in n8n.
    const nameCheck = isUnsafeCompanyName((company as Record<string, unknown>).companyName);
    if (!nameCheck.safe) {
      throw new Error(`Refusing to create company: ${nameCheck.reason}. Route to manual review.`);
    }
    // Owner is required by Autotask (§6.1) — resolve it explicitly (supplied
    // value or AUTOTASK_DEFAULT_OWNER_RESOURCE_ID), never silently omit or pick.
    const ownerResourceID = resolveCompanyOwnerResourceID(company);
    // The tenant's defaults (console → Settings → Defaults) under the caller's own values.
    const { company: withDefaults } = withCompanyDefaults(company as Record<string, unknown>, tenantCompanyDefaults());
    try {
      this.logger.debug('Creating company:', withDefaults);
      const id = await http.create('Companies', { ...withDefaults, ownerResourceID });
      this.logger.info(`Company created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create company:', error);
      throw error;
    }
  }

  async updateCompany(id: number, updates: Partial<AutotaskCompany>): Promise<void> {
    const http = await this.ensureClient();
    // Hard gate (brief §7.31): never rename, reclassify, or deactivate a
    // protected internal account (company 0 always, plus any configured in
    // AUTOTASK_PROTECTED_COMPANY_IDS). Benign updates are still allowed.
    const guard = checkProtectedCompanyMutation(id, updates as Record<string, unknown>);
    if (guard.blocked) {
      throw new Error(guard.reason);
    }
    try {
      this.logger.debug(`Updating company ${id}:`, updates);
      await http.update('Companies', id, updates as Record<string, any>);
      this.logger.info(`Company ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update company ${id}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Contacts
  // =====================================================

  /** id → "First Last", memoised briefly: names rarely change, and every ticket card / report wants them. */
  private resourceNameCache = new Map<number, { name: string; at: number }>();
  private static readonly RESOURCE_NAME_TTL_MS = 10 * 60_000;

  /**
   * Names for a set of resource ids in ONE `in` query per 200 (sequential),
   * served from a 10-minute memo where possible. Replaces per-id GETs fired in
   * parallel, which burst past Autotask's per-integration concurrent-request
   * limit (HTTP 429) when a busy caller rendered many ticket cards. Misses are
   * simply absent; a failed lookup returns what the memo has.
   */
  async getResourceNames(ids: unknown[]): Promise<Map<number, string>> {
    const now = Date.now();
    const out = new Map<number, string>();
    const missing: number[] = [];
    for (const id of new Set(ids.map(Number).filter((x) => Number.isFinite(x)))) {
      const hit = this.resourceNameCache.get(id);
      if (hit && now - hit.at < AutotaskService.RESOURCE_NAME_TTL_MS) out.set(id, hit.name);
      else missing.push(id);
    }
    if (!missing.length) return out;
    try {
      const http = await this.ensureClient();
      for (let i = 0; i < missing.length; i += 200) {
        const rows = await http.query<{ id: number; firstName?: string; lastName?: string }>('Resources', [{ op: 'in', field: 'id', value: missing.slice(i, i + 200) }], { includeFields: ['id', 'firstName', 'lastName'], maxRecords: 500 });
        for (const r of rows) {
          const name = [r.firstName, r.lastName].filter(Boolean).join(' ');
          if (!name) continue;
          out.set(r.id, name);
          this.resourceNameCache.set(r.id, { name, at: now });
        }
      }
    } catch (error) {
      this.logger.debug('Resource name lookup failed; returning cached names only', error);
    }
    return out;
  }

  /**
   * Autotask API budget: this server's upstream calls (by method + entity),
   * cache hits and shared in-flight reads, plus Autotask's OWN live counter
   * for the integration (ThresholdInformation — counts every caller sharing
   * the API user, not just this server). Read-only; one upstream call.
   */
  /** The Autotask API username (the tenant key of the per-tenant gates), lowercased; '' when unset. */
  apiUsername(): string {
    return (this.config.autotask.username ?? '').toLowerCase();
  }

  async getApiUsage(): Promise<{ server: ApiUsageSnapshot; autotask: { used: number | null; limit: number | null; windowMinutes: number | null; usedPct: number | null } | { error: string } }> {
    // Snapshot AFTER the live probe so the server view includes it.
    const snap = () => usageSnapshot(this.config.autotask.username?.toLowerCase() ?? '');
    try {
      const http = await this.ensureClient();
      const t = await http.thresholdInformation();
      const used = t.currentTimeframeRequestCount ?? null;
      const limit = t.externalRequestThreshold ?? null;
      const server = snap();
      noteTenantUsage({ tenantUsed: used, limit, windowMinutes: t.requestThresholdTimeframe ?? null, mcpLastHour: server.upstreamLastHour, mcpCountingSince: Date.parse(server.since) });
      return { server, autotask: { used, limit, windowMinutes: t.requestThresholdTimeframe ?? null, usedPct: used != null && limit ? Math.round((used / limit) * 1000) / 10 : null } };
    } catch (error) {
      return { server: snap(), autotask: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  /**
   * Deep link that opens a ticket in the Autotask web UI, via Autotask's
   * documented AutotaskExtend "OpenTicketDetail" command. Null when the web
   * UI base can't be determined (set AUTOTASK_WEB_URL to force it). Runs after
   * any API call has resolved the zone, so the zone's webUrl is cached.
   */
  getTicketWebUrl(ticketId: number): string | null {
    const { username, apiUrl } = this.config.autotask;
    const web = resolveAutotaskWebUrl(username, apiUrl);
    return web ? `${web}Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketID=${encodeURIComponent(String(ticketId))}` : null;
  }

  /** Deep link to a company (OpenAccount) or contact (OpenContact) in the Autotask web UI; null when the UI base is unknown. */
  getRecordWebUrl(kind: 'company' | 'contact', id: number): string | null {
    const { username, apiUrl } = this.config.autotask;
    const web = resolveAutotaskWebUrl(username, apiUrl);
    if (!web) return null;
    return kind === 'company'
      ? `${web}Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenAccount&AccountID=${encodeURIComponent(String(id))}`
      : `${web}Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenContact&ContactID=${encodeURIComponent(String(id))}`;
  }

  async getContact(id: number): Promise<AutotaskContact | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting contact with ID: ${id}`);
      return await http.get<AutotaskContact>('Contacts', id);
    } catch (error) {
      this.logger.error(`Failed to get contact ${id}:`, error);
      throw error;
    }
  }

  async searchContacts(options: AutotaskQueryOptions = {}): Promise<PagedResult<AutotaskContact>> {
    try {
      this.logger.debug('Searching contacts with options:', options);

      const filters: QueryFilter[] = [];
      if (options.searchTerm) {
        // Combined first/last + exact-email search (§6.3) — a full name like
        // "Joan Eberly" now resolves instead of being applied whole to each field.
        filters.push(buildContactSearchFilter(options.searchTerm));
      }
      if (options.companyID !== undefined) {
        filters.push({ op: 'eq', field: 'companyID', value: options.companyID });
      }
      if (options.isActive !== undefined) {
        filters.push({ op: 'eq', field: 'isActive', value: options.isActive });
      }

      return await this.queryPaged<AutotaskContact>('Contacts', filters, options, { maxPageSize: 200 });
    } catch (error) {
      this.logger.error('Failed to search contacts:', error);
      throw error;
    }
  }

  async createContact(contact: Partial<AutotaskContact>): Promise<number> {
    const http = await this.ensureClient();
    // Contacts are a child of Companies. The GDS zone rejects root
    // POST /Contacts (issue #133 / brief §4.2) — creation must go through the
    // company child route POST /Companies/{companyID}/Contacts. companyID is
    // therefore mandatory; fail fast with an actionable error rather than
    // letting Autotask return an opaque 404/400.
    const companyID = (contact as Record<string, any>).companyID;
    if (companyID === undefined || companyID === null) {
      throw new Error(
        'Cannot create contact: companyID is required (contacts are created via the ' +
        'Companies/{companyID}/Contacts child route).'
      );
    }
    // Contacts.isActive is an integer (0 / 1) — a boolean fails the request (HTTP 500).
    const c0 = contact as Record<string, any>;
    if (c0.isActive !== undefined) c0.isActive = c0.isActive === true || c0.isActive === 1 || c0.isActive === '1' || String(c0.isActive).toLowerCase() === 'true' ? 1 : 0;
    // Enforce the 50-char contact note limit (§6.2); `truncateNote` is an
    // MCP-only opt-in, not an Autotask field, so strip it from the payload.
    const { truncateNote, ...rest } = contact as Record<string, any>;
    const note = normalizeContactNote(rest.note, { truncate: truncateNote === true });
    const payload: Record<string, any> = { ...rest };
    if (note !== undefined) payload.note = note; else delete payload.note;
    try {
      this.logger.debug('Creating contact:', payload);
      const id = await http.childCreate('Companies', companyID, 'Contacts', payload);
      this.logger.info(`Contact created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create contact:', error);
      throw error;
    }
  }

  /**
   * Find a contact in a company by email, or create it if absent. Idempotent —
   * safe against the "already exists" race and the create-then-GET fragility that
   * bit automation clients. Returns the id and whether it was newly created.
   */
  async findOrCreateContact(
    companyID: number,
    contact: Partial<AutotaskContact> & { emailAddress?: string; email?: string; reactivate?: boolean }
  ): Promise<{ id: number | null; created: boolean; status?: 'ambiguous'; matchedBy?: 'email' | 'name'; reactivated?: boolean; candidates?: number[] }> {
    if (companyID === undefined || companyID === null) {
      throw new Error('Cannot find-or-create contact: companyID is required.');
    }
    const http = await this.ensureClient();
    const { email: emailAlias, reactivate, ...fields } = contact;
    const email = String(fields.emailAddress ?? emailAlias ?? '').trim();
    const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    type Row = { id: number; isActive?: unknown; firstName?: string; lastName?: string };
    // Inactive contacts are matched too: re-creating one would leave a duplicate beside it.
    let hits: Row[] = [];
    let matchedBy: 'email' | 'name' | undefined;
    if (email) {
      hits = await http.query<Row>('Contacts', [
        { op: 'eq', field: 'companyID', value: companyID },
        { op: 'eq', field: 'emailAddress', value: email },
      ], { includeFields: ['id', 'isActive'], maxRecords: 25 });
      matchedBy = 'email';
    } else if (norm(fields.firstName) && norm(fields.lastName)) {
      const rows = await http.query<Row>('Contacts', [
        { op: 'eq', field: 'companyID', value: companyID },
        { op: 'eq', field: 'lastName', value: String(fields.lastName).trim() },
      ], { includeFields: ['id', 'isActive', 'firstName', 'lastName'], maxRecords: 100 });
      hits = rows.filter((r) => norm(r.firstName) === norm(fields.firstName) && norm(r.lastName) === norm(fields.lastName));
      matchedBy = 'name';
    }
    const isActive = (r: Row) => !(r.isActive === false || r.isActive === 0 || r.isActive === '0');
    // Prefer active matches; several left → ambiguous, nothing created.
    const active = hits.filter(isActive);
    const pool = active.length ? active : hits;
    if (pool.length > 1) {
      return { id: null, created: false, status: 'ambiguous', ...(matchedBy ? { matchedBy } : {}), candidates: pool.map((r) => r.id) };
    }
    if (pool.length === 1 && typeof pool[0].id === 'number') {
      const hit = pool[0];
      let reactivated = false;
      if (!isActive(hit) && reactivate !== false) {
        await this.updateContact(hit.id, { isActive: 1, companyID } as Partial<AutotaskContact>);
        reactivated = true;
      }
      this.logger.info(`findOrCreateContact: matched existing contact ${hit.id} by ${matchedBy} in company ${companyID}${reactivated ? ' (reactivated)' : ''}`);
      return { id: hit.id, created: false, ...(matchedBy ? { matchedBy } : {}), reactivated };
    }
    const id = await this.createContact({ ...fields, ...(email ? { emailAddress: email } : {}), companyID } as Partial<AutotaskContact>);
    return { id, created: true };
  }

  /** Tenants (API usernames) whose zone takes only the child route — learned when PATCH /Contacts and PUT /Contacts/{id} fail with 404 / 405 and the child route works. */
  private static contactChildRouteTenants = new Set<string>();
  /** Tests only. */
  static _resetContactRoute(): void { AutotaskService.contactChildRouteTenants.clear(); }
  private get contactRouteKey(): string { return String(this.config.autotask.username ?? '').toLowerCase(); }

  async updateContact(id: number, updates: Partial<AutotaskContact>): Promise<void> {
    const http = await this.ensureClient();
    // Enforce the 50-char contact note limit (§6.2). `truncateNote` is MCP-only.
    const upd = updates as Record<string, any>;
    if (upd.truncateNote !== undefined) {
      const truncate = upd.truncateNote === true;
      delete upd.truncateNote;
      if (upd.note !== undefined) upd.note = normalizeContactNote(upd.note, { truncate });
    } else if (upd.note !== undefined) {
      upd.note = normalizeContactNote(upd.note);
    }
    // Contacts.isActive is an INTEGER (0 / 1), unlike Companies' boolean: `false` fails the whole
    // update with HTTP 500 "Unexpected character … Path 'isActive'" (seen live deactivating contacts).
    if (upd.isActive !== undefined) {
      const v = upd.isActive;
      upd.isActive = v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true' ? 1 : 0;
    }
    try {
      this.logger.debug(`Updating contact ${id}:`, updates);
      // This zone only takes the child route (learned on the first update): go straight there.
      if (AutotaskService.contactChildRouteTenants.has(this.contactRouteKey)) {
        let companyID = upd.companyID as number | null | undefined;
        if (companyID == null) companyID = ((await this.getContact(id)) as Record<string, any> | null)?.companyID;
        if (companyID == null) throw new Error(`Cannot update contact ${id}: unable to resolve its companyID (does the contact still exist?)`);
        await http.childUpdate('Companies', companyID, 'Contacts', id, updates as Record<string, any>);
        this.logger.info(`Contact ${id} updated successfully`);
        return;
      }
      try {
        await http.update('Contacts', id, updates as Record<string, any>);
      } catch (err) {
        // Some zone hosts register NEITHER route update() tries: the
        // collection-level PATCH /Contacts returns an HTML 404 (the Zone DE1
        // behaviour from issue #133) AND the PUT /Contacts/{id} fallback is
        // rejected with 405 (#197), so every contact update fails with no
        // workaround. Contacts are a child entity of Companies, so retry
        // through the documented child route
        // PATCH /Companies/{companyID}/Contacts — resolving the parent from
        // the update payload when supplied, otherwise from the existing
        // record. The fallback is gated on 404/405 so genuine validation
        // errors (400/422) surface unchanged, and ordered last so zones where
        // update() works (including DE1's PUT fallback) keep their behaviour.
        const status = (err as { status?: number })?.status;
        if (status !== 404 && status !== 405) throw err;
        let companyID = (updates as Record<string, any>).companyID as number | null | undefined;
        if (companyID === undefined || companyID === null) {
          companyID = ((await this.getContact(id)) as Record<string, any> | null)?.companyID;
        }
        if (companyID === undefined || companyID === null) {
          throw new Error(
            `Cannot update contact ${id}: unable to resolve parent companyID for the ` +
            `Companies/{companyID}/Contacts child route (does the contact still exist?)`,
            { cause: err }
          );
        }
        this.logger.debug(
          `Contact ${id}: update() failed with HTTP ${status} — retrying via Companies/${companyID}/Contacts child route`
        );
        await http.childUpdate('Companies', companyID, 'Contacts', id, updates as Record<string, any>);
        AutotaskService.contactChildRouteTenants.add(this.contactRouteKey); // skip the two failing routes from now on
      }
      this.logger.info(`Contact ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update contact ${id}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Tickets
  // =====================================================

  async getTicket(id: number, fullDetails: boolean = false): Promise<AutotaskTicket | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting ticket with ID: ${id}, fullDetails: ${fullDetails}`);
      const ticket = await http.get<AutotaskTicket>('Tickets', id);
      if (!ticket) return null;
      return fullDetails ? ticket : this.optimizeTicketData(ticket);
    } catch (error) {
      this.logger.error(`Failed to get ticket ${id}:`, error);
      throw error;
    }
  }

  async searchTickets(options: AutotaskQueryOptionsExtended = {}): Promise<PagedResult<AutotaskTicket>> {
    try {
      this.logger.debug('Searching tickets with options:', options);

      const filters: QueryFilter[] = [];

      // searchTerm: a ticket-number-looking value ("T20260921", "T20260921.0086",
      // "20260921") keeps the ticket-number PREFIX match; anything else is a
      // keyword and searches the TITLE (Autotask `contains`, case-insensitive).
      // Before, a keyword here matched no ticket number and silently returned
      // nothing — so callers listed a whole company's open tickets to scan
      // titles themselves, page after page (each emulated page re-fetches the
      // ones before it). `title` is the explicit keyword filter.
      if (options.searchTerm) {
        const term = String(options.searchTerm).trim();
        if (/^T?\d{4,8}(\.\d{0,4})?$/i.test(term)) {
          filters.push({ op: 'beginsWith', field: 'ticketNumber', value: /^\d/.test(term) ? `T${term}` : term });
        } else {
          filters.push({ op: 'contains', field: 'title', value: term });
        }
      }
      if (options.title) {
        filters.push({ op: 'contains', field: 'title', value: String(options.title).trim() });
      }

      if (options.status !== undefined) {
        filters.push({ op: 'eq', field: 'status', value: options.status });
      } else if ((options as Record<string, unknown>).includeCompleted !== true) {
        filters.push({ op: 'noteq', field: 'status', value: 5 }); // 5 = Complete (Autotask REST uses 'noteq', not 'ne')
      }

      if (options.queueID !== undefined) {
        filters.push({ op: 'eq', field: 'queueID', value: options.queueID });
      }

      if (options.priority !== undefined) {
        filters.push({ op: 'eq', field: 'priority', value: options.priority });
      }

      if (options.unassigned === true) {
        filters.push({ op: 'eq', field: 'assignedResourceID', value: null });
      } else if (options.assignedResourceID !== undefined) {
        filters.push({ op: 'eq', field: 'assignedResourceID', value: options.assignedResourceID });
      }

      const companyId = options.companyID ?? options.companyId;
      if (companyId !== undefined) {
        filters.push({ op: 'eq', field: 'companyID', value: companyId });
      }

      const contactId = options.contactID ?? options.contactId;
      if (contactId !== undefined) {
        filters.push({ op: 'eq', field: 'contactID', value: contactId });
      }

      // Contract reconciliation: tickets on a contract, or on NO contract.
      const o = options as Record<string, unknown>;
      if (o.noContract === true) {
        filters.push({ op: 'notExist', field: 'contractID' });
      } else if (o.contractID !== undefined && o.contractID !== null) {
        filters.push({ op: 'eq', field: 'contractID', value: o.contractID });
      }

      if (options.createdAfter) {
        filters.push({ op: 'gte', field: 'createDate', value: options.createdAfter });
      }
      if (options.createdBefore) {
        filters.push({ op: 'lte', field: 'createDate', value: options.createdBefore });
      }
      if (options.lastActivityAfter) {
        filters.push({ op: 'gte', field: 'lastActivityDate', value: options.lastActivityAfter });
      }
      if (options.externalID) {
        filters.push({ op: 'eq', field: 'externalID', value: options.externalID });
      }

      const paged = await this.queryPaged<AutotaskTicket>('Tickets', filters, options, { maxPageSize: 500 });
      return { ...paged, items: paged.items.map(t => this.optimizeTicketDataAggressive(t)) };
    } catch (error) {
      this.logger.error('Failed to search tickets:', error);
      throw error;
    }
  }

  private optimizeTicketDataAggressive(ticket: AutotaskTicket): AutotaskTicket {
    const optimized: AutotaskTicket = {};
    if (ticket.id !== undefined) optimized.id = ticket.id;
    if (ticket.ticketNumber !== undefined) optimized.ticketNumber = ticket.ticketNumber;
    if (ticket.title !== undefined) optimized.title = ticket.title;
    if (ticket.description !== undefined && ticket.description !== null) {
      optimized.description = ticket.description.length > 200
        ? ticket.description.substring(0, 200) + '... [truncated - use get_ticket_details for full text]'
        : ticket.description;
    }
    if (ticket.status !== undefined) optimized.status = ticket.status;
    if (ticket.priority !== undefined) optimized.priority = ticket.priority;
    // externalID is the idempotency/occurrence key — preserve it so a search by
    // externalID returns it, not just the ticket id.
    if ((ticket as any).externalID !== undefined && (ticket as any).externalID !== null) {
      (optimized as any).externalID = (ticket as any).externalID;
    }
    if (ticket.companyID !== undefined) optimized.companyID = ticket.companyID;
    if (ticket.contactID !== undefined) optimized.contactID = ticket.contactID;
    if (ticket.assignedResourceID !== undefined) optimized.assignedResourceID = ticket.assignedResourceID;
    if (ticket.createDate !== undefined) optimized.createDate = ticket.createDate;
    if (ticket.lastActivityDate !== undefined) optimized.lastActivityDate = ticket.lastActivityDate;
    if (ticket.dueDateTime !== undefined) optimized.dueDateTime = ticket.dueDateTime;
    if (ticket.completedDate !== undefined) optimized.completedDate = ticket.completedDate;
    if (ticket.estimatedHours !== undefined) optimized.estimatedHours = ticket.estimatedHours;
    if (ticket.ticketType !== undefined) optimized.ticketType = ticket.ticketType;
    if (ticket.source !== undefined) optimized.source = ticket.source;
    if (ticket.issueType !== undefined) optimized.issueType = ticket.issueType;
    if (ticket.subIssueType !== undefined) optimized.subIssueType = ticket.subIssueType;
    if (ticket.resolution !== undefined && ticket.resolution !== null) {
      optimized.resolution = ticket.resolution.length > 100
        ? ticket.resolution.substring(0, 100) + '... [truncated - use get_ticket_details for full text]'
        : ticket.resolution;
    }
    return optimized;
  }

  private optimizeTicketData(ticket: AutotaskTicket): AutotaskTicket {
    const maxDescriptionLength = 500;
    const maxNotesLength = 300;
    return {
      ...ticket,
      description: ticket.description && ticket.description.length > maxDescriptionLength
        ? ticket.description.substring(0, maxDescriptionLength) + '... [truncated]'
        : ticket.description,
      resolution: ticket.resolution && ticket.resolution.length > maxNotesLength
        ? ticket.resolution.substring(0, maxNotesLength) + '... [truncated]'
        : ticket.resolution,
      userDefinedFields: [],
      ...(ticket.purchaseOrderNumber && {
        purchaseOrderNumber: ticket.purchaseOrderNumber.length > 50
          ? ticket.purchaseOrderNumber.substring(0, 50) + '...'
          : ticket.purchaseOrderNumber
      })
    };
  }

  async createTicket(ticket: Partial<AutotaskTicket>): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating ticket:', ticket);
      const id = await http.create('Tickets', ticket);
      this.logger.info(`Ticket created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create ticket:', error);
      throw error;
    }
  }

  async updateTicket(id: number, updates: Partial<AutotaskTicket>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating ticket ${id}:`, updates);
      await http.update('Tickets', id, updates as Record<string, any>);
      this.logger.info(`Ticket ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update ticket ${id}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Ticket audit (read-only): full resolved ticket, parsed history, the
  // originating email. Every section is fail-soft and runs sequentially.
  // =====================================================

  /** A ticket id from { ticketID } or { ticketNumber } ("T20261005.0123", T optional). */
  async resolveTicketRef(ref: { ticketID?: unknown; ticketNumber?: unknown }, opts: { withRow?: boolean } = {}): Promise<{ id: number; ticketNumber?: string; row?: AutotaskTicket } | { error: string }> {
    if (ref.ticketID !== undefined && ref.ticketID !== null && ref.ticketID !== '') {
      const id = Number(ref.ticketID);
      return Number.isInteger(id) && id > 0 ? { id } : { error: `ticketID must be a positive integer, got "${String(ref.ticketID)}".` };
    }
    const number = normalizeTicketNumber(ref.ticketNumber);
    if (!number) return { error: `Provide ticketID or a ticket number like T20261005.0123 (got "${String(ref.ticketNumber ?? '')}").` };
    const http = await this.ensureClient();
    // withRow: fetch the whole ticket here, so the caller needn't GET it again (one round-trip less).
    const hits = await http.query<AutotaskTicket & { id: number; ticketNumber: string }>('Tickets', [{ op: 'eq', field: 'ticketNumber', value: number }], { maxRecords: 5, ...(opts.withRow ? {} : { includeFields: ['id', 'ticketNumber'] }) });
    if (!hits.length) return { error: `No ticket ${number} found.` };
    if (hits.length > 1) return { error: `Ticket number ${number} matched ${hits.length} tickets (ids ${hits.map((h) => h.id).join(', ')}) — pass ticketID.` };
    return { id: Number(hits[0]!.id), ticketNumber: number, ...(opts.withRow ? { row: hits[0]! } : {}) };
  }

  /**
   * The full ticket with every picklist labelled and every reference named:
   * company, contact(s) with email, resources, role, contract, opportunity,
   * configuration item, work type, location, UDFs (list labels), and the
   * Autotask link. Read-only; one call per referenced entity, all in parallel.
   * `preloaded`: the ticket row when the caller already has it (skips the GET).
   */
  async getTicketFull(id: number, preloaded?: AutotaskTicket): Promise<Record<string, unknown> | null> {
    const http = await this.ensureClient();
    const raw = preloaded && Number(preloaded.id) === id ? preloaded : await http.get<AutotaskTicket>('Tickets', id);
    if (!raw) return null;
    const { userDefinedFields, ...ticket } = raw;
    const errors: Array<{ section: string; error: string }> = [];
    const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try { return await fn(); } catch (e) { errors.push({ section: name, error: e instanceof Error ? e.message : String(e) }); return undefined; }
    };
    const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
    const names: Record<string, Record<string, unknown>> = {};

    // Every lookup below depends only on the ticket, so they all run at once
    // (2026-10-08: sequential, a cold call took 11 Autotask round-trips ≈ 7.4 s).
    // The per-endpoint gate still caps Autotask threads; mirrored entities
    // (company, contacts, resources, contract, project, problem ticket) are
    // answered by the Postgres shadow when it's on.
    const lookups: Array<Promise<unknown>> = [];
    let labels: Record<string, string> = {};
    lookups.push(section('labels', async () => picklistLabels(ticket, await this.getFieldInfo('Tickets'))).then((l) => { labels = l ?? {}; }));

    const companyID = num(ticket.companyID);
    if (companyID != null) {
      lookups.push(section('company', () => this.getCompanyNamesByIds([companyID])).then((c) => { names.companyID = { id: companyID, name: c?.[0]?.companyName ?? null }; }));
    }
    const contactIds = TICKET_CONTACT_FIELDS.map((f) => num(ticket[f])).filter((x): x is number => x != null);
    if (contactIds.length) {
      lookups.push(section('contacts', () => http.query<ContactRow>('Contacts', [{ op: 'in', field: 'id', value: [...new Set(contactIds)] }], { maxRecords: 10, includeFields: ['id', 'firstName', 'lastName', 'emailAddress', 'companyID', 'isActive'] })).then((rows) => {
        for (const f of TICKET_CONTACT_FIELDS) {
          const cid = num(ticket[f]);
          if (cid == null) continue;
          const r = rows?.find((x) => Number(x.id) === cid);
          names[f] = { id: cid, name: contactName(r), email: r?.emailAddress ?? null, companyID: r?.companyID ?? null, isActive: r?.isActive ?? null };
        }
      }));
    }
    const resIds = TICKET_RESOURCE_FIELDS.map((f) => num(ticket[f])).filter((x): x is number => x != null);
    if (resIds.length) {
      lookups.push(section('resources', () => this.getResourceNames(resIds)).then((m) => {
        for (const f of TICKET_RESOURCE_FIELDS) {
          const rid = num(ticket[f]);
          if (rid != null) names[f] = { id: rid, name: m?.get(rid) ?? (rid === SYSTEM_RESOURCE_ID ? 'Autotask Administrator (system)' : null) };
        }
      }));
    }
    // Single-row lookups: [ticket field, entity, the entity's name field(s)].
    const singles: Array<[string, string, string[]]> = [
      ['assignedResourceRoleID', 'Roles', ['name']],
      ['contractID', 'Contracts', ['contractName']],
      ['opportunityID', 'Opportunities', ['title']],
      ['configurationItemID', 'ConfigurationItems', ['referenceTitle', 'serialNumber']],
      ['billingCodeID', 'BillingCodes', ['name']],
      ['companyLocationID', 'CompanyLocations', ['name']],
      ['projectID', 'Projects', ['projectName']],
      ['problemTicketId', 'Tickets', ['ticketNumber', 'title']],
    ];
    for (const [field, entity, nameFields] of singles) {
      const rid = num(ticket[field]);
      if (rid == null) continue;
      lookups.push(section(field, () => http.query<Record<string, unknown>>(entity, [{ op: 'eq', field: 'id', value: rid }], { maxRecords: 1, includeFields: ['id', ...nameFields] })).then((rows) => {
        const r = rows?.[0];
        names[field] = { id: rid, ...Object.fromEntries(nameFields.map((n) => [n, r?.[n] ?? null])) };
      }));
    }

    let udfs: unknown;
    lookups.push(section('udfs', async () => labelUdfs(userDefinedFields, (await http.udfInfo('Tickets')).fields)).then((u) => { udfs = u; }));
    await Promise.all(lookups);
    let ticketUrl: string | null = null;
    try { ticketUrl = this.getTicketWebUrl(id); } catch { /* no web base resolvable */ }
    return { ticket, labels, names, udfs: udfs ?? (Array.isArray(userDefinedFields) ? userDefinedFields : []), ticketUrl, ...(errors.length ? { errors } : {}) };
  }

  /**
   * TicketHistory as parsed events, oldest first: field / from / to for
   * "X changed from A to B", the actor named and classified (system account,
   * this MCP's API user, or a person). Timestamp-only actions are hidden by
   * default and counted.
   */
  async getTicketHistoryEvents(id: number, opts: { includeNoise?: boolean; live?: boolean } = {}): Promise<Record<string, unknown>> {
    // Served from the audit ledger when its copy is current (0 calls); timestamp-only rows aren't stored, so includeNoise reads live.
    const cached = opts.includeNoise || opts.live ? null : await this.cachedTicketHistory(id);
    let rows: HistoryRow[];
    let parsedFromCache: Map<number, { field: string | null; from: string | null; to: string | null }> | null = null;
    if (cached) {
      rows = cached.rows;
      parsedFromCache = cached.parsed;
    } else {
      const http = await this.ensureClient();
      rows = await http.query<HistoryRow>('TicketHistory', [{ op: 'eq', field: 'ticketID', value: id }], { maxRecords: 500 });
    }
    rows.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || Number(a.id) - Number(b.id));
    const noise = rows.filter((r) => NOISE_HISTORY_ACTIONS.has(String(r.action)));
    const kept = opts.includeNoise ? rows : rows.filter((r) => !NOISE_HISTORY_ACTIONS.has(String(r.action)));

    let fields: FieldInfo[] = [];
    try { fields = await this.getFieldInfo('Tickets'); } catch { /* parse without label anchors */ }
    const labelsFor = (field: string): string[] => {
      const f = fields.find((x) => x.name === HISTORY_FIELD_PICKLIST[field.toLowerCase()]);
      return (f?.picklistValues ?? []).map((v) => v.label);
    };
    // A live read refreshes the index, so the activity feed and the next read skip this ticket's history call.
    if (!cached) await this.indexTicketHistory(id, rows, labelsFor);
    let self: number | null = null;
    try { self = await this.resolveApiUserResourceId(); } catch { /* unknown */ }
    let actorNames = new Map<number, string>();
    const actorIds = [...new Set(kept.map((r) => Number(r.resourceID)).filter((x) => Number.isFinite(x) && x > 0))];
    try { if (actorIds.length) actorNames = await this.getResourceNames(actorIds); } catch { /* ids only */ }

    let actorCtx: ClassifyContext | null = null;
    try { actorCtx = await this.getActorContext(); } catch { /* classification is best-effort */ }
    const events = kept.map((r) => {
      const stored = parsedFromCache?.get(Number(r.id));
      const change = stored?.field ? { field: stored.field, from: stored.from, to: stored.to, ambiguous: false }
        : r.detail ? parseHistoryChange(String(r.detail), labelsFor(String(r.detail).split(/ changed from /i)[0] ?? '')) : null;
      const rid = r.resourceID != null ? Number(r.resourceID) : null;
      const kind = actorKind(rid, self);
      const cls = actorCtx ? classifyActor(rid, actorCtx) : null;
      return {
        id: r.id, date: r.date, action: r.action,
        ...(change ? { field: change.field, from: change.from, to: change.to, ...(change.ambiguous ? { parseAmbiguous: true } : {}) } : {}),
        detail: r.detail ?? null,
        actor: { resourceID: rid, kind, name: rid != null ? (actorNames.get(rid) ?? cls?.displayName ?? (kind === 'system' ? 'Autotask Administrator (system)' : null)) : null,
          ...(cls ? { actorType: cls.actorType, classificationSource: cls.classificationSource, reference: cls.reference } : { actorType: 'unknown', classificationSource: 'unclassified', reference: false }) },
      };
    });
    const byActor: Record<string, number> = {};
    for (const e of events) byActor[e.actor.kind] = (byActor[e.actor.kind] ?? 0) + 1;
    const byActorType: Record<string, number> = {};
    for (const e of events) byActorType[e.actor.actorType] = (byActorType[e.actor.actorType] ?? 0) + 1;
    return {
      ticketID: id, events,
      // From the index the timestamp-only rows aren't known (they're never stored): null, not 0.
      counts: { events: events.length, hiddenTimestampOnly: opts.includeNoise ? 0 : cached ? null : noise.length, byActorKind: byActor, byActorType },
      mcpApiUserResourceID: self, truncated: cached ? cached.truncated : rows.length >= 500,
      source: cached ? { from: 'index', indexedAt: cached.indexedAt, ticketLastModified: cached.ticketLastModified } : { from: 'live' },
    };
  }

  /**
   * The ticket's history from the audit ledger, when the ledger's copy is
   * current: read after the ticket's last tracked change (per the Tickets
   * mirror, itself fresh), and the ticket not written since. Otherwise null → live.
   */
  private async cachedTicketHistory(id: number): Promise<{
    rows: HistoryRow[]; parsed: Map<number, { field: string | null; from: string | null; to: string | null }>;
    indexedAt: string; ticketLastModified: string; truncated: boolean;
  } | null> {
    const rt = getShadowRuntime();
    if (!rt) return null;
    try {
      if (rt.sync?.isDirty('Tickets', id)) return null;
      const f = await rt.store.freshness('Tickets');
      if (!f.ready || f.ageSeconds == null || f.ageSeconds > rt.maxAgeSeconds) return null;
      const t = (await rt.store.query('Tickets', [{ op: 'eq', field: 'id', value: id }], { limit: 1, fields: ['lastTrackedModificationDateTime'] })).rows[0];
      const lastMod = t?.lastTrackedModificationDateTime ? new Date(String(t.lastTrackedModificationDateTime)) : null;
      const at = (await rt.ledger.historyFetched([id])).get(id);
      if (!lastMod || Number.isNaN(lastMod.getTime()) || !at || at < lastMod) return null;
      const evs = await rt.ledger.query({ start: '1970-01-01T00:00:00Z', end: '9999-01-01T00:00:00Z', sources: ['ticket_history'], entityTypes: ['ticket'], entityIds: [id] });
      const parsed = new Map<number, { field: string | null; from: string | null; to: string | null }>();
      const rows: HistoryRow[] = evs.map((e) => {
        const hid = Number(String(e.eventId).replace(/^th:/, ''));
        const d = (e.details ?? {}) as Record<string, unknown>;
        if (e.field && (e.oldValue != null || e.newValue != null)) parsed.set(hid, { field: e.field, from: e.oldValue ?? null, to: e.newValue ?? null });
        const detail = typeof d.detail === 'string' ? d.detail
          : e.field && (e.oldValue != null || e.newValue != null) ? `${e.field} changed from ${e.oldValue ?? ''} to ${e.newValue ?? ''}` : null;
        return { id: hid, date: e.timestamp, ...(typeof d.historyAction === 'string' ? { action: d.historyAction } : {}), detail, resourceID: e.resourceId };
      });
      return { rows, parsed, indexedAt: at.toISOString(), ticketLastModified: lastMod.toISOString(), truncated: rows.length >= 500 };
    } catch { return null; }
  }

  /** Store a live history read in the audit ledger (best effort — the read never fails over it). */
  private async indexTicketHistory(id: number, rows: HistoryRow[], labelsFor: (field: string) => string[]): Promise<void> {
    const rt = getShadowRuntime();
    if (!rt) return;
    try {
      const t = (await rt.store.query('Tickets', [{ op: 'eq', field: 'id', value: id }], { limit: 1, fields: ['ticketNumber', 'companyID'] })).rows[0] as { ticketNumber?: string; companyID?: number } | undefined;
      const ticket = { id, ticketNumber: t?.ticketNumber ?? null, companyID: t?.companyID ?? null };
      const evs = rows.map((r) => historyEvent(r as never, ticket, labelsFor)).filter((e): e is NonNullable<typeof e> => !!e);
      await rt.ledger.insert(evs);
      await rt.ledger.markHistoryFetched(id, new Date());
    } catch (err) { this.logger.debug(`ticket ${id}: history not indexed`, err); }
  }

  /**
   * Where an email-created ticket came from: the ORIGINAL message Autotask's
   * email processor attached ("Originating Email", message/rfc822) — From,
   * Reply-To, To, Cc, Subject, Date, Message-ID, Authentication-Results, the
   * plain-text body — plus the ticket's source/creator. Which mailbox or
   * email-processor rule produced the ticket is NOT exposed by the API; the
   * result says so instead of guessing.
   */
  async getTicketEmailContext(id: number, opts: { maxBodyChars?: number } = {}): Promise<Record<string, unknown>> {
    const http = await this.ensureClient();
    const ticket = await http.get<AutotaskTicket>('Tickets', id);
    if (!ticket) return { ticketID: id, status: 'not_found' };
    let fields: FieldInfo[] = [];
    try { fields = await this.getFieldInfo('Tickets'); } catch { /* raw values */ }
    const labels = picklistLabels(ticket, fields);
    const creator: Record<string, unknown> = { type: labels.creatorType ?? ticket.creatorType ?? null };
    if (ticket.createdByContactID != null) {
      try {
        const c = (await http.query<ContactRow>('Contacts', [{ op: 'eq', field: 'id', value: ticket.createdByContactID }], { maxRecords: 1, includeFields: ['id', 'firstName', 'lastName', 'emailAddress', 'companyID'] }))[0];
        creator.contact = { id: Number(ticket.createdByContactID), name: contactName(c), email: c?.emailAddress ?? null, companyID: c?.companyID ?? null };
      } catch { creator.contact = { id: Number(ticket.createdByContactID) }; }
    }
    if (ticket.creatorResourceID != null) {
      try { creator.resource = { id: Number(ticket.creatorResourceID), name: (await this.getResourceNames([ticket.creatorResourceID])).get(Number(ticket.creatorResourceID)) ?? null }; } catch { creator.resource = { id: Number(ticket.creatorResourceID) }; }
    }

    const atts = await http.query<AttachmentRow>('TicketAttachments', [{ op: 'eq', field: 'parentID', value: id }], { maxRecords: 50, includeFields: ['id', 'title', 'contentType', 'fileSize', 'attachDate', 'attachmentType'] });
    const emails = atts.filter((a) => String(a.contentType ?? '').toLowerCase() === 'message/rfc822')
      .sort((a, b) => Number(/originating email/i.test(String(b.title))) - Number(/originating email/i.test(String(a.title))) || String(a.attachDate ?? '').localeCompare(String(b.attachDate ?? '')));
    const base = {
      ticketID: id, ticketNumber: ticket.ticketNumber, title: ticket.title,
      source: { value: ticket.source ?? null, label: labels.source ?? null, isEmail: isEmailSource(labels.source) },
      createDate: ticket.createDate, creator,
      emailAttachments: emails.map((a) => ({ id: a.id, title: a.title, size: a.fileSize ?? null, attachDate: a.attachDate ?? null })),
      notExposedByApi: ['the mailbox that received the message', 'the email-processor rule that created the ticket'],
    };
    const orig = emails[0];
    if (!orig) {
      return { ...base, status: 'no_original_email', message: base.source.isEmail
        ? 'The ticket came in by email but has no original-message attachment (the email processor may not be set to attach it). Only the flattened description is available.'
        : `The ticket's source is "${base.source.label ?? 'unknown'}", not email, and it has no attached message.` };
    }
    const MAX_BYTES = 5 * 1024 * 1024;
    if (Number(orig.fileSize) > MAX_BYTES) return { ...base, status: 'original_email_too_large', originalEmail: { attachmentID: orig.id, size: orig.fileSize } };
    const full = await http.get<AttachmentRow>('TicketAttachments', Number(orig.id));
    if (!full?.data) return { ...base, status: 'original_email_unreadable', originalEmail: { attachmentID: orig.id } };
    const mail = parseRfc822(Buffer.from(String(full.data), 'base64'));
    const maxChars = Math.min(Math.max(Number(opts.maxBodyChars) || 8000, 500), 50000);
    const body = mail.textBody ?? '';
    const from = parseAddress(mail.header('From'));
    return {
      ...base,
      status: 'ok',
      originalEmail: {
        attachmentID: orig.id,
        from, fromDisplayName: from.name, fromAddress: from.address,
        replyTo: parseAddressList(mail.header('Reply-To')),
        to: parseAddressList(mail.header('To')),
        cc: parseAddressList(mail.header('Cc')),
        subject: mail.header('Subject') ?? null,
        date: mail.header('Date') ?? null,
        messageId: mail.header('Message-ID') ?? null,
        returnPath: mail.header('Return-Path') ?? null,
        authenticationResults: [...mail.all('Authentication-Results'), ...mail.all('ARC-Authentication-Results')],
        receivedSpf: mail.all('Received-SPF'),
        dkimDomains: mail.all('DKIM-Signature').map((d) => d.match(/\bd=([^;\s]+)/)?.[1]).filter(Boolean),
        replyToDiffersFromFrom: (() => { const rt = parseAddressList(mail.header('Reply-To')); return rt.length > 0 && !!from.address && !rt.some((r) => r.address === from.address); })(),
        textBody: body.length > maxChars ? body.slice(0, maxChars) : body,
        textBodyTruncated: body.length > maxChars,
        textSource: mail.textSource,
        parts: mail.parts,
      },
    };
  }

  /**
   * Add author + label fields to ticket notes (additive — existing fields
   * untouched): authorName (resource or contact), authorKind, noteTypeLabel,
   * publishLabel. Best-effort; a failed lookup leaves the field out.
   */
  async labelTicketNotes<T extends { creatorResourceID?: unknown; createdByContactID?: unknown; noteType?: unknown; publish?: unknown }>(notes: T[]): Promise<Array<T & Record<string, unknown>>> {
    if (!notes.length) return notes;
    let types: PicklistValue[] = [], pubs: PicklistValue[] = [];
    try { types = await this.getPicklistValues('TicketNotes', 'noteType'); pubs = await this.getPicklistValues('TicketNotes', 'publish'); } catch { /* ids only */ }
    let resNames = new Map<number, string>();
    try { resNames = await this.getResourceNames(notes.map((n) => n.creatorResourceID).filter((x) => x != null)); } catch { /* ids only */ }
    const contactIds = [...new Set(notes.map((n) => n.createdByContactID).filter((x) => x != null).map(Number))];
    const contacts = new Map<number, string>();
    if (contactIds.length) {
      try {
        const http = await this.ensureClient();
        for (const c of await http.query<ContactRow>('Contacts', [{ op: 'in', field: 'id', value: contactIds.slice(0, 200) }], { maxRecords: 200, includeFields: ['id', 'firstName', 'lastName', 'emailAddress'] })) {
          contacts.set(Number(c.id), `${[c.firstName, c.lastName].filter(Boolean).join(' ')}${c.emailAddress ? ` <${c.emailAddress}>` : ''}`);
        }
      } catch { /* ids only */ }
    }
    const label = (list: PicklistValue[], v: unknown) => list.find((p) => String(p.value) === String(v))?.label;
    return notes.map((n) => {
      const byContact = n.createdByContactID != null;
      const rid = n.creatorResourceID != null ? Number(n.creatorResourceID) : null;
      const authorName = byContact ? contacts.get(Number(n.createdByContactID)) : rid != null ? (resNames.get(rid) ?? (rid === SYSTEM_RESOURCE_ID ? 'Autotask Administrator (system)' : undefined)) : undefined;
      const nt = label(types, n.noteType), pb = label(pubs, n.publish);
      return {
        ...n,
        authorKind: byContact ? 'contact' : rid === SYSTEM_RESOURCE_ID ? 'system' : rid != null ? 'resource' : 'unknown',
        ...(authorName ? { authorName } : {}),
        ...(nt ? { noteTypeLabel: nt } : {}),
        ...(pb ? { publishLabel: pb } : {}),
      };
    });
  }

  /** Active values of several picklist fields in one call; unknown / non-picklist names listed. */
  async getPicklists(entity: string, fieldNames?: string[]): Promise<{ entity: string; picklists: Record<string, Array<{ value: string; label: string; parentValue?: string }>>; unknownFields: string[]; notPicklists: string[] }> {
    const fields = await this.getFieldInfo(entity);
    const wanted = fieldNames?.length ? fieldNames : fields.filter((f) => f.isPickList).map((f) => f.name);
    const picklists: Record<string, Array<{ value: string; label: string; parentValue?: string }>> = {};
    const unknownFields: string[] = [], notPicklists: string[] = [];
    for (const name of wanted) {
      const f = fields.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
      if (!f) { unknownFields.push(name); continue; }
      if (!f.isPickList) { notPicklists.push(f.name); continue; }
      picklists[f.name] = (f.picklistValues ?? []).filter((v) => v.isActive !== false)
        .map((v) => ({ value: v.value, label: v.label, ...(v.parentValue ? { parentValue: v.parentValue } : {}) }));
    }
    return { entity, picklists, unknownFields, notPicklists };
  }

  /**
   * Move a ticket to another contract, and (by default) the ticket's time
   * entries that sit on the OLD contract or on NO contract — a ticket's
   * contractID doesn't carry its labor with it. DRY RUN unless dryRun:false.
   * Validates the contract (exists, same company, active unless
   * allowInactive), never touches posted entries, flags entries outside the
   * contract's dates, then re-reads the ticket and entries to verify.
   */
  async setTicketContract(opts: { ticketID: number; contractID: number; fromContractID?: number; entries?: EntryScope; allowInactive?: boolean; dryRun?: boolean }): Promise<Record<string, unknown>> {
    const http = await this.ensureClient();
    const scope: EntryScope = opts.entries ?? 'old_or_none';
    const t = await http.get<TicketContractRow & { title?: string; status?: number }>('Tickets', opts.ticketID);
    if (!t) return { status: 'not_found', ticketID: opts.ticketID };
    const contractFields = ['id', 'companyID', 'contractName', 'contractNumber', 'status', 'contractType', 'startDate', 'endDate'];
    const ids = [...new Set([opts.contractID, t.contractID, opts.fromContractID].filter((x): x is number => x != null).map(Number))];
    const contracts = await http.query<ContractRow>('Contracts', [{ op: 'in', field: 'id', value: ids }], { maxRecords: 5, includeFields: contractFields });
    const target = contracts.find((c) => Number(c.id) === Number(opts.contractID)) ?? null;
    const oldRef = opts.fromContractID ?? t.contractID;
    const old = oldRef != null ? contracts.find((c) => Number(c.id) === Number(oldRef)) ?? null : null;
    const entries = await http.query<EntryRow>('TimeEntries', [{ op: 'eq', field: 'ticketID', value: opts.ticketID }], { maxRecords: 500, includeFields: ['id', 'contractID', 'dateWorked', 'hoursWorked', 'isNonBillable', 'billingApprovalDateTime'] });
    const plan = planContractMove(t, target, entries, scope, { ...(opts.allowInactive ? { allowInactive: true } : {}), ...(opts.fromContractID != null ? { fromContractID: opts.fromContractID } : {}) });
    const summary = (c: ContractRow | null) => (c ? { id: Number(c.id), name: c.contractName ?? null, number: c.contractNumber ?? null, status: c.status === 1 ? 'Active' : c.status === 0 ? 'Inactive' : c.status ?? null, startDate: c.startDate ?? null, endDate: c.endDate ?? null } : null);
    const base = { ticketID: opts.ticketID, ticketNumber: t.ticketNumber ?? null, from: summary(old) ?? (oldRef != null ? { id: Number(oldRef) } : null), ticketAlreadyOnTarget: Number(t.contractID) === Number(opts.contractID), to: summary(target), entryScope: scope, plan };
    if (plan.errors.length) return { ...base, status: 'validation_failed' };
    const toMove = plan.entries.filter((e) => e.action === 'move');
    if (!plan.ticketPatch && !toMove.length) return { ...base, status: 'nothing_to_change' };
    if (opts.dryRun !== false) return { ...base, status: 'dry_run' };

    const results: { ticket?: string; entries: Array<{ id: number; ok: boolean; error?: string }> } = { entries: [] };
    if (plan.ticketPatch) {
      try { await this.updateTicket(opts.ticketID, plan.ticketPatch as Partial<AutotaskTicket>); results.ticket = 'updated'; }
      catch (e) { return { ...base, status: 'failed', error: `ticket update failed — nothing changed: ${e instanceof Error ? e.message : String(e)}` }; }
    }
    for (const e of toMove) {
      try { await this.updateTimeEntry(e.id, { contractID: opts.contractID } as Partial<AutotaskTimeEntry>); results.entries.push({ id: e.id, ok: true }); }
      catch (err) { const c = classifyTimeEntryWriteError(err); results.entries.push({ id: e.id, ok: false, error: c ? `${c.status}: ${c.reason}` : (err instanceof Error ? err.message : String(err)) }); }
    }
    // Verify from Autotask, not from what we sent.
    const after = await http.get<TicketContractRow>('Tickets', opts.ticketID);
    const afterEntries = await http.query<EntryRow>('TimeEntries', [{ op: 'eq', field: 'ticketID', value: opts.ticketID }], { maxRecords: 500, includeFields: ['id', 'contractID'] });
    const movedIds = new Set(toMove.map((e) => e.id));
    const verified = {
      ticketContractID: after?.contractID ?? null,
      ticketOk: Number(after?.contractID) === Number(opts.contractID),
      entriesOnTarget: afterEntries.filter((e) => Number(e.contractID) === Number(opts.contractID)).map((e) => Number(e.id)),
      entriesNotMoved: afterEntries.filter((e) => movedIds.has(Number(e.id)) && Number(e.contractID) !== Number(opts.contractID)).map((e) => Number(e.id)),
    };
    const ok = verified.ticketOk && verified.entriesNotMoved.length === 0;
    return { ...base, status: ok ? 'updated' : 'partial', results, verified };
  }

  /**
   * Idempotency primitive (§9): find the ticket(s) carrying a given externalID
   * (occurrence key). Returns the full matching records (NOT run through the
   * aggressive optimizer, so `externalID` is preserved) so a controller can
   * confirm an occurrence already exists before creating a duplicate. externalID
   * is not enforced-unique by Autotask, so all matches are returned.
   */
  async findTicketByExternalId(externalID: string): Promise<AutotaskTicket[]> {
    const http = await this.ensureClient();
    return http.query<AutotaskTicket>(
      'Tickets',
      [{ op: 'eq', field: 'externalID', value: externalID }],
      { maxRecords: 25 }
    );
  }

  // =====================================================
  // TicketAdditionalConfigurationItems (§8) — link extra CIs to a ticket beyond
  // the primary configurationItemID. Live schema: exactly {id, ticketID,
  // configurationItemID}; top-level queryable/creatable/deletable.
  // =====================================================

  /** List the additional-CI associations on a ticket, optionally one CI. */
  async searchTicketConfigurationItems(
    ticketID: number,
    configurationItemID?: number
  ): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [{ op: 'eq', field: 'ticketID', value: ticketID }];
    pushEq(filters, 'configurationItemID', configurationItemID);
    return http.query<Record<string, any>>('TicketAdditionalConfigurationItems', filters, { maxRecords: 500 });
  }

  /** Link an additional CI to a ticket; returns the new association id. */
  async addTicketConfigurationItem(ticketID: number, configurationItemID: number): Promise<number> {
    const http = await this.ensureClient();
    const id = await http.create('TicketAdditionalConfigurationItems', { ticketID, configurationItemID });
    this.logger.info(`Linked CI ${configurationItemID} to ticket ${ticketID} (association ${id})`);
    return id;
  }

  /** Remove an additional-CI association by its association id (destructive). */
  async removeTicketConfigurationItem(associationID: number): Promise<void> {
    const http = await this.ensureClient();
    await http.delete('TicketAdditionalConfigurationItems', associationID);
    this.logger.info(`Removed ticket additional-CI association ${associationID}`);
  }

  /**
   * Convenience create (§7): create a ticket, then link one or more additional
   * configuration items, then read the ticket and its CI associations back
   * (§12 read-after-write). The created ticket's id is authoritative — a CI link
   * that fails is recorded per-item rather than aborting (the ticket already
   * exists; failing the whole call would invite a duplicate on retry). Returns
   * the enriched result the tool surfaces.
   */
  async createTicketWithConfigurationItems(
    ticket: Partial<AutotaskTicket>,
    additionalConfigurationItemIDs: number[]
  ): Promise<{
    id: number;
    item: AutotaskTicket | null;
    additionalConfigurationItems: Array<Record<string, any>>;
    linkErrors: Array<{ configurationItemID: number; error: string }>;
  }> {
    const id = await this.createTicket(ticket);
    const linkErrors: Array<{ configurationItemID: number; error: string }> = [];
    for (const ciID of additionalConfigurationItemIDs) {
      try {
        await this.addTicketConfigurationItem(id, ciID);
      } catch (error) {
        linkErrors.push({ configurationItemID: ciID, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // Read-after-write: surface the persisted ticket and its associations.
    let item: AutotaskTicket | null = null;
    let additionalConfigurationItems: Array<Record<string, any>> = [];
    try { item = await this.getTicket(id, true); } catch { /* read-back is best-effort; id stays authoritative */ }
    try { additionalConfigurationItems = await this.searchTicketConfigurationItems(id); } catch { /* best-effort */ }
    return { id, item, additionalConfigurationItems, linkErrors };
  }

  /** The active locations for a company; the primary is preferred by callers. */
  async searchCompanyLocations(companyID: number): Promise<AutotaskCompanyLocation[]> {
    const http = await this.ensureClient();
    return http.query<AutotaskCompanyLocation>(
      'CompanyLocations',
      [
        { op: 'eq', field: 'companyID', value: companyID },
        { op: 'eq', field: 'isActive', value: true },
      ],
      { maxRecords: 200 }
    );
  }

  /** Resolve a company's primary active location (falls back to the first active). */
  async resolvePrimaryCompanyLocation(companyID: number): Promise<AutotaskCompanyLocation | null> {
    const locations = await this.searchCompanyLocations(companyID);
    if (locations.length === 0) return null;
    return locations.find((l) => l.isPrimary === true) ?? locations[0];
  }

  /**
   * Move a ticket to another company safely (brief §4.6). Changing companyID
   * alone leaves an incompatible companyLocationID, so this resolves the target
   * company's primary location and sets both together. It refuses to move a
   * ticket linked to a configuration item (§7.12 — that can break the
   * RMM-to-Autotask device relationship) unless force is set, and clears the
   * contact unless a target contact is supplied. Reads back to verify.
   *
   * companyLocationID: a specific location of the TARGET company (e.g. the
   * matched contact's site) instead of the primary one — refused if it isn't
   * one of the target company's locations.
   * Contract: a contract belongs to one company, so when the ticket's contract
   * isn't the target company's, contract + service + bundle are cleared as part
   * of the move and reported in `contractCleared` (n8n's Blackpoint sorting
   * flow did this through raw_request, bypassing the financial gate; here it is
   * validated and reported).
   */
  async moveTicketToCompany(
    ticketId: number,
    targetCompanyID: number,
    opts: {
      contactID?: number | undefined; force?: boolean | undefined; companyLocationID?: number | undefined;
      /** Routing sent in the SAME write as the company (one update, one workflow-rule firing). */
      also?: { queueID?: number | undefined; status?: number | undefined; assignedResourceID?: number | undefined; assignedResourceRoleID?: number | undefined; userDefinedFields?: Array<{ name: string; value: unknown }> | undefined } | undefined;
    } = {}
  ): Promise<Record<string, unknown>> {
    const also = opts.also ?? {};
    if ((also.assignedResourceID != null) !== (also.assignedResourceRoleID != null)) {
      throw new Error('assignedResourceID and assignedResourceRoleID go together; ticket not moved.');
    }
    const ticket = await this.getTicket(ticketId, true);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found.`);

    const currentCI = (ticket as Record<string, any>).configurationItemID;
    if (currentCI != null && opts.force !== true) {
      return {
        status: 'blocked',
        reason: 'configuration-item-linked',
        ticketId,
        configurationItemID: currentCI,
        message:
          `Ticket ${ticketId} is linked to configuration item ${currentCI}; moving companies ` +
          `could break the RMM-to-Autotask device relationship. Not moved. Detach the CI first, ` +
          `or pass force:true to override (not recommended).`,
      };
    }

    let location: AutotaskCompanyLocation | null;
    if (opts.companyLocationID != null) {
      const wanted = Number(opts.companyLocationID);
      location = (await this.searchCompanyLocations(targetCompanyID)).find((l) => Number(l.id) === wanted) ?? null;
      if (!location) {
        throw new Error(`Location ${wanted} is not a location of company ${targetCompanyID}; ticket ${ticketId} not moved.`);
      }
    } else {
      location = await this.resolvePrimaryCompanyLocation(targetCompanyID);
    }
    if (!location || location.id == null) {
      throw new Error(
        `Target company ${targetCompanyID} has no active location; cannot move ticket ${ticketId} ` +
        `safely (companyLocationID would be incompatible).`
      );
    }

    const updates: Record<string, any> = {
      companyID: targetCompanyID,
      companyLocationID: location.id,
    };
    // Clear the contact unless a target-company contact is supplied — a contact
    // from the old company is invalid on the new one (§7.6).
    updates.contactID = opts.contactID != null ? opts.contactID : null;

    // A contract belongs to one company: keep it only if it is the target company's.
    const t = ticket as unknown as Record<string, unknown>;
    let contractCleared: Record<string, unknown> | null = null;
    if (t.contractID != null) {
      let contractCompany: number | null = null;
      try {
        const http = await this.ensureClient();
        const c = await http.get<Record<string, unknown>>('Contracts', Number(t.contractID));
        contractCompany = c?.companyID != null ? Number(c.companyID) : null;
      } catch { /* unknown → treat as not the target's */ }
      if (contractCompany !== targetCompanyID) {
        updates.contractID = null;
        updates.contractServiceID = null;
        updates.contractServiceBundleID = null;
        contractCleared = {
          contractID: t.contractID, contractServiceID: t.contractServiceID ?? null, contractServiceBundleID: t.contractServiceBundleID ?? null,
          contractCompanyID: contractCompany, reason: 'the contract belongs to another company',
        };
      }
    }

    const routed = (['queueID', 'status', 'assignedResourceID', 'assignedResourceRoleID'] as const).filter((k) => also[k] != null);
    for (const k of routed) updates[k] = Number(also[k]);
    const udfs = Array.isArray(also.userDefinedFields) ? also.userDefinedFields : [];
    if (udfs.length) updates.userDefinedFields = udfs.map((u) => ({ name: u.name, value: u.value == null ? null : String(u.value) }));

    await this.updateTicket(ticketId, updates);

    const after = (await this.getTicket(ticketId, true)) as Record<string, any> | null;
    const udfVal = (rec: Record<string, any> | null, name: string) => (rec?.userDefinedFields as Array<{ name: string; value: unknown }> | undefined)?.find((u) => u.name === name)?.value ?? null;
    const routing = [
      ...routed.map((k) => ({ field: k, to: after?.[k] ?? null, applied: after != null && Number(after[k]) === Number(updates[k]) })),
      ...udfs.map((u) => { const got = udfVal(after, u.name); return { field: `udf:${u.name}`, to: got, applied: String(got ?? '') === String(u.value ?? '') }; }),
    ];
    const verified =
      after != null && after.companyID === targetCompanyID && after.companyLocationID === location.id &&
      (opts.contactID == null || Number(after.contactID) === Number(opts.contactID)) &&
      (!contractCleared || after.contractID == null) &&
      routing.every((r) => r.applied);

    return {
      status: verified ? 'updated' : 'failed-verification',
      ticketId,
      companyID: after?.companyID,
      companyLocationID: after?.companyLocationID,
      locationSource: opts.companyLocationID != null ? 'given' : 'primary',
      contactID: after?.contactID,
      contractID: after?.contractID ?? null,
      ...(contractCleared ? { contractCleared } : {}),
      ...(routing.length ? { routing } : {}),
      verified,
      message: verified
        ? `Ticket ${ticketId} moved to company ${targetCompanyID} (location ${location.id}${opts.companyLocationID != null ? '' : ', primary'}${contractCleared ? `; contract ${String(contractCleared.contractID)} cleared — it belongs to another company` : ''}).`
        : `Ticket ${ticketId} move did not verify — check company/location/contact/contract${routing.some((r) => !r.applied) ? ` and ${routing.filter((r) => !r.applied).map((r) => r.field).join(', ')}` : ''} on the ticket.`,
    };
  }

  // =====================================================
  // Ticket Charges (child of Tickets for create/delete)
  // =====================================================

  async getTicketCharge(id: number): Promise<AutotaskTicketCharge | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting ticket charge with ID: ${id}`);
      return await http.get<AutotaskTicketCharge>('TicketCharges', id);
    } catch (error) {
      this.logger.error(`Failed to get ticket charge ${id}:`, error);
      throw error;
    }
  }

  async searchTicketCharges(options: AutotaskQueryOptionsExtended & { ticketId?: number; ticketIds?: number[]; isBilled?: boolean; purchasedAfter?: string } = {}): Promise<AutotaskTicketCharge[]> {
    try {
      this.logger.debug('Searching ticket charges with options:', options);
      const filters: QueryFilter[] = [];
      if (options.ticketId != null) filters.push({ op: 'eq', field: 'ticketID', value: options.ticketId });
      // Many tickets in one call (a billing check over a month's tickets), instead of one search per ticket.
      const ids = Array.isArray(options.ticketIds) ? [...new Set(options.ticketIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500) : [];
      if (ids.length) filters.push({ op: 'in', field: 'ticketID', value: ids });
      if (typeof options.isBilled === 'boolean') filters.push({ op: 'eq', field: 'isBilled', value: options.isBilled });
      // datePurchased is the mirror's window field: a dated check is answered from Postgres.
      if (options.purchasedAfter) filters.push({ op: 'gte', field: 'datePurchased', value: options.purchasedAfter });
      const pageSize = options.pageSize || (filters.length > 0 ? (ids.length ? 500 : 25) : 10);
      // queryPaged: served from the Postgres shadow when it mirrors TicketCharges and is fresh (0 Autotask calls).
      const r = await this.queryPaged<AutotaskTicketCharge>('TicketCharges', filters.length > 0 ? filters : MATCH_ALL, { pageSize }, { defaultPageSize: 25, maxPageSize: 500 });
      return r.items;
    } catch (error) {
      this.logger.error('Failed to search ticket charges:', error);
      throw error;
    }
  }

  /**
   * Ticket-charge report: charges in a window with a status/billed breakdown,
   * total billable, and a per-ticket rollup. `unbilledOnly` surfaces the to-bill
   * queue; optional company/status filters.
   */
  async getTicketChargesReport(
    opts: { sinceDays?: number; status?: number; unbilledOnly?: boolean; companyID?: number } = {}
  ): Promise<Record<string, any>> {
    const http = await this.ensureClient();
    const since = new Date(Date.now() - (opts.sinceDays ?? 90) * 864e5).toISOString();
    const filters: QueryFilter[] = [{ op: 'gte', field: 'createDate', value: since }];
    if (opts.status !== undefined) filters.push({ op: 'eq', field: 'status', value: opts.status });
    const charges = await http.query<ChargeRow & { ticketID: number }>('TicketCharges', filters, {
      includeFields: ['id', 'ticketID', 'name', 'status', 'isBilled', 'billableAmount', 'extendedCost', 'unitQuantity'],
      maxRecords: 3000,
    });

    // Join tickets for number + company (and to filter by company when requested).
    const ticketIds = [...new Set(charges.map((c) => c.ticketID).filter((x) => x != null))];
    const ticketsById: Record<string, { id: number; ticketNumber?: string; companyID?: number }> = {};
    for (let i = 0; i < ticketIds.length; i += 200) {
      const rows = await http.query<{ id: number; ticketNumber?: string; companyID?: number }>('Tickets', [{ op: 'in', field: 'id', value: ticketIds.slice(i, i + 200) }], {
        includeFields: ['id', 'ticketNumber', 'companyID'],
        maxRecords: 500,
      });
      for (const r of rows) ticketsById[String(r.id)] = r;
    }
    const companyIds = [...new Set(Object.values(ticketsById).map((t) => t.companyID).filter((x): x is number => x != null))];
    const companyName: Record<string, string> = {};
    for (let i = 0; i < companyIds.length; i += 200) {
      const rows = await http.query<{ id: number; companyName?: string }>('Companies', [{ op: 'in', field: 'id', value: companyIds.slice(i, i + 200) }], { includeFields: ['id', 'companyName'], maxRecords: 500 });
      for (const r of rows) companyName[String(r.id)] = r.companyName ?? '';
    }

    const enriched: ChargeRow[] = [];
    for (const c of charges) {
      const t = ticketsById[String(c.ticketID)];
      if (opts.companyID !== undefined && t?.companyID !== opts.companyID) continue;
      enriched.push({
        ...c,
        ...(t?.ticketNumber ? { ticketNumber: t.ticketNumber } : {}),
        ...(t?.companyID != null && companyName[String(t.companyID)] ? { company: companyName[String(t.companyID)] } : {}),
      });
    }
    return summarizeTicketCharges(enriched, { unbilledOnly: !!opts.unbilledOnly });
  }

  /**
   * Unbilled-work / revenue-leakage report. Uninvoiced billable BillingItems
   * (invoiceID absent, nonBillable false) aged into buckets, with at-risk (>30d)
   * totals and a per-company rollup — catches billable time/charges that age out
   * unbilled because accounting only reviews recent items. Optional company filter
   * and minimum age.
   */
  async getUnbilledReport(opts: { companyID?: number; minAgeDays?: number } = {}): Promise<Record<string, any>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [
      { op: 'notExist', field: 'invoiceID' },
      { op: 'eq', field: 'nonBillable', value: false },
    ];
    if (opts.companyID !== undefined) filters.push({ op: 'eq', field: 'companyID', value: opts.companyID });
    const items = await http.query<UnbilledItem>('BillingItems', filters, {
      includeFields: ['id', 'itemDate', 'postedDate', 'totalAmount', 'extendedPrice', 'timeEntryID', 'ticketChargeID', 'contractID', 'ticketID', 'companyID'],
      maxRecords: 20000,
    });

    const asOf = new Date();
    let scoped = items;
    if (opts.minAgeDays !== undefined) {
      scoped = items.filter((it) => {
        const d = it.itemDate ?? it.postedDate;
        return d ? (asOf.getTime() - new Date(d).getTime()) / 864e5 >= opts.minAgeDays! : false;
      });
    }

    const companyIds = [...new Set(scoped.map((i) => i.companyID).filter((x): x is number => x != null))];
    const companyName: Record<string, string> = {};
    for (let i = 0; i < companyIds.length; i += 200) {
      const rows = await http.query<{ id: number; companyName?: string }>('Companies', [{ op: 'in', field: 'id', value: companyIds.slice(i, i + 200) }], { includeFields: ['id', 'companyName'], maxRecords: 500 });
      for (const r of rows) companyName[String(r.id)] = r.companyName ?? '';
    }
    for (const it of scoped) if (it.companyID != null && companyName[String(it.companyID)]) it.company = companyName[String(it.companyID)];

    return summarizeUnbilled(scoped, asOf);
  }

  async createTicketCharge(charge: Partial<AutotaskTicketCharge>): Promise<number> {
    const http = await this.ensureClient();
    try {
      if (!charge.ticketID) {
        throw new Error('ticketID is required to create a ticket charge');
      }
      this.logger.debug('Creating ticket charge:', charge);
      // TicketCharges is a child entity — create via parent URL.
      const id = await http.childCreate('Tickets', charge.ticketID, 'Charges', charge);
      this.logger.info(`Ticket charge created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create ticket charge:', error);
      throw error;
    }
  }

  async updateTicketCharge(id: number, updates: Partial<AutotaskTicketCharge>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating ticket charge ${id}:`, updates);
      await http.update('TicketCharges', id, updates as Record<string, any>);
      this.logger.info(`Ticket charge ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update ticket charge ${id}:`, error);
      throw error;
    }
  }

  async deleteTicketCharge(ticketId: number, chargeId: number): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Deleting ticket charge ${chargeId} from ticket ${ticketId}`);
      await http.childDelete('Tickets', ticketId, 'Charges', chargeId);
      this.logger.info(`Ticket charge ${chargeId} deleted successfully`);
    } catch (error) {
      this.logger.error(`Failed to delete ticket charge ${chargeId}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Ticket History (read-only audit trail of field changes)
  // =====================================================

  async getTicketHistory(id: number): Promise<AutotaskTicketHistory | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting ticket history entry with ID: ${id}`);
      return await http.get<AutotaskTicketHistory>('TicketHistory', id);
    } catch (error) {
      this.logger.error(`Failed to get ticket history entry ${id}:`, error);
      throw error;
    }
  }

  async searchTicketHistory(options: AutotaskQueryOptionsExtended & { ticketId?: number } = {}): Promise<AutotaskTicketHistory[]> {
    // Autotask requires a ticketID filter for TicketHistory queries — surface
    // a friendly error instead of letting the API reject with a generic 400.
    // Guard before ensureClient() so callers fail fast without a network round-trip.
    if (!options.ticketId) {
      throw new Error('ticketId is required to search ticket history');
    }
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching ticket history with options:', options);
      const filters: QueryFilter[] = [
        { op: 'eq', field: 'ticketID', value: options.ticketId },
      ];
      return await http.query<AutotaskTicketHistory>(
        'TicketHistory',
        filters,
        { maxRecords: Math.min(options.pageSize || 50, 500) }
      );
    } catch (error) {
      this.logger.error('Failed to search ticket history:', error);
      throw error;
    }
  }

  // =====================================================
  // Time Entries
  // =====================================================

  /**
   * Resolve a resource's IANA timezone, mirroring how the Autotask UI applies
   * the user's location timezone: Resource has no direct tz — it carries a
   * locationID → InternalLocation.timeZone (a Windows/.NET name) → IANA.
   * Cached per resource (locations are few and stable). Returns undefined when
   * the resource, location, or mapping can't be resolved (caller then leaves
   * the timestamp naive).
   */
  private resourceTimeZoneCache = new Map<number, string | null>();
  async resolveResourceTimeZone(resourceID: number): Promise<string | undefined> {
    if (this.resourceTimeZoneCache.has(resourceID)) {
      return this.resourceTimeZoneCache.get(resourceID) ?? undefined;
    }
    let iana: string | null = null;
    try {
      const http = await this.ensureClient();
      const resource = await http.get<Record<string, any>>('Resources', resourceID);
      const locationID = resource?.locationID;
      if (locationID != null) {
        const locs = await http.query<Record<string, any>>(
          'InternalLocations',
          [{ op: 'eq', field: 'id', value: locationID }],
          { maxRecords: 1, includeFields: ['id', 'timeZone'] }
        );
        iana = windowsToIana(locs?.[0]?.timeZone);
      }
    } catch (e) {
      this.logger.debug(`resolveResourceTimeZone(${resourceID}) failed, leaving naive:`, e);
    }
    this.resourceTimeZoneCache.set(resourceID, iana);
    return iana ?? undefined;
  }

  async createTimeEntry(timeEntry: Partial<AutotaskTimeEntry> & { timeZone?: string }): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating time entry:', timeEntry);

      // Autotask TimeEntries are a TOP-LEVEL entity: POST /TimeEntries with the
      // parent id in the body. The child routes /Tickets|Tasks/{id}/TimeEntries
      // return HTTP 404 (verified live against the tenant — the old child-route
      // path was broken; issue #72). TimeEntries carries `ticketID` and `taskID`
      // but has NO `projectID` field — project work is logged against a project
      // TASK (taskID), not the project directly — so projectID is dropped and a
      // project-only request is rejected with a clear message.
      // `timeZone` is an INPUT hint (IANA or Windows name), never an Autotask
      // field — strip it from the body regardless of how timestamps resolve.
      const { projectID, timeZone, ...body } = timeEntry as Record<string, any>;
      if (projectID != null && body.ticketID == null && body.taskID == null) {
        throw new Error(
          'Autotask time entries attach to a ticket or a project TASK, not a project directly — ' +
          'pass taskID (a task on the project) or ticketID instead of projectID.'
        );
      }
      // Timezone context (opt-in): explicit timeZone wins, else the resource's
      // location timezone (mirrors the UI). Only used to convert LOCAL (offset-
      // less) timestamps; offset-aware timestamps already pin the instant, and
      // when neither a tz nor an offset is present we keep the naive string
      // (unchanged legacy behavior — no surprise shifts).
      let effectiveTz: string | undefined = timeZone;
      if (!effectiveTz && body.resourceID != null) {
        effectiveTz = await this.resolveResourceTimeZone(body.resourceID);
      }
      // Service-desk ticket time (and task time) requires a start AND stop time —
      // Autotask rejects hours-only with "Service tickets require a start and stop
      // time." Reconcile the span so a caller can log ONE entry (a full day, a
      // billing offset for lunch, or a span across midnight) instead of splitting.
      // Naive local datetime strings (no Z) to avoid a TZ date shift.
      if (body.ticketID != null || body.taskID != null) {
        const addDaysISO = (d: string, n: number): string => {
          if (!n) return d;
          const dt = new Date(`${d}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() + n);
          return dt.toISOString().slice(0, 10);
        };
        const startMs = body.startDateTime ? Date.parse(String(body.startDateTime)) : NaN;
        const endMs = body.endDateTime ? Date.parse(String(body.endDateTime)) : NaN;
        // Full span given → derive hoursWorked (total span) when the caller omitted it.
        if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs && body.hoursWorked == null) {
          body.hoursWorked = Math.round(((endMs - startMs) / 3_600_000) * 100) / 100;
        }
        // Only hours given → derive a span on the work date, rolling past midnight.
        if ((!body.startDateTime || !body.endDateTime) && body.hoursWorked != null && body.dateWorked) {
          const d = String(body.dateWorked).slice(0, 10);
          const startMin = 9 * 60; // default 09:00
          const endTotal = startMin + Math.max(0, Math.round(Number(body.hoursWorked) * 60));
          const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          body.startDateTime = `${d}T09:00:00`;
          body.endDateTime = `${addDaysISO(d, Math.floor(endTotal / 1440))}T${hhmm(endTotal % 1440)}:00`;
        }
        // Timezone-normalize provided/derived timestamps to a UTC instant:
        //  - offset-aware (…-04:00 / …Z) -> that exact instant as UTC
        //  - local + a known tz (explicit, else the resource's location tz) ->
        //    converted to UTC (DST-correct), matching how the UI interprets time
        //  - local with no resolvable tz -> left naive (legacy behavior)
        if (body.startDateTime) body.startDateTime = normalizeTimestamp(String(body.startDateTime), effectiveTz);
        if (body.endDateTime) body.endDateTime = normalizeTimestamp(String(body.endDateTime), effectiveTz);
      }
      // hoursToBill is READ-ONLY (TimeEntries entityInformation, verified live
      // 2026-09-29): Autotask derives it from hoursWorked − offsetHours plus the
      // contract/work-type rounding, and silently ignores a supplied value. Never
      // send it, so nothing implies it was honoured. Use offsetHours to bill less.
      delete body.hoursToBill;
      const id = await http.create('TimeEntries', body);
      this.logger.info(`Time entry created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create time entry:', error);
      throw error;
    }
  }

  async getTimeEntries(options: AutotaskQueryOptions = {}): Promise<AutotaskTimeEntry[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Getting time entries with options:', options);
      const pageSize = Math.min(options.pageSize || 25, 500);
      const filter: QueryFilter[] =
        Array.isArray(options.filter) && options.filter.length > 0
          ? (options.filter as QueryFilter[])
          : MATCH_ALL;
      return await http.query<AutotaskTimeEntry>('TimeEntries', filter, { maxRecords: pageSize });
    } catch (error) {
      this.logger.error('Failed to get time entries:', error);
      throw error;
    }
  }

  /**
   * Get a single time entry (§4.8). The returned record distinguishes actual
   * worked time (`hoursWorked`) from Autotask's billing-rounded time
   * (`hoursToBill`), so callers can read both after a create.
   */
  async getTimeEntry(id: number): Promise<AutotaskTimeEntry | null> {
    const http = await this.ensureClient();
    try {
      return await http.get<AutotaskTimeEntry>('TimeEntries', id);
    } catch (error) {
      this.logger.error(`Failed to get time entry ${id}:`, error);
      throw error;
    }
  }

  /**
   * Best-effort read-only check of whether a resource's timesheet is locked for
   * a given work date. Degrades to 'unknown' on any lookup failure (the
   * authoritative gate is Autotask's own error on write/delete, mapped via
   * classifyLockError). No timesheet row for the week => 'open'.
   */
  /**
   * Assess the lock state of a time entry from what the REST API can actually
   * SEE ahead of time: only `billingApprovalDateTime` (posted / contract
   * auto-approve). The submitted/approved TIMESHEET lock, the owner-only rule,
   * and the owner's delete permission are NOT exposed by the API (there is no
   * timesheet entity and no lock field on TimeEntry) — those surface only when
   * the delete is attempted and are mapped by classifyLockError. So a
   * non-posted entry returns state 'open' with `preflightOnly: true` to signal
   * that further locks can still be enforced at execution.
   */
  async assessTimeEntryLock(entry: Partial<AutotaskTimeEntry>): Promise<{
    locked: boolean;
    state: TimeEntryLockState;
    reason?: string;
    preflightOnly?: boolean;
  }> {
    if ((entry as any).billingApprovalDateTime != null) {
      return { locked: true, state: 'billing_posted', reason: lockReason('billing_posted') };
    }
    // Not posted — no other lock is knowable pre-flight (no timesheet entity /
    // no lock field). Enforced at execution via classifyLockError.
    return { locked: false, state: 'open', preflightOnly: true };
  }

  /**
   * Unbilled-TIME leakage: billable time entries not yet approved for billing
   * (billingApprovalDateTime not set), so they can't reach an invoice until
   * approved. Per resource, aged by dateWorked, valued at the role's bill rate
   * (Roles.hourlyRate) with hours-missing-rate surfaced separately. Complements
   * report_unbilled (posted-but-not-invoiced BillingItems). Read-only.
   */
  async reportUnbilledTime(opts: { fromDate?: string; toDate?: string; resourceID?: number; includeApproved?: boolean } = {}): Promise<UnbilledTimeSummary> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [{ op: 'eq', field: 'isNonBillable', value: false }];
    // Guardrail: default to the last 365 days so an unbounded call can't trigger
    // a full-history scan. Pass fromDate explicitly to widen.
    const effectiveFrom = opts.fromDate ?? new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    filters.push({ op: 'gte', field: 'dateWorked', value: `${effectiveFrom.slice(0, 10)}T00:00:00` });
    if (opts.toDate) filters.push({ op: 'lte', field: 'dateWorked', value: `${opts.toDate.slice(0, 10)}T23:59:59` });
    if (opts.resourceID != null) filters.push({ op: 'eq', field: 'resourceID', value: opts.resourceID });
    // Unapproved = the pre-invoice leak. notExist for nulls (eq null matches nothing in Autotask).
    if (!opts.includeApproved) filters.push({ op: 'notExist', field: 'billingApprovalDateTime' });

    const includeFields = ['id', 'resourceID', 'roleID', 'dateWorked', 'createDateTime', 'hoursWorked', 'hoursToBill', 'isNonBillable', 'billingApprovalDateTime', 'ticketID', 'taskID', 'contractID'];
    const entries: Array<Record<string, any>> = [];
    let lastId = 0;
    for (let page = 0; page < 40; page++) {
      const batch = await http.query<Record<string, any>>(
        'TimeEntries',
        [...filters, { op: 'gt', field: 'id', value: lastId }],
        { maxRecords: 500, includeFields }
      );
      if (!batch || batch.length === 0) break;
      batch.sort((a, b) => Number(a.id) - Number(b.id));
      entries.push(...batch);
      lastId = Number(batch[batch.length - 1].id);
      if (batch.length < 500) break;
    }

    // Resolve role bill rates + resource names for the ids actually present.
    const rateByRole = new Map<number, number>();
    try {
      const roles = await this.searchRoles({ pageSize: 500 });
      for (const r of roles) if (r.id != null && r.hourlyRate != null) rateByRole.set(Number(r.id), Number(r.hourlyRate));
    } catch { /* rates are a nicety; value falls to hoursMissingRate */ }
    const nameByResource = new Map<number, string>();
    const resourceIDs = [...new Set(entries.map((e) => Number(e.resourceID)).filter((n) => Number.isFinite(n)))];
    for (let i = 0; i < resourceIDs.length; i += 200) {
      try {
        const res = await http.query<Record<string, any>>('Resources', [{ op: 'in', field: 'id', value: resourceIDs.slice(i, i + 200) }], { maxRecords: 500, includeFields: ['id', 'firstName', 'lastName'] });
        for (const r of res) nameByResource.set(Number(r.id), `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim());
      } catch { /* names are a nicety */ }
    }

    // Contract labour-billing basis per entry, so no_contract time is surfaced
    // as its own bucket instead of being filtered out. Resolve the contractType
    // of the contracts actually referenced; entries with no contractID become
    // no_contract in the summary. The lookup is a nicety — if it fails the
    // rollup is simply omitted (hours are never lost).
    const basisByContract = new Map<number, LabourBasis>();
    const contractIDs = [...new Set(entries.map((e) => (e.contractID != null ? Number(e.contractID) : NaN)).filter((n) => Number.isFinite(n)))];
    for (let i = 0; i < contractIDs.length; i += 200) {
      try {
        const cs = await http.query<Record<string, any>>('Contracts', [{ op: 'in', field: 'id', value: contractIDs.slice(i, i + 200) }], { maxRecords: 500, includeFields: ['id', 'contractType'] });
        for (const c of cs) basisByContract.set(Number(c.id), classifyContractLabourBilling(c.contractType).basis);
      } catch { /* basis rollup is a nicety; omitted on failure */ }
    }
    const haveBasis = contractIDs.length === 0 || basisByContract.size > 0;
    return summarizeUnbilledTime(entries as UnbilledTimeEntry[], { rateByRole, nameByResource, ...(haveBasis ? { basisByContract } : {}) });
  }

  /**
   * DELETE a time entry (top-level entity). Autotask permits a time entry to be
   * deleted only BY THE RESOURCE WHO OWNS IT — even an admin/API user cannot
   * delete another user's time directly (confirmed in the UI). So when
   * `asResourceID` is given we tunnel the delete via native impersonation
   * (ImpersonationResourceId = the owner) for the duration of the call. Requires
   * the API user's security level to allow impersonation and the owner to be an
   * ACTIVE, non-API, non-system resource. Lock errors are re-thrown for the
   * caller to map.
   */
  async deleteTimeEntry(id: number, opts?: { asResourceID?: number }): Promise<void> {
    const http = await this.ensureClient();
    const run = () => http.delete('TimeEntries', id);
    if (opts?.asResourceID != null) {
      const origin = getRequestOrigin();
      await runWithRequestContext(
        { impersonationResourceId: opts.asResourceID, ...(origin ? { origin } : {}) },
        run
      );
    } else {
      await run();
    }
    this.logger.info(`Time entry ${id} deleted${opts?.asResourceID != null ? ` (as resource ${opts.asResourceID})` : ''}`);
  }

  /** DELETE a project task via the child route (needs projectID, like update/complete). */
  async deleteTaskById(id: number, projectID: number): Promise<void> {
    const http = await this.ensureClient();
    await http.childDelete('Projects', projectID, 'Tasks', id);
    this.logger.info(`Task ${id} deleted (project ${projectID})`);
  }

  /**
   * Read-only inventory of everything attached to a task, for a guarded delete:
   * time entries, notes, attachments, secondary resources, and predecessor
   * dependencies (incoming + outgoing). Never deletes; never cascades.
   */
  async inspectTaskForDelete(id: number): Promise<{
    task: AutotaskTask | null;
    timeEntries: Array<Record<string, any>>;
    notes: Array<Record<string, any>>;
    attachments: Array<Record<string, any>>;
    secondaryResources: Array<Record<string, any>>;
    dependencies: Array<Record<string, any>>;
  }> {
    const http = await this.ensureClient();
    const [task, timeEntries, notes, attachments, secondaryResources, preds] = await Promise.all([
      this.getTask(id).catch(() => null),
      http.query<Record<string, any>>('TimeEntries', [{ op: 'eq', field: 'taskID', value: id }], { maxRecords: 500, includeFields: ['id', 'resourceID', 'dateWorked', 'hoursWorked'] }).catch(() => []),
      this.searchTaskNotes(id, { pageSize: 100 }).catch(() => [] as any[]),
      this.searchTaskAttachments(id, { pageSize: 100 }).catch(() => [] as any[]),
      this.listTaskResources(id).catch(() => [] as any[]),
      Promise.all([
        http.query<Record<string, any>>('TaskPredecessors', [{ op: 'eq', field: 'predecessorTaskID', value: id }], { maxRecords: 200, includeFields: ['id', 'predecessorTaskID', 'successorTaskID', 'lagDays'] }).catch(() => []),
        http.query<Record<string, any>>('TaskPredecessors', [{ op: 'eq', field: 'successorTaskID', value: id }], { maxRecords: 200, includeFields: ['id', 'predecessorTaskID', 'successorTaskID', 'lagDays'] }).catch(() => []),
      ]).then(([outgoing, incoming]) => [...outgoing, ...incoming]),
    ]);
    return { task, timeEntries, notes, attachments, secondaryResources, dependencies: preds };
  }

  /** Update a time entry (§4.8) via the collection PATCH convention. */
  async updateTimeEntry(id: number, updates: Partial<AutotaskTimeEntry>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating time entry ${id}:`, updates);
      // hoursToBill is read-only (see createTimeEntry) — never send it.
      const { hoursToBill: _readOnly, ...writable } = updates;
      await http.update('TimeEntries', id, writable as Record<string, any>);
      this.logger.info(`Time entry ${id} updated`);
    } catch (error) {
      this.logger.error(`Failed to update time entry ${id}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Staff day / backfill (#42 slice 3). Primitives for a scheduled personal
  // assistant (ChatGPT) that reviews the day (calendar/meetings/emails elsewhere)
  // and backfills Autotask. The MCP owns HOW to read "what's mine / already
  // logged" and to write time idempotently — not the agenda-matching reasoning.
  // =====================================================

  /**
   * A resource's working picture for a date (default today): the tickets
   * assigned to them, the time they've already logged that day, their open
   * tasks, their service calls that day, their open To-Dos due by that day,
   * and the GAPS — service-call tickets with no time logged — so the assistant
   * backfills only what's missing instead of re-logging.
   *
   * Fail-soft — each section is independent; a failed section is recorded
   * under `errors` rather than failing the whole read. Sections run ONE AT A
   * TIME: a parallel fan-out per call is the burst pattern #149 removed.
   *
   * The day is the resource's LOCAL day — `timeZone`, else their location
   * timezone, else the tenant default — so evening work isn't pushed onto the
   * next UTC day. "Today" is local today; datetimes are windowed on local
   * midnight-to-midnight; time entries match on dateWorked (already a date).
   */
  async getMyDay(
    resourceID: number,
    date?: string,
    timeZone?: string
  ): Promise<Record<string, any>> {
    const tz = validTimeZone(timeZone) ?? (await this.resolveResourceTimeZone(resourceID)) ?? defaultTimeZone();
    const day = date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : dayIn(new Date(), tz);
    const { start: dayStart, end: dayEnd } = localDayWindow(day, tz);
    const errors: Array<{ section: string; error: string }> = [];
    const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try { return await fn(); } catch (e) { errors.push({ section: name, error: e instanceof Error ? e.message : String(e) }); return undefined; }
    };
    const http = await this.ensureClient();

    const assignedTickets = await section('assignedTickets', async () => (await this.searchTickets({ assignedResourceID: resourceID, pageSize: 100 } as any)).items);
    const timeEntries = await section('timeEntries', () => http.query<Record<string, any>>('TimeEntries', [
      { op: 'eq', field: 'resourceID', value: resourceID },
      { op: 'eq', field: 'dateWorked', value: day },
    ], { maxRecords: 500 }));
    const tasks = await section('tasks', async () => (await this.searchTasks({ assignedResourceID: resourceID, pageSize: 100 } as any)).items);
    const serviceCalls = await section('serviceCalls', () => this.myServiceCallsOn(resourceID, dayStart, dayEnd));
    // Open To-Dos starting in the TODO_WINDOW_DAYS up to the day. Not "every
    // open To-Do": never-completed ones pile up (a live tech had 500+, all 1–12
    // months old, nearly all ticket-linked), which buries today's in noise.
    const todos = await section('todos', () => http.query<Record<string, unknown>>('CompanyToDos', [
      { op: 'eq', field: 'assignedToResourceID', value: resourceID },
      { op: 'notExist', field: 'completedDate' },
      { op: 'gte', field: 'startDateTime', value: localDayWindow(addDays(day, -(TODO_WINDOW_DAYS - 1)), tz).start },
      { op: 'lte', field: 'startDateTime', value: dayEnd },
    ], { maxRecords: 100 }));

    const entries = timeEntries ?? [];
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const hrs = (e: any) => Number(e.hoursWorked) || 0;
    // Split by the three Autotask time-entry workflows so an EOD readback never
    // reports "0 hours" when ticket time is 0 but Regular Time exists.
    const ticketTime = entries.filter((e: any) => e.ticketID != null);
    const taskTime = entries.filter((e: any) => e.ticketID == null && e.taskID != null);
    const regularTime = entries.filter((e: any) => e.ticketID == null && e.taskID == null);
    const hoursLogged = entries.reduce((s, e: any) => s + hrs(e), 0);
    const billableHours = entries.filter((e: any) => !e.isNonBillable).reduce((s, e: any) => s + hrs(e), 0);
    const nonBillableHours = entries.filter((e: any) => e.isNonBillable).reduce((s, e: any) => s + hrs(e), 0);
    const calls = serviceCalls ?? [];
    // Gaps only when BOTH reads succeeded — a failed time read would make
    // every service-call ticket look like missing time.
    const missingTime = serviceCalls && timeEntries ? serviceCallTimeGaps(calls, ticketTime) : [];
    return {
      resourceID,
      date: day,
      timeZone: tz,
      dayWindow: { start: dayStart, end: dayEnd },
      assignedTickets: assignedTickets ?? [],
      timeEntries: entries,
      ticketTime,
      taskTime,
      regularTime,
      openTasks: tasks ?? [],
      serviceCalls: calls,
      openTodos: todos ?? [],
      todoWindowDays: TODO_WINDOW_DAYS,
      missingTime,
      totals: {
        assignedTickets: (assignedTickets ?? []).length,
        serviceCalls: calls.length,
        openTodos: (todos ?? []).length,
        missingTime: missingTime.length,
        timeEntries: entries.length,
        hoursLogged: r2(hoursLogged),
        ticketHours: r2(ticketTime.reduce((s, e: any) => s + hrs(e), 0)),
        taskHours: r2(taskTime.reduce((s, e: any) => s + hrs(e), 0)),
        regularHours: r2(regularTime.reduce((s, e: any) => s + hrs(e), 0)),
        billableHours: r2(billableHours),
        nonBillableHours: r2(nonBillableHours),
      },
      ...(errors.length ? { errors } : {}),
    };
  }

  /**
   * The resource's service calls starting inside [start, end]: calls in the
   * window → their tickets → the ticket-resource rows for THIS resource.
   * ServiceCalls carry no resource field, so it has to go call → ticket →
   * resource; scoping the calls by day first keeps each query small (the
   * resource's assignment history is unbounded). Three sequential queries.
   */
  private async myServiceCallsOn(resourceID: number, start: string, end: string): Promise<Array<MyServiceCall & { canceled: boolean }>> {
    const http = await this.ensureClient();
    const calls = await http.query<ServiceCallRow>('ServiceCalls', [
      { op: 'gte', field: 'startDateTime', value: start },
      { op: 'lte', field: 'startDateTime', value: end },
    ], { maxRecords: 200 });
    if (!calls.length) return [];
    const links = await http.query<{ id: number; serviceCallID: number; ticketID: number }>('ServiceCallTickets', [
      { op: 'in', field: 'serviceCallID', value: calls.map((c) => c.id) },
    ], { maxRecords: 500 });
    if (!links.length) return [];
    const mine = await http.query<{ serviceCallTicketID: number }>('ServiceCallTicketResources', [
      { op: 'in', field: 'serviceCallTicketID', value: links.map((l) => l.id) },
      { op: 'eq', field: 'resourceID', value: resourceID },
    ], { maxRecords: 500 });
    const myLinkIds = new Set(mine.map((m) => Number(m.serviceCallTicketID)));
    const ticketsByCall = new Map<number, number[]>();
    for (const l of links) {
      if (!myLinkIds.has(Number(l.id))) continue;
      const list = ticketsByCall.get(Number(l.serviceCallID)) ?? [];
      list.push(Number(l.ticketID));
      ticketsByCall.set(Number(l.serviceCallID), list);
    }
    return calls
      .filter((c) => ticketsByCall.has(Number(c.id)))
      .map((c) => ({
        serviceCallID: Number(c.id),
        startDateTime: c.startDateTime,
        endDateTime: c.endDateTime,
        durationHours: hoursBetween(c.startDateTime, c.endDateTime),
        isComplete: c.isComplete === true || c.isComplete === 1,
        canceled: c.canceledDateTime != null,
        ticketIDs: ticketsByCall.get(Number(c.id)) ?? [],
      }))
      .sort((a, b) => String(a.startDateTime ?? '').localeCompare(String(b.startDateTime ?? '')));
  }

  /** Active picklist values of an entity field (field info is cached for an hour). */
  async getPicklistValues(entityType: string, fieldName: string): Promise<PicklistValue[]> {
    const fields = await this.getFieldInfo(entityType);
    return fields.find((f) => f.name === fieldName)?.picklistValues ?? [];
  }

  /**
   * start_work_on_ticket (#21 §9): mark a ticket In Progress and, when it is
   * unassigned, assign it to the resource (with their default role). A ticket
   * already assigned to SOMEONE ELSE is left untouched unless `takeOver` —
   * nothing is written and the assignee is named. Rerun-safe: a ticket already
   * In Progress and assigned to the resource writes nothing. Returns
   * `startedAt`, so the closing log_my_time can carry real start/end times.
   */
  async startWorkOnTicket(opts: {
    ticketID: number; resourceID: number; roleID?: number; status?: string | number; takeOver?: boolean; dryRun?: boolean;
  }): Promise<StartWorkResult> {
    const startedAt = new Date().toISOString();
    const ticket = await this.getTicket(opts.ticketID, true);
    if (!ticket) return { status: 'not_found', ticketID: opts.ticketID };
    const base = { ticketID: opts.ticketID, ticketNumber: ticket.ticketNumber, title: ticket.title };
    if (Number(ticket.status) === 5) {
      return { ...base, status: 'ticket_complete', message: `Ticket ${ticket.ticketNumber} is Complete — reopen it (set a working status) before starting work.` };
    }
    const statusMatch = matchPicklist(await this.getPicklistValues('Tickets', 'status'), opts.status ?? 'In Progress');
    if (!statusMatch.ok) {
      return { ...base, status: 'invalid_status', requested: statusMatch.requested, choices: statusMatch.choices };
    }

    const patch: Partial<AutotaskTicket> = {};
    let assignment: 'already_yours' | 'assigned_to_you' | 'taken_over' | 'assigned_to_other' = 'already_yours';
    const current = ticket.assignedResourceID != null ? Number(ticket.assignedResourceID) : null;
    if (current !== opts.resourceID) {
      if (current != null && !opts.takeOver) {
        const names = await this.getResourceNames([current]);
        return {
          ...base, status: 'assigned_to_other', assignedResourceID: current, assignedResourceName: names.get(current) ?? null,
          message: `Ticket ${ticket.ticketNumber} is assigned to ${names.get(current) ?? `resource ${current}`} — nothing changed. Re-run with takeOver:true to reassign it to yourself.`,
        };
      }
      const roleID = opts.roleID ?? await this.resolveResourceDefaultRole(opts.resourceID);
      if (roleID == null) {
        return { ...base, status: 'role_required', message: `Resource ${opts.resourceID} has no default role — pass roleID to assign the ticket.` };
      }
      patch.assignedResourceID = opts.resourceID;
      patch.assignedResourceRoleID = roleID;
      assignment = current == null ? 'assigned_to_you' : 'taken_over';
    }
    if (Number(ticket.status) !== statusMatch.value) patch.status = statusMatch.value;

    const result = { ...base, assignment, statusLabel: statusMatch.label, startedAt, previousStatus: Number(ticket.status), previousAssignedResourceID: current };
    if (!Object.keys(patch).length) return { ...result, status: 'already_started', changes: {} };
    if (opts.dryRun) return { ...result, status: 'dry_run', plannedChanges: patch };
    await this.updateTicket(opts.ticketID, patch);
    return { ...result, status: 'started', changes: patch };
  }

  /**
   * Validate an add_ticket_update before anything is written: the ticket
   * exists, the requested status and note visibility resolve against the
   * tenant picklists, and the note type is the human one. Returns the
   * resolved values, or `ok:false` with the choices (nothing written).
   */
  async planTicketUpdate(opts: {
    ticketID: number; status?: string | number; visibility?: NoteVisibility; noteType?: number;
  }): Promise<
    | { ok: true; ticket: AutotaskTicket; status: { value: number; label: string } | null; publish: { value: number; label: string }; noteType: number }
    | { ok: false; status: string; message: string; choices?: PicklistChoice[] }
  > {
    const ticket = await this.getTicket(opts.ticketID, true);
    if (!ticket) return { ok: false, status: 'not_found', message: `Ticket ${opts.ticketID} not found — nothing written.` };
    let status: { value: number; label: string } | null = null;
    if (opts.status != null && opts.status !== '') {
      const m = matchPicklist(await this.getPicklistValues('Tickets', 'status'), opts.status);
      if (!m.ok) return { ok: false, status: 'invalid_status', message: `Ticket status "${opts.status}" not found — nothing written. Choices: ${formatChoices(m.choices)}`, choices: m.choices };
      if (m.value !== Number(ticket.status)) status = { value: m.value, label: m.label };
    }
    const visibility = opts.visibility ?? 'internal';
    const pub = matchPicklist(await this.getPicklistValues('TicketNotes', 'publish'), PUBLISH_LABELS[visibility]);
    if (!pub.ok) return { ok: false, status: 'invalid_visibility', message: `No note visibility matching "${PUBLISH_LABELS[visibility]}" — nothing written. Choices: ${formatChoices(pub.choices)}`, choices: pub.choices };
    let noteType = opts.noteType;
    if (noteType == null) {
      const nt = matchPicklist(await this.getPicklistValues('TicketNotes', 'noteType'), HUMAN_NOTE_TYPE_LABEL);
      noteType = nt.ok ? nt.value : 1;
    }
    return { ok: true, ticket, status, publish: { value: pub.value, label: pub.label }, noteType };
  }

  /**
   * Post a ticket note unless the SAME note (text + title) was posted on the
   * ticket in the last 24 h — then return that one. Rerun-safe without a
   * marker in the body (a client-visible note must not carry one).
   */
  async postTicketNoteOnce(ticketID: number, note: { title?: string; description: string; noteType: number; publish: number }): Promise<{ created: boolean; noteId: number }> {
    const now = new Date();
    let existing: Array<{ id?: number; title?: string; description?: string; createDateTime?: string }> = [];
    try {
      // Only the last 24 h, newest window — a child read of all notes returns
      // the OLDEST first and would miss a recent duplicate on a long ticket.
      const http = await this.ensureClient();
      existing = await http.query<{ id?: number; title?: string; description?: string; createDateTime?: string }>('TicketNotes', [
        { op: 'eq', field: 'ticketID', value: ticketID },
        { op: 'gte', field: 'createDateTime', value: new Date(now.getTime() - 24 * 3600_000).toISOString() },
      ], { maxRecords: 100 });
    } catch { /* guard read failed → post */ }
    const dup = findDuplicateNote(existing, note.title, note.description, now);
    if (dup?.id != null) return { created: false, noteId: dup.id };
    const noteId = await this.createTicketNote(ticketID, { title: note.title || 'Update', description: note.description, noteType: note.noteType, publish: note.publish });
    return { created: true, noteId };
  }

  /**
   * Time-entry TARGETS for a resource (#5): the valid things they can log time
   * against — OPEN project tasks (completedDateTime is null; logging on a
   * completed task is rejected by Autotask) and non-complete assigned tickets.
   * Scope by company/project and a title searchTerm. Read-only; one call so the
   * EOD bot doesn't run several broad searches to answer "where does this go?".
   */
  async getTimeEntryTargets(opts: {
    resourceID: number; companyID?: number; projectID?: number; searchTerm?: string; maxRecords?: number;
  }): Promise<Record<string, any>> {
    const http = await this.ensureClient();
    const max = Math.min(opts.maxRecords ?? 100, 500);
    const term = opts.searchTerm ? String(opts.searchTerm).toLowerCase() : null;

    const taskFilters: QueryFilter[] = [
      { op: 'eq', field: 'assignedResourceID', value: opts.resourceID },
      { op: 'noteq', field: 'status', value: 5 },            // 5 = Complete
      { op: 'notExist', field: 'completedDateTime' },          // belt-and-suspenders: exclude completed
    ];
    if (opts.projectID != null) taskFilters.push({ op: 'eq', field: 'projectID', value: opts.projectID });

    const ticketFilters: QueryFilter[] = [
      { op: 'eq', field: 'assignedResourceID', value: opts.resourceID },
      { op: 'noteq', field: 'status', value: 5 },            // 5 = Complete
    ];
    if (opts.companyID != null) ticketFilters.push({ op: 'eq', field: 'companyID', value: opts.companyID });

    const [tasks, tickets] = await Promise.all([
      http.query<Record<string, any>>('Tasks', taskFilters, { includeFields: ['id', 'title', 'projectID', 'phaseID', 'status', 'startDateTime', 'endDateTime', 'estimatedHours', 'remainingHours', 'assignedResourceID'], maxRecords: max }).catch(() => [] as Record<string, any>[]),
      http.query<Record<string, any>>('Tickets', ticketFilters, { includeFields: ['id', 'ticketNumber', 'title', 'status', 'companyID', 'queueID', 'priority'], maxRecords: max }).catch(() => [] as Record<string, any>[]),
    ]);

    // Resolve project names for the open tasks (batched, best-effort).
    const projectIds = [...new Set(tasks.map((t) => t.projectID).filter((x): x is number => typeof x === 'number'))];
    const projectName = new Map<number, string>();
    for (let i = 0; i < projectIds.length; i += 200) {
      try {
        const rows = await http.query<Record<string, any>>('Projects', [{ op: 'in', field: 'id', value: projectIds.slice(i, i + 200) }], { includeFields: ['id', 'projectName'], maxRecords: 500 });
        for (const r of rows) projectName.set(r.id, r.projectName);
      } catch { /* names are a nicety */ }
    }

    const matchTerm = (s: unknown) => term == null || String(s ?? '').toLowerCase().includes(term);
    const taskRows = tasks
      .filter((t) => matchTerm(t.title))
      .map((t) => ({ taskID: t.id, title: t.title ?? null, projectID: t.projectID ?? null, projectName: projectName.get(t.projectID) ?? null, phaseID: t.phaseID ?? null, status: t.status ?? null, remainingHours: t.remainingHours ?? null, startDate: t.startDateTime ?? null, endDate: t.endDateTime ?? null }));
    const ticketRows = tickets
      .filter((t) => matchTerm(t.title) || matchTerm(t.ticketNumber))
      .map((t) => ({ ticketID: t.id, ticketNumber: t.ticketNumber ?? null, title: t.title ?? null, status: t.status ?? null, companyID: t.companyID ?? null, queueID: t.queueID ?? null }));

    return { resourceID: opts.resourceID, tasks: taskRows, tickets: ticketRows, counts: { tasks: taskRows.length, tickets: ticketRows.length } };
  }

  /**
   * Create a time entry idempotently (#42 slice 3): if the resource already has
   * an entry on the same day against the same ticket/task with the same summary,
   * skip and report the existing one instead of double-posting. This is the
   * content-match guard that makes a scheduled end-of-day backfill (and retries)
   * safe. `resourceID`, `dateWorked`, and `summaryNotes` are required for the
   * guard to be meaningful; without a ticket/task it guards regular time by
   * summary alone for the day.
   */
  async logTimeIdempotent(
    entry: Partial<AutotaskTimeEntry> & { resourceID: number; dateWorked: string; summaryNotes: string }
  ): Promise<{ created: boolean; id: number; duplicateOf?: number }> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [
      { op: 'eq', field: 'resourceID', value: entry.resourceID },
      { op: 'eq', field: 'dateWorked', value: entry.dateWorked },
    ];
    if (entry.ticketID != null) filters.push({ op: 'eq', field: 'ticketID', value: entry.ticketID });
    if (entry.taskID != null) filters.push({ op: 'eq', field: 'taskID', value: entry.taskID });
    // Regular Time: scope the guard to the same category too, so two different
    // internal categories with a similar summary aren't treated as duplicates.
    const e2 = entry as Record<string, any>;
    if (e2.internalBillingCodeID != null) filters.push({ op: 'eq', field: 'internalBillingCodeID', value: e2.internalBillingCodeID });
    let existing: Array<Record<string, any>> = [];
    try {
      existing = await http.query<Record<string, any>>('TimeEntries', filters, { maxRecords: 200 });
    } catch { /* if the guard read fails, fall through to create rather than block logging */ }
    const want = String(entry.summaryNotes).trim().toLowerCase();
    const wantStart = e2.startDateTime ? String(e2.startDateTime) : null;
    const dup = existing.find((e) => {
      const sameSummary = String(e.summaryNotes ?? '').trim().toLowerCase() === want;
      // When both sides carry a start time, it must match too — distinct meetings
      // on the same day/category with the same summary stay distinct.
      const sameStart = wantStart == null || e.startDateTime == null || String(e.startDateTime) === wantStart;
      return sameSummary && sameStart;
    });
    if (dup?.id != null) {
      this.logger.info(`Skipping duplicate time entry (matches ${dup.id})`);
      return { created: false, id: dup.id, duplicateOf: dup.id };
    }
    const id = await this.createTimeEntry(entry);
    return { created: true, id };
  }

  /**
   * Bulk-create task time entries (one per attendee) for a meeting/task
   * closeout, in a rerun-safe, validate-all-before-write way (report gap #11).
   *
   * Two passes:
   *  1) Resolve every entry (resourceName -> id, roleID auto-resolve) and probe
   *     the task+date for an existing matching entry (same guard as
   *     logTimeIdempotent). Build a plan with per-entry status.
   *  2) If dryRun, return the plan (nothing written). Otherwise, if ANY entry
   *     failed resolution/role selection, write NOTHING and return the plan so
   *     the caller can fix it (atomic validation gate); else write each via the
   *     idempotent path and report created / duplicate ids.
   *
   * The result is verification-shaped (counts + per-entry status), so the caller
   * can gate a task closeout on "all expected entries present".
   */
  async createTaskTimeEntriesBulk(params: {
    taskID: number;
    dateWorked: string;
    entries: Array<{
      resourceID?: number;
      resourceName?: string;
      hoursWorked: number;
      summaryNotes: string;
      internalNotes?: string;
      startDateTime?: string;
      endDateTime?: string;
      roleID?: number;
    }>;
    dryRun?: boolean;
  }): Promise<{
    taskID: number;
    dateWorked: string;
    dryRun: boolean;
    planned: number;
    wouldCreate: number;
    duplicates: number;
    errors: number;
    created: number;
    written: boolean;
    results: Array<{
      resourceID?: number;
      resourceName?: string;
      hoursWorked: number;
      roleID?: number;
      roleName?: string | null;
      roleSource?: RoleSource;
      status: 'would_create' | 'created' | 'duplicate' | 'error';
      id?: number;
      duplicateOf?: number;
      error?: string;
      needsSelection?: Array<{ roleID: number; roleName?: string | null; isDefault?: boolean; departments?: string[]; queues?: string[] }>;
    }>;
  }> {
    const { taskID, dateWorked, entries, dryRun = false } = params;
    const http = await this.ensureClient();

    // One read of the task's entries for the day, matched in memory per resource.
    let dayEntries: Array<Record<string, any>> = [];
    try {
      dayEntries = await http.query<Record<string, any>>(
        'TimeEntries',
        [{ op: 'eq', field: 'taskID', value: taskID }, { op: 'eq', field: 'dateWorked', value: dateWorked }],
        { maxRecords: 500, includeFields: ['id', 'resourceID', 'summaryNotes', 'startDateTime'] }
      );
    } catch { /* fall through: probe failure should not block, per-entry create still guards */ }

    type Row = Awaited<ReturnType<AutotaskService['createTaskTimeEntriesBulk']>>['results'][number];
    const plan: Array<{ row: Row; entry: typeof entries[number] }> = [];

    for (const entry of entries) {
      const row: Row = {
        hoursWorked: entry.hoursWorked,
        status: 'would_create',
        ...(entry.resourceID != null ? { resourceID: entry.resourceID } : {}),
        ...(entry.resourceName ? { resourceName: entry.resourceName } : {}),
      };

      // Resolve resource
      let resourceID = entry.resourceID;
      if (resourceID == null && entry.resourceName) {
        const r = await this.resolveResourceByName(entry.resourceName);
        if (!r) { row.status = 'error'; row.error = `No active resource found matching "${entry.resourceName}"`; plan.push({ row, entry }); continue; }
        resourceID = r.id;
        row.resourceID = r.id;
      }
      if (resourceID == null) { row.status = 'error'; row.error = 'resourceID or resourceName is required'; plan.push({ row, entry }); continue; }

      // Resolve the role, or validate a caller-chosen one (a needsSelection or an
      // invalid role is a hard stop for that entry). Best-effort: a failed lookup
      // keeps a caller-chosen roleID and lets Autotask enforce it.
      let roleID = entry.roleID;
      let rr: Awaited<ReturnType<typeof this.resolveWorkTimeEntryRole>> | null;
      try { rr = await this.resolveWorkTimeEntryRole(resourceID, roleID); } catch { rr = null; }
      if (rr && 'error' in rr) { row.status = 'error'; row.error = rr.error; plan.push({ row, entry }); continue; }
      if (rr && 'needsSelection' in rr) { row.status = 'error'; row.error = 'Resource has multiple roles and no default — set roleID'; row.needsSelection = rr.needsSelection; plan.push({ row, entry }); continue; }
      if (rr && 'invalidRole' in rr) { row.status = 'error'; row.error = `roleID ${rr.invalidRole} is not an active role for this resource — set roleID to one of its roles`; row.needsSelection = rr.validRoles; plan.push({ row, entry }); continue; }
      if (rr && 'roleID' in rr) { roleID = rr.roleID; row.roleName = rr.roleName; row.roleSource = rr.source; }
      else if (roleID != null) row.roleSource = 'explicit_unverified';
      if (roleID != null) row.roleID = roleID;

      // Duplicate probe (mirror logTimeIdempotent's summary guard)
      const want = String(entry.summaryNotes).trim().toLowerCase();
      const dup = dayEntries.find((e) => e.resourceID === resourceID && String(e.summaryNotes ?? '').trim().toLowerCase() === want);
      if (dup?.id != null) { row.status = 'duplicate'; row.duplicateOf = dup.id; }

      plan.push({ row, entry });
    }

    const hasErrors = plan.some((p) => p.row.status === 'error');

    // Write pass: only when not dry-run AND no resolution errors (validate-all-before-write)
    if (!dryRun && !hasErrors) {
      for (const p of plan) {
        if (p.row.status !== 'would_create') continue; // skip duplicates
        // One entry's Autotask rejection (e.g. that attendee's timesheet is
        // locked) is recorded on its row with the explained reason; the others
        // still write. Rerun-safe: the idempotent path won't double-post.
        try {
          const res = await this.logTimeIdempotent({
            resourceID: p.row.resourceID as number,
            dateWorked,
            taskID,
            summaryNotes: p.entry.summaryNotes,
            hoursWorked: p.entry.hoursWorked,
            ...(p.row.roleID != null ? { roleID: p.row.roleID } : {}),
            ...(p.entry.internalNotes ? { internalNotes: p.entry.internalNotes } : {}),
            ...(p.entry.startDateTime ? { startDateTime: p.entry.startDateTime } : {}),
            ...(p.entry.endDateTime ? { endDateTime: p.entry.endDateTime } : {}),
          } as any);
          if (res.created) { p.row.status = 'created'; p.row.id = res.id; }
          else { p.row.status = 'duplicate'; p.row.duplicateOf = res.duplicateOf ?? res.id; p.row.id = res.id; }
        } catch (e) {
          p.row.status = 'error';
          p.row.error = classifyTimeEntryWriteError(e)?.reason ?? (e instanceof Error ? e.message : String(e));
        }
      }
    }

    const results = plan.map((p) => p.row);
    return {
      taskID,
      dateWorked,
      dryRun,
      planned: results.length,
      wouldCreate: results.filter((r) => r.status === 'would_create').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      errors: results.filter((r) => r.status === 'error').length,
      created: results.filter((r) => r.status === 'created').length,
      written: !dryRun && !hasErrors,
      results,
    };
  }

  /** Resolve an ACTIVE resource by exact email (Teams participant → Autotask resource). */
  async resolveResourceByEmail(email: string): Promise<{ id: number; firstName: string; lastName: string } | null> {
    const http = await this.ensureClient();
    try {
      const rows = await http.query<Record<string, any>>(
        'Resources',
        [{ op: 'eq', field: 'email', value: email.trim() }, { op: 'eq', field: 'isActive', value: true }],
        { maxRecords: 2, includeFields: ['id', 'firstName', 'lastName', 'email'] }
      );
      const r = (rows || [])[0];
      return r?.id != null ? { id: r.id, firstName: r.firstName ?? '', lastName: r.lastName ?? '' } : null;
    } catch { return null; }
  }

  /**
   * Capture a collaborative work event (e.g. a Teams triage thread on a ticket)
   * as one call: a TICKET time entry per contributing tech + an optional ticket
   * note (the narrative). The ticket-oriented sibling of createTaskTimeEntriesBulk.
   *
   * Resolves each participant by resourceID | resourceName | email; auto-resolves
   * the role (a multi-role/no-default participant errors asking for roleID — never
   * guesses); applies billingTreatment; inherits timezone normalization from
   * createTimeEntry. Dry-run first + validate-all-before-write: if ANY participant
   * fails to resolve, nothing is written. Time is written idempotently
   * (logTimeIdempotent). The note is written last, idempotently when an
   * idempotencyKey is given, so a re-run neither double-logs time nor dupes the note.
   */
  async logTicketCollaboration(params: {
    ticketID: number;
    dateWorked: string;
    participants: Array<{
      resourceID?: number;
      resourceName?: string;
      email?: string;
      hoursWorked: number;
      summaryNotes: string;
      internalNotes?: string;
      roleID?: number;
      billingTreatment?: BillingTreatment;
      startDateTime?: string;
      endDateTime?: string;
      timeZone?: string;
    }>;
    note?: { title?: string; description: string; noteType?: number; publish?: number; idempotencyKey?: string };
    dryRun?: boolean;
  }): Promise<{
    ticketID: number;
    dateWorked: string;
    dryRun: boolean;
    planned: number;
    wouldCreate: number;
    duplicates: number;
    errors: number;
    created: number;
    written: boolean;
    note?: { status: 'would_create' | 'created' | 'duplicate' | 'skipped'; noteId?: number };
    results: Array<{
      resourceID?: number;
      label?: string;
      hoursWorked: number;
      roleID?: number;
      roleName?: string | null;
      roleSource?: RoleSource;
      status: 'would_create' | 'created' | 'duplicate' | 'error';
      id?: number;
      duplicateOf?: number;
      error?: string;
      needsSelection?: Array<{ roleID: number; roleName?: string | null; isDefault?: boolean; departments?: string[]; queues?: string[] }>;
    }>;
  }> {
    const { ticketID, dateWorked, participants, note, dryRun = false } = params;
    const http = await this.ensureClient();

    let dayEntries: Array<Record<string, any>> = [];
    try {
      dayEntries = await http.query<Record<string, any>>(
        'TimeEntries',
        [{ op: 'eq', field: 'ticketID', value: ticketID }, { op: 'eq', field: 'dateWorked', value: dateWorked }],
        { maxRecords: 500, includeFields: ['id', 'resourceID', 'summaryNotes', 'startDateTime'] }
      );
    } catch { /* probe failure shouldn't block; per-entry create still guards */ }

    type Row = Awaited<ReturnType<AutotaskService['logTicketCollaboration']>>['results'][number];
    const plan: Array<{ row: Row; p: typeof participants[number] }> = [];

    for (const p of participants) {
      const label = p.resourceName || p.email || (p.resourceID != null ? `resource ${p.resourceID}` : undefined);
      const row: Row = { hoursWorked: p.hoursWorked, status: 'would_create', ...(p.resourceID != null ? { resourceID: p.resourceID } : {}), ...(label ? { label } : {}) };

      let resourceID = p.resourceID;
      if (resourceID == null && p.email) {
        const r = await this.resolveResourceByEmail(p.email);
        if (!r) { row.status = 'error'; row.error = `No active resource found for email "${p.email}"`; plan.push({ row, p }); continue; }
        resourceID = r.id; row.resourceID = r.id;
      }
      if (resourceID == null && p.resourceName) {
        const r = await this.resolveResourceByName(p.resourceName);
        if (!r) { row.status = 'error'; row.error = `No active resource found matching "${p.resourceName}"`; plan.push({ row, p }); continue; }
        resourceID = r.id; row.resourceID = r.id;
      }
      if (resourceID == null) { row.status = 'error'; row.error = 'resourceID, resourceName, or email is required'; plan.push({ row, p }); continue; }

      // Resolve the role, or validate a caller-chosen one (see the bulk-task path).
      let roleID = p.roleID;
      let rr: Awaited<ReturnType<typeof this.resolveWorkTimeEntryRole>> | null;
      try { rr = await this.resolveWorkTimeEntryRole(resourceID, roleID); } catch { rr = null; }
      if (rr && 'error' in rr) { row.status = 'error'; row.error = rr.error; plan.push({ row, p }); continue; }
      if (rr && 'needsSelection' in rr) { row.status = 'error'; row.error = 'Resource has multiple roles and no default — set roleID'; row.needsSelection = rr.needsSelection; plan.push({ row, p }); continue; }
      if (rr && 'invalidRole' in rr) { row.status = 'error'; row.error = `roleID ${rr.invalidRole} is not an active role for this resource — set roleID to one of its roles`; row.needsSelection = rr.validRoles; plan.push({ row, p }); continue; }
      if (rr && 'roleID' in rr) { roleID = rr.roleID; row.roleName = rr.roleName; row.roleSource = rr.source; }
      else if (roleID != null) row.roleSource = 'explicit_unverified';
      if (roleID != null) row.roleID = roleID;

      const want = String(p.summaryNotes).trim().toLowerCase();
      const dup = dayEntries.find((e) => e.resourceID === resourceID && String(e.summaryNotes ?? '').trim().toLowerCase() === want);
      if (dup?.id != null) { row.status = 'duplicate'; row.duplicateOf = dup.id; }

      plan.push({ row, p });
    }

    const hasErrors = plan.some((x) => x.row.status === 'error');

    if (!dryRun && !hasErrors) {
      for (const { row, p } of plan) {
        if (row.status !== 'would_create') continue;
        const entry: Record<string, any> = {
          resourceID: row.resourceID as number,
          dateWorked,
          ticketID,
          summaryNotes: p.summaryNotes,
          hoursWorked: p.hoursWorked,
          ...(row.roleID != null ? { roleID: row.roleID } : {}),
          ...(p.internalNotes ? { internalNotes: p.internalNotes } : {}),
          ...(p.startDateTime ? { startDateTime: p.startDateTime } : {}),
          ...(p.endDateTime ? { endDateTime: p.endDateTime } : {}),
          ...(p.timeZone ? { timeZone: p.timeZone } : {}),
        };
        applyBillingTreatment(entry, p.billingTreatment);
        // Per-row failure with the explained reason (see the bulk-task path).
        try {
          const res = await this.logTimeIdempotent(entry as any);
          if (res.created) { row.status = 'created'; row.id = res.id; }
          else { row.status = 'duplicate'; row.duplicateOf = res.duplicateOf ?? res.id; row.id = res.id; }
        } catch (e) {
          row.status = 'error';
          row.error = classifyTimeEntryWriteError(e)?.reason ?? (e instanceof Error ? e.message : String(e));
        }
      }
    }

    // Note last — only when time succeeded (no resolution OR write errors), idempotent if keyed.
    let noteResult: { status: 'would_create' | 'created' | 'duplicate' | 'skipped'; noteId?: number } | undefined;
    const writeFailed = plan.some((x) => x.row.status === 'error');
    if (note?.description) {
      if (dryRun || hasErrors) {
        noteResult = { status: 'would_create' };
      } else if (writeFailed) {
        noteResult = { status: 'skipped' }; // re-run after fixing the failed row(s)
      } else if (note.idempotencyKey) {
        const nr = await this.createTicketNoteIdempotent(ticketID, { title: note.title ?? 'Ticket note', description: note.description, ...(note.noteType != null ? { noteType: note.noteType } : {}), ...(note.publish != null ? { publish: note.publish } : {}) } as any, note.idempotencyKey);
        noteResult = { status: nr.created ? 'created' : 'duplicate', noteId: nr.noteId };
      } else {
        const nid = await this.createTicketNote(ticketID, { title: note.title ?? 'Ticket note', description: note.description, ...(note.noteType != null ? { noteType: note.noteType } : {}), ...(note.publish != null ? { publish: note.publish } : {}) } as any);
        noteResult = { status: 'created', noteId: nid };
      }
    }

    const results = plan.map((x) => x.row);
    return {
      ticketID,
      dateWorked,
      dryRun,
      planned: results.length,
      wouldCreate: results.filter((r) => r.status === 'would_create').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      errors: results.filter((r) => r.status === 'error').length,
      created: results.filter((r) => r.status === 'created').length,
      written: !dryRun && !hasErrors,
      ...(noteResult ? { note: noteResult } : {}),
      results,
    };
  }

  /**
   * Resolve a resource by full/partial name via POST /Resources/query.
   * Returns the first match, or null.
   */
  async resolveResourceByName(name: string): Promise<{ id: number; firstName: string; lastName: string } | null> {
    const http = await this.ensureClient();
    try {
      // Try an exact concat match first: firstName + ' ' + lastName.
      const parts = name.trim().split(/\s+/);
      const first = parts[0];
      const last = parts.slice(1).join(' ') || undefined;

      const filters: QueryFilter[] = [{ op: 'eq', field: 'isActive', value: true }];
      if (first && last) {
        filters.push({
          op: 'and',
          items: [
            { op: 'contains', field: 'firstName', value: first },
            { op: 'contains', field: 'lastName', value: last }
          ]
        });
      } else {
        filters.push({
          op: 'or',
          items: [
            { op: 'contains', field: 'firstName', value: first },
            { op: 'contains', field: 'lastName', value: first },
            { op: 'contains', field: 'email', value: first }
          ]
        });
      }

      const results = await http.query<{ id: number; firstName: string; lastName: string }>(
        'Resources',
        filters,
        { maxRecords: 5 }
      );
      return results[0] || null;
    } catch (error) {
      this.logger.error(`Failed to resolve resource "${name}":`, error);
      throw error;
    }
  }

  /**
   * Find active resources by exact email (for caller→resource mapping, §4.1).
   * Returns all matches so the caller can distinguish unique vs ambiguous.
   */
  async searchResourcesByEmail(
    email: string
  ): Promise<Array<{ id: number; firstName?: string; lastName?: string; email?: string }>> {
    const http = await this.ensureClient();
    try {
      return await http.query('Resources', [
        { op: 'eq', field: 'isActive', value: true },
        { op: 'eq', field: 'email', value: email },
      ], { maxRecords: 5 });
    } catch (error) {
      this.logger.error(`Failed to search resources by email "${email}":`, error);
      throw error;
    }
  }

  // Regular Time categories are BillingCodes with useType = 3 (Internal Allocation
  // Code) — verified live 2026-09-23: Internal Meeting, Office Management,
  // HR/Recruiting, Quote building, Research, Travel Time, Sick Time, etc. This is a
  // DIFFERENT set from work types (useType 1 = General Allocation Code: Onsite
  // Support, Remote Support, …), which are for TICKET/TASK time — never mix them.
  private readonly REGULAR_TIME_USE_TYPE = 3;

  /** Structured Regular Time categories: { id, name, active }. Read-only. */
  async getRegularTimeCategories(): Promise<Array<{ id: number; name: string; active: boolean }>> {
    const http = await this.ensureClient();
    const codes = await http.query<Record<string, any>>(
      'BillingCodes',
      [{ op: 'eq', field: 'useType', value: this.REGULAR_TIME_USE_TYPE }],
      { maxRecords: 500, includeFields: ['id', 'name', 'isActive', 'useType'] }
    );
    return codes
      .filter((c) => c.name != null)
      .map((c) => ({ id: c.id, name: String(c.name), active: c.isActive !== false }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private readonly WORK_TYPE_USE_TYPE = 1;

  /** Ticket/task WORK TYPES (BillingCodes useType 1): { id, name, active }. Read-only. */
  async getWorkTypes(): Promise<Array<{ id: number; name: string; active: boolean }>> {
    const http = await this.ensureClient();
    const codes = await http.query<{ id: number; name?: string | null; isActive?: boolean }>(
      'BillingCodes',
      [{ op: 'eq', field: 'useType', value: this.WORK_TYPE_USE_TYPE }],
      { maxRecords: 500, includeFields: ['id', 'name', 'isActive', 'useType'] }
    );
    return codes
      .filter((c) => c.name != null)
      .map((c) => ({ id: c.id, name: String(c.name), active: c.isActive !== false }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Pre-flight a ticket/task time entry's billingCodeID. Autotask rejects a bad
   * one with "The given allocation code is not an active general allocation
   * code." — which doesn't say whether the id doesn't exist, is inactive, or is
   * the wrong KIND (e.g. a Regular Time category, useType 3, passed as a work
   * type). This says which, with the active work types to choose from.
   */
  async validateWorkType(billingCodeID: number): Promise<
    | { ok: true; name: string | null }
    | { ok: false; reason: 'not_found' | 'inactive' | 'not_a_work_type'; name: string | null; useType: number | null; validWorkTypes: Array<{ id: number; name: string }> }
  > {
    const bc = (await this.getBillingCode(billingCodeID)) as { name?: string | null; useType?: number | null; isActive?: boolean } | null;
    const name = bc?.name != null ? String(bc.name) : null;
    const useType = bc?.useType != null ? Number(bc.useType) : null;
    const reason = !bc ? 'not_found' : useType !== this.WORK_TYPE_USE_TYPE ? 'not_a_work_type' : bc.isActive === false ? 'inactive' : null;
    if (!reason) return { ok: true, name };
    const validWorkTypes = (await this.getWorkTypes().catch(() => [])).filter((w) => w.active).map(({ id, name }) => ({ id, name }));
    return { ok: false, reason, name, useType, validWorkTypes };
  }

  /** Names of active Regular Time categories (for prompts). */
  async getInternalBillingCodeNames(): Promise<string[]> {
    try {
      return (await this.getRegularTimeCategories()).filter((c) => c.active).map((c) => c.name);
    } catch (error) {
      this.logger.error('Failed to get regular time categories:', error);
      throw error;
    }
  }

  /**
   * Resolve a Regular Time category by name — case-insensitive, exact match only
   * (never fuzzy across materially different categories like Internal Meeting vs
   * Non-billable Meeting). Ambiguous/none returns null; callers list choices.
   */
  async resolveInternalBillingCodeByName(name: string): Promise<{ id: number; name: string } | null> {
    try {
      const want = String(name).trim().toLowerCase();
      const exact = (await this.getRegularTimeCategories()).filter((c) => c.active && c.name.toLowerCase() === want);
      return exact.length === 1 ? { id: exact[0].id, name: exact[0].name } : null;
    } catch (error) {
      this.logger.error(`Failed to resolve regular time category "${name}":`, error);
      throw error;
    }
  }

  // =====================================================
  // Projects
  // =====================================================

  async getProject(id: number): Promise<AutotaskProject | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting project with ID: ${id}`);
      return await http.get<AutotaskProject>('Projects', id);
    } catch (error) {
      this.logger.error(`Failed to get project ${id}:`, error);
      throw error;
    }
  }

  async searchProjects(options: AutotaskQueryOptions = {}): Promise<PagedResult<AutotaskProject>> {
    try {
      this.logger.debug('Searching projects with options:', options);
      const filters: QueryFilter[] = [];
      const o = options as any;

      pushEq(filters, 'companyID', o.companyID);
      pushEq(filters, 'status', o.status);
      pushEq(filters, 'projectLeadResourceID', o.projectLeadResourceID);
      if (o.searchTerm) {
        filters.push({ op: 'contains', field: 'projectName', value: o.searchTerm });
      }
      mergeFilterEscapeHatch(filters, options.filter);

      const paged = await this.queryPaged<AutotaskProject>('Projects', filters, options, { maxPageSize: 100 });
      return { ...paged, items: paged.items.map(p => this.optimizeProjectData(p)) };
    } catch (error) {
      this.logger.error('Failed to search projects:', error);
      throw error;
    }
  }

  private optimizeProjectData(project: AutotaskProject): AutotaskProject {
    const maxDescriptionLength = 500;
    const optimizedDescription = project.description
      ? (project.description.length > maxDescriptionLength
          ? project.description.substring(0, maxDescriptionLength) + '... [truncated]'
          : project.description)
      : '';
    return { ...project, description: optimizedDescription, userDefinedFields: [] };
  }

  async createProject(project: Partial<AutotaskProject>): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating project:', project);
      const id = await http.create('Projects', project);
      this.logger.info(`Project created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create project:', error);
      throw error;
    }
  }

  /**
   * Link a project to its commercial records — contract and/or opportunity
   * (MCP-PROJ-001). Project reads already surface contract/milestone/opportunity
   * context; this is the typed WRITE path, which did not exist: neither
   * `autotask_create_project` nor `autotask_update_project` exposed `contractID`
   * or `opportunityID`, so a project could not be attached to the commercial
   * record it bills against.
   *
   * Both fields are writable on Projects (verified against this tenant's
   * entityInformation). The guard that matters is ownership: Autotask will
   * happily point a project at another company's contract, which silently
   * misroutes that project's billing. So both references are checked to belong
   * to the project's own company before anything is written.
   *
   * Follows the safe-orchestration contract (§MCP-CORE-004/005): validate →
   * idempotency probe → optional dry run → write → read back and confirm the
   * fields actually took.
   */
  async linkProjectCommercial(params: {
    projectID: number;
    contractID?: number;
    opportunityID?: number;
    dryRun?: boolean;
  }): Promise<WritePlanResult> {
    const plan = new WritePlan();

    if (params.contractID == null && params.opportunityID == null) {
      return plan.fail('input', 'Supply contractID, opportunityID, or both — nothing to link otherwise');
    }

    // 1. Project
    const project = (await this.getProject(params.projectID).catch(() => null)) as Record<string, any> | null;
    if (!project) return plan.fail('project', `Project ${params.projectID} not found`);
    const projectCompanyID = project.companyID;
    plan.ok('project', { companyID: projectCompanyID });

    // 2. Contract: exists, owned by the same company, and commercially usable.
    if (params.contractID != null) {
      const contract = (await this.getContract(params.contractID)) as Record<string, any> | null;
      if (!contract) return plan.fail('contract', `Contract ${params.contractID} not found`);
      if (contract.companyID != null && projectCompanyID != null && contract.companyID !== projectCompanyID) {
        return plan.fail('contract', `Contract ${params.contractID} belongs to company ${contract.companyID}, but project ${params.projectID} belongs to company ${projectCompanyID} — linking it would bill this project against another company's contract`);
      }
      const label = await this.contractStatusLabel(contract.status);
      const endDate = contract.endDate ? new Date(contract.endDate) : null;
      const expired = endDate != null && !Number.isNaN(endDate.getTime()) && endDate.getTime() < Date.now();
      if (expired) return plan.fail('contract', `Contract ${params.contractID} is expired (endDate ${contract.endDate})`);
      if (label != null && !/\bactive\b|\bin effect\b/i.test(label)) {
        return plan.fail('contract', `Contract ${params.contractID} is not active (status "${label}")`);
      }
      plan.ok('contract', { statusLabel: label, endDate: contract.endDate });
    }

    // 3. Opportunity: exists and is owned by the same company.
    if (params.opportunityID != null) {
      const opp = (await this.getOpportunity(params.opportunityID)) as Record<string, any> | null;
      if (!opp) return plan.fail('opportunity', `Opportunity ${params.opportunityID} not found`);
      if (opp.companyID != null && projectCompanyID != null && opp.companyID !== projectCompanyID) {
        return plan.fail('opportunity', `Opportunity ${params.opportunityID} belongs to company ${opp.companyID}, but project ${params.projectID} belongs to company ${projectCompanyID}`);
      }
      plan.ok('opportunity');
    }

    // 4. Idempotency: a re-link to the values already stored is a no-op, so say
    //    so with evidence instead of issuing a pointless write.
    const updates: Record<string, any> = {};
    if (params.contractID != null && project.contractID !== params.contractID) updates.contractID = params.contractID;
    if (params.opportunityID != null && project.opportunityID !== params.opportunityID) updates.opportunityID = params.opportunityID;
    if (Object.keys(updates).length === 0) {
      return plan.duplicate({
        id: params.projectID,
        entityType: 'Projects',
        alreadyLinked: {
          ...(params.contractID != null && { contractID: project.contractID }),
          ...(params.opportunityID != null && { opportunityID: project.opportunityID }),
        },
      });
    }
    plan.ok('idempotency', { changing: Object.keys(updates) });

    // 5. Dry run stops here.
    if (params.dryRun) {
      return plan.dryRun({
        id: params.projectID,
        entityType: 'Projects',
        plannedUpdate: updates,
        currentValues: { contractID: project.contractID ?? null, opportunityID: project.opportunityID ?? null },
      });
    }

    // 6. Write, then read back and confirm each field actually took. A write
    //    Autotask accepts but does not apply is the failure mode worth catching
    //    here — `verified: false` says the link is NOT in place, unlike the
    //    create-path `verified` flag, where the id stays authoritative.
    await this.updateProject(params.projectID, updates as Partial<AutotaskProject>);
    const after = (await this.getProject(params.projectID).catch(() => null)) as Record<string, any> | null;
    const applied = Object.fromEntries(
      Object.keys(updates).map((k) => [k, after ? after[k] === updates[k] : null])
    );
    const verified = after != null && Object.values(applied).every((v) => v === true);

    return plan.done('linked', {
      id: params.projectID,
      entityType: 'Projects',
      applied: updates,
      verified,
      fieldsConfirmed: applied,
      item: after,
    });
  }

  async updateProject(id: number, updates: Partial<AutotaskProject>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating project ${id}:`, updates);
      await http.update('Projects', id, updates as Record<string, any>);
      this.logger.info(`Project ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update project ${id}:`, error);
      throw error;
    }
  }

  /**
   * Find a previously-built project for a build key so a re-run resumes instead
   * of duplicating (#46). Matches the build marker in the description first
   * (authoritative), falling back to an exact projectName match within the
   * company (covers a project created before markers, or edited descriptions).
   */
  private async findProjectByBuildKey(
    companyID: number, buildKey: string, projectName: string
  ): Promise<AutotaskProject | null> {
    const { items } = await this.searchProjects({ companyID, pageSize: 500 } as AutotaskQueryOptions);
    const marked = items.find((p) => hasBuildMarker((p as Record<string, any>).description, buildKey));
    if (marked) return marked;
    return items.find((p) => (p.projectName ?? '').trim() === projectName.trim()) ?? null;
  }

  /**
   * Build engine (#46, §14): realize a validated ProjectBuildPlan as a real
   * Autotask project — project → phases (parent-first) → tasks → dependencies —
   * with the shared write-plan envelope. Safe by construction:
   *
   *  - dryRun defaults ON: unless `dryRun === false`, nothing is written; the
   *    planned mutation counts are returned for review.
   *  - idempotent + resumable: a re-run finds the prior project by build marker
   *    (or name) and creates only the phases/tasks/dependencies still missing
   *    (matched by title within the project), so a retry after a partial failure
   *    never duplicates.
   *  - partial-failure reporting: per-entity errors are collected and returned;
   *    the created ids stay authoritative so a follow-up run completes the rest.
   */
  async buildProjectFromPlan(params: {
    plan: ProjectBuildPlan;
    companyID: number;
    buildKey?: string | undefined;
    projectDefaults?: Record<string, any> | undefined;
    dryRun?: boolean | undefined;
  }): Promise<WritePlanResult> {
    const wp = new WritePlan();

    // 1. Structural validation of the plan (pure).
    const v = validateBuildPlan(params.plan);
    if (!v.valid) return wp.fail('plan', { errors: v.errors, warnings: v.warnings });
    wp.ok('plan', { phases: (params.plan.phases ?? []).length, tasks: (params.plan.tasks ?? []).length, warnings: v.warnings });

    // 2. Company must exist (the project's owner).
    if (params.companyID == null) return wp.fail('company', 'companyID is required');
    const company = await this.getCompany(params.companyID);
    if (!company) return wp.fail('company', `Company ${params.companyID} not found`);
    wp.ok('company', { id: params.companyID });

    const bp = planProjectBuild(params.plan);
    const buildKey = (params.buildKey && params.buildKey.trim()) || `${params.companyID}:${params.plan.name}`;

    // 3. Idempotency probe: is there already a project for this build key?
    const existing = await this.findProjectByBuildKey(params.companyID, buildKey, params.plan.name);
    wp.ok('idempotency', existing ? { existingProjectId: existing.id, resume: true } : { willCreateProject: true });

    // 4. Dry run (default) — report the plan; write nothing.
    if (params.dryRun !== false) {
      return wp.dryRun({
        buildKey,
        existingProjectId: existing?.id ?? null,
        plannedProject: { projectName: params.plan.name, companyID: params.companyID, ...(params.projectDefaults ?? {}) },
        plannedPhases: bp.counts.phases,
        plannedTasks: bp.counts.tasks,
        plannedDependencies: bp.counts.dependencies,
      });
    }

    // 5. Execute. Collect per-entity outcomes; never throw past a single record —
    //    a partial build must be resumable, so we record the error and continue.
    const errors: Array<{ step: string; ref?: string; detail: string }> = [];

    // 5a. Project (reuse existing, else create with the build marker embedded).
    let projectId: number;
    if (existing?.id != null) {
      projectId = existing.id;
    } else {
      const description = [params.plan.source, buildMarker(buildKey)].filter(Boolean).join('\n');
      projectId = await this.createProject({
        projectName: params.plan.name,
        companyID: params.companyID,
        description,
        ...(params.projectDefaults ?? {}),
      } as Partial<AutotaskProject>);
    }

    // 5b–5e: materialize phases/tasks/dependencies (idempotent, title-matched).
    const applied = await this.applyPlanToProject(projectId, bp, existing?.id != null, errors);
    return wp.done(applied.errors.length > 0 ? 'built_with_errors' : 'built', {
      projectId,
      buildKey,
      resumed: existing?.id != null,
      summary: applied.summary,
      phases: applied.phaseResults,
      tasks: applied.taskResults,
      ...(applied.errors.length > 0 ? { errors: applied.errors } : {}),
    });
  }

  /**
   * Shared build-engine step: create the plan's phases (parent-first), tasks, and
   * dependencies inside `projectId`, idempotently (title-matched → reuse). Used by
   * both buildProjectFromPlan (§14) and extendProject (§2.4). When `loadExisting`
   * is true it pre-loads the project's current phases/tasks so nothing duplicates.
   * Never throws past a single record — per-entity errors accumulate in `errors`.
   */
  private async applyPlanToProject(
    projectId: number,
    bp: ReturnType<typeof planProjectBuild>,
    loadExisting: boolean,
    errors: Array<{ step: string; ref?: string; detail: string }> = [],
  ): Promise<{
    summary: Record<string, number>;
    errors: Array<{ step: string; ref?: string; detail: string }>;
    phaseResults: Array<{ ref: string; id: number | null; reused: boolean }>;
    taskResults: Array<{ ref: string; id: number | null; reused: boolean }>;
  }> {
    const phaseTitleToId = new Map<string, number>();
    const taskTitleToId = new Map<string, number>();
    if (loadExisting) {
      try {
        const [ph, tk] = await Promise.all([
          this.searchPhases(projectId, { pageSize: 500 }),
          this.searchTasks({ projectID: projectId, pageSize: 500 } as AutotaskQueryOptions),
        ]);
        for (const p of ph.items) if (p.title && p.id != null) phaseTitleToId.set(p.title, p.id);
        for (const t of tk.items) if (t.title && t.id != null) taskTitleToId.set(t.title, t.id);
      } catch (e) {
        errors.push({ step: 'load-existing', detail: (e as Error).message });
      }
    }

    // Phases (parent-first). refs → real ids.
    const phaseRefToId = new Map<string, number>();
    const phaseResults: Array<{ ref: string; id: number | null; reused: boolean }> = [];
    for (const p of bp.orderedPhases) {
      try {
        let id = phaseTitleToId.get(p.title);
        const reused = id != null;
        if (id == null) {
          const payload: Record<string, any> = { projectID: projectId, title: p.title };
          if (p.description) payload.description = p.description;
          if (p.parentRef && phaseRefToId.has(p.parentRef)) payload.parentPhaseID = phaseRefToId.get(p.parentRef);
          id = await this.createPhase(payload as Partial<AutotaskPhase>);
          phaseTitleToId.set(p.title, id);
        }
        phaseRefToId.set(p.ref, id);
        phaseResults.push({ ref: p.ref, id, reused });
      } catch (e) {
        errors.push({ step: 'phase', ref: p.ref, detail: (e as Error).message });
        phaseResults.push({ ref: p.ref, id: null, reused: false });
      }
    }

    // Tasks. refs → real ids.
    const taskRefToId = new Map<string, number>();
    const taskResults: Array<{ ref: string; id: number | null; reused: boolean }> = [];
    for (const t of bp.tasks) {
      try {
        let id = taskTitleToId.get(t.title);
        const reused = id != null;
        if (id == null) {
          const payload: Record<string, any> = { projectID: projectId, title: t.title, estimatedHours: t.estimatedHours ?? 0 };
          if (t.description) payload.description = t.description;
          if (t.phaseRef && phaseRefToId.has(t.phaseRef)) payload.phaseID = phaseRefToId.get(t.phaseRef);
          if (t.taskType != null) payload.taskType = t.taskType;
          id = await this.createTask(payload as Partial<AutotaskTask>);
          taskTitleToId.set(t.title, id);
        }
        taskRefToId.set(t.ref, id);
        taskResults.push({ ref: t.ref, id, reused });
      } catch (e) {
        errors.push({ step: 'task', ref: t.ref, detail: (e as Error).message });
        taskResults.push({ ref: t.ref, id: null, reused: false });
      }
    }

    // Dependencies. Skip any already present (resume-safe); skip edges whose
    // endpoints didn't get created.
    let depsCreated = 0;
    let depsReused = 0;
    for (const edge of bp.dependencies) {
      const successorId = taskRefToId.get(edge.taskRef);
      const predId = taskRefToId.get(edge.predecessorRef);
      if (successorId == null || predId == null) {
        errors.push({ step: 'dependency', ref: `${edge.taskRef}<-${edge.predecessorRef}`, detail: 'endpoint task not created' });
        continue;
      }
      try {
        if (loadExisting) {
          const current = await this.listTaskPredecessors(successorId);
          if (current.some((r) => (r as Record<string, any>).predecessorTaskID === predId)) { depsReused++; continue; }
        }
        await this.addTaskPredecessor(successorId, predId, edge.lagDays);
        depsCreated++;
      } catch (e) {
        errors.push({ step: 'dependency', ref: `${edge.taskRef}<-${edge.predecessorRef}`, detail: (e as Error).message });
      }
    }

    const summary = {
      phasesCreated: phaseResults.filter((p) => p.id != null && !p.reused).length,
      phasesReused: phaseResults.filter((p) => p.reused).length,
      tasksCreated: taskResults.filter((t) => t.id != null && !t.reused).length,
      tasksReused: taskResults.filter((t) => t.reused).length,
      dependenciesCreated: depsCreated,
      dependenciesReused: depsReused,
    };
    return { summary, errors, phaseResults, taskResults };
  }

  /**
   * Project extension (#46 §2.4): add phases / tasks / dependencies to an EXISTING
   * project by id — a change order, an added phase, a recurring month, a new site,
   * or extra tasks. SAFE BY DEFAULT (dryRun !== false): reports what WOULD be added
   * and writes nothing. Idempotent: phases/tasks already present (by title) are
   * reused, not duplicated, so it's a safe merge. Same write-plan envelope + build
   * engine as buildProjectFromPlan, but targets a known projectID instead of
   * creating/finding a project.
   */
  async extendProject(params: { projectID: number; plan: ProjectBuildPlan; dryRun?: boolean }): Promise<WritePlanResult> {
    const wp = new WritePlan();
    if (params.projectID == null) return wp.fail('project', 'projectID is required');
    const v = validateBuildPlan(params.plan);
    if (!v.valid) return wp.fail('plan', { errors: v.errors, warnings: v.warnings });
    wp.ok('plan', { phases: (params.plan.phases ?? []).length, tasks: (params.plan.tasks ?? []).length, warnings: v.warnings });

    const project = await this.getProject(params.projectID);
    if (!project) return wp.fail('project', `Project ${params.projectID} not found`);
    wp.ok('project', { id: params.projectID, name: project.projectName });

    const bp = planProjectBuild(params.plan);

    // Determine which phases/tasks are genuinely NEW (title not already present).
    let existingPhaseTitles = new Set<string>();
    let existingTaskTitles = new Set<string>();
    try {
      const [ph, tk] = await Promise.all([
        this.searchPhases(params.projectID, { pageSize: 500 }),
        this.searchTasks({ projectID: params.projectID, pageSize: 500 } as AutotaskQueryOptions),
      ]);
      existingPhaseTitles = new Set(ph.items.map((p) => (p.title ?? '').trim()).filter(Boolean));
      existingTaskTitles = new Set(tk.items.map((t) => (t.title ?? '').trim()).filter(Boolean));
    } catch (e) {
      return wp.fail('load-existing', `Could not read project ${params.projectID} structure: ${(e as Error).message}`);
    }
    const newPhases = bp.orderedPhases.filter((p) => !existingPhaseTitles.has(p.title.trim()));
    const newTasks = bp.tasks.filter((t) => !existingTaskTitles.has(t.title.trim()));
    wp.ok('diff', { newPhases: newPhases.length, newTasks: newTasks.length, reusedPhases: bp.orderedPhases.length - newPhases.length, reusedTasks: bp.tasks.length - newTasks.length });

    if (params.dryRun !== false) {
      return wp.dryRun({
        projectId: params.projectID,
        wouldAddPhases: newPhases.map((p) => p.title),
        wouldAddTasks: newTasks.map((t) => ({ title: t.title, estimatedHours: t.estimatedHours ?? 0, phaseRef: t.phaseRef ?? null })),
        plannedDependencies: bp.dependencies.length,
      });
    }

    const applied = await this.applyPlanToProject(params.projectID, bp, true);
    return wp.done(applied.errors.length > 0 ? 'extended_with_errors' : 'extended', {
      projectId: params.projectID,
      summary: applied.summary,
      phases: applied.phaseResults,
      tasks: applied.taskResults,
      ...(applied.errors.length > 0 ? { errors: applied.errors } : {}),
    });
  }

  /**
   * Normalized project outline (§4.3/§6): the project plus its phases (nested by
   * parentPhaseID) with tasks bucketed under each phase, and any unphased tasks.
   * Read-only; preserves Autotask-native fields for blueprint/rebuild.
   */
  async getProjectStructure(projectID: number): Promise<Record<string, any>> {
    const http = await this.ensureClient();
    const [project, phases, tasks] = await Promise.all([
      this.getProject(projectID),
      http.query<Record<string, any>>('Phases', [{ op: 'eq', field: 'projectID', value: projectID }], {
        includeFields: ['id', 'projectID', 'parentPhaseID', 'title', 'description', 'startDate', 'dueDate', 'estimatedHours', 'phaseNumber', 'isScheduled', 'externalID'],
        maxRecords: 1000,
      }),
      http.query<Record<string, any>>('Tasks', [{ op: 'eq', field: 'projectID', value: projectID }], {
        includeFields: ['id', 'projectID', 'phaseID', 'title', 'description', 'status', 'taskType', 'taskNumber', 'startDateTime', 'endDateTime', 'estimatedHours', 'remainingHours', 'assignedResourceID', 'assignedResourceRoleID', 'departmentID', 'billingCodeID', 'priority', 'isTaskBillable', 'completedDateTime', 'externalID'],
        maxRecords: 5000,
      }),
    ]);
    return buildProjectHierarchy(project as Record<string, any> | null, phases, tasks);
  }

  /**
   * Project labor summary (§4.5) — estimated vs actual/billable hours, variance,
   * and a per-phase rollup, aggregated through the task hierarchy (Project →
   * Tasks → task TimeEntries) because project-scoped time queries are unreliable.
   * Time entries are fetched in batched IN queries to stay under API thresholds.
   */
  async getProjectLaborSummary(projectID: number): Promise<Record<string, any>> {
    const http = await this.ensureClient();
    const tasks = await http.query<Record<string, any>>('Tasks', [{ op: 'eq', field: 'projectID', value: projectID }], {
      includeFields: ['id', 'phaseID', 'estimatedHours', 'title'],
      maxRecords: 5000,
    });
    const taskIds = tasks.map((t) => t.id).filter((x): x is number => x != null);
    const entries: Record<string, any>[] = [];
    for (let i = 0; i < taskIds.length; i += 200) {
      const chunk = taskIds.slice(i, i + 200);
      const es = await http.query<Record<string, any>>('TimeEntries', [{ op: 'in', field: 'taskID', value: chunk }], {
        includeFields: ['taskID', 'hoursWorked', 'hoursToBill', 'isNonBillable', 'dateWorked', 'resourceID'],
        maxRecords: 10000,
      }).catch(() => []);
      entries.push(...es);
    }
    return summarizeProjectLabor(tasks, entries);
  }

  /**
   * Export a project as a reusable, tenant-agnostic blueprint (§2.3): the
   * phase/task hierarchy with titles, estimated hours, and task type — without
   * tenant-specific ids, resource assignments, or absolute dates.
   */
  async exportProjectBlueprint(projectID: number): Promise<Record<string, any>> {
    const structure = await this.getProjectStructure(projectID);
    return toProjectBlueprint(structure);
  }

  /**
   * Complete read-only project context for the Project Builder (§10): the
   * project, its nested phase/task hierarchy, dependency graph, labor rollup,
   * notes/attachments, owning company, and commercial linkage (contract +
   * milestones, opportunity). Best-effort and fail-soft: each section is fetched
   * independently and a section that errors is recorded under `errors` rather
   * than failing the whole call — a wide read must degrade gracefully, never
   * return a misleading whole-context failure. The one hard stop is the project
   * itself: if it can't be read the context is meaningless, so that propagates
   * (or reports notFound for a genuine 404).
   *
   * Heavy sections are opt-in to bound API fan-out (429 risk): configuration
   * items (per-company, can be large) default off. Quotes/linked tickets/charges
   * are deferred to a later slice.
   */
  async getCompleteProjectContext(
    projectID: number,
    options: { includeConfigurationItems?: boolean; includeCommercial?: boolean } = {}
  ): Promise<Record<string, any>> {
    const includeCommercial = options.includeCommercial !== false; // default on
    const errors: Array<{ section: string; error: string }> = [];
    const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        errors.push({ section: name, error: e instanceof Error ? e.message : String(e) });
        return undefined;
      }
    };

    // Hierarchy first — it carries the project record (with linkage fields) and
    // the task set the dependency graph is built from. A read failure here is a
    // real failure and propagates (fail closed); a genuine not-found is reported.
    const structure = await this.getProjectStructure(projectID);
    const project = structure.project as Record<string, any> | null;
    if (!project) {
      return { projectID, found: false, message: `Project ${projectID} not found`, errors };
    }

    // Collect every task id across the nested hierarchy for the dependency graph.
    const taskIds: number[] = [];
    const walk = (phase: any) => {
      for (const t of phase.tasks ?? []) if (t?.id != null) taskIds.push(t.id);
      for (const c of phase.children ?? []) walk(c);
    };
    for (const p of structure.phases ?? []) walk(p);
    for (const t of structure.unphasedTasks ?? []) if (t?.id != null) taskIds.push(t.id);

    const companyID = project.companyID as number | undefined;
    const contractID = project.contractID as number | undefined;
    const opportunityID = project.opportunityID as number | undefined;

    // Fan out the independent sections in parallel; queryByIds bounds its own
    // per-chunk concurrency, so the section count (not the row count) is what
    // fires at once here.
    const [
      laborSummary,
      predecessors,
      notes,
      projectAttachments,
      company,
      contract,
      contractMilestones,
      opportunity,
      configurationItems,
    ] = await Promise.all([
      section('laborSummary', () => this.getProjectLaborSummary(projectID)),
      section('predecessors', () => this.getProjectTaskPredecessors(taskIds)),
      section('notes', () => this.searchProjectNotes(projectID)),
      section('attachments', () => this.searchProjectAttachments(projectID)),
      section('company', () => (companyID != null ? this.getCompany(companyID) : Promise.resolve(null))),
      section('contract', () =>
        includeCommercial && contractID != null ? this.getContract(contractID) : Promise.resolve(null)),
      section('contractMilestones', () =>
        includeCommercial && contractID != null
          ? this.searchContractMilestones({ contractID })
          : Promise.resolve([])),
      section('opportunity', () =>
        includeCommercial && opportunityID != null
          ? this.getOpportunity(opportunityID)
          : Promise.resolve(null)),
      section('configurationItems', () =>
        options.includeConfigurationItems && companyID != null
          ? this.searchConfigurationItems({ companyID } as AutotaskQueryOptions)
          : Promise.resolve([])),
    ]);

    const predItems = (predecessors as any)?.items ?? [];
    const predFailed = (predecessors as any)?.failedChunks ?? [];
    for (const fc of predFailed) {
      errors.push({ section: 'predecessors', error: `chunk ${JSON.stringify(fc.ids)}: ${fc.error}` });
    }

    return {
      projectID,
      found: true,
      project,
      structure: {
        phases: structure.phases,
        unphasedTasks: structure.unphasedTasks,
        summary: structure.summary,
      },
      laborSummary: laborSummary ?? null,
      dependencies: predItems,
      notes: notes ?? [],
      attachments: projectAttachments ?? [],
      company: company ?? null,
      commercial: includeCommercial
        ? {
            contractID: contractID ?? null,
            contract: contract ?? null,
            contractMilestones: contractMilestones ?? [],
            opportunityID: opportunityID ?? null,
            opportunity: opportunity ?? null,
          }
        : null,
      configurationItems: configurationItems ?? [],
      summary: {
        phaseCount: structure.summary?.phaseCount ?? 0,
        taskCount: structure.summary?.taskCount ?? 0,
        dependencyCount: predItems.length,
        noteCount: (notes ?? []).length,
        attachmentCount: (projectAttachments ?? []).length,
        milestoneCount: (contractMilestones ?? []).length,
        hasContract: !!contract,
        hasOpportunity: !!opportunity,
      },
      errors,
    };
  }

  /** Batched dependency-graph fetch for a task set (successorTaskID IN taskIds). */
  async getProjectTaskPredecessors(
    taskIds: number[]
  ): Promise<{ items: Array<Record<string, any>>; failedChunks: Array<{ ids: Array<number | string>; error: string }> }> {
    const http = await this.ensureClient();
    if (!taskIds.length) return { items: [], failedChunks: [] };
    return http.queryByIds<Record<string, any>>('TaskPredecessors', 'successorTaskID', taskIds, {
      includeFields: ['id', 'predecessorTaskID', 'successorTaskID', 'lagDays'],
    });
  }

  /**
   * Read-after-write verification helper (§2): read a just-created entity back
   * by id, with a bounded retry that tolerates Autotask's brief post-create read
   * lag (a fresh entity can 404 for a moment). Returns the entity once visible,
   * or null if it never appears within the budget. This is confirmation/
   * enrichment only — the create response's itemId remains the source of truth
   * for whether the write succeeded, so a null here means "created but not yet
   * verifiable", never "not created".
   */
  async readEntityForVerification(
    entityType: string,
    id: number,
    opts?: { attempts?: number; delayMs?: number }
  ): Promise<Record<string, any> | null> {
    const http = await this.ensureClient();
    return http.getWithRetry<Record<string, any>>(entityType, id, opts ?? {});
  }

  // =====================================================
  // Resources
  // =====================================================

  async getResource(id: number): Promise<AutotaskResource | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting resource with ID: ${id}`);
      return await http.get<AutotaskResource>('Resources', id);
    } catch (error) {
      this.logger.error(`Failed to get resource ${id}:`, error);
      throw error;
    }
  }

  /**
   * Per-resource labour-burden report for cost/utilisation pages. Returns the
   * fields the cost math is built on: `internalCost` (the Autotask labour-burden
   * basis — a PER-HOUR internal cost as entered), the employment basis
   * (`payrollType`: Salary/Hourly/Contractor/Salary Non Exempt, and
   * `resourceType`: Employee/Contractor — which decide whether an unlogged hour
   * is cash gone vs capacity uncaptured), plus isActive and hireDate. Read-only.
   *
   * IMPORTANT (open data question, not answerable via the API): `internalCost` is
   * only the number entered in Autotask — the API does not say whether it is
   * fully loaded (wage + employer taxes + benefits) or wage-only. Surfaced in
   * `notes` so a cost page can flag the assumption rather than silently understate.
   * Autotask has NO department field on Resource — department lives on
   * ResourceRoles; use getResourceRoles / autotask_get_resource_roles for that.
   */
  async reportResourceBurden(opts: { includeInactive?: boolean; includeApiUsers?: boolean; resourceType?: string; resourceIDs?: number[] } = {}): Promise<{
    count: number;
    withCost: number;
    missingCost: number;
    apiUsersExcluded: number;
    notes: string[];
    resources: Array<{
      id: number; firstName: string | null; lastName: string | null; email: string | null;
      isActive: boolean; internalCost: number | null; hasInternalCost: boolean;
      payrollType: number | null; payrollTypeLabel: string | null;
      resourceType: string | null; licenseType: number | null; licenseTypeLabel: string | null;
      hireDate: string | null;
    }>;
  }> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [];
    if (!opts.includeInactive) filters.push({ op: 'eq', field: 'isActive', value: true });
    if (opts.resourceType) filters.push({ op: 'eq', field: 'resourceType', value: opts.resourceType });
    if (opts.resourceIDs?.length) filters.push({ op: 'in', field: 'id', value: opts.resourceIDs });
    // Autotask caps a single query at 500 rows — plenty for a resource roster.
    const rows = await http.query<Record<string, any>>(
      'Resources',
      filters.length ? filters : MATCH_ALL,
      { maxRecords: 500, includeFields: ['id', 'firstName', 'lastName', 'email', 'isActive', 'internalCost', 'payrollType', 'resourceType', 'licenseType', 'hireDate'] }
    );
    let payrollLabels = new Map<number, string>();
    let licenseLabels = new Map<number, string>();
    let apiUserLicenseValue: number | null = null;
    try {
      const fi = await this.getFieldInfo('Resources');
      payrollLabels = new Map((fi.find((f) => f.name === 'payrollType')?.picklistValues ?? []).map((v) => [Number(v.value), v.label]));
      const licVals = fi.find((f) => f.name === 'licenseType')?.picklistValues ?? [];
      licenseLabels = new Map(licVals.map((v) => [Number(v.value), v.label]));
      const apiVal = licVals.find((v) => /api user/i.test(String(v.label)));
      apiUserLicenseValue = apiVal ? Number(apiVal.value) : 7; // 7 = API User (standard)
    } catch { apiUserLicenseValue = 7; }
    // API/integration accounts (licenseType = API User) are not real staff and
    // would pollute cost/utilisation — excluded by default.
    const isApiUser = (r: Record<string, any>) => apiUserLicenseValue != null && Number(r.licenseType) === apiUserLicenseValue;
    const apiUsersExcluded = opts.includeApiUsers ? 0 : (rows || []).filter(isApiUser).length;
    const kept = (rows || []).filter((r) => opts.includeApiUsers || !isApiUser(r));
    const resources = kept.map((r) => ({
      id: Number(r.id),
      firstName: r.firstName ?? null,
      lastName: r.lastName ?? null,
      email: r.email ?? null,
      isActive: !!r.isActive,
      internalCost: r.internalCost != null ? Number(r.internalCost) : null,
      hasInternalCost: r.internalCost != null && Number(r.internalCost) > 0,
      payrollType: r.payrollType != null ? Number(r.payrollType) : null,
      payrollTypeLabel: r.payrollType != null ? (payrollLabels.get(Number(r.payrollType)) ?? null) : null,
      resourceType: r.resourceType ?? null,
      licenseType: r.licenseType != null ? Number(r.licenseType) : null,
      licenseTypeLabel: r.licenseType != null ? (licenseLabels.get(Number(r.licenseType)) ?? null) : null,
      hireDate: r.hireDate ?? null,
    }));
    const missingCost = resources.filter((r) => !r.hasInternalCost).length;
    return {
      count: resources.length,
      withCost: resources.length - missingCost,
      missingCost,
      apiUsersExcluded,
      notes: [
        'internalCost is the PER-HOUR internal cost as entered in Autotask (the labour-burden basis).',
        'The API does not indicate whether internalCost is fully loaded (wage + employer taxes + benefits) or wage-only — treat it per your data-entry convention; a wage-only figure understates true cost by ~25–30%.',
        'payrollType/resourceType give the employment basis (salaried vs hourly vs contractor). Department is not on the Resource — use get_resource_roles.',
        opts.includeApiUsers ? 'API/integration accounts INCLUDED (includeApiUsers=true).' : `${apiUsersExcluded} API/integration account(s) (licenseType = API User) excluded — pass includeApiUsers:true to include.`,
        missingCost > 0 ? `${missingCost} of the returned resource(s) have no internalCost set — their cost math falls back to a blended rate.` : 'All returned resources have an internalCost set.',
      ],
      resources,
    };
  }

  // =====================================================
  // Roles (#42) — Autotask role model. A Resource has a
  // `defaultServiceDeskRoleID` (its default role) and a set of ResourceRoles
  // (the roles it MAY act in). Ticket assignment needs assignedResourceRoleID
  // and time entries need roleID; both default to the resource's default role.
  // =====================================================

  /** Search Autotask Roles (id, name, hourlyRate, isActive, roleType). */
  async searchRoles(
    options: { searchTerm?: string; isActive?: boolean; pageSize?: number } = {}
  ): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [];
    pushEq(filters, 'isActive', options.isActive);
    if (options.searchTerm) filters.push({ op: 'contains', field: 'name', value: options.searchTerm });
    const pageSize = Math.min(options.pageSize || 100, 500);
    return http.query<Record<string, any>>('Roles', filters.length > 0 ? filters : MATCH_ALL, { maxRecords: pageSize });
  }

  /**
   * The roles a resource may act in (from ResourceRoles), enriched best-effort
   * with the role name and marking the resource's default role.
   */
  async getResourceRoles(resourceID: number): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const [links, resource] = await Promise.all([
      http.query<Record<string, any>>('ResourceRoles', [{ op: 'eq', field: 'resourceID', value: resourceID }], { maxRecords: 500 }),
      this.getResource(resourceID).catch(() => null),
    ]);
    const defaultRoleID = (resource as Record<string, any> | null)?.defaultServiceDeskRoleID ?? null;
    // Resolve role names for exactly this resource's roleIDs (an `in` query, so
    // there is no page cap to miss a real role). A roleID the Roles entity does
    // not return is a hidden SYSTEM role — e.g. 110/112, held by ~9 GDS
    // resources in Administration with no name and never used for time
    // (verified live 2026-09-29) — flagged roleExists:false. If the lookup
    // itself fails, roleExists is null (unknown), never false.
    let nameById: Map<number, string> | null = null;
    const roleIDs = [...new Set(links.map((l) => Number(l.roleID)).filter((id) => Number.isFinite(id)))];
    try {
      nameById = new Map();
      for (let i = 0; i < roleIDs.length; i += 200) {
        const roles = await http.query<{ id: number; name?: string }>('Roles', [{ op: 'in', field: 'id', value: roleIDs.slice(i, i + 200) }], { includeFields: ['id', 'name'], maxRecords: 500 });
        for (const r of roles) nameById.set(Number(r.id), String(r.name));
      }
    } catch { nameById = null; /* names are a nicety */ }
    // Department + queue names give an LLM the context to pick the right role
    // when a resource has several (e.g. Engineer in IT vs Administrative in Admin).
    let deptById = new Map<number, string>();
    try {
      const depts = await http.query<Record<string, any>>('Departments', MATCH_ALL, { includeFields: ['id', 'name'], maxRecords: 500 });
      deptById = new Map(depts.map((d) => [Number(d.id), String(d.name)]));
    } catch { /* best-effort */ }
    const queueById = new Map<number, string>();
    try {
      const fi = await this.getFieldInfo('Tickets');
      for (const v of fi.find((f) => f.name === 'queueID')?.picklistValues ?? []) queueById.set(Number(v.value), v.label);
    } catch { /* best-effort */ }
    return links.map((l) => ({
      ...l,
      roleName: nameById?.get(Number(l.roleID)) ?? null,
      roleExists: nameById ? nameById.has(Number(l.roleID)) : null,
      departmentName: l.departmentID != null ? (deptById.get(Number(l.departmentID)) ?? null) : null,
      queueName: l.queueID != null ? (queueById.get(Number(l.queueID)) ?? null) : null,
      isDefaultServiceDeskRole: defaultRoleID != null && Number(l.roleID) === Number(defaultRoleID),
    }));
  }

  /**
   * Resolve a resource's default role id for assignment / time entries
   * (`Resources.defaultServiceDeskRoleID`). Best-effort: returns null if the
   * resource can't be read or has no default role.
   */
  async resolveResourceDefaultRole(resourceID: number): Promise<number | null> {
    try {
      const resource = await this.getResource(resourceID) as Record<string, any> | null;
      const roleID = resource?.defaultServiceDeskRoleID;
      return typeof roleID === 'number' ? roleID : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the roleID for a ticket/task time entry (Autotask requires one).
   *
   * With `requestedRoleID` (the caller chose): VALIDATE it against the
   * resource's active roles — a role that isn't theirs returns `invalidRole`
   * plus the valid choices instead of being sent to Autotask.
   *
   * Without it: the resource's DEFAULT service-desk role, or its sole role —
   * otherwise a SELECTION list (roleID → canonical name + department/queue) so
   * the caller picks. Never guesses between several roles (see
   * utils/time-entry-role). `source` records how the role was chosen.
   */
  async resolveWorkTimeEntryRole(
    resourceID: number,
    requestedRoleID?: number | null
  ): Promise<
    | { roleID: number; roleName: string | null; source: 'explicit' | 'default' | 'sole' }
    | { needsSelection: RoleChoice[] }
    | { invalidRole: number; validRoles: RoleChoice[] }
    | { error: string }
  > {
    // Inactive ResourceRoles rows, and hidden system roles the Roles entity
    // doesn't return (roleExists:false — unnamed, not meant for billable
    // work), are not roles to log time in: neither offered nor accepted.
    const roles = (await this.getResourceRoles(resourceID)).filter((r) => r.roleID != null && r.isActive !== false && r.roleExists !== false);
    if (!roles.length) {
      return { error: `Resource ${resourceID} has no active roles assigned — ticket/task time entries require a role. Assign one in Autotask, then re-run.` };
    }
    // DEDUPE by roleID with the department(s)/queue(s) each covers — Autotask
    // stores one ResourceRoles row per department AND per queue, so the raw list
    // repeats roles.
    const byRole = new Map<number, { roleID: number; roleName: string | null; isDefault: boolean; departments: Set<string>; queues: Set<string> }>();
    for (const r of roles) {
      const id = Number(r.roleID);
      const e = byRole.get(id) ?? { roleID: id, roleName: r.roleName ?? null, isDefault: false, departments: new Set<string>(), queues: new Set<string>() };
      if (r.departmentName) e.departments.add(String(r.departmentName));
      if (r.queueName) e.queues.add(String(r.queueName));
      e.isDefault = e.isDefault || !!r.isDefaultServiceDeskRole;
      byRole.set(id, e);
    }
    const choices: RoleChoice[] = [...byRole.values()].map((e) => ({
      roleID: e.roleID,
      roleName: e.roleName,
      isDefault: e.isDefault,
      ...(e.departments.size ? { departments: [...e.departments] } : {}),
      ...(e.queues.size ? { queues: [...e.queues] } : {}),
    }));
    if (requestedRoleID != null) {
      const hit = byRole.get(Number(requestedRoleID));
      return hit
        ? { roleID: hit.roleID, roleName: hit.roleName, source: 'explicit' }
        : { invalidRole: Number(requestedRoleID), validRoles: choices };
    }
    const def = choices.find((c) => c.isDefault);
    if (def) return { roleID: def.roleID, roleName: def.roleName, source: 'default' };
    if (choices.length === 1) return { roleID: choices[0]!.roleID, roleName: choices[0]!.roleName, source: 'sole' };
    return { needsSelection: choices };
  }

  async searchResources(options: AutotaskQueryOptions = {}): Promise<PagedResult<AutotaskResource>> {
    try {
      this.logger.debug('Searching resources with options:', options);
      const filters: QueryFilter[] = [];
      if (options.searchTerm) {
        filters.push({
          op: 'or',
          items: [
            { op: 'contains', field: 'email', value: options.searchTerm },
            { op: 'contains', field: 'firstName', value: options.searchTerm },
            { op: 'contains', field: 'lastName', value: options.searchTerm }
          ]
        });
      }
      // `isActive` and `resourceType` are advertised by the tool schema but were
      // never translated into filters, so both were silently ignored.
      if (options.isActive !== undefined) {
        filters.push({ op: 'eq', field: 'isActive', value: options.isActive });
      }
      if ((options as any).resourceType !== undefined) {
        filters.push({ op: 'eq', field: 'resourceType', value: (options as any).resourceType });
      }
      return await this.queryPaged<AutotaskResource>('Resources', filters, options, { maxPageSize: 500 });
    } catch (error) {
      this.logger.error('Failed to search resources:', error);
      throw error;
    }
  }

  // =====================================================
  // Configuration Items
  // =====================================================

  async getConfigurationItem(id: number): Promise<AutotaskConfigurationItem | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting configuration item with ID: ${id}`);
      return await http.get<AutotaskConfigurationItem>('ConfigurationItems', id);
    } catch (error) {
      this.logger.error(`Failed to get configuration item ${id}:`, error);
      throw error;
    }
  }

  /**
   * Fields Autotask accepts when writing a ConfigurationItem, verified against
   * this tenant's `ConfigurationItems/entityInformation/fields`. Anything else
   * is either read-only (the whole `rmm*` / `ssl*` audit surface, which Autotask
   * populates from the RMM integration) or not a field at all, and sending it
   * risks the write being rejected outright.
   *
   * Deliberately absent: `companyID`. It is REQUIRED but READ-ONLY — set once,
   * through the company child route at create time, and never changeable after.
   * There is no "move this CI to another company" operation in the API.
   */
  private static readonly CI_WRITABLE_FIELDS = [
    'productID', 'isActive',
    // Placement and ownership
    'companyLocationID', 'contactID', 'parentConfigurationItemID', 'vendorID',
    // Commercial / entitlement
    'contractID', 'contractServiceID', 'contractServiceBundleID',
    'serviceID', 'serviceBundleID', 'serviceLevelAgreementID',
    // Classification
    'configurationItemCategoryID', 'configurationItemType',
    // Identity and descriptive
    'referenceNumber', 'referenceTitle', 'serialNumber', 'location', 'notes',
    'installDate', 'warrantyExpirationDate', 'numberOfUsers',
    // Costs
    'dailyCost', 'hourlyCost', 'monthlyCost', 'perUseCost', 'setupFee',
    // Domain records
    'domain', 'domainRegistrarID', 'domainExpirationDateTime',
    'domainRegistrationDateTime', 'domainLastUpdatedDateTime',
  ] as const;

  /** Keep only fields Autotask will accept, and report what was dropped. */
  private pickCIWritableFields(input: Record<string, any>): { payload: Record<string, any>; ignored: string[] } {
    const allowed = new Set<string>(AutotaskService.CI_WRITABLE_FIELDS as readonly string[]);
    const payload: Record<string, any> = {};
    const ignored: string[] = [];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (allowed.has(k)) payload[k] = v;
      else ignored.push(k);
    }
    return { payload, ignored };
  }

  /**
   * Create a configuration item (MCP-CI-001). CI reads — search, entitlement,
   * coverage gaps — already existed; the lifecycle WRITE path did not.
   *
   * Created through the company child route, because `companyID` is read-only on
   * the entity: it is fixed by the route at creation and cannot be changed
   * later. Same shape as `createContact` (§4.2).
   *
   * Guards before writing, since Autotask enforces none of these and each one
   * silently produces a CI that misreports entitlement:
   *   - the product exists (Autotask requires productID),
   *   - a referenced contract belongs to the SAME company as the CI,
   *   - a referenced parent CI belongs to the same company too.
   */
  async createConfigurationItem(data: Record<string, any>): Promise<number> {
    const http = await this.ensureClient();
    const companyID = data.companyID ?? data.companyId;
    if (companyID === undefined || companyID === null) {
      throw new Error(
        'Cannot create configuration item: companyID is required (configuration items are ' +
        'created via the Companies/{companyID}/ConfigurationItems child route, and companyID ' +
        'is read-only afterwards).'
      );
    }
    if (data.productID === undefined || data.productID === null) {
      throw new Error('Cannot create configuration item: productID is required by Autotask.');
    }

    if (data.contractID != null) {
      const contract = (await this.getContract(data.contractID)) as Record<string, any> | null;
      if (!contract) throw new Error(`Cannot create configuration item: contract ${data.contractID} not found.`);
      if (contract.companyID != null && contract.companyID !== companyID) {
        throw new Error(
          `Cannot create configuration item: contract ${data.contractID} belongs to company ` +
          `${contract.companyID}, not ${companyID}. A CI covered by another company's contract ` +
          'reports false entitlement.'
        );
      }
    }
    if (data.parentConfigurationItemID != null) {
      const parent = (await this.getConfigurationItem(data.parentConfigurationItemID)) as Record<string, any> | null;
      if (!parent) throw new Error(`Cannot create configuration item: parent CI ${data.parentConfigurationItemID} not found.`);
      if (parent.companyID != null && parent.companyID !== companyID) {
        throw new Error(
          `Cannot create configuration item: parent CI ${data.parentConfigurationItemID} belongs to ` +
          `company ${parent.companyID}, not ${companyID}.`
        );
      }
    }

    const { payload, ignored } = this.pickCIWritableFields(data);
    if (payload.isActive === undefined) payload.isActive = true;
    if (ignored.length > 0) {
      this.logger.warn(
        `createConfigurationItem: ignoring field(s) Autotask does not accept on ConfigurationItems: ${ignored.join(', ')}`
      );
    }

    try {
      const id = await http.childCreate('Companies', companyID, 'ConfigurationItems', payload);
      this.logger.info(`Configuration item created with ID: ${id} (company ${companyID})`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create configuration item:', error);
      throw error;
    }
  }

  /**
   * Update a configuration item (MCP-CI-001) — the same lifecycle surface as
   * create, minus `companyID`, which Autotask will not let you change.
   *
   * There is no lifecycle/status picklist on ConfigurationItems in this tenant:
   * `isActive` is the only state field, so "retire" is `isActive: false`.
   */
  async updateConfigurationItem(id: number, updates: Record<string, any>): Promise<void> {
    const http = await this.ensureClient();
    if (updates.companyID !== undefined || updates.companyId !== undefined) {
      throw new Error(
        `Cannot update configuration item ${id}: companyID is read-only in Autotask. ` +
        'A CI cannot be moved between companies — retire it (isActive: false) and create ' +
        'a new one under the correct company.'
      );
    }

    const { payload, ignored } = this.pickCIWritableFields(updates);
    if (Object.keys(payload).length === 0) {
      throw new Error(
        `Cannot update configuration item ${id}: no writable fields supplied` +
        (ignored.length > 0 ? ` (ignored: ${ignored.join(', ')})` : '') + '.'
      );
    }
    if (ignored.length > 0) {
      this.logger.warn(
        `updateConfigurationItem: ignoring field(s) Autotask does not accept on ConfigurationItems: ${ignored.join(', ')}`
      );
    }

    try {
      await http.update('ConfigurationItems', id, payload);
      this.logger.info(`Configuration item ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update configuration item ${id}:`, error);
      throw error;
    }
  }

  /**
   * Resolve human-readable names for a configuration item's reference fields
   * (§5 enrichReferences). Best-effort: every lookup is independent and a
   * failed/absent reference is simply omitted — enrichment never throws or
   * fails the underlying get. Only references with a single-record getter are
   * resolved; the resolved names are returned under a `_enriched` bag so the
   * raw CI fields stay untouched.
   */
  async enrichConfigurationItemReferences(
    ci: AutotaskConfigurationItem
  ): Promise<Record<string, string>> {
    const enriched: Record<string, string> = {};
    const set = (key: string, value: unknown) => {
      if (typeof value === 'string' && value.length > 0) enriched[key] = value;
    };
    const tryGet = async (fn: () => Promise<void>) => {
      try { await fn(); } catch { /* best-effort: skip a reference that won't resolve */ }
    };

    const tasks: Array<Promise<void>> = [];
    if (ci.companyID != null) {
      tasks.push(tryGet(async () => {
        const c = await this.getCompany(ci.companyID as number);
        set('companyName', c?.companyName);
      }));
    }
    if (ci.contractID != null) {
      tasks.push(tryGet(async () => {
        const c = await this.getContract(ci.contractID as number) as Record<string, any> | null;
        set('contractName', c?.contractName);
        if (c?.status != null) enriched.contractStatus = String(c.status);
      }));
    }
    if (ci.serviceID != null) {
      tasks.push(tryGet(async () => {
        const svc = await this.getService(ci.serviceID as number) as Record<string, any> | null;
        set('serviceName', svc?.name);
      }));
    }
    if (ci.contractServiceID != null) {
      tasks.push(tryGet(async () => {
        const cs = await this.getContractService(ci.contractServiceID as number);
        set('contractServiceName', cs?.invoiceDescription || cs?.internalDescription);
      }));
    }
    if (ci.productID != null) {
      tasks.push(tryGet(async () => {
        const p = await this.getProduct(ci.productID as number) as Record<string, any> | null;
        set('productName', p?.name);
      }));
    }
    if (ci.parentConfigurationItemID != null) {
      tasks.push(tryGet(async () => {
        const parent = await this.getConfigurationItem(ci.parentConfigurationItemID as number);
        set('parentConfigurationItemName', parent?.referenceTitle as string | undefined);
      }));
    }
    await Promise.all(tasks);
    return enriched;
  }

  async searchConfigurationItems(options: AutotaskQueryOptions = {}): Promise<AutotaskConfigurationItem[]> {
    try {
      this.logger.debug('Searching configuration items with options:', options);
      // Schema-shaped filter args were previously dropped — issue #105.
      const filters: QueryFilter[] = [];
      const o = options as any;

      pushEq(filters, 'companyID', o.companyID);
      pushEq(filters, 'isActive', o.isActive);
      pushEq(filters, 'productID', o.productID);
      pushEq(filters, 'configurationItemType', o.configurationItemType);
      pushEq(filters, 'configurationItemCategoryID', o.configurationItemCategoryID);
      // Entitlement filters (§4.1) — the native CI→contract/service linkage the
      // revenue-first automation matches against. All verified queryable on the
      // live ConfigurationItems schema.
      pushEq(filters, 'companyLocationID', o.companyLocationID);
      pushEq(filters, 'contractID', o.contractID);
      pushEq(filters, 'contractServiceID', o.contractServiceID);
      pushEq(filters, 'contractServiceBundleID', o.contractServiceBundleID);
      pushEq(filters, 'serviceID', o.serviceID);
      pushEq(filters, 'serviceBundleID', o.serviceBundleID);
      pushEq(filters, 'parentConfigurationItemID', o.parentConfigurationItemID);
      if (o.searchTerm) {
        filters.push({ op: 'contains', field: 'referenceTitle', value: o.searchTerm });
      }
      // Serial number (UPS / firewall alerts carry it): the serial field, or the reference number many techs put it in.
      if (o.serialNumber != null && String(o.serialNumber).trim()) {
        const sn = String(o.serialNumber).trim();
        filters.push({ op: 'or', items: [{ op: 'eq', field: 'serialNumber', value: sn }, { op: 'eq', field: 'referenceNumber', value: sn }] });
      }
      mergeFilterEscapeHatch(filters, options.filter);

      const pageSize = Math.min(options.pageSize || 25, 500);
      // Served from the Postgres shadow when it mirrors ConfigurationItems and is fresh (0 Autotask calls).
      return (await this.queryPaged<AutotaskConfigurationItem>('ConfigurationItems', filters.length > 0 ? filters : MATCH_ALL, { pageSize }, { defaultPageSize: 25, maxPageSize: 500 })).items;
    } catch (error) {
      this.logger.error('Failed to search configuration items:', error);
      throw error;
    }
  }

  // Note: createConfigurationItem/updateConfigurationItem live above, next to
  // getConfigurationItem. The unguarded passthroughs that used to sit here wrote
  // through the top-level POST /ConfigurationItems route and were never exposed
  // as tools (no callers anywhere) — they are replaced, not moved.

  // =====================================================
  // Contracts (read-only)
  // =====================================================

  async getContract(id: number): Promise<AutotaskContract | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting contract with ID: ${id}`);
      return await http.get<AutotaskContract>('Contracts', id);
    } catch (error) {
      this.logger.error(`Failed to get contract ${id}:`, error);
      throw error;
    }
  }

  async searchContracts(options: AutotaskQueryOptions = {}): Promise<AutotaskContract[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching contracts with options:', options);
      // Schema-shaped filter args were previously dropped — issue #105.
      const filters: QueryFilter[] = [];
      const o = options as any;

      pushEq(filters, 'companyID', o.companyID);
      pushEq(filters, 'status', o.status);
      pushEq(filters, 'contractType', o.contractType);
      if (o.searchTerm) {
        filters.push({ op: 'contains', field: 'contractName', value: o.searchTerm });
      }
      if (o.endDateFrom) {
        filters.push({ op: 'gte', field: 'endDate', value: o.endDateFrom });
      }
      if (o.endDateTo) {
        filters.push({ op: 'lte', field: 'endDate', value: o.endDateTo });
      }
      mergeFilterEscapeHatch(filters, options.filter);

      const pageSize = Math.min(options.pageSize || 25, 500);
      return await http.query<AutotaskContract>(
        'Contracts',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: pageSize }
      );
    } catch (error) {
      this.logger.error('Failed to search contracts:', error);
      throw error;
    }
  }

  /**
   * Contract labour-billing basis (dashboard gap #4). Per contract, derives
   * whether labour is billed on top (T&M / Per Ticket), drawn from a prepaid
   * block (Block Hours), or absorbed in the fee (Fixed Price / Retainer /
   * Recurring Service) — the flag that tells a real billing leak from a contract
   * working as designed. Also surfaces billingPreference (why time may sit
   * unapproved) and overageBillingRate. Read-only. Active contracts by default.
   */
  async reportContractLabourBasis(opts: { companyID?: number; includeInactive?: boolean; contractType?: number } = {}): Promise<{
    count: number;
    byBasis: Record<LabourBasis, number>;
    notes: string[];
    contracts: Array<{
      id: number; contractName: string | null; companyID: number | null;
      contractType: number | null; contractTypeLabel: string | null;
      basis: LabourBasis; labourBilled: boolean | null; leakageRelevant: boolean; description: string;
      billingPreference: number | null; billingPreferenceLabel: string | null;
      overageBillingRate: number | null; setupFee: number | null; contractExclusionSetID: number | null;
    }>;
  }> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [];
    if (!opts.includeInactive) filters.push({ op: 'eq', field: 'status', value: 1 });
    if (opts.companyID != null) filters.push({ op: 'eq', field: 'companyID', value: opts.companyID });
    if (opts.contractType != null) filters.push({ op: 'eq', field: 'contractType', value: opts.contractType });
    const rows = await http.query<Record<string, any>>(
      'Contracts',
      filters.length ? filters : MATCH_ALL,
      { maxRecords: 500, includeFields: ['id', 'contractName', 'companyID', 'contractType', 'billingPreference', 'overageBillingRate', 'setupFee', 'contractExclusionSetID'] }
    );
    let typeLabels = new Map<number, string>();
    let prefLabels = new Map<number, string>();
    try {
      const fi = await this.getFieldInfo('Contracts');
      typeLabels = new Map((fi.find((f) => f.name === 'contractType')?.picklistValues ?? []).map((v) => [Number(v.value), v.label]));
      prefLabels = new Map((fi.find((f) => f.name === 'billingPreference')?.picklistValues ?? []).map((v) => [Number(v.value), v.label]));
    } catch { /* labels are a nicety */ }
    const byBasis: Record<LabourBasis, number> = { billed: 0, block: 0, absorbed: 0, umbrella: 0, unknown: 0 };
    const contracts = (rows || []).map((c) => {
      const cls = classifyContractLabourBilling(c.contractType);
      byBasis[cls.basis] += 1;
      return {
        id: Number(c.id),
        contractName: c.contractName ?? null,
        companyID: c.companyID != null ? Number(c.companyID) : null,
        contractType: c.contractType != null ? Number(c.contractType) : null,
        contractTypeLabel: c.contractType != null ? (typeLabels.get(Number(c.contractType)) ?? null) : null,
        basis: cls.basis,
        labourBilled: cls.labourBilled,
        leakageRelevant: cls.leakageRelevant,
        description: cls.description,
        billingPreference: c.billingPreference != null ? Number(c.billingPreference) : null,
        billingPreferenceLabel: c.billingPreference != null ? (prefLabels.get(Number(c.billingPreference)) ?? null) : null,
        overageBillingRate: c.overageBillingRate != null ? Number(c.overageBillingRate) : null,
        setupFee: c.setupFee != null ? Number(c.setupFee) : null,
        contractExclusionSetID: c.contractExclusionSetID != null ? Number(c.contractExclusionSetID) : null,
      };
    });
    return {
      count: contracts.length,
      byBasis,
      notes: [
        'Labour basis is derived from contractType (Autotask has no direct "labour included" field).',
        'leakageRelevant=true (T&M / Per Ticket / Block overage) means unbilled/unapproved time on that contract is worth chasing; absorbed (Fixed/Retainer/Recurring) means it is by design.',
        'billingPreference explains WHY time may sit unapproved: "Manually" and "On timesheet approval" both defer billing until a person acts.',
        'Cross-reference this with report_unbilled_time / report_unbilled so the $ signal is scoped to leakageRelevant contracts.',
      ],
      contracts,
    };
  }

  /**
   * Expiring/expired contracts report (issue #237): contracts whose endDate
   * falls within the next `daysAhead` days (default 60). With
   * `includeExpired`, already-lapsed contracts are included too. Scope to one
   * company via `companyID`, or the whole org by omitting it.
   */
  async listExpiringContracts(options: {
    daysAhead?: number;
    companyID?: number;
    includeExpired?: boolean;
    status?: number;
    pageSize?: number;
  } = {}): Promise<AutotaskContract[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Listing expiring contracts with options:', options);
      const daysAhead = options.daysAhead ?? 60;
      const dayMs = 24 * 60 * 60 * 1000;
      const isoDay = (d: Date) => d.toISOString().slice(0, 10);
      const today = new Date();

      const filters: QueryFilter[] = [
        { op: 'lte', field: 'endDate', value: isoDay(new Date(today.getTime() + daysAhead * dayMs)) },
      ];
      if (!options.includeExpired) {
        filters.push({ op: 'gte', field: 'endDate', value: isoDay(today) });
      }
      pushEq(filters, 'companyID', options.companyID);
      pushEq(filters, 'status', options.status);

      const pageSize = Math.min(options.pageSize || 100, 500);
      return await http.query<AutotaskContract>('Contracts', filters, { maxRecords: pageSize });
    } catch (error) {
      this.logger.error('Failed to list expiring contracts:', error);
      throw error;
    }
  }

  // =====================================================
  // Contracts (write) and ContractServices CRUD
  // =====================================================

  async createContract(contract: Partial<AutotaskContract>): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating contract:', contract);
      const id = await http.create('Contracts', contract);
      this.logger.info(`Contract created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create contract:', error);
      throw error;
    }
  }

  /**
   * Bulk contract-shell creation (issue #237). The Autotask REST API has no
   * batch endpoint for Contracts, so shells are POSTed one at a time —
   * sequentially, to stay under the per-integration API thresholds. A failed
   * shell doesn't abort the batch; each item reports its own outcome so
   * callers can retry just the failures.
   */
  async createContracts(contracts: Partial<AutotaskContract>[]): Promise<Array<{
    index: number;
    contractName?: string | undefined;
    success: boolean;
    id?: number | undefined;
    error?: string | undefined;
  }>> {
    const results: Array<{
      index: number;
      contractName?: string | undefined;
      success: boolean;
      id?: number | undefined;
      error?: string | undefined;
    }> = [];
    for (const [index, contract] of contracts.entries()) {
      try {
        const id = await this.createContract(contract);
        results.push({ index, contractName: contract.contractName, success: true, id });
      } catch (error) {
        results.push({
          index,
          contractName: contract.contractName,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  async updateContract(id: number, updates: Partial<AutotaskContract>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating contract ${id}:`, updates);
      await http.update('Contracts', id, updates as Record<string, any>);
      this.logger.info(`Contract ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update contract ${id}:`, error);
      throw error;
    }
  }

  async createContractService(cs: Record<string, any>): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating contract service:', cs);
      const id = await http.create('ContractServices', cs);
      this.logger.info(`ContractService created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create contract service:', error);
      throw error;
    }
  }

  async updateContractService(id: number, updates: Record<string, any>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating contract service ${id}:`, updates);
      await http.update('ContractServices', id, updates);
      this.logger.info(`ContractService ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update contract service ${id}:`, error);
      throw error;
    }
  }

  /**
   * Get a single ContractService line by id (§6). Returns null on a missing-by-id
   * GET (Autotask 200 {item:null}); `http.get` routes through unwrapEntity.
   */
  async getContractService(id: number): Promise<Record<string, any> | null> {
    const http = await this.ensureClient();
    return http.get<Record<string, any>>('ContractServices', id);
  }

  /**
   * Search ContractService lines (§6) — the "is this CI still entitled through
   * an active Contract Service?" read. Filter by contractID (all service lines
   * on a contract), serviceID, and/or quoteItemID; all three are verified
   * queryable on the live ContractServices schema. With no filter this returns
   * the first page of contract services (bounded by pageSize) rather than
   * scanning the whole tenant.
   */
  async searchContractServices(
    options: { contractID?: number; serviceID?: number; quoteItemID?: number; pageSize?: number } = {}
  ): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [];
    pushEq(filters, 'contractID', options.contractID);
    pushEq(filters, 'serviceID', options.serviceID);
    pushEq(filters, 'quoteItemID', options.quoteItemID);
    const pageSize = Math.min(options.pageSize || 25, 500);
    return http.query<Record<string, any>>(
      'ContractServices',
      filters.length > 0 ? filters : MATCH_ALL,
      { maxRecords: pageSize }
    );
  }

  /**
   * Search ContractServiceBundles — the recurring BUNDLE lines on a contract
   * (#73). Live schema (verified): contractID, serviceBundleID, unitPrice,
   * adjustedPrice, invoiceDescription; no per-period `units` (those live in
   * ContractServiceBundleUnits).
   */
  async searchContractServiceBundles(
    options: { contractID?: number; serviceBundleID?: number; pageSize?: number } = {}
  ): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [];
    pushEq(filters, 'contractID', options.contractID);
    pushEq(filters, 'serviceBundleID', options.serviceBundleID);
    const pageSize = Math.min(options.pageSize || 25, 500);
    return http.query<Record<string, any>>(
      'ContractServiceBundles',
      filters.length > 0 ? filters : MATCH_ALL,
      { maxRecords: pageSize }
    );
  }

  /**
   * Search ContractServiceUnits — the per-period BILLED UNITS for a contract's
   * service lines (#73). Each row is one line for one period with `units` and a
   * (prorated on partial months) `price`. Live schema (verified): all fields
   * read-only; contractID / contractServiceID / serviceID / startDate / endDate
   * are queryable. `coversDate` narrows to the period covering a date (the
   * roll-up path); `startAfter`/`startBefore` bound a reporting window.
   */
  async searchContractServiceUnits(
    options: {
      contractID?: number | undefined; contractServiceID?: number | undefined; serviceID?: number | undefined;
      coversDate?: string | undefined; startAfter?: string | undefined; startBefore?: string | undefined; pageSize?: number | undefined;
    } = {}
  ): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [];
    pushEq(filters, 'contractID', options.contractID);
    pushEq(filters, 'contractServiceID', options.contractServiceID);
    pushEq(filters, 'serviceID', options.serviceID);
    if (options.coversDate) {
      filters.push({ op: 'lte', field: 'startDate', value: options.coversDate });
      filters.push({ op: 'gte', field: 'endDate', value: options.coversDate });
    }
    if (options.startAfter) filters.push({ op: 'gte', field: 'startDate', value: options.startAfter });
    if (options.startBefore) filters.push({ op: 'lte', field: 'startDate', value: options.startBefore });
    const pageSize = Math.min(options.pageSize || 100, 500);
    return http.query<Record<string, any>>(
      'ContractServiceUnits',
      filters.length > 0 ? filters : MATCH_ALL,
      { maxRecords: pageSize }
    );
  }

  /**
   * Search ContractServiceBundleUnits — the per-period BILLED UNITS for a
   * contract's bundle lines (#73). Bundle analog of searchContractServiceUnits;
   * keyed by contractServiceBundleID / serviceBundleID.
   */
  async searchContractServiceBundleUnits(
    options: {
      contractID?: number | undefined; contractServiceBundleID?: number | undefined; serviceBundleID?: number | undefined;
      coversDate?: string | undefined; startAfter?: string | undefined; startBefore?: string | undefined; pageSize?: number | undefined;
    } = {}
  ): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [];
    pushEq(filters, 'contractID', options.contractID);
    pushEq(filters, 'contractServiceBundleID', options.contractServiceBundleID);
    pushEq(filters, 'serviceBundleID', options.serviceBundleID);
    if (options.coversDate) {
      filters.push({ op: 'lte', field: 'startDate', value: options.coversDate });
      filters.push({ op: 'gte', field: 'endDate', value: options.coversDate });
    }
    if (options.startAfter) filters.push({ op: 'gte', field: 'startDate', value: options.startAfter });
    if (options.startBefore) filters.push({ op: 'lte', field: 'startDate', value: options.startBefore });
    const pageSize = Math.min(options.pageSize || 100, 500);
    return http.query<Record<string, any>>(
      'ContractServiceBundleUnits',
      filters.length > 0 ? filters : MATCH_ALL,
      { maxRecords: pageSize }
    );
  }

  /**
   * Billed-units report for a contract (#73): the actual per-period unit
   * rows for its service lines (and, unless excluded, bundle lines), enriched
   * with service/bundle names. Read-only. Scope by contract, a single service
   * line, and/or a start-date window.
   */
  async getContractBilledUnits(options: {
    contractID?: number; contractServiceID?: number;
    startAfter?: string; startBefore?: string; includeBundles?: boolean; pageSize?: number;
  }): Promise<{
    serviceUnits: Array<Record<string, any>>;
    bundleUnits: Array<Record<string, any>>;
    totalServiceUnits: number;
    totalBundleUnits: number;
    totalBilled: number;
  }> {
    const includeBundles = options.includeBundles !== false;
    const serviceUnits = await this.searchContractServiceUnits({
      contractID: options.contractID,
      contractServiceID: options.contractServiceID,
      startAfter: options.startAfter,
      startBefore: options.startBefore,
      pageSize: options.pageSize,
    });
    // Bundle units have no contractServiceID; only fetch them for a whole-contract
    // scope (not when a single service line was requested).
    const bundleUnits = includeBundles && options.contractServiceID == null
      ? await this.searchContractServiceBundleUnits({
          contractID: options.contractID,
          startAfter: options.startAfter,
          startBefore: options.startBefore,
          pageSize: options.pageSize,
        })
      : [];
    await this.enrichServiceUnitNames(serviceUnits, bundleUnits);
    const sum = (rows: Array<Record<string, any>>) =>
      rows.reduce((t, r) => t + (typeof r.price === 'number' ? r.price : 0), 0);
    return {
      serviceUnits,
      bundleUnits,
      totalServiceUnits: serviceUnits.length,
      totalBundleUnits: bundleUnits.length,
      totalBilled: Math.round((sum(serviceUnits) + sum(bundleUnits) + Number.EPSILON) * 100) / 100,
    };
  }

  /**
   * Recurring-revenue roll-up for a contract (#73): MRR/ARR from its service +
   * bundle rate lines and the per-period units covering `asOf` (default today).
   * MRR = Σ units × rate (rate = adjustedPrice ?? unitPrice) — the prorated
   * per-period `price` is surfaced per line but never summed (see
   * utils/recurring-revenue). Read-only.
   */
  async getContractRecurringRevenue(options: {
    contractID: number; asOfDate?: string;
  }): Promise<RecurringRevenue & { contractID: number }> {
    const asOf = options.asOfDate ? new Date(options.asOfDate) : new Date();
    const coversDate = asOf.toISOString().slice(0, 10);
    const [serviceLines, bundleLines, serviceUnitRows, bundleUnitRows] = await Promise.all([
      this.searchContractServices({ contractID: options.contractID, pageSize: 500 }),
      this.searchContractServiceBundles({ contractID: options.contractID, pageSize: 500 }),
      this.searchContractServiceUnits({ contractID: options.contractID, coversDate, pageSize: 500 }),
      this.searchContractServiceBundleUnits({ contractID: options.contractID, coversDate, pageSize: 500 }),
    ]);
    const report = computeRecurringRevenue({
      asOf,
      serviceLines: serviceLines.map((l) => ({ id: l.id as number, refId: l.serviceID as number, unitPrice: l.unitPrice as number, adjustedPrice: l.adjustedPrice as number })),
      bundleLines: bundleLines.map((l) => ({ id: l.id as number, refId: l.serviceBundleID as number, unitPrice: l.unitPrice as number, adjustedPrice: l.adjustedPrice as number })),
      serviceUnits: serviceUnitRows.map((u) => ({ lineId: u.contractServiceID as number, units: u.units as number, price: u.price as number, startDate: u.startDate as string, endDate: u.endDate as string })),
      bundleUnits: bundleUnitRows.map((u) => ({ lineId: u.contractServiceBundleID as number, units: u.units as number, price: u.price as number, startDate: u.startDate as string, endDate: u.endDate as string })),
    });
    await this.enrichRecurringLineNames(report.lines);
    return { contractID: options.contractID, ...report };
  }

  /** Best-effort: attach `serviceName`/`serviceBundleName` to raw unit rows. */
  private async enrichServiceUnitNames(
    serviceUnits: Array<Record<string, any>>, bundleUnits: Array<Record<string, any>>
  ): Promise<void> {
    try {
      const svcIds = [...new Set(serviceUnits.map((r) => r.serviceID).filter((v) => typeof v === 'number'))];
      const bunIds = [...new Set(bundleUnits.map((r) => r.serviceBundleID).filter((v) => typeof v === 'number'))];
      const svcNames = new Map<number, string>();
      const bunNames = new Map<number, string>();
      await Promise.all([
        ...svcIds.map(async (id) => { const s = await this.getService(id).catch(() => null); if (s?.name) svcNames.set(id, s.name); }),
        ...bunIds.map(async (id) => { const b = await this.getServiceBundle(id).catch(() => null); if (b?.name) bunNames.set(id, b.name); }),
      ]);
      for (const r of serviceUnits) if (svcNames.has(r.serviceID)) r.serviceName = svcNames.get(r.serviceID);
      for (const r of bundleUnits) if (bunNames.has(r.serviceBundleID)) r.serviceBundleName = bunNames.get(r.serviceBundleID);
    } catch { /* enrichment is best-effort */ }
  }

  /** Best-effort: attach `refName` (service or bundle name) to roll-up lines. */
  private async enrichRecurringLineNames(lines: RecurringLine[]): Promise<void> {
    try {
      const svcIds = [...new Set(lines.filter((l) => l.kind === 'service' && l.refId != null).map((l) => l.refId as number))];
      const bunIds = [...new Set(lines.filter((l) => l.kind === 'bundle' && l.refId != null).map((l) => l.refId as number))];
      const svcNames = new Map<number, string>();
      const bunNames = new Map<number, string>();
      await Promise.all([
        ...svcIds.map(async (id) => { const s = await this.getService(id).catch(() => null); if (s?.name) svcNames.set(id, s.name); }),
        ...bunIds.map(async (id) => { const b = await this.getServiceBundle(id).catch(() => null); if (b?.name) bunNames.set(id, b.name); }),
      ]);
      for (const l of lines) {
        const name = l.kind === 'service' ? svcNames.get(l.refId as number) : bunNames.get(l.refId as number);
        if (name) l.refName = name;
      }
    } catch { /* enrichment is best-effort */ }
  }

  // =====================================================
  // ContractMilestones (§30) — commercial milestone payments on a contract.
  // Live entity metadata: canDelete=false (no delete tool); contractID is
  // required + readonly (set at create, immutable); status is a tenant picklist.
  // =====================================================

  async getContractMilestone(id: number): Promise<Record<string, any> | null> {
    const http = await this.ensureClient();
    return http.get<Record<string, any>>('ContractMilestones', id);
  }

  /**
   * Search contract milestones, primarily by contractID (all milestones on a
   * contract). Optional status narrows to a picklist state. Returns [] when no
   * filter is given rather than scanning every milestone in the tenant.
   */
  async searchContractMilestones(
    options: { contractID?: number; status?: number; pageSize?: number } = {}
  ): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [];
    pushEq(filters, 'contractID', options.contractID);
    pushEq(filters, 'status', options.status);
    if (filters.length === 0) return [];
    return http.query('ContractMilestones', filters, { maxRecords: options.pageSize || 500 });
  }

  async createContractMilestone(milestone: Record<string, any>): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating contract milestone:', milestone);
      if (!milestone.contractID) {
        throw new Error('contractID is required to create a contract milestone');
      }
      const id = await http.create('ContractMilestones', milestone);
      this.logger.info(`ContractMilestone created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create contract milestone:', error);
      throw error;
    }
  }

  /**
   * Update a contract milestone. contractID is readonly in Autotask, so it is
   * dropped if passed — every other writable field (title, amount, dateDue,
   * status, isInitialPayment, description, billingCodeID) is forwarded.
   */
  async updateContractMilestone(id: number, updates: Record<string, any>): Promise<void> {
    const http = await this.ensureClient();
    const { contractID, ...writable } = updates;
    try {
      this.logger.debug(`Updating contract milestone ${id}:`, writable);
      await http.update('ContractMilestones', id, writable);
      this.logger.info(`ContractMilestone ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update contract milestone ${id}:`, error);
      throw error;
    }
  }

  /**
   * Block-hour contract usage report (contractType 4). Monthly, use-it-or-lose-it:
   * each month's purchased block hours vs billable hours worked → overage /
   * forfeited (see utils/block-hours). Scope by contractID, companyID, or all
   * active block-hour contracts (the default).
   */
  async getBlockHourUsage(
    opts: { contractID?: number; companyID?: number; includeInactive?: boolean } = {}
  ): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [{ op: 'eq', field: 'contractType', value: 4 }];
    if (opts.contractID !== undefined) filters.push({ op: 'eq', field: 'id', value: opts.contractID });
    if (opts.companyID !== undefined) filters.push({ op: 'eq', field: 'companyID', value: opts.companyID });
    if (!opts.includeInactive) filters.push({ op: 'eq', field: 'status', value: 1 });

    const contracts = await http.query<any>('Contracts', filters, {
      includeFields: ['id', 'contractName', 'companyID', 'status', 'startDate', 'endDate'],
      maxRecords: 500,
    });

    const results: Array<Record<string, any>> = [];
    for (const c of contracts) {
      const [blocks, entries] = await Promise.all([
        http.query<any>('ContractBlocks', [{ op: 'eq', field: 'contractID', value: c.id }], {
          includeFields: ['hours', 'startDate', 'status'],
          maxRecords: 500,
        }),
        http.query<any>('TimeEntries', [{ op: 'eq', field: 'contractID', value: c.id }], {
          includeFields: ['dateWorked', 'hoursWorked', 'hoursToBill', 'isNonBillable'],
          maxRecords: 5000,
        }),
      ]);
      const usage = computeBlockHourUsage(blocks, entries);
      results.push({
        contractId: c.id,
        contractName: c.contractName,
        companyID: c.companyID,
        active: c.status === 1,
        term: { start: c.startDate, end: c.endDate },
        ...usage,
      });
    }
    return results;
  }

  // =====================================================
  // Invoices
  // =====================================================

  async getInvoice(id: number): Promise<AutotaskInvoice | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting invoice with ID: ${id}`);
      return await http.get<AutotaskInvoice>('Invoices', id);
    } catch (error) {
      this.logger.error(`Failed to get invoice ${id}:`, error);
      throw error;
    }
  }

  // Invoice fields the read optimizer must NOT strip (verified live 2026-09-23).
  // Includes the QuickBooks-sync markers the dashboard billing-gap rule needs:
  // invoiceNumber (blank = never synced), webServiceDate (QBO), paidDate, isVoided.
  // Timestamps are exposed over booleans on purpose (voidedDate/paidDate/webServiceDate).
  private readonly INVOICE_FIELDS = [
    'id', 'invoiceNumber', 'batchID', 'invoiceDateTime', 'dueDate', 'fromDate', 'toDate',
    'invoiceTotal', 'totalTaxValue', 'isVoided', 'voidedDate', 'paidDate', 'webServiceDate',
    'orderNumber', 'invoiceStatus', 'paymentTerm', 'comments', 'companyID', 'createDateTime', 'creatorResourceID',
  ];

  async searchInvoices(options: AutotaskQueryOptions = {}): Promise<AutotaskInvoice[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching invoices with options:', options);
      // Schema-shaped filter args were previously dropped — issue #105.
      const filters: QueryFilter[] = [];
      const o = options as any;

      pushEq(filters, 'companyID', o.companyID);
      pushEq(filters, 'invoiceNumber', o.invoiceNumber);
      pushEq(filters, 'isVoided', o.isVoided);
      pushEq(filters, 'batchID', o.batchID);
      // "Never synced to QuickBooks" = invoiceNumber is null (blank). The dashboard
      // billing-gap rule keys on this. Voids legitimately have no number, so callers
      // typically pair unsyncedOnly with isVoided:false.
      if (o.unsyncedOnly === true) filters.push({ op: 'notExist', field: 'invoiceNumber' });
      if (o.fromDate) filters.push({ op: 'gte', field: 'invoiceDateTime', value: o.fromDate });
      if (o.toDate) filters.push({ op: 'lte', field: 'invoiceDateTime', value: o.toDate });
      mergeFilterEscapeHatch(filters, options.filter);

      const pageSize = Math.min(options.pageSize || 25, 500);
      return await http.query<AutotaskInvoice>(
        'Invoices',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: pageSize, includeFields: this.INVOICE_FIELDS }
      );
    } catch (error) {
      this.logger.error('Failed to search invoices:', error);
      throw error;
    }
  }

  /**
   * Get an invoice with its line items composed from BillingItems.
   *
   * The Autotask REST API supports `includeItemsAndExpenses=true` on the GET
   * /Invoices/{id} endpoint, but since our shared HTTP helper doesn't pass
   * query params, we use the simpler approach: fetch the invoice, then fetch
   * BillingItems filtered by invoiceID. The result shape is identical.
   */
  async getInvoiceDetails(id: number): Promise<AutotaskInvoice | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting invoice details with ID: ${id}`);
      const invoice = await http.get<AutotaskInvoice>('Invoices', id);
      if (!invoice) return null;

      let lineItems: AutotaskBillingItem[] = [];
      try {
        lineItems = await http.query<AutotaskBillingItem>(
          'BillingItems',
          [{ op: 'eq', field: 'invoiceID', value: id }],
          { maxRecords: 500, includeFields: ['id', 'invoiceID', 'ticketID', 'taskID', 'projectID', 'ticketChargeID', 'itemName', 'lineItemFullDescription', 'itemDate', 'nonBillable', 'billingItemType'] }
        );
      } catch (biErr) {
        this.logger.warn(
          `Failed to fetch line items for invoice ${id}: ${(biErr as Error).message}`
        );
      }

      // Invoice → work linkage: which tickets/projects/tasks this invoice billed
      // (from its BillingItems) — so a finding can name the job, not just a value.
      const distinct = (field: 'ticketID' | 'projectID' | 'taskID'): number[] =>
        [...new Set(lineItems.map((li) => (li as Record<string, any>)[field]).filter((v): v is number => typeof v === 'number' && v > 0))];

      return {
        ...invoice,
        lineItems,
        linkedTicketIDs: distinct('ticketID'),
        linkedProjectIDs: distinct('projectID'),
        linkedTaskIDs: distinct('taskID'),
      };
    } catch (error) {
      this.logger.error(`Failed to get invoice details ${id}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Tasks
  // =====================================================

  async getTask(id: number): Promise<AutotaskTask | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting task with ID: ${id}`);
      return await http.get<AutotaskTask>('Tasks', id);
    } catch (error) {
      this.logger.error(`Failed to get task ${id}:`, error);
      throw error;
    }
  }

  /**
   * Look up a project task by its human-facing task number (e.g.
   * "T20260922.0189") and return the FULL task object. Exact match on
   * `taskNumber`, then a by-id GET for all fields — one call for the caller
   * instead of resolve-reference (which returns only id/number/title) + get.
   * A task number should be unique, so >1 hit is surfaced as ambiguous rather
   * than silently picking the first.
   */
  async getTaskByNumber(taskNumber: string): Promise<{
    status: 'found' | 'not-found' | 'ambiguous';
    taskNumber: string;
    task?: AutotaskTask | null;
    matches?: Array<{ id: number; taskNumber?: string; title?: string }>;
  }> {
    const ref = (taskNumber ?? '').trim();
    if (!ref) return { status: 'not-found', taskNumber: ref };
    const http = await this.ensureClient();
    const rows = await http.query<AutotaskTask>(
      'Tasks',
      [{ op: 'eq', field: 'taskNumber', value: ref }],
      { maxRecords: 5, includeFields: ['id', 'taskNumber', 'title'] }
    );
    const hits = (rows || []).filter((t) => t.id != null);
    if (hits.length === 0) return { status: 'not-found', taskNumber: ref };
    if (hits.length > 1) {
      return {
        status: 'ambiguous',
        taskNumber: ref,
        matches: hits.map((t) => ({
          id: t.id as number,
          ...(t.taskNumber !== undefined ? { taskNumber: t.taskNumber } : {}),
          ...(t.title !== undefined ? { title: t.title } : {}),
        })),
      };
    }
    const task = await this.getTask(hits[0].id as number);
    return { status: 'found', taskNumber: ref, task };
  }

  async searchTasks(options: AutotaskQueryOptions = {}): Promise<PagedResult<AutotaskTask>> {
    try {
      this.logger.debug('Searching tasks with options:', options);
      // Schema-shaped filter args were previously dropped — issues #104, #105.
      const filters: QueryFilter[] = [];
      const o = options as any;

      pushEq(filters, 'projectID', o.projectID);
      pushEq(filters, 'status', o.status);
      pushEq(filters, 'assignedResourceID', o.assignedResourceID);
      if (o.searchTerm) {
        filters.push({ op: 'contains', field: 'title', value: o.searchTerm });
      }
      mergeFilterEscapeHatch(filters, options.filter);

      const paged = await this.queryPaged<AutotaskTask>('Tasks', filters, options, { maxPageSize: 100 });
      return { ...paged, items: paged.items.map(t => this.optimizeTaskData(t)) };
    } catch (error) {
      this.logger.error('Failed to search tasks:', error);
      throw error;
    }
  }

  private optimizeTaskData(task: AutotaskTask): AutotaskTask {
    const maxDescriptionLength = 400;
    const optimizedDescription = task.description
      ? (task.description.length > maxDescriptionLength
          ? task.description.substring(0, maxDescriptionLength) + '... [truncated]'
          : task.description)
      : '';
    return { ...task, description: optimizedDescription, userDefinedFields: [] };
  }

  /**
   * Resolve a canonical `T…` display reference (e.g. "T20260825.0006") to a
   * single Ticket or Task (brief §7.30). Both entity types share the same
   * reference form, so we query BOTH by their exact display number and only
   * report a match when exactly one record is found — the prefix is never used
   * to guess the type. Read-only; ambiguity and misses are returned as
   * structured results, not thrown.
   */
  async resolveRecordReference(reference: string): Promise<RecordReferenceResult> {
    const ref = (reference ?? '').trim();
    if (!ref) return { status: 'not-found', reference: ref };

    const http = await this.ensureClient();
    // Direct queries (no status filter) so completed tickets/tasks still
    // resolve. Small cap: a display number should be unique per entity, and >1
    // hit in either set is itself an ambiguity signal worth surfacing.
    const [tickets, tasks] = await Promise.all([
      http.query<AutotaskTicket>(
        'Tickets',
        [{ op: 'eq', field: 'ticketNumber', value: ref }],
        { maxRecords: 5, includeFields: ['id', 'ticketNumber', 'title'] }
      ),
      http.query<AutotaskTask>(
        'Tasks',
        [{ op: 'eq', field: 'taskNumber', value: ref }],
        { maxRecords: 5, includeFields: ['id', 'taskNumber', 'title'] }
      ),
    ]);

    const candidates: ReferenceCandidate[] = [];
    for (const t of tickets) {
      if (t.id == null) continue;
      candidates.push({
        entityType: 'ticket',
        id: t.id,
        reference: typeof t.ticketNumber === 'string' ? t.ticketNumber : ref,
        ...(t.title !== undefined ? { title: t.title } : {}),
      });
    }
    for (const t of tasks) {
      if (t.id == null) continue;
      candidates.push({
        entityType: 'task',
        id: t.id,
        reference: typeof t.taskNumber === 'string' ? t.taskNumber : ref,
        ...(t.title !== undefined ? { title: t.title } : {}),
      });
    }

    return classifyReferenceMatches(ref, candidates);
  }

  async createTask(task: Partial<AutotaskTask>): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating task:', task);
      if (!task.projectID) {
        throw new Error('projectID is required to create a task');
      }
      // Tasks are created via POST /Projects/{projectID}/Tasks
      const id = await http.childCreate('Projects', task.projectID, 'Tasks', task);
      this.logger.info(`Task created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create task:', error);
      throw error;
    }
  }

  async updateTask(id: number, updates: Partial<AutotaskTask>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating task ${id}:`, updates);
      if (!updates.projectID) {
        throw new Error('projectID is required to update a task');
      }
      // Update via PATCH on the collection endpoint: /Projects/{projectID}/Tasks
      // with the task ID in the body.
      await http.childUpdate('Projects', updates.projectID, 'Tasks', id, updates as Record<string, any>);
      this.logger.info(`Task ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update task ${id}:`, error);
      throw error;
    }
  }

  /** Resolve a Tasks status picklist value by its label (§4.4 — no hard-coded IDs). Cached. */
  private taskStatusByLabel?: Record<string, number>;
  private async resolveTaskStatusId(label: string): Promise<number | undefined> {
    if (!this.taskStatusByLabel) {
      const fi = await this.getFieldInfo('Tasks').catch(() => [] as any[]);
      const status = (fi as any[]).find((f) => f.name === 'status');
      const map: Record<string, number> = {};
      for (const pv of status?.picklistValues ?? []) map[String(pv.label).toLowerCase()] = Number(pv.value);
      this.taskStatusByLabel = map;
    }
    return this.taskStatusByLabel[label.toLowerCase()];
  }

  /**
   * Mark a task complete — sets the tenant's "Complete" status (resolved from
   * metadata, not hard-coded) and completedDateTime. projectID is looked up from
   * the task when not supplied (task update is a child-route PATCH).
   */
  async completeTask(id: number, opts: { projectID?: number; statusId?: number; completedDateTime?: string } = {}): Promise<void> {
    let projectID = opts.projectID;
    if (projectID === undefined) {
      const task = await this.getTask(id);
      projectID = (task as any)?.projectID;
      if (projectID === undefined) throw new Error(`Cannot complete task ${id}: projectID unknown (task not found?).`);
    }
    const statusId = opts.statusId ?? (await this.resolveTaskStatusId('Complete'));
    if (statusId === undefined) throw new Error('Could not resolve the "Complete" task status from tenant metadata; pass statusId explicitly.');
    await this.updateTask(id, { projectID, status: statusId, completedDateTime: opts.completedDateTime ?? new Date().toISOString() } as any);
  }

  /**
   * Read-only verification of the time entries logged on a task for a day
   * (report gap #6). When expectedResourceIDs is given, reports which are
   * missing and which have more than one entry (duplicate). Used as the gate
   * before closing a meeting task.
   */
  async verifyTaskTimeEntries(
    taskID: number,
    dateWorked: string,
    expectedResourceIDs?: number[]
  ): Promise<{
    taskID: number;
    dateWorked: string;
    expected: number;
    found: number;
    missingResourceIDs: number[];
    duplicateResourceIDs: number[];
    entries: Array<Record<string, any>>;
  }> {
    const http = await this.ensureClient();
    const rows = await http.query<Record<string, any>>(
      'TimeEntries',
      [{ op: 'eq', field: 'taskID', value: taskID }, { op: 'eq', field: 'dateWorked', value: dateWorked }],
      { maxRecords: 500, includeFields: ['id', 'resourceID', 'hoursWorked', 'summaryNotes'] }
    );
    const counts = new Map<number, number>();
    for (const r of rows) {
      if (r.resourceID != null) counts.set(r.resourceID, (counts.get(r.resourceID) ?? 0) + 1);
    }
    const expected = expectedResourceIDs ?? [];
    const missingResourceIDs = expected.filter((id) => !counts.has(id));
    const duplicateResourceIDs = [...counts.entries()]
      .filter(([id, c]) => c > 1 && (expected.length === 0 || expected.includes(id)))
      .map(([id]) => id);
    return {
      taskID,
      dateWorked,
      expected: expected.length,
      found: expected.length ? expected.filter((id) => counts.has(id)).length : counts.size,
      missingResourceIDs,
      duplicateResourceIDs,
      entries: rows,
    };
  }

  /**
   * Meeting-task closeout orchestrator (report gap #7). Finalizes a meeting
   * task only after the caller-supplied downstream work is verified — it does
   * NOT create downstream tickets itself. Dry-run first: reports what it would
   * do and every blocker without changing anything; re-run with dryRun:false
   * to act. Refuses to close (status 'blocked') if:
   *   - requireTimeEntries and any expected resource has no entry that day
   *   - a duplicate time entry is detected for an expected resource
   *   - requireCloseoutNote and no closeoutNote was supplied
   *   - any relatedTicketIDs cannot be found
   * An already-complete task is recognized safely (status 'already_complete',
   * no-op) so a re-run is safe.
   */
  async closeMeetingTask(params: {
    taskID: number;
    projectID?: number;
    dateWorked?: string;
    expectedResourceIDs?: number[];
    requireTimeEntries?: boolean;
    relatedTicketIDs?: number[];
    closeoutNote?: string;
    closeoutNoteTitle?: string;
    closeoutNoteType?: number;
    closeoutNotePublish?: number;
    requireCloseoutNote?: boolean;
    dryRun?: boolean;
  }): Promise<{
    status: 'dry_run' | 'closed' | 'blocked' | 'already_complete' | 'error';
    taskID: number;
    wouldClose?: boolean;
    blockers: string[];
    verification?: Awaited<ReturnType<AutotaskService['verifyTaskTimeEntries']>>;
    missingRelatedTicketIDs?: number[];
    noteId?: number;
    task?: AutotaskTask | null;
    error?: string;
  }> {
    const { taskID, dryRun = true } = params;
    const blockers: string[] = [];

    const task = await this.getTask(taskID);
    if (!task) return { status: 'error', taskID, blockers: ['task not found'], error: `Task ${taskID} not found` };
    if ((task as any).completedDateTime != null) {
      return { status: 'already_complete', taskID, blockers: [], task };
    }

    // Time-entry verification
    let verification: Awaited<ReturnType<AutotaskService['verifyTaskTimeEntries']>> | undefined;
    if (params.dateWorked && params.expectedResourceIDs?.length) {
      verification = await this.verifyTaskTimeEntries(taskID, params.dateWorked, params.expectedResourceIDs);
      if (params.requireTimeEntries && verification.missingResourceIDs.length) {
        blockers.push(`missing time entries for resource(s): ${verification.missingResourceIDs.join(', ')}`);
      }
      if (verification.duplicateResourceIDs.length) {
        blockers.push(`duplicate time entries for resource(s): ${verification.duplicateResourceIDs.join(', ')}`);
      }
    } else if (params.requireTimeEntries) {
      blockers.push('requireTimeEntries is set but dateWorked/expectedResourceIDs were not provided');
    }

    // Closeout note requirement
    if (params.requireCloseoutNote && !params.closeoutNote) {
      blockers.push('requireCloseoutNote is set but no closeoutNote was supplied');
    }

    // Related-ticket existence
    let missingRelatedTicketIDs: number[] | undefined;
    if (params.relatedTicketIDs?.length) {
      const http = await this.ensureClient();
      const found = await http.query<Record<string, any>>(
        'Tickets',
        [{ op: 'in', field: 'id', value: params.relatedTicketIDs }],
        { maxRecords: 500, includeFields: ['id'] }
      );
      const foundIds = new Set(found.map((t) => t.id));
      missingRelatedTicketIDs = params.relatedTicketIDs.filter((id) => !foundIds.has(id));
      if (missingRelatedTicketIDs.length) blockers.push(`related tickets not found: ${missingRelatedTicketIDs.join(', ')}`);
    }

    if (dryRun) {
      return {
        status: 'dry_run',
        taskID,
        wouldClose: blockers.length === 0,
        blockers,
        ...(verification ? { verification } : {}),
        ...(missingRelatedTicketIDs ? { missingRelatedTicketIDs } : {}),
        task,
      };
    }
    if (blockers.length) {
      return {
        status: 'blocked',
        taskID,
        blockers,
        ...(verification ? { verification } : {}),
        ...(missingRelatedTicketIDs ? { missingRelatedTicketIDs } : {}),
        task,
      };
    }

    // Act: closeout note (idempotent via marker) then complete.
    let noteId: number | undefined;
    if (params.closeoutNote) {
      const marker = `[MCP-ID:CLOSEOUT:${taskID}]`;
      const existingNotes = await this.searchTaskNotes(taskID, { pageSize: 100 });
      const prior = (existingNotes || []).find(
        (n) => typeof n.description === 'string' && n.description.includes(marker)
      );
      if (prior?.id != null) {
        noteId = prior.id;
      } else {
        const noteBody: Record<string, any> = {
          title: params.closeoutNoteTitle ?? 'Meeting Closeout',
          description: `${params.closeoutNote}\n\n${marker}`,
        };
        if (params.closeoutNoteType != null) noteBody.noteType = params.closeoutNoteType;
        if (params.closeoutNotePublish != null) noteBody.publish = params.closeoutNotePublish;
        noteId = await this.createTaskNote(taskID, noteBody);
      }
    }

    await this.completeTask(taskID, params.projectID != null ? { projectID: params.projectID } : {});
    const readBack = await this.getTask(taskID);
    return {
      status: 'closed',
      taskID,
      blockers: [],
      ...(verification ? { verification } : {}),
      ...(noteId != null ? { noteId } : {}),
      task: readBack,
    };
  }

  // Task secondary resources (§5.4) — the primary resource is the task's
  // assignedResourceID; additional crew are TaskSecondaryResources rows.
  async listTaskResources(taskID: number): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    return http.query('TaskSecondaryResources', [{ op: 'eq', field: 'taskID', value: taskID }], {
      includeFields: ['id', 'taskID', 'resourceID', 'roleID'],
      maxRecords: 500,
    });
  }
  async addTaskResource(taskID: number, resourceID: number, roleID?: number): Promise<number> {
    const http = await this.ensureClient();
    const body: Record<string, any> = { taskID, resourceID };
    if (roleID !== undefined) body.roleID = roleID;
    return http.create('TaskSecondaryResources', body);
  }
  async removeTaskResource(id: number): Promise<void> {
    const http = await this.ensureClient();
    await http.delete('TaskSecondaryResources', id);
  }

  // Task predecessors / dependencies (§5.5) — a TaskPredecessors row links a
  // predecessor task to a successor task with an optional lag.
  async listTaskPredecessors(taskID: number): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    return http.query('TaskPredecessors', [{ op: 'eq', field: 'successorTaskID', value: taskID }], {
      includeFields: ['id', 'predecessorTaskID', 'successorTaskID', 'lagDays'],
      maxRecords: 500,
    });
  }
  async addTaskPredecessor(successorTaskID: number, predecessorTaskID: number, lagDays?: number): Promise<number> {
    const http = await this.ensureClient();
    const body: Record<string, any> = { successorTaskID, predecessorTaskID };
    if (lagDays !== undefined) body.lagDays = lagDays;
    return http.create('TaskPredecessors', body);
  }
  async removeTaskPredecessor(id: number): Promise<void> {
    const http = await this.ensureClient();
    await http.delete('TaskPredecessors', id);
  }

  /** Get one TaskPredecessors row by id, or null if it doesn't exist. */
  async getTaskPredecessor(id: number): Promise<Record<string, any> | null> {
    const http = await this.ensureClient();
    return http.get<Record<string, any>>('TaskPredecessors', id);
  }

  /**
   * Search TaskPredecessors by either endpoint of the dependency. Filtering by
   * `successorTaskID` lists what a task waits on; by `predecessorTaskID`, what
   * waits on it. Both may be combined. With neither, returns nothing rather than
   * scanning the whole tenant (a project-wide graph is built from the task set,
   * not an unfiltered dump).
   */
  async searchTaskPredecessors(
    options: { successorTaskID?: number; predecessorTaskID?: number; pageSize?: number } = {}
  ): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [];
    pushEq(filters, 'successorTaskID', options.successorTaskID);
    pushEq(filters, 'predecessorTaskID', options.predecessorTaskID);
    if (filters.length === 0) return [];
    return http.query('TaskPredecessors', filters, {
      includeFields: ['id', 'predecessorTaskID', 'successorTaskID', 'lagDays'],
      maxRecords: options.pageSize || 500,
    });
  }

  /**
   * Update a TaskPredecessors row. Only `lagDays` is writable — Autotask marks
   * predecessorTaskID and successorTaskID readonly (verified against live entity
   * metadata), so re-pointing a dependency requires delete + recreate, not update.
   */
  async updateTaskPredecessor(id: number, lagDays: number): Promise<void> {
    const http = await this.ensureClient();
    await http.update('TaskPredecessors', id, { lagDays });
  }

  // =====================================================
  // Phases
  // =====================================================

  async createPhase(phase: Partial<AutotaskPhase>): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating phase:', phase);
      if (!phase.projectID) {
        throw new Error('projectID is required to create a phase');
      }
      const id = await http.childCreate('Projects', phase.projectID, 'Phases', phase);
      this.logger.info(`Phase created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create phase:', error);
      throw error;
    }
  }

  async getPhase(id: number): Promise<AutotaskPhase | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting phase ${id}`);
      return await http.get<AutotaskPhase>('Phases', id);
    } catch (error) {
      this.logger.error(`Failed to get phase ${id}:`, error);
      throw error;
    }
  }

  async updatePhase(id: number, updates: Partial<AutotaskPhase>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating phase ${id}:`, updates);
      await http.update('Phases', id, updates as Record<string, any>);
      this.logger.info(`Phase ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update phase ${id}:`, error);
      throw error;
    }
  }

  async searchPhases(projectID: number, options: AutotaskQueryOptions = {}): Promise<PagedResult<AutotaskPhase>> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Searching phases for project ${projectID}:`, options);
      // childQuery does not walk nextPageUrl, so paging here is bounded by the
      // single 500-record page Autotask returns. Ample for phases on a project;
      // a project that ever exceeded it would need the cursor walk.
      return await this.paginate<AutotaskPhase>(
        `phases for project ${projectID}`,
        (limit) => http.childQuery<AutotaskPhase>('Projects', projectID, 'Phases', MATCH_ALL, { maxRecords: limit }),
        options,
        { maxPageSize: 100 }
      );
    } catch (error) {
      this.logger.error(`Failed to search phases for project ${projectID}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Utility
  // =====================================================

  async testConnection(): Promise<boolean> {
    try {
      const http = await this.ensureClient();
      // Cheap probe: query Companies with a trivial filter.
      await http.query<AutotaskCompany>('Companies', MATCH_ALL, { maxRecords: 1 });
      this.logger.info('Connection test successful');
      return true;
    } catch (error) {
      this.logger.error('Connection test failed:', error);
      return false;
    }
  }

  // =====================================================
  // Notes (child of Tickets / Projects / Companies)
  // =====================================================

  /**
   * Parent entity mapping for note operations.
   */
  private noteParent(parentField: string): { parent: string; bodyField: string } {
    const map: Record<string, { parent: string; bodyField: string }> = {
      ticketId:  { parent: 'Tickets',   bodyField: 'ticketID' },
      projectId: { parent: 'Projects',  bodyField: 'projectID' },
      accountId: { parent: 'Companies', bodyField: 'companyID' },
      taskId:    { parent: 'Tasks',     bodyField: 'taskID' },
    };
    const m = map[parentField];
    if (!m) throw new Error(`Unknown parent field for note operation: ${parentField}`);
    return m;
  }

  private async getNoteImpl(parentField: string, parentId: number, noteId: number): Promise<any> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting note - ${parentField}: ${parentId}, noteID: ${noteId}`);
      const { parent } = this.noteParent(parentField);
      return await http.childGet<any>(parent, parentId, 'Notes', noteId);
    } catch (error) {
      this.logger.error(`Failed to get note ${noteId} for ${parentField}=${parentId}:`, error);
      throw error;
    }
  }

  private async searchNotesImpl(
    parentField: string,
    parentId: number,
    options: AutotaskQueryOptionsExtended = {}
  ): Promise<any[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Searching notes for ${parentField}=${parentId}:`, options);
      const { parent } = this.noteParent(parentField);
      const notes = await http.childQuery<any>(
        parent,
        parentId,
        'Notes',
        MATCH_ALL,
        { maxRecords: options.pageSize || 25 }
      );
      this.logger.info(`Retrieved ${notes.length} notes for ${parentField}=${parentId}`);
      return notes;
    } catch (error) {
      this.logger.error(`Failed to search notes for ${parentField}=${parentId}:`, error);
      throw error;
    }
  }

  private async createNoteImpl(
    parentField: string,
    parentId: number,
    note: Record<string, any>
  ): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Creating note for ${parentField}=${parentId}:`, note);
      const { parent, bodyField } = this.noteParent(parentField);
      const noteData = { ...note, [bodyField]: parentId };
      const id = await http.childCreate(parent, parentId, 'Notes', noteData);
      this.logger.info(`Note created with ID: ${id} for ${parentField}=${parentId}`);
      return id;
    } catch (error) {
      this.logger.error(`Failed to create note for ${parentField}=${parentId}:`, error);
      throw error;
    }
  }

  async getTicketNote(ticketId: number, noteId: number): Promise<AutotaskTicketNote | null> {
    return this.getNoteImpl('ticketId', ticketId, noteId);
  }
  async searchTicketNotes(ticketId: number, opts?: AutotaskQueryOptionsExtended): Promise<AutotaskTicketNote[]> {
    return this.searchNotesImpl('ticketId', ticketId, opts);
  }
  async createTicketNote(ticketId: number, note: Partial<AutotaskTicketNote>): Promise<number> {
    return this.createNoteImpl('ticketId', ticketId, note as Record<string, any>);
  }

  /**
   * Create a ticket note idempotently so a re-run of a workflow (e.g. meeting
   * closeout touch-points) does not duplicate notes. A deterministic marker
   * `[MCP-ID:<key>]` is appended to the note body; before creating, existing
   * notes on the ticket are scanned for that marker and the prior note is
   * returned instead. TicketNotes have no native externalID, hence the marker.
   * Keep the note internal (publish) if the key should not be client-visible.
   * A blank key falls through to a plain create (no dedup).
   */
  async createTicketNoteIdempotent(
    ticketId: number,
    note: Partial<AutotaskTicketNote>,
    idempotencyKey: string
  ): Promise<{ created: boolean; noteId: number; idempotencyKey?: string }> {
    const key = (idempotencyKey ?? '').trim();
    if (!key) {
      const id = await this.createTicketNote(ticketId, note);
      return { created: true, noteId: id };
    }
    const marker = `[MCP-ID:${key}]`;
    const existing = await this.searchTicketNotes(ticketId, { pageSize: 100 });
    const hit = (existing || []).find(
      (n) => typeof n.description === 'string' && n.description.includes(marker)
    );
    if (hit && hit.id != null) {
      return { created: false, noteId: hit.id, idempotencyKey: key };
    }
    const description = `${note.description ?? ''}\n\n${marker}`.trim();
    const id = await this.createTicketNote(ticketId, { ...note, description });
    return { created: true, noteId: id, idempotencyKey: key };
  }

  async getProjectNote(projectId: number, noteId: number): Promise<AutotaskProjectNote | null> {
    return this.getNoteImpl('projectId', projectId, noteId);
  }
  async searchProjectNotes(projectId: number, opts?: AutotaskQueryOptionsExtended): Promise<AutotaskProjectNote[]> {
    return this.searchNotesImpl('projectId', projectId, opts);
  }
  async createProjectNote(projectId: number, note: Partial<AutotaskProjectNote>): Promise<number> {
    return this.createNoteImpl('projectId', projectId, note as Record<string, any>);
  }

  async getCompanyNote(companyId: number, noteId: number): Promise<AutotaskCompanyNote | null> {
    return this.getNoteImpl('accountId', companyId, noteId);
  }
  async searchCompanyNotes(companyId: number, opts?: AutotaskQueryOptionsExtended): Promise<AutotaskCompanyNote[]> {
    return this.searchNotesImpl('accountId', companyId, opts);
  }
  async createCompanyNote(companyId: number, note: Partial<AutotaskCompanyNote>): Promise<number> {
    return this.createNoteImpl('accountId', companyId, note as Record<string, any>);
  }

  /** List attachment metadata on a project (§5.7 read). Binary upload/download is a follow-up. */
  async searchProjectAttachments(projectId: number, options: AutotaskQueryOptionsExtended = {}): Promise<any[]> {
    const http = await this.ensureClient();
    return http.childQuery<any>('Projects', projectId, 'Attachments', MATCH_ALL, { maxRecords: options.pageSize || 25 });
  }
  /** List attachment metadata on a project task (§5.7 read). */
  async searchTaskAttachments(taskId: number, options: AutotaskQueryOptionsExtended = {}): Promise<any[]> {
    const http = await this.ensureClient();
    return http.childQuery<any>('Tasks', taskId, 'Attachments', MATCH_ALL, { maxRecords: options.pageSize || 25 });
  }

  async getTaskNote(taskId: number, noteId: number): Promise<any> {
    return this.getNoteImpl('taskId', taskId, noteId);
  }
  async searchTaskNotes(taskId: number, opts?: AutotaskQueryOptionsExtended): Promise<any[]> {
    return this.searchNotesImpl('taskId', taskId, opts);
  }
  async createTaskNote(taskId: number, note: Record<string, any>): Promise<number> {
    return this.createNoteImpl('taskId', taskId, note);
  }

  // =====================================================
  // Ticket Checklist Items (child of Tickets)
  // =====================================================

  async searchTicketChecklistItems(ticketId: number): Promise<AutotaskTicketChecklistItem[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Listing checklist items for ticket ${ticketId}`);
      const items = await http.childQuery<AutotaskTicketChecklistItem>(
        'Tickets',
        ticketId,
        'ChecklistItems',
        MATCH_ALL,
        { maxRecords: 500 }
      );
      this.logger.info(`Retrieved ${items.length} checklist items for ticket ${ticketId}`);
      return items;
    } catch (error) {
      this.logger.error(`Failed to list checklist items for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async createTicketChecklistItem(
    ticketId: number,
    data: Partial<AutotaskTicketChecklistItem>
  ): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Creating checklist item on ticket ${ticketId}:`, data);
      const body = { ...data, ticketID: ticketId };
      const id = await http.childCreate('Tickets', ticketId, 'ChecklistItems', body);
      this.logger.info(`Checklist item created with ID ${id} on ticket ${ticketId}`);
      return id;
    } catch (error) {
      this.logger.error(`Failed to create checklist item on ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async updateTicketChecklistItem(
    ticketId: number,
    itemId: number,
    data: Partial<AutotaskTicketChecklistItem>
  ): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating checklist item ${itemId} on ticket ${ticketId}:`, data);
      const body = { ...data, ticketID: ticketId } as Record<string, any>;
      await http.childUpdate('Tickets', ticketId, 'ChecklistItems', itemId, body);
      this.logger.info(`Checklist item ${itemId} updated on ticket ${ticketId}`);
    } catch (error) {
      this.logger.error(`Failed to update checklist item ${itemId} on ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async deleteTicketChecklistItem(ticketId: number, itemId: number): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Deleting checklist item ${itemId} from ticket ${ticketId}`);
      await http.childDelete('Tickets', ticketId, 'ChecklistItems', itemId);
      this.logger.info(`Checklist item ${itemId} deleted from ticket ${ticketId}`);
    } catch (error) {
      this.logger.error(`Failed to delete checklist item ${itemId} from ticket ${ticketId}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Checklist Libraries (§10) — reusable checklists (ChecklistLibraries, live
  // schema {id, name, description, isActive, entityType}) whose items live in
  // ChecklistLibraryChecklistItems ({id, checklistLibraryID, itemName,
  // isImportant, knowledgebaseArticleID, position}). Autotask has no native
  // "apply library" endpoint, so applying expands the library's items into
  // per-ticket TicketChecklistItems.
  // =====================================================

  /** Search checklist libraries; optional isActive/entityType/searchTerm. */
  async searchChecklistLibraries(
    options: { isActive?: boolean; entityType?: number; searchTerm?: string; pageSize?: number } = {}
  ): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [];
    pushEq(filters, 'isActive', options.isActive);
    pushEq(filters, 'entityType', options.entityType);
    if (options.searchTerm) filters.push({ op: 'contains', field: 'name', value: options.searchTerm });
    const pageSize = Math.min(options.pageSize || 100, 500);
    return http.query<Record<string, any>>(
      'ChecklistLibraries',
      filters.length > 0 ? filters : MATCH_ALL,
      { maxRecords: pageSize }
    );
  }

  /** The items belonging to a checklist library, ordered by position. */
  async getChecklistLibraryItems(checklistLibraryID: number): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const items = await http.query<Record<string, any>>(
      'ChecklistLibraryChecklistItems',
      [{ op: 'eq', field: 'checklistLibraryID', value: checklistLibraryID }],
      { maxRecords: 500 }
    );
    return items.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  /** Get a checklist library plus its items (§10). Returns null if not found. */
  async getChecklistLibrary(id: number): Promise<Record<string, any> | null> {
    const http = await this.ensureClient();
    const library = await http.get<Record<string, any>>('ChecklistLibraries', id);
    if (!library) return null;
    const items = await this.getChecklistLibraryItems(id);
    return { ...library, items };
  }

  /**
   * Apply a checklist library to a ticket (§10): expand the library's items into
   * TicketChecklistItems on the ticket (itemName / isImportant / position /
   * knowledgebaseArticleID carried over). Each item is created independently; a
   * failed item is reported rather than aborting the rest. Returns the created
   * item ids and any per-item errors.
   */
  async applyChecklistLibraryToTicket(
    ticketID: number,
    checklistLibraryID: number
  ): Promise<{ ticketID: number; checklistLibraryID: number; created: number[]; itemErrors: Array<{ itemName: string; error: string }> }> {
    const items = await this.getChecklistLibraryItems(checklistLibraryID);
    const created: number[] = [];
    const itemErrors: Array<{ itemName: string; error: string }> = [];
    for (const item of items) {
      const data: Partial<AutotaskTicketChecklistItem> = { itemName: item.itemName };
      if (item.isImportant !== undefined) (data as any).isImportant = item.isImportant;
      if (item.position !== undefined) (data as any).position = item.position;
      if (item.knowledgebaseArticleID != null) (data as any).knowledgebaseArticleID = item.knowledgebaseArticleID;
      try {
        created.push(await this.createTicketChecklistItem(ticketID, data));
      } catch (error) {
        itemErrors.push({ itemName: String(item.itemName), error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.logger.info(`Applied checklist library ${checklistLibraryID} to ticket ${ticketID}: ${created.length} item(s), ${itemErrors.length} failed`);
    return { ticketID, checklistLibraryID, created, itemErrors };
  }

  // =====================================================
  // Entitlement + coverage helpers, and the maintenance-ticket orchestrator
  // (§13/§14/§15). The MCP owns HOW to read state / verify entitlement / create
  // safe objects; the automation layer owns WHEN/WHICH/WHETHER (§20).
  // =====================================================

  /** Normalized entitlement reasons (§14). EXCLUDED_BY_POLICY is reserved for the
   * automation layer (policy is not owned by the MCP) and is never emitted here. */
  static readonly ENTITLEMENT_REASONS = [
    'ACTIVE_CI_ACTIVE_CONTRACT_SERVICE',
    'ACTIVE_CI_NO_CONTRACT',
    'CONTRACT_EXPIRED',
    'CONTRACT_TERMINATED',
    'CONTRACT_SERVICE_MISMATCH',
    'SERVICE_NOT_MAPPED',
    'CI_INACTIVE',
    'EXCLUDED_BY_POLICY',
  ] as const;

  /** Map a Contracts.status picklist value to its label (tenant-specific). */
  private async contractStatusLabel(statusValue: unknown): Promise<string | undefined> {
    if (statusValue == null) return undefined;
    try {
      const fields = await this.getFieldInfo('Contracts');
      const status = fields.find((f) => f.name === 'status');
      const pv = (status?.picklistValues ?? []).find((v) => String(v.value) === String(statusValue));
      return pv?.label;
    } catch {
      return undefined;
    }
  }

  /**
   * Determine whether a configuration item is entitled to recurring service and
   * why (§14). Deterministic and evidence-backed: reads the CI, its contract,
   * and its contract-service line, then classifies. Contract "active" is decided
   * by the status LABEL (tenant picklists differ — this tenant uses
   * 0=Inactive/1=Active, others use In Effect/Terminated) plus the endDate, not a
   * hardcoded numeric. Entitled ⇔ reason === ACTIVE_CI_ACTIVE_CONTRACT_SERVICE.
   */
  async getConfigurationItemEntitlement(configurationItemId: number): Promise<{
    configurationItemId: number;
    found: boolean;
    isEntitled: boolean;
    reason: string | null;
    evidence: Record<string, any>;
  }> {
    const ci = await this.getConfigurationItem(configurationItemId);
    if (!ci) {
      return { configurationItemId, found: false, isEntitled: false, reason: null, evidence: {} };
    }
    const evidence: Record<string, any> = {
      isActive: ci.isActive,
      contractID: ci.contractID ?? null,
      contractServiceID: ci.contractServiceID ?? null,
      serviceID: ci.serviceID ?? null,
    };
    const done = (reason: string) => ({ configurationItemId, found: true, isEntitled: reason === 'ACTIVE_CI_ACTIVE_CONTRACT_SERVICE', reason, evidence });

    if (ci.isActive === false) return done('CI_INACTIVE');
    if (ci.contractID == null && ci.contractServiceID == null) return done('ACTIVE_CI_NO_CONTRACT');

    // Resolve the contract and classify its state.
    const contract = ci.contractID != null ? await this.getContract(ci.contractID) as Record<string, any> | null : null;
    if (ci.contractID != null && !contract) {
      evidence.contractFound = false;
      return done('CONTRACT_TERMINATED'); // referenced contract no longer readable
    }
    if (contract) {
      const label = await this.contractStatusLabel(contract.status);
      const endDate = contract.endDate ? new Date(contract.endDate) : null;
      const expired = endDate != null && !Number.isNaN(endDate.getTime()) && endDate.getTime() < Date.now();
      const active = label != null && /\bactive\b|\bin effect\b/i.test(label);
      evidence.contractStatus = contract.status;
      evidence.contractStatusLabel = label ?? null;
      evidence.contractEndDate = contract.endDate ?? null;
      evidence.contractExpired = expired;
      if (label != null && /terminat/i.test(label)) return done('CONTRACT_TERMINATED');
      if (expired) return done('CONTRACT_EXPIRED');
      if (!active) return done('CONTRACT_TERMINATED'); // inactive/on-hold/etc — not generating work
    }

    // Contract is active — validate the contract-service linkage.
    if (ci.contractServiceID == null) return done('SERVICE_NOT_MAPPED');
    const cs = await this.getContractService(ci.contractServiceID);
    if (!cs) { evidence.contractServiceFound = false; return done('CONTRACT_SERVICE_MISMATCH'); }
    evidence.contractServiceContractID = cs.contractID;
    evidence.contractServiceServiceID = cs.serviceID;
    if (ci.contractID != null && cs.contractID !== ci.contractID) return done('CONTRACT_SERVICE_MISMATCH');
    if (ci.serviceID != null && cs.serviceID != null && cs.serviceID !== ci.serviceID) return done('CONTRACT_SERVICE_MISMATCH');
    return done('ACTIVE_CI_ACTIVE_CONTRACT_SERVICE');
  }

  /**
   * Active configuration items with no contract coverage — for Sales / Account
   * review (§15). NOTE: Autotask's `eq null` / `noteExist` filters on CI foreign
   * keys (contractID/contractServiceID) return zero rows even when null-valued
   * records exist (verified live), so coverage is computed in-memory: query
   * active CIs and keep those with neither a contract nor a contract-service link.
   */
  async searchConfigurationItemCoverageGaps(
    options: { companyID?: number; pageSize?: number } = {}
  ): Promise<Array<Record<string, any>>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [{ op: 'eq', field: 'isActive', value: true }];
    pushEq(filters, 'companyID', options.companyID);
    const cap = Math.min(options.pageSize || 500, 500);
    const active = await http.query<Record<string, any>>('ConfigurationItems', filters, { maxRecords: cap });
    return active.filter((ci) => ci.contractID == null && ci.contractServiceID == null);
  }

  /**
   * Maintenance-ticket orchestrator (§13). Validates company → contract →
   * contract service → CI ownership/activity, checks the externalID for an
   * existing occurrence (idempotency), then (unless dryRun) creates the ticket,
   * links additional CIs, applies a checklist library, and reads everything back.
   * The MCP does not own recurrence scheduling — the caller decides WHEN/WHICH.
   */
  async createMaintenanceTicket(params: {
    companyID: number;
    title: string;
    description: string;
    configurationItemID?: number;
    additionalConfigurationItemIDs?: number[];
    contractID?: number;
    contractServiceID?: number;
    companyLocationID?: number;
    externalID?: string;
    checklistLibraryID?: number;
    ticketFields?: Record<string, any>;
    dryRun?: boolean;
    allowDuplicate?: boolean;
    requireEntitlement?: boolean;
  }): Promise<Record<string, any>> {
    // Standard safe-orchestration envelope (MCP-CORE-004): every early return
    // below is a no-write outcome carrying the audit trail of what was checked.
    const plan = new WritePlan();
    const fail = (step: string, detail: any) => plan.fail(step, detail);

    // 1. Company
    const company = await this.getCompany(params.companyID).catch(() => null);
    if (!company) return fail('company', `Company ${params.companyID} not found`);
    plan.ok('company');

    // 2. Contract (if supplied)
    if (params.contractID != null) {
      const contract = await this.getContract(params.contractID) as Record<string, any> | null;
      if (!contract) return fail('contract', `Contract ${params.contractID} not found`);
      const label = await this.contractStatusLabel(contract.status);
      const endDate = contract.endDate ? new Date(contract.endDate) : null;
      const expired = endDate != null && !Number.isNaN(endDate.getTime()) && endDate.getTime() < Date.now();
      const active = label != null && /\bactive\b|\bin effect\b/i.test(label);
      if (expired) return fail('contract', `Contract ${params.contractID} is expired (endDate ${contract.endDate})`);
      if (label != null && !active) return fail('contract', `Contract ${params.contractID} is not active (status "${label}")`);
      plan.ok('contract', { statusLabel: label, endDate: contract.endDate });
    }

    // 3. Contract service (if supplied)
    if (params.contractServiceID != null) {
      const cs = await this.getContractService(params.contractServiceID);
      if (!cs) return fail('contractService', `ContractService ${params.contractServiceID} not found`);
      if (params.contractID != null && cs.contractID !== params.contractID) {
        return fail('contractService', `ContractService ${params.contractServiceID} belongs to contract ${cs.contractID}, not ${params.contractID}`);
      }
      plan.ok('contractService');
    }

    // 4. Primary CI ownership + activity (if supplied)
    if (params.configurationItemID != null) {
      const ci = await this.getConfigurationItem(params.configurationItemID);
      if (!ci) return fail('configurationItem', `Configuration item ${params.configurationItemID} not found`);
      if (ci.companyID != null && ci.companyID !== params.companyID) {
        return fail('configurationItem', `CI ${params.configurationItemID} belongs to company ${ci.companyID}, not ${params.companyID}`);
      }
      if (ci.isActive === false) return fail('configurationItem', `CI ${params.configurationItemID} is inactive`);
      if (params.requireEntitlement) {
        const ent = await this.getConfigurationItemEntitlement(params.configurationItemID);
        if (!ent.isEntitled) return fail('entitlement', { reason: ent.reason, evidence: ent.evidence });
        plan.ok('entitlement', { reason: ent.reason });
      }
      plan.ok('configurationItem');
    }

    // 5. Idempotency: existing occurrence?
    let existing: AutotaskTicket[] = [];
    if (params.externalID) {
      existing = await this.findTicketByExternalId(params.externalID);
      if (existing.length > 0 && !params.allowDuplicate) {
        return plan.duplicate({ existingTickets: existing });
      }
      plan.ok('idempotency', { existing: existing.length });
    }

    const ticketPayload: Record<string, any> = {
      companyID: params.companyID,
      title: params.title,
      description: params.description,
      ...(params.configurationItemID != null && { configurationItemID: params.configurationItemID }),
      ...(params.contractID != null && { contractID: params.contractID }),
      ...(params.contractServiceID != null && { contractServiceID: params.contractServiceID }),
      ...(params.companyLocationID != null && { companyLocationID: params.companyLocationID }),
      ...(params.externalID != null && { externalID: params.externalID }),
      ...(params.ticketFields ?? {}),
    };

    // 6. Dry run stops here — return the plan without writing.
    if (params.dryRun) {
      return plan.dryRun({
        plannedTicket: ticketPayload,
        wouldLinkConfigurationItems: params.additionalConfigurationItemIDs ?? [],
        wouldApplyChecklistLibraryID: params.checklistLibraryID ?? null,
        existingTickets: existing,
      });
    }

    // 7-9. Create → link CIs → apply checklist → read back.
    const additional = (params.additionalConfigurationItemIDs ?? []).filter((n) => typeof n === 'number');
    const createResult = additional.length > 0
      ? await this.createTicketWithConfigurationItems(ticketPayload, additional)
      : { id: await this.createTicket(ticketPayload), item: null as AutotaskTicket | null, additionalConfigurationItems: [] as Array<Record<string, any>>, linkErrors: [] as Array<{ configurationItemID: number; error: string }> };

    let checklist: Awaited<ReturnType<AutotaskService['applyChecklistLibraryToTicket']>> | null = null;
    if (params.checklistLibraryID != null) {
      checklist = await this.applyChecklistLibraryToTicket(createResult.id, params.checklistLibraryID);
    }

    // 10. Read the ticket back if the convenience flow didn't already.
    let item = createResult.item;
    if (!item) { try { item = await this.getTicket(createResult.id, true); } catch { /* id authoritative */ } }

    return plan.done('created', {
      id: createResult.id,
      entityType: 'Tickets',
      item,
      additionalConfigurationItems: createResult.additionalConfigurationItems,
      linkErrors: createResult.linkErrors,
      checklist,
    });
  }

  // =====================================================
  // Ticket Attachments (child of Tickets)
  // =====================================================

  // Default cap on inline attachment data (base64-encoded length). 750 KB of
  // base64 ≈ 560 KB raw, leaving headroom for the JSON envelope under typical
  // MCP client tool-result limits (~1 MB). Callable overrides via options.
  private static readonly DEFAULT_MAX_INLINE_ATTACHMENT_BASE64 = 750_000;

  // Autotask hard limit on attachment upload size (decoded bytes). Applies to
  // ticket, project, and task attachments alike.
  private static readonly MAX_ATTACHMENT_UPLOAD_BYTES = 3 * 1024 * 1024; // 3 MB

  /**
   * Validate a base64 attachment payload shared by all attachment-create paths:
   * `title`/`data` present, `data` is real base64, non-empty, within the size
   * limit. Returns the decoded byte length. Throws with a `${method}:`-prefixed
   * message on any violation.
   */
  private validateAttachmentUploadData(method: string, data: AutotaskAttachmentCreateRequest): number {
    if (!data || typeof data.data !== 'string' || data.data.length === 0) {
      throw new Error(`${method}: \`data\` (base64-encoded file content) is required`);
    }
    if (!data.title) {
      throw new Error(`${method}: \`title\` is required`);
    }

    let decodedLength: number;
    try {
      const buf = Buffer.from(data.data, 'base64');
      if (buf.toString('base64').replace(/=+$/, '') !== data.data.replace(/\s+/g, '').replace(/=+$/, '')) {
        throw new Error('invalid base64');
      }
      decodedLength = buf.length;
    } catch {
      throw new Error(`${method}: \`data\` is not valid base64-encoded content`);
    }

    if (decodedLength === 0) {
      throw new Error(`${method}: decoded attachment is empty`);
    }
    if (decodedLength > AutotaskService.MAX_ATTACHMENT_UPLOAD_BYTES) {
      throw new Error(
        `${method}: attachment is ${decodedLength} bytes which exceeds the Autotask 3MB (${AutotaskService.MAX_ATTACHMENT_UPLOAD_BYTES} byte) limit`
      );
    }
    return decodedLength;
  }

  /**
   * Fetch an attachment for a Projects/Tasks-style parent. Metadata comes from
   * the child endpoint (never populates `data`); binary content comes from the
   * top-level entity endpoint by id, then is scope-verified against the parent
   * and stripped if too large for inline transport. Mirrors getTicketAttachment.
   */
  private async getChildAttachmentImpl<T extends { data?: string; parentID?: number; [k: string]: any }>(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    topLevelEntity: string,
    fkField: string,
    attachmentId: number,
    options: { includeData?: boolean; maxInlineBase64Bytes?: number } = {}
  ): Promise<(T & { dataOmittedReason?: string }) | null> {
    const includeData = options.includeData ?? false;
    const maxInlineBase64Bytes =
      options.maxInlineBase64Bytes ?? AutotaskService.DEFAULT_MAX_INLINE_ATTACHMENT_BASE64;

    const http = await this.ensureClient();
    this.logger.debug(
      `Getting ${parentEntity} attachment - parentId: ${parentId}, attachmentId: ${attachmentId}, includeData: ${includeData}`
    );

    if (!includeData) {
      return await http.childGet<T>(parentEntity, parentId, childEntity, attachmentId);
    }

    const attachment = await http.get<T>(topLevelEntity, attachmentId);
    if (!attachment) return null;

    // The top-level endpoint accepts any attachment ID, so enforce parent scope
    // ourselves. Prefer the entity-specific FK; fall back to the generic parentID.
    const scopeVal =
      typeof attachment[fkField] === 'number' ? attachment[fkField]
      : typeof attachment.parentID === 'number' ? attachment.parentID
      : undefined;
    if (typeof scopeVal === 'number' && scopeVal !== parentId) {
      this.logger.warn(
        `${topLevelEntity} ${attachmentId} belongs to parent ${scopeVal}, not ${parentId}. Returning null.`
      );
      return null;
    }

    if (typeof attachment.data === 'string' && attachment.data.length > maxInlineBase64Bytes) {
      const decodedBytes = Buffer.byteLength(attachment.data, 'base64');
      const reason =
        `Attachment data omitted: base64 length ${attachment.data.length} bytes ` +
        `(${decodedBytes} bytes decoded) exceeds inline limit of ${maxInlineBase64Bytes} bytes. ` +
        `Fetch directly from Autotask, or call again with a larger maxInlineBase64Bytes (caveat: ` +
        `the MCP client may reject the oversized response).`;
      this.logger.warn(
        `getChildAttachmentImpl: stripping oversized data for ${topLevelEntity} ${attachmentId} (${attachment.data.length} base64 bytes)`
      );
      const { data: _omitted, ...rest } = attachment;
      return { ...(rest as T), dataOmittedReason: reason };
    }

    return attachment;
  }

  /**
   * Create an attachment under a Projects/Tasks-style parent via the child
   * endpoint. The parent linkage is established by the URL (parentID is
   * read-only), so no parentId/parentType is sent. Mirrors createTicketAttachment.
   */
  private async createChildAttachmentImpl(
    parentEntity: string,
    parentId: number,
    childEntity: string,
    method: string,
    data: AutotaskAttachmentCreateRequest
  ): Promise<number> {
    const decodedLength = this.validateAttachmentUploadData(method, data);
    const http = await this.ensureClient();

    const payload = {
      title: data.title,
      fullPath: data.fullPath || data.title,
      data: data.data,
      attachmentType: data.attachmentType || 'FILE_ATTACHMENT',
      contentType: data.contentType,
      publish: data.publish ?? 1
    };

    this.logger.info(
      `${method}: ${parentEntity.toLowerCase()}Id=${parentId} title="${data.title}" bytes=${decodedLength}`
    );
    const id = await http.childCreate(parentEntity, parentId, childEntity, payload);
    this.logger.info(`${method}: created attachment ${id} on ${parentEntity} ${parentId}`);
    return id;
  }

  /** Get a project attachment (metadata, or binary via includeData=true). */
  async getProjectAttachment(
    projectId: number,
    attachmentId: number,
    options: { includeData?: boolean; maxInlineBase64Bytes?: number } = {}
  ): Promise<(AutotaskProjectAttachment & { dataOmittedReason?: string }) | null> {
    return this.getChildAttachmentImpl<AutotaskProjectAttachment>(
      'Projects', projectId, 'Attachments', 'ProjectAttachments', 'projectID', attachmentId, options
    );
  }

  /** Upload a base64 file attachment to a project. */
  async createProjectAttachment(projectId: number, data: AutotaskAttachmentCreateRequest): Promise<number> {
    return this.createChildAttachmentImpl('Projects', projectId, 'Attachments', 'createProjectAttachment', data);
  }

  /** Get a task attachment (metadata, or binary via includeData=true). */
  async getTaskAttachment(
    taskId: number,
    attachmentId: number,
    options: { includeData?: boolean; maxInlineBase64Bytes?: number } = {}
  ): Promise<(AutotaskTaskAttachment & { dataOmittedReason?: string }) | null> {
    return this.getChildAttachmentImpl<AutotaskTaskAttachment>(
      'Tasks', taskId, 'Attachments', 'TaskAttachments', 'taskID', attachmentId, options
    );
  }

  /** Upload a base64 file attachment to a project task. */
  async createTaskAttachment(taskId: number, data: AutotaskAttachmentCreateRequest): Promise<number> {
    return this.createChildAttachmentImpl('Tasks', taskId, 'Attachments', 'createTaskAttachment', data);
  }

  async getTicketAttachment(
    ticketId: number,
    attachmentId: number,
    options: { includeData?: boolean; maxInlineBase64Bytes?: number } = {}
  ): Promise<(AutotaskTicketAttachment & { dataOmittedReason?: string }) | null> {
    const includeData = options.includeData ?? false;
    const maxInlineBase64Bytes =
      options.maxInlineBase64Bytes ?? AutotaskService.DEFAULT_MAX_INLINE_ATTACHMENT_BASE64;

    const http = await this.ensureClient();
    try {
      this.logger.debug(
        `Getting ticket attachment - TicketID: ${ticketId}, AttachmentID: ${attachmentId}, includeData: ${includeData}`
      );

      if (!includeData) {
        // The child endpoint never populates the `data` field — using it for
        // the metadata-only path sidesteps the binary download entirely.
        return await http.childGet<AutotaskTicketAttachment>(
          'Tickets',
          ticketId,
          'Attachments',
          attachmentId
        );
      }

      // Only the top-level entity endpoint populates `data`; the child endpoint
      // omits it regardless of any query parameters.
      const attachment = await http.get<AutotaskTicketAttachment>('TicketAttachments', attachmentId);
      if (!attachment) return null;

      // The top-level endpoint accepts any attachment ID, so we have to enforce
      // parent scope ourselves to honor the (ticketId, attachmentId) contract.
      if (typeof attachment.ticketID === 'number' && attachment.ticketID !== ticketId) {
        this.logger.warn(
          `Ticket attachment ${attachmentId} belongs to ticket ${attachment.ticketID}, not ${ticketId}. Returning null.`
        );
        return null;
      }

      // Oversized binaries arrive truncated/garbled at the MCP client. Strip
      // and surface a reason so the caller knows to fetch out-of-band rather
      // than wondering why the response is broken.
      if (typeof attachment.data === 'string' && attachment.data.length > maxInlineBase64Bytes) {
        const decodedBytes = Buffer.byteLength(attachment.data, 'base64');
        const reason =
          `Attachment data omitted: base64 length ${attachment.data.length} bytes ` +
          `(${decodedBytes} bytes decoded) exceeds inline limit of ${maxInlineBase64Bytes} bytes. ` +
          `Fetch directly from Autotask, or call again with a larger maxInlineBase64Bytes (caveat: ` +
          `the MCP client may reject the oversized response).`;
        this.logger.warn(
          `getTicketAttachment: stripping oversized data for attachment ${attachmentId} (${attachment.data.length} base64 bytes)`
        );
        const { data: _omitted, ...rest } = attachment;
        return { ...rest, dataOmittedReason: reason };
      }

      return attachment;
    } catch (error) {
      this.logger.error(`Failed to get ticket attachment ${attachmentId} for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async searchTicketAttachments(
    ticketId: number,
    options: AutotaskQueryOptionsExtended = {}
  ): Promise<AutotaskTicketAttachment[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Searching ticket attachments for ticket ${ticketId}:`, options);
      const attachments = await http.childQuery<AutotaskTicketAttachment>(
        'Tickets',
        ticketId,
        'Attachments',
        MATCH_ALL,
        { maxRecords: options.pageSize || 10 }
      );
      this.logger.info(`Retrieved ${attachments.length} ticket attachments`);
      return attachments;
    } catch (error) {
      this.logger.error(`Failed to search ticket attachments for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  async createTicketAttachment(
    ticketId: number,
    data: AutotaskTicketAttachmentCreateRequest
  ): Promise<number> {
    const decodedLength = this.validateAttachmentUploadData('createTicketAttachment', data);

    const http = await this.ensureClient();

    const payload = {
      title: data.title,
      fullPath: data.fullPath || data.title,
      data: data.data,
      attachmentType: data.attachmentType || 'FILE_ATTACHMENT',
      contentType: data.contentType,
      publish: data.publish ?? 1,
      parentId: ticketId,
      parentType: 4 // Ticket
    };

    try {
      this.logger.info(
        `Creating ticket attachment - ticketId=${ticketId} title="${data.title}" bytes=${decodedLength}`
      );
      const id = await http.childCreate('Tickets', ticketId, 'Attachments', payload);
      this.logger.info(`Ticket attachment created with ID: ${id} for ticket ${ticketId}`);
      return id;
    } catch (error) {
      this.logger.error(`Failed to create ticket attachment for ticket ${ticketId}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Expense Reports / Items
  // =====================================================

  async getExpenseReport(id: number): Promise<AutotaskExpenseReport | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting expense report with ID: ${id}`);
      return await http.get<AutotaskExpenseReport>('ExpenseReports', id);
    } catch (error) {
      this.logger.error(`Failed to get expense report ${id}:`, error);
      throw error;
    }
  }

  async searchExpenseReports(options: AutotaskQueryOptionsExtended = {}): Promise<AutotaskExpenseReport[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching expense reports with options:', options);
      const filters: QueryFilter[] = [];
      if (options.submitterId) {
        filters.push({ field: 'resourceId', op: 'eq', value: options.submitterId });
      }
      if (options.status) {
        filters.push({ field: 'status', op: 'eq', value: options.status });
      }
      const reports = await http.query<AutotaskExpenseReport>(
        'ExpenseReports',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: options.pageSize || 25 }
      );
      this.logger.info(`Retrieved ${reports.length} expense reports`);
      return reports;
    } catch (error) {
      this.logger.error('Failed to search expense reports:', error);
      throw error;
    }
  }

  async createExpenseReport(report: Partial<AutotaskExpenseReport>): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating expense report:', report);
      const id = await http.create('ExpenseReports', report);
      this.logger.info(`Expense report created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create expense report:', error);
      throw error;
    }
  }

  async getExpenseItem(itemId: number): Promise<AutotaskExpenseItem | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting expense item with ID: ${itemId}`);
      return await http.get<AutotaskExpenseItem>('ExpenseItems', itemId);
    } catch (error) {
      this.logger.error(`Failed to get expense item ${itemId}:`, error);
      throw error;
    }
  }

  async searchExpenseItems(options: AutotaskQueryOptionsExtended = {}): Promise<AutotaskExpenseItem[]> {
    try {
      this.logger.debug('Searching expense items with options:', options);
      const filters: QueryFilter[] = [];
      if (options.expenseReportId) {
        filters.push({ field: 'expenseReportID', op: 'eq', value: options.expenseReportId });
      }
      if (options.ticketId != null) {
        filters.push({ field: 'ticketID', op: 'eq', value: options.ticketId });
      }
      if (options.startDate) {
        filters.push({ field: 'expenseDate', op: 'gte', value: options.startDate });
      }
      if (options.endDate) {
        filters.push({ field: 'expenseDate', op: 'lte', value: options.endDate });
      }
      // Served from the Postgres shadow when a date range keeps it inside the mirrored window (0 Autotask calls).
      const items = (await this.queryPaged<AutotaskExpenseItem>('ExpenseItems', filters.length > 0 ? filters : MATCH_ALL, { pageSize: options.pageSize || 25 }, { defaultPageSize: 25, maxPageSize: 500 })).items;
      this.logger.info(`Retrieved ${items.length} expense items`);
      return items;
    } catch (error) {
      this.logger.error('Failed to search expense items:', error);
      throw error;
    }
  }

  async createExpenseItem(item: Partial<AutotaskExpenseItem>): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating expense item:', item);
      const id = await http.create('ExpenseItems', item);
      this.logger.info(`Expense item created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create expense item:', error);
      throw error;
    }
  }

  // =====================================================
  // Quotes
  // =====================================================

  async getQuote(id: number): Promise<AutotaskQuote | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting quote with ID: ${id}`);
      return await http.get<AutotaskQuote>('Quotes', id);
    } catch (error) {
      this.logger.error(`Failed to get quote ${id}:`, error);
      throw error;
    }
  }

  async searchQuotes(options: AutotaskQueryOptionsExtended = {}): Promise<AutotaskQuote[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching quotes with options:', options);
      const filters: QueryFilter[] = [];
      if (options.companyId != null) {
        // The Quotes entity has NO account* field — its company link is
        // `companyID` (confirmed via entityInformation/fields). Filtering on
        // `accountId` returns HTTP 500 "Unable to find accountId in the
        // Quote Entity" on every tenant.
        filters.push({ field: 'companyID', op: 'eq', value: options.companyId });
      }
      if (options.contactId) {
        filters.push({ field: 'contactID', op: 'eq', value: options.contactId });
      }
      if (options.opportunityId) {
        filters.push({ field: 'opportunityID', op: 'eq', value: options.opportunityId });
      }
      if (options.searchTerm) {
        filters.push({ field: 'description', op: 'contains', value: options.searchTerm });
      }
      const quotes = await http.query<AutotaskQuote>(
        'Quotes',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: options.pageSize || 25 }
      );
      this.logger.info(`Retrieved ${quotes.length} quotes`);
      return quotes;
    } catch (error) {
      this.logger.error('Failed to search quotes:', error);
      throw error;
    }
  }

  async createQuote(quote: Partial<AutotaskQuote>): Promise<number> {
    const http = await this.ensureClient();
    try {
      // Autotask requires location IDs on the quote. Auto-populate from the
      // company's first location if the caller didn't supply them.
      if (
        quote.companyID != null &&
        (!quote.billToLocationID || !quote.shipToLocationID || !quote.soldToLocationID)
      ) {
        try {
          const locations = await http.query<{ id: number }>(
            'CompanyLocations',
            [{ op: 'eq', field: 'companyID', value: quote.companyID }],
            { maxRecords: 10 }
          );
          if (locations.length > 0) {
            const defaultLocationId = locations[0].id;
            if (!quote.billToLocationID) quote.billToLocationID = defaultLocationId;
            if (!quote.shipToLocationID) quote.shipToLocationID = defaultLocationId;
            if (!quote.soldToLocationID) quote.soldToLocationID = defaultLocationId;
          }
        } catch (locError) {
          this.logger.warn('Could not auto-populate location IDs for quote:', locError);
        }
      }

      this.logger.debug('Creating quote:', quote);
      const id = await http.create('Quotes', quote);
      this.logger.info(`Quote created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create quote:', error);
      throw error;
    }
  }

  // =====================================================
  // Opportunities
  // =====================================================

  async getOpportunity(id: number): Promise<AutotaskOpportunity | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting opportunity with ID: ${id}`);
      return await http.get<AutotaskOpportunity>('Opportunities', id);
    } catch (error) {
      this.logger.error(`Failed to get opportunity ${id}:`, error);
      throw error;
    }
  }

  async searchOpportunities(options: AutotaskQueryOptionsExtended = {}): Promise<AutotaskOpportunity[]> {
    try {
      this.logger.debug('Searching opportunities with options:', options);
      const filters: QueryFilter[] = [];
      if (options.companyId != null) {
        filters.push({ field: 'companyID', op: 'eq', value: options.companyId });
      }
      if (options.searchTerm) {
        filters.push({ field: 'title', op: 'contains', value: options.searchTerm });
      }
      if (options.status !== undefined) {
        filters.push({ field: 'status', op: 'eq', value: options.status });
      }
      // Served from the Postgres shadow when it mirrors Opportunities and is fresh (0 Autotask calls).
      const items = (await this.queryPaged<AutotaskOpportunity>('Opportunities', filters.length > 0 ? filters : MATCH_ALL, { pageSize: options.pageSize || 25 }, { defaultPageSize: 25, maxPageSize: 500 })).items;
      this.logger.info(`Retrieved ${items.length} opportunities`);
      return items;
    } catch (error) {
      this.logger.error('Failed to search opportunities:', error);
      throw error;
    }
  }

  async createOpportunity(opportunity: Record<string, any>): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating opportunity:', opportunity);
      const oppData: Record<string, any> = {
        title: opportunity.title,
        companyID: opportunity.companyID,
        ownerResourceID: opportunity.ownerResourceID,
        status: opportunity.status,
        stage: opportunity.stage,
        projectedCloseDate: opportunity.projectedCloseDate,
        startDate: opportunity.startDate,
        probability: opportunity.probability ?? 50,
        amount: opportunity.amount ?? 0,
        cost: opportunity.cost ?? 0,
        useQuoteTotals: opportunity.useQuoteTotals ?? true,
      };
      if (opportunity.totalAmountMonths) oppData.totalAmountMonths = opportunity.totalAmountMonths;
      if (opportunity.contactID) oppData.contactID = opportunity.contactID;
      if (opportunity.description) oppData.description = opportunity.description;
      if (opportunity.opportunityCategoryID) oppData.opportunityCategoryID = opportunity.opportunityCategoryID;

      const id = await http.create('Opportunities', oppData);
      this.logger.info(`Created opportunity with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create opportunity:', error);
      throw error;
    }
  }

  /**
   * Update an opportunity (brief §4.7). Uses the HTTP client's collection PATCH
   * convention (PATCH /Opportunities with id in the body) — the item route
   * /Opportunities/{id} did not work in the GDS zone. http.update() already
   * PATCHes the collection, so this simply routes through it and preserves any
   * status/closed-date fields the caller supplies.
   */
  async updateOpportunity(id: number, updates: Record<string, any>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating opportunity ${id}:`, updates);
      await http.update('Opportunities', id, updates);
      this.logger.info(`Opportunity ${id} updated`);
    } catch (error) {
      this.logger.error(`Failed to update opportunity ${id}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Products / Services / Service Bundles (read)
  // =====================================================

  async getProduct(id: number): Promise<AutotaskProduct | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting product with ID: ${id}`);
      return await http.get<AutotaskProduct>('Products', id);
    } catch (error) {
      this.logger.error(`Failed to get product ${id}:`, error);
      throw error;
    }
  }

  async searchProducts(options: AutotaskQueryOptionsExtended = {}): Promise<AutotaskProduct[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching products with options:', options);
      const filters: QueryFilter[] = [];
      if (options.searchTerm) {
        filters.push({ field: 'name', op: 'contains', value: options.searchTerm });
      }
      if (options.isActive !== undefined) {
        filters.push({ field: 'isActive', op: 'eq', value: options.isActive });
      }
      const items = await http.query<AutotaskProduct>(
        'Products',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: options.pageSize || 25 }
      );
      this.logger.info(`Retrieved ${items.length} products`);
      return items;
    } catch (error) {
      this.logger.error('Failed to search products:', error);
      throw error;
    }
  }

  // =====================================================
  // Product & Inventory full-access CRUD (#93 / #19)
  // Admin cleanup needs create/update on the catalog and the full inventory
  // surface (stock levels, locations, transfers, count adjustments), not just
  // read reports. Thin wrappers over the REST entities; count-mutating writes
  // (transfer / add / remove) are gated as inventory-movement (confirm:true).
  // =====================================================

  async createProduct(data: Record<string, any>): Promise<number> {
    const http = await this.ensureClient();
    const id = await http.create('Products', data);
    this.logger.info(`Product created with ID: ${id}`);
    return id;
  }
  async updateProduct(id: number, updates: Record<string, any>): Promise<void> {
    const http = await this.ensureClient();
    await http.update('Products', id, updates);
    this.logger.info(`Product ${id} updated`);
  }

  // --- InventoryProducts: a product's stock levels at a location ---
  async searchInventoryProducts(opts: { productID?: number; inventoryLocationID?: number; pageSize?: number } = {}): Promise<any[]> {
    const http = await this.ensureClient();
    const f: QueryFilter[] = [];
    pushEq(f, 'productID', opts.productID);
    pushEq(f, 'inventoryLocationID', opts.inventoryLocationID);
    return http.query<any>('InventoryProducts', f.length ? f : MATCH_ALL, { maxRecords: Math.min(opts.pageSize || 100, 500) });
  }
  async getInventoryProduct(id: number): Promise<any> {
    const http = await this.ensureClient();
    return http.get<any>('InventoryProducts', id);
  }
  async createInventoryProduct(data: Record<string, any>): Promise<number> {
    const http = await this.ensureClient();
    const id = await http.create('InventoryProducts', data);
    this.logger.info(`InventoryProduct created with ID: ${id}`);
    return id;
  }
  async updateInventoryProduct(id: number, updates: Record<string, any>): Promise<void> {
    const http = await this.ensureClient();
    await http.update('InventoryProducts', id, updates);
    this.logger.info(`InventoryProduct ${id} updated`);
  }

  // --- InventoryLocations: warehouses / tech vans ---
  async searchInventoryLocations(opts: { isActive?: boolean; pageSize?: number } = {}): Promise<any[]> {
    const http = await this.ensureClient();
    const f: QueryFilter[] = [];
    if (opts.isActive !== undefined) f.push({ op: 'eq', field: 'isActive', value: opts.isActive });
    return http.query<any>('InventoryLocations', f.length ? f : MATCH_ALL, { maxRecords: Math.min(opts.pageSize || 200, 500) });
  }
  async getInventoryLocation(id: number): Promise<any> {
    const http = await this.ensureClient();
    return http.get<any>('InventoryLocations', id);
  }
  async createInventoryLocation(data: Record<string, any>): Promise<number> {
    const http = await this.ensureClient();
    const id = await http.create('InventoryLocations', data);
    this.logger.info(`InventoryLocation created with ID: ${id}`);
    return id;
  }
  async updateInventoryLocation(id: number, updates: Record<string, any>): Promise<void> {
    const http = await this.ensureClient();
    await http.update('InventoryLocations', id, updates);
    this.logger.info(`InventoryLocation ${id} updated`);
  }

  // --- InventoryStockedItems: individual stocked units (serials, counts) ---
  async searchInventoryStockedItems(opts: { inventoryProductID?: number; currentInventoryLocationID?: number; serialNumber?: string; pageSize?: number } = {}): Promise<any[]> {
    const http = await this.ensureClient();
    const f: QueryFilter[] = [];
    pushEq(f, 'inventoryProductID', opts.inventoryProductID);
    pushEq(f, 'currentInventoryLocationID', opts.currentInventoryLocationID);
    if (opts.serialNumber) f.push({ op: 'eq', field: 'serialNumber', value: opts.serialNumber });
    return http.query<any>('InventoryStockedItems', f.length ? f : MATCH_ALL, { maxRecords: Math.min(opts.pageSize || 100, 500) });
  }
  async getInventoryStockedItem(id: number): Promise<any> {
    const http = await this.ensureClient();
    return http.get<any>('InventoryStockedItems', id);
  }

  // --- InventoryTransfers: move stock between locations ---
  async searchInventoryTransfers(opts: { productID?: number; fromLocationID?: number; toLocationID?: number; pageSize?: number } = {}): Promise<any[]> {
    const http = await this.ensureClient();
    const f: QueryFilter[] = [];
    pushEq(f, 'productID', opts.productID);
    pushEq(f, 'fromLocationID', opts.fromLocationID);
    pushEq(f, 'toLocationID', opts.toLocationID);
    return http.query<any>('InventoryTransfers', f.length ? f : MATCH_ALL, { maxRecords: Math.min(opts.pageSize || 100, 500) });
  }
  async createInventoryTransfer(data: Record<string, any>): Promise<number> {
    const http = await this.ensureClient();
    const id = await http.create('InventoryTransfers', data);
    this.logger.info(`InventoryTransfer created with ID: ${id}`);
    return id;
  }

  // --- Stock count adjustments (add / remove) ---
  async addInventoryStock(data: Record<string, any>): Promise<number> {
    const http = await this.ensureClient();
    const id = await http.create('InventoryStockedItemsAdd', data);
    this.logger.info(`InventoryStockedItemsAdd created with ID: ${id}`);
    return id;
  }
  async removeInventoryStock(data: Record<string, any>): Promise<number> {
    const http = await this.ensureClient();
    const id = await http.create('InventoryStockedItemsRemove', data);
    this.logger.info(`InventoryStockedItemsRemove created with ID: ${id}`);
    return id;
  }

  // --- Phase B: guarded bulk catalog writes (dry-run-first) ---

  /**
   * Bulk product update (#93 Phase B): apply per-product field patches
   * (category, description, MSRP, part numbers, isActive, …). Diffs against
   * current values so only real changes are written and no-ops/unknown fields are
   * skipped. dryRun defaults ON — returns the planned changes and writes nothing
   * unless dryRun:false. Per-item partial-failure reporting on execute.
   */
  async bulkUpdateProducts(params: { updates: Array<Record<string, any> & { id: number }>; dryRun?: boolean }): Promise<WritePlanResult> {
    const wp = new WritePlan();
    const updates = params.updates ?? [];
    if (updates.length === 0) return wp.fail('updates', 'no product updates supplied');
    if (updates.some((u) => u.id == null)) return wp.fail('updates', 'every update needs an id');
    wp.ok('input', { products: updates.length });

    const ids = [...new Set(updates.map((u) => u.id))];
    const current = new Map<number, Record<string, any>>();
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await (await this.ensureClient()).query<any>('Products', [{ op: 'in', field: 'id', value: ids.slice(i, i + 200) }], { includeFields: this.CATALOG_FIELDS, maxRecords: 500 });
      for (const r of rows) current.set(r.id, r);
    }
    const plan = planBulkProductUpdate(current, updates);
    wp.ok('diff', { withChanges: plan.totalWithChanges, changedFields: plan.totalChangedFields, notFound: plan.notFound.length });

    if (params.dryRun !== false) {
      return wp.dryRun({ plannedUpdates: plan.items.filter((i) => i.found && !i.noop), noop: plan.items.filter((i) => i.noop).map((i) => i.id), notFound: plan.notFound });
    }

    const applied: number[] = [];
    const errors: Array<{ id: number; detail: string }> = [];
    for (const item of plan.items) {
      if (!item.found || item.noop) continue;
      const patch: Record<string, any> = {};
      for (const [k, ch] of Object.entries(item.changes)) patch[k] = ch.to;
      try { await this.updateProduct(item.id, patch); applied.push(item.id); }
      catch (e) { errors.push({ id: item.id, detail: (e as Error).message }); }
    }
    return wp.done(errors.length > 0 ? 'updated_with_errors' : 'updated', {
      updated: applied.length, updatedIds: applied,
      noop: plan.items.filter((i) => i.noop).map((i) => i.id), notFound: plan.notFound,
      ...(errors.length > 0 ? { errors } : {}),
    });
  }

  /**
   * Merge duplicate products (#93 Phase B): keep `survivorId`, enrich it with any
   * fields it lacks from the duplicates, and mark the duplicates inactive. Never
   * moves inventory — duplicates that still hold on-hand stock are flagged so
   * counts can be reconciled/transferred first. dryRun defaults ON.
   */
  async mergeProducts(params: { survivorId: number; duplicateIds: number[]; enrichSurvivor?: boolean; dryRun?: boolean }): Promise<WritePlanResult> {
    const wp = new WritePlan();
    const dupIds = [...new Set(params.duplicateIds ?? [])].filter((id) => id !== params.survivorId);
    if (params.survivorId == null) return wp.fail('survivor', 'survivorId is required');
    if (dupIds.length === 0) return wp.fail('duplicates', 'at least one duplicate id (distinct from survivor) is required');

    const survivor = (await this.getProduct(params.survivorId)) as Record<string, any> | null;
    if (!survivor) return wp.fail('survivor', `Product ${params.survivorId} not found`);
    const duplicates: Record<string, any>[] = [];
    for (const id of dupIds) {
      const d = (await this.getProduct(id)) as Record<string, any> | null;
      if (!d) return wp.fail('duplicates', `Product ${id} not found`);
      duplicates.push(d);
    }
    wp.ok('products', { survivor: params.survivorId, duplicates: dupIds });

    // On-hand per duplicate product (across locations) — warn, never auto-move.
    const onHand = new Map<number, number>();
    for (const d of duplicates) {
      const ips = await this.searchInventoryProducts({ productID: d.id, pageSize: 500 });
      onHand.set(d.id, ips.reduce((s: number, ip: any) => s + (ip.onHandUnits ?? 0), 0));
    }
    const plan = planProductMerge(survivor, duplicates, onHand, { ...(params.enrichSurvivor !== undefined ? { enrichSurvivor: params.enrichSurvivor } : {}) });
    wp.ok('plan', { enrichFields: Object.keys(plan.survivorPatch), deactivate: plan.deactivate, onHandWarnings: plan.onHandWarnings });

    if (params.dryRun !== false) {
      return wp.dryRun({
        survivorId: plan.survivorId, survivorPatch: plan.survivorPatch,
        wouldDeactivate: plan.deactivate, onHandWarnings: plan.onHandWarnings,
      });
    }

    const errors: Array<{ step: string; id?: number; detail: string }> = [];
    if (Object.keys(plan.survivorPatch).length > 0) {
      const patch: Record<string, any> = {};
      for (const [k, ch] of Object.entries(plan.survivorPatch)) patch[k] = ch.to;
      try { await this.updateProduct(plan.survivorId, patch); } catch (e) { errors.push({ step: 'enrich-survivor', id: plan.survivorId, detail: (e as Error).message }); }
    }
    const deactivated: number[] = [];
    for (const id of plan.deactivate) {
      try { await this.updateProduct(id, { isActive: false }); deactivated.push(id); }
      catch (e) { errors.push({ step: 'deactivate', id, detail: (e as Error).message }); }
    }
    return wp.done(errors.length > 0 ? 'merged_with_errors' : 'merged', {
      survivorId: plan.survivorId, enriched: Object.keys(plan.survivorPatch),
      deactivated, onHandWarnings: plan.onHandWarnings,
      ...(errors.length > 0 ? { errors } : {}),
    });
  }

  // =====================================================
  // Catalog hygiene (Phase A — read-only inspection, #93)
  // =====================================================

  private readonly CATALOG_FIELDS = [
    'id', 'name', 'description', 'productCategory', 'msrp', 'unitPrice', 'isActive',
    'sku', 'internalProductID', 'externalProductID', 'manufacturerName', 'manufacturerProductName', 'vendorProductNumber',
  ];

  /** Pull catalog products (bounded) with the fields the hygiene tools need.
   *  Autotask's native search is weak, so the hygiene/search tools scan the
   *  catalog and match in-memory; `maxProducts` keeps that bounded. */
  private async fetchCatalogProducts(opts: { activeOnly?: boolean | undefined; maxProducts?: number | undefined } = {}): Promise<any[]> {
    const http = await this.ensureClient();
    const max = Math.min(opts.maxProducts ?? 5000, 20000);
    const filters: QueryFilter[] = opts.activeOnly ? [{ op: 'eq', field: 'isActive', value: true }] : [{ op: 'gte', field: 'id', value: 0 }];
    return http.query<any>('Products', filters, { includeFields: this.CATALOG_FIELDS, maxRecords: max });
  }

  /** List the productCategory picklist as a parent→child tree, flagging
   *  malformed labels; optionally tally product counts per category (#93). */
  async listProductCategories(opts: { withCounts?: boolean; maxProducts?: number } = {}): Promise<Record<string, any>> {
    const http = await this.ensureClient();
    const picks = await http.picklistValues('Products', 'productCategory');
    let counts: Map<number, number> | undefined;
    let countedProducts = 0;
    let truncated = false;
    if (opts.withCounts) {
      const products = await this.fetchCatalogProducts({ maxProducts: opts.maxProducts });
      counts = new Map<number, number>();
      for (const p of products) if (p.productCategory != null) counts.set(p.productCategory, (counts.get(p.productCategory) ?? 0) + 1);
      countedProducts = products.length;
      truncated = products.length >= Math.min(opts.maxProducts ?? 5000, 20000);
    }
    const tree = buildCategoryTree(
      picks.map((p: any) => ({ value: Number(p.value), label: String(p.label), isActive: p.isActive })),
      counts,
    );
    return {
      categoryCount: tree.nodes.length,
      malformedCount: tree.malformedCount,
      ...(opts.withCounts ? { countedProducts, countsTruncated: truncated } : {}),
      roots: tree.roots,
      categories: tree.nodes,
    };
  }

  /** Products missing a category / MSRP / usable description (#93). */
  async findCatalogGaps(opts: { activeOnly?: boolean; minDescriptionLength?: number; maxSamples?: number; maxProducts?: number } = {}): Promise<CatalogGapsResult & { truncated: boolean }> {
    const products = await this.fetchCatalogProducts({ activeOnly: opts.activeOnly ?? true, maxProducts: opts.maxProducts });
    const res = findCatalogGaps(products as ProductLite[], { ...(opts.minDescriptionLength !== undefined ? { minDescriptionLength: opts.minDescriptionLength } : {}), ...(opts.maxSamples !== undefined ? { maxSamples: opts.maxSamples } : {}) });
    return { ...res, truncated: products.length >= Math.min(opts.maxProducts ?? 5000, 20000) };
  }

  /** Duplicate-product candidate groups with a suggested survivor (#93). */
  async findDuplicateProducts(opts: { activeOnly?: boolean; maxProducts?: number; limit?: number } = {}): Promise<Record<string, any>> {
    const products = await this.fetchCatalogProducts({ activeOnly: opts.activeOnly ?? false, maxProducts: opts.maxProducts });
    const groups = findDuplicateProducts(products as ProductLite[]);
    const limited = opts.limit ? groups.slice(0, opts.limit) : groups;
    return {
      scanned: products.length,
      duplicateGroups: limited.length,
      totalDuplicateProducts: groups.reduce((s, g) => s + g.members.length, 0),
      groups: limited,
      truncated: products.length >= Math.min(opts.maxProducts ?? 5000, 20000),
    };
  }

  /** Clean normalized product search across all identifiers (#93) — the usable
   *  layer over Autotask's weak native search. */
  async findProducts(query: string, opts: { limit?: number; activeOnly?: boolean; maxProducts?: number } = {}): Promise<Record<string, any>> {
    const products = await this.fetchCatalogProducts({ activeOnly: false, maxProducts: opts.maxProducts });
    const matches = matchProducts(products as SearchableProduct[], query, { ...(opts.limit !== undefined ? { limit: opts.limit } : {}), ...(opts.activeOnly !== undefined ? { activeOnly: opts.activeOnly } : {}) });
    return { query, scanned: products.length, matchCount: matches.length, matches, truncated: products.length >= Math.min(opts.maxProducts ?? 5000, 20000) };
  }

  // =====================================================
  // Inventory reports (Phase 3)
  // =====================================================

  /** Fetch a batch of Products keyed by id (for report joins). */
  private async fetchProductsByIds(ids: number[]): Promise<Record<string, ProductRow>> {
    const http = await this.ensureClient();
    const out: Record<string, ProductRow> = {};
    const unique = [...new Set(ids.filter((x) => x != null))];
    for (let i = 0; i < unique.length; i += 200) {
      const rows = await http.query<ProductRow>('Products', [{ op: 'in', field: 'id', value: unique.slice(i, i + 200) }], {
        includeFields: ['id', 'name', 'sku', 'unitCost', 'isActive'],
        maxRecords: 500,
      });
      for (const r of rows) out[String(r.id)] = r;
    }
    return out;
  }

  /** Reorder-control report: InventoryProducts below minimum → suggested order (all locations). */
  async getInventoryReorder(opts: { locationID?: number; warehouseOnly?: boolean } = {}): Promise<Record<string, any>> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [{ op: 'gt', field: 'quantityMinimum', value: 0 }];
    if (opts.locationID !== undefined) filters.push({ op: 'eq', field: 'inventoryLocationID', value: opts.locationID });
    const inv = await http.query<InvProductRow>('InventoryProducts', filters, {
      includeFields: ['productID', 'inventoryLocationID', 'onHandUnits', 'availableUnits', 'unitsOnOrder', 'quantityMinimum', 'quantityMaximum', 'bin'],
      maxRecords: 5000,
    });
    const locRows = await http.query<LocationRow>('InventoryLocations', MATCH_ALL, { includeFields: ['id', 'locationName', 'resourceID'], maxRecords: 500 });
    const locationsById: Record<string, LocationRow> = Object.fromEntries(locRows.map((l) => [String(l.id), l]));
    const products = await this.fetchProductsByIds(inv.map((r) => r.productID));
    const { lines, totalEstCost } = computeReorder(inv, products, locationsById);
    const filtered = opts.warehouseOnly ? lines.filter((l) => l.locationType === 'warehouse') : lines;
    return { count: filtered.length, totalEstCost: opts.warehouseOnly ? Math.round(filtered.reduce((s, l) => s + l.estCost, 0) * 100) / 100 : totalEstCost, lines: filtered };
  }

  /** Close-out report: to-order ticket charges (status 3/4) whose product has stock. Generics flagged. */
  async getInventoryCloseouts(opts: { includeGenerics?: boolean } = {}): Promise<Record<string, any>> {
    const http = await this.ensureClient();
    const charges = await http.query<OpenChargeRow>('TicketCharges', [{ op: 'in', field: 'status', value: [3, 4] }], {
      includeFields: ['id', 'ticketID', 'productID', 'name', 'status', 'unitQuantity'],
      maxRecords: 3000,
    });
    const productIds = [...new Set(charges.map((c) => c.productID).filter((x): x is number => x != null))];
    const stockByProduct: Record<string, number> = {};
    for (let i = 0; i < productIds.length; i += 200) {
      const rows = await http.query<InvProductRow>('InventoryProducts', [{ op: 'in', field: 'productID', value: productIds.slice(i, i + 200) }], {
        includeFields: ['productID', 'availableUnits'],
        maxRecords: 5000,
      });
      for (const r of rows) stockByProduct[String(r.productID)] = (stockByProduct[String(r.productID)] || 0) + (Number(r.availableUnits) || 0);
    }
    const products = await this.fetchProductsByIds(productIds);
    let lines = computeCloseouts(charges, stockByProduct, products);
    if (opts.includeGenerics === false) lines = lines.filter((l) => !l.isGeneric);
    return { count: lines.length, generics: lines.filter((l) => l.isGeneric).length, lines };
  }

  /** Stale/trending report: on-hand stock aging + recent movement (dead-stock detection). */
  async getInventoryStale(opts: { staleDays?: number; recentDays?: number } = {}): Promise<Record<string, any>> {
    const http = await this.ensureClient();
    const staleDays = opts.staleDays ?? 180;
    const recentDays = opts.recentDays ?? 180;
    const cutoff = new Date(Date.now() - recentDays * 864e5).toISOString();
    const fields = ['id', 'inventoryProductID', 'onHandUnits', 'unitCost', 'createDateTime', 'pickedRemovedDateTime'];
    const [onHand, removed] = await Promise.all([
      http.query<StockedItemRow & { id: number }>('InventoryStockedItems', [{ op: 'gt', field: 'onHandUnits', value: 0 }], { includeFields: fields, maxRecords: 10000 }),
      http.query<StockedItemRow & { id: number }>('InventoryStockedItems', [{ op: 'gte', field: 'pickedRemovedDateTime', value: cutoff }], { includeFields: fields, maxRecords: 10000 }),
    ]);
    const byId = new Map<number, StockedItemRow & { id: number }>();
    for (const it of [...onHand, ...removed]) byId.set(it.id, it);
    const items = [...byId.values()];

    const invProductIds = [...new Set(items.map((i) => i.inventoryProductID).filter((x): x is number => x != null))];
    const invToProduct: Record<string, number> = {};
    for (let i = 0; i < invProductIds.length; i += 200) {
      const rows = await http.query<{ id: number; productID: number }>('InventoryProducts', [{ op: 'in', field: 'id', value: invProductIds.slice(i, i + 200) }], { includeFields: ['id', 'productID'], maxRecords: 5000 });
      for (const r of rows) invToProduct[String(r.id)] = r.productID;
    }
    const products = await this.fetchProductsByIds(Object.values(invToProduct));
    const resolve = (ip: number) => {
      const pid = invToProduct[String(ip)] ?? null;
      return { productID: pid, name: (pid != null && products[String(pid)]?.name) || `invProduct#${ip}` };
    };
    const lines = computeStaleStock(items, resolve, { staleDays, recentDays });
    const stale = lines.filter((l) => l.stale);

    // Phantom vs dead-stock (#41): a stale product with NO removal ever on record
    // was never decremented in Autotask (likely a count error), vs one that had
    // movement and has since stalled (genuine dead stock). Scope the movement
    // lookup to just the stale products so the extra query stays bounded.
    const staleIds = [...new Set(stale.map((l) => l.inventoryProductID))];
    const everRemoved = new Set<number>();
    for (let i = 0; i < staleIds.length; i += 200) {
      const rows = await http.query<{ inventoryProductID: number }>(
        'InventoryStockedItems',
        [{ op: 'in', field: 'inventoryProductID', value: staleIds.slice(i, i + 200) }, { op: 'noteq', field: 'pickedRemovedDateTime', value: null }],
        { includeFields: ['inventoryProductID'], maxRecords: 5000 }
      );
      for (const r of rows) if (r.inventoryProductID != null) everRemoved.add(r.inventoryProductID);
    }
    classifyStaleLines(lines, everRemoved);

    // Aggregates for review: value tied up by classification and by aging bucket.
    const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const phantom = stale.filter((l) => l.classification === 'phantom');
    const deadStock = stale.filter((l) => l.classification === 'dead-stock');
    const byBucket: Record<StaleBucket, { count: number; value: number }> = {
      lt90: { count: 0, value: 0 }, d90_180: { count: 0, value: 0 }, d180_365: { count: 0, value: 0 }, d365plus: { count: 0, value: 0 },
    };
    for (const l of stale) { byBucket[l.bucket].count += 1; byBucket[l.bucket].value = r2(byBucket[l.bucket].value + l.value); }

    return {
      count: lines.length,
      staleCount: stale.length,
      staleValue: r2(stale.reduce((s, l) => s + l.value, 0)),
      phantomCount: phantom.length,
      phantomValue: r2(phantom.reduce((s, l) => s + l.value, 0)),
      deadStockCount: deadStock.length,
      deadStockValue: r2(deadStock.reduce((s, l) => s + l.value, 0)),
      byBucket,
      lines,
    };
  }

  async getService(id: number): Promise<AutotaskServiceEntity | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting service with ID: ${id}`);
      return await http.get<AutotaskServiceEntity>('Services', id);
    } catch (error) {
      this.logger.error(`Failed to get service ${id}:`, error);
      throw error;
    }
  }

  async searchServices(options: AutotaskQueryOptionsExtended = {}): Promise<AutotaskServiceEntity[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching services with options:', options);
      const filters: QueryFilter[] = [];
      if (options.searchTerm) {
        filters.push({ field: 'name', op: 'contains', value: options.searchTerm });
      }
      if (options.isActive !== undefined) {
        filters.push({ field: 'isActive', op: 'eq', value: options.isActive });
      }
      const items = await http.query<AutotaskServiceEntity>(
        'Services',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: options.pageSize || 25 }
      );
      this.logger.info(`Retrieved ${items.length} services`);
      return items;
    } catch (error) {
      this.logger.error('Failed to search services:', error);
      throw error;
    }
  }

  async getServiceBundle(id: number): Promise<AutotaskServiceBundle | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting service bundle with ID: ${id}`);
      return await http.get<AutotaskServiceBundle>('ServiceBundles', id);
    } catch (error) {
      this.logger.error(`Failed to get service bundle ${id}:`, error);
      throw error;
    }
  }

  async searchServiceBundles(options: AutotaskQueryOptionsExtended = {}): Promise<AutotaskServiceBundle[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching service bundles with options:', options);
      const filters: QueryFilter[] = [];
      if (options.searchTerm) {
        filters.push({ field: 'name', op: 'contains', value: options.searchTerm });
      }
      if (options.isActive !== undefined) {
        filters.push({ field: 'isActive', op: 'eq', value: options.isActive });
      }
      const items = await http.query<AutotaskServiceBundle>(
        'ServiceBundles',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: options.pageSize || 25 }
      );
      this.logger.info(`Retrieved ${items.length} service bundles`);
      return items;
    } catch (error) {
      this.logger.error('Failed to search service bundles:', error);
      throw error;
    }
  }

  // =====================================================
  // Quote Items (child of Quotes for create/delete)
  // =====================================================

  async getQuoteItem(id: number): Promise<AutotaskQuoteItem | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting quote item with ID: ${id}`);
      return await http.get<AutotaskQuoteItem>('QuoteItems', id);
    } catch (error) {
      this.logger.error(`Failed to get quote item ${id}:`, error);
      throw error;
    }
  }

  async searchQuoteItems(options: AutotaskQueryOptionsExtended & { quoteId?: number } = {}): Promise<AutotaskQuoteItem[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching quote items with options:', options);
      const filters: QueryFilter[] = [];
      if (options.quoteId) {
        filters.push({ field: 'quoteID', op: 'eq', value: options.quoteId });
      }
      if (options.searchTerm) {
        filters.push({ field: 'name', op: 'contains', value: options.searchTerm });
      }
      const items = await http.query<AutotaskQuoteItem>(
        'QuoteItems',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: options.pageSize || 50 }
      );
      this.logger.info(`Retrieved ${items.length} quote items`);
      return items;
    } catch (error) {
      this.logger.error('Failed to search quote items:', error);
      throw error;
    }
  }

  async createQuoteItem(item: Partial<AutotaskQuoteItem>): Promise<number> {
    const http = await this.ensureClient();
    try {
      // Auto-determine quoteItemType based on which ID field is set.
      let quoteItemType = item.quoteItemType;
      if (!quoteItemType) {
        if (item.serviceID) quoteItemType = 11;
        else if (item.serviceBundleID) quoteItemType = 12;
        else if (item.productID) quoteItemType = 1;
        else if (item.chargeID) quoteItemType = 2;
        else if (item.laborID) quoteItemType = 3;
        else if (item.expenseID) quoteItemType = 4;
        else if (item.shippingID) quoteItemType = 6;
        else quoteItemType = 2;
      }

      if (!item.quoteID) {
        throw new Error('quoteID is required to create a quote item');
      }

      const quoteItem = {
        unitDiscount: 0,
        lineDiscount: 0,
        percentageDiscount: 0,
        isOptional: false,
        ...item,
        quoteItemType: item.quoteItemType || quoteItemType,
      };
      this.logger.debug('Creating quote item:', quoteItem);
      // QuoteItems are child of Quotes: POST /Quotes/{quoteId}/Items
      const id = await http.childCreate('Quotes', item.quoteID, 'Items', quoteItem);
      this.logger.info(`Quote item created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create quote item:', error);
      throw error;
    }
  }

  async updateQuoteItem(id: number, item: Partial<AutotaskQuoteItem>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating quote item ${id}:`, item);
      await http.update('QuoteItems', id, item as Record<string, any>);
      this.logger.info(`Quote item ${id} updated`);
    } catch (error) {
      this.logger.error(`Failed to update quote item ${id}:`, error);
      throw error;
    }
  }

  async deleteQuoteItem(quoteId: number, id: number): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Deleting quote item ${id} from quote ${quoteId}`);
      await http.childDelete('Quotes', quoteId, 'Items', id);
      this.logger.info(`Quote item ${id} deleted from quote ${quoteId}`);
    } catch (error) {
      this.logger.error(`Failed to delete quote item ${id}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Billing Items
  // =====================================================

  async getBillingItem(id: number): Promise<AutotaskBillingItem | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting billing item with ID: ${id}`);
      return await http.get<AutotaskBillingItem>('BillingItems', id);
    } catch (error) {
      this.logger.error(`Failed to get billing item ${id}:`, error);
      throw error;
    }
  }

  async searchBillingItems(options: AutotaskQueryOptionsExtended = {}): Promise<PagedResult<AutotaskBillingItem>> {
    try {
      this.logger.debug('Searching billing items with options:', options);
      const filters: QueryFilter[] = [];

      if (options.companyId !== undefined) {
        filters.push({ op: 'eq', field: 'companyID', value: options.companyId });
      }
      if ((options as any).ticketId !== undefined) {
        filters.push({ op: 'eq', field: 'ticketID', value: (options as any).ticketId });
      }
      if ((options as any).projectId !== undefined) {
        filters.push({ op: 'eq', field: 'projectID', value: (options as any).projectId });
      }
      if ((options as any).contractId !== undefined) {
        filters.push({ op: 'eq', field: 'contractID', value: (options as any).contractId });
      }
      if ((options as any).invoiceId !== undefined) {
        filters.push({ op: 'eq', field: 'invoiceID', value: (options as any).invoiceId });
      }
      if ((options as any).isInvoiced !== undefined) {
        filters.push({ op: (options as any).isInvoiced ? 'exist' : 'notExist', field: 'invoiceID' });
      }
      if ((options as any).dateFrom) {
        filters.push({ op: 'gte', field: 'itemDate', value: (options as any).dateFrom });
      }
      if ((options as any).dateTo) {
        filters.push({ op: 'lte', field: 'itemDate', value: (options as any).dateTo });
      }
      if ((options as any).postedAfter) {
        filters.push({ op: 'gte', field: 'postedDate', value: (options as any).postedAfter });
      }
      if ((options as any).postedBefore) {
        filters.push({ op: 'lte', field: 'postedDate', value: (options as any).postedBefore });
      }

      return await this.queryPaged<AutotaskBillingItem>('BillingItems', filters, options, { maxPageSize: 500 });
    } catch (error) {
      this.logger.error('Failed to search billing items:', error);
      throw error;
    }
  }

  async searchBillingItemApprovalLevels(
    options: AutotaskQueryOptionsExtended = {}
  ): Promise<PagedResult<AutotaskBillingItemApprovalLevel>> {
    try {
      this.logger.debug('Searching billing item approval levels with options:', options);
      const filters: QueryFilter[] = [];
      if ((options as any).timeEntryId !== undefined) {
        filters.push({ op: 'eq', field: 'timeEntryID', value: (options as any).timeEntryId });
      }
      if ((options as any).approvalResourceId !== undefined) {
        filters.push({ op: 'eq', field: 'approvalResourceID', value: (options as any).approvalResourceId });
      }
      if ((options as any).approvalLevel !== undefined) {
        filters.push({ op: 'eq', field: 'approvalLevel', value: (options as any).approvalLevel });
      }
      if ((options as any).approvedAfter) {
        filters.push({ op: 'gte', field: 'approvalDateTime', value: (options as any).approvedAfter });
      }
      if ((options as any).approvedBefore) {
        filters.push({ op: 'lte', field: 'approvalDateTime', value: (options as any).approvedBefore });
      }

      return await this.queryPaged<AutotaskBillingItemApprovalLevel>(
        'BillingItemApprovalLevels', filters, options, { maxPageSize: 500 }
      );
    } catch (error) {
      this.logger.error('Failed to search billing item approval levels:', error);
      throw error;
    }
  }

  async searchTimeEntries(options: AutotaskQueryOptionsExtended = {}): Promise<PagedResult<AutotaskTimeEntry>> {
    try {
      this.logger.debug('Searching time entries with options:', options);
      const filters: QueryFilter[] = [];

      if ((options as any).resourceId !== undefined) {
        filters.push({ op: 'eq', field: 'resourceID', value: (options as any).resourceId });
      }
      if ((options as any).ticketId !== undefined) {
        filters.push({ op: 'eq', field: 'ticketID', value: (options as any).ticketId });
      }
      if ((options as any).projectId !== undefined) {
        filters.push({ op: 'eq', field: 'projectID', value: (options as any).projectId });
      }
      if ((options as any).taskId !== undefined) {
        filters.push({ op: 'eq', field: 'taskID', value: (options as any).taskId });
      }
      // Contract reconciliation: labor on a contract, or on NO contract.
      const contractOpt = options as { noContract?: boolean; contractID?: number | null };
      if (contractOpt.noContract === true) {
        filters.push({ op: 'notExist', field: 'contractID' });
      } else if (contractOpt.contractID !== undefined && contractOpt.contractID !== null) {
        filters.push({ op: 'eq', field: 'contractID', value: contractOpt.contractID });
      }
      if ((options as any).dateWorkedAfter) {
        filters.push({ op: 'gte', field: 'dateWorked', value: (options as any).dateWorkedAfter });
      }
      if ((options as any).dateWorkedBefore) {
        filters.push({ op: 'lte', field: 'dateWorked', value: (options as any).dateWorkedBefore });
      }

      const approvalStatus = (options as any).approvalStatus;
      if (approvalStatus === 'unapproved') {
        filters.push({ op: 'eq', field: 'billingApprovalDateTime', value: null });
      } else if (approvalStatus === 'approved') {
        filters.push({ op: 'isnotnull', field: 'billingApprovalDateTime' });
      }

      if ((options as any).billable !== undefined) {
        filters.push({ op: 'eq', field: 'isNonBillable', value: !(options as any).billable });
      }

      return await this.queryPaged<AutotaskTimeEntry>('TimeEntries', filters, options, { maxPageSize: 500 });
    } catch (error) {
      this.logger.error('Failed to search time entries:', error);
      throw error;
    }
  }

  /**
   * Profitability (P&L) for a project / task / ticket (#98), bucketed by week or
   * month. Burden-based cost from ALL time worked (billable or not, posted or
   * not) vs realized revenue from posted billing items, with posted-vs-pending
   * clarity and a cost-coverage flag for hours whose resource has no burden set.
   * Read-only. Give exactly one of projectID / taskId / ticketId.
   */
  async getProjectPL(opts: {
    projectID?: number; taskId?: number; ticketId?: number;
    bucket?: 'week' | 'month'; from?: string; to?: string;
  }): Promise<ProjectPLResult> {
    const http = await this.ensureClient();
    const bucket = opts.bucket ?? 'month';
    const scope: 'project' | 'task' | 'ticket' = opts.projectID != null ? 'project' : opts.taskId != null ? 'task' : 'ticket';
    const entityId = (opts.projectID ?? opts.taskId ?? opts.ticketId)!;
    if (entityId == null) throw new Error('getProjectPL requires one of projectID, taskId, ticketId');

    // Resolve the set of taskIDs / ticketID that scope the time entries.
    const teFilters: QueryFilter[] = [];
    const biFilters: QueryFilter[] = [];
    if (scope === 'project') {
      const tasks = await this.searchTasks({ projectID: opts.projectID, pageSize: 500 } as AutotaskQueryOptionsExtended);
      const taskIds = tasks.items.map((t) => t.id).filter((x): x is number => x != null);
      if (taskIds.length === 0) teFilters.push({ op: 'eq', field: 'taskID', value: -1 }); // no tasks → no labor
      else teFilters.push({ op: 'in', field: 'taskID', value: taskIds });
      biFilters.push({ op: 'eq', field: 'projectID', value: opts.projectID });
    } else if (scope === 'task') {
      teFilters.push({ op: 'eq', field: 'taskID', value: opts.taskId });
      biFilters.push({ op: 'eq', field: 'taskID', value: opts.taskId });
    } else {
      teFilters.push({ op: 'eq', field: 'ticketID', value: opts.ticketId });
      biFilters.push({ op: 'eq', field: 'ticketID', value: opts.ticketId });
    }
    if (opts.from) { teFilters.push({ op: 'gte', field: 'dateWorked', value: opts.from }); biFilters.push({ op: 'gte', field: 'itemDate', value: opts.from }); }
    if (opts.to) { teFilters.push({ op: 'lte', field: 'dateWorked', value: opts.to }); biFilters.push({ op: 'lte', field: 'itemDate', value: opts.to }); }

    const [timeEntries, billingItems] = await Promise.all([
      http.query<any>('TimeEntries', teFilters, { includeFields: ['id', 'resourceID', 'hoursWorked', 'isNonBillable', 'billingApprovalDateTime', 'dateWorked', 'taskID', 'ticketID'], maxRecords: 5000 }),
      http.query<any>('BillingItems', biFilters, { includeFields: ['id', 'totalAmount', 'ourCost', 'billingItemType', 'nonBillable', 'postedDate', 'itemDate', 'projectID', 'taskID', 'ticketID'], maxRecords: 5000 }),
    ]);

    // Resource burden (internalCost) for the resources that logged time.
    const resourceIds = [...new Set(timeEntries.map((t: any) => t.resourceID).filter((x: any): x is number => x != null))];
    const burdenByResource = new Map<number, number>();
    for (let i = 0; i < resourceIds.length; i += 200) {
      const rows = await http.query<any>('Resources', [{ op: 'in', field: 'id', value: resourceIds.slice(i, i + 200) }], { includeFields: ['id', 'internalCost'], maxRecords: 500 });
      for (const r of rows) burdenByResource.set(r.id, r.internalCost ?? 0);
    }

    return computeProjectPL({ scope, entityId, bucket, timeEntries, billingItems, burdenByResource });
  }

  /**
   * SLA compliance report (#100): classify each ticket's three SLA stages
   * (Triage / Tech-Engagement / Resolved) as met / missed / pending / breached /
   * no-target, with per-stage compliance %, a breach queue (open + overdue), and
   * optional grouping. Read-only. Scoped by createDate window + optional
   * company/queue; bounded by maxTickets.
   */
  async getSlaCompliance(opts: {
    from?: string; to?: string; companyID?: number; queueID?: number; openOnly?: boolean;
    groupBy?: 'queue' | 'resource' | 'company' | 'week' | 'month'; maxTickets?: number;
  } = {}): Promise<SlaComplianceResult> {
    const http = await this.ensureClient();
    const max = Math.min(opts.maxTickets ?? 2000, 10000);
    const from = opts.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const filters: QueryFilter[] = [{ op: 'gte', field: 'createDate', value: from }];
    if (opts.to) filters.push({ op: 'lte', field: 'createDate', value: opts.to });
    if (opts.companyID != null) filters.push({ op: 'eq', field: 'companyID', value: opts.companyID });
    if (opts.queueID != null) filters.push({ op: 'eq', field: 'queueID', value: opts.queueID });
    if (opts.openOnly) filters.push({ op: 'noteq', field: 'status', value: 5 }); // 5 = Complete

    // Query Tickets directly (not searchTickets) so the SLA fields aren't stripped
    // by the aggressive read optimizer.
    const tickets = await http.query<any>('Tickets', filters, {
      includeFields: [
        'id', 'ticketNumber', 'status', 'queueID', 'assignedResourceID', 'companyID', 'createDate',
        'firstResponseDueDateTime', 'firstResponseDateTime',
        'resolutionPlanDueDateTime', 'resolutionPlanDateTime',
        'resolvedDueDateTime', 'resolvedDateTime',
        'serviceLevelAgreementHasBeenMet', 'serviceLevelAgreementID',
      ],
      maxRecords: max,
    });
    const result = computeSlaCompliance(tickets, new Date(), { ...(opts.groupBy ? { groupBy: opts.groupBy } : {}) });
    if (tickets.length >= max) result.truncated = true;
    return result;
  }

  /**
   * Time-entry compliance / team hours (#100). Per resource × week/month:
   * hours logged vs expected (utilization), billable vs non-billable, approved
   * vs unapproved (billingApprovalDateTime — the timesheet check-and-balance),
   * and LATE entries (createDateTime vs dateWorked) as the real-time-discipline
   * signal. Flags under-logged / not-logging / low-utilization / chronically-late
   * resources. Read-only; scoped by dateWorked window (default last 4 weeks).
   */
  async getTimeEntryComplianceReport(opts: {
    from?: string; to?: string; bucket?: 'week' | 'month'; resourceID?: number;
    expectedHoursPerBucket?: number; expectedHoursPerWeek?: number; lateThresholdDays?: number;
    maxEntries?: number;
  } = {}): Promise<TimeEntryComplianceResult> {
    const http = await this.ensureClient();
    const max = Math.min(opts.maxEntries ?? 5000, 20000);
    const to = opts.to ?? new Date().toISOString().slice(0, 10);
    const from = opts.from ?? new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10);

    const filters: QueryFilter[] = [
      { op: 'gte', field: 'dateWorked', value: from },
      { op: 'lte', field: 'dateWorked', value: to },
    ];
    if (opts.resourceID != null) filters.push({ op: 'eq', field: 'resourceID', value: opts.resourceID });

    const entries = await http.query<any>('TimeEntries', filters, {
      includeFields: ['id', 'resourceID', 'hoursWorked', 'isNonBillable', 'billingApprovalDateTime', 'dateWorked', 'createDateTime'],
      maxRecords: max,
    });

    // Resource names for the resources that logged time (bounded).
    const resourceIds = [...new Set(entries.map((e: any) => e.resourceID).filter((x: any): x is number => x != null))];
    const resourceNames = new Map<number, string>();
    for (let i = 0; i < resourceIds.length; i += 200) {
      const rows = await http.query<any>('Resources', [{ op: 'in', field: 'id', value: resourceIds.slice(i, i + 200) }], { includeFields: ['id', 'firstName', 'lastName'], maxRecords: 500 });
      for (const r of rows) resourceNames.set(r.id, [r.firstName, r.lastName].filter(Boolean).join(' ') || `Resource ${r.id}`);
    }

    const result = computeTimeEntryCompliance(entries, from, to, {
      ...(opts.bucket ? { bucket: opts.bucket } : {}),
      ...(opts.expectedHoursPerBucket != null ? { expectedHoursPerBucket: opts.expectedHoursPerBucket } : {}),
      ...(opts.expectedHoursPerWeek != null ? { expectedHoursPerWeek: opts.expectedHoursPerWeek } : {}),
      ...(opts.lateThresholdDays != null ? { lateThresholdDays: opts.lateThresholdDays } : {}),
      resourceNames,
    });
    if (entries.length >= max) result.truncated = true;
    return result;
  }

  /**
   * Notification history (read-only): the e-mails Autotask sent, grouped into
   * SENDS (one row per recipient upstream; see utils/notification-history).
   * Scoped by subject (ticket / time entry / task / project), initiator,
   * recipient, template and/or a sent-time window. Autotask can't sort query
   * results, so matching rows are fetched (capped), grouped, sorted newest
   * first, and paged by SEND — a send's recipients never split across pages.
   */
  async searchNotificationHistory(opts: {
    ticketID?: number; timeEntryID?: number; taskID?: number; projectID?: number;
    initiatingResourceID?: number; recipientEmail?: string; templateName?: string;
    from?: string; to?: string; page?: number; pageSize?: number; maxRows?: number;
  }): Promise<{ sends: NotificationSend[]; page: number; pageSize: number; hasMore: boolean; totalSends: number; rowsScanned: number; truncated: boolean; internalDomains: string[] }> {
    const http = await this.ensureClient();
    const filters: QueryFilter[] = [];
    pushEq(filters, 'ticketID', opts.ticketID);
    pushEq(filters, 'timeEntryID', opts.timeEntryID);
    pushEq(filters, 'taskID', opts.taskID);
    pushEq(filters, 'projectID', opts.projectID);
    pushEq(filters, 'initiatingResourceID', opts.initiatingResourceID);
    if (opts.recipientEmail) filters.push({ op: 'contains', field: 'recipientEmailAddress', value: opts.recipientEmail });
    if (opts.templateName) filters.push({ op: 'contains', field: 'templateName', value: opts.templateName });
    const scoped = filters.length > 0;
    if (opts.from) filters.push({ op: 'gte', field: 'notificationSentTime', value: opts.from.length === 10 ? `${opts.from}T00:00:00Z` : opts.from });
    if (opts.to) filters.push({ op: 'lt', field: 'notificationSentTime', value: opts.to.length === 10 ? new Date(Date.parse(`${opts.to}T00:00:00Z`) + 86_400_000).toISOString() : opts.to });
    if (!scoped) {
      // An unscoped scan of the whole e-mail log is never what a caller wants.
      const span = opts.from && opts.to ? (Date.parse(opts.to) - Date.parse(opts.from)) / 86_400_000 : Infinity;
      if (!(span <= 31)) throw new Error('Scope the search: pass ticketID / timeEntryID / taskID / projectID / initiatingResourceID / recipientEmail / templateName, or a from+to window of at most 31 days.');
    }
    const maxRows = Math.min(Math.max(opts.maxRows ?? 2000, 1), 10000);
    const rows = await http.query<NotificationRow>('NotificationHistory', filters, {
      includeFields: ['id', 'notificationSentTime', 'notificationHistoryTypeID', 'templateName', 'recipientEmailAddress', 'recipientDisplayName',
        'initiatingResourceID', 'initiatingContactID', 'ticketID', 'timeEntryID', 'taskID', 'projectID', 'opportunityID', 'quoteID', 'companyID', 'entityNumber', 'entityTitle'],
      maxRecords: maxRows,
    });

    const typeLabels = new Map<number, string>();
    try {
      const f = (await this.getFieldInfo('NotificationHistory')).find((x) => x.name === 'notificationHistoryTypeID');
      for (const v of f?.picklistValues ?? []) typeLabels.set(Number(v.value), v.label);
    } catch { /* labels are a nicety */ }
    const resourceNames = new Map<number, string>();
    const domains = new Set((process.env.AUTOTASK_INTERNAL_EMAIL_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean));
    const ids = [...new Set(rows.map((r) => r.initiatingResourceID).filter((x): x is number => x != null))];
    for (let i = 0; i < ids.length; i += 200) {
      try {
        for (const r of await http.query<{ id: number; firstName?: string; lastName?: string; email?: string }>('Resources', [{ op: 'in', field: 'id', value: ids.slice(i, i + 200) }], { includeFields: ['id', 'firstName', 'lastName', 'email'], maxRecords: 500 })) {
          resourceNames.set(r.id, [r.firstName, r.lastName].filter(Boolean).join(' ') || `Resource ${r.id}`);
          // A tech's own address marks the tenant's internal domain(s).
          const dom = emailDomain(r.email);
          if (dom) domains.add(dom);
        }
      } catch { /* names are a nicety */ }
    }

    const internalDomains = [...domains];
    const all = groupNotificationSends(rows, { typeLabels, resourceNames, internalDomains });
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(Math.max(opts.pageSize || 25, 1), 200);
    const sends = all.slice((page - 1) * pageSize, page * pageSize);
    return { sends, page, pageSize, hasMore: all.length > page * pageSize, totalSends: all.length, rowsScanned: rows.length, truncated: rows.length >= maxRows, internalDomains };
  }

  /**
   * Activity without time — the Autotask side of the billable-time leakage
   * audit. Per resource × local day: tickets with evidence of their work
   * (substantive notes they wrote, tickets they completed; close notes and
   * e-mails they sent as supporting context) but NO time entry by them on the
   * ticket that day (± toleranceDays). Read-only. Days are the resource's local
   * days (their location's timezone unless timeZone is given). See
   * utils/activity-without-time for the grading.
   */
  async reportActivityWithoutTime(opts: {
    resourceIDs: number[]; from?: string; to?: string; timeZone?: string;
    toleranceDays?: number; minConfidence?: GapConfidence; includeMonitoring?: boolean;
    includeInternal?: boolean; staleDays?: number;
  }): Promise<{ from: string; to: string; resources: AwtResourceResult[]; totals: { high: number; medium: number; resources: number }; notes: string[] }> {
    const http = await this.ensureClient();
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const to = opts.to ?? day(new Date());
    const from = opts.from ?? day(new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000));
    const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (!(spanDays >= 0) || spanDays > 31) throw new Error('from/to must be a window of 0–31 days (YYYY-MM-DD, from <= to).');
    const tolerance = Math.min(Math.max(opts.toleranceDays ?? 1, 0), 7);
    // Pad the UTC fetch window a day each side so local days at the edges are whole.
    const utcFrom = `${day(new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000))}T00:00:00Z`;
    const utcTo = `${day(new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86_400_000))}T00:00:00Z`;
    const timeFrom = day(new Date(Date.parse(`${from}T00:00:00Z`) - tolerance * 86_400_000));
    const timeTo = day(new Date(Date.parse(`${to}T00:00:00Z`) + tolerance * 86_400_000));

    // Monitoring-alert tickets (auto-generated) — by source / queue / type /
    // category label (live GDS picklists: source "Monitoring Alert"/"RMM", queues
    // "Monitoring Alert"/"Managed Services Alert"/"Alerts", type "Alert",
    // categories "AEM Alert"/"Datto Alert").
    const monitoringValues = { source: new Set<string>(), queueID: new Set<string>(), ticketType: new Set<string>(), ticketCategory: new Set<string>() };
    try {
      const fields = await this.getFieldInfo('Tickets');
      for (const f of ['source', 'queueID', 'ticketType', 'ticketCategory'] as const) {
        for (const v of fields.find((x) => x.name === f)?.picklistValues ?? []) {
          if (/monitor|rmm|alert|datto|auvik|backup/i.test(v.label)) monitoringValues[f].add(String(v.value));
        }
      }
    } catch { /* best-effort: nothing excluded as monitoring */ }

    const resources: AwtResourceResult[] = [];
    for (const resourceID of opts.resourceIDs) {
      const tz = validTimeZone(opts.timeZone) ?? (await this.resolveResourceTimeZone(resourceID)) ?? defaultTimeZone();
      // Sequential, never Promise.all: the API user is shared by every caller
      // (n8n, ChatGPT, automations), and a parallel burst trips Autotask's
      // per-integration concurrent-request 429 for all of them.
      const notes = await http.query<AwtNote>('TicketNotes', [{ op: 'eq', field: 'creatorResourceID', value: resourceID }, { op: 'gte', field: 'createDateTime', value: utcFrom }, { op: 'lt', field: 'createDateTime', value: utcTo }],
        { includeFields: ['id', 'ticketID', 'noteType', 'title', 'description', 'createDateTime', 'creatorResourceID'], maxRecords: 5000 });
      const completions = await http.query<AwtCompletion>('Tickets', [{ op: 'eq', field: 'completedByResourceID', value: resourceID }, { op: 'gte', field: 'completedDate', value: utcFrom }, { op: 'lt', field: 'completedDate', value: utcTo }],
        { includeFields: ['id', 'completedDate'], maxRecords: 5000 });
      const emails = await http.query<AwtEmail>('NotificationHistory', [{ op: 'eq', field: 'initiatingResourceID', value: resourceID }, { op: 'gte', field: 'notificationSentTime', value: utcFrom }, { op: 'lt', field: 'notificationSentTime', value: utcTo }],
        { includeFields: ['id', 'ticketID', 'timeEntryID', 'notificationSentTime', 'templateName', 'recipientEmailAddress'], maxRecords: 5000 }).catch(() => [] as AwtEmail[]);
      const timeEntries = await http.query<AwtTimeEntry>('TimeEntries', [{ op: 'eq', field: 'resourceID', value: resourceID }, { op: 'gte', field: 'dateWorked', value: timeFrom }, { op: 'lte', field: 'dateWorked', value: timeTo }],
        { includeFields: ['id', 'ticketID', 'dateWorked', 'hoursWorked'], maxRecords: 5000 });
      const resourceName = (await this.getResourceNames([resourceID])).get(resourceID);

      // Ticket context for every ticket that carries evidence.
      const ids = [...new Set([...notes.map((n) => n.ticketID), ...completions.map((c) => c.id)].filter((x): x is number => x != null))];
      const tickets = new Map<number, AwtTicket>();
      const companyIDs = new Set<number>();
      type RawTicket = { id: number; ticketNumber?: string; title?: string; companyID?: number; source?: number; queueID?: number; ticketType?: number; ticketCategory?: number; createDate?: string };
      const raw: RawTicket[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        raw.push(...await http.query<RawTicket>('Tickets', [{ op: 'in', field: 'id', value: ids.slice(i, i + 200) }],
          { includeFields: ['id', 'ticketNumber', 'title', 'companyID', 'source', 'queueID', 'ticketType', 'ticketCategory', 'createDate'], maxRecords: 500 }));
      }
      const hit = (set: Set<string>, v: number | undefined) => v != null && set.has(String(v));
      for (const t of raw) if (t.companyID != null) companyIDs.add(t.companyID);
      const companyNames = new Map<number, string>();
      const cids = [...companyIDs];
      for (let i = 0; i < cids.length; i += 200) {
        try {
          for (const c of await http.query<{ id: number; companyName?: string }>('Companies', [{ op: 'in', field: 'id', value: cids.slice(i, i + 200) }], { includeFields: ['id', 'companyName'], maxRecords: 500 })) {
            if (c.companyName) companyNames.set(c.id, c.companyName);
          }
        } catch { /* names are a nicety */ }
      }
      const linkFor = (id: number): string | null => { try { return this.getTicketWebUrl(id); } catch { return null; } };
      for (const t of raw) {
        const url = linkFor(t.id);
        tickets.set(t.id, {
          id: t.id,
          ...(t.ticketNumber ? { ticketNumber: t.ticketNumber } : {}),
          ...(t.title ? { title: t.title } : {}),
          companyName: t.companyID != null ? (companyNames.get(t.companyID) ?? null) : null,
          isMonitoring: hit(monitoringValues.source, t.source) || hit(monitoringValues.queueID, t.queueID) || hit(monitoringValues.ticketType, t.ticketType) || hit(monitoringValues.ticketCategory, t.ticketCategory),
          // companyID 0 is always the tenant's own company in Autotask.
          isInternal: t.companyID === 0,
          createDate: t.createDate ?? null,
          ticketUrl: url,
        });
      }
      const name = resourceName ?? '';
      resources.push(computeActivityWithoutTime(resourceID, { notes, completions, emails, timeEntries, tickets }, {
        timeZone: tz, from, to, toleranceDays: tolerance,
        ...(opts.minConfidence ? { minConfidence: opts.minConfidence } : {}),
        ...(opts.includeMonitoring != null ? { includeMonitoring: opts.includeMonitoring } : {}),
        ...(opts.includeInternal != null ? { includeInternal: opts.includeInternal } : {}),
        ...(opts.staleDays != null ? { staleDays: opts.staleDays } : {}),
      }, name || undefined));
    }

    return {
      from, to, resources,
      totals: { high: resources.reduce((s, r) => s + r.counts.high, 0), medium: resources.reduce((s, r) => s + r.counts.medium, 0), resources: resources.length },
      notes: [
        'A gap is Autotask evidence of work with no time by that tech on that ticket that day — a lead to confirm, not proof of unbilled work (some work is legitimately non-billable or logged elsewhere).',
        'Excluded by default (counted per resource under "excluded"): internal-company tickets, monitoring alerts, mail-loop junk (auto-replies/bounces), and backlog cleanup (an old ticket closed with no substantive note).',
        `Time on the same ticket within ${tolerance} day(s) either side counts as covered.`,
        'External evidence (Teams, email, meetings, phone) is not read here — correlate it separately.',
      ],
    };
  }

  /**
   * Tickets needing scheduling (#100). Open tickets with hours left to schedule
   * (and/or an install/project type) that have NO usable Service Call — the work
   * that never made it onto the calendar. Classifies unscheduled (no service call)
   * vs past_service_call (only stale/past calls) vs scheduled (a future call).
   * Read-only. By default limits to open tickets with hoursToBeScheduled > 0;
   * pass requireHoursToSchedule:false to consider every open ticket.
   */
  async getTicketsNeedingScheduling(opts: {
    companyID?: number; queueID?: number; ticketType?: number;
    requireHoursToSchedule?: boolean; groupBy?: 'queue' | 'company' | 'resource'; maxTickets?: number;
  } = {}): Promise<TicketsNeedingSchedulingResult> {
    const http = await this.ensureClient();
    const max = Math.min(opts.maxTickets ?? 2000, 10000);
    const filters: QueryFilter[] = [{ op: 'noteq', field: 'status', value: 5 }]; // 5 = Complete
    if (opts.companyID != null) filters.push({ op: 'eq', field: 'companyID', value: opts.companyID });
    if (opts.queueID != null) filters.push({ op: 'eq', field: 'queueID', value: opts.queueID });
    if (opts.ticketType != null) filters.push({ op: 'eq', field: 'ticketType', value: opts.ticketType });
    if (opts.requireHoursToSchedule !== false) filters.push({ op: 'gt', field: 'hoursToBeScheduled', value: 0 });

    const tickets = await http.query<any>('Tickets', filters, {
      includeFields: ['id', 'ticketNumber', 'companyID', 'queueID', 'ticketType', 'priority', 'status', 'assignedResourceID', 'hoursToBeScheduled', 'createDate', 'dueDateTime'],
      maxRecords: max,
    });

    // Which candidate tickets have a service-call link, and when those calls start.
    const ticketIds = tickets.map((t: any) => t.id).filter((x: any): x is number => x != null);
    const linkPairs: Array<{ ticketID: number; serviceCallID: number }> = [];
    for (let i = 0; i < ticketIds.length; i += 200) {
      const links = await http.query<any>('ServiceCallTickets', [{ op: 'in', field: 'ticketID', value: ticketIds.slice(i, i + 200) }], { includeFields: ['id', 'ticketID', 'serviceCallID'], maxRecords: 500 });
      for (const l of links) linkPairs.push({ ticketID: l.ticketID, serviceCallID: l.serviceCallID });
    }
    const scIds = [...new Set(linkPairs.map((l) => l.serviceCallID).filter((x): x is number => x != null))];
    const scStart = new Map<number, string | null>();
    for (let i = 0; i < scIds.length; i += 200) {
      const calls = await http.query<any>('ServiceCalls', [{ op: 'in', field: 'id', value: scIds.slice(i, i + 200) }], { includeFields: ['id', 'startDateTime'], maxRecords: 500 });
      for (const c of calls) scStart.set(c.id, c.startDateTime ?? null);
    }
    const serviceCallsByTicket = new Map<number, ServiceCallLite[]>();
    for (const l of linkPairs) {
      const arr = serviceCallsByTicket.get(l.ticketID) ?? [];
      arr.push({ id: l.serviceCallID, startDateTime: scStart.get(l.serviceCallID) ?? null });
      serviceCallsByTicket.set(l.ticketID, arr);
    }

    const result = computeTicketsNeedingScheduling(tickets, serviceCallsByTicket, new Date(), { ...(opts.groupBy ? { groupBy: opts.groupBy } : {}) });
    if (tickets.length >= max) result.truncated = true;
    return result;
  }

  /**
   * Ticket throughput / work-queue KPIs (#100). FLOW over a window (created vs
   * completed vs completion ratio + net backlog change) plus the current BACKLOG
   * snapshot (open tickets by age bucket, by status, oldest-open). Optional
   * grouping by queue/resource/company for per-team throughput. Read-only;
   * scoped by createDate/completedDate window (default last 30 days) + optional
   * company/queue. Status labels resolved from the picklist (open/waiting/on-hold
   * splits stay tenant-specific).
   */
  async getTicketThroughput(opts: {
    from?: string; to?: string; companyID?: number; queueID?: number;
    agingThresholds?: number[]; groupBy?: 'queue' | 'resource' | 'company'; maxTickets?: number;
  } = {}): Promise<TicketThroughputResult> {
    const http = await this.ensureClient();
    const max = Math.min(opts.maxTickets ?? 5000, 20000);
    const to = opts.to ?? new Date().toISOString().slice(0, 10);
    const from = opts.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const scope: QueryFilter[] = [];
    if (opts.companyID != null) scope.push({ op: 'eq', field: 'companyID', value: opts.companyID });
    if (opts.queueID != null) scope.push({ op: 'eq', field: 'queueID', value: opts.queueID });
    const fields = ['id', 'createDate', 'completedDate', 'status', 'queueID', 'assignedResourceID', 'companyID'];

    const [created, completed, open] = await Promise.all([
      http.query<any>('Tickets', [...scope, { op: 'gte', field: 'createDate', value: from }, { op: 'lte', field: 'createDate', value: to }], { includeFields: fields, maxRecords: max }),
      http.query<any>('Tickets', [...scope, { op: 'gte', field: 'completedDate', value: from }, { op: 'lte', field: 'completedDate', value: to }], { includeFields: fields, maxRecords: max }),
      http.query<any>('Tickets', [...scope, { op: 'noteq', field: 'status', value: 5 }], { includeFields: fields, maxRecords: max }),
    ]);

    // Resolve status labels for the backlog snapshot (best-effort).
    const statusLabels = new Map<number, string>();
    try {
      const fi = await this.getFieldInfo('Tickets');
      const sf = fi.find((f) => f.name === 'status');
      for (const pv of sf?.picklistValues ?? []) { const n = Number(pv.value); if (!Number.isNaN(n)) statusLabels.set(n, pv.label); }
    } catch { /* labels are optional */ }

    const result = computeTicketThroughput({
      created, completed, open, from, to,
      ...(opts.agingThresholds ? { agingThresholds: opts.agingThresholds } : {}),
      ...(opts.groupBy ? { groupBy: opts.groupBy } : {}),
      statusLabels,
    });
    const trunc: { created?: boolean; completed?: boolean; open?: boolean } = {};
    if (created.length >= max) trunc.created = true;
    if (completed.length >= max) trunc.completed = true;
    if (open.length >= max) trunc.open = true;
    if (Object.keys(trunc).length) result.truncated = trunc;
    return result;
  }

  /**
   * Request segmentation dimension (#100). Split tickets into delivery segments
   * (project / install / recurring / support, or any caller scheme) and report
   * per-segment KPIs (volume, open backlog, completion, avg open age, share).
   * Segment rules are caller-provided (queues/types are tenant-specific); with
   * none supplied it falls back to the universal ITIL classification by
   * ticketType. Read-only; scoped by createDate window (default last 90 days) +
   * optional company/queue, or openOnly for the current backlog.
   */
  async getRequestSegmentation(opts: {
    from?: string; to?: string; companyID?: number; queueID?: number; openOnly?: boolean;
    segments?: SegmentRule[]; defaultSegmentName?: string; maxTickets?: number;
  } = {}): Promise<RequestSegmentationResult> {
    const http = await this.ensureClient();
    const max = Math.min(opts.maxTickets ?? 5000, 20000);
    const to = opts.to ?? new Date().toISOString().slice(0, 10);
    const from = opts.from ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const filters: QueryFilter[] = [];
    if (opts.openOnly) filters.push({ op: 'noteq', field: 'status', value: 5 });
    else { filters.push({ op: 'gte', field: 'createDate', value: from }); filters.push({ op: 'lte', field: 'createDate', value: to }); }
    if (opts.companyID != null) filters.push({ op: 'eq', field: 'companyID', value: opts.companyID });
    if (opts.queueID != null) filters.push({ op: 'eq', field: 'queueID', value: opts.queueID });

    const tickets = await http.query<any>('Tickets', filters, {
      includeFields: ['id', 'ticketType', 'queueID', 'priority', 'issueType', 'title', 'status', 'createDate', 'completedDate'],
      maxRecords: max,
    });

    const result = computeRequestSegmentation(tickets, from, to, {
      ...(opts.segments ? { segments: opts.segments } : {}),
      ...(opts.defaultSegmentName ? { defaultSegmentName: opts.defaultSegmentName } : {}),
      ...(opts.openOnly != null ? { openOnly: opts.openOnly } : {}),
    });
    if (tickets.length >= max) result.truncated = true;
    return result;
  }

  // =====================================================
  // Webhook management (#23 §16) — read/discovery layer
  // =====================================================

  /**
   * List existing webhooks for a webhook-capable entity (tickets / companies /
   * contacts / configurationItems / ticketNotes). Read-only.
   */
  async searchWebhooks(entityKey: string, opts: { activeOnly?: boolean; pageSize?: number } = {}): Promise<{ entity: string; parentEntity: string; webhooks: Record<string, any>[] }> {
    const map = resolveWebhookEntity(entityKey);
    if (!map) throw new Error(`Unknown or unsupported webhook entity "${entityKey}". Supported: ${Object.keys(WEBHOOK_ENTITIES).join(', ')}`);
    const http = await this.ensureClient();
    const filters: QueryFilter[] = opts.activeOnly ? [{ op: 'eq', field: 'isActive', value: true }] : MATCH_ALL;
    const webhooks = await http.query<Record<string, any>>(map.parent, filters, { maxRecords: Math.min(opts.pageSize ?? 100, 500) });
    return { entity: map.key, parentEntity: map.parent, webhooks };
  }

  /**
   * Get one webhook with its monitored fields, UDF fields, and excluded resources
   * (the loop-prevention list). Read-only.
   */
  async getWebhook(entityKey: string, id: number): Promise<Record<string, any> | null> {
    const map = resolveWebhookEntity(entityKey);
    if (!map) throw new Error(`Unknown or unsupported webhook entity "${entityKey}". Supported: ${Object.keys(WEBHOOK_ENTITIES).join(', ')}`);
    const http = await this.ensureClient();
    const webhook = await http.get<Record<string, any>>(map.parent, id);
    if (!webhook) return null;
    const childFilter: QueryFilter[] = [{ op: 'eq', field: WEBHOOK_PARENT_FK, value: id }];
    const [fields, udfFields, excludedResources] = await Promise.all([
      http.query<Record<string, any>>(map.fields, childFilter, { maxRecords: 500 }).catch(() => [] as Record<string, any>[]),
      http.query<Record<string, any>>(map.udfFields, childFilter, { maxRecords: 500 }).catch(() => [] as Record<string, any>[]),
      http.query<Record<string, any>>(map.excludedResources, childFilter, { maxRecords: 500 }).catch(() => [] as Record<string, any>[]),
    ]);
    return { entity: map.key, parentEntity: map.parent, webhook, fields, udfFields, excludedResources };
  }

  // ---- Webhook writes (guarded; #23 §16 slice 2) --------------------------

  private webhookMapOrThrow(entityKey: string) {
    const map = resolveWebhookEntity(entityKey);
    if (!map) throw new Error(`Unknown or unsupported webhook entity "${entityKey}". Supported: ${Object.keys(WEBHOOK_ENTITIES).join(', ')}`);
    return map;
  }

  /**
   * Create a webhook (dry-run-first). Creates the parent webhook, then its
   * monitored fields and excluded resources. `excludedResourceIDs` should include
   * the MCP integration user's resourceID to prevent the MCP's own writes from
   * re-triggering the webhook (loop prevention). Standing config — dryRun defaults ON.
   */
  async createWebhook(entityKey: string, params: WebhookParams & {
    fields?: WebhookFieldSpec[];
    excludedResourceIDs?: number[];
    /** Exclude this MCP's own API user (loop prevention). Default true. */
    excludeSelf?: boolean;
    dryRun?: boolean;
  }): Promise<WritePlanResult> {
    const wp = new WritePlan();
    const map = this.webhookMapOrThrow(entityKey);
    // The secret comes from the argument or (preferred) AUTOTASK_WEBHOOK_SECRET,
    // so it need never appear in chat; it is never echoed back either way.
    const { secret, source: secretSource } = resolveWebhookSecret(params.secretKey);
    const errors = [
      ...secretErrors(secret),
      ...validateWebhookCreate({ ...params, secretKey: secret ?? 'placeholder-checked-above' }),
    ];
    if (errors.length) return wp.fail('input', { errors });
    wp.ok('input', { entity: map.key, secretSource });

    // Defaults for required fields Autotask expects on create (verified live).
    const payload = buildWebhookPayload({
      ...params,
      secretKey: secret!,
      isActive: params.isActive ?? true,
      sendThresholdExceededNotification: params.sendThresholdExceededNotification ?? false,
    });
    const fields = params.fields ?? [];
    // Loop prevention: requested ids + this MCP's own API user + env ids.
    const self = params.excludeSelf === false ? null : await this.resolveApiUserResourceId();
    const exclusions = buildExclusions(params.excludedResourceIDs, self, params.excludeSelf !== false);
    const excluded = exclusions.map((e) => e.resourceID);
    const warnings: string[] = [...secretWarnings(secret)];
    if (params.excludeSelf !== false && self == null) {
      warnings.push("Could not resolve this MCP's own API-user resource to exclude it — add it to excludedResourceIDs (or AUTOTASK_WEBHOOK_EXCLUDE_RESOURCE_IDS) or the MCP's own writes may re-trigger this webhook.");
    }
    wp.ok('plan', { fields: fields.length, excludedResources: excluded.length });

    if (params.dryRun !== false) {
      return wp.dryRun({
        entity: map.key,
        plannedWebhook: maskSecret(payload, secretSource),
        plannedFields: fields.map((f) => buildWebhookFieldRow(0, f)),
        plannedExcludedResources: exclusions,
        ...(warnings.length ? { warnings } : {}),
      });
    }

    const http = await this.ensureClient();
    const webhookID = await http.create(map.parent, payload);
    const childErrors: Array<{ step: string; detail: string }> = [];
    for (const f of fields) {
      try { await http.create(map.fields, buildWebhookFieldRow(webhookID, f)); }
      catch (e) { childErrors.push({ step: `field:${f.fieldID}`, detail: (e as Error).message }); }
    }
    for (const rid of excluded) {
      try { await http.create(map.excludedResources, { [WEBHOOK_PARENT_FK]: webhookID, resourceID: rid }); }
      catch (e) { childErrors.push({ step: `excludedResource:${rid}`, detail: (e as Error).message }); }
    }
    return wp.done(childErrors.length ? 'created_with_errors' : 'created', {
      entity: map.key, webhookID, fieldsCreated: fields.length - childErrors.filter((e) => e.step.startsWith('field')).length,
      excludedResourcesCreated: excluded.length - childErrors.filter((e) => e.step.startsWith('excludedResource')).length,
      excludedResources: exclusions,
      secretSource,
      ...(warnings.length ? { warnings } : {}),
      ...(childErrors.length ? { errors: childErrors } : {}),
    });
  }

  /**
   * The Resource id of the API user this MCP authenticates as — the identity
   * its own writes are attributed to, and so the one to exclude from webhooks.
   * An API user's Resource `userName` is the local part of the API username
   * (verified live 2026-10-01); falls back to email == username. Memoised;
   * null when it can't be resolved.
   */
  private apiUserResourceId: number | null | undefined;
  /**
   * Everything needed to classify an actor (MCP-001): all resources (from the
   * Postgres shadow when it mirrors them — 0 calls), the licenseType value that
   * means "API User", this MCP's own API user, and the console's registry and
   * reference-technician settings. Resources are cached 10 minutes.
   */
  async getActorContext(): Promise<ClassifyContext> {
    const now = Date.now();
    if (!this.actorResourceCache || now - this.actorResourceCache.at > 600_000) {
      const http = await this.ensureClient();
      const rows = await http.query<ActorRecord>('Resources', [{ op: 'gte', field: 'id', value: 0 }], { maxRecords: 2000, includeFields: ['id', 'firstName', 'lastName', 'email', 'isActive', 'licenseType'] });
      let apiLicenseValue: number | null = 7; // 7 = API User on standard tenants
      try {
        const lic = (await this.getFieldInfo('Resources')).find((f) => f.name === 'licenseType')?.picklistValues ?? [];
        const api = lic.find((v) => /api user/i.test(String(v.label)));
        if (api) apiLicenseValue = Number(api.value);
      } catch { /* keep the standard value */ }
      this.actorResourceCache = { at: now, resources: new Map(rows.map((r) => [Number(r.id), r])), apiLicenseValue };
    }
    let mcpApiUserId: number | null = null;
    try { mcpApiUserId = await this.resolveApiUserResourceId(); } catch { /* unknown */ }
    return {
      resources: this.actorResourceCache.resources,
      apiLicenseValue: this.actorResourceCache.apiLicenseValue,
      mcpApiUserId,
      registry: parseRegistry(settingValue<string[]>('actors.registry')),
      reference: parseReference(settingValue<string[]>('actors.reference')),
    };
  }
  private actorResourceCache: { at: number; resources: Map<number, ActorRecord>; apiLicenseValue: number | null } | null = null;

  /** The classified roster: every resource (or the given ids), with type, provenance and the reference flag. */
  async getActorRoster(opts: { resourceIds?: number[]; actorTypes?: string[]; referenceOnly?: boolean; includeInactive?: boolean } = {}): Promise<Record<string, unknown>> {
    const ctx = await this.getActorContext();
    const ids = opts.resourceIds?.length ? opts.resourceIds.map(Number) : [...new Set([...ctx.resources.keys(), ...ctx.registry.keys(), ...ctx.reference.keys()])];
    let actors = ids.map((id) => classifyActor(id, ctx));
    if (!opts.resourceIds?.length && !opts.includeInactive) actors = actors.filter((a) => a.isActive !== false || a.reference || ctx.registry.has(Number(a.resourceId)));
    if (opts.actorTypes?.length) actors = actors.filter((a) => opts.actorTypes!.includes(a.actorType));
    if (opts.referenceOnly) actors = actors.filter((a) => a.reference);
    actors.sort((a, b) => a.actorType.localeCompare(b.actorType) || String(a.displayName ?? '').localeCompare(String(b.displayName ?? '')));
    const counts: Record<string, number> = {};
    for (const a of actors) counts[a.actorType] = (counts[a.actorType] ?? 0) + 1;
    return { actors, counts, referenceCount: actors.filter((a) => a.reference).length, mcpApiUserResourceID: ctx.mcpApiUserId,
      note: 'Only actorType "human" is a person; "unknown" must be confirmed in the actor registry before being treated as one. Automated changes (this MCP\'s n8n/Nexus writes = service_account) are never ground truth.' };
  }

  async resolveApiUserResourceId(): Promise<number | null> {
    if (this.apiUserResourceId !== undefined) return this.apiUserResourceId;
    const username = this.config.autotask.username ?? '';
    if (!username) return (this.apiUserResourceId = null);
    try {
      const http = await this.ensureClient();
      const local = username.split('@')[0] ?? username;
      for (const filter of [
        [{ op: 'eq', field: 'userName', value: local }],
        [{ op: 'eq', field: 'email', value: username }],
      ] as QueryFilter[][]) {
        const rows = await http.query<{ id: number }>('Resources', filter, { includeFields: ['id'], maxRecords: 2 });
        if (rows.length === 1) return (this.apiUserResourceId = rows[0]!.id);
      }
    } catch (error) {
      this.logger.warn('Could not resolve the API user resource for webhook exclusion', error);
      return null; // transient: don't memoise a failure
    }
    return (this.apiUserResourceId = null);
  }

  /**
   * Update a webhook's parent settings (activate/deactivate, URL, event
   * subscriptions, notifications). Dry-run-first. Child fields/excluded resources
   * are managed via their own tools.
   */
  async updateWebhook(entityKey: string, id: number, patch: WebhookParams & { useEnvSecret?: boolean }, dryRun?: boolean): Promise<WritePlanResult> {
    const wp = new WritePlan();
    const map = this.webhookMapOrThrow(entityKey);
    if (id == null) return wp.fail('input', 'webhook id is required');
    // Secret rotation without the secret in chat: useEnvSecret takes it from
    // AUTOTASK_WEBHOOK_SECRET. A secret is only ever shown masked.
    const { useEnvSecret, ...rest } = patch;
    let secretSource: SecretSource | null = rest.secretKey ? 'argument' : null;
    if (useEnvSecret && !rest.secretKey) {
      const env = resolveWebhookSecret(undefined);
      if (!env.secret) return wp.fail('input', `useEnvSecret is set but ${WEBHOOK_SECRET_ENV} is not configured on the MCP host`);
      rest.secretKey = env.secret;
      secretSource = 'env';
    }
    if (rest.secretKey) {
      const errs = secretErrors(rest.secretKey);
      if (errs.length) return wp.fail('input', { errors: errs });
    }
    const payload = buildWebhookPayload(rest);
    if (Object.keys(payload).length === 0) return wp.fail('input', 'no updatable fields supplied');
    if (payload.webhookUrl && !/^https:\/\//i.test(String(payload.webhookUrl))) return wp.fail('input', 'webhookUrl must be an https:// URL');
    wp.ok('input', { entity: map.key, id, fields: Object.keys(payload) });

    if (dryRun !== false) return wp.dryRun({ entity: map.key, id, plannedPatch: maskSecret(payload, secretSource) });

    const http = await this.ensureClient();
    await http.update(map.parent, id, payload);
    return wp.done('updated', { entity: map.key, id, updated: Object.keys(payload) });
  }

  /** Delete a webhook (destructive — confirm-gated at the handler). */
  async deleteWebhook(entityKey: string, id: number): Promise<void> {
    const map = this.webhookMapOrThrow(entityKey);
    const http = await this.ensureClient();
    await http.delete(map.parent, id);
    this.logger.info(`Deleted ${map.parent} ${id}`);
  }

  /**
   * Manage a webhook's excluded resources (loop prevention). mode: 'add' creates
   * the missing ones, 'remove' deletes matching ones, 'replace' makes the set
   * exactly match resourceIDs. Dry-run-first.
   */
  async setWebhookExcludedResources(entityKey: string, webhookID: number, resourceIDs: number[], mode: 'add' | 'remove' | 'replace' = 'add', dryRun?: boolean): Promise<WritePlanResult> {
    const wp = new WritePlan();
    const map = this.webhookMapOrThrow(entityKey);
    if (webhookID == null) return wp.fail('input', 'webhookID is required');
    const wanted = [...new Set(resourceIDs ?? [])];
    if (mode !== 'replace' && wanted.length === 0) return wp.fail('input', 'resourceIDs is required for add/remove');

    const http = await this.ensureClient();
    const existing = await http.query<Record<string, any>>(map.excludedResources, [{ op: 'eq', field: WEBHOOK_PARENT_FK, value: webhookID }], { maxRecords: 500 });
    const existingByResource = new Map<number, number>(); // resourceID → row id
    for (const r of existing) if (r.resourceID != null) existingByResource.set(r.resourceID, r.id);

    let toAdd: number[] = [];
    let toRemove: number[] = []; // row ids
    if (mode === 'add') toAdd = wanted.filter((rid) => !existingByResource.has(rid));
    else if (mode === 'remove') toRemove = wanted.filter((rid) => existingByResource.has(rid)).map((rid) => existingByResource.get(rid)!);
    else { // replace
      toAdd = wanted.filter((rid) => !existingByResource.has(rid));
      toRemove = [...existingByResource.entries()].filter(([rid]) => !wanted.includes(rid)).map(([, rowId]) => rowId);
    }
    wp.ok('diff', { mode, toAdd: toAdd.length, toRemove: toRemove.length, existing: existing.length });

    if (dryRun !== false) return wp.dryRun({ entity: map.key, webhookID, mode, wouldAddResourceIDs: toAdd, wouldRemoveRowIDs: toRemove });

    const errors: Array<{ step: string; detail: string }> = [];
    for (const rid of toAdd) {
      try { await http.create(map.excludedResources, { [WEBHOOK_PARENT_FK]: webhookID, resourceID: rid }); }
      catch (e) { errors.push({ step: `add:${rid}`, detail: (e as Error).message }); }
    }
    for (const rowId of toRemove) {
      try { await http.delete(map.excludedResources, rowId); }
      catch (e) { errors.push({ step: `remove:${rowId}`, detail: (e as Error).message }); }
    }
    return wp.done(errors.length ? 'updated_with_errors' : 'updated', {
      entity: map.key, webhookID, added: toAdd.length - errors.filter((e) => e.step.startsWith('add')).length,
      removed: toRemove.length - errors.filter((e) => e.step.startsWith('remove')).length,
      ...(errors.length ? { errors } : {}),
    });
  }

  /**
   * SLA coverage / readiness check (#102 slice 2). Which contracts have no SLA
   * linked, and whether any SLA definitions exist at all. Active-status detection
   * is derived from the status picklist LABELS (tenant-agnostic); scope by company
   * or an explicit status, or set activeOnly:false to include every status.
   * Read-only.
   */
  async getContractSlaCoverage(opts: {
    companyID?: number; status?: number; activeOnly?: boolean; maxContracts?: number;
  } = {}): Promise<SlaCoverageResult> {
    const http = await this.ensureClient();
    const max = Math.min(opts.maxContracts ?? 2000, 10000);
    const fi = await this.getFieldInfo('Contracts');
    const slaField = fi.find((f) => f.name === 'serviceLevelAgreementID');
    const slaValues: PicklistOption[] = (slaField?.picklistValues ?? [])
      .filter((v) => v.isActive !== false).map((v) => ({ value: v.value, label: v.label }));
    const statusField = fi.find((f) => f.name === 'status');
    const statusValues: PicklistOption[] = (statusField?.picklistValues ?? []).map((v) => ({ value: v.value, label: v.label }));
    const activeVals = activeStatusValues(statusValues);

    const filters: QueryFilter[] = [];
    if (opts.companyID != null) filters.push({ op: 'eq', field: 'companyID', value: opts.companyID });
    if (opts.status != null) filters.push({ op: 'eq', field: 'status', value: opts.status });
    else if (opts.activeOnly !== false && activeVals.size > 0) filters.push({ op: 'in', field: 'status', value: [...activeVals] });

    const rows = await http.query<any>('Contracts', filters.length ? filters : MATCH_ALL, {
      includeFields: ['id', 'contractName', 'companyID', 'contractType', 'status', 'endDate', 'serviceLevelAgreementID'],
      maxRecords: max,
    });
    const contracts: ContractLite[] = rows.map((r) => ({
      id: r.id, contractName: r.contractName, companyID: r.companyID,
      contractType: r.contractType, status: r.status, endDate: r.endDate,
      serviceLevelAgreementID: r.serviceLevelAgreementID,
    }));
    const result = classifyContractSlaCoverage(contracts, slaValues);
    if (rows.length >= max) result.truncated = true;
    return result;
  }

  /**
   * Bulk-assign an SLA to contracts (#102 slice 3). `serviceLevelAgreementID` is
   * API-writable once SLAs exist in the UI. DRY-RUN BY DEFAULT (dryRun !== false):
   * returns the planned assignments and writes nothing. Fails closed if the tenant
   * has NO SLA definitions yet, or if an SLA value isn't a valid active picklist
   * value. Give either `assignments:[{contractID, serviceLevelAgreementID}]` or the
   * shorthand `serviceLevelAgreementID` + `contractIDs:[...]`. Shared write-plan
   * envelope; reversible (it only sets a picklist link).
   */
  async assignContractSla(params: {
    assignments?: AssignInput[]; serviceLevelAgreementID?: number | string; contractIDs?: number[]; dryRun?: boolean;
  }): Promise<WritePlanResult> {
    const wp = new WritePlan();
    let assignments: AssignInput[] = params.assignments ?? [];
    if (assignments.length === 0 && params.serviceLevelAgreementID != null && params.contractIDs?.length) {
      assignments = params.contractIDs.map((id) => ({ contractID: id, serviceLevelAgreementID: params.serviceLevelAgreementID! }));
    }
    if (assignments.length === 0) return wp.fail('input', 'supply assignments[] or (serviceLevelAgreementID + contractIDs[])');
    if (assignments.some((a) => a.contractID == null || a.serviceLevelAgreementID == null || a.serviceLevelAgreementID === '')) {
      return wp.fail('input', 'every assignment needs a contractID and a serviceLevelAgreementID');
    }
    wp.ok('input', { assignments: assignments.length });

    const fi = await this.getFieldInfo('Contracts');
    const slaField = fi.find((f) => f.name === 'serviceLevelAgreementID');
    const slaValues: PicklistOption[] = (slaField?.picklistValues ?? [])
      .filter((v) => v.isActive !== false).map((v) => ({ value: v.value, label: v.label }));
    if (slaValues.length === 0) {
      return wp.fail('sla_definitions', 'No SLA definitions exist in this tenant (Contracts.serviceLevelAgreementID has 0 values). Create them in the Autotask UI first — see autotask_generate_sla_framework.');
    }
    wp.ok('sla_definitions', { available: slaValues.length });

    const ids = [...new Set(assignments.map((a) => a.contractID))];
    const current = new Map<number, ContractLite>();
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await (await this.ensureClient()).query<any>('Contracts', [{ op: 'in', field: 'id', value: ids.slice(i, i + 200) }], {
        includeFields: ['id', 'contractName', 'companyID', 'serviceLevelAgreementID'], maxRecords: 500,
      });
      for (const r of rows) current.set(r.id, { id: r.id, contractName: r.contractName, companyID: r.companyID, serviceLevelAgreementID: r.serviceLevelAgreementID });
    }
    const plan = planContractSlaAssignment(current, assignments, slaValues);
    wp.ok('diff', { planned: plan.planned.length, noop: plan.noop.length, notFound: plan.notFound.length, invalidSla: plan.invalidSla.length });

    if (plan.planned.length === 0 && plan.invalidSla.length > 0) {
      return wp.fail('sla_value', { message: 'no valid assignments — every serviceLevelAgreementID was invalid', invalidSla: plan.invalidSla, validValues: slaValues });
    }

    if (params.dryRun !== false) {
      return wp.dryRun({ plannedAssignments: plan.planned, noop: plan.noop, notFound: plan.notFound, invalidSla: plan.invalidSla });
    }

    const coerce = (v: number | string): number | string => { const n = Number(v); return Number.isNaN(n) ? v : n; };
    const applied: number[] = [];
    const errors: Array<{ contractID: number; detail: string }> = [];
    for (const item of plan.planned) {
      try { await this.updateContract(item.contractID, { serviceLevelAgreementID: coerce(item.to) } as any); applied.push(item.contractID); }
      catch (e) { errors.push({ contractID: item.contractID, detail: (e as Error).message }); }
    }
    return wp.done(errors.length ? 'assigned_with_errors' : 'assigned', {
      assigned: applied.length, assignedIds: applied, noop: plan.noop, notFound: plan.notFound, invalidSla: plan.invalidSla,
      ...(errors.length ? { errors } : {}),
    });
  }

  // =====================================================
  // Service Calls
  // =====================================================

  async getServiceCall(id: number): Promise<AutotaskServiceCall | null> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting service call with ID: ${id}`);
      return await http.get<AutotaskServiceCall>('ServiceCalls', id);
    } catch (error) {
      this.logger.error(`Failed to get service call ${id}:`, error);
      throw error;
    }
  }

  async searchServiceCalls(options: AutotaskQueryOptionsExtended = {}): Promise<PagedResult<AutotaskServiceCall>> {
    try {
      this.logger.debug('Searching service calls with options:', options);
      const o = options as any;
      const filters: QueryFilter[] = [];

      // The tool schema advertises `companyId`, `startAfter` and `startBefore`,
      // but this method only ever read `startDate`/`endDate`. Every filter was
      // therefore dropped and the query fell through to MATCH_ALL, which is why
      // a request scoped to 2026 came back with records from 2007. `startDate`/
      // `endDate` stay accepted as aliases for existing internal callers.
      if (o.companyId !== undefined || o.companyID !== undefined) {
        filters.push({ op: 'eq', field: 'companyID', value: o.companyId ?? o.companyID });
      }
      if (o.status !== undefined) {
        filters.push({ op: 'eq', field: 'status', value: o.status });
      }
      const startAfter = o.startAfter ?? o.startDate;
      const startBefore = o.startBefore ?? o.endDate;
      // Both bounds constrain startDateTime: a call is "in the window" by when
      // it starts. Filtering the upper bound on endDateTime (as this did) drops
      // any call that starts inside the range but runs past its end.
      if (startAfter) {
        filters.push({ op: 'gte', field: 'startDateTime', value: startAfter });
      }
      if (startBefore) {
        filters.push({ op: 'lte', field: 'startDateTime', value: startBefore });
      }

      return await this.queryPaged<AutotaskServiceCall>('ServiceCalls', filters, options, { maxPageSize: 200 });
    } catch (error) {
      this.logger.error('Failed to search service calls:', error);
      throw error;
    }
  }

  /**
   * Reconcile one service call against its linked ticket's time entries, charges
   * and history — detecting the billing-leakage classes (done-not-closed,
   * no-time-logged, unfulfilled parts, unbilled time). Read-only. Resolve by
   * serviceCallId, or by ticketId (uses the first service call linked to it).
   */
  async reconcileServiceCall(opts: { serviceCallId?: number; ticketId?: number }): Promise<SCReconResult | null> {
    let serviceCallId = opts.serviceCallId;
    if (serviceCallId == null && opts.ticketId != null) {
      const links = await this.searchServiceCallTickets({ ticketId: opts.ticketId } as AutotaskQueryOptionsExtended);
      serviceCallId = links[0]?.serviceCallID;
    }
    if (serviceCallId == null) return null;
    const sc = await this.getServiceCall(serviceCallId);
    if (!sc) return null;
    return this.reconcileFetchedServiceCall(sc);
  }

  /** Shared fetch+reconcile for one already-loaded service call (used by the sweep). */
  private async reconcileFetchedServiceCall(sc: AutotaskServiceCall): Promise<SCReconResult | null> {
    const links = await this.searchServiceCallTickets({ serviceCallId: (sc as any).id } as AutotaskQueryOptionsExtended);
    const ticketId = links[0]?.ticketID;
    if (ticketId == null) return null;
    const [teRes, charges, history] = await Promise.all([
      this.searchTimeEntries({ ticketId, pageSize: 500 } as AutotaskQueryOptionsExtended).catch(() => ({ items: [] } as any)),
      this.searchTicketCharges({ ticketId, pageSize: 200 } as AutotaskQueryOptionsExtended & { ticketId?: number }).catch(() => []),
      this.searchTicketHistory({ ticketId, pageSize: 300 } as AutotaskQueryOptionsExtended & { ticketId?: number }).catch(() => []),
    ]);
    let ticketNumber: string | undefined;
    try { ticketNumber = ((await this.getTicket(ticketId)) as any)?.ticketNumber; } catch { /* best-effort */ }
    return reconcileServiceCallPure({
      serviceCall: {
        id: (sc as any).id,
        isComplete: (sc as any).isComplete,
        status: (sc as any).status,
        startDateTime: (sc as any).startDateTime,
        endDateTime: (sc as any).endDateTime,
      },
      ticketId,
      ...(ticketNumber !== undefined ? { ticketNumber } : {}),
      timeEntries: (teRes.items ?? []) as any[],
      charges: charges as any[],
      history: history as any[],
    });
  }

  /**
   * Weekly billing-leakage sweep: scan open, past-scheduled service calls in a
   * look-back window and reconcile each, returning only the ones with issues
   * plus a digest (counts per issue type, parts $ at risk, unbilled hours).
   * Read-only; bounded by `maxServiceCalls` so a scheduled run is predictable.
   */
  async reportServiceCallLeakage(opts: {
    lookbackDays?: number; companyID?: number; maxServiceCalls?: number; includeClean?: boolean; includeCompleted?: boolean;
  } = {}): Promise<{
    scanned: number; scannedOpen: number; scannedCompleted: number; flagged: number; window: { after: string; before: string };
    totals: { doneNotClosed: number; noTimeLogged: number; partsUnfulfilled: number; unbilledTime: number; atRiskPartsValue: number; unbilledHours: number };
    items: SCReconResult[];
    truncated: boolean;
  }> {
    const lookbackDays = opts.lookbackDays ?? 30;
    const maxServiceCalls = Math.min(opts.maxServiceCalls ?? 100, 500);
    const now = new Date();
    const after = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
    const before = now.toISOString().slice(0, 10);

    const search = await this.searchServiceCalls({
      startAfter: after, startBefore: before,
      ...(opts.companyID != null ? { companyID: opts.companyID } : {}),
      pageSize: maxServiceCalls,
    } as AutotaskQueryOptionsExtended);
    // Canceled calls are dead artifacts, never leakage — always excluded. OPEN
    // calls are the orphan-cascade / done-not-closed risk (prevention). COMPLETED
    // calls (default off) still carry ticket-level leakage — parts never pulled
    // from inventory, billable time never approved — that persists after close, so
    // includeCompleted turns the sweep into a recovery pass over closed work too.
    const includeCompleted = opts.includeCompleted === true;
    const isCompleted = (s: any) => s.isComplete === 1 || s.isComplete === true || s.status === 2;
    const candidatesAll = (search.items ?? []).filter((sc) => {
      const s = sc as any;
      if (s.status === 101 || s.status === 102) return false; // canceled
      return includeCompleted || !isCompleted(s);
    });
    const truncated = candidatesAll.length > maxServiceCalls;
    const candidates = candidatesAll.slice(0, maxServiceCalls);
    const scannedCompleted = candidates.filter((sc) => isCompleted(sc)).length;

    const results: SCReconResult[] = [];
    for (const sc of candidates) {
      const r = await this.reconcileFetchedServiceCall(sc).catch(() => null);
      if (r) results.push(r);
    }
    const flaggedItems = results.filter((r) => r.issues.length > 0);
    const totals = {
      doneNotClosed: flaggedItems.filter((r) => r.flags.doneNotClosed).length,
      noTimeLogged: flaggedItems.filter((r) => r.flags.noTimeLogged).length,
      partsUnfulfilled: flaggedItems.filter((r) => r.flags.unfulfilledParts.count > 0).length,
      unbilledTime: flaggedItems.filter((r) => r.flags.unbilledTime.count > 0).length,
      atRiskPartsValue: Math.round((flaggedItems.reduce((s, r) => s + r.atRiskPartsValue, 0) + Number.EPSILON) * 100) / 100,
      unbilledHours: Math.round((flaggedItems.reduce((s, r) => s + r.flags.unbilledTime.hours, 0) + Number.EPSILON) * 100) / 100,
    };
    return {
      scanned: candidates.length,
      scannedOpen: candidates.length - scannedCompleted,
      scannedCompleted,
      flagged: flaggedItems.length,
      window: { after, before },
      totals,
      items: opts.includeClean ? results : flaggedItems,
      truncated,
    };
  }

  async createServiceCall(data: Partial<AutotaskServiceCall>): Promise<number> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Creating service call:', data);
      const id = await http.create('ServiceCalls', data);
      this.logger.info(`Service call created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create service call:', error);
      throw error;
    }
  }

  async updateServiceCall(id: number, updates: Partial<AutotaskServiceCall>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating service call ${id}:`, updates);
      await http.update('ServiceCalls', id, updates as Record<string, any>);
      this.logger.info(`Service call ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update service call ${id}:`, error);
      throw error;
    }
  }

  async deleteServiceCall(id: number): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Deleting service call ${id}`);
      await http.delete('ServiceCalls', id);
      this.logger.info(`Service call ${id} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete service call ${id}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Service Call Tickets / Resources
  // =====================================================

  async searchServiceCallTickets(options: AutotaskQueryOptionsExtended = {}): Promise<AutotaskServiceCallTicket[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching service call tickets with options:', options);
      const filters: QueryFilter[] = [];
      if ((options as any).serviceCallId !== undefined) {
        filters.push({ op: 'eq', field: 'serviceCallID', value: (options as any).serviceCallId });
      }
      if ((options as any).ticketId !== undefined) {
        filters.push({ op: 'eq', field: 'ticketID', value: (options as any).ticketId });
      }
      const pageSize = Math.min(options.pageSize || 25, 200);
      const items = await http.query<AutotaskServiceCallTicket>(
        'ServiceCallTickets',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: pageSize }
      );
      this.logger.info(`Retrieved ${items.length} service call tickets`);
      return items;
    } catch (error) {
      this.logger.error('Failed to search service call tickets:', error);
      throw error;
    }
  }

  async createServiceCallTicket(data: Partial<AutotaskServiceCallTicket>): Promise<number> {
    const http = await this.ensureClient();
    // Root POST /ServiceCallTickets does not exist (brief §4.3). The link must
    // be created under the parent service call:
    // POST /ServiceCalls/{serviceCallID}/Tickets.
    const serviceCallID = (data as Record<string, any>).serviceCallID;
    if (serviceCallID === undefined || serviceCallID === null) {
      throw new Error(
        'Cannot link ticket to service call: serviceCallID is required (created via the ' +
        'ServiceCalls/{serviceCallID}/Tickets child route).'
      );
    }
    try {
      this.logger.debug('Creating service call ticket:', data);
      const id = await http.childCreate('ServiceCalls', serviceCallID, 'Tickets', data);
      this.logger.info(`Service call ticket created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create service call ticket:', error);
      throw error;
    }
  }

  async deleteServiceCallTicket(id: number): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Deleting service call ticket ${id}`);
      await http.delete('ServiceCallTickets', id);
      this.logger.info(`Service call ticket ${id} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete service call ticket ${id}:`, error);
      throw error;
    }
  }

  async searchServiceCallTicketResources(
    options: AutotaskQueryOptionsExtended = {}
  ): Promise<AutotaskServiceCallTicketResource[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching service call ticket resources with options:', options);
      const filters: QueryFilter[] = [];
      if ((options as any).serviceCallTicketId !== undefined) {
        filters.push({ op: 'eq', field: 'serviceCallTicketID', value: (options as any).serviceCallTicketId });
      }
      if ((options as any).resourceId !== undefined) {
        filters.push({ op: 'eq', field: 'resourceID', value: (options as any).resourceId });
      }
      const pageSize = Math.min(options.pageSize || 25, 200);
      const items = await http.query<AutotaskServiceCallTicketResource>(
        'ServiceCallTicketResources',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: pageSize }
      );
      this.logger.info(`Retrieved ${items.length} service call ticket resources`);
      return items;
    } catch (error) {
      this.logger.error('Failed to search service call ticket resources:', error);
      throw error;
    }
  }

  async createServiceCallTicketResource(data: Partial<AutotaskServiceCallTicketResource>): Promise<number> {
    const http = await this.ensureClient();
    // Root POST /ServiceCallTicketResources does not exist (brief §4.3). The
    // resource assignment must be created under the parent service-call ticket:
    // POST /ServiceCallTickets/{serviceCallTicketID}/Resources.
    const serviceCallTicketID = (data as Record<string, any>).serviceCallTicketID;
    if (serviceCallTicketID === undefined || serviceCallTicketID === null) {
      throw new Error(
        'Cannot assign resource to service call ticket: serviceCallTicketID is required ' +
        '(created via the ServiceCallTickets/{serviceCallTicketID}/Resources child route).'
      );
    }
    try {
      // The entity has exactly resourceID + serviceCallTicketID (live
      // entityInformation, 2026-09-30) — no roleID. Send only those; an unknown
      // field makes Autotask reject the whole create.
      const body = { resourceID: data.resourceID, serviceCallTicketID };
      this.logger.debug('Creating service call ticket resource:', body);
      const id = await http.childCreate('ServiceCallTickets', serviceCallTicketID, 'Resources', body);
      this.logger.info(`Service call ticket resource created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create service call ticket resource:', error);
      throw error;
    }
  }

  async deleteServiceCallTicketResource(id: number): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Deleting service call ticket resource ${id}`);
      await http.delete('ServiceCallTicketResources', id);
      this.logger.info(`Service call ticket resource ${id} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete service call ticket resource ${id}:`, error);
      throw error;
    }
  }

  // ---- Service calls on TASKS (parallel to the ticket side) ---------------
  // Lets a service call attach to a PROJECT TASK so scheduled work (e.g. a
  // recurring meeting task) carries its resources onto the Autotask calendar —
  // no scheduling-ticket workaround needed.

  async searchServiceCallTasks(options: AutotaskQueryOptionsExtended = {}): Promise<AutotaskServiceCallTask[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching service call tasks with options:', options);
      const filters: QueryFilter[] = [];
      if ((options as any).serviceCallId !== undefined) {
        filters.push({ op: 'eq', field: 'serviceCallID', value: (options as any).serviceCallId });
      }
      if ((options as any).taskId !== undefined) {
        filters.push({ op: 'eq', field: 'taskID', value: (options as any).taskId });
      }
      const pageSize = Math.min(options.pageSize || 25, 200);
      const items = await http.query<AutotaskServiceCallTask>(
        'ServiceCallTasks',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: pageSize }
      );
      this.logger.info(`Retrieved ${items.length} service call tasks`);
      return items;
    } catch (error) {
      this.logger.error('Failed to search service call tasks:', error);
      throw error;
    }
  }

  async createServiceCallTask(data: Partial<AutotaskServiceCallTask>): Promise<number> {
    const http = await this.ensureClient();
    // Root POST /ServiceCallTasks does not exist. The link is created under the
    // parent service call: POST /ServiceCalls/{serviceCallID}/Tasks.
    const serviceCallID = (data as Record<string, any>).serviceCallID;
    if (serviceCallID === undefined || serviceCallID === null) {
      throw new Error(
        'Cannot link task to service call: serviceCallID is required (created via the ' +
        'ServiceCalls/{serviceCallID}/Tasks child route).'
      );
    }
    try {
      this.logger.debug('Creating service call task:', data);
      const id = await http.childCreate('ServiceCalls', serviceCallID, 'Tasks', data);
      this.logger.info(`Service call task created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create service call task:', error);
      throw error;
    }
  }

  async deleteServiceCallTask(id: number): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Deleting service call task ${id}`);
      await http.delete('ServiceCallTasks', id);
      this.logger.info(`Service call task ${id} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete service call task ${id}:`, error);
      throw error;
    }
  }

  async searchServiceCallTaskResources(
    options: AutotaskQueryOptionsExtended = {}
  ): Promise<AutotaskServiceCallTaskResource[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug('Searching service call task resources with options:', options);
      const filters: QueryFilter[] = [];
      if ((options as any).serviceCallTaskId !== undefined) {
        filters.push({ op: 'eq', field: 'serviceCallTaskID', value: (options as any).serviceCallTaskId });
      }
      if ((options as any).resourceId !== undefined) {
        filters.push({ op: 'eq', field: 'resourceID', value: (options as any).resourceId });
      }
      const pageSize = Math.min(options.pageSize || 25, 200);
      const items = await http.query<AutotaskServiceCallTaskResource>(
        'ServiceCallTaskResources',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: pageSize }
      );
      this.logger.info(`Retrieved ${items.length} service call task resources`);
      return items;
    } catch (error) {
      this.logger.error('Failed to search service call task resources:', error);
      throw error;
    }
  }

  async createServiceCallTaskResource(data: Partial<AutotaskServiceCallTaskResource>): Promise<number> {
    const http = await this.ensureClient();
    // Root POST /ServiceCallTaskResources does not exist. Created under the parent
    // service-call task: POST /ServiceCallTasks/{serviceCallTaskID}/Resources.
    const serviceCallTaskID = (data as Record<string, any>).serviceCallTaskID;
    if (serviceCallTaskID === undefined || serviceCallTaskID === null) {
      throw new Error(
        'Cannot assign resource to service call task: serviceCallTaskID is required ' +
        '(created via the ServiceCallTasks/{serviceCallTaskID}/Resources child route).'
      );
    }
    try {
      // Exactly resourceID + serviceCallTaskID (no roleID) — see the ticket variant.
      const body = { resourceID: data.resourceID, serviceCallTaskID };
      this.logger.debug('Creating service call task resource:', body);
      const id = await http.childCreate('ServiceCallTasks', serviceCallTaskID, 'Resources', body);
      this.logger.info(`Service call task resource created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create service call task resource:', error);
      throw error;
    }
  }

  async deleteServiceCallTaskResource(id: number): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Deleting service call task resource ${id}`);
      await http.delete('ServiceCallTaskResources', id);
      this.logger.info(`Service call task resource ${id} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete service call task resource ${id}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Company To-Dos (CRM calendar follow-ups) — brief §4.1
  // Writes go through the company child route; root CompanyToDos rejects
  // create/update in the GDS zone. completedDate == null means open.
  // =====================================================

  /** Fetch the CompanyToDos.actionType picklist ([{value,label}]) from live metadata. */
  private async getCompanyToDoActionTypes(): Promise<Array<{ value: string | number; label: string }>> {
    const http = await this.ensureClient();
    return http.picklistValues('CompanyToDos', 'actionType');
  }

  async getCompanyToDo(id: number): Promise<AutotaskCompanyToDo | null> {
    const http = await this.ensureClient();
    try {
      return await http.get<AutotaskCompanyToDo>('CompanyToDos', id);
    } catch (error) {
      this.logger.error(`Failed to get Company To-Do ${id}:`, error);
      throw error;
    }
  }

  async searchCompanyToDos(
    options: AutotaskQueryOptionsExtended & {
      companyID?: number;
      assignedToResourceID?: number;
      ticketID?: number;
      contactID?: number;
      opportunityID?: number;
      contractID?: number;
      openOnly?: boolean;
    } = {}
  ): Promise<AutotaskCompanyToDo[]> {
    const http = await this.ensureClient();
    try {
      const filters: QueryFilter[] = [];
      pushEq(filters, 'companyID', options.companyID);
      pushEq(filters, 'assignedToResourceID', options.assignedToResourceID);
      pushEq(filters, 'ticketID', options.ticketID);
      pushEq(filters, 'contactID', options.contactID);
      pushEq(filters, 'opportunityID', options.opportunityID);
      pushEq(filters, 'contractID', options.contractID);
      // Open == not yet completed. Autotask has no isComplete field on this
      // entity, so "open" is completedDate IS NULL.
      if (options.openOnly === true) {
        filters.push({ op: 'eq', field: 'completedDate', value: null });
      }
      const pageSize = Math.min(options.pageSize || 25, 200);
      const items = await http.query<AutotaskCompanyToDo>(
        'CompanyToDos',
        filters.length > 0 ? filters : MATCH_ALL,
        { maxRecords: pageSize }
      );
      this.logger.info(`Retrieved ${items.length} Company To-Dos`);
      return items;
    } catch (error) {
      this.logger.error('Failed to search Company To-Dos:', error);
      throw error;
    }
  }

  async createCompanyToDo(
    todo: Partial<AutotaskCompanyToDo> & { actionTypeName?: string }
  ): Promise<number> {
    const http = await this.ensureClient();
    const companyID = todo.companyID;
    if (companyID == null) throw new Error('companyID is required to create a Company To-Do.');
    if (todo.assignedToResourceID == null) throw new Error('assignedToResourceID is required to create a Company To-Do.');
    if (!todo.startDateTime || !todo.endDateTime) {
      throw new Error('startDateTime and endDateTime are required to create a Company To-Do.');
    }

    // Resolve actionType: use a numeric actionType as-is, otherwise resolve the
    // name (or the documented General default) from live picklist metadata.
    let actionType = todo.actionType;
    if (actionType == null || todo.actionTypeName) {
      const picklist = await this.getCompanyToDoActionTypes();
      actionType = resolveActionType(
        { actionType: todo.actionType, actionTypeName: todo.actionTypeName },
        picklist
      );
    }

    const { actionTypeName: _drop, ...rest } = todo;
    const payload = { ...rest, actionType };
    try {
      const id = await http.childCreate('Companies', companyID, 'ToDos', payload);
      this.logger.info(`Company To-Do created with ID: ${id}`);
      return id;
    } catch (error) {
      this.logger.error('Failed to create Company To-Do:', error);
      throw error;
    }
  }

  /** Resolve the parent companyID for a To-Do write, reading the record if needed. */
  private async resolveTodoCompanyID(id: number, companyID?: number): Promise<number> {
    if (companyID != null) return companyID;
    const existing = await this.getCompanyToDo(id);
    const cid = existing?.companyID;
    if (cid == null) {
      throw new Error(
        `Company To-Do ${id}: unable to resolve parent companyID for the ` +
        `Companies/{companyID}/ToDos child route (does the To-Do still exist?).`
      );
    }
    return cid;
  }

  async updateCompanyToDo(
    id: number,
    updates: Partial<AutotaskCompanyToDo> & { actionTypeName?: string },
    companyID?: number
  ): Promise<void> {
    const http = await this.ensureClient();
    const cid = await this.resolveTodoCompanyID(id, companyID ?? updates.companyID);
    const { actionTypeName, ...rest } = updates;
    const body: Record<string, any> = { ...rest };
    if (actionTypeName) {
      const picklist = await this.getCompanyToDoActionTypes();
      body.actionType = resolveActionType({ actionType: updates.actionType, actionTypeName }, picklist);
    }
    try {
      await http.childUpdate('Companies', cid, 'ToDos', id, body);
      this.logger.info(`Company To-Do ${id} updated`);
    } catch (error) {
      this.logger.error(`Failed to update Company To-Do ${id}:`, error);
      throw error;
    }
  }

  /** Complete a To-Do by setting completedDate (there is no isComplete field). */
  async completeCompanyToDo(id: number, companyID?: number): Promise<string> {
    const http = await this.ensureClient();
    const cid = await this.resolveTodoCompanyID(id, companyID);
    const completedDate = new Date().toISOString();
    try {
      await http.childUpdate('Companies', cid, 'ToDos', id, { completedDate });
      this.logger.info(`Company To-Do ${id} completed at ${completedDate}`);
      return completedDate;
    } catch (error) {
      this.logger.error(`Failed to complete Company To-Do ${id}:`, error);
      throw error;
    }
  }

  async deleteCompanyToDo(id: number, companyID?: number): Promise<void> {
    const http = await this.ensureClient();
    const cid = await this.resolveTodoCompanyID(id, companyID);
    try {
      // NEEDS VERIFICATION: delete via the company child route for consistency
      // with create/update (root CompanyToDos rejects writes in the GDS zone).
      await http.childDelete('Companies', cid, 'ToDos', id);
      this.logger.info(`Company To-Do ${id} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete Company To-Do ${id}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Billing Codes / Departments (read-only helpers)
  // =====================================================

  async getBillingCode(id: number): Promise<AutotaskBillingCode | null> {
    const http = await this.ensureClient();
    try {
      return await http.get<AutotaskBillingCode>('BillingCodes', id);
    } catch (error) {
      this.logger.error(`Failed to get billing code ${id}:`, error);
      throw error;
    }
  }

  // Per-instance memo of work-type attributes (useType / billingCodeType / name)
  // so the ticket-billing-gaps sweep resolves each billingCodeID at most once.
  private billingCodeAttrCache = new Map<number, { useType?: number; billingCodeType?: number; name?: string }>();
  private async resolveBillingCodeAttrs(id: number): Promise<{ useType?: number; billingCodeType?: number; name?: string }> {
    const hit = this.billingCodeAttrCache.get(id);
    if (hit) return hit;
    const bc = (await this.getBillingCode(id).catch(() => null)) as Record<string, any> | null;
    const attrs = bc ? { useType: bc.useType, billingCodeType: bc.billingCodeType, name: bc.name } : {};
    this.billingCodeAttrCache.set(id, attrs);
    return attrs;
  }

  /**
   * Ticket-anchored billing-completeness analysis (read-only, for review): does a
   * ticket show work that wasn't captured/billed? Fetches the ticket's time
   * entries, tech reply notes and contract, resolves each entry's work type, and
   * flags work-not-logged / note-without-time / billable-marked-non-billable.
   */
  async analyzeTicketBillingGaps(ticketId: number): Promise<TBGResult | null> {
    const ticket = (await this.getTicket(ticketId)) as Record<string, any> | null;
    if (!ticket) return null;
    const [teRes, notes] = await Promise.all([
      this.searchTimeEntries({ ticketId, pageSize: 500 } as AutotaskQueryOptionsExtended).catch(() => ({ items: [] } as any)),
      this.searchTicketNotes(ticketId).catch(() => [] as any[]),
    ]);
    let contractType: number | null = null;
    if (ticket.contractID != null) {
      const c = (await this.getContract(ticket.contractID).catch(() => null)) as Record<string, any> | null;
      contractType = c?.contractType ?? null;
    }
    // Resolve work-type attributes for the entries' billing codes (cached).
    const entries: TBGTimeEntry[] = [];
    for (const e of (teRes.items ?? []) as Record<string, any>[]) {
      const attrs = e.billingCodeID != null ? await this.resolveBillingCodeAttrs(e.billingCodeID) : {};
      entries.push({
        resourceID: e.resourceID, dateWorked: e.dateWorked, hoursWorked: e.hoursWorked,
        hoursToBill: e.hoursToBill, isNonBillable: e.isNonBillable,
        workTypeUseType: attrs.useType, workTypeBillingCodeType: attrs.billingCodeType, workTypeName: attrs.name,
      });
    }
    return analyzeTicketBillingGapsPure({
      ticket: {
        id: ticketId, ticketNumber: ticket.ticketNumber, status: ticket.status,
        completedDate: ticket.completedDate ?? null, contractType,
      },
      timeEntries: entries,
      notes: (notes ?? []) as any[],
    });
  }

  /**
   * Weekly ticket billing-gaps sweep (read-only, for review): scans tickets
   * active in a look-back window — OPEN and, unless excluded, COMPLETED — and
   * returns the ones with gaps plus a digest. Bounded by maxTickets for a
   * predictable scheduled run. This is a review report; the human decides.
   */
  async reportTicketBillingGaps(opts: {
    lookbackDays?: number; companyID?: number; maxTickets?: number; includeCompleted?: boolean; includeClean?: boolean;
  } = {}): Promise<{
    scanned: number; flagged: number; window: { after: string };
    totals: { workNotLogged: number; noteWithoutTime: number; billableMarkedNonbillable: number; suspectNonbillableHours: number; uncapturedNotes: number };
    items: TBGResult[]; truncated: boolean;
  }> {
    const lookbackDays = opts.lookbackDays ?? 14;
    const maxTickets = Math.min(opts.maxTickets ?? 100, 500);
    const after = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
    const includeCompleted = opts.includeCompleted !== false; // default TRUE — "all tickets"
    const scope = { lastActivityAfter: after, ...(opts.companyID != null ? { companyID: opts.companyID } : {}) } as AutotaskQueryOptionsExtended;

    // Open tickets (searchTickets excludes status 5 by default) + completed ones
    // (status 5) so a closed ticket with uncaptured work is still reviewed.
    const openRes = await this.searchTickets({ ...scope, pageSize: maxTickets });
    const completedRes = includeCompleted
      ? await this.searchTickets({ ...scope, status: COMPLETE_TICKET_STATUS, pageSize: maxTickets })
      : ({ items: [] } as any);
    const byId = new Map<number, Record<string, any>>();
    for (const t of [...(openRes.items ?? []), ...(completedRes.items ?? [])] as Record<string, any>[]) {
      if (t.id != null) byId.set(t.id, t);
    }
    const all = [...byId.values()];
    const truncated = all.length > maxTickets;
    const candidates = all.slice(0, maxTickets);

    const results: TBGResult[] = [];
    for (const t of candidates) {
      const r = await this.analyzeTicketBillingGaps(t.id).catch(() => null);
      if (r) results.push(r);
    }
    const flaggedItems = results.filter((r) => r.issues.length > 0);
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const totals = {
      workNotLogged: flaggedItems.filter((r) => r.flags.workNotLogged).length,
      noteWithoutTime: flaggedItems.filter((r) => r.flags.notesWithoutTime.count > 0).length,
      billableMarkedNonbillable: flaggedItems.filter((r) => r.flags.nonbillableSuspect.count > 0).length,
      suspectNonbillableHours: round2(flaggedItems.reduce((s, r) => s + r.flags.nonbillableSuspect.hours, 0)),
      uncapturedNotes: flaggedItems.reduce((s, r) => s + r.flags.notesWithoutTime.count, 0),
    };
    return {
      scanned: candidates.length,
      flagged: flaggedItems.length,
      window: { after },
      totals,
      items: opts.includeClean ? results : flaggedItems,
      truncated,
    };
  }

  async searchBillingCodes(_options: AutotaskQueryOptionsExtended = {}): Promise<AutotaskBillingCode[]> {
    const http = await this.ensureClient();
    try {
      return await http.query<AutotaskBillingCode>(
        'BillingCodes',
        [{ op: 'eq', field: 'isActive', value: true }],
        { maxRecords: 500 }
      );
    } catch (error) {
      this.logger.error('Failed to search billing codes:', error);
      throw error;
    }
  }

  async getDepartment(_id: number): Promise<AutotaskDepartment | null> {
    throw new Error('Departments API not directly available in Autotask REST');
  }

  async searchDepartments(_options: AutotaskQueryOptionsExtended = {}): Promise<AutotaskDepartment[]> {
    throw new Error('Departments API not directly available in Autotask REST');
  }

  // =====================================================
  // Field info / picklists
  // =====================================================

  async getFieldInfo(entityType: string): Promise<FieldInfo[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting field info for entity: ${entityType}`);
      const { fields: rawFields } = await http.fieldInfo(entityType);
      return rawFields.map((field: any): FieldInfo => ({
        name: field.name,
        dataType: field.dataType,
        length: field.length,
        isRequired: field.isRequired || false,
        isReadOnly: field.isReadOnly || false,
        isQueryable: field.isQueryable || false,
        isReference: field.isReference || false,
        referenceEntityType: field.referenceEntityType,
        isPickList: field.isPickList || false,
        picklistValues: field.picklistValues?.map((pv: any): PicklistValue => {
          const out: PicklistValue = {
            value: String(pv.value),
            label: pv.label || pv.name || String(pv.value),
            isDefaultValue: pv.isDefaultValue || false,
            sortOrder: pv.sortOrder,
            isActive: pv.isActive !== false,
            isSystem: pv.isSystem || false,
          };
          if (pv.parentValue) out.parentValue = String(pv.parentValue);
          return out;
        }),
        picklistParentValueField: field.picklistParentValueField,
      }));
    } catch (error) {
      this.logger.error(`Failed to get field info for ${entityType}:`, error);
      throw error;
    }
  }

  /**
   * Resolve a picklist label to its tenant value (§4.4 — never hard-code IDs).
   * Returns a structured outcome: matched / ambiguous / not-found (with
   * suggestions + the full active value list) / field-not-found / not-a-picklist.
   * Case-insensitive; active values only.
   */
  async resolvePicklistValue(entity: string, field: string, label: string): Promise<Record<string, any>> {
    const fi = await this.getFieldInfo(entity);
    const f = fi.find((x) => x.name === field);
    if (!f) return { status: 'field-not-found', entity, field };
    const values = (f.picklistValues ?? []).filter((v) => v.isActive !== false);
    if (!values.length) return { status: 'not-a-picklist', entity, field };
    const norm = String(label).trim().toLowerCase();
    const brief = (v: PicklistValue) => ({ value: v.value, label: v.label });
    const exact = values.filter((v) => String(v.label).toLowerCase() === norm);
    if (exact.length === 1) return { status: 'matched', value: exact[0].value, label: exact[0].label };
    if (exact.length > 1) return { status: 'ambiguous', candidates: exact.map(brief) };
    const suggestions = values.filter((v) => String(v.label).toLowerCase().includes(norm)).map(brief);
    return { status: 'not-found', field, entity, suggestions: suggestions.slice(0, 10), values: values.map(brief) };
  }

  // =====================================================
  // Company Site Configurations
  // =====================================================

  async getCompanySiteConfigurations(companyId: number): Promise<any[]> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Getting company site configurations for company ID: ${companyId}`);
      return await http.query<any>(
        'CompanySiteConfigurations',
        [{ op: 'eq', field: 'companyID', value: companyId }],
        { maxRecords: 100 }
      );
    } catch (error) {
      this.logger.error(`Failed to get company site configurations for company ${companyId}:`, error);
      throw error;
    }
  }

  async updateCompanySiteConfiguration(id: number, updates: Record<string, any>): Promise<void> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Updating company site configuration ${id}:`, updates);
      await http.update('CompanySiteConfigurations', id, updates);
      this.logger.info(`Company site configuration ${id} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update company site configuration ${id}:`, error);
      throw error;
    }
  }

  // =====================================================
  // Raw REST passthrough (escape hatch)
  // =====================================================

  async rawRequest<T = any>(
    method: string,
    path: string,
    body?: any,
    queryParams?: Record<string, string | number | boolean>
  ): Promise<T> {
    const http = await this.ensureClient();
    try {
      this.logger.debug(`Raw Autotask request ${method} ${path}`, { hasBody: body !== undefined, queryParams });
      return await http.rawRequest<T>(method, path, body, queryParams);
    } catch (error) {
      this.logger.error(`Raw Autotask request ${method} ${path} failed:`, error);
      throw error;
    }
  }
}

// resolveAutotaskApiUrl kept referenced to avoid unused-import warnings
// for tooling that may not see usage inside AutotaskHttpClient (it's used
// there). This re-export is harmless.
export { resolveAutotaskApiUrl };
