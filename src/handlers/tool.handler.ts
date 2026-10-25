import { Server } from "@modelcontextprotocol/server";

// Autotask Tool Handler
// Handles MCP tool calls for Autotask operations (search, create, update)
import { AutotaskService } from '../services/autotask.service.js';
import { AutotaskRateLimitError } from '../services/autotask-http.js';
import { PicklistCache, PicklistValue } from '../services/picklist.cache.js';
import { Logger } from '../utils/logger.js';
import { formatCompactResponse, detectEntityType, COMPACT_SEARCH_TOOLS, PageMeta } from '../utils/response.formatter.js';
import { PagedResult } from '../types/autotask.js';
import { MappingService } from '../utils/mapping.service.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { normalizeCreateToolResult, CREATE_TOOL_META, NormalizedCreateResult } from '../utils/create-result.js';
import { classifyLockError, lockReason } from '../utils/timesheet-lock.js';
import { RoleSource, needsRoleSelectionMessage, invalidRoleMessage } from '../utils/time-entry-role.js';
import { partitionTicketNotes } from '../utils/ticket-note-kind.js';
import { defaultWorkDate, formatChoices, localDayWindow, matchPicklist, matchPicklistExact, TimeGap } from '../utils/staff-tools.js';
import { getShadowRuntime } from '../db/shadow-runtime.js';
import { collectAuditEvents, type CollectOptions } from '../db/audit-collector.js';
import { BACKFILL_SOURCES, BackfillJobs, MAX_RANGE_DAYS, runBackfillStep, type BackfillSource } from '../db/history-backfill.js';
import { backpressure } from '../services/backpressure.js';
import { FEED_SOURCES, SOURCE_ENTITY, decodeCursor, encodeCursor, eventType, feedActor, ingestActivity, type FeedSource } from '../db/activity-feed.js';
import { buildDailyAudit } from '../utils/daily-audit.js';
import { SHADOW_ENTITIES, shadowEntity } from '../db/shadow-entities.js';

const SHADOW_OFF = 'The Postgres shadow is not enabled on this server (MCP_PG_ENABLED + MCP_PG_SHADOW_ENABLED). Live Autotask tools still work.';
import { classifyTimeEntryWriteError } from '../utils/time-entry-errors.js';

// Destructive tools that DEFAULT to dry-run when `dryRun` is omitted — so the
// confirm gate treats an omitted dryRun as a dry-run (plan only, no confirm),
// and only requires confirm:true on the actual execution (dryRun:false).
/** Tested n8n receiver (signature check) for webhooks this MCP creates. */
const N8N_RECEIVER_GUIDE = 'https://github.com/GDSTechnology/psarelay/blob/main/docs/N8N_WEBHOOKS.md';

const DRY_RUN_FIRST_TOOLS = new Set<string>([
  'autotask_delete_time_entry',
  'autotask_delete_task',
  'autotask_delete_task_with_time',
  'autotask_set_ticket_contract',
]);
import { applyBillingTreatment } from '../utils/billing-treatment.js';
import { defaultTimeZone, durationHours, normalizeTimestamp, validTimeZone } from '../utils/timezone.js';
import { calculateProjectSchedule } from '../utils/project-schedule.js';
import { generateProjectLaborPlan } from '../utils/project-labor-plan.js';
import { generateSlaFramework } from '../utils/sla-framework.js';
import { extractProjectScope } from '../utils/project-scope.js';
import { computeBomLabor } from '../utils/bom-labor.js';
import { classifyProject } from '../utils/project-classification.js';
import { WEBHOOK_ENTITIES } from '../utils/webhook-entities.js';
import { extractCallerContext, stripCallerContext, CallerContext } from '../types/context.js';
import { emitAudit, AuditEntry } from '../utils/audit.js';
import { AuditSink, createAuditSink } from '../db/audit-sink.js';
import {
  RiskLevel,
  classifyRisk,
  requiresExplicitConfirmation,
  buildConfirmationRequired,
} from '../utils/risk.js';
import { InMemoryIdempotencyStore, deriveIdempotencyKey, isMutatingTool } from '../utils/idempotency.js';
import { randomUUID } from 'node:crypto';
import { runInOperation, type OperationScope } from '../utils/operation-context.js';
import { argsDigest, mayWrite, operationClaimResult, operationSummary, withOperation } from '../utils/operations.js';
import { OperationStore, type ClaimResult, type OperationInput } from '../db/operation-store.js';
import { getPool } from '../db/pool.js';
import { notify } from '../services/notifier.js';
import { vendorToolHandlers } from '../vendors/tools.js';
import { catalogToolHandlers } from '../vendors/catalog-tools.js';
import { reconToolHandlers } from '../vendors/recon-tools.js';
import { rawCompanyWriteProblem } from '../utils/company-guard.js';
import { processToolHandlers } from '../vendors/process-tools.js';
import { mergeToolHandlers } from '../merge/tools.js';
import { bulkToolHandlers } from '../bulk/tools.js';
import { commerceToolHandlers } from '../commerce/tools.js';
import { setupToolHandlers } from '../setup/tools.js';
import { captureGap, gapToolHandlers } from '../gaps/tools.js';
import { pax8ToolHandlers } from '../vendors/pax8-tools.js';
import { contractToolHandlers } from '../vendors/contract-tools.js';
import {
  FunctionalRole,
  parseRoleMap,
  resolveRole,
  evaluatePermission,
  buildPermissionDenied,
  isPermissionsEnabled,
} from '../utils/permissions.js';
import { evaluateRawRequest, buildRawRequestDenied } from '../utils/raw-gate.js';
import {
  CallerResolution,
  ResolvedResource,
  parseUserMap,
  callerMapKeys,
  resourceDisplayName,
  classifyEmailMatch,
  identificationRequired,
  ACTING_RESOURCE_TOOLS,
  ACTING_ROLE_FIELDS,
  CURRENT_USER_DEFAULT_TOOLS,
} from '../utils/caller-resolution.js';
import { TrustedActing } from '../utils/impersonation.js';
import {
  runWithRequestContext,
  getImpersonationMode,
  getRequestOrigin,
  isImpersonationAllowedForSource,
} from '../utils/request-context.js';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from './tool.definitions.js';
import { toolAllowed, toolBlockReason } from '../admin/tool-gate.js';
import { runToolCall, noteToolAudit, noteRawRequest } from '../services/call-log.js';
import { buildTicketCard } from './card.builder.js';

// Default concurrency for company/resource name enrichment. Autotask allows
// only a handful of concurrent API threads per integration, so enrichment is
// fanned out in small batches rather than all at once (see enhanceItems).
const DEFAULT_ENHANCE_CONCURRENCY = 3;

function resolveEnhanceConcurrency(raw: string | undefined): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_ENHANCE_CONCURRENCY;
}

// Fields accepted by autotask_create_ticket / autotask_update_ticket.
// Keep this list in sync with the tool definitions in tool.definitions.ts.
const TICKET_WRITABLE_FIELDS = [
  'companyID',
  'title',
  'description',
  'status',
  'priority',
  'assignedResourceID',
  // Autotask requires the primary resource and its role together — omitting
  // assignedResourceRoleID from this allowlist silently dropped the role from
  // the typed payload, so assignment updates failed while a raw PATCH carrying
  // both fields succeeded (brief §4.4).
  'assignedResourceRoleID',
  'contactID',
  'queueID',
  'ticketCategory',
  'ticketType',
  'issueType',
  'subIssueType',
  'source',
  'billingCodeID',
  'serviceLevelAgreementID',
  'estimatedHours',
  'projectID',
  'ticketAdditionalContacts',
  'resolution',
  'userDefinedFields',
  // §4.5: complete a ticket in one create call (a 2nd update retriggers
  // "Created, Edited" workflow rules). companyLocationID pairs with companyID.
  'dueDateTime',
  'companyLocationID',
  'configurationItemID',
  // §7: contract/service linkage + idempotency + problem-ticket grouping. All
  // verified writable on the live Tickets schema.
  'contractID',
  'contractServiceID',
  'contractServiceBundleID',
  'externalID',
  'problemTicketId',
  'purchaseOrderNumber',
  'opportunityID'
] as const;

/** Tickets picklist fields update_ticket resolves by label or id (verified on the live schema). */
const TICKET_PICKLIST_FIELDS = new Set(['status', 'priority', 'queueID', 'issueType', 'subIssueType', 'source', 'ticketType', 'ticketCategory', 'serviceLevelAgreementID']);

function buildTicketPayload(args: Record<string, any>): Record<string, any> {
  const payload: Record<string, any> = {};
  for (const field of TICKET_WRITABLE_FIELDS) {
    if (args[field] !== undefined) {
      payload[field] = args[field];
    }
  }
  return payload;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    // Literal 'object' (not string): the v2 SDK's tools/list result type
    // requires the JSON Schema type discriminant as a literal.
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** MCP Apps (SEP-1865) metadata, e.g. `ui/resourceUri` linking a ui:// card. */
  _meta?: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

export class AutotaskToolHandler {
  protected autotaskService: AutotaskService;
  protected logger: Logger;
  protected picklistCache: PicklistCache;
  protected mcpServer: Server | null = null;
  private mappingService: MappingService | null = null;
  private lazyLoading: boolean;
  private enhanceConcurrency: number;
  // Caller→resource mapping (§4.1): a static override map for non-email identities
  // and an in-memory cache of resolutions so a caller is only prompted once.
  private userMap = parseUserMap(process.env.AUTOTASK_USER_MAP);
  private resourceCache = new Map<string, ResolvedResource>();
  // Per-tool risk level (§4.3), derived once from the tool annotations + the
  // financial/inventory registries. Drives the confirmation gate in callTool.
  private toolRisk = new Map<string, RiskLevel>(
    TOOL_DEFINITIONS.map((d) => [d.name, classifyRisk(d.name, d.annotations)])
  );
  // Idempotency store (§4.4): replays the prior result for a repeated mutation.
  private idempotencyStore = new InMemoryIdempotencyStore<McpToolResult>();
  // Optional PG audit sink (§23): persists audit records when MCP_PG_AUDIT_ENABLED.
  // Null when disabled — the structured log is always emitted regardless.
  // Assigned in the constructor (needs this.logger).
  private auditSink: AuditSink | null = null;
  // Operation log (MCP-007); null without Postgres, or once its table is found missing.
  private operations: OperationStore | null = null;
  // Caller → functional role (§4.2), for the permission gate. Config-driven for
  // now; disabled unless MCP_PERMISSIONS_ENABLED=true.
  private roleMap = parseRoleMap(process.env.AUTOTASK_ROLE_MAP);

  constructor(autotaskService: AutotaskService, logger: Logger, lazyLoading = false) {
    this.autotaskService = autotaskService;
    this.logger = logger;
    this.lazyLoading = lazyLoading;
    this.auditSink = createAuditSink(logger);
    // Operation log + durable idempotency (MCP-007) whenever Postgres is configured.
    const opPool = getPool(logger);
    if (opPool) {
      this.operations = new OperationStore(opPool);
      const purge = () => { this.operations?.purge(90).catch(() => undefined); };
      setTimeout(purge, 60_000).unref?.();
      setInterval(purge, 24 * 3_600_000).unref?.();
    }
    this.enhanceConcurrency = resolveEnhanceConcurrency(process.env.AUTOTASK_ENHANCE_CONCURRENCY);
    this.picklistCache = new PicklistCache(
      logger,
      (entityType) => this.autotaskService.getFieldInfo(entityType)
    );
  }

  private async getMappingService(): Promise<MappingService> {
    if (!this.mappingService) {
      // Per-toolHandler MappingService instance. In gateway mode this
      // toolHandler is created per-request (see McpServer.buildPerRequestHandlers),
      // so each tenant gets a MappingService bound to its own AutotaskService —
      // company/resource caches cannot leak across tenants. The tenantKey
      // lets same-tenant instances share warmed cache DATA across requests
      // (keyed by credential, so isolation still holds) — without it, every
      // request re-walked the tenant's full company list, stalling responses
      // past the gateway timeout on large tenants.
      this.mappingService = await MappingService.create(this.autotaskService, this.logger, {
        lazyLoading: this.lazyLoading,
        tenantKey: this.autotaskService.getTenantKey() ?? undefined,
      });
    }
    return this.mappingService;
  }

  /**
   * Enhance items by inlining company/resource names from IDs
   */
  private async enhanceItems(items: any[]): Promise<any[]> {
    try {
      const mappingService = await this.getMappingService();
      // One batched lookup for every company in the result, up front — the
      // per-row getCompanyName calls below are then cache hits.
      await mappingService.primeCompanies(items.map((i) => i?.companyID));
      // Bound the fan-out: one item may trigger up to a few Autotask API
      // calls (company + resource names), and Autotask 429s past its
      // concurrent-thread limit. mapWithConcurrency keeps us under it so
      // every row's names resolve instead of most of them being dropped.
      const enhanced = await mapWithConcurrency(
        items,
        this.enhanceConcurrency,
        async (item) => {
          const result = { ...item };
          if (item.companyID != null && typeof item.companyID === 'number') {
            try {
              const name = await mappingService.getCompanyName(item.companyID);
              if (name) result.company = name;
            } catch { /* skip */ }
          }
          if (item.assignedResourceID != null && typeof item.assignedResourceID === 'number') {
            try {
              const name = await mappingService.getResourceName(item.assignedResourceID);
              if (name) result.assignedTo = name;
            } catch { /* skip */ }
          }
          if (item.projectLeadResourceID != null && typeof item.projectLeadResourceID === 'number') {
            try {
              const name = await mappingService.getResourceName(item.projectLeadResourceID);
              if (name) result.lead = name;
            } catch { /* skip */ }
          }
          return result;
        }
      );
      return enhanced
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
        .map(r => r.value);
    } catch (error) {
      this.logger.debug('Enhancement failed, returning original items:', error);
      return items;
    }
  }

  /**
   * Set the MCP server reference for elicitation support
   */
  setServer(server: Server): void {
    this.mcpServer = server;
  }

  /**
   * Trusted acting identity from a gateway header (#42). Set ONLY on a
   * per-request, gateway-mode handler after the S2S gate — never on the shared
   * env-mode handler — so it can't leak across requests.
   */
  private trustedActing: TrustedActing | undefined;
  setTrustedActingContext(acting: TrustedActing | undefined): void {
    this.trustedActing = acting;
  }

  /**
   * Elicit user input for a selection from picklist values.
   * Falls back to returning null if elicitation is not supported by the client.
   */
  protected async elicitSelection(
    message: string,
    fieldName: string,
    options: PicklistValue[]
  ): Promise<string | null> {
    if (!this.mcpServer) return null;

    try {
      const result = await this.mcpServer.elicitInput({
        message,
        requestedSchema: {
          type: 'object' as const,
          properties: {
            [fieldName]: {
              type: 'string' as const,
              title: fieldName,
              description: `Select a ${fieldName}`,
              enum: options.map(o => o.value),
              enumNames: options.map(o => o.label),
            }
          },
          required: [fieldName],
        }
      });

      if (result.action === 'accept' && result.content) {
        return result.content[fieldName] as string;
      }
      return null;
    } catch (error) {
      // Client likely doesn't support elicitation — not an error
      this.logger.debug(`Elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Elicit a date range filter when no filters are provided for ticket search.
   * Returns date filter params or null if elicitation is not available/dismissed.
   * Times out after 5 seconds to avoid blocking in non-interactive environments.
   */
  protected async elicitDateRange(): Promise<Record<string, string> | null> {
    if (!this.mcpServer) return null;

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('elicitation timeout')), 5000)
      );
      const result = await Promise.race([this.mcpServer.elicitInput({
        message: 'No filters specified. What date range would you like to search?',
        requestedSchema: {
          type: 'object' as const,
          properties: {
            dateRange: {
              type: 'string' as const,
              title: 'Date Range',
              description: 'How far back to search',
              enum: ['today', 'past_week', 'past_month', 'past_quarter', 'all'],
              enumNames: ['Today', 'Past Week', 'Past Month', 'Past Quarter', 'All Time'],
            }
          },
          required: ['dateRange'],
        }
      }), timeoutPromise]);

      if (result.action === 'accept' && result.content) {
        const range = result.content.dateRange as string;
        const now = new Date();
        let createdAfter: string | undefined;

        switch (range) {
          case 'today':
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'past_week':
            now.setDate(now.getDate() - 7);
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'past_month':
            now.setMonth(now.getMonth() - 1);
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'past_quarter':
            now.setMonth(now.getMonth() - 3);
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'all':
          default:
            return null; // No date filter
        }

        if (createdAfter) {
          return { createdAfter };
        }
      }
      return null;
    } catch (error) {
      this.logger.debug(`Date range elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Elicit a company name and resolve it to a companyId.
   * Returns the selected companyId or null if elicitation is unavailable/dismissed.
   */
  protected async elicitCompanyId(): Promise<number | null> {
    if (!this.mcpServer) return null;

    try {
      // First, ask for the company name
      const nameResult = await this.mcpServer.elicitInput({
        message: 'No company specified. What company is this quote for?',
        requestedSchema: {
          type: 'object' as const,
          properties: {
            companyName: {
              type: 'string' as const,
              title: 'Company Name',
              description: 'Enter the company name to search for',
            }
          },
          required: ['companyName'],
        }
      });

      if (nameResult.action !== 'accept' || !nameResult.content?.companyName) {
        return null;
      }

      const searchTerm = nameResult.content.companyName as string;
      const { items: companies } = await this.autotaskService.searchCompanies({ searchTerm });

      if (companies.length === 0) {
        this.logger.debug(`No companies found matching "${searchTerm}"`);
        return null;
      }

      if (companies.length === 1 && companies[0].id != null) {
        return companies[0].id;
      }

      // Multiple results — let user pick
      const options: PicklistValue[] = companies
        .filter(c => c.id != null)
        .map(c => ({
          value: String(c.id),
          label: c.companyName || `Company #${c.id}`,
        }));

      const selected = await this.elicitSelection(
        `Found ${companies.length} companies matching "${searchTerm}". Which one?`,
        'companyId',
        options
      );

      return selected ? Number(selected) : null;
    } catch (error) {
      this.logger.debug(`Company elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Ask the caller for their Autotask username/email and resolve it to a
   * resource, binding it to this connection (#42). Used when the connecting app
   * didn't identify the user. Returns the resolution, or null if the client
   * can't be prompted or the caller declines (caller then falls back to the
   * identification_required response). Resolving via `resolveCaller` with an
   * explicit email/name caches the result under the caller's connection keys,
   * so subsequent calls skip the prompt.
   */
  protected async elicitAutotaskIdentity(ctx: CallerContext): Promise<CallerResolution | null> {
    if (!this.mcpServer) return null;
    try {
      const res = await this.mcpServer.elicitInput({
        message: 'To act on your behalf in Autotask, what is your Autotask username (login email)?',
        requestedSchema: {
          type: 'object' as const,
          properties: {
            autotaskUsername: {
              type: 'string' as const,
              title: 'Autotask username / email',
              description: 'Your Autotask login email (e.g. jane.doe@example.com)',
            },
          },
          required: ['autotaskUsername'],
        },
      });
      if (res.action !== 'accept' || !res.content?.autotaskUsername) return null;
      const value = String(res.content.autotaskUsername).trim();
      if (!value) return null;
      // An "@" means an email (matched against Resources); otherwise treat as a name.
      return value.includes('@')
        ? await this.resolveCaller(ctx, { resourceEmail: value })
        : await this.resolveCaller(ctx, { resourceName: value });
    } catch (error) {
      this.logger.debug(`Identity elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Elicit a service or product selection when creating a quote item without explicit IDs.
   * Searches both services and products by name, presents a combined list.
   * Returns { serviceID, productID } or null.
   */
  protected async elicitItemSelection(
    name: string
  ): Promise<{ serviceID?: number; productID?: number } | null> {
    if (!this.mcpServer) return null;

    try {
      const [services, products] = await Promise.all([
        this.autotaskService.searchServices({ searchTerm: name, isActive: true }),
        this.autotaskService.searchProducts({ searchTerm: name, isActive: true }),
      ]);

      const options: PicklistValue[] = [];

      for (const svc of services) {
        if (svc.id == null) continue;
        const price = svc.unitPrice != null ? ` ($${svc.unitPrice.toFixed(2)})` : '';
        options.push({
          value: `service:${svc.id}`,
          label: `Service: ${svc.name || `#${svc.id}`}${price}`,
        });
      }

      for (const prod of products) {
        if (prod.id == null) continue;
        const price = prod.unitPrice != null ? ` ($${prod.unitPrice.toFixed(2)})` : '';
        options.push({
          value: `product:${prod.id}`,
          label: `Product: ${prod.name || `#${prod.id}`}${price}`,
        });
      }

      if (options.length === 0) return null;

      const selected = await this.elicitSelection(
        `Found ${options.length} services/products matching "${name}". Which one should be used for this quote item?`,
        'itemSelection',
        options
      );

      if (!selected) return null;

      const [type, idStr] = selected.split(':');
      const id = Number(idStr);
      if (type === 'service') return { serviceID: id };
      if (type === 'product') return { productID: id };
      return null;
    } catch (error) {
      this.logger.debug(`Item elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Route a natural-language intent to the best matching tool with pre-filled parameters.
   */
  private routeIntent(rawIntent: string): {
    suggestedTool: string;
    suggestedParams: Record<string, any>;
    description: string;
    requiredParams: string[];
  } {
    // Extract quoted strings from original (preserves case) before lowercasing
    const quotedStrings = rawIntent.match(/["']([^"']+)["']/g)?.map(s => s.slice(1, -1)) || [];
    const intent = rawIntent.toLowerCase();

    // Extract potential IDs from the intent
    const numbers = intent.match(/\b\d+\b/g)?.map(Number) || [];

    // Extract hours pattern (e.g., "2 hours", "1.5 hrs")
    const hoursMatch = intent.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i);
    const hours = hoursMatch ? parseFloat(hoursMatch[1]) : undefined;

    // Decision tree based on keyword matching

    // Company To-Do (CRM calendar follow-up) — check BEFORE time tracking so a
    // "sales follow-up To-Do" is not misrouted to a time entry (§4.10). A
    // To-Do is distinct from an appointment, service call, checklist item,
    // project task, and time entry.
    if (/\b(?:to-?dos?|follow[-\s]?ups?)\b/.test(intent)) {
      const ticketIdMatch = intent.match(/ticket\s*#?\s*(\d+)/i);
      if (/\b(?:create|add|new|schedule|set|make|put)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (ticketIdMatch) params.ticketID = parseInt(ticketIdMatch[1]);
        if (quotedStrings[0]) params.activityDescription = quotedStrings[0];
        if (/\bsales\b/.test(intent)) params.actionTypeName = 'Sales';
        else if (/\bmeeting\b/.test(intent)) params.actionTypeName = 'Meeting';
        else if (/\b(?:phone|call)\b/.test(intent)) params.actionTypeName = 'Phone Call';
        return {
          suggestedTool: 'autotask_create_company_todo',
          suggestedParams: params,
          description: 'Create a Company To-Do (CRM calendar follow-up)',
          requiredParams: ['companyID', 'assignedToResourceID', 'startDateTime', 'endDateTime'],
        };
      }
      const params: Record<string, any> = {};
      if (ticketIdMatch) params.ticketID = parseInt(ticketIdMatch[1]);
      return {
        suggestedTool: 'autotask_search_company_todos',
        suggestedParams: params,
        description: 'Search Company To-Dos (CRM calendar follow-ups)',
        requiredParams: [],
      };
    }

    // Time tracking (check BEFORE tickets — "log hours on ticket" should route here, not to tickets)
    if (/\b(?:hours?|hrs?)\b/.test(intent) && /\b(?:log|enter|add|record|track|create)\b/.test(intent)) {
      const params: Record<string, any> = {};
      if (hours) params.hoursWorked = hours;
      // Look for ticket ID pattern
      const ticketIdMatch = intent.match(/ticket\s*#?\s*(\d+)/i) || intent.match(/on\s+(\d+)/);
      if (ticketIdMatch) params.ticketID = parseInt(ticketIdMatch[1]);
      else if (numbers[0] && !hours) params.ticketID = numbers[0];
      else if (numbers.length > 1) params.ticketID = numbers.find(n => n > 100) || numbers[1]; // larger numbers are likely ticket IDs
      return {
        suggestedTool: 'autotask_create_time_entry',
        suggestedParams: params,
        description: 'Log a time entry',
        requiredParams: [...(!params.ticketID ? ['ticketID'] : []), ...(!params.hoursWorked ? ['hoursWorked'] : [])],
      };
    }

    // Ticket operations
    if (/\b(?:tickets?|issues?|requests?)\b/.test(intent)) {
      if (/\b(?:create|open|new|submit)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (numbers[0] !== undefined) params.companyId = numbers[0];
        if (quotedStrings[0]) params.title = quotedStrings[0];
        return {
          suggestedTool: 'autotask_create_ticket',
          suggestedParams: params,
          description: 'Create a new service ticket',
          requiredParams: [...(params.companyId == null ? ['companyId'] : []), ...(!params.title ? ['title'] : [])],
        };
      }
      if (/\b(?:update|change|modify|edit|assign|reassign|close)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (numbers[0]) params.ticketId = numbers[0];
        return {
          suggestedTool: 'autotask_update_ticket',
          suggestedParams: params,
          description: 'Update an existing ticket',
          requiredParams: !params.ticketId ? ['ticketId'] : [],
        };
      }
      if (/\b(?:details?|info|view|show|get)\b/.test(intent) && numbers[0]) {
        return {
          suggestedTool: 'autotask_get_ticket_details',
          suggestedParams: { ticketID: numbers[0], fullDetails: true },
          description: 'Get full ticket details by ID',
          requiredParams: [],
        };
      }
      if (/\b(?:notes?|comments?)\b/.test(intent)) {
        if (/\b(?:add|create|post)\b/.test(intent)) {
          const params: Record<string, any> = {};
          if (numbers[0]) params.ticketId = numbers[0];
          return {
            suggestedTool: 'autotask_create_ticket_note',
            suggestedParams: params,
            description: 'Add a note to a ticket',
            requiredParams: [...(!params.ticketId ? ['ticketId'] : []), 'title', 'description'],
          };
        }
        const params: Record<string, any> = {};
        if (numbers[0]) params.ticketId = numbers[0];
        return {
          suggestedTool: 'autotask_search_ticket_notes',
          suggestedParams: params,
          description: 'List notes on a ticket',
          requiredParams: !params.ticketId ? ['ticketId'] : [],
        };
      }
      // Default: search tickets
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      else if (/for\s+(\w[\w\s]*?)(?:\.|$|,)/i.test(intent)) {
        const match = intent.match(/for\s+(\w[\w\s]*?)(?:\.|$|,)/i);
        if (match) params.searchTerm = match[1].trim();
      }
      if (numbers[0] !== undefined) params.companyID = numbers[0];
      return {
        suggestedTool: 'autotask_search_tickets',
        suggestedParams: params,
        description: 'Search for tickets',
        requiredParams: [],
      };
    }

    // Quote operations (check before company — "quote for client" should match quote, not company)
    if (/\b(?:quotes?|proposals?|estimates?)\b/.test(intent)) {
      if (/\b(?:item|line|add.*to)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (numbers[0]) params.quoteId = numbers[0];
        return {
          suggestedTool: 'autotask_create_quote_item',
          suggestedParams: params,
          description: 'Add a line item to a quote',
          requiredParams: [...(!params.quoteId ? ['quoteId'] : []), 'name', 'quantity', 'unitPrice'],
        };
      }
      if (/\b(?:create|new|build)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (quotedStrings[0]) params.name = quotedStrings[0];
        return {
          suggestedTool: 'autotask_create_quote',
          suggestedParams: params,
          description: 'Create a new quote',
          requiredParams: [...(!params.name ? ['name'] : []), 'companyId'],
        };
      }
      const params: Record<string, any> = {};
      if (numbers[0]) params.quoteId = numbers[0];
      return {
        suggestedTool: numbers[0] ? 'autotask_get_quote' : 'autotask_search_quotes',
        suggestedParams: params,
        description: numbers[0] ? 'Get quote details' : 'Search for quotes',
        requiredParams: [],
      };
    }

    // Company operations
    if (/\b(?:company|companies|organization|client|account)\b/.test(intent)) {
      if (/\b(?:create|new|add)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (quotedStrings[0]) params.companyName = quotedStrings[0];
        return {
          suggestedTool: 'autotask_create_company',
          suggestedParams: params,
          description: 'Create a new company',
          requiredParams: !params.companyName ? ['companyName'] : [],
        };
      }
      if (/\b(?:update|edit|modify)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (numbers[0] !== undefined) params.id = numbers[0];
        return {
          suggestedTool: 'autotask_update_company',
          suggestedParams: params,
          description: 'Update company details',
          requiredParams: params.id == null ? ['id'] : [],
        };
      }
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      return {
        suggestedTool: 'autotask_search_companies',
        suggestedParams: params,
        description: 'Search for companies',
        requiredParams: [],
      };
    }

    // Contact operations
    if (/\b(?:contacts?|person|people)\b/.test(intent)) {
      if (/\b(?:create|new|add)\b/.test(intent)) {
        return {
          suggestedTool: 'autotask_create_contact',
          suggestedParams: {},
          description: 'Create a new contact',
          requiredParams: ['firstName', 'lastName', 'companyID'],
        };
      }
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      return {
        suggestedTool: 'autotask_search_contacts',
        suggestedParams: params,
        description: 'Search for contacts',
        requiredParams: [],
      };
    }

    // Project operations
    if (/\b(?:projects?)\b/.test(intent)) {
      if (/\b(?:create|new)\b/.test(intent)) {
        return {
          suggestedTool: 'autotask_create_project',
          suggestedParams: {},
          description: 'Create a new project',
          requiredParams: ['projectName', 'companyID'],
        };
      }
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      return {
        suggestedTool: 'autotask_search_projects',
        suggestedParams: params,
        description: 'Search for projects',
        requiredParams: [],
      };
    }

    // Resource operations
    if (/\b(?:resource|technician|tech|engineer|staff)\b/.test(intent)) {
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      return {
        suggestedTool: 'autotask_search_resources',
        suggestedParams: params,
        description: 'Search for resources/technicians',
        requiredParams: [],
      };
    }

    // Expense operations
    if (/\b(?:expense|receipt)\b/.test(intent)) {
      if (/\b(?:create|new|submit)\b/.test(intent)) {
        return {
          suggestedTool: 'autotask_create_expense_report',
          suggestedParams: {},
          description: 'Create an expense report',
          requiredParams: ['name', 'submitterId', 'weekEndingDate'],
        };
      }
      return {
        suggestedTool: 'autotask_search_expense_reports',
        suggestedParams: {},
        description: 'Search expense reports',
        requiredParams: [],
      };
    }

    // Configuration items / assets
    if (/\b(?:config|asset|device|hardware|ci)\b/.test(intent)) {
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      return {
        suggestedTool: 'autotask_search_configuration_items',
        suggestedParams: params,
        description: 'Search configuration items/assets',
        requiredParams: [],
      };
    }

    // Product/service catalog
    if (/\b(?:product|service|bundle|catalog)\b/.test(intent)) {
      if (/\b(?:bundle)\b/.test(intent)) {
        return {
          suggestedTool: 'autotask_search_service_bundles',
          suggestedParams: {},
          description: 'Search service bundles',
          requiredParams: [],
        };
      }
      if (/\b(?:service)\b/.test(intent)) {
        return {
          suggestedTool: 'autotask_search_services',
          suggestedParams: {},
          description: 'Search services',
          requiredParams: [],
        };
      }
      return {
        suggestedTool: 'autotask_search_products',
        suggestedParams: {},
        description: 'Search products',
        requiredParams: [],
      };
    }

    // Charge operations
    if (/\b(?:charges?|material|cost)\b/.test(intent) && /\b(?:ticket|bill)\b/.test(intent)) {
      if (/\b(?:create|add|new)\b/.test(intent)) {
        const params: Record<string, any> = {};
        const ticketMatch = intent.match(/ticket\s*#?\s*(\d+)/i);
        if (ticketMatch) params.ticketID = parseInt(ticketMatch[1]);
        else if (numbers[0]) params.ticketID = numbers[0];
        return {
          suggestedTool: 'autotask_create_ticket_charge',
          suggestedParams: params,
          description: 'Create a ticket charge',
          requiredParams: [...(!params.ticketID ? ['ticketID'] : []), 'name', 'chargeType'],
        };
      }
      if (/\b(?:delete|remove)\b/.test(intent) && numbers[0]) {
        const deleteParams: Record<string, any> = { chargeId: numbers[0] };
        const ticketDeleteMatch = intent.match(/ticket\s*#?\s*(\d+)/i);
        if (ticketDeleteMatch) deleteParams.ticketId = parseInt(ticketDeleteMatch[1]);
        else if (numbers[1]) deleteParams.ticketId = numbers[1];
        return {
          suggestedTool: 'autotask_delete_ticket_charge',
          suggestedParams: deleteParams,
          description: 'Delete a ticket charge',
          requiredParams: [...(!deleteParams.ticketId ? ['ticketId'] : [])],
        };
      }
      const params: Record<string, any> = {};
      const ticketMatch = intent.match(/ticket\s*#?\s*(\d+)/i);
      if (ticketMatch) params.ticketId = parseInt(ticketMatch[1]);
      else if (numbers[0]) params.ticketId = numbers[0];
      return {
        suggestedTool: 'autotask_search_ticket_charges',
        suggestedParams: params,
        description: 'Search ticket charges',
        requiredParams: [],
      };
    }

    // Contract operations
    if (/\b(?:contract|agreement)s?\b/.test(intent) && /expir|renew|laps/.test(intent)) {
      return {
        suggestedTool: 'autotask_list_expiring_contracts',
        suggestedParams: {},
        description: 'List contracts expiring soon (or already expired)',
        requiredParams: [],
      };
    }
    if (/\b(?:contract|agreement)s?\b/.test(intent)) {
      return {
        suggestedTool: 'autotask_search_contracts',
        suggestedParams: {},
        description: 'Search contracts',
        requiredParams: [],
      };
    }

    // Invoice operations
    if (/\b(?:invoice|bill|billing)\b/.test(intent)) {
      return {
        suggestedTool: 'autotask_search_invoices',
        suggestedParams: {},
        description: 'Search invoices',
        requiredParams: [],
      };
    }

    // Field info / picklist
    if (/\b(?:field|picklist|dropdown|options)\b/.test(intent)) {
      const entityMatch = intent.match(/(?:for|on|of)\s+(\w+)/i);
      return {
        suggestedTool: 'autotask_get_field_info',
        suggestedParams: entityMatch ? { entityType: entityMatch[1] } : {},
        description: 'Get field definitions and picklist values',
        requiredParams: entityMatch ? [] : ['entityType'],
      };
    }

    // Queue / status / priority lookups
    if (/\b(?:queue|status|statuses|priorit)\b/.test(intent)) {
      if (/\bqueue\b/.test(intent)) return { suggestedTool: 'autotask_list_queues', suggestedParams: {}, description: 'List ticket queues', requiredParams: [] };
      if (/\bstatus\b/.test(intent)) return { suggestedTool: 'autotask_list_ticket_statuses', suggestedParams: {}, description: 'List ticket statuses', requiredParams: [] };
      return { suggestedTool: 'autotask_list_ticket_priorities', suggestedParams: {}, description: 'List ticket priorities', requiredParams: [] };
    }

    // Connection test
    if (/\b(?:test|connect|connection|ping|health)\b/.test(intent)) {
      return {
        suggestedTool: 'autotask_test_connection',
        suggestedParams: {},
        description: 'Test API connection',
        requiredParams: [],
      };
    }

    // Fallback: suggest list_categories
    return {
      suggestedTool: 'autotask_list_categories',
      suggestedParams: {},
      description: 'Could not determine intent. Use autotask_list_categories to discover available tool categories.',
      requiredParams: [],
    };
  }

  /**
   * List all available tools
   */
  async listTools(): Promise<McpTool[]> {
    if (this.lazyLoading) {
      // In lazy loading mode, only expose the 3 meta-tools
      const metaTools = TOOL_DEFINITIONS.filter(t =>
        t.name === 'autotask_list_categories' ||
        t.name === 'autotask_list_category_tools' ||
        t.name === 'autotask_execute_tool' ||
        t.name === 'autotask_router'
      );
      this.logger.debug(`Lazy loading mode: exposing ${metaTools.length} meta-tools (${TOOL_DEFINITIONS.length} total available)`);
      return metaTools;
    }
    // Tools switched off in the admin console (read-only mode, disabled groups) are hidden.
    const tools = TOOL_DEFINITIONS.filter((t) => toolAllowed(t.name));
    this.logger.debug(`Listed ${tools.length} available tools`);
    return tools;
  }

  /**
   * Dispatch table: maps tool names to handler functions
   */
  private getDispatchTable(): Map<string, (args: any, ctx: CallerContext) => Promise<{ result: any; message: string; pagination?: PageMeta }>> {
    const s = this.autotaskService;
    type H = (args: any, ctx: CallerContext) => Promise<{ result: any; message: string; pagination?: PageMeta }>;
    // Search tools return a PagedResult; unwrap it into the array callers expect
    // and carry the honest `hasMore` alongside, so the response formatter reports
    // real pagination state instead of guessing from `items.length >= pageSize`.
    const paged = <T>(p: PagedResult<T>, noun: string) => ({
      result: p.items,
      message: `Found ${p.items.length} ${noun}${p.servedFrom ? ` (served from the Postgres shadow, data ${p.servedFrom.ageSeconds}s old — 0 Autotask calls)` : ''}`,
      pagination: { page: p.page, pageSize: p.pageSize, hasMore: p.hasMore },
    });
    // Run a time-entry write; an Autotask rejection we can explain (timesheet
    // lock, posted entry, bad work type, completed task, role) comes back as an
    // actionable status instead of the raw API error. Anything else rethrows.
    const explainTimeEntryWrite = async <T>(write: () => Promise<T>): Promise<{ ok: T } | { stop: { result: unknown; message: string } }> => {
      try {
        return { ok: await write() };
      } catch (e) {
        const c = classifyTimeEntryWriteError(e);
        if (!c) throw e;
        return { stop: { result: { status: c.status, autotaskError: c.autotaskError }, message: c.reason } };
      }
    };
    // Resources + time window for the audit tools: date + timeZone (default: the
    // first resource's location timezone), or explicit start/end instants.
    const auditWindow = async (a: Record<string, unknown>): Promise<{ error: string } | { resourceIds: number[]; window: { start: string; end: string; timeZone: string; label: string }; collect: CollectOptions }> => {
      const ids = [...(Array.isArray(a.resourceIds) ? a.resourceIds : []), ...(a.resourceId != null ? [a.resourceId] : [])].map(Number).filter((x) => Number.isInteger(x) && x > 0);
      const tz = validTimeZone(a.timeZone as string) ?? validTimeZone(a.timezone as string) ?? (ids.length ? await s.resolveResourceTimeZone(ids[0]!) : undefined) ?? defaultTimeZone();
      let start: string, end: string, label: string;
      if (typeof a.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.date)) {
        const d = localDayWindow(a.date, tz);
        start = d.start; end = new Date(new Date(d.end).getTime() + 1000).toISOString(); label = `on ${a.date} (${tz})`;
      } else if (a.startDateTime && a.endDateTime) {
        const sd = new Date(String(a.startDateTime)), ed = new Date(String(a.endDateTime));
        if (Number.isNaN(sd.getTime()) || Number.isNaN(ed.getTime()) || ed <= sd) return { error: 'startDateTime / endDateTime must be valid ISO datetimes with end after start.' };
        if (ed.getTime() - sd.getTime() > 31 * 86400_000) return { error: 'The window is limited to 31 days — audit longer periods in pieces.' };
        start = sd.toISOString(); end = ed.toISOString(); label = `${start} → ${end}`;
      } else return { error: 'Give date (YYYY-MM-DD, with optional timeZone) or startDateTime + endDateTime.' };
      return {
        resourceIds: ids,
        window: { start, end, timeZone: tz, label },
        collect: {
          resourceIds: ids, start, end, timeZone: tz,
          includeSystemGenerated: a.includeSystemGenerated === true, includeUnattributed: a.includeUnattributed === true,
          ...(a.maxApiCalls != null ? { maxApiCalls: Number(a.maxApiCalls) } : {}),
        },
      };
    };
    // One-line summary of an identity search: count, top match and its evidence, duplicate clusters.
    const identityMessage = (noun: string, r: Record<string, unknown>): string => {
      const cands = (r.candidates ?? []) as Array<{ id: number; companyName?: string | null; name?: string; evidence: Array<{ kind: string }>; conflicts?: Array<{ detail: string }> }>;
      const cl = (r.clusters ?? []) as unknown[];
      const top = cands[0];
      const topText = top ? ` Top: ${top.id} ${top.companyName ?? top.name ?? ''} (${top.evidence.map((e) => e.kind).join(' + ')})${top.conflicts?.length ? ` — conflicts: ${top.conflicts.map((c) => c.detail).join('; ')}` : ''}.` : '';
      const dom = r.domain as { freeMail?: boolean; note?: string } | undefined;
      return `READ-ONLY: ${cands.length} ${noun} with matching evidence.${topText}${cl.length ? ` ${cl.length} duplicate cluster(s).` : ''}${dom?.freeMail ? ` ${dom.note}` : ''}`;
    };
    // Default dateWorked for the "my" time tools: the LOCAL date (of the start
    // time when given, else today) in timeZone → the resource's location
    // timezone → the tenant default. The UTC date is already tomorrow for an
    // evening entry in the Americas.
    const workDate = async (a: { dateWorked?: unknown; startDateTime?: unknown; timeZone?: string; resourceID?: number }): Promise<string> => {
      const explicit = typeof a.dateWorked === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a.dateWorked);
      const tz = explicit ? defaultTimeZone()
        : validTimeZone(a.timeZone) ?? (a.resourceID != null ? await s.resolveResourceTimeZone(a.resourceID) : undefined) ?? defaultTimeZone();
      return defaultWorkDate({ dateWorked: a.dateWorked, startDateTime: a.startDateTime, timeZone: tz });
    };
    // Service-call resource assignments (ticket/task) have NO role field in
    // Autotask (entityInformation: resourceID + serviceCallTicketID/TaskID only).
    // A roleID from an older caller is dropped, and the result says so.
    const roleIgnoredNote = (roleID: unknown): string =>
      roleID != null ? ` (roleID ${roleID} ignored — Autotask service-call resource assignments have no role; the role is set on the ticket/task time entry instead)` : '';
    // Pre-flight a supplied work type so a bad one is named (not found /
    // inactive / a Regular Time category) with the active choices, instead of
    // Autotask's "not an active general allocation code". Best-effort: a failed
    // lookup lets the write proceed (Autotask still enforces it).
    const checkWorkType = async (billingCodeID: unknown): Promise<{ result: unknown; message: string } | null> => {
      if (billingCodeID == null) return null;
      let v: Awaited<ReturnType<typeof s.validateWorkType>>;
      try { v = await s.validateWorkType(Number(billingCodeID)); } catch { return null; }
      if (v.ok) return null;
      const what = v.reason === 'not_found' ? 'does not exist'
        : v.reason === 'inactive' ? `is inactive ("${v.name}")`
        : `is not a ticket/task work type ("${v.name}" is useType ${v.useType}${v.useType === 3 ? ' — a Regular Time category; pass it as `category` with no ticket/task' : ''})`;
      const choices = v.validWorkTypes.map((w) => `${w.id} = ${w.name}`).join('; ');
      return {
        result: { status: 'invalid_work_type', billingCodeID: Number(billingCodeID), reason: v.reason, validWorkTypes: v.validWorkTypes },
        message: `billingCodeID ${billingCodeID} ${what} — nothing was written. Re-run with an active work type${choices ? `: ${choices}` : ''}, or omit billingCodeID to use the default.`,
      };
    };
    // hoursToBill is read-only: Autotask derives it and ignores a supplied value.
    // Say so when a caller asked for a value the stored entry doesn't carry.
    const hoursToBillWarning = (requested: unknown, stored: unknown): string | null => {
      if (requested == null) return null;
      if (stored != null && Math.abs(Number(stored) - Number(requested)) < 0.005) return null;
      return `hoursToBill is read-only in the Autotask API — requested ${requested}, Autotask stored ${stored ?? 'unknown'} (derived from hoursWorked − offsetHours plus contract/work-type rounding). Use offsetHours to bill less than worked, or edit Hours to Bill in the Autotask UI.`;
    };
    // Ticket/task time needs a roleID: resolve the default/sole role, or VALIDATE
    // a caller-chosen one against the resource's roles. Returns `stop` (a response
    // to send, nothing written) for a needed pick or an invalid role; otherwise
    // fills a.roleID and reports how it was chosen. Best-effort: if the role
    // lookup itself fails the write proceeds (Autotask still enforces the role).
    const resolveTimeEntryRole = async (a: any): Promise<{ stop: { result: any; message: string } } | { roleName: string | null; roleSource: RoleSource | null }> => {
      if (!(a.ticketID || a.taskID)) return { roleName: null, roleSource: null };
      let rr: Awaited<ReturnType<typeof s.resolveWorkTimeEntryRole>> | null;
      try { rr = await s.resolveWorkTimeEntryRole(a.resourceID, a.roleID); } catch { rr = null; }
      if (rr && 'error' in rr) return { stop: { result: null, message: rr.error } };
      if (rr && 'needsSelection' in rr) {
        return { stop: { result: { status: 'role_required', needsSelection: rr.needsSelection }, message: needsRoleSelectionMessage(rr.needsSelection) } };
      }
      if (rr && 'invalidRole' in rr) {
        return { stop: { result: { status: 'invalid_role', requestedRoleID: rr.invalidRole, needsSelection: rr.validRoles }, message: invalidRoleMessage(rr.invalidRole, a.resourceID, rr.validRoles) } };
      }
      if (rr && 'roleID' in rr) { a.roleID = rr.roleID; return { roleName: rr.roleName, roleSource: rr.source }; }
      return { roleName: null, roleSource: a.roleID != null ? 'explicit_unverified' : null };
    };
    return new Map<string, H>([
      // Vendor purchasing & billing reconciliation (P0, Postgres only — read-only toward Autotask).
      ...vendorToolHandlers(s, () => getPool(this.logger)),
      ...catalogToolHandlers(s, () => getPool(this.logger)),
      ...reconToolHandlers(s, () => getPool(this.logger)),
      ...pax8ToolHandlers(() => getPool(this.logger)),
      ...contractToolHandlers(s, () => getPool(this.logger)),
      ...processToolHandlers(s, () => getPool(this.logger)),
      // Safe company / contact merges (ID-only work lists of Autotask UI steps; read-only toward Autotask).
      ...mergeToolHandlers(s, () => getPool(this.logger)),
      // Bulk placeholder cleanup (staged in Postgres, pushed by the background worker at a set pace).
      ...bulkToolHandlers(s, () => getPool(this.logger)),
      ...commerceToolHandlers(s, () => getPool(this.logger)),
      ...setupToolHandlers(s),
      // Capability gaps → console Requests page.
      ...gapToolHandlers(() => getPool(this.logger)),
      // Connection
      ['autotask_get_api_usage', async () => {
        const r = await s.getApiUsage();
        const at = 'error' in r.autotask
          ? `Autotask counter unavailable (${r.autotask.error})`
          : `Autotask: ${r.autotask.used ?? '?'} of ${r.autotask.limit ?? '?'} requests used in the current ${r.autotask.windowMinutes ?? '?'}-minute window (${r.autotask.usedPct ?? '?'}%) — all callers on this API user`;
        const sv = r.server;
        const top = sv.topUpstream.slice(0, 3).map((t) => `${t.call} ×${t.count}`).join(', ');
        return {
          result: r,
          message: `${at}. This server: ${sv.upstreamLastHour} upstream call(s) in the last hour (${sv.upstreamLastFiveMinutes} in 5 min), ${sv.cacheHits} cache hit(s) + ${sv.coalesced} shared read(s)${sv.savedPct != null ? ` (${sv.savedPct}% of reads saved)` : ''}, ${sv.rateLimited} 429(s) since ${sv.since}${top ? `. Top: ${top}` : ''}.`,
        };
      }],
      // Postgres shadow (read-only mirror of Tickets / TimeEntries / Companies /
      // Contacts / Contracts / services / blocks / Resources). Reads cost 0 Autotask calls.
      // Resource activity / labor audit (read-only): one normalized event stream per resource + window.
      ['autotask_search_audit_activity', async (a) => {
        const w = await auditWindow(a);
        if ('error' in w) return { result: null, message: w.error };
        const r = await collectAuditEvents(s, { ...w.collect, ...(Array.isArray(a.entityTypes) && a.entityTypes.length ? { entityTypes: a.entityTypes } : {}) });
        const limit = Math.min(Math.max(Number(a.limit) || 500, 1), 2000);
        const offset = a.cursor ? Math.max(0, Number(Buffer.from(String(a.cursor), 'base64').toString('utf8')) || 0) : 0;
        const page = r.events.slice(offset, offset + limit);
        const next = offset + limit < r.events.length ? Buffer.from(String(offset + limit)).toString('base64') : null;
        return {
          result: { window: w.window, events: page, nextCursor: next, meta: { ...r.meta, recordsReturned: page.length, totalEvents: r.events.length } },
          message: `${r.events.length} event(s) for ${w.resourceIds.length || 'all'} resource(s) ${w.window.label}${next ? ` (page of ${page.length}; pass nextCursor for more)` : ''}. ${r.meta.apiCallsUsed} Autotask call(s)${r.meta.incomplete.length ? ` — INCOMPLETE: ${r.meta.incomplete.join('; ')}` : ''}.`,
        };
      }],
      // Bounded historical backfill (MCP-006): completed tickets in a range → the ledger, one budgeted step per call.
      ['autotask_backfill_history', async (a) => {
        const rt = getShadowRuntime();
        const pool = getPool(this.logger);
        if (!rt || !pool) return { result: { status: 'unavailable' }, message: 'The history backfill needs the Postgres store (MCP_PG_ENABLED, MCP_PG_SHADOW_ENABLED and migration 0009).' };
        const jobs = new BackfillJobs(pool);
        if (!a.jobId && !a.from) {
          const list = await jobs.list();
          return { result: { jobs: list }, message: list.length ? `${list.length} backfill job(s): ${list.slice(0, 5).map((j) => `${j.id} ${j.rangeFrom.slice(0, 10)}→${j.rangeTo.slice(0, 10)} ${j.status} ${j.ticketsDone}/${j.ticketsTotal ?? '?'}`).join('; ')}` : 'No backfill jobs yet — start one with from/to (dryRun:true first).' };
        }
        const http = await s.httpClient();
        let job = a.jobId ? await jobs.get(String(a.jobId)) : null;
        if (a.jobId && !job) return { result: { status: 'not_found' }, message: `No backfill job ${String(a.jobId)}.` };
        if (!job) {
          const from = new Date(String(a.from)), to = a.to ? new Date(String(a.to)) : new Date();
          if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return { result: { status: 'invalid_value' }, message: 'from/to must be ISO dates with from before to.' };
          if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) return { result: { status: 'invalid_value' }, message: `A job covers at most ${MAX_RANGE_DAYS} days — split the range.` };
          const sources = (Array.isArray(a.sources) && a.sources.length ? a.sources.map(String) : BACKFILL_SOURCES).filter((x: string): x is BackfillSource => (BACKFILL_SOURCES as string[]).includes(x));
          const total = await http.count('Tickets', [{ op: 'gte', field: 'completedDate', value: from.toISOString() }, { op: 'lt', field: 'completedDate', value: to.toISOString() }]);
          const batch = Math.min(Math.max(Number(a.batchSize) || 50, 1), 200);
          const pages = total != null ? Math.ceil(total / batch) : null;
          const estimate = total != null && pages != null ? (sources.includes('tickets') ? total : 0) + pages * (2 + (sources.includes('ticketNotes') ? 1 : 0) + (sources.includes('timeEntries') ? 1 : 0)) : null;
          if (a.dryRun === true) {
            return { result: { dryRun: true, ticketsCompleted: total, sources, estimatedApiCalls: estimate }, message: `${total ?? 'Unknown number of'} ticket(s) completed ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}; about ${estimate ?? '?'} Autotask call(s) in total (notes / time entries above 500 per page add a few). Nothing created — run without dryRun to start.` };
          }
          job = await jobs.create({ rangeFrom: from, rangeTo: to, sources, ticketsTotal: total });
        }
        const step = await runBackfillStep({
          ledger: rt.ledger, jobs, http, service: s,
          usagePct: async () => { const u = await s.getApiUsage(); return 'usedPct' in u.autotask ? u.autotask.usedPct : null; },
        }, job, {
          maxApiCalls: Number(a.maxApiCalls) || 100, batchSize: Number(a.batchSize) || 50,
          pauseAtPct: a.pauseAtUsagePct != null ? Number(a.pauseAtUsagePct) : 50, timeZone: defaultTimeZone(),
        });
        const j = step.job;
        const progress = `${j.ticketsDone}/${j.ticketsTotal ?? '?'} ticket(s), ${j.eventsIngested} event(s), ${j.apiCalls} call(s) so far`;
        const next = j.status === 'done' ? 'Done.' : step.stoppedBy === 'error' ? `Stopped on an Autotask error: ${step.error} — fix, then call again with this jobId.` : `Call again with jobId ${j.id} to continue.`;
        return { result: step, message: `Backfill ${j.id} (${j.rangeFrom.slice(0, 10)} → ${j.rangeTo.slice(0, 10)}): ${step.paused ? `PAUSED — ${step.paused}. ` : `this step ${step.ticketsProcessed} ticket(s), ${step.eventsIngested} event(s), ${step.apiCallsUsed} call(s). `}${progress}. ${next}` };
      }],
      // Backpressure (MCP-008): ok / slow / stop for dispatchers, from in-process state (0 calls unless refresh).
      ['autotask_get_backpressure', async (a) => {
        if (a.refresh === true) await s.getApiUsage().catch(() => null);
        const b = backpressure(s.apiUsername());
        return { result: b, message: `${b.level.toUpperCase()}${b.retryAfterSeconds != null ? ` — wait ${b.retryAfterSeconds}s` : ''}: ${b.reasons.length ? b.reasons.join('; ') : 'no pressure'}. ${b.advice}` };
      }],
      // Operation log lookup (MCP-007): what a correlation / decision / key / ticket led this MCP to write.
      ['autotask_get_operations', async (a) => {
        if (!this.operations) return { result: { status: 'unavailable' }, message: 'The operation log needs the Postgres store (MCP_PG_ENABLED=true and migration 0008).' };
        const q = {
          ...(a.operationId ? { operationId: String(a.operationId) } : {}), ...(a.correlationId ? { correlationId: String(a.correlationId) } : {}),
          ...(a.decisionId ? { decisionId: String(a.decisionId) } : {}), ...(a.idempotencyKey ? { idempotencyKey: String(a.idempotencyKey) } : {}),
          ...(a.ticketId != null ? { ticketId: Number(a.ticketId) } : {}), ...(a.since ? { since: String(a.since) } : {}), ...(a.limit ? { limit: Number(a.limit) } : {}),
        };
        if (q.operationId && !/^[0-9a-f-]{36}$/i.test(q.operationId)) return { result: { status: 'invalid_value', field: 'operationId' }, message: 'operationId is the UUID in a write result (_operation.operationId).' };
        if (!q.operationId && !q.correlationId && !q.decisionId && !q.idempotencyKey && q.ticketId == null) return { result: null, message: 'Give operationId, correlationId, decisionId, idempotencyKey or ticketId.' };
        const ops = await this.operations.find(q);
        return { result: { operations: ops }, message: `${ops.length} operation(s)${ops.length ? `: ${ops.slice(0, 5).map((o) => `${o.tool} ${o.status} (${o.writes.length} write(s))`).join('; ')}${ops.length > 5 ? '; …' : ''}` : ''}.` };
      }],
      // Incremental activity feed (MCP-002/003): checkpointed ingest into audit_event, cursor = ingestion order.
      ['autotask_get_activity_feed', async (a) => {
        const rt = getShadowRuntime();
        if (!rt) return { result: { status: 'unavailable' }, message: 'The activity feed needs the Postgres store (MCP_PG_ENABLED=true and migrations 0003 + 0007). Single-ticket history is still available via autotask_get_ticket_change_history.' };
        const now = new Date();
        const cur = a.cursor != null && a.cursor !== '' ? decodeCursor(a.cursor) : null;
        if (a.cursor != null && a.cursor !== '' && !cur) return { result: { status: 'invalid_cursor' }, message: 'cursor is not a nextCursor from this tool — start again with since.' };
        const since = cur?.since ?? (a.since != null && a.since !== '' ? normalizeTimestamp(String(a.since)) : new Date(now.getTime() - 86_400_000).toISOString());
        if (!since || Number.isNaN(Date.parse(since))) return { result: { status: 'invalid_value', field: 'since' }, message: `since "${String(a.since)}" is not an ISO date/time.` };
        const entityTypes: string[] = Array.isArray(a.entityTypes) && a.entityTypes.length ? a.entityTypes.map(String) : ['ticket', 'ticketNote', 'timeEntry'];
        const sources = FEED_SOURCES.filter((src: FeedSource) => entityTypes.includes(SOURCE_ENTITY[src]));
        const ingest = a.ingest === false ? null : await ingestActivity({ ledger: rt.ledger, store: rt.store, http: await s.httpClient(), service: s }, {
          since: new Date(since), sources, backfill: a.backfill === true, timeZone: defaultTimeZone(),
          maxApiCalls: a.maxApiCalls != null ? Number(a.maxApiCalls) : 40,
        });
        const limit = Math.min(Math.max(Number(a.limit) || 250, 1), 1000);
        const ticketIds = Array.isArray(a.ticketIds) ? a.ticketIds.map(Number).filter(Number.isFinite) : [];
        const rows = await rt.ledger.feedPage({ afterId: cur?.id ?? 0, since, limit, entityTypes, ticketIds });
        const page = rows.slice(0, limit);
        let ctx: Awaited<ReturnType<typeof s.getActorContext>> | null = null;
        try { ctx = await s.getActorContext(); } catch { /* actors reported as unknown */ }
        const actorTypes: string[] = Array.isArray(a.actorTypes) ? a.actorTypes.map(String) : [];
        const withBA = a.includeBeforeAfter !== false, withDetails = a.includeDetails !== false;
        let events = page.map((e) => {
          const actor = feedActor(e, ctx);
          const ticketId = e.entityType === 'ticket' ? e.entityId : e.parentEntityType === 'ticket' ? e.parentEntityId ?? null : null;
          return {
            eventId: e.eventId, feedId: e.feedId, eventType: eventType(e), occurredAt: e.timestamp, ingestedAt: e.ingestedAt,
            ticketId, ticketNumber: e.entityType === 'ticket' ? e.entityReference ?? null : null,
            entityType: e.entityType, entityId: e.entityId, companyId: e.companyId ?? null, actor,
            field: e.field ?? null, ...(withBA ? { before: e.oldValue ?? null, after: e.newValue ?? null } : {}),
            source: e.source, systemGenerated: e.systemGenerated, ...(withDetails && e.details ? { details: e.details } : {}),
          };
        }).filter((e) => (!actorTypes.length || actorTypes.includes(e.actor.actorType)) && (a.referenceOnly !== true || e.actor.reference));
        // MCP-007: changes made through this MCP carry the operation (correlation / decision) that made them.
        events = await this.linkOperations(events, (e) => (e.actor.actorType === 'service_account' ? { type: e.entityType, id: e.entityId, at: e.occurredAt } : null), (e, operation) => ({ ...e, operation }));
        const lastId = page.length ? page[page.length - 1]!.feedId : cur?.id ?? 0;
        const cps = await rt.ledger.feedCheckpoints();
        const marks = sources.map((src) => cps.get(src)).filter((c): c is NonNullable<typeof c> => !!c);
        const watermark = marks.length === sources.length && marks.length ? new Date(Math.min(...marks.map((c) => c.watermark.getTime()))) : null;
        const coveredFrom = marks.length === sources.length && marks.length ? new Date(Math.max(...marks.map((c) => c.coveredFrom.getTime()))) : null;
        const coverageComplete = !!coveredFrom && coveredFrom.getTime() <= Date.parse(since);
        const pending = ingest ? ingest.incomplete.length > 0 : false;
        const hasMore = rows.length > limit || pending;
        return {
          result: {
            events, nextCursor: encodeCursor({ id: lastId, since }), hasMore,
            watermark: watermark?.toISOString() ?? null,
            sourceLagSeconds: watermark ? Math.max(0, Math.round((now.getTime() - watermark.getTime()) / 1000)) : null,
            coverage: { since, coveredFrom: coveredFrom?.toISOString() ?? null, complete: coverageComplete },
            ingest: ingest ?? { ran: false, skipped: 'ingest:false' },
            scanned: page.length,
          },
          message: `${events.length} event(s)${page.length !== events.length ? ` (${page.length} scanned, filtered by actor)` : ''}${hasMore ? ' — more available: call again with nextCursor' : ''}. ${ingest ? `${ingest.apiCallsUsed} Autotask call(s) to ingest` : 'No ingest'}${ingest?.incomplete.length ? ` — PENDING: ${ingest.incomplete.join('; ')}` : ''}.${coverageComplete ? '' : ` Coverage starts ${coveredFrom?.toISOString() ?? 'at the first ingest'} — earlier events were never ingested (pass backfill:true).`}`,
        };
      }],
      ['autotask_report_resource_activity', async (a) => {
        const w = await auditWindow(a);
        if ('error' in w) return { result: null, message: w.error };
        if (!w.resourceIds.length) return { result: null, message: 'resourceId or resourceIds is required.' };
        const r = await collectAuditEvents(s, w.collect);
        const per = w.resourceIds.map((rid) => {
          const evs = r.events.filter((e) => e.resourceId === rid);
          const count = (k: (e: typeof evs[number]) => string) => evs.reduce<Record<string, number>>((m, e) => { m[k(e)] = (m[k(e)] ?? 0) + 1; return m; }, {});
          return { resourceId: rid, resourceName: evs[0]?.resourceName ?? null, eventCount: evs.length, byEntityType: count((e) => e.entityType), byAction: count((e) => e.action), events: evs };
        });
        return {
          result: { window: w.window, resources: per, meta: r.meta },
          message: `${w.window.label}: ${per.map((p) => `${p.resourceName ?? p.resourceId} ${p.eventCount} event(s)`).join(', ')}. ${r.meta.apiCallsUsed} Autotask call(s)${r.meta.incomplete.length ? ` — INCOMPLETE: ${r.meta.incomplete.join('; ')}` : ''}.`,
        };
      }],
      ['autotask_report_resource_daily_audit', async (a) => {
        const date = typeof a.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : null;
        if (!date) return { result: null, message: 'date (YYYY-MM-DD) is required.' };
        const w = await auditWindow({ ...a, date });
        if ('error' in w) return { result: null, message: w.error };
        if (!w.resourceIds.length) return { result: null, message: 'resourceId or resourceIds is required.' };
        const r = await collectAuditEvents(s, { ...w.collect, includeUnattributed: false });
        const bhStart = /^\d{2}:\d{2}$/.test(String(a.businessHoursStart)) ? String(a.businessHoursStart) : '08:00';
        const bhEnd = /^\d{2}:\d{2}$/.test(String(a.businessHoursEnd)) ? String(a.businessHoursEnd) : '17:00';
        const names = await s.getResourceNames(w.resourceIds).catch(() => new Map<number, string>());
        const audits = w.resourceIds.map((rid) => buildDailyAudit({ id: rid, name: names.get(rid) ?? null }, r.events, r.tickets, { date, timeZone: w.window.timeZone, businessHoursStart: bhStart, businessHoursEnd: bhEnd }));
        const lines = audits.map((x) => `${x.resource.name ?? x.resource.id}: ${x.summary.hoursEntered}h entered, ${x.summary.ticketsTouched} ticket(s) + ${x.summary.tasksTouched} task(s) touched, ${x.summary.itemsWithoutTime} with no time${x.summary.closedItemsMissingLabor ? ` (${x.summary.closedItemsMissingLabor} closed — reopen to backfill)` : ''}, ${x.summary.afterHoursEvents} after-hours event(s), ${x.summary.lateEntries} late entr(ies) — ${x.summary.reviewItems} to review`);
        return {
          result: { audits, meta: r.meta },
          message: `Daily audit ${date} (${w.window.timeZone}): ${lines.join(' | ')}. ${r.meta.apiCallsUsed} Autotask call(s)${r.meta.incomplete.length ? ` — INCOMPLETE: ${r.meta.incomplete.join('; ')}` : ''}.`,
        };
      }],
      ['autotask_shadow_status', async () => {
        const rt = getShadowRuntime();
        if (!rt) return { result: { enabled: false }, message: SHADOW_OFF };
        const states = await rt.store.allStates();
        const fresh = await Promise.all(SHADOW_ENTITIES.map((e) => rt.store.freshness(e.name)));
        const rows = fresh.map((f) => {
          const st = states.find((s) => s.entity === f.entity);
          return { ...f, backfillCursor: st?.backfill_cursor ?? 0, apiCallsTotal: st?.api_calls_total ?? 0, watermark: st?.watermark ?? null, lastReconcileAt: st?.last_reconcile_at ?? null, lastError: st?.last_error ?? null };
        });
        const ready = rows.filter((r) => r.ready);
        return {
          result: { enabled: true, serveReads: rt.serveReads, maxAgeSeconds: rt.maxAgeSeconds, pendingWrittenRows: rt.sync.dirtyCount(), lastRun: rt.lastRun(), entities: rows },
          message: `Shadow: ${ready.length}/${rows.length} entities ready (${rows.map((r) => `${r.entity} ${r.rows}${r.ready ? '' : ' backfilling'}${r.ageSeconds != null ? ` ${r.ageSeconds}s old` : ''}`).join(', ')}); serving search reads: ${rt.serveReads ? 'yes' : 'no'}.`,
        };
      }],
      ['autotask_shadow_query', async (a) => {
        const rt = getShadowRuntime();
        if (!rt) return { result: { enabled: false }, message: SHADOW_OFF };
        const e = shadowEntity(a.entity);
        if (!e) return { result: null, message: `entity must be one of: ${SHADOW_ENTITIES.map((x) => x.name).join(', ')}` };
        const f = await rt.store.freshness(e.name);
        const r = await rt.store.query(e.name, Array.isArray(a.filters) ? a.filters : [], { fields: a.fields, limit: a.limit, offset: a.offset, orderBy: a.orderBy, desc: a.desc === true });
        return { result: { rows: r.rows, total: r.total, freshness: f }, message: `${r.rows.length} of ${r.total} ${e.name} from the Postgres shadow (${f.ready ? `data ${f.ageSeconds}s old` : 'STILL BACKFILLING — incomplete'}${f.windowFrom ? `; holds history from ${f.windowFrom} (plus open tickets) — older data is not in the shadow` : ''}; 0 Autotask calls).` };
      }],
      ['autotask_shadow_aggregate', async (a) => {
        const rt = getShadowRuntime();
        if (!rt) return { result: { enabled: false }, message: SHADOW_OFF };
        const e = shadowEntity(a.entity);
        if (!e) return { result: null, message: `entity must be one of: ${SHADOW_ENTITIES.map((x) => x.name).join(', ')}` };
        const f = await rt.store.freshness(e.name);
        const rows = await rt.store.aggregate(e.name, Array.isArray(a.filters) ? a.filters : [], Array.isArray(a.groupBy) ? a.groupBy : [], Array.isArray(a.sum) ? a.sum : [], a.limit ?? 1000);
        return { result: { groups: rows, freshness: f }, message: `${rows.length} group(s) over ${e.name} from the Postgres shadow (${f.ready ? `data ${f.ageSeconds}s old` : 'STILL BACKFILLING — incomplete'}${f.windowFrom ? `; holds history from ${f.windowFrom} (plus open tickets) — older data is not in the shadow` : ''}; 0 Autotask calls).` };
      }],
      ['autotask_shadow_sync', async (a) => {
        const rt = getShadowRuntime();
        if (!rt) return { result: { enabled: false }, message: SHADOW_OFF };
        const action = a.action ?? 'run';
        if (action === 'refresh') {
          const e = shadowEntity(a.entity);
          const ids = (Array.isArray(a.ids) ? a.ids : []).map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
          if (!e || !ids.length) return { result: null, message: 'refresh needs entity and ids.' };
          const n = await rt.sync.refreshIds(e.name, ids);
          return { result: { refreshed: n }, message: `Re-read ${n} of ${ids.length} ${e.name} row(s) from Autotask into the shadow.` };
        }
        if (action === 'verify') {
          const r = await rt.verify({ ...(a.entity ? { entities: [String(a.entity)] } : {}), ...(a.sample ? { sample: Math.min(Math.max(Number(a.sample) || 10, 1), 50) } : {}), trigger: 'tool' });
          if (!r) return { result: null, message: 'A sync is running (here or on another instance) — try again shortly.' };
          const bad = r.entities.filter((x) => x.differs || x.missing || x.countOk === false || x.error);
          return { result: r, message: r.skipped ?? `Shadow check ${r.status === 'ok' ? 'OK' : 'needs attention'}: ${r.entities.reduce((n, x) => n + x.sampled, 0)} rows sampled across ${r.entities.length} entities, ${r.calls} Autotask call(s).${bad.length ? ` Mismatches: ${bad.map((x) => `${x.entity} (${x.differs} differ, ${x.missing} missing${x.countOk === false ? `, count Δ${x.countDelta}` : ''})`).join('; ')} — repaired from Autotask.` : ''}` };
        }
        if (action === 'reconcile') {
          const e = shadowEntity(a.entity);
          if (!e) return { result: null, message: `reconcile needs entity: ${SHADOW_ENTITIES.map((x) => x.name).join(', ')}` };
          const r = await rt.sync.reconcile(e.name, Math.min(Number(a.maxCalls) || 600, 1000));
          return { result: r, message: `Reconciled ${e.name}: ${r.calls} call(s), ${r.rows} live id(s), ${r.deleted ?? 0} marked deleted${r.done ? '' : ' — INCOMPLETE (budget); run again'}.` };
        }
        const r = await rt.runNow();
        if (!r) return { result: null, message: 'A sync is already running (here or on another instance) — try again shortly.' };
        return { result: r, message: r.skipped ?? `Sync run: ${r.calls} Autotask call(s); ${r.entities.map((x) => `${x.entity} ${x.mode}${x.rows ? ` ${x.rows}` : ''}${x.error ? ` ERROR ${x.error}` : ''}`).join(', ')}.` };
      }],
      ['autotask_test_connection', async () => {
        const ok = await s.testConnection();
        if (!ok) {
          throw new Error('Connection to Autotask API failed. Verify AUTOTASK_USERNAME, AUTOTASK_SECRET, and AUTOTASK_INTEGRATION_CODE are configured correctly and that the API user has at least read access to Companies.');
        }
        return { result: { success: true }, message: 'Successfully connected to Autotask API' };
      }],

      // Identity: resolve the caller to an Autotask resource (§4.1)
      ['autotask_whoami', async (a, ctx) => {
        const r = await this.resolveCaller(ctx, {
          resourceId: a.resourceId,
          resourceEmail: a.resourceEmail,
          resourceName: a.resourceName,
        });
        const message =
          r.status === 'resolved'
            ? `You are ${r.resource.name} (Autotask resource ${r.resource.id}), resolved via ${r.via}.`
            : r.message;
        return { result: r, message };
      }],

      // Companies
      ['autotask_search_companies', async (a) => {
        // Identity mode (read-only, evidence per match) when any identity field is given.
        const given = (v: unknown) => v != null && v !== '';
        // Classification {id, label} on every plain-mode row (null when unset); labels from the tenant's live picklist.
        const classValues = async () => { try { return await s.getPicklistValues('Companies', 'classification'); } catch { return []; } };
        const withClassification = (items: object[], values: Array<{ value: unknown; label: string }>) => {
          const labels = new Map(values.map((v) => [Number(v.value), v.label]));
          return items.map((c) => { const id = (c as Record<string, unknown>).classification; return { ...c, classification: id == null || id === '' ? null : { id: Number(id), label: labels.get(Number(id)) ?? null } }; });
        };
        // Classification search is plain mode: it combines with searchTerm (or name) / isActive / companyType, never identity matching.
        if (given(a.classification)) {
          const other = (['webDomain', 'domain', 'emailDomain', 'phone', 'companyNumber'] as const).filter((k) => given(a[k]));
          if (other.length) return { result: { status: 'invalid_combination', fields: other }, message: `classification combines with searchTerm (or name), isActive and companyType — not ${other.join(', ')}. Search by those without classification (identity mode).` };
          const values = await s.getPicklistValues('Companies', 'classification');
          const m = matchPicklistExact(values, a.classification, { includeInactive: a.includeInactiveClassifications === true });
          if (!m.ok) {
            const hint = m.reason === 'ambiguous' ? 'several classifications have that label — pass the id'
              : m.inactiveMatch ? `"${m.inactiveMatch.label}" (${m.inactiveMatch.value}) is INACTIVE — pass includeInactiveClassifications: true, or its id`
              : m.suggestions.length ? `did you mean ${formatChoices(m.suggestions)}?` : 'no such classification';
            return { result: { status: m.reason === 'ambiguous' ? 'ambiguous_classification' : 'invalid_classification', requested: m.requested, choices: m.choices, suggestions: m.suggestions, inactiveMatch: m.inactiveMatch }, message: `classification "${m.requested}": ${hint}. Choices: ${formatChoices(m.choices)}` };
          }
          let companyType: number | undefined;
          if (given(a.companyType)) {
            const t = matchPicklist(await s.getPicklistValues('Companies', 'companyType'), a.companyType);
            if (!t.ok) return { result: { status: 'invalid_company_type', choices: t.choices }, message: `companyType "${a.companyType}" not found. Choices: ${formatChoices(t.choices)}` };
            companyType = t.value;
          }
          const { companyType: _type, classification: _class, ...rest } = a;
          const p = await s.searchCompanies({ ...rest, searchTerm: a.searchTerm ?? a.name, classification: m.value, ...(companyType != null ? { companyType } : {}) });
          const out = paged({ ...p, items: withClassification(p.items, values) }, 'companies');
          return { ...out, message: `${out.message} classified "${m.label}" (${m.value})${m.isActive ? '' : ' — an INACTIVE classification'}` };
        }
        const identity = [a.name, a.webDomain, a.domain, a.emailDomain, a.phone, a.companyNumber, a.companyType].some(given);
        if (!identity) {
          const p = await s.searchCompanies(a);
          return paged({ ...p, items: withClassification(p.items, await classValues()) }, 'companies');
        }
        let companyType: number | undefined;
        if (a.companyType != null && a.companyType !== '') {
          const m = matchPicklist(await s.getPicklistValues('Companies', 'companyType'), a.companyType);
          if (!m.ok) return { result: { status: 'invalid_company_type', choices: m.choices }, message: `companyType "${a.companyType}" not found. Choices: ${formatChoices(m.choices)}` };
          companyType = m.value;
        }
        const r = await s.findCompanies({
          name: a.name, domain: a.webDomain ?? a.domain ?? a.emailDomain, phone: a.phone, companyNumber: a.companyNumber,
          ...(companyType != null ? { companyType } : {}), ...(typeof a.isActive === 'boolean' ? { isActive: a.isActive } : {}),
        });
        return { result: r, message: identityMessage('compan(ies)', r) };
      }],
      ['autotask_get_company', async (a) => {
        const raw = a.companyID ?? a.companyId ?? a.id;
        const id = raw == null || raw === '' ? NaN : Number(raw); // 0 = your own company
        if (!Number.isInteger(id) || id < 0) return { result: null, message: 'companyID is required (a whole number; 0 is your own company).' };
        const r = await s.getCompanyFull(id);
        if (!r) return { result: null, message: `Company ${id} not found.` };
        const c = r.company as Record<string, unknown>, l = r.labels as Record<string, string>, n = r.names as Record<string, { name?: string | null }>;
        return { result: r, message: `Company ${id}: "${c.companyName}" — ${c.isActive ? 'active' : 'INACTIVE'}${l.companyType ? `, ${l.companyType}` : ''}${n.ownerResourceID?.name ? `, owner ${n.ownerResourceID.name}` : ''}, created ${c.createDate ?? '?'}${n.createdByResourceID?.name ? ` by ${n.createdByResourceID.name}` : ''}` };
      }],
      ['autotask_get_contact', async (a) => {
        const id = Number(a.contactID ?? a.contactId ?? a.id);
        if (!Number.isInteger(id) || id <= 0) return { result: null, message: 'contactID (a positive integer) is required.' };
        const r = await s.getContactFull(id);
        if (!r) return { result: null, message: `Contact ${id} not found.` };
        const c = r.contact as Record<string, unknown>, n = r.names as Record<string, { name?: string | null }>;
        return { result: r, message: `Contact ${id}: ${[c.firstName, c.lastName].filter(Boolean).join(' ')} <${c.emailAddress ?? 'no email'}> — ${c.isActive === 1 || c.isActive === true ? 'active' : 'INACTIVE'}, company ${n.companyID?.name ?? c.companyID ?? '?'}, created ${c.createDate ?? '?'}` };
      }],
      ['autotask_find_company_contact_candidates', async (a) => {
        if (![a.companyName, a.contactName, a.email, a.phone, a.domain].some((v) => v != null && String(v).trim() !== '')) {
          return { result: null, message: 'Give at least one of companyName, contactName, email, phone, domain.' };
        }
        const r = await s.findCompanyContactCandidates({ companyName: a.companyName ?? undefined, contactName: a.contactName ?? undefined, email: a.email ?? undefined, phone: a.phone ?? undefined, domain: a.domain ?? undefined });
        const side = (x: { verdict: string; confidence: string; candidates: unknown[]; reason: string }) => `${x.verdict} (${x.confidence}; ${x.candidates.length} candidate(s)) — ${x.reason}`;
        return { result: r, message: `READ-ONLY, nothing created. Contact: ${side(r.contact as never)}. Company: ${side(r.company as never)}.${(r.notes as string[]).length ? ` ${(r.notes as string[]).join(' ')}` : ''}` };
      }],
      ['autotask_find_duplicate_companies', async (a) => {
        const raw = a.companyID ?? a.companyId ?? a.id;
        const id = raw == null || raw === '' ? NaN : Number(raw); // 0 = your own company
        if (!Number.isInteger(id) || id < 0) return { result: null, message: 'companyID is required (a whole number; 0 is your own company).' };
        const r = await s.findDuplicateCompanies(id);
        if (r.status === 'not_found') return { result: r, message: `Company ${id} not found.` };
        return { result: r, message: identityMessage(`possible duplicate(s) of company ${id}`, r) };
      }],
      ['autotask_find_duplicate_contacts', async (a) => {
        const id = Number(a.contactID ?? a.contactId ?? a.id);
        if (!Number.isInteger(id) || id <= 0) return { result: null, message: 'contactID (a positive integer) is required.' };
        const r = await s.findDuplicateContacts(id);
        if (r.status === 'not_found') return { result: r, message: `Contact ${id} not found.` };
        return { result: r, message: identityMessage(`possible duplicate(s) of contact ${id}`, r) };
      }],
      ['autotask_create_company', async (a) => {
        const id = await s.createCompany(a); return { result: id, message: `Successfully created company with ID: ${id}` };
      }],
      ['autotask_update_company', async (a) => {
        await s.updateCompany(a.id, a); return { result: undefined, message: `Successfully updated company ID: ${a.id}` };
      }],
      ['autotask_get_company_site_configuration', async (a) => {
        const r = await s.getCompanySiteConfigurations(a.companyId);
        return { result: r, message: `Found ${r.length} site configuration record(s) for company ${a.companyId}` };
      }],
      ['autotask_update_company_site_configuration', async (a) => {
        await s.updateCompanySiteConfiguration(a.id, a.updates || {});
        return { result: undefined, message: `Successfully updated company site configuration ID: ${a.id}` };
      }],

      // Contacts
      ['autotask_search_contacts', async (a) => {
        // Identity mode (read-only, evidence per match, every exact-email duplicate) when any identity field is given.
        const name = a.name ?? ([a.firstName, a.lastName].filter(Boolean).join(' ') || undefined);
        const identity = [a.email, name, a.phone].some((v) => v != null && v !== '');
        if (!identity) return paged(await s.searchContacts(a), 'contacts');
        const r = await s.findContacts({
          email: a.email, name, phone: a.phone,
          ...(a.companyID != null ? { companyID: Number(a.companyID) } : {}), ...(a.isActive != null && a.isActive !== '' ? { isActive: a.isActive === true || Number(a.isActive) === 1 } : {}),
        });
        return { result: r, message: identityMessage('contact(s)', r) };
      }],
      ['autotask_create_contact', async (a) => {
        const id = await s.createContact(a); return { result: id, message: `Successfully created contact with ID: ${id}` };
      }],
      ['autotask_find_or_create_contact', async (a) => {
        const { companyID, ...rest } = a;
        const r = await s.findOrCreateContact(companyID, rest);
        if (r.status === 'ambiguous') return { result: r, message: `Nothing created: ${r.candidates?.length} contacts in company ${companyID} match by ${r.matchedBy} (ids ${r.candidates?.join(', ')}) — pick one.` };
        return { result: r, message: r.created ? `Created contact ${r.id}` : `Found existing contact ${r.id} (by ${r.matchedBy})${r.reactivated ? ' — it was inactive and has been reactivated' : ''}` };
      }],
      ['autotask_update_contact', async (a) => {
        await s.updateContact(a.id, a); return { result: undefined, message: `Successfully updated contact ID: ${a.id}` };
      }],

      // Tickets
      ['autotask_search_tickets', async (a) => {
        // Elicitation for zero-filter ticket searches
        const hasFilters = a.searchTerm || a.title || a.companyID != null || a.contactID || a.status !== undefined ||
          a.priority !== undefined || a.queueID !== undefined ||
          a.assignedResourceID || a.unassigned || a.createdAfter || a.createdBefore || a.lastActivityAfter ||
          a.externalID || a.contractID || a.noContract;
        if (!hasFilters && this.mcpServer) {
          const dateChoice = await this.elicitDateRange();
          if (dateChoice) a = { ...a, ...dateChoice };
        }
        const { companyID, ...rest } = a;
        const opts = { ...rest, ...(companyID !== undefined && { companyId: companyID }) };
        return paged(await s.searchTickets(opts), 'tickets');
      }],
      ['autotask_get_ticket_details', async (a) => {
        const r = await s.getTicket(a.ticketID, a.fullDetails);
        // A plain-text "open in Autotask" link the model can hand the tech, so the
        // full detail is one click away even where the card's button can't open
        // links. Best-effort: no resolvable web UI base → no link.
        const ticketUrl = ((): string | null => {
          try { return r?.id != null ? s.getTicketWebUrl(Number(r.id)) : null; } catch { return null; }
        })();
        if (r && ticketUrl) (r as Record<string, unknown>).ticketUrl = ticketUrl;
        return { result: r, message: `Ticket details retrieved successfully${ticketUrl ? ` — open in Autotask: ${ticketUrl}` : ''}` };
      }],
      ['autotask_create_ticket', async (a) => {
        const payload = buildTicketPayload(a);
        const additional: number[] = Array.isArray(a.additionalConfigurationItemIDs)
          ? a.additionalConfigurationItemIDs.filter((n: unknown) => typeof n === 'number')
          : [];
        if (additional.length > 0) {
          // §7 convenience: create → link additional CIs → read back → enriched.
          const r = await s.createTicketWithConfigurationItems(payload, additional);
          const linked = r.additionalConfigurationItems.length;
          const failed = r.linkErrors.length;
          return {
            result: r,
            message: `Created ticket ${r.id}; linked ${linked} additional CI(s)` + (failed ? `, ${failed} failed` : ''),
          };
        }
        const id = await s.createTicket(payload);
        return { result: id, message: `Successfully created ticket with ID: ${id}` };
      }],
      ['autotask_update_ticket', async (a) => {
        const { ticketId, ...rest } = a;
        // Contract and company moves have their own guarded tools (financial
        // confirmation / company-move checks) — never a side door through here.
        const routed: Record<string, string> = { contractID: 'autotask_set_ticket_contract', contractServiceID: 'autotask_set_ticket_contract', contractServiceBundleID: 'autotask_set_ticket_contract', companyID: 'autotask_move_ticket_to_company' };
        const blocked = Object.keys(routed).filter((k) => rest[k] !== undefined);
        if (blocked.length) {
          return { result: { status: 'use_dedicated_tool', fields: blocked }, message: `Nothing written: ${blocked.join(', ')} can't be changed with update_ticket — use ${[...new Set(blocked.map((k) => routed[k]))].join(' / ')} (it validates and moves the related records too).` };
        }
        if (rest.queueID === undefined && typeof rest.queue === 'string' && rest.queue.trim()) rest.queueID = rest.queue.trim();
        const payload = buildTicketPayload(rest);
        if (!Object.keys(payload).length) return { result: null, message: `Nothing to update on ticket ${ticketId} — no writable fields given.` };
        // Picklists by label or id: "Tier 1 Support" → its queue id; an unknown
        // label or inactive id returns the choices instead of a failed write.
        const pick = Object.keys(payload).filter((k) => TICKET_PICKLIST_FIELDS.has(k));
        let fields: Awaited<ReturnType<typeof s.getFieldInfo>> = [];
        if (pick.length) {
          try { fields = await s.getFieldInfo('Tickets'); } catch { fields = []; }
          for (const k of pick) {
            const values = fields.find((f) => f.name === k)?.picklistValues;
            // Picklist unavailable: a numeric id passes through (Autotask still validates); a label can't be resolved.
            if (!values?.length) {
              if (/^\d+$/.test(String(payload[k]))) { payload[k] = Number(payload[k]); continue; }
              return { result: { status: 'invalid_value', field: k, requested: payload[k] }, message: `Nothing written: couldn't load the ${k} choices to resolve "${payload[k]}" — pass the numeric id.` };
            }
            const m = matchPicklist(values, payload[k]);
            if (!m.ok) return { result: { status: 'invalid_value', field: k, requested: payload[k], choices: m.choices }, message: `Nothing written: ${k} "${payload[k]}" is not an active choice. Choices: ${formatChoices(m.choices)}` };
            payload[k] = m.value;
          }
        }
        // Old values from the Postgres shadow (0 Autotask calls) when it mirrors the ticket.
        const before = await getShadowRuntime()?.store.query('Tickets', [{ op: 'eq', field: 'id', value: Number(ticketId) }], { limit: 1 }).then((r) => (r.rows[0] as Record<string, unknown>) ?? null).catch(() => null) ?? null;
        await s.updateTicket(ticketId, payload);
        // Read back: report old → new per field, and anything Autotask didn't apply.
        let after: Record<string, unknown> | null = null;
        try { after = await s.getTicket(Number(ticketId), true) as Record<string, unknown> | null; } catch { /* verification is best-effort */ }
        if (!after) return { result: ticketId, message: `Successfully updated ticket ${ticketId}` };
        if (!fields.length) { try { fields = await s.getFieldInfo('Tickets'); } catch { /* raw values */ } }
        const lbl = (k: string, v: unknown) => fields.find((f) => f.name === k)?.picklistValues?.find((p) => String(p.value) === String(v))?.label ?? v;
        const changes: Array<{ field: string; from: unknown; to: unknown; applied: boolean }> = Object.keys(payload).filter((k) => k !== 'userDefinedFields' && k !== 'ticketAdditionalContacts').map((k) => ({
          field: k, from: before ? lbl(k, before[k] ?? null) : undefined, to: lbl(k, after![k] ?? null),
          applied: JSON.stringify(after![k] ?? null) === JSON.stringify(payload[k] ?? null) || String(after![k]) === String(payload[k]),
        }));
        // UDFs are verified too (callers like n8n check e.g. BP-Status / Nexus-Status after the write).
        if (Array.isArray(payload.userDefinedFields)) {
          const udfVal = (list: unknown, name: string) => { const u = (Array.isArray(list) ? list : []).find((x: { name?: unknown }) => String(x?.name) === name) as { value?: unknown } | undefined; return u?.value === undefined || u?.value === '' ? null : u.value; };
          for (const u of payload.userDefinedFields as Array<{ name?: unknown; value?: unknown }>) {
            const name = String(u?.name ?? '');
            if (!name) continue;
            const want = u.value === undefined || u.value === '' ? null : u.value;
            const got = udfVal(after.userDefinedFields, name);
            changes.push({ field: `udf:${name}`, from: before ? udfVal(before.userDefinedFields, name) : undefined, to: got, applied: String(got ?? '') === String(want ?? '') });
          }
        }
        const notApplied = changes.filter((c) => !c.applied);
        const tn = (after.ticketNumber as string) ?? `ticket ${ticketId}`;
        const desc = changes.filter((c) => c.applied).map((c) => `${c.field}${c.from !== undefined ? ` ${c.from ?? '∅'} →` : ' →'} ${c.to ?? '∅'}`).join('; ');
        return {
          result: { ticketId, ticketNumber: after.ticketNumber ?? null, changes, verified: notApplied.length === 0 },
          message: `Updated ${tn}${desc ? `: ${desc}` : ''}.${notApplied.length ? ` WARNING — Autotask did not apply: ${notApplied.map((c) => `${c.field} (now ${c.to ?? '∅'})`).join(', ')}.` : ''}`,
        };
      }],
      ['autotask_move_ticket_to_company', async (a) => {
        const r = await s.moveTicketToCompany(a.ticketId, a.companyID, {
          contactID: a.contactID, force: a.force, companyLocationID: a.companyLocationID,
          also: { queueID: a.queueID, status: a.status, assignedResourceID: a.assignedResourceID, assignedResourceRoleID: a.assignedResourceRoleID, userDefinedFields: a.userDefinedFields },
        });
        return { result: r, message: (r.message as string) ?? `Ticket ${a.ticketId} move result: ${r.status}` };
      }],
      ['autotask_find_ticket_by_external_id', async (a) => {
        const r = await s.findTicketByExternalId(a.externalID);
        return { result: r, message: r.length ? `Found ${r.length} ticket(s) with externalID "${a.externalID}"` : `No ticket found with externalID "${a.externalID}"` };
      }],
      // TicketAdditionalConfigurationItems (§8)
      ['autotask_search_ticket_configuration_items', async (a) => {
        const r = await s.searchTicketConfigurationItems(a.ticketID, a.configurationItemID);
        return { result: r, message: `Found ${r.length} additional configuration item(s) on ticket ${a.ticketID}` };
      }],
      ['autotask_add_ticket_configuration_item', async (a) => {
        const id = await s.addTicketConfigurationItem(a.ticketID, a.configurationItemID);
        return { result: id, message: `Linked CI ${a.configurationItemID} to ticket ${a.ticketID} (association ${id})` };
      }],
      ['autotask_remove_ticket_configuration_item', async (a) => {
        await s.removeTicketConfigurationItem(a.associationID);
        return { result: a.associationID, message: `Removed ticket additional-CI association ${a.associationID}` };
      }],
      // Ticket Charges
      ['autotask_get_ticket_charge', async (a) => {
        const r = await s.getTicketCharge(a.chargeId);
        if (!r) return { result: null, message: `No ticket charge found with ID ${a.chargeId}` };
        return { result: r, message: 'Ticket charge retrieved successfully' };
      }],
      ['autotask_search_ticket_charges', async (a) => {
        const r = await s.searchTicketCharges(a);
        return { result: r, message: `Found ${r.length} ticket charges` };
      }],
      ['autotask_create_ticket_charge', async (a) => {
        const id = await s.createTicketCharge(a);
        return { result: id, message: `Successfully created ticket charge with ID: ${id}` };
      }],
      ['autotask_update_ticket_charge', async (a) => {
        const { chargeId, ...updates } = a;
        await s.updateTicketCharge(chargeId, updates);
        return { result: chargeId, message: `Successfully updated ticket charge ${chargeId}` };
      }],
      ['autotask_delete_ticket_charge', async (a) => {
        await s.deleteTicketCharge(a.ticketId, a.chargeId);
        return { result: a.chargeId, message: `Successfully deleted ticket charge ${a.chargeId}` };
      }],

      // Ticket History (read-only audit trail)
      ['autotask_get_ticket_history', async (a) => {
        const r = await s.getTicketHistory(a.historyId);
        if (!r) return { result: null, message: `No ticket history entry found with ID ${a.historyId}` };
        return { result: r, message: 'Ticket history entry retrieved successfully' };
      }],
      ['autotask_search_ticket_history', async (a) => {
        const r = await s.searchTicketHistory({ ticketId: a.ticketId, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} ticket history entries for ticket ${a.ticketId}` };
      }],

      // Ticket audit (read-only): full resolved ticket, parsed history, original email, picklists.
      ['autotask_get_actor_roster', async (a) => {
        const r = await s.getActorRoster({ resourceIds: Array.isArray(a.resourceIds) ? a.resourceIds : undefined, actorTypes: Array.isArray(a.actorTypes) ? a.actorTypes : undefined, referenceOnly: a.referenceOnly === true, includeInactive: a.includeInactive === true });
        const c = r.counts as Record<string, number>;
        return { result: r, message: `${(r.actors as unknown[]).length} actor(s): ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}; ${r.referenceCount as number} reference technician(s).` };
      }],
      ['autotask_get_ticket_by_number', async (a) => {
        const ref = await s.resolveTicketRef({ ticketID: a.ticketID ?? a.ticketId ?? a.id, ticketNumber: a.ticketNumber }, { withRow: true });
        if ('error' in ref) return { result: null, message: ref.error };
        const r = await s.getTicketFull(ref.id, ref.row);
        if (!r) return { result: null, message: `Ticket ${ref.ticketNumber ?? ref.id} not found.` };
        const t = r.ticket as Record<string, unknown>;
        const l = r.labels as Record<string, string>;
        const n = r.names as Record<string, Record<string, unknown>>;
        const who = (k: string) => (n[k]?.name as string | null | undefined) ?? (n[k] ? `#${n[k]!.id}` : null);
        const bits = [
          l.status && `status ${l.status}`, l.priority && `priority ${l.priority}`, l.queueID && `queue ${l.queueID}`, l.source && `source ${l.source}`,
          who('companyID') && `company ${who('companyID')}`,
          n.contactID && `contact ${who('contactID')}${n.contactID.email ? ` <${n.contactID.email}>` : ''}`,
          who('assignedResourceID') && `assigned ${who('assignedResourceID')}`,
        ].filter(Boolean);
        const errs = (r.errors as unknown[] | undefined)?.length ? ` (${(r.errors as unknown[]).length} section(s) unavailable — see errors)` : '';
        return { result: r, message: `${t.ticketNumber} — ${t.title}: ${bits.join(', ')}${r.ticketUrl ? `. Open: ${r.ticketUrl}` : ''}${errs}` };
      }],
      ['autotask_set_ticket_contract', async (a) => {
        const ref = await s.resolveTicketRef({ ticketID: a.ticketID ?? a.ticketId, ticketNumber: a.ticketNumber });
        if ('error' in ref) return { result: null, message: ref.error };
        const contractID = Number(a.contractID);
        if (!Number.isInteger(contractID) || contractID <= 0) return { result: null, message: 'contractID (a positive integer) is required — nothing written.' };
        const scope = a.entries ?? 'old_or_none';
        if (!['old_or_none', 'none', 'all_unposted'].includes(scope)) return { result: null, message: `entries must be old_or_none, none or all_unposted — got "${scope}". Nothing written.` };
        const fromContractID = a.fromContractID != null && a.fromContractID !== '' ? Number(a.fromContractID) : undefined;
        const r = await s.setTicketContract({ ticketID: ref.id, contractID, ...(fromContractID != null ? { fromContractID } : {}), entries: scope, allowInactive: a.allowInactive === true, dryRun: a.dryRun !== false });
        const plan = r.plan as { errors: string[]; warnings: string[]; counts: Record<string, number> } | undefined;
        const tn = (r.ticketNumber as string | null) ?? `ticket ${ref.id}`;
        const from = r.from as { id: number; number?: string | null } | null, to = r.to as { id: number; number?: string | null } | null;
        const move = `${tn}: contract ${from ? `${from.id}${from.number ? ` (${from.number})` : ''}` : 'none'} → ${to ? `${to.id}${to.number ? ` (${to.number})` : ''}` : contractID}`;
        const c = plan?.counts ?? {};
        const ents = `time entries: ${c.move ?? 0} to move, ${c.already_on_target ?? 0} already on it, ${c.skip_posted ?? 0} posted (untouched), ${c.skip_other_contract ?? 0} on another contract (left)`;
        const warn = plan?.warnings.length ? ` WARNINGS: ${plan.warnings.join(' | ')}` : '';
        const message = r.status === 'not_found' ? `Ticket ${ref.id} not found.`
          : r.status === 'validation_failed' ? `NOTHING WRITTEN — ${plan?.errors.join('; ')}.`
          : r.status === 'nothing_to_change' ? `${move} — already correct; nothing to change.`
          : r.status === 'dry_run' ? `DRY RUN (nothing written) — ${move}; ${ents}.${warn} Re-run with dryRun:false and confirm:true to apply.`
          : r.status === 'failed' ? String(r.error)
          : r.status === 'updated' ? `Done and verified — ${move}; ${ents}.${warn}`
          : `PARTIAL — ${move}; verify: ${JSON.stringify(r.verified)}; results: ${JSON.stringify(r.results)}`;
        return { result: r, message };
      }],
      ['autotask_get_ticket_change_history', async (a) => {
        const ref = await s.resolveTicketRef({ ticketID: a.ticketID ?? a.ticketId, ticketNumber: a.ticketNumber });
        if ('error' in ref) return { result: null, message: ref.error };
        const r = await s.getTicketHistoryEvents(ref.id, { includeNoise: a.includeTimestampOnly === true, live: a.live === true });
        type HistEv = { date?: string; actor?: { actorType?: string } } & Record<string, unknown>;
        if (Array.isArray(r.events)) {
          r.events = await this.linkOperations(r.events as HistEv[], (e) => (e.actor?.actorType === 'service_account' && e.date ? { type: 'ticket', id: ref.id, at: new Date(e.date.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(e.date) ? e.date : `${e.date}Z`).toISOString() } : null), (e, operation) => ({ ...e, operation }));
        }
        const c = r.counts as { events: number; hiddenTimestampOnly: number; byActorKind: Record<string, number> };
        const kinds = Object.entries(c.byActorKind).map(([k, v]) => `${v} by ${k}`).join(', ');
        return { result: r, message: `${c.events} history event(s) on ticket ${ref.ticketNumber ?? ref.id}${kinds ? ` (${kinds})` : ''}${c.hiddenTimestampOnly ? `; ${c.hiddenTimestampOnly} timestamp-only event(s) hidden (includeTimestampOnly:true to show)` : ''}.` };
      }],
      ['autotask_get_ticket_email_context', async (a) => {
        const ref = await s.resolveTicketRef({ ticketID: a.ticketID ?? a.ticketId, ticketNumber: a.ticketNumber });
        if ('error' in ref) return { result: null, message: ref.error };
        const r = await s.getTicketEmailContext(ref.id, { maxBodyChars: a.maxBodyChars });
        const o = r.originalEmail as { fromDisplayName?: string | null; fromAddress?: string | null; replyToDiffersFromFrom?: boolean; replyTo: Array<{ address: string }>; subject?: string | null; authenticationResults: unknown[] } | undefined;
        const message = r.status === 'ok' && o
          ? `Original email on ${r.ticketNumber}: from ${o.fromDisplayName ? `"${o.fromDisplayName}" ` : ''}<${o.fromAddress ?? '?'}>${o.replyToDiffersFromFrom ? ` — Reply-To DIFFERS (${o.replyTo.map((x) => x.address).join(', ')})` : ''}, subject "${o.subject ?? ''}", ${o.authenticationResults.length} Authentication-Results header(s).`
          : r.status === 'not_found' ? `Ticket ${ref.id} not found.`
          : String(r.message ?? r.status);
        return { result: r, message };
      }],
      ['autotask_get_picklists', async (a) => {
        if (typeof a.entity !== 'string' || !a.entity) return { result: null, message: 'entity is required, e.g. { "entity": "Tickets", "fields": ["queueID", "status"] }' };
        const r = await s.getPicklists(a.entity, Array.isArray(a.fields) ? a.fields.map(String) : undefined);
        const sizes = Object.entries(r.picklists).map(([k, v]) => `${k} (${v.length})`).join(', ');
        const extra = [r.unknownFields.length ? `unknown: ${r.unknownFields.join(', ')}` : '', r.notPicklists.length ? `not picklists: ${r.notPicklists.join(', ')}` : ''].filter(Boolean).join('; ');
        return { result: r, message: `${a.entity} picklists: ${sizes || 'none'}${extra ? ` — ${extra}` : ''}` };
      }],

      // Canonical record-reference resolver (read-only, tickets + tasks)
      ['autotask_resolve_record_reference', async (a) => {
        const r = await s.resolveRecordReference(a.reference);
        const message =
          r.status === 'matched'
            ? `Resolved ${r.reference} to ${r.entityType} ${r.id}${r.title ? ` — ${r.title}` : ''}`
            : r.status === 'ambiguous'
              ? `Reference ${r.reference} is ambiguous (${r.candidates?.length ?? 0} matches); no record selected`
              : `No ticket or task found for reference ${r.reference}`;
        return { result: r, message };
      }],

      // Service Calls
      ['autotask_get_service_call', async (a) => {
        const r = await s.getServiceCall(a.serviceCallId);
        if (!r) return { result: null, message: `No service call found with ID ${a.serviceCallId}` };
        return { result: r, message: 'Service call retrieved successfully' };
      }],
      ['autotask_search_service_calls', async (a) => {
        return paged(await s.searchServiceCalls(a), 'service calls');
      }],
      ['autotask_reconcile_service_call', async (a) => {
        const r = await s.reconcileServiceCall({ serviceCallId: a.serviceCallId, ticketId: a.ticketId });
        if (!r) return { result: null, message: 'No service call / linked ticket found to reconcile' };
        const msg = r.issues.length === 0
          ? `Service call ${r.serviceCallId} on ticket ${r.ticketNumber ?? r.ticketId}: no billing issues`
          : `Service call ${r.serviceCallId} on ticket ${r.ticketNumber ?? r.ticketId}: ${r.issues.join(', ')}` +
            (r.atRiskPartsValue > 0 ? ` ($${r.atRiskPartsValue} parts unfulfilled)` : '');
        return { result: r, message: msg };
      }],
      ['autotask_report_service_call_leakage', async (a) => {
        const r = await s.reportServiceCallLeakage({
          lookbackDays: a.lookbackDays, companyID: a.companyID,
          maxServiceCalls: a.maxServiceCalls, includeClean: a.includeClean, includeCompleted: a.includeCompleted,
        });
        return {
          result: r,
          message: `Scanned ${r.scanned} service call(s) since ${r.window.after} (${r.scannedOpen} open, ${r.scannedCompleted} completed); ${r.flagged} flagged — ` +
            `${r.totals.doneNotClosed} done-not-closed, ${r.totals.noTimeLogged} no-time, ${r.totals.partsUnfulfilled} parts-unfulfilled ($${r.totals.atRiskPartsValue}), ` +
            `${r.totals.unbilledTime} with unbilled time (${r.totals.unbilledHours}h)` + (r.truncated ? ' [truncated]' : ''),
        };
      }],
      ['autotask_analyze_ticket_billing_gaps', async (a) => {
        const r = await s.analyzeTicketBillingGaps(a.ticketId);
        if (!r) return { result: null, message: `Ticket ${a.ticketId} not found` };
        const msg = r.issues.length === 0
          ? `Ticket ${r.ticketNumber ?? r.ticketId}: no billing gaps`
          : `Ticket ${r.ticketNumber ?? r.ticketId}: ${r.issues.join(', ')}` +
            (r.flags.nonbillableSuspect.hours > 0 ? ` (${r.flags.nonbillableSuspect.hours}h non-billable suspect)` : '') +
            (r.flags.notesWithoutTime.count > 0 ? ` (${r.flags.notesWithoutTime.count} note(s) w/o time)` : '');
        return { result: r, message: msg };
      }],
      ['autotask_report_ticket_billing_gaps', async (a) => {
        const r = await s.reportTicketBillingGaps({
          lookbackDays: a.lookbackDays, companyID: a.companyID,
          maxTickets: a.maxTickets, includeCompleted: a.includeCompleted, includeClean: a.includeClean,
        });
        return {
          result: r,
          message: `Scanned ${r.scanned} ticket(s) active since ${r.window.after}; ${r.flagged} flagged — ` +
            `${r.totals.workNotLogged} work-not-logged, ${r.totals.noteWithoutTime} note-without-time (${r.totals.uncapturedNotes} notes), ` +
            `${r.totals.billableMarkedNonbillable} billable-marked-nonbillable (${r.totals.suspectNonbillableHours}h)` + (r.truncated ? ' [truncated]' : ''),
        };
      }],
      ['autotask_create_service_call', async (a) => {
        const id = await s.createServiceCall(a);
        return { result: id, message: `Successfully created service call with ID: ${id}` };
      }],
      ['autotask_update_service_call', async (a) => {
        const { serviceCallId, ...updates } = a;
        await s.updateServiceCall(serviceCallId, updates);
        return { result: serviceCallId, message: `Successfully updated service call ${serviceCallId}` };
      }],
      ['autotask_delete_service_call', async (a) => {
        await s.deleteServiceCall(a.serviceCallId);
        return { result: a.serviceCallId, message: `Successfully deleted service call ${a.serviceCallId}` };
      }],

      // ServiceCallTickets
      ['autotask_search_service_call_tickets', async (a) => {
        const r = await s.searchServiceCallTickets(a);
        return { result: r, message: `Found ${r.length} service call tickets` };
      }],
      ['autotask_create_service_call_ticket', async (a) => {
        const id = await s.createServiceCallTicket(a);
        return { result: id, message: `Successfully linked ticket to service call, record ID: ${id}` };
      }],
      ['autotask_delete_service_call_ticket', async (a) => {
        await s.deleteServiceCallTicket(a.serviceCallTicketId);
        return { result: a.serviceCallTicketId, message: `Successfully removed ticket from service call` };
      }],

      // ServiceCallTicketResources
      ['autotask_search_service_call_ticket_resources', async (a) => {
        const r = await s.searchServiceCallTicketResources(a);
        return { result: r, message: `Found ${r.length} service call ticket resources` };
      }],
      ['autotask_create_service_call_ticket_resource', async (a) => {
        const id = await s.createServiceCallTicketResource(a);
        return { result: id, message: `Successfully assigned resource to service call ticket, record ID: ${id}${roleIgnoredNote(a.roleID)}` };
      }],
      ['autotask_delete_service_call_ticket_resource', async (a) => {
        await s.deleteServiceCallTicketResource(a.serviceCallTicketResourceId);
        return { result: a.serviceCallTicketResourceId, message: `Successfully removed resource from service call ticket` };
      }],

      // ServiceCallTasks (schedule a project task onto the Autotask calendar)
      ['autotask_search_service_call_tasks', async (a) => {
        const r = await s.searchServiceCallTasks(a);
        return { result: r, message: `Found ${r.length} service call task(s)` };
      }],
      ['autotask_create_service_call_task', async (a) => {
        const id = await s.createServiceCallTask(a);
        return { result: id, message: `Successfully linked task to service call, record ID: ${id}` };
      }],
      ['autotask_delete_service_call_task', async (a) => {
        await s.deleteServiceCallTask(a.serviceCallTaskId);
        return { result: a.serviceCallTaskId, message: `Successfully removed task from service call` };
      }],

      // ServiceCallTaskResources
      ['autotask_search_service_call_task_resources', async (a) => {
        const r = await s.searchServiceCallTaskResources(a);
        return { result: r, message: `Found ${r.length} service call task resource(s)` };
      }],
      ['autotask_create_service_call_task_resource', async (a) => {
        const id = await s.createServiceCallTaskResource(a);
        return { result: id, message: `Successfully assigned resource to service call task, record ID: ${id}${roleIgnoredNote(a.roleID)}` };
      }],
      ['autotask_delete_service_call_task_resource', async (a) => {
        await s.deleteServiceCallTaskResource(a.serviceCallTaskResourceId);
        return { result: a.serviceCallTaskResourceId, message: `Successfully removed resource from service call task` };
      }],

      // Company To-Dos (CRM calendar follow-ups)
      ['autotask_get_company_todo', async (a) => {
        const r = await s.getCompanyToDo(a.id);
        if (!r) return { result: null, message: `No Company To-Do found with ID ${a.id}` };
        return { result: r, message: 'Company To-Do retrieved successfully' };
      }],
      ['autotask_search_company_todos', async (a) => {
        const r = await s.searchCompanyToDos(a);
        return { result: r, message: `Found ${r.length} Company To-Do(s)` };
      }],
      ['autotask_create_company_todo', async (a) => {
        const id = await s.createCompanyToDo(a);
        return { result: id, message: `Successfully created Company To-Do with ID: ${id}` };
      }],
      ['autotask_update_company_todo', async (a) => {
        const { id, companyID, ...updates } = a;
        await s.updateCompanyToDo(id, updates, companyID);
        return { result: id, message: `Successfully updated Company To-Do ${id}` };
      }],
      ['autotask_complete_company_todo', async (a) => {
        const completedDate = await s.completeCompanyToDo(a.id, a.companyID);
        return { result: { id: a.id, completedDate }, message: `Company To-Do ${a.id} marked complete (completedDate ${completedDate})` };
      }],
      ['autotask_delete_company_todo', async (a) => {
        await s.deleteCompanyToDo(a.id, a.companyID);
        return { result: a.id, message: `Successfully deleted Company To-Do ${a.id}` };
      }],


      // Time entries
      ['autotask_create_time_entry', async (a) => {
        // If no resource specified at all, prompt the user
        if (!a.resourceID && !a.resourceName) {
          return { result: null, message: 'Please specify who is logging this time. Provide a resourceName (e.g., "Will Spence") or resourceID.' };
        }
        // Resolve resourceName to resourceID via SDK helper
        let resourceName: string | null = null;
        if (a.resourceName && !a.resourceID) {
          const resource = await s.resolveResourceByName(a.resourceName);
          if (!resource) {
            throw new Error(`No resource found matching "${a.resourceName}"`);
          }
          a.resourceID = resource.id;
          resourceName = [resource.firstName, resource.lastName].filter(Boolean).join(' ') || null;
        }
        delete a.resourceName;
        // For Regular Time entries (no ticket/task/project), handle category
        const isRegularTime = !a.ticketID && !a.taskID && !a.projectID;
        if (isRegularTime) {
          if (!a.category && !a.internalBillingCodeID) {
            // List available categories and prompt user
            const categories = await s.getInternalBillingCodeNames();
            return { result: null, message: `Please specify a category for this Regular Time entry. Available categories: ${categories.join(', ')}` };
          }
          if (a.category && !a.internalBillingCodeID) {
            const billingCode = await s.resolveInternalBillingCodeByName(a.category);
            if (!billingCode) {
              const categories = await s.getInternalBillingCodeNames();
              throw new Error(`No Regular Time category matching "${a.category}". Categories (exact, case-insensitive): ${categories.join(', ')}`);
            }
            a.internalBillingCodeID = billingCode.id;
            delete a.category;
          }
          // Regular Time entries carry no ticket/task; set the entry type so
          // Autotask doesn't try to resolve a ticket/task reference (the cause of
          // the "Error finding reference Task/Ticket" 500). 5 = Activity.
          if (a.timeEntryType == null) a.timeEntryType = 5;
        }
        // Ticket/task time: default/sole role, a pick, or validate the chosen one.
        const role = await resolveTimeEntryRole(a);
        if ('stop' in role) return role.stop;
        if (a.ticketID || a.taskID) {
          const badWorkType = await checkWorkType(a.billingCodeID);
          if (badWorkType) return badWorkType;
        }
        // High-level billing intent -> Autotask field combo (explicit fields win).
        const billingTreatment = a.billingTreatment; delete a.billingTreatment;
        applyBillingTreatment(a, billingTreatment);
        // hoursToBill is read-only (Autotask derives it); kept only to warn below.
        const requestedHoursToBill = a.hoursToBill; delete a.hoursToBill;
        const written = await explainTimeEntryWrite(() => s.createTimeEntry(a));
        if ('stop' in written) return written.stop;
        const id = written.ok;
        // Rich readback so timezone/billing/role errors are visible immediately
        // (who, which role, how much, where), not just the id.
        const stored = await s.getTimeEntry(id).catch(() => null);
        if (resourceName == null && a.resourceID != null) {
          const r = await s.getResource(a.resourceID).catch(() => null) as Record<string, any> | null;
          resourceName = r ? ([r.firstName, r.lastName].filter(Boolean).join(' ') || null) : null;
        }
        const warnings: string[] = [];
        const span = durationHours(stored?.startDateTime as string | undefined, stored?.endDateTime as string | undefined);
        if (span != null && stored?.hoursWorked != null && Math.abs(span - Number(stored.hoursWorked)) > 0.02) {
          warnings.push(`hoursWorked=${stored.hoursWorked} does not match the ${span.toFixed(4)}h stored start/end interval`);
        }
        if (stored && a.roleID != null && stored.roleID != null && Number(stored.roleID) !== Number(a.roleID)) {
          warnings.push(`stored roleID ${stored.roleID} differs from the requested roleID ${a.roleID}`);
        }
        const htbWarning = hoursToBillWarning(requestedHoursToBill, stored?.hoursToBill);
        if (htbWarning) warnings.push(htbWarning);
        const result = stored
          ? {
              id,
              ticketID: stored.ticketID ?? null, taskID: stored.taskID ?? null,
              resourceID: stored.resourceID, resourceName,
              roleID: stored.roleID ?? null,
              roleName: stored.roleID != null && Number(stored.roleID) === Number(a.roleID) ? role.roleName : null,
              roleSource: role.roleSource,
              dateWorked: stored.dateWorked, startDateTime: stored.startDateTime, endDateTime: stored.endDateTime,
              hoursWorked: stored.hoursWorked, hoursToBill: (stored as any).hoursToBill,
              isNonBillable: (stored as any).isNonBillable, showOnInvoice: (stored as any).showOnInvoice,
              billingCodeID: (stored as any).billingCodeID,
              summaryNotes: stored.summaryNotes,
              ...(warnings.length ? { warnings } : {}),
            }
          : { id, resourceID: a.resourceID, resourceName, roleID: a.roleID ?? null, roleName: role.roleName, roleSource: role.roleSource };
        const roleBit = a.roleID != null ? ` as ${role.roleName ?? 'role'} (${a.roleID})` : '';
        return { result, message: `Successfully created time entry with ID: ${id}${resourceName ? ` for ${resourceName}` : ''}${roleBit}${warnings.length ? ` (warning: ${warnings.join('; ')})` : ''}` };
      }],
      ['autotask_create_task_time_entries_bulk', async (a) => {
        if (!a.taskID) return { result: null, message: 'taskID is required.' };
        if (!a.dateWorked) return { result: null, message: 'dateWorked (YYYY-MM-DD) is required.' };
        if (!Array.isArray(a.entries) || a.entries.length === 0) return { result: null, message: 'entries[] is required (one per attendee, each with hoursWorked + summaryNotes).' };
        const dryRun = a.dryRun === undefined ? true : !!a.dryRun; // dry-run first by default
        const r = await s.createTaskTimeEntriesBulk({ taskID: a.taskID, dateWorked: a.dateWorked, entries: a.entries, dryRun });
        const verb = r.dryRun ? 'DRY RUN (nothing written)' : (r.written ? 'wrote' : 'NO WRITES — fix the errors and re-run');
        const msg = `${verb}: of ${r.planned} entr(ies) on task ${r.taskID} (${r.dateWorked}) — ${r.dryRun ? r.wouldCreate + ' would create' : r.created + ' created'}, ${r.duplicates} duplicate, ${r.errors} error(s). ${r.dryRun ? 'Re-run with dryRun:false to commit.' : ''}`.trim();
        return { result: r, message: msg };
      }],
      ['autotask_log_ticket_collaboration', async (a) => {
        if (!a.ticketID) return { result: null, message: 'ticketID is required.' };
        if (!a.dateWorked) return { result: null, message: 'dateWorked (YYYY-MM-DD) is required.' };
        if (!Array.isArray(a.participants) || a.participants.length === 0) return { result: null, message: 'participants[] is required (one per contributing tech, each with hoursWorked + summaryNotes and one of resourceID/resourceName/email).' };
        if (a.note && !a.note.description) return { result: null, message: 'note.description is required when note is provided.' };
        const dryRun = a.dryRun === undefined ? true : !!a.dryRun; // dry-run first by default
        const r = await s.logTicketCollaboration({ ticketID: a.ticketID, dateWorked: a.dateWorked, participants: a.participants, note: a.note, dryRun });
        const verb = r.dryRun ? 'DRY RUN (nothing written)' : (r.written ? 'wrote' : 'NO WRITES — fix the errors and re-run');
        const noteBit = r.note ? `; note ${r.note.status}${r.note.noteId ? ` (${r.note.noteId})` : ''}` : '';
        const msg = `${verb}: of ${r.planned} participant(s) on ticket ${r.ticketID} (${r.dateWorked}) — ${r.dryRun ? r.wouldCreate + ' would create' : r.created + ' created'}, ${r.duplicates} duplicate, ${r.errors} error(s)${noteBit}. ${r.dryRun ? 'Re-run with dryRun:false to commit.' : ''}`.trim();
        return { result: r, message: msg };
      }],
      ['autotask_get_time_entry_targets', async (a) => {
        if (a.resourceID == null) return { result: null, message: 'resourceID is required (whose targets to list).' };
        const r = await s.getTimeEntryTargets({ resourceID: a.resourceID, companyID: a.companyID, projectID: a.projectID, searchTerm: a.searchTerm, maxRecords: a.maxRecords });
        return { result: r, message: `Targets for resource ${a.resourceID}: ${r.counts.tasks} open task(s), ${r.counts.tickets} open ticket(s)` };
      }],
      ['autotask_list_regular_time_categories', async () => {
        const r = await s.getRegularTimeCategories();
        const active = r.filter((c) => c.active);
        return { result: r, message: `${active.length} active Regular Time categor(y/ies): ${active.map((c) => c.name).join(', ')}` };
      }],
      ['autotask_get_my_day', async (a) => {
        if (a.resourceID == null) {
          return { result: null, message: 'Could not determine the acting user. Provide resourceID, or call as an identified user (currentUser / gateway impersonation).' };
        }
        const r = await s.getMyDay(a.resourceID, a.date, a.timeZone);
        const gaps = r.totals.missingTime ? ` — ${r.totals.missingTime} service-call ticket(s) with NO time logged: ${(r.missingTime as TimeGap[]).map((g) => g.ticketID).join(', ')}` : '';
        return { result: r, message: `${r.date}: ${r.totals.assignedTickets} assigned ticket(s), ${r.totals.serviceCalls} service call(s), ${r.totals.openTodos} open To-Do(s), ${r.totals.timeEntries} time entr(ies) (${r.totals.hoursLogged}h logged), ${r.openTasks.length} open task(s)${gaps}` };
      }],
      ['autotask_start_work_on_ticket', async (a) => {
        if (a.resourceID == null) {
          return { result: null, message: 'Could not determine who is starting work. Provide resourceID, or call as an identified user (currentUser / gateway impersonation).' };
        }
        const r = await s.startWorkOnTicket({ ticketID: a.ticketID, resourceID: a.resourceID, roleID: a.roleID, status: a.status, takeOver: a.takeOver === true, dryRun: a.dryRun === true });
        const t = r.ticketNumber ?? `ticket ${a.ticketID}`;
        const next = `When you finish, log it with autotask_log_my_time (ticketID ${a.ticketID}, startDateTime ${r.startedAt}).`;
        const assign = r.assignment === 'assigned_to_you' ? ' and assigned it to you' : r.assignment === 'taken_over' ? ' and reassigned it to you' : '';
        const message = r.status === 'started' ? `Started ${t}: status → ${r.statusLabel}${assign}. ${next}`
          : r.status === 'already_started' ? `${t} is already ${r.statusLabel} and assigned to you — nothing changed. ${next}`
          : r.status === 'dry_run' ? `DRY RUN (nothing written): would set ${t} to ${r.statusLabel}${assign}.`
          : r.status === 'invalid_status' ? `Status "${r.requested}" not found — nothing changed. Choices: ${formatChoices(r.choices ?? [])}`
          : r.status === 'not_found' ? `Ticket ${a.ticketID} not found.`
          : r.message ?? `${t}: ${r.status} — nothing changed.`;
        return { result: r, message };
      }],
      ['autotask_add_ticket_update', async (a) => {
        if (a.resourceID == null) {
          return { result: null, message: 'Could not determine who is posting the update. Provide resourceID, or call as an identified user (currentUser / gateway impersonation).' };
        }
        const text = String(a.update ?? '').trim();
        if (!text) return { result: null, message: 'update (the note text) is required — nothing written.' };
        const visibility = a.visibility ?? 'internal';
        if (!['internal', 'client', 'co-managed'].includes(visibility)) {
          return { result: null, message: `visibility must be internal (default), client or co-managed — got "${visibility}". Nothing written.` };
        }
        const plan = await s.planTicketUpdate({ ticketID: a.ticketID, status: a.status, visibility, noteType: a.noteType });
        if (!plan.ok) return { result: { status: plan.status, ...(plan.choices ? { choices: plan.choices } : {}) }, message: plan.message };

        // Optional time entry — validated (role, work type) BEFORE any write.
        const wantsTime = a.hoursWorked != null || (a.startDateTime && a.endDateTime);
        let time: Parameters<typeof s.logTimeIdempotent>[0] | null = null;
        let roleInfo: { roleName: string | null; roleSource: RoleSource | null } | null = null;
        if (wantsTime) {
          // summaryNotes is printed on the client's INVOICE. Reuse the update
          // text only when the update itself is client-visible; an internal
          // note must never leak onto an invoice by default.
          const summaryNotes = a.summaryNotes ?? (visibility === 'client' ? text : null);
          if (!summaryNotes) {
            return { result: { status: 'summary_required' }, message: 'Logging time needs summaryNotes (client/invoice-facing) — this update is internal, so its text is not reused on the invoice. Nothing written.' };
          }
          const dateWorked = await workDate(a);
          time = Object.fromEntries(Object.entries({
            ticketID: a.ticketID, resourceID: a.resourceID, roleID: a.roleID, billingCodeID: a.billingCodeID,
            hoursWorked: a.hoursWorked, startDateTime: a.startDateTime, endDateTime: a.endDateTime, offsetHours: a.offsetHours,
            summaryNotes, internalNotes: a.internalNotes, dateWorked, timeZone: a.timeZone,
          }).filter(([, v]) => v !== undefined)) as Parameters<typeof s.logTimeIdempotent>[0];
          const role = await resolveTimeEntryRole(time);
          if ('stop' in role) return role.stop;
          roleInfo = role;
          const badWorkType = await checkWorkType(time.billingCodeID);
          if (badWorkType) return badWorkType;
        }

        const tn = plan.ticket.ticketNumber ?? `ticket ${a.ticketID}`;
        const planned = {
          ticketID: a.ticketID, ticketNumber: plan.ticket.ticketNumber,
          note: { visibility, publish: plan.publish, noteType: plan.noteType, title: a.title ?? 'Update' },
          time: time ? { hoursWorked: time.hoursWorked ?? null, startDateTime: time.startDateTime ?? null, endDateTime: time.endDateTime ?? null, roleID: time.roleID ?? null, roleName: roleInfo?.roleName ?? null, dateWorked: time.dateWorked } : null,
          statusChange: plan.status ? { from: Number(plan.ticket.status), to: plan.status.value, label: plan.status.label } : null,
        };
        const steps = [`${visibility} note`, ...(time ? ['time entry'] : []), ...(plan.status ? [`status → ${plan.status.label}`] : [])];
        if (a.dryRun === true) return { result: { status: 'dry_run', ...planned }, message: `DRY RUN (nothing written) on ${tn}: ${steps.join(' + ')}.` };

        // Execute in order note → time → status, stopping at the first failure:
        // never change status (e.g. Complete) after the time entry failed.
        const done: { note?: { created: boolean; noteId: number }; time?: Awaited<ReturnType<typeof s.logTimeIdempotent>>; status?: { to: number; label: string } } = {};
        const note = await s.postTicketNoteOnce(a.ticketID, { title: a.title ?? 'Update', description: text, noteType: plan.noteType, publish: plan.publish.value });
        done.note = note;
        if (time) {
          const entry = time;
          const written = await explainTimeEntryWrite(() => s.logTimeIdempotent(entry));
          if ('stop' in written) {
            return { result: { status: 'partial', ...planned, done, timeError: written.stop.result }, message: `${tn}: note ${note.created ? `posted (${note.noteId})` : `already posted (${note.noteId})`}, but the time entry was NOT logged — ${written.stop.message}${plan.status ? ' Status left unchanged.' : ''}` };
          }
          done.time = written.ok;
        }
        if (plan.status) {
          await s.updateTicket(a.ticketID, { status: plan.status.value });
          done.status = { to: plan.status.value, label: plan.status.label };
        }
        const bits = [
          note.created ? `${visibility} note ${note.noteId} posted` : `note already posted (${note.noteId}) — not duplicated`,
          ...(done.time ? [done.time.created ? `time entry ${done.time.id} logged` : `time entry already logged (${done.time.duplicateOf})`] : []),
          ...(done.status ? [`status → ${done.status.label}`] : []),
        ];
        return { result: { status: 'updated', ...planned, done }, message: `${tn}: ${bits.join('; ')}.` };
      }],
      ['autotask_log_my_time', async (a) => {
        if (a.resourceID == null) {
          return { result: null, message: 'Could not determine who to log time as. Provide resourceID, or call as an identified user (currentUser / gateway impersonation).' };
        }
        // Regular Time (no ticket/task): resolve a category to its internal billing code (mirrors create_time_entry).
        const isRegular = !a.ticketID && !a.taskID;
        if (isRegular) {
          if (a.category && !a.internalBillingCodeID) {
            const bc = await s.resolveInternalBillingCodeByName(a.category);
            if (!bc) {
              const cats = await s.getInternalBillingCodeNames();
              throw new Error(`No category found matching "${a.category}". Available categories: ${cats.join(', ')}`);
            }
            a.internalBillingCodeID = bc.id;
          }
          if (!a.internalBillingCodeID) {
            const cats = await s.getInternalBillingCodeNames();
            return { result: null, message: `Regular Time (no ticket/task) needs a category. Available categories: ${cats.join(', ')}` };
          }
          // Regular Time entry type so Autotask doesn't expect a ticket/task (5 = Activity).
          if (a.timeEntryType == null) a.timeEntryType = 5;
        }
        delete a.category;
        // Ticket/task time: default/sole role, a pick, or validate the chosen one.
        const role = await resolveTimeEntryRole(a);
        if ('stop' in role) return role.stop;
        if (!isRegular) {
          const badWorkType = await checkWorkType(a.billingCodeID);
          if (badWorkType) return badWorkType;
        }
        const dateWorked = await workDate(a);
        const written = await explainTimeEntryWrite(() => s.logTimeIdempotent({ ...a, dateWorked }));
        if ('stop' in written) return written.stop;
        const r = written.ok;
        const roleInfo = a.roleID != null ? { roleID: a.roleID, roleName: role.roleName, roleSource: role.roleSource } : {};
        return { result: { ...r, ...roleInfo }, message: r.created ? `Logged time entry ${r.id}` : `Skipped — duplicate of existing time entry ${r.duplicateOf}` };
      }],

      // Projects
      ['autotask_search_projects', async (a) => {
        return paged(await s.searchProjects(a), 'projects');
      }],
      ['autotask_get_project', async (a) => {
        const r = await s.getProject(a.id); return { result: r, message: r ? `Project ${a.id}` : `Project ${a.id} not found` };
      }],
      ['autotask_get_project_structure', async (a) => {
        const r = await s.getProjectStructure(a.projectID);
        return { result: r, message: `Project ${a.projectID}: ${r.summary.phaseCount} phase(s), ${r.summary.taskCount} task(s), depth ${r.summary.maxPhaseDepth}` };
      }],
      ['autotask_get_complete_project_context', async (a) => {
        const r = await s.getCompleteProjectContext(a.projectID, {
          includeConfigurationItems: a.includeConfigurationItems,
          includeCommercial: a.includeCommercial,
        });
        if (!r.found) return { result: r, message: r.message };
        const errs = r.errors?.length ? `, ${r.errors.length} section error(s)` : '';
        return { result: r, message: `Project ${a.projectID} context: ${r.summary.phaseCount} phase(s), ${r.summary.taskCount} task(s), ${r.summary.dependencyCount} dependency(ies), ${r.summary.milestoneCount} milestone(s)${errs}` };
      }],
      ['autotask_get_project_labor_summary', async (a) => {
        const r = await s.getProjectLaborSummary(a.projectID);
        return { result: r, message: `Project ${a.projectID} labor: ${r.actualHours}h actual vs ${r.estimatedHours}h estimated (variance ${r.variance}h), ${r.billableHours}h billable` };
      }],
      ['autotask_export_project_blueprint', async (a) => {
        const r = await s.exportProjectBlueprint(a.projectID);
        return { result: r, message: `Blueprint of "${r.name}": ${r.phaseCount} phase(s), ${r.taskCount} task(s), ${r.estimatedHours}h` };
      }],
      ['autotask_calculate_project_schedule', async (a) => {
        // Pure/deterministic — no Autotask I/O. Schedules a caller-provided plan.
        const r = calculateProjectSchedule(a.plan, {
          startDate: a.startDate,
          hoursPerDay: a.hoursPerDay,
          defaultCrewSize: a.defaultCrewSize,
          workweek: a.workweek,
          holidays: a.holidays,
          targetCompletionDate: a.targetCompletionDate,
        });
        const warn = r.warnings.length ? `; ${r.warnings.length} warning(s)` : '';
        return {
          result: r,
          message: `Scheduled ${r.taskCount} task(s): ${r.startDate} → ${r.targetCompletionDate} (${r.durationWorkingDays} working days, ${r.totalEstimatedHours}h)${warn}`,
        };
      }],
      ['autotask_extract_project_scope', async (a) => {
        // Pure/deterministic — no Autotask I/O, no reference-project inference.
        // Section-parses a SOW into the normalized scope envelope for review.
        const r = extractProjectScope({ sowText: a.sowText, scope: a.scope, source: a.source, quantityBuckets: a.quantityBuckets });
        const counts = `${r.included.length} in / ${r.excluded.length} out / ${r.assumptions.length} assumption(s) / ${r.quantities.length} qty`;
        return {
          result: r,
          message: `Scope extracted: ${counts}. ${r.unclassified.length} unclassified; ${r.warnings.length} warning(s) — review before planning.`,
        };
      }],
      ['autotask_classify_project', async (a) => {
        // Pure/deterministic — no Autotask I/O. Keyword-scores a project/scope
        // against a caller-provided archetype set; explainable, no AI.
        const r = classifyProject({ archetypes: a.archetypes, text: a.text, scope: a.scope, minScore: a.minScore, defaultArchetype: a.defaultArchetype });
        return {
          result: r,
          message: `Classified as "${r.classification}" (${r.confidence} confidence). ${r.rationale}`,
        };
      }],
      // Webhook management (#23 §16) — read/discovery layer
      ['autotask_list_webhook_entities', async () => {
        // Pure/deterministic — the prerequisite: which entities support webhooks
        // and the REST entity names behind each (incl. the excluded-resources
        // child used for loop prevention).
        const entities = Object.values(WEBHOOK_ENTITIES).map((m) => ({
          entity: m.key, watches: m.targetEntity, webhookEntity: m.parent,
          fieldsEntity: m.fields, udfFieldsEntity: m.udfFields, excludedResourcesEntity: m.excludedResources,
        }));
        return {
          result: { entities, loopPreventionNote: 'Exclude the MCP integration user\'s resourceID via the excluded-resources child so the MCP\'s own writes do not trigger the webhook (avoids loops).' },
          message: `${entities.length} webhook-capable entit(ies): ${entities.map((e) => e.entity).join(', ')}`,
        };
      }],
      ['autotask_search_webhooks', async (a) => {
        const r = await s.searchWebhooks(a.entity, { activeOnly: a.activeOnly, pageSize: a.pageSize });
        const active = r.webhooks.filter((w) => w.isActive).length;
        return { result: r, message: `${r.webhooks.length} webhook(s) on ${r.entity} (${active} active)` };
      }],
      ['autotask_get_webhook', async (a) => {
        const r = await s.getWebhook(a.entity, a.id);
        if (!r) return { result: null, message: `Webhook ${a.id} not found on ${a.entity}` };
        return { result: r, message: `Webhook ${a.id} on ${r.entity}: ${(r.fields as any[]).length} field(s), ${(r.excludedResources as any[]).length} excluded resource(s)` };
      }],
      ['autotask_create_webhook', async (a) => {
        const r = await s.createWebhook(a.entity, {
          name: a.name, webhookUrl: a.webhookUrl, deactivationUrl: a.deactivationUrl, isActive: a.isActive,
          subscribeCreate: a.subscribeCreate, subscribeUpdate: a.subscribeUpdate, subscribeDelete: a.subscribeDelete,
          sendThresholdExceededNotification: a.sendThresholdExceededNotification, notificationEmailAddress: a.notificationEmailAddress,
          secretKey: a.secretKey,
          fields: a.fields, excludedResourceIDs: a.excludedResourceIDs, excludeSelf: a.excludeSelf, dryRun: a.dryRun,
        });
        const ex = (r.plannedExcludedResources ?? r.excludedResources) as Array<{ resourceID: number; reason: string }> | undefined;
        const exText = ex?.length ? ` — excluded resources: ${ex.map((e) => `${e.resourceID} (${e.reason})`).join(', ')}` : ` — NO excluded resources (the MCP's own writes WILL fire it)`;
        const warn = (r.warnings as string[] | undefined)?.length ? ` WARNING: ${(r.warnings as string[]).join(' ')}` : '';
        const msg = r.status === 'dry_run' ? `Dry run: would create a ${a.entity} webhook → ${a.webhookUrl} with ${(r.plannedFields as unknown[])?.length ?? 0} field(s)${exText}; secret from ${a.secretKey ? 'the argument (hidden)' : 'AUTOTASK_WEBHOOK_SECRET'}; nothing written.${warn}`
          : r.status === 'validation_failed' ? `Validation failed: ${JSON.stringify(r.errors ?? r.detail)}`
          : `Created ${a.entity} webhook ${r.webhookID}` + ((r.errors as any[])?.length ? ` with ${(r.errors as any[]).length} child error(s)` : '');
        // The receiver must verify X-Hook-Signature; point the builder of the
        // n8n flow at the tested snippet rather than a hand-rolled HMAC.
        const guide = r.status === 'validation_failed' ? '' : ` Receiver: verify the signature with the n8n Code node in ${N8N_RECEIVER_GUIDE}.`;
        return { result: { ...r, receiverGuide: N8N_RECEIVER_GUIDE }, message: msg + guide };
      }],
      ['autotask_update_webhook', async (a) => {
        const r = await s.updateWebhook(a.entity, a.id, {
          name: a.name, webhookUrl: a.webhookUrl, deactivationUrl: a.deactivationUrl, isActive: a.isActive,
          subscribeCreate: a.subscribeCreate, subscribeUpdate: a.subscribeUpdate, subscribeDelete: a.subscribeDelete,
          sendThresholdExceededNotification: a.sendThresholdExceededNotification, notificationEmailAddress: a.notificationEmailAddress,
          secretKey: a.secretKey, useEnvSecret: a.useEnvSecret,
        }, a.dryRun);
        const msg = r.status === 'dry_run' ? `Dry run: would update ${a.entity} webhook ${a.id} — ${Object.keys(r.plannedPatch as object).join(', ')}; nothing written`
          : r.status === 'validation_failed' ? `Validation failed: ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`
          : `Updated ${a.entity} webhook ${a.id}`;
        return { result: r, message: msg };
      }],
      ['autotask_delete_webhook', async (a) => {
        await s.deleteWebhook(a.entity, a.id);
        return { result: undefined, message: `Deleted ${a.entity} webhook ${a.id}` };
      }],
      ['autotask_set_webhook_excluded_resources', async (a) => {
        const r = await s.setWebhookExcludedResources(a.entity, a.webhookID, a.resourceIDs, a.mode, a.dryRun);
        const msg = r.status === 'dry_run' ? `Dry run (${a.mode ?? 'add'}): would add ${(r.wouldAddResourceIDs as any[])?.length ?? 0}, remove ${(r.wouldRemoveRowIDs as any[])?.length ?? 0} excluded resource(s) on webhook ${a.webhookID}; nothing written`
          : r.status === 'validation_failed' ? `Validation failed: ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`
          : `Excluded resources on webhook ${a.webhookID}: +${r.added}/-${r.removed}`;
        return { result: r, message: msg };
      }],
      ['autotask_calculate_bom_labor', async (a) => {
        // Pure/deterministic — no Autotask I/O. BOM quantities + caller rate
        // catalog → calculated hours per phase (+ tasks) for the labor plan.
        const r = computeBomLabor({ items: a.items, rates: a.rates, defaultHoursPerUnit: a.defaultHoursPerUnit, defaultPhaseRef: a.defaultPhaseRef });
        return {
          result: r,
          message: `Calculated ${r.totalHours}h from ${r.matchedItems}/${r.lines.length} matched item(s) across ${Object.keys(r.byPhase).length} phase(s); ${r.unmatched.length} unmatched${r.warnings.length ? `; ${r.warnings.length} warning(s)` : ''}`,
        };
      }],
      ['autotask_generate_project_labor_plan', async (a) => {
        // Pure/deterministic — no Autotask I/O. Compares planned vs quoted vs
        // calculated labor for a caller-provided plan.
        const r = generateProjectLaborPlan({
          plan: a.plan,
          quotedHoursByPhase: a.quotedHoursByPhase,
          calculatedHoursByPhase: a.calculatedHoursByPhase,
          quotedHoursTotal: a.quotedHoursTotal,
          calculatedHoursTotal: a.calculatedHoursTotal,
          varianceThresholdPct: a.varianceThresholdPct,
        });
        const q = r.totals.quotedHours != null ? ` vs ${r.totals.quotedHours}h quoted` : '';
        return {
          result: r,
          message: `Labor plan: ${r.totals.plannedHours}h planned${q} across ${r.phases.length} phase(s); ${r.flaggedPhases} flagged for variance (>${Math.round(r.varianceThresholdPct * 100)}%)`,
        };
      }],
      ['autotask_create_project', async (a) => {
        const projectData = { ...a };
        // Map startDate/endDate (YYYY-MM-DD) to startDateTime/endDateTime (ISO) expected by the API
        if (projectData.startDate && !projectData.startDateTime) {
          projectData.startDateTime = `${projectData.startDate}T00:00:00Z`;
          delete projectData.startDate;
        }
        if (projectData.endDate && !projectData.endDateTime) {
          projectData.endDateTime = `${projectData.endDate}T00:00:00Z`;
          delete projectData.endDate;
        }
        const id = await s.createProject(projectData); return { result: id, message: `Successfully created project with ID: ${id}` };
      }],
      ['autotask_update_project', async (a) => {
        const { projectId, ...rest } = a;
        const updates: Record<string, any> = {};
        // Only fields Autotask actually accepts on Projects reach the API
        // (verified against entityInformation). `estimatedTime` is read-only
        // there, and assignedResourceID/assignedResourceRoleID are Task fields,
        // not Project ones — all three were being forwarded and doing nothing.
        // They stay accepted as arguments so existing callers do not break, but
        // are no longer sent upstream.
        for (const key of [
          'projectName',
          'description',
          'status',
          'statusDetail',
          'projectLeadResourceID',
          'startDateTime',
          'endDateTime',
          'contractID',
          'opportunityID',
          'purchaseOrderNumber',
          'userDefinedFields'
        ]) {
          if (rest[key] !== undefined) updates[key] = rest[key];
        }
        // The Projects field is `department`, not `departmentID`; the advertised
        // spelling was silently dropped. Accept either.
        const department = rest.department ?? rest.departmentID;
        if (department !== undefined) updates.department = department;
        await s.updateProject(projectId, updates);
        return { result: undefined, message: `Successfully updated project ID: ${projectId}` };
      }],
      ['autotask_create_configuration_item', async (a) => {
        const id = await s.createConfigurationItem(a);
        return { result: id, message: `Successfully created configuration item with ID: ${id}` };
      }],
      ['autotask_update_configuration_item', async (a) => {
        const { id, ...updates } = a;
        await s.updateConfigurationItem(id, updates);
        return { result: id, message: `Successfully updated configuration item ${id}` };
      }],
      ['autotask_link_project_commercial', async (a) => {
        const r = await s.linkProjectCommercial(a);
        return { result: r, message: `Project commercial linkage: ${r.status}` };
      }],
      ['autotask_build_project_from_plan', async (a) => {
        const r = await s.buildProjectFromPlan({
          plan: a.plan, companyID: a.companyID, buildKey: a.buildKey,
          projectDefaults: a.projectDefaults, dryRun: a.dryRun,
        });
        const sm = r.summary as Record<string, number> | undefined;
        const msg =
          r.status === 'dry_run' ? `Dry run OK — would create ${r.plannedPhases} phase(s), ${r.plannedTasks} task(s), ${r.plannedDependencies} dependency link(s)${r.existingProjectId ? ` (resuming project ${r.existingProjectId})` : ''}; nothing written`
          : r.status === 'validation_failed' ? `Validation failed at step "${r.step}": ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`
          : r.status === 'built' ? `Built project ${r.projectId}: +${sm?.phasesCreated} phase(s), +${sm?.tasksCreated} task(s), +${sm?.dependenciesCreated} dependency link(s)${r.resumed ? ' (resumed)' : ''}`
          : r.status === 'built_with_errors' ? `Built project ${r.projectId} with ${(r.errors as any[])?.length} error(s): +${sm?.tasksCreated} task(s), +${sm?.phasesCreated} phase(s) — re-run to complete`
          : `Build result: ${r.status}`;
        return { result: r, message: msg };
      }],
      ['autotask_extend_project', async (a) => {
        const r = await s.extendProject({ projectID: a.projectID, plan: a.plan, dryRun: a.dryRun });
        const sm = r.summary as Record<string, number> | undefined;
        const msg =
          r.status === 'dry_run' ? `Dry run OK — would add ${(r.wouldAddPhases as any[])?.length ?? 0} phase(s), ${(r.wouldAddTasks as any[])?.length ?? 0} task(s) to project ${r.projectId} (${r.plannedDependencies} dependency link(s)); nothing written`
          : r.status === 'validation_failed' ? `Validation failed at step "${r.step}": ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`
          : r.status === 'extended' ? `Extended project ${r.projectId}: +${sm?.phasesCreated} phase(s), +${sm?.tasksCreated} task(s), +${sm?.dependenciesCreated} dependency link(s)`
          : r.status === 'extended_with_errors' ? `Extended project ${r.projectId} with ${(r.errors as any[])?.length} error(s): +${sm?.tasksCreated} task(s), +${sm?.phasesCreated} phase(s) — re-run to complete`
          : `Extend result: ${r.status}`;
        return { result: r, message: msg };
      }],

      // Resources
      ['autotask_search_resources', async (a) => {
        return paged(await s.searchResources(a), 'resources');
      }],
      ['autotask_search_roles', async (a) => {
        const r = await s.searchRoles({ searchTerm: a.searchTerm, isActive: a.isActive, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} role(s)` };
      }],
      ['autotask_get_resource_roles', async (a) => {
        const r = await s.getResourceRoles(a.resourceID);
        const summary = r.map((x) => `${x.roleID}=${x.roleExists === false ? '(hidden system role — not for time entry)' : (x.roleName ?? '?')}${x.departmentName ? ` [${x.departmentName}]` : ''}${x.isDefaultServiceDeskRole ? ' (default)' : ''}`).join('; ');
        return { result: r, message: `Resource ${a.resourceID} has ${r.length} role association(s): ${summary}` };
      }],
      ['autotask_report_resource_burden', async (a) => {
        const r = await s.reportResourceBurden({ includeInactive: a.includeInactive, includeApiUsers: a.includeApiUsers, resourceType: a.resourceType, resourceIDs: a.resourceIDs });
        return { result: r, message: `${r.count} resource(s): ${r.withCost} with internalCost, ${r.missingCost} without${r.apiUsersExcluded ? ` (${r.apiUsersExcluded} API account(s) excluded)` : ''}.` };
      }],

      // Configuration Items
      ['autotask_search_configuration_items', async (a) => {
        const r = await s.searchConfigurationItems(a); return { result: r, message: `Found ${r.length} configuration items` };
      }],
      ['autotask_get_configuration_item', async (a) => {
        const ci = await s.getConfigurationItem(a.configurationItemId);
        if (!ci) return { result: null, message: `No configuration item found with ID ${a.configurationItemId}` };
        if (a.enrichReferences) {
          const _enriched = await s.enrichConfigurationItemReferences(ci);
          return { result: { ...ci, _enriched }, message: `Retrieved configuration item ${a.configurationItemId} (enriched)` };
        }
        return { result: ci, message: `Retrieved configuration item ${a.configurationItemId}` };
      }],
      ['autotask_get_configuration_item_entitlement', async (a) => {
        const r = await s.getConfigurationItemEntitlement(a.configurationItemId);
        const msg = !r.found ? `Configuration item ${a.configurationItemId} not found`
          : `CI ${a.configurationItemId}: ${r.isEntitled ? 'entitled' : 'not entitled'} (${r.reason})`;
        return { result: r, message: msg };
      }],
      ['autotask_search_configuration_item_coverage_gaps', async (a) => {
        const r = await s.searchConfigurationItemCoverageGaps({ companyID: a.companyID, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} active uncovered configuration item(s)` };
      }],
      ['autotask_create_maintenance_ticket', async (a) => {
        const r = await s.createMaintenanceTicket(a);
        const msg = r.status === 'created' ? `Created maintenance ticket ${r.id}`
          : r.status === 'duplicate' ? `Occurrence already exists (${(r.existingTickets as any[])?.length} ticket(s) with externalID "${a.externalID}") — no duplicate created`
          : r.status === 'dry_run' ? `Dry run OK — validated ${(r.validation as any[])?.length} step(s); nothing written`
          : `Validation failed at step "${r.step}": ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`;
        return { result: r, message: msg };
      }],

      // Contracts
      ['autotask_search_contracts', async (a) => {
        const r = await s.searchContracts(a); return { result: r, message: `Found ${r.length} contracts` };
      }],
      ['autotask_get_contract', async (a) => {
        const r = await s.getContract(a.id); return { result: r, message: `Retrieved contract ${a.id}` };
      }],
      ['autotask_list_expiring_contracts', async (a) => {
        const r = await s.listExpiringContracts(a);
        return { result: r, message: `Found ${r.length} contracts with end dates within ${a.daysAhead ?? 60} days` };
      }],
      ['autotask_report_block_hour_usage', async (a) => {
        const r = await s.getBlockHourUsage({ contractID: a.contractID, companyID: a.companyID, includeInactive: a.includeInactive });
        const over = r.filter((c) => (c.billableOverageHours ?? 0) > 0).length;
        return { result: r, message: `Block-hour usage for ${r.length} contract(s); ${over} over block hours` };
      }],
      ['autotask_report_ticket_charges', async (a) => {
        const r = await s.getTicketChargesReport({ sinceDays: a.sinceDays, status: a.status, unbilledOnly: a.unbilledOnly, companyID: a.companyID });
        return { result: r, message: `${r.totalCharges} charge(s) on ${r.ticketsWithCharges} ticket(s); ${r.unbilled} unbilled ($${r.unbilledBillable})` };
      }],
      ['autotask_report_unbilled', async (a) => {
        const r = await s.getUnbilledReport({ companyID: a.companyID, minAgeDays: a.minAgeDays });
        return { result: r, message: `$${r.totalAmount} unbilled across ${r.totalCount} item(s); $${r.atRiskAmount} at risk (>30d)` };
      }],
      ['autotask_report_unbilled_time', async (a) => {
        const r = await s.reportUnbilledTime({ fromDate: a.fromDate, toDate: a.toDate, resourceID: a.resourceID, includeApproved: a.includeApproved });
        const v = r.totals.estValue != null ? `~$${r.totals.estValue} est. value` : 'value n/a (no bill rates)';
        const bb = r.byContractBasis;
        // Surface the contract-basis split, leading with no_contract — time on a
        // company with NO contract is billable-until-proven-otherwise, not absorbed.
        const basis = bb
          ? ` Basis: ${r.totals.needsReviewHours}h needs review (${bb.no_contract.billableHours}h no-contract, ${bb.billed.billableHours}h billed, ${bb.block.billableHours}h block, ${bb.unknown.billableHours}h unknown); ${bb.absorbed.billableHours}h absorbed + ${bb.umbrella.billableHours}h umbrella by design.`
          : '';
        return { result: r, message: `${r.totals.billableHours}h unapproved billable across ${r.totals.entries} entr(ies) / ${r.byResource.length} resource(s); ${v}; ${r.totals.atRiskHours}h >30d.${basis}` };
      }],
      ['autotask_report_sla_compliance', async (a) => {
        const r = await s.getSlaCompliance({ from: a.from, to: a.to, companyID: a.companyID, queueID: a.queueID, openOnly: a.openOnly, groupBy: a.groupBy, maxTickets: a.maxTickets });
        const tr = r.stages.triage, en = r.stages.engagement, rv = r.stages.resolved;
        const pct = (a2: any) => a2.compliancePct == null ? 'n/a' : `${a2.compliancePct}%`;
        const rm = r.responseMetrics;
        const base = r.targetsConfigured === 0
          ? `No SLA targets configured on ${r.ticketsEvaluated} ticket(s) — compliance n/a`
          : `SLA over ${r.ticketsEvaluated} ticket(s) (${r.targetsConfigured} with targets): triage ${pct(tr)}, engagement ${pct(en)}, resolved ${pct(rv)}; ${r.breaches.length} open breach(es)`;
        return { result: r, message: `${base}. Actual: median ${rm.medianHoursToFirstResponse ?? 'n/a'}h to first response, ${rm.medianHoursToResolve ?? 'n/a'}h to resolve${r.truncated ? ' [truncated]' : ''}` };
      }],
      ['autotask_generate_sla_framework', async (a) => {
        // Pure/deterministic — no Autotask I/O. Produces an ITIL-standard SLA spec
        // (priority matrix + clean scheme + target matrix) to enter in the UI.
        const r = generateSlaFramework({
          levels: a.levels,
          requestTypes: a.requestTypes,
          tiers: a.tiers,
          currentPriorities: a.currentPriorities,
          businessHoursPerDay: a.businessHoursPerDay,
          serviceRequestResolutionMultiplier: a.serviceRequestResolutionMultiplier,
          overrides: a.overrides,
        });
        const mig = r.priorityMigration ? `; mapped ${r.priorityMigration.length} current priority value(s)` : '';
        return {
          result: r,
          message: `ITIL SLA framework: ${r.priorityScheme.length}-level priority scheme + ${r.targets.length} target row(s) across ${new Set(r.targets.map((t) => t.tier)).size} tier(s). Advisory only — enter in the Autotask UI${mig}.`,
        };
      }],
      ['autotask_search_notification_history', async (a) => {
        const r = await s.searchNotificationHistory({
          ticketID: a.ticketID, timeEntryID: a.timeEntryID, taskID: a.taskID, projectID: a.projectID,
          initiatingResourceID: a.initiatingResourceID, recipientEmail: a.recipientEmail, templateName: a.templateName,
          from: a.from, to: a.to, page: a.page, pageSize: a.pageSize,
        });
        const ext = r.sends.filter((x) => x.toExternal).length;
        const msg = r.totalSends === 0
          ? 'No notification e-mails found for that scope — Autotask sent nothing matching (the API cannot send notifications; only UI actions and workflow rules do).'
          : `Found ${r.totalSends} notification send(s) (${r.rowsScanned} recipient rows); showing ${r.sends.length}, newest first${r.internalDomains.length ? ` — ${ext} on this page reached someone outside ${r.internalDomains.join(', ')}` : ''}${r.truncated ? '. Row cap reached — narrow the scope for older sends' : ''}.`;
        return { result: r, message: msg, pagination: { page: r.page, pageSize: r.pageSize, hasMore: r.hasMore } };
      }],
      ['autotask_report_activity_without_time', async (a) => {
        const ids: number[] = Array.isArray(a.resourceIDs) ? a.resourceIDs.map(Number).filter(Number.isFinite) : [];
        if (a.resourceID != null) ids.unshift(Number(a.resourceID));
        const resourceIDs = [...new Set(ids)].slice(0, 10);
        if (!resourceIDs.length) return { result: null, message: 'resourceID (or resourceIDs, up to 10) is required — whose activity to audit.' };
        const r = await s.reportActivityWithoutTime({
          resourceIDs, from: a.from, to: a.to, timeZone: a.timeZone,
          toleranceDays: a.toleranceDays, minConfidence: a.minConfidence, includeMonitoring: a.includeMonitoring,
          includeInternal: a.includeInternal, staleDays: a.staleDays,
        });
        const per = r.resources.map((x) => `${x.resourceName ?? `Resource ${x.resourceID}`}: ${x.counts.high} high / ${x.counts.medium} medium (${x.hoursLogged} h logged)`).join('; ');
        return { result: r, message: `Activity without time ${r.from}..${r.to}: ${r.totals.high} high-confidence and ${r.totals.medium} medium gap(s) — ${per}. Each gap is a lead to confirm before backfilling.` };
      }],
      ['autotask_report_time_entry_compliance', async (a) => {
        const r = await s.getTimeEntryComplianceReport({
          from: a.from, to: a.to, bucket: a.bucket, resourceID: a.resourceID,
          expectedHoursPerBucket: a.expectedHoursPerBucket, expectedHoursPerWeek: a.expectedHoursPerWeek,
          lateThresholdDays: a.lateThresholdDays, maxEntries: a.maxEntries,
        });
        const o = r.overall;
        return {
          result: r,
          message: `Time entry over ${r.resourcesEvaluated} resource(s), ${r.bucketsCovered.length} ${r.bucket}(s): ${o.totalHours}h logged (${o.billableHours}h billable), ${o.unapprovedHours}h unapproved, ${o.lateEntries} late entr(y/ies); ${r.flagged.length} resource(s) flagged${r.truncated ? ' [truncated]' : ''}`,
        };
      }],
      ['autotask_report_request_segmentation', async (a) => {
        const r = await s.getRequestSegmentation({
          from: a.from, to: a.to, companyID: a.companyID, queueID: a.queueID, openOnly: a.openOnly,
          segments: a.segments, defaultSegmentName: a.defaultSegmentName, maxTickets: a.maxTickets,
        });
        const top = r.segments.slice(0, 3).map((s2) => `${s2.name} ${s2.total}${s2.sharePct != null ? ` (${s2.sharePct}%)` : ''}`).join(', ');
        return {
          result: r,
          message: `Segmented ${r.ticketsEvaluated} ticket(s) into ${r.segments.length} segment(s) [${r.rulesUsed}]: ${top}${r.segments.length > 3 ? ', …' : ''}${r.truncated ? ' [truncated]' : ''}`,
        };
      }],
      ['autotask_report_ticket_throughput', async (a) => {
        const r = await s.getTicketThroughput({
          from: a.from, to: a.to, companyID: a.companyID, queueID: a.queueID,
          agingThresholds: a.agingThresholds, groupBy: a.groupBy, maxTickets: a.maxTickets,
        });
        const f = r.flow;
        const rt = f.completionRatio != null ? `${Math.round(f.completionRatio * 100)}%` : 'n/a';
        return {
          result: r,
          message: `Flow ${r.from}→${r.to}: ${f.created} created / ${f.completed} completed (${rt}), net backlog ${f.netBacklogChange >= 0 ? '+' : ''}${f.netBacklogChange}. Open now: ${r.backlog.open} (oldest ${r.backlog.oldestOpenDays ?? 'n/a'}d)${r.truncated ? ' [truncated]' : ''}`,
        };
      }],
      ['autotask_report_tickets_needing_scheduling', async (a) => {
        const r = await s.getTicketsNeedingScheduling({
          companyID: a.companyID, queueID: a.queueID, ticketType: a.ticketType,
          requireHoursToSchedule: a.requireHoursToSchedule, groupBy: a.groupBy, maxTickets: a.maxTickets,
        });
        return {
          result: r,
          message: `${r.needsScheduling.length} of ${r.ticketsEvaluated} open ticket(s) need scheduling (${r.counts.unscheduled} no service call, ${r.counts.pastServiceCall} stale); ${r.totalHoursToSchedule}h to schedule${r.truncated ? ' [truncated]' : ''}`,
        };
      }],
      ['autotask_report_sla_coverage', async (a) => {
        const r = await s.getContractSlaCoverage({ companyID: a.companyID, status: a.status, activeOnly: a.activeOnly, maxContracts: a.maxContracts });
        const msg = r.readiness === 'no_sla_definitions'
          ? `No SLA definitions in this tenant — define them in the UI first (${r.contractsEvaluated} contract(s) checked)`
          : `${r.linked}/${r.contractsEvaluated} contract(s) linked to an SLA; ${r.unlinked} unlinked${r.truncated ? ' [truncated]' : ''}`;
        return { result: r, message: msg };
      }],
      ['autotask_assign_contract_sla', async (a) => {
        const r = await s.assignContractSla({ assignments: a.assignments, serviceLevelAgreementID: a.serviceLevelAgreementID, contractIDs: a.contractIDs, dryRun: a.dryRun });
        const detail = (d: unknown) => typeof d === 'string' ? d : (d as any)?.message ?? JSON.stringify(d);
        const msg = r.status === 'dry_run' ? `Dry run: would assign an SLA to ${(r.plannedAssignments as any[])?.length ?? 0} contract(s); nothing written`
          : r.status === 'validation_failed' ? `Validation failed at "${r.step}": ${detail(r.detail)}`
          : `Assigned an SLA to ${r.assigned} contract(s)` + ((r.errors as any[])?.length ? ` with ${(r.errors as any[]).length} error(s)` : '');
        return { result: r, message: msg };
      }],
      ['autotask_report_project_pl', async (a) => {
        const r = await s.getProjectPL({ projectID: a.projectID, taskId: a.taskId, ticketId: a.ticketId, bucket: a.bucket, from: a.from, to: a.to });
        const t = r.totals;
        const cov = r.costCoverage.hoursNoBurden > 0 ? ` — ${r.costCoverage.hoursNoBurden}h with NO burden set (cost understated)` : '';
        const pend = t.pendingBillableHours > 0 ? `; ${t.pendingBillableHours}h pending/unposted` : '';
        return { result: r, message: `${r.scope} ${r.entityId} P&L (${r.bucket}): $${t.postedRevenue} revenue − $${t.totalCost} cost = $${t.realizedMargin} margin${t.marginPct != null ? ` (${Math.round(t.marginPct * 100)}%)` : ''} over ${r.buckets.length} ${r.bucket}(s)${pend}${cov}` };
      }],
      ['autotask_report_inventory_reorder', async (a) => {
        const r = await s.getInventoryReorder({ locationID: a.locationID, warehouseOnly: a.warehouseOnly });
        return { result: r, message: `${r.count} product/location line(s) below minimum; est order cost $${r.totalEstCost}` };
      }],
      ['autotask_report_inventory_closeouts', async (a) => {
        const r = await s.getInventoryCloseouts({ includeGenerics: a.includeGenerics });
        return { result: r, message: `${r.count} to-order charge(s) already in stock (${r.generics} generic/flagged)` };
      }],
      ['autotask_report_inventory_stale', async (a) => {
        const r = await s.getInventoryStale({ staleDays: a.staleDays, recentDays: a.recentDays });
        return { result: r, message: `${r.staleCount} stale product(s) of ${r.count} on hand; $${r.staleValue} tied up — ${r.phantomCount} phantom ($${r.phantomValue}, never decremented) vs ${r.deadStockCount} dead-stock ($${r.deadStockValue})` };
      }],
      ['autotask_create_contracts_bulk', async (a) => {
        const r = await s.createContracts(a.contracts);
        const ok = r.filter((item) => item.success).length;
        return { result: r, message: `Created ${ok}/${r.length} contracts` };
      }],
      ['autotask_create_contract', async (a) => {
        const id = await s.createContract(a); return { result: id, message: `Successfully created contract with ID: ${id}` };
      }],
      ['autotask_update_contract', async (a) => {
        const { id, ...rest } = a;
        await s.updateContract(id, rest); return { result: undefined, message: `Successfully updated contract ID: ${id}` };
      }],
      ['autotask_create_contract_service', async (a) => {
        const id = await s.createContractService(a); return { result: id, message: `Successfully created contract service with ID: ${id}` };
      }],
      ['autotask_update_contract_service', async (a) => {
        const { id, ...rest } = a;
        await s.updateContractService(id, rest); return { result: undefined, message: `Successfully updated contract service ID: ${id}` };
      }],
      ['autotask_get_contract_service', async (a) => {
        const r = await s.getContractService(a.id);
        return { result: r, message: r ? `Retrieved contract service ${a.id}` : `Contract service ${a.id} not found` };
      }],
      ['autotask_search_contract_services', async (a) => {
        const r = await s.searchContractServices({ contractID: a.contractID, serviceID: a.serviceID, quoteItemID: a.quoteItemID, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} contract service(s)` };
      }],
      ['autotask_get_contract_billed_units', async (a) => {
        const r = await s.getContractBilledUnits({
          contractID: a.contractID, contractServiceID: a.contractServiceID,
          startAfter: a.startAfter, startBefore: a.startBefore,
          includeBundles: a.includeBundles, pageSize: a.pageSize,
        });
        return { result: r, message: `${r.totalServiceUnits} service + ${r.totalBundleUnits} bundle unit row(s); $${r.totalBilled} billed` };
      }],
      ['autotask_report_contract_recurring_revenue', async (a) => {
        const r = await s.getContractRecurringRevenue({ contractID: a.contractID, asOfDate: a.asOfDate });
        return { result: r, message: `MRR $${r.mrr} / ARR $${r.arr} across ${r.activeLineCount} active recurring line(s) as of ${r.asOf}` };
      }],
      ['autotask_report_contract_labour_basis', async (a) => {
        const r = await s.reportContractLabourBasis({ companyID: a.companyID, includeInactive: a.includeInactive, contractType: a.contractType });
        const b = r.byBasis;
        return { result: r, message: `${r.count} contract(s): ${b.billed} billed, ${b.block} block, ${b.absorbed} absorbed, ${b.umbrella} umbrella, ${b.unknown} unknown.` };
      }],
      ['autotask_get_contract_milestone', async (a) => {
        const r = await s.getContractMilestone(a.id); return { result: r, message: r ? `Contract milestone ${a.id}` : `Contract milestone ${a.id} not found` };
      }],
      ['autotask_search_contract_milestones', async (a) => {
        const r = await s.searchContractMilestones({ contractID: a.contractID, status: a.status, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} contract milestone(s)` };
      }],
      ['autotask_create_contract_milestone', async (a) => {
        const id = await s.createContractMilestone(a); return { result: id, message: `Successfully created contract milestone with ID: ${id}` };
      }],
      ['autotask_update_contract_milestone', async (a) => {
        const { id, ...rest } = a;
        await s.updateContractMilestone(id, rest); return { result: undefined, message: `Successfully updated contract milestone ${id}` };
      }],

      // Raw REST passthrough (escape hatch)
      ['autotask_raw_request', async (a) => {
        noteRawRequest(a.method, a.path); // admin console "Tool gaps"
        // The typed create_company refuses junk names ("Gmail", greetings…); raw_request writes to /Companies used to skip that.
        const bad = rawCompanyWriteProblem(a.method, a.path, a.body);
        if (bad) return { result: { status: 'refused', reason: bad }, message: `Refused: ${bad}. Not sent to Autotask — route this to manual review (a consumer email domain is never a company).` };
        const r = await s.rawRequest(a.method, a.path, a.body, a.queryParams);
        return { result: r, message: `Autotask ${a.method} ${a.path} completed` };
      }],

      // Invoices
      ['autotask_search_invoices', async (a) => {
        const r = await s.searchInvoices(a); return { result: r, message: `Found ${r.length} invoices` };
      }],
      ['autotask_get_invoice_details', async (a) => {
        const r = await s.getInvoiceDetails(a.invoiceId);
        const count = r?.lineItems?.length ?? 0;
        const tix = r?.linkedTicketIDs?.length ?? 0;
        return { result: r, message: r ? `Invoice ${a.invoiceId}: ${count} line item(s), ${tix} linked ticket(s)` : `Invoice ${a.invoiceId} not found` };
      }],

      // Tasks
      ['autotask_search_tasks', async (a) => {
        return paged(await s.searchTasks(a), 'tasks');
      }],
      ['autotask_create_task', async (a) => {
        const taskData = { ...a, taskType: a.taskType ?? 1 };
        const id = await s.createTask(taskData); return { result: id, message: `Successfully created task with ID: ${id}` };
      }],
      ['autotask_get_task', async (a) => {
        const r = await s.getTask(a.id); return { result: r, message: r ? `Task ${a.id}` : `Task ${a.id} not found` };
      }],
      ['autotask_get_task_by_number', async (a) => {
        const r = await s.getTaskByNumber(a.taskNumber);
        const msg = r.status === 'found'
          ? `Task ${r.taskNumber} → id ${r.task?.id}`
          : r.status === 'ambiguous'
            ? `Multiple tasks match ${r.taskNumber} — pick by id: ${(r.matches || []).map((m) => m.id).join(', ')}`
            : `No task found with number ${r.taskNumber}`;
        return { result: r, message: msg };
      }],
      ['autotask_update_task', async (a) => {
        const { id, ...rest } = a; await s.updateTask(id, rest); return { result: undefined, message: `Successfully updated task ${id}` };
      }],
      ['autotask_complete_task', async (a) => {
        await s.completeTask(a.id, { projectID: a.projectID, statusId: a.statusId });
        return { result: undefined, message: `Task ${a.id} marked complete` };
      }],
      ['autotask_verify_task_time_entries', async (a) => {
        if (!a.taskID) return { result: null, message: 'taskID is required.' };
        if (!a.dateWorked) return { result: null, message: 'dateWorked (YYYY-MM-DD) is required.' };
        const r = await s.verifyTaskTimeEntries(a.taskID, a.dateWorked, a.expectedResourceIDs);
        const msg = a.expectedResourceIDs?.length
          ? `Task ${a.taskID} (${a.dateWorked}): ${r.found}/${r.expected} expected present, ${r.missingResourceIDs.length} missing, ${r.duplicateResourceIDs.length} duplicate`
          : `Task ${a.taskID} (${a.dateWorked}): ${r.entries.length} entr(ies) across ${r.found} resource(s)`;
        return { result: r, message: msg };
      }],
      ['autotask_close_meeting_task', async (a) => {
        if (!a.taskID) return { result: null, message: 'taskID is required.' };
        const dryRun = a.dryRun === undefined ? true : !!a.dryRun; // dry-run first by default
        const r = await s.closeMeetingTask({
          taskID: a.taskID,
          projectID: a.projectID,
          dateWorked: a.dateWorked,
          expectedResourceIDs: a.expectedResourceIDs,
          requireTimeEntries: a.requireTimeEntries,
          relatedTicketIDs: a.relatedTicketIDs,
          closeoutNote: a.closeoutNote,
          closeoutNoteTitle: a.closeoutNoteTitle,
          closeoutNoteType: a.closeoutNoteType,
          closeoutNotePublish: a.closeoutNotePublish,
          requireCloseoutNote: a.requireCloseoutNote,
          dryRun,
        });
        let msg: string;
        if (r.status === 'dry_run') msg = r.wouldClose ? `DRY RUN: task ${r.taskID} would close (no blockers). Re-run with dryRun:false to close.` : `DRY RUN: task ${r.taskID} would be BLOCKED — ${r.blockers.join('; ')}`;
        else if (r.status === 'blocked') msg = `BLOCKED — not closed: ${r.blockers.join('; ')}`;
        else if (r.status === 'already_complete') msg = `Task ${r.taskID} is already complete — nothing to do.`;
        else if (r.status === 'closed') msg = `Task ${r.taskID} closed${r.noteId ? ` (closeout note ${r.noteId})` : ''}.`;
        else msg = r.error || 'error';
        return { result: r, message: msg };
      }],
      ['autotask_list_task_resources', async (a) => {
        const r = await s.listTaskResources(a.taskID); return { result: r, message: `${r.length} secondary resource(s) on task ${a.taskID}` };
      }],
      ['autotask_add_task_resource', async (a) => {
        const id = await s.addTaskResource(a.taskID, a.resourceID, a.roleID); return { result: id, message: `Added resource ${a.resourceID} to task ${a.taskID} (row ${id})` };
      }],
      ['autotask_remove_task_resource', async (a) => {
        await s.removeTaskResource(a.id); return { result: undefined, message: `Removed task resource row ${a.id}` };
      }],
      ['autotask_list_task_predecessors', async (a) => {
        const r = await s.listTaskPredecessors(a.taskID); return { result: r, message: `${r.length} predecessor(s) for task ${a.taskID}` };
      }],
      ['autotask_add_task_predecessor', async (a) => {
        const id = await s.addTaskPredecessor(a.successorTaskID, a.predecessorTaskID, a.lagDays); return { result: id, message: `Task ${a.predecessorTaskID} → ${a.successorTaskID} (row ${id})` };
      }],
      ['autotask_remove_task_predecessor', async (a) => {
        await s.removeTaskPredecessor(a.id); return { result: undefined, message: `Removed task predecessor row ${a.id}` };
      }],
      ['autotask_get_task_predecessor', async (a) => {
        const r = await s.getTaskPredecessor(a.id); return { result: r, message: r ? `Task predecessor row ${a.id}` : `Task predecessor row ${a.id} not found` };
      }],
      ['autotask_search_task_predecessors', async (a) => {
        const r = await s.searchTaskPredecessors({ successorTaskID: a.successorTaskID, predecessorTaskID: a.predecessorTaskID, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} task predecessor row(s)` };
      }],
      ['autotask_update_task_predecessor', async (a) => {
        await s.updateTaskPredecessor(a.id, a.lagDays); return { result: undefined, message: `Updated task predecessor row ${a.id} (lagDays=${a.lagDays})` };
      }],

      // Phases
      ['autotask_list_phases', async (a) => {
        return paged(await s.searchPhases(a.projectID, { page: a.page, pageSize: a.pageSize }), 'phases');
      }],
      ['autotask_create_phase', async (a) => {
        const id = await s.createPhase(a); return { result: id, message: `Successfully created phase with ID: ${id}` };
      }],
      ['autotask_get_phase', async (a) => {
        const r = await s.getPhase(a.id); return { result: r, message: r ? `Phase ${a.id}` : `Phase ${a.id} not found` };
      }],
      ['autotask_update_phase', async (a) => {
        const { id, ...rest } = a; await s.updatePhase(id, rest); return { result: undefined, message: `Successfully updated phase ${id}` };
      }],

      // Notes (ticket/project/company)
      ['autotask_get_ticket_note', async (a) => {
        const r = await s.getTicketNote(a.ticketId, a.noteId); return { result: r, message: 'Ticket note retrieved successfully' };
      }],
      ['autotask_search_ticket_notes', async (a) => {
        const pageSize = Math.min(Math.max(Number(a.pageSize) || 25, 1), 100);
        if (a.includeSystemNotes === true) {
          const r = await s.labelTicketNotes(await s.searchTicketNotes(a.ticketId, { pageSize }));
          return { result: r, message: `Found ${r.length} ticket notes (system notes included)` };
        }
        // Hide Autotask bookkeeping (workflow-rule / notification / forward
        // notes). Read one full page so pageSize counts HUMAN notes, and say how
        // many were hidden — a silent drop would read as "that's all there is".
        const { human, systemHidden } = partitionTicketNotes(await s.searchTicketNotes(a.ticketId, { pageSize: 500 }));
        const r = await s.labelTicketNotes(human.slice(0, pageSize));
        const hidden = systemHidden ? ` (${systemHidden} system note(s) hidden — workflow-rule, Service Desk Notification and forward/modify logs; pass includeSystemNotes:true to include them)` : '';
        return { result: r, message: `Found ${r.length} ticket notes${hidden}` };
      }],
      ['autotask_create_ticket_note', async (a) => {
        if (a.noteType === undefined || a.noteType === null) {
          throw new Error('noteType is required. Picklist values are tenant-specific — call autotask_get_field_info with entityType "TicketNotes" and fieldName "noteType" to discover the correct ID.');
        }
        if (a.publish === undefined || a.publish === null) {
          throw new Error('publish is required and security-sensitive (controls client visibility). Picklist values are tenant-specific — call autotask_get_field_info with entityType "TicketNotes" and fieldName "publish" to discover the correct ID.');
        }
        const noteBody = {
          title: a.title || 'Note',
          description: a.description,
          noteType: a.noteType,
          publish: a.publish
        };
        if (a.idempotencyKey) {
          const r = await s.createTicketNoteIdempotent(a.ticketId, noteBody, a.idempotencyKey);
          return {
            result: r,
            message: r.created
              ? `Successfully created ticket note with ID: ${r.noteId}`
              : `Ticket note already exists for key "${a.idempotencyKey}" (ID: ${r.noteId}) — not duplicated`
          };
        }
        const id = await s.createTicketNote(a.ticketId, noteBody);
        return { result: id, message: `Successfully created ticket note with ID: ${id}` };
      }],
      // Ticket Checklist Items
      ['autotask_search_ticket_checklist_items', async (a) => {
        const r = await s.searchTicketChecklistItems(a.ticketId);
        return { result: r, message: `Found ${r.length} checklist items` };
      }],
      ['autotask_create_ticket_checklist_item', async (a) => {
        const id = await s.createTicketChecklistItem(a.ticketId, {
          itemName: a.itemName,
          position: a.position,
          isCompleted: a.isCompleted
        });
        return { result: id, message: `Successfully created ticket checklist item with ID: ${id}` };
      }],
      ['autotask_update_ticket_checklist_item', async (a) => {
        await s.updateTicketChecklistItem(a.ticketId, a.itemId, {
          itemName: a.itemName,
          isCompleted: a.isCompleted,
          position: a.position
        });
        return { result: a.itemId, message: `Successfully updated ticket checklist item ${a.itemId}` };
      }],
      ['autotask_delete_ticket_checklist_item', async (a) => {
        await s.deleteTicketChecklistItem(a.ticketId, a.itemId);
        return { result: a.itemId, message: `Successfully deleted ticket checklist item ${a.itemId}` };
      }],

      // Checklist Libraries (§10)
      ['autotask_search_checklist_libraries', async (a) => {
        const r = await s.searchChecklistLibraries({ isActive: a.isActive, entityType: a.entityType, searchTerm: a.searchTerm, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} checklist librar${r.length === 1 ? 'y' : 'ies'}` };
      }],
      ['autotask_get_checklist_library', async (a) => {
        const r = await s.getChecklistLibrary(a.id);
        if (!r) return { result: null, message: `No checklist library found with ID ${a.id}` };
        return { result: r, message: `Retrieved checklist library ${a.id} with ${(r.items as any[])?.length ?? 0} item(s)` };
      }],
      ['autotask_apply_checklist_library_to_ticket', async (a) => {
        const r = await s.applyChecklistLibraryToTicket(a.ticketID, a.checklistLibraryID);
        const failed = r.itemErrors.length;
        return { result: r, message: `Applied checklist library ${a.checklistLibraryID} to ticket ${a.ticketID}: created ${r.created.length} item(s)` + (failed ? `, ${failed} failed` : '') };
      }],

      ['autotask_get_project_note', async (a) => {
        const r = await s.getProjectNote(a.projectId, a.noteId); return { result: r, message: 'Project note retrieved successfully' };
      }],
      ['autotask_search_project_notes', async (a) => {
        const r = await s.searchProjectNotes(a.projectId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} project notes` };
      }],
      ['autotask_create_project_note', async (a) => {
        const id = await s.createProjectNote(a.projectId, { title: a.title, description: a.description, noteType: a.noteType, publish: a.publish ?? 1, isAnnouncement: a.isAnnouncement ?? false });
        return { result: id, message: `Successfully created project note with ID: ${id}` };
      }],
      ['autotask_get_task_note', async (a) => {
        const r = await s.getTaskNote(a.taskId, a.noteId); return { result: r, message: r ? `Task note ${a.noteId}` : `Task note ${a.noteId} not found` };
      }],
      ['autotask_search_task_notes', async (a) => {
        const r = await s.searchTaskNotes(a.taskId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} task notes` };
      }],
      ['autotask_create_task_note', async (a) => {
        const note: Record<string, any> = { description: a.description };
        if (a.title !== undefined) note.title = a.title;
        if (a.noteType !== undefined) note.noteType = a.noteType;
        if (a.publish !== undefined) note.publish = a.publish;
        const id = await s.createTaskNote(a.taskId, note);
        return { result: id, message: `Successfully created task note with ID: ${id}` };
      }],
      ['autotask_search_project_attachments', async (a) => {
        const r = await s.searchProjectAttachments(a.projectId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} project attachment(s)` };
      }],
      ['autotask_search_task_attachments', async (a) => {
        const r = await s.searchTaskAttachments(a.taskId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} task attachment(s)` };
      }],
      ['autotask_get_company_note', async (a) => {
        const r = await s.getCompanyNote(a.companyId, a.noteId); return { result: r, message: 'Company note retrieved successfully' };
      }],
      ['autotask_search_company_notes', async (a) => {
        const r = await s.searchCompanyNotes(a.companyId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} company notes` };
      }],
      ['autotask_create_company_note', async (a) => {
        const id = await s.createCompanyNote(a.companyId, { title: a.title, description: a.description, actionType: a.actionType });
        return { result: id, message: `Successfully created company note with ID: ${id}` };
      }],

      // Attachments
      ['autotask_get_ticket_attachment', async (a) => {
        const r = await s.getTicketAttachment(a.ticketId, a.attachmentId, {
          includeData: a.includeData,
          maxInlineBase64Bytes: a.maxInlineBase64Bytes,
        });
        if (!r) return { result: null, message: `No ticket attachment found with ID ${a.attachmentId} on ticket ${a.ticketId}` };
        const message = r.dataOmittedReason
          ? `Ticket attachment retrieved (data omitted: oversized for inline transport)`
          : 'Ticket attachment retrieved successfully';
        return { result: r, message };
      }],
      ['autotask_search_ticket_attachments', async (a) => {
        const r = await s.searchTicketAttachments(a.ticketId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} ticket attachments` };
      }],
      ['autotask_create_ticket_attachment', async (a) => {
        // Never log `data` (base64 file bytes) — can be large / contain PII.
        const decodedBytes = typeof a.data === 'string'
          ? Buffer.from(a.data, 'base64').length
          : 0;
        this.logger.info(
          `autotask_create_ticket_attachment invoked: ticketId=${a.ticketId} title="${a.title}" bytes=${decodedBytes}`
        );
        const id = await s.createTicketAttachment(a.ticketId, {
          title: a.title,
          fullPath: a.fullPath || a.title,
          data: a.data,
          contentType: a.contentType,
          publish: a.publish ?? 1
        });
        return { result: id, message: `Successfully created ticket attachment with ID: ${id}` };
      }],
      ['autotask_get_project_attachment', async (a) => {
        const r = await s.getProjectAttachment(a.projectId, a.attachmentId, {
          includeData: a.includeData,
          maxInlineBase64Bytes: a.maxInlineBase64Bytes,
        });
        if (!r) return { result: null, message: `No project attachment found with ID ${a.attachmentId} on project ${a.projectId}` };
        const message = r.dataOmittedReason
          ? 'Project attachment retrieved (data omitted: oversized for inline transport)'
          : 'Project attachment retrieved successfully';
        return { result: r, message };
      }],
      ['autotask_create_project_attachment', async (a) => {
        // Never log `data` (base64 file bytes) — can be large / contain PII.
        const decodedBytes = typeof a.data === 'string' ? Buffer.from(a.data, 'base64').length : 0;
        this.logger.info(
          `autotask_create_project_attachment invoked: projectId=${a.projectId} title="${a.title}" bytes=${decodedBytes}`
        );
        const id = await s.createProjectAttachment(a.projectId, {
          title: a.title,
          fullPath: a.fullPath || a.title,
          data: a.data,
          contentType: a.contentType,
          publish: a.publish ?? 1
        });
        return { result: id, message: `Successfully created project attachment with ID: ${id}` };
      }],
      ['autotask_get_task_attachment', async (a) => {
        const r = await s.getTaskAttachment(a.taskId, a.attachmentId, {
          includeData: a.includeData,
          maxInlineBase64Bytes: a.maxInlineBase64Bytes,
        });
        if (!r) return { result: null, message: `No task attachment found with ID ${a.attachmentId} on task ${a.taskId}` };
        const message = r.dataOmittedReason
          ? 'Task attachment retrieved (data omitted: oversized for inline transport)'
          : 'Task attachment retrieved successfully';
        return { result: r, message };
      }],
      ['autotask_create_task_attachment', async (a) => {
        // Never log `data` (base64 file bytes) — can be large / contain PII.
        const decodedBytes = typeof a.data === 'string' ? Buffer.from(a.data, 'base64').length : 0;
        this.logger.info(
          `autotask_create_task_attachment invoked: taskId=${a.taskId} title="${a.title}" bytes=${decodedBytes}`
        );
        const id = await s.createTaskAttachment(a.taskId, {
          title: a.title,
          fullPath: a.fullPath || a.title,
          data: a.data,
          contentType: a.contentType,
          publish: a.publish ?? 1
        });
        return { result: id, message: `Successfully created task attachment with ID: ${id}` };
      }],

      // Expense Reports
      ['autotask_get_expense_report', async (a) => {
        const r = await s.getExpenseReport(a.reportId); return { result: r, message: 'Expense report retrieved successfully' };
      }],
      ['autotask_search_expense_reports', async (a) => {
        const r = await s.searchExpenseReports({ submitterId: a.submitterId, status: a.status, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} expense reports` };
      }],
      ['autotask_create_expense_report', async (a) => {
        const id = await s.createExpenseReport({ name: a.name, description: a.description, submitterID: a.submitterId, weekEnding: a.weekEndingDate || a.weekEnding });
        return { result: id, message: `Successfully created expense report with ID: ${id}` };
      }],

      // Expense Items
      ['autotask_create_expense_item', async (a) => {
        const id = await s.createExpenseItem({ expenseReportID: a.expenseReportId, description: a.description, expenseDate: a.expenseDate, expenseCategory: a.expenseCategory, expenseCurrencyExpenseAmount: a.amount, companyID: a.companyId ?? 0, haveReceipt: a.haveReceipt ?? false, isBillableToCompany: a.isBillableToCompany ?? false, isReimbursable: a.isReimbursable ?? true, paymentType: a.paymentType ?? 10 });
        return { result: id, message: `Successfully created expense item with ID: ${id}` };
      }],

      // Quotes
      ['autotask_get_quote', async (a) => {
        const r = await s.getQuote(a.quoteId); return { result: r, message: 'Quote retrieved successfully' };
      }],
      ['autotask_search_quotes', async (a) => {
        const r = await s.searchQuotes({ companyId: a.companyId, contactId: a.contactId, opportunityId: a.opportunityId, searchTerm: a.searchTerm, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} quotes` };
      }],
      ['autotask_create_quote', async (a) => {
        // Elicit company if not provided
        if (a.companyId == null && this.mcpServer) {
          try {
            const companyId = await this.elicitCompanyId();
            if (companyId != null) a = { ...a, companyId: companyId };
          } catch { /* proceed without company */ }
        }

        // Elicit opportunity if not provided but company is known
        if (!a.opportunityId && a.companyId != null && this.mcpServer) {
          try {
            const opps = await s.searchOpportunities({ companyId: a.companyId });
            if (opps.length > 0) {
              const options: PicklistValue[] = opps
                .filter(o => o.id != null)
                .map(o => ({
                  value: String(o.id),
                  label: o.title || `Opportunity #${o.id}`,
                }));
              const selected = await this.elicitSelection(
                `Found ${opps.length} opportunities for this company. Which one should the quote be attached to?`,
                'opportunityId',
                options
              );
              if (selected) a = { ...a, opportunityId: Number(selected) };
            }
          } catch { /* proceed without opportunity */ }
        }

        const id = await s.createQuote({ name: a.name, description: a.description, companyID: a.companyId, contactID: a.contactId, opportunityID: a.opportunityId, effectiveDate: a.effectiveDate, expirationDate: a.expirationDate });
        return { result: id, message: `Successfully created quote with ID: ${id}` };
      }],

      // Opportunities
      ['autotask_get_opportunity', async (a) => {
        const r = await s.getOpportunity(a.opportunityId); return { result: r, message: 'Opportunity retrieved successfully' };
      }],
      ['autotask_search_opportunities', async (a) => {
        const r = await s.searchOpportunities({ companyId: a.companyId, searchTerm: a.searchTerm, status: a.status, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} opportunities` };
      }],
      ['autotask_create_opportunity', async (a) => {
        const id = await s.createOpportunity({ title: a.title, companyID: a.companyId, ownerResourceID: a.ownerResourceId, status: a.status, stage: a.stage, projectedCloseDate: a.projectedCloseDate, startDate: a.startDate, probability: a.probability ?? 50, amount: a.amount ?? 0, cost: a.cost ?? 0, useQuoteTotals: a.useQuoteTotals ?? true, totalAmountMonths: a.totalAmountMonths, contactID: a.contactId, description: a.description, opportunityCategoryID: a.opportunityCategoryID });
        return { result: id, message: `Successfully created opportunity with ID: ${id}` };
      }],
      ['autotask_update_opportunity', async (a) => {
        const updates: Record<string, any> = {};
        for (const f of ['title', 'status', 'stage', 'projectedCloseDate', 'startDate', 'amount', 'cost', 'probability', 'description'] as const) {
          if (a[f] !== undefined) updates[f] = a[f];
        }
        if (a.contactId !== undefined) updates.contactID = a.contactId;
        await s.updateOpportunity(a.opportunityId, updates);
        return { result: a.opportunityId, message: `Successfully updated opportunity ${a.opportunityId}` };
      }],

      // Products
      ['autotask_get_product', async (a) => {
        const r = await s.getProduct(a.productId); return { result: r, message: 'Product retrieved successfully' };
      }],
      ['autotask_search_products', async (a) => {
        const r = await s.searchProducts({ searchTerm: a.searchTerm, isActive: a.isActive, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} products` };
      }],
      ['autotask_find_product', async (a) => {
        const r = await s.findProducts(a.query, { limit: a.limit, activeOnly: a.activeOnly, maxProducts: a.maxProducts });
        return { result: r, message: `${r.matchCount} match(es) for "${a.query}" across ${r.scanned} product(s)${r.truncated ? ' [catalog truncated]' : ''}` };
      }],
      ['autotask_list_product_categories', async (a) => {
        const r = await s.listProductCategories({ withCounts: a.withCounts, maxProducts: a.maxProducts });
        return { result: r, message: `${r.categoryCount} categories (${r.malformedCount} malformed)` };
      }],
      ['autotask_find_catalog_gaps', async (a) => {
        const r = await s.findCatalogGaps({ activeOnly: a.activeOnly, minDescriptionLength: a.minDescriptionLength, maxSamples: a.maxSamples, maxProducts: a.maxProducts });
        return { result: r, message: `${r.scanned} product(s): ${r.gaps.missingCategory.count} no-category, ${r.gaps.missingMsrp.count} no-MSRP, ${r.gaps.weakDescription.count} weak-description${r.truncated ? ' [truncated]' : ''}` };
      }],
      ['autotask_find_duplicate_products', async (a) => {
        const r = await s.findDuplicateProducts({ activeOnly: a.activeOnly, maxProducts: a.maxProducts, limit: a.limit });
        return { result: r, message: `${r.duplicateGroups} duplicate group(s) covering ${r.totalDuplicateProducts} product(s) of ${r.scanned} scanned${r.truncated ? ' [truncated]' : ''}` };
      }],
      // Catalog Phase B: guarded bulk writes (dry-run-first)
      ['autotask_bulk_update_products', async (a) => {
        const r = await s.bulkUpdateProducts({ updates: a.updates, dryRun: a.dryRun });
        const msg = r.status === 'dry_run' ? `Dry run: ${(r.plannedUpdates as any[])?.length ?? 0} product(s) would change; nothing written`
          : r.status === 'validation_failed' ? `Validation failed at "${r.step}": ${r.detail}`
          : `Updated ${r.updated} product(s)` + ((r.errors as any[])?.length ? ` with ${(r.errors as any[]).length} error(s)` : '');
        return { result: r, message: msg };
      }],
      ['autotask_merge_products', async (a) => {
        const r = await s.mergeProducts({ survivorId: a.survivorId, duplicateIds: a.duplicateIds, enrichSurvivor: a.enrichSurvivor, dryRun: a.dryRun });
        const msg = r.status === 'dry_run' ? `Dry run: would deactivate ${(r.wouldDeactivate as any[])?.length ?? 0} dup(s) into survivor ${r.survivorId}` + ((r.onHandWarnings as any[])?.length ? `; ${(r.onHandWarnings as any[]).length} still hold stock` : '') + '; nothing written'
          : r.status === 'validation_failed' ? `Validation failed at "${r.step}": ${r.detail}`
          : `Merged: deactivated ${(r.deactivated as any[])?.length ?? 0} dup(s) into survivor ${r.survivorId}` + ((r.errors as any[])?.length ? ` with ${(r.errors as any[]).length} error(s)` : '');
        return { result: r, message: msg };
      }],
      // Product CRUD (full access)
      ['autotask_create_product', async (a) => {
        const id = await s.createProduct(a); return { result: id, message: `Created product ${id}` };
      }],
      ['autotask_update_product', async (a) => {
        const { id, ...rest } = a; await s.updateProduct(id, rest); return { result: undefined, message: `Updated product ${id}` };
      }],
      // Inventory products (stock at a location)
      ['autotask_search_inventory_products', async (a) => {
        const r = await s.searchInventoryProducts({ productID: a.productID, inventoryLocationID: a.inventoryLocationID, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} inventory-product record(s)` };
      }],
      ['autotask_get_inventory_product', async (a) => {
        const r = await s.getInventoryProduct(a.id); return { result: r, message: r ? `Inventory product ${a.id}` : `Inventory product ${a.id} not found` };
      }],
      ['autotask_create_inventory_product', async (a) => {
        const id = await s.createInventoryProduct(a); return { result: id, message: `Created inventory-product ${id}` };
      }],
      ['autotask_update_inventory_product', async (a) => {
        const { id, ...rest } = a; await s.updateInventoryProduct(id, rest); return { result: undefined, message: `Updated inventory-product ${id}` };
      }],
      // Inventory locations
      ['autotask_search_inventory_locations', async (a) => {
        const r = await s.searchInventoryLocations({ isActive: a.isActive, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} inventory location(s)` };
      }],
      ['autotask_get_inventory_location', async (a) => {
        const r = await s.getInventoryLocation(a.id); return { result: r, message: r ? `Inventory location ${a.id}` : `Inventory location ${a.id} not found` };
      }],
      ['autotask_create_inventory_location', async (a) => {
        const id = await s.createInventoryLocation(a); return { result: id, message: `Created inventory location ${id}` };
      }],
      ['autotask_update_inventory_location', async (a) => {
        const { id, ...rest } = a; await s.updateInventoryLocation(id, rest); return { result: undefined, message: `Updated inventory location ${id}` };
      }],
      // Stocked items (units / serials / counts)
      ['autotask_search_inventory_stocked_items', async (a) => {
        const r = await s.searchInventoryStockedItems({ inventoryProductID: a.inventoryProductID, currentInventoryLocationID: a.currentInventoryLocationID, serialNumber: a.serialNumber, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} stocked-item record(s)` };
      }],
      ['autotask_get_inventory_stocked_item', async (a) => {
        const r = await s.getInventoryStockedItem(a.id); return { result: r, message: r ? `Stocked item ${a.id}` : `Stocked item ${a.id} not found` };
      }],
      // Transfers + count adjustments (inventory-movement: need confirm:true)
      ['autotask_search_inventory_transfers', async (a) => {
        const r = await s.searchInventoryTransfers({ productID: a.productID, fromLocationID: a.fromLocationID, toLocationID: a.toLocationID, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} transfer(s)` };
      }],
      ['autotask_create_inventory_transfer', async (a) => {
        const id = await s.createInventoryTransfer(a); return { result: id, message: `Created inventory transfer ${id} (${a.quantityTransferred} of product ${a.productID}: ${a.fromLocationID}→${a.toLocationID})` };
      }],
      ['autotask_add_inventory_stock', async (a) => {
        const id = await s.addInventoryStock(a); return { result: id, message: `Added ${a.quantityBeingAdded} unit(s) to inventory-product ${a.inventoryProductID} (adjustment ${id})` };
      }],
      ['autotask_remove_inventory_stock', async (a) => {
        const id = await s.removeInventoryStock(a); return { result: id, message: `Removed ${a.quantityBeingRemoved} unit(s) from inventory-product ${a.inventoryProductID} (adjustment ${id})` };
      }],

      // Services
      ['autotask_get_service', async (a) => {
        const r = await s.getService(a.serviceId); return { result: r, message: 'Service retrieved successfully' };
      }],
      ['autotask_search_services', async (a) => {
        const r = await s.searchServices({ searchTerm: a.searchTerm, isActive: a.isActive, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} services` };
      }],

      // Service Bundles
      ['autotask_get_service_bundle', async (a) => {
        const r = await s.getServiceBundle(a.serviceBundleId); return { result: r, message: 'Service bundle retrieved successfully' };
      }],
      ['autotask_search_service_bundles', async (a) => {
        const r = await s.searchServiceBundles({ searchTerm: a.searchTerm, isActive: a.isActive, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} service bundles` };
      }],

      // Quote Items
      ['autotask_get_quote_item', async (a) => {
        const r = await s.getQuoteItem(a.quoteItemId); return { result: r, message: 'Quote item retrieved successfully' };
      }],
      ['autotask_search_quote_items', async (a) => {
        const r = await s.searchQuoteItems({ quoteId: a.quoteId, searchTerm: a.searchTerm, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} quote items` };
      }],
      ['autotask_create_quote_item', async (a) => {
        // Elicit service/product selection when no ID is provided but name is available
        if (!a.serviceID && !a.productID && !a.serviceBundleID && a.name && this.mcpServer) {
          try {
            const itemChoice = await this.elicitItemSelection(a.name);
            if (itemChoice) a = { ...a, ...itemChoice };
          } catch { /* proceed as cost-type item */ }
        }

        const id = await s.createQuoteItem({ quoteID: a.quoteId, name: a.name, description: a.description, quantity: a.quantity, unitPrice: a.unitPrice, unitCost: a.unitCost, unitDiscount: a.unitDiscount, lineDiscount: a.lineDiscount, percentageDiscount: a.percentageDiscount, isOptional: a.isOptional, serviceID: a.serviceID, productID: a.productID, serviceBundleID: a.serviceBundleID, sortOrderID: a.sortOrderID, quoteItemType: a.quoteItemType });
        return { result: id, message: `Successfully created quote item with ID: ${id}` };
      }],
      ['autotask_update_quote_item', async (a) => {
        await s.updateQuoteItem(a.quoteItemId, { quantity: a.quantity, unitPrice: a.unitPrice, unitDiscount: a.unitDiscount, lineDiscount: a.lineDiscount, percentageDiscount: a.percentageDiscount, isOptional: a.isOptional, sortOrderID: a.sortOrderID });
        return { result: true, message: `Quote item ${a.quoteItemId} updated successfully` };
      }],
      ['autotask_delete_quote_item', async (a) => {
        await s.deleteQuoteItem(a.quoteId, a.quoteItemId); return { result: true, message: `Quote item ${a.quoteItemId} deleted successfully` };
      }],
      // Picklist tools
      ['autotask_list_queues', async () => {
        const queues = await this.picklistCache.getQueues();
        return { result: queues.map(q => ({ id: q.value, name: q.label, isActive: q.isActive })), message: `Found ${queues.length} queues` };
      }],
      ['autotask_list_ticket_statuses', async () => {
        const statuses = await this.picklistCache.getTicketStatuses();
        return { result: statuses.map(s => ({ id: s.value, name: s.label, isActive: s.isActive })), message: `Found ${statuses.length} ticket statuses` };
      }],
      ['autotask_list_ticket_priorities', async () => {
        const priorities = await this.picklistCache.getTicketPriorities();
        return { result: priorities.map(p => ({ id: p.value, name: p.label, isActive: p.isActive })), message: `Found ${priorities.length} ticket priorities` };
      }],
      ['autotask_get_field_info', async (a) => {
        // LLMs commonly pass `entity`/`field` instead of `entityType`/`fieldName`
        // (our own picklist error hints phrase it as "entity X and field Y"),
        // so accept those as aliases rather than crashing on undefined.
        const rawEntityType: unknown = a.entityType ?? a.entity;
        const rawFieldName: unknown = a.fieldName ?? a.field;
        if (typeof rawEntityType !== 'string' || rawEntityType.length === 0) {
          throw new Error('entityType is required — e.g. { "entityType": "Tickets" } or { "entityType": "TicketNotes", "fieldName": "noteType" }');
        }
        // Normalize common entity type aliases to correct Autotask REST API names
        const entityAliases: Record<string, string> = {
          'tasks': 'ProjectTasks',
          'task': 'ProjectTasks',
          'projecttask': 'ProjectTasks',
          'ticketnotes': 'TicketNotes',
          'projectnotes': 'ProjectNotes',
          'companynotes': 'CompanyNotes',
        };
        const entityType = entityAliases[rawEntityType.toLowerCase()] || rawEntityType;
        const fields = await this.picklistCache.getFields(entityType);
        if (typeof rawFieldName === 'string' && rawFieldName.length > 0) {
          const field = fields.find(f => f.name?.toLowerCase() === rawFieldName.toLowerCase());
          return { result: field || null, message: field ? `Field info for ${rawEntityType}.${rawFieldName}` : `Field '${rawFieldName}' not found on ${rawEntityType}` };
        }
        const summary = fields.map(f => ({ name: f.name, dataType: f.dataType, isRequired: f.isRequired, isPickList: f.isPickList, isQueryable: f.isQueryable, picklistValueCount: f.picklistValues?.length || 0 }));
        return { result: summary, message: `Found ${fields.length} fields for ${rawEntityType}` };
      }],
      ['autotask_resolve_picklist_value', async (a) => {
        // Note: the entityInformation/fields endpoint uses "Tasks" (not
        // "ProjectTasks", which 404s there) — pass the entity through as given.
        const r = await s.resolvePicklistValue(a.entity, a.field, a.label);
        return { result: r, message: r.status === 'matched' ? `${a.entity}.${a.field} "${a.label}" → ${r.value} (${r.label})` : `${a.entity}.${a.field} "${a.label}": ${r.status}` };
      }],

      // Billing Items (Approve and Post workflow)
      ['autotask_search_billing_items', async (a) => {
        const r = await s.searchBillingItems({
          companyId: a.companyId,
          ticketId: a.ticketId,
          projectId: a.projectId,
          contractId: a.contractId,
          invoiceId: a.invoiceId,
          isInvoiced: a.isInvoiced,
          dateFrom: a.dateFrom,
          dateTo: a.dateTo,
          postedAfter: a.postedAfter,
          postedBefore: a.postedBefore,
          page: a.page,
          pageSize: a.pageSize
        } as any);
        return paged(r, 'billing items');
      }],
      ['autotask_get_billing_item', async (a) => {
        const r = await s.getBillingItem(a.billingItemId);
        return { result: r, message: 'Billing item retrieved successfully' };
      }],

      // Billing Item Approval Levels
      ['autotask_search_billing_item_approval_levels', async (a) => {
        const r = await s.searchBillingItemApprovalLevels({
          timeEntryId: a.timeEntryId,
          approvalResourceId: a.approvalResourceId,
          approvalLevel: a.approvalLevel,
          approvedAfter: a.approvedAfter,
          approvedBefore: a.approvedBefore,
          page: a.page,
          pageSize: a.pageSize
        } as any);
        return paged(r, 'billing item approval levels');
      }],

      // Time Entries
      ['autotask_search_time_entries', async (a) => {
        const r = await s.searchTimeEntries({
          resourceId: a.resourceId,
          ticketId: a.ticketId,
          projectId: a.projectId,
          taskId: a.taskId,
          approvalStatus: a.approvalStatus,
          billable: a.billable,
          contractID: a.contractID,
          noContract: a.noContract,
          dateWorkedAfter: a.dateWorkedAfter,
          dateWorkedBefore: a.dateWorkedBefore,
          page: a.page,
          pageSize: a.pageSize
        } as any);
        return paged(r, 'time entries');
      }],
      ['autotask_get_time_entry', async (a) => {
        const r = await s.getTimeEntry(a.id);
        if (!r) return { result: null, message: `No time entry found with ID ${a.id}` };
        return { result: r, message: 'Time entry retrieved successfully' };
      }],
      ['autotask_update_time_entry', async (a) => {
        const { id, billingTreatment, timeZone, hoursToBill: requestedHoursToBill, ...updates } = a;
        // hoursToBill is read-only (Autotask derives it) — an update of ONLY it
        // would be a silent no-op reported as success, so refuse it up front.
        if (requestedHoursToBill != null && Object.keys(updates).length === 0 && !billingTreatment) {
          return {
            result: { id, status: 'not_writable', field: 'hoursToBill' },
            message: `Nothing was written: hoursToBill is read-only in the Autotask API — Autotask calculates it from hoursWorked − offsetHours and the contract/work-type rounding. To bill less than worked set offsetHours; to change the rounding, edit the contract, or edit Hours to Bill in the Autotask UI.`,
          };
        }
        // A role change is validated against the ENTRY OWNER's roles (not the
        // caller's) so a wrong role can't be written onto someone's time.
        if (updates.roleID != null) {
          const entry = await s.getTimeEntry(id);
          if (!entry) return { result: null, message: `Time entry ${id} not found.` };
          const role = await resolveTimeEntryRole({ ...entry, roleID: updates.roleID });
          if ('stop' in role) return role.stop;
        }
        const badWorkType = await checkWorkType(updates.billingCodeID);
        if (badWorkType) return badWorkType;
        // Timezone-normalize any local start/end (offset-aware or missing tz = passthrough).
        if (updates.startDateTime) updates.startDateTime = normalizeTimestamp(updates.startDateTime, timeZone);
        if (updates.endDateTime) updates.endDateTime = normalizeTimestamp(updates.endDateTime, timeZone);
        // High-level billing intent -> Autotask field combo (explicit fields win).
        applyBillingTreatment(updates, billingTreatment);
        // Warn (do not block) when a supplied start/end span disagrees with hoursWorked.
        const warnings: string[] = [];
        const span = durationHours(updates.startDateTime, updates.endDateTime);
        if (span != null && updates.hoursWorked != null && Math.abs(span - updates.hoursWorked) > 0.02) {
          warnings.push(`hoursWorked=${updates.hoursWorked} does not match the ${span.toFixed(4)}h start/end interval`);
        }
        const written = await explainTimeEntryWrite(() => s.updateTimeEntry(id, updates));
        if ('stop' in written) return { result: { id, ...(written.stop.result as Record<string, unknown>) }, message: written.stop.message };
        if (requestedHoursToBill != null) {
          const after = await s.getTimeEntry(id).catch(() => null);
          const w = hoursToBillWarning(requestedHoursToBill, after?.hoursToBill);
          if (w) warnings.push(w);
        }
        return { result: warnings.length ? { id, warnings } : id, message: `Successfully updated time entry ${id}${warnings.length ? ` (warning: ${warnings.join('; ')})` : ''}` };
      }],
      ['autotask_delete_time_entry', async (a) => {
        const dryRun = a.dryRun !== false; // default true
        const allowApproved = a.allowApproved === true;
        const entry = await s.getTimeEntry(a.id);
        if (!entry) return { result: { status: 'already_deleted', timeEntryId: a.id }, message: `Time entry ${a.id} not found (already deleted).` };
        const lock = await s.assessTimeEntryLock(entry);
        const target = {
          id: entry.id, resourceID: entry.resourceID, dateWorked: entry.dateWorked, hoursWorked: entry.hoursWorked,
          hoursToBill: (entry as any).hoursToBill, ticketID: entry.ticketID, taskID: entry.taskID, billingCodeID: (entry as any).billingCodeID,
          isNonBillable: (entry as any).isNonBillable, showOnInvoice: (entry as any).showOnInvoice,
          billingApprovalDateTime: (entry as any).billingApprovalDateTime, summaryNotes: entry.summaryNotes, internalNotes: entry.internalNotes,
        };
        // Only billing-posted is knowable pre-flight; a submitted/approved timesheet,
        // the owner-only rule, and the owner's delete permission are enforced only
        // when the delete is attempted (no API entity/field exposes them).
        const blockedByApproval = lock.state === 'billing_posted' && !allowApproved;
        const caveat = 'Note: a submitted/approved timesheet, the owner-only rule, or the owner lacking delete permission can only be detected at execution.';
        if (dryRun) {
          const canDelete = !blockedByApproval;
          return {
            result: { status: 'dry_run', timeEntry: target, lock, canDelete, preflightOnly: true, ...(canDelete ? {} : { blockedReason: lock.reason }) },
            message: canDelete ? `DRY RUN: no billing-post lock on time entry ${a.id}. ${caveat} Re-run with dryRun:false and confirm:true to attempt.` : `DRY RUN: time entry ${a.id} is BLOCKED — ${lock.reason}`,
          };
        }
        if (blockedByApproval) return { result: { status: 'blocked', timeEntryId: a.id, lock }, message: `Not deleted — ${lock.reason} Pass allowApproved:true to attempt anyway (Autotask may still refuse).` };
        try {
          // Autotask lets only the OWNER delete their time — impersonate them.
          await s.deleteTimeEntry(a.id, entry.resourceID != null ? { asResourceID: entry.resourceID } : undefined);
        } catch (e) {
          const ls = classifyLockError(e instanceof Error ? e.message : String(e));
          if (ls) return { result: { status: 'blocked', timeEntryId: a.id, lock: { locked: true, state: ls, reason: lockReason(ls) } }, message: `Not deleted — ${lockReason(ls)}` };
          throw e;
        }
        const after = await s.getTimeEntry(a.id).catch(() => null);
        return { result: { status: 'deleted', timeEntryId: a.id, verification: { exists: !!after } }, message: `Deleted time entry ${a.id}.` };
      }],
      ['autotask_delete_task', async (a) => {
        // Autotask does NOT permit deleting a project task via the REST API
        // (Tasks entityInformation canDelete=false) — UI only. We inventory the
        // task so the caller sees what's attached, but never attempt the delete.
        const inv = await s.inspectTaskForDelete(a.id);
        if (!inv.task) return { result: { status: 'already_deleted', taskId: a.id }, message: `Task ${a.id} not found.` };
        const attached = {
          timeEntries: inv.timeEntries.map((t) => t.id), notes: inv.notes.map((n) => n.id),
          attachments: inv.attachments.map((x) => x.id), secondaryResources: inv.secondaryResources.map((r) => r.id),
          dependencies: inv.dependencies.map((d) => d.id),
        };
        const base = { taskId: a.id, taskNumber: (inv.task as any).taskNumber, title: inv.task.title, projectId: a.projectID ?? (inv.task as any).projectID };
        return {
          result: { status: 'ui_delete_required', ...base, apiDeletable: false, attached },
          message: `Autotask does not allow deleting a project task via the API — delete task ${a.id} in the Autotask UI (its notes & secondary resources cascade). This tool can clear the API-deletable time entries first: use autotask_delete_task_with_time. Attached now: ${attached.timeEntries.length} time entr(ies), ${attached.notes.length} note(s), ${attached.secondaryResources.length} secondary resource(s), ${attached.dependencies.length} dependency(ies).`,
        };
      }],
      ['autotask_delete_task_with_time', async (a) => {
        const taskId = a.taskId ?? a.id;
        const dryRun = a.dryRun !== false;
        const allowApproved = a.allowApproved === true;
        const removeSecondaryResources = a.removeSecondaryResources === true;
        const inv = await s.inspectTaskForDelete(taskId);
        if (!inv.task) return { result: { status: 'already_deleted', taskId }, message: `Task ${taskId} not found.` };
        const base = { taskId, taskNumber: (inv.task as any).taskNumber, title: inv.task.title, projectId: a.projectID ?? (inv.task as any).projectID };
        // Pre-flight per entry: only billing-post is visible; other locks surface at execution.
        const teAssess = await Promise.all(inv.timeEntries.map(async (t) => {
          const full = await s.getTimeEntry(t.id).catch(() => null);
          const lock = full ? await s.assessTimeEntryLock(full) : { locked: false, state: 'open' as const };
          const blockedPreflight = lock.state === 'billing_posted' && !allowApproved;
          return { id: t.id, resource: t.resourceID, dateWorked: t.dateWorked, hoursWorked: t.hoursWorked, lock, blockedPreflight };
        }));
        const secResourceIds = inv.secondaryResources.map((r) => r.id);
        const uiRemainder = { notes: inv.notes.map((n) => n.id), attachments: inv.attachments.map((x) => x.id), dependencies: inv.dependencies.map((d) => d.id), ...(removeSecondaryResources ? {} : { secondaryResources: secResourceIds }) };
        if (dryRun) {
          const plannedActions = [
            ...teAssess.map((t) => `Delete time entry ${t.id} (as owner ${t.resource})`),
            ...(removeSecondaryResources ? secResourceIds.map((id) => `Remove secondary resource row ${id}`) : []),
            `Then delete task ${taskId} in the Autotask UI (API cannot delete tasks); its notes/dependencies cascade.`,
          ];
          return {
            result: { status: 'dry_run', ...base, apiTaskDeletable: false, timeEntries: teAssess, willRemoveSecondaryResources: removeSecondaryResources ? secResourceIds : [], uiRemainder, plannedActions },
            message: `DRY RUN: would delete ${teAssess.length} time entr(ies)${removeSecondaryResources ? ` + ${secResourceIds.length} secondary resource(s)` : ''} for task ${taskId}, then you delete the task in the UI (API can't). Locks beyond billing-post are enforced at execution. Re-run with dryRun:false and confirm:true.`,
          };
        }
        // Execute: delete time entries as their owners (best-effort, per-entry).
        const timeEntryResults: Array<Record<string, any>> = [];
        for (const t of teAssess) {
          try { await s.deleteTimeEntry(t.id, t.resource != null ? { asResourceID: t.resource } : undefined); timeEntryResults.push({ id: t.id, status: 'deleted' }); }
          catch (e) { const ls = classifyLockError(e instanceof Error ? e.message : String(e)); timeEntryResults.push({ id: t.id, status: 'error', state: ls ?? undefined, reason: ls ? lockReason(ls) : (e instanceof Error ? e.message : String(e)) }); }
        }
        const secResourceResults: Array<Record<string, any>> = [];
        if (removeSecondaryResources) {
          for (const id of secResourceIds) {
            try { await s.removeTaskResource(id); secResourceResults.push({ id, status: 'removed' }); }
            catch (e) { secResourceResults.push({ id, status: 'error', reason: e instanceof Error ? e.message : String(e) }); }
          }
        }
        const teFailed = timeEntryResults.filter((r) => r.status === 'error');
        const recheck = await s.inspectTaskForDelete(taskId).catch(() => null);
        const remainingTime = recheck ? recheck.timeEntries.map((t) => t.id) : undefined;
        const cleared = teFailed.length === 0;
        return {
          result: {
            status: cleared ? 'time_cleared' : 'partial',
            ...base, apiTaskDeletable: false, timeEntryResults,
            ...(removeSecondaryResources ? { secResourceResults } : {}),
            ...(remainingTime ? { remainingTimeEntries: remainingTime } : {}),
            uiRemainder,
          },
          message: cleared
            ? `Deleted ${timeEntryResults.length} time entr(ies)${removeSecondaryResources ? ` + ${secResourceResults.filter((r) => r.status === 'removed').length} secondary resource(s)` : ''}. Task ${taskId} can't be deleted via the API — delete it in the Autotask UI (notes/dependencies cascade).`
            : `Partial: ${teFailed.length} of ${timeEntryResults.length} time entr(y/ies) could NOT be deleted (${teFailed.map((r) => `#${r.id}: ${r.reason}`).join('; ')}). Clear those (reopen timesheet / owner delete permission / UI) then re-run.`,
        };
      }],

      // Meta-tools for progressive discovery
      ['autotask_list_categories', async () => {
        const categories = Object.entries(TOOL_CATEGORIES).map(([name, cat]) => ({
          name,
          description: cat.description,
          toolCount: cat.tools.length,
        }));
        return { result: categories, message: `Found ${categories.length} tool categories with ${Object.values(TOOL_CATEGORIES).reduce((sum, c) => sum + c.tools.length, 0)} total tools` };
      }],
      ['autotask_list_category_tools', async (a) => {
        const category = TOOL_CATEGORIES[a.category];
        if (!category) {
          const available = Object.keys(TOOL_CATEGORIES).join(', ');
          throw new Error(`Unknown category "${a.category}". Available: ${available}`);
        }
        const tools = TOOL_DEFINITIONS.filter(t => category.tools.includes(t.name) && toolAllowed(t.name));
        return { result: tools, message: `Found ${tools.length} tools in "${a.category}" category` };
      }],
      ['autotask_execute_tool', async (a, ctx) => {
        const toolName = a.toolName;
        const toolArgs = a.arguments || {};
        const handler = this.getDispatchTable().get(toolName);
        if (!handler) throw new Error(`Unknown tool: ${toolName}`);
        // Prevent recursive meta-tool calls
        if (toolName === 'autotask_execute_tool') throw new Error('Cannot recursively execute autotask_execute_tool');
        const blocked = toolBlockReason(toolName);
        if (blocked) throw new Error(blocked);
        return handler(toolArgs, ctx);
      }],

      // Intent-based router
      ['autotask_router', async (a) => {
        const rawIntent = a.intent || '';
        const suggestion = this.routeIntent(rawIntent);
        return { result: suggestion, message: `Suggested tool: ${suggestion.suggestedTool}` };
      }],
    ]);
  }

  /**
   * Build a human-readable "not found" error message from the tool name and arguments.
   * Returns null if the result is NOT empty (i.e. no error needed).
   */
  private buildNotFoundMessage(name: string, args: Record<string, any>, result: any): string | null {
    // Single-entity "get" tools: result is null/undefined
    const isGetTool = name.startsWith('autotask_get_');
    if (isGetTool && (result === null || result === undefined)) {
      const entityLabel = name
        .replace('autotask_get_', '')
        .replace(/_/g, ' ');
      // Try to identify the ID arg used
      const idArg = Object.entries(args).find(([k]) =>
        /id$/i.test(k)
      );
      const idInfo = idArg ? ` with ${idArg[0]} ${idArg[1]}` : '';
      return `No ${entityLabel} found${idInfo}. Verify the ID is correct.`;
    }

    // Search tools: result is an empty array
    const isSearchTool = name.startsWith('autotask_search_') || name === 'autotask_search_tickets';
    if (isSearchTool && Array.isArray(result) && result.length === 0) {
      const entityLabel = name
        .replace('autotask_search_', '')
        .replace(/_/g, ' ');
      // Build a summary of the search criteria
      const criteria = Object.entries(args)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      const criteriaInfo = criteria ? `: ${criteria}` : '';
      return `No ${entityLabel} found matching search criteria${criteriaInfo}. The search returned zero results — do not guess or fabricate data.`;
    }

    return null;
  }

  /**
   * Call a tool with the given arguments
   */
  /**
   * Resolve the caller to an Autotask resource for permissions + proxy data
   * input (§4.1). Order: explicit id/email/name → static AUTOTASK_USER_MAP →
   * in-memory cache → live email match. Caches any resolution under the caller's
   * keys so they are prompted at most once. Returns a structured identification
   * prompt when it can't resolve unambiguously.
   */
  async resolveCaller(
    ctx: CallerContext,
    explicit?: { resourceId?: number; resourceEmail?: string; resourceName?: string }
  ): Promise<CallerResolution> {
    const keys = callerMapKeys(ctx);
    const cacheAll = (res: ResolvedResource): void => {
      for (const k of keys) this.resourceCache.set(k, res);
    };
    const toCandidates = (
      ms: Array<{ id: number; firstName?: string; lastName?: string; email?: string }>
    ) => ms.map((m) => ({ id: m.id, name: resourceDisplayName(m), ...(m.email !== undefined ? { email: m.email } : {}) }));

    // 1. Explicit resource id (trusted; establishes/updates the mapping).
    if (explicit?.resourceId != null) {
      const res: ResolvedResource = { id: explicit.resourceId, name: explicit.resourceName ?? `Resource ${explicit.resourceId}` };
      cacheAll(res);
      return { status: 'resolved', via: 'explicit-id', resource: res };
    }
    // 2. Explicit email.
    if (explicit?.resourceEmail) {
      const r = classifyEmailMatch(explicit.resourceEmail, toCandidates(await this.autotaskService.searchResourcesByEmail(explicit.resourceEmail)));
      if (r.status === 'resolved') cacheAll(r.resource);
      return r;
    }
    // 3. Explicit name.
    if (explicit?.resourceName) {
      const m = await this.autotaskService.resolveResourceByName(explicit.resourceName);
      if (!m) return identificationRequired('not-found');
      const res: ResolvedResource = { id: m.id, name: resourceDisplayName(m) };
      cacheAll(res);
      return { status: 'resolved', via: 'explicit-name', resource: res };
    }
    // 3.5 Trusted gateway impersonation (#42): a verified gateway header (behind
    // S2S) said "act as this user". Trusted — outranks the payload email and the
    // static map, but not an explicit in-call resource (1-3). A resource id is
    // authoritative; an email is matched live against Autotask Resources.
    if (ctx.trustedActingResourceId != null) {
      const res: ResolvedResource = { id: ctx.trustedActingResourceId, name: `Resource ${ctx.trustedActingResourceId}` };
      cacheAll(res);
      return { status: 'resolved', via: 'gateway-impersonation', resource: res };
    }
    if (ctx.trustedActingUserEmail) {
      const r = classifyEmailMatch(ctx.trustedActingUserEmail, toCandidates(await this.autotaskService.searchResourcesByEmail(ctx.trustedActingUserEmail)));
      if (r.status === 'resolved') { cacheAll(r.resource); return { ...r, via: 'gateway-impersonation' }; }
      return r;
    }

    // 4. Static override map (Telegram handles / non-email identities).
    for (const k of keys) {
      const id = this.userMap.get(k);
      if (id != null) {
        const res: ResolvedResource = { id, name: `Resource ${id}` };
        cacheAll(res);
        return { status: 'resolved', via: 'static-map', resource: res };
      }
    }
    // 5. In-memory cache (already resolved this session).
    for (const k of keys) {
      const cached = this.resourceCache.get(k);
      if (cached) return { status: 'resolved', via: 'cache', resource: cached };
    }
    // 6. Live email match against Autotask Resources.
    if (ctx.requestingUserEmail) {
      const r = classifyEmailMatch(ctx.requestingUserEmail, toCandidates(await this.autotaskService.searchResourcesByEmail(ctx.requestingUserEmail)));
      if (r.status === 'resolved') cacheAll(r.resource);
      return r;
    }
    // 7. Nothing to go on.
    return identificationRequired('no-identity');
  }

  /**
   * Read-after-write verification for a create result (§2). Reads the just-
   * created entity back (bounded retry for Autotask's post-create read lag) and
   * returns the result augmented with `verified` and, when visible, `item`.
   *
   * Fail-safe by construction: the create's itemId is already authoritative, so
   * a read that never resolves (lag beyond budget) or that errors is reported as
   * `verified: false` — never re-thrown. Throwing here would make a successful
   * create look failed and invite a duplicate on rerun (§42).
   */
  private async verifyCreatedEntity(
    name: string,
    normalized: NormalizedCreateResult
  ): Promise<NormalizedCreateResult> {
    try {
      const item = await this.autotaskService.readEntityForVerification(
        normalized.entityType,
        normalized.id
      );
      if (item) {
        return { ...normalized, verified: true, item: item as Record<string, unknown> };
      }
      this.logger.warn(
        `Read-after-create for ${name} id=${normalized.id} (${normalized.entityType}): entity not visible within retry budget — returning verified:false (the create itemId is authoritative; do NOT recreate).`
      );
      return { ...normalized, verified: false };
    } catch (err) {
      // A payload anomaly / transport error on the read-back is a verification
      // failure, not a create failure. Surface verified:false and move on.
      this.logger.warn(
        `Read-after-create for ${name} id=${normalized.id} (${normalized.entityType}) errored: ${err instanceof Error ? err.message : String(err)} — returning verified:false.`
      );
      return { ...normalized, verified: false };
    }
  }

  /** Claim an idempotency key; null (unguarded, in-memory fallback) when the operation table isn't migrated. Other errors fail the call. */
  private async claimOperation(op: OperationInput & { idempotencyKey: string }): Promise<ClaimResult | null> {
    try { return await this.operations!.claim(op); } catch (err) {
      if (/mcp_operation/.test(String((err as Error)?.message)) && /does not exist/.test(String((err as Error)?.message))) {
        this.logger.warn('Operation log: table missing — run the migrations (0008); idempotency falls back to memory');
        this.operations = null;
        return null;
      }
      throw err;
    }
  }

  /**
   * Tie audit events made by this MCP's API user to the operation (and so the
   * caller's correlation / decision ids) whose recorded write is nearest in time.
   * Best effort: without the operation log, events come back unchanged.
   */
  private async linkOperations<T>(events: T[], target: (e: T) => { type: string; id: number; at: string } | null, attach: (e: T, op: Record<string, unknown>) => T): Promise<T[]> {
    if (!this.operations || !events.length) return events;
    const keyed = events.map((e) => ({ e, t: target(e) }));
    const targets = keyed.map((k) => k.t).filter((t): t is NonNullable<typeof t> => !!t && Number.isFinite(Date.parse(t.at)));
    if (!targets.length) return events;
    let links: Map<string, Awaited<ReturnType<OperationStore['find']>>[number]>;
    try { links = await this.operations.linkEvents(targets); } catch { return events; }
    return keyed.map(({ e, t }) => {
      const op = t ? links.get(`${t.type}:${t.id}:${t.at}`) : undefined;
      return op ? attach(e, { operationId: op.operationId, correlationId: op.correlationId, decisionId: op.decisionId, tool: op.tool, source: op.source, refs: op.refs, startedAt: op.startedAt }) : e;
    });
  }

  /** Record an operation's outcome — best effort, never fails the call. */
  private async finishOperation(op: OperationInput, out: Parameters<OperationStore['finish']>[1]): Promise<void> {
    // A write that failed after writing needs a person: notify (console → Notifications).
    if (out.status === 'partial') {
      notify({
        type: 'operation.partial', severity: 'critical', title: `${op.tool} failed after writing to Autotask`,
        detail: `${out.error ?? 'error'}\nThe change is half-applied — check the records below. A retry with the same idempotency key is refused, so nothing is written twice.`,
        fields: {
          writes: out.writes.map((w) => `${w.method} ${w.entityType ?? w.path}${w.entityId != null ? ` ${w.entityId}` : ''}`).join(', ').slice(0, 900) || 'none',
          source: op.source, ...(op.refs?.workflow ? { workflow: op.refs.workflow } : {}), ...(op.refs?.node ? { node: op.refs.node } : {}),
          correlationId: op.correlationId, operationId: op.operationId,
        },
        dedupeKey: `operation.partial:${op.operationId}`,
      });
    }
    if (!this.operations) return;
    try { await this.operations.finish(op, out); } catch (err) { this.logger.warn(`Operation log: could not record ${op.tool} (${op.operationId})`, err); }
  }

  /**
   * Emit one audit record: always to the structured log, and additionally to the
   * PG audit_log table when the sink is enabled (§23). The PG write is
   * fire-and-forget and never blocks or fails the call.
   */
  private recordAudit(ctx: CallerContext, entry: AuditEntry): void {
    emitAudit(this.logger, ctx, entry);
    this.auditSink?.record(ctx, entry);
    // Admin console "Calls" log (in memory; caller + outcome, never arguments).
    noteToolAudit({
      outcome: entry.outcome, durationMs: entry.durationMs, source: ctx.source,
      user: ctx.trustedActingUserEmail ?? ctx.requestingUserEmail,
      ip: ctx.origin?.forwardedFor ?? ctx.origin?.remoteAddr, userAgent: ctx.origin?.userAgent, error: entry.error,
    });
  }

  async callTool(name: string, args: Record<string, any>, meta?: Record<string, any>): Promise<McpToolResult> {
    return runToolCall(name, () => this.dispatchToolCall(name, args, meta));
  }

  private async dispatchToolCall(name: string, args: Record<string, any>, meta?: Record<string, any>): Promise<McpToolResult> {
    // Caller context (who/where/correlation) for audit + future permissions
    // (§3.5/§23). Strip the reserved `_context` key so it never reaches tool logic.
    const ctx = extractCallerContext(meta, args);
    // Overlay the trusted gateway acting identity (#42) — this comes from a
    // verified gateway header (behind S2S), NOT from the client payload, so it
    // outranks `requestingUserEmail` when resolving the caller (see resolveCaller).
    if (this.trustedActing) {
      if (this.trustedActing.resourceId != null) ctx.trustedActingResourceId = this.trustedActing.resourceId;
      if (this.trustedActing.email) ctx.trustedActingUserEmail = this.trustedActing.email;
    }
    // Attach the transport-derived origin captured at the HTTP entry (server-
    // side, via AsyncLocalStorage) so the audit trail records where the request
    // actually came from — not just the client-declared `source`.
    const origin = getRequestOrigin();
    if (origin) ctx.origin = origin;
    args = stripCallerContext(args);
    const startedAt = Date.now();
    // Operation scope (MCP-007): every Autotask write this call makes is captured
    // and recorded with the caller's correlation / decision ids.
    const opScope: OperationScope = { operationId: randomUUID(), writes: [] };
    let opInput: OperationInput | null = null;
    let opClaimed = false;
    this.logger.debug(`Calling tool: ${name}`, args);

    try {
      const handler = this.getDispatchTable().get(name);
      if (!handler) {
        // A client asked for a tool that doesn't exist: capture it as a request (console → Requests).
        captureGap(() => getPool(this.logger), { dedupeKey: `unknown_tool:${name.slice(0, 120)}`, title: `Unknown tool called: ${name.slice(0, 120)}`, detail: `A client called "${name.slice(0, 120)}", which this MCP doesn't have. Arguments given: ${Object.keys(args ?? {}).slice(0, 20).join(', ') || 'none'}.`, reporter: ctx.source !== 'unknown' ? ctx.source : null, toolTried: name.slice(0, 120) });
        throw new Error(`Unknown tool: ${name}`);
      }
      // Admin console switches (read-only mode / disabled tool groups).
      const blocked = toolBlockReason(name);
      if (blocked) throw new Error(blocked);

      const risk = this.toolRisk.get(name) ?? 'reversible-update';

      // Permission gate (§4.2): the caller's functional role must permit this
      // tool's risk. Disabled unless MCP_PERMISSIONS_ENABLED=true, so the live
      // server is unaffected until roles are mapped. Denied before dispatch and
      // before the confirmation prompt — no point confirming what you can't do.
      if (isPermissionsEnabled() && isMutatingTool(name)) {
        const role: FunctionalRole | undefined = resolveRole(ctx, this.roleMap);
        const decision = evaluatePermission(role, risk);
        if (!decision.allowed) {
          const denied = buildPermissionDenied(name, risk, decision);
          this.recordAudit(ctx, { tool: name, outcome: 'permission-denied', durationMs: Date.now() - startedAt });
          return { content: [{ type: 'text', text: JSON.stringify({ message: denied.message, data: denied }) }] };
        }
      }

      // Raw-request gatekeeping (§3.4): administrator-only when permissions are
      // on, DELETE disabled by default, and a production read-only switch. The
      // HTTP layer already blocks absolute URLs / off-zone hosts / auth overrides.
      if (name === 'autotask_raw_request') {
        const role = resolveRole(ctx, this.roleMap);
        const decision = evaluateRawRequest({ method: args.method, role, permissionsEnabled: isPermissionsEnabled() });
        if (!decision.allowed) {
          const denied = buildRawRequestDenied(args.method, decision);
          this.recordAudit(ctx, { tool: name, outcome: 'permission-denied', durationMs: Date.now() - startedAt });
          return { content: [{ type: 'text', text: JSON.stringify({ message: denied.message, data: denied }) }] };
        }
      }

      // Risk-based confirmation gate (§4.3): destructive / financial / inventory
      // mutations require an explicit confirm:true before running. Read-only and
      // routine reversible updates pass through. `confirm` never reaches the tool.
      // A dry-run mutates nothing, so it never needs confirm — this lets a
      // destructive tool (e.g. delete_*) return its plan freely; only the real
      // execution (dryRun:false) hits the confirm gate. The delete_* tools
      // DEFAULT to dry-run when dryRun is omitted, so treat omitted as dry-run
      // for them; every other destructive tool still requires confirm as before.
      const isDryRunCall = args.dryRun === true || (DRY_RUN_FIRST_TOOLS.has(name) && args.dryRun !== false);
      if (requiresExplicitConfirmation(risk) && args.confirm !== true && !isDryRunCall) {
        const cr = buildConfirmationRequired(name, risk);
        this.recordAudit(ctx, { tool: name, outcome: 'confirmation-required', durationMs: Date.now() - startedAt });
        return { content: [{ type: 'text', text: JSON.stringify({ message: cr.message, data: cr }) }] };
      }
      if ('confirm' in args) {
        const { confirm: _confirm, ...rest } = args;
        args = rest;
      }

      // "My" tools (#42 slice 3) default to acting as the caller: if neither the
      // resource field nor an explicit currentUser was provided, assume currentUser.
      const defaultField = CURRENT_USER_DEFAULT_TOOLS[name];
      if (defaultField && args[defaultField] == null && args.currentUser == null && args.resourceName == null) {
        args = { ...args, currentUser: true };
      }

      // Proxy data input (§4.1): `currentUser: true` acts as the caller — resolve
      // them to an Autotask resource and write it into the tool's resource field,
      // or return the identity prompt when the caller can't be mapped.
      const actingField = ACTING_RESOURCE_TOOLS[name];
      if (actingField) {
        if (args.currentUser === true && args[actingField] == null) {
          let resolution = await this.resolveCaller(ctx);
          // Prompt-and-bind: when the app didn't identify the caller, ask them
          // for their Autotask username and bind it to this connection (#42).
          // Graceful — if the client can't be prompted, fall through to the
          // identification_required response for the assistant to relay.
          if (resolution.status !== 'resolved') {
            const elicited = await this.elicitAutotaskIdentity(ctx);
            if (elicited && elicited.status === 'resolved') resolution = elicited;
          }
          if (resolution.status !== 'resolved') {
            this.recordAudit(ctx, { tool: name, outcome: 'identification-required', durationMs: Date.now() - startedAt });
            return { content: [{ type: 'text', text: JSON.stringify({ message: resolution.message, data: resolution }) }] };
          }
          args = { ...args, [actingField]: resolution.resource.id };
        }
        if ('currentUser' in args) {
          const { currentUser: _drop, ...rest } = args;
          args = rest;
        }
      }

      // Role auto-fill (#42): when a tool's resource field is set (via currentUser
      // above or explicitly) but its paired role field is empty, fill the role
      // from the resource's default (Resources.defaultServiceDeskRoleID). An
      // explicit role always wins. Best-effort — a resource with no default role
      // leaves the field unset (Autotask then reports its own requirement error).
      const roleMap = ACTING_ROLE_FIELDS[name];
      if (roleMap && args[roleMap.resourceField] != null && args[roleMap.roleField] == null) {
        const roleId = await this.autotaskService.resolveResourceDefaultRole(args[roleMap.resourceField]);
        if (roleId != null) args = { ...args, [roleMap.roleField]: roleId };
      }

      // Idempotency (§4.4): for mutating tools, replay the prior result for a
      // repeated logical action instead of mutating twice. Keyed by a
      // caller-supplied idempotencyKey, or derived from caller + conversation +
      // tool + payload. No key (e.g. a context-free CLI call) → no dedup.
      // Durable claim first (MCP-007): an explicit idempotencyKey on a call that can
      // write is claimed in Postgres BEFORE running, so a retry, a concurrent
      // duplicate or a restart can't write twice. The in-memory store remains for
      // derived (conversation) keys and when Postgres is off.
      opInput = {
        operationId: opScope.operationId, correlationId: ctx.correlationId, decisionId: ctx.decisionId, idempotencyKey: ctx.idempotencyKey,
        tool: name, argsDigest: argsDigest(args), source: ctx.source, refs: ctx.refs,
        caller: { user: ctx.trustedActingUserEmail ?? ctx.requestingUserEmail ?? null, resourceId: ctx.trustedActingResourceId ?? ctx.autotaskResourceId ?? null, conversationId: ctx.conversationId ?? null, userAgent: ctx.origin?.userAgent ?? null },
      };
      if (this.operations && ctx.idempotencyKey && mayWrite(name, args)) {
        const claim = await this.claimOperation({ ...opInput, idempotencyKey: ctx.idempotencyKey });
        if (claim && claim.status !== 'claimed') {
          this.recordAudit(ctx, { tool: name, outcome: claim.status === 'replay' ? 'idempotent-replay' : 'idempotency-refused', durationMs: Date.now() - startedAt });
          return operationClaimResult(claim, ctx.idempotencyKey);
        }
        opClaimed = claim?.status === 'claimed';
      }
      const idempotencyKey = !opClaimed && isMutatingTool(name) ? deriveIdempotencyKey(ctx, name, args) : undefined;
      if (idempotencyKey) {
        const cached = this.idempotencyStore.get(idempotencyKey);
        if (cached) {
          this.recordAudit(ctx, { tool: name, outcome: 'idempotent-replay', durationMs: Date.now() - startedAt });
          return cached;
        }
      }

      // Native Autotask impersonation (#42): for a mutating call, tunnel the
      // write on the acting user's behalf via ImpersonationResourceId. The
      // deployment's posture is set per-instance by AUTOTASK_IMPERSONATION_MODE:
      //
      //   off      no impersonation (integration user; e.g. n8n/cron instance)
      //   gateway  ONLY the trusted, S2S-verified gateway header may impersonate;
      //            the client payload never picks the acting user
      //   caller   resolve the CALLER (distinct from a ticket's assignee)
      //            best-effort and impersonate them, degrading to the integration
      //            user when unidentified (never prompts here)
      //
      // In `caller` mode an optional source allowlist
      // (AUTOTASK_IMPERSONATION_SOURCES) can bar impersonation for specific
      // declared sources (e.g. n8n) even on a shared instance.
      let impersonationResourceId: number | undefined;
      const impersonationMode = getImpersonationMode();
      if (impersonationMode !== 'off' && isMutatingTool(name)) {
        if (ctx.trustedActingResourceId != null) {
          impersonationResourceId = ctx.trustedActingResourceId;
        } else if (impersonationMode === 'caller' && isImpersonationAllowedForSource(ctx.source)) {
          const callerRes = await this.resolveCaller(ctx);
          if (callerRes.status === 'resolved') impersonationResourceId = callerRes.resource.id;
        }
      }

      const { result: rawResult, message, pagination } = await runWithRequestContext(
        {
          ...(impersonationResourceId != null ? { impersonationResourceId } : {}),
          // Preserve the origin captured at the HTTP entry across this nested
          // context so audit inside the dispatch still sees the calling container.
          ...(ctx.origin ? { origin: ctx.origin } : {}),
        },
        () => runInOperation(opScope, () => handler(args, ctx))
      );

      // Check for empty/not-found results and return explicit error to prevent hallucination
      const notFoundMsg = this.buildNotFoundMessage(name, args, rawResult);
      if (notFoundMsg) {
        this.logger.debug(`Not-found result for ${name}: ${notFoundMsg}`);
        this.recordAudit(ctx, { tool: name, outcome: 'not-found', durationMs: Date.now() - startedAt });
        if (opInput && (opClaimed || opScope.writes.length)) await this.finishOperation(opInput, { status: opScope.writes.length ? 'partial' : 'error', writes: opScope.writes, error: notFoundMsg });
        return errorToolResult({ error: notFoundMsg, tool: name });
      }

      // Normalize create-tool ids into the { id, entityType, parentType?,
      // parentId? } contract (§5/§7.1) — one shape for every create, so callers
      // never special-case itemId vs item. Non-create results pass through.
      let result = normalizeCreateToolResult(name, args, rawResult);

      // Read-after-write verification (§2): for create tools flagged verifyRead
      // (Project-Builder entities), read the just-created entity back and attach
      // `item` + `verified`. The create's itemId is authoritative — this only
      // confirms/enriches — so it never converts a successful create into a
      // failure (which would risk a duplicate on rerun, §42).
      if (
        typeof rawResult === 'number' &&
        result !== null && typeof result === 'object' && !Array.isArray(result) &&
        CREATE_TOOL_META[name]?.verifyRead
      ) {
        result = await this.verifyCreatedEntity(name, result as NormalizedCreateResult);
      }

      // Format and enhance response
      let responseText: string;
      if (COMPACT_SEARCH_TOOLS.has(name) && Array.isArray(result)) {
        const entityType = detectEntityType(name);
        if (entityType) {
          const compact = formatCompactResponse(result, entityType, {
            page: args.page,
            pageSize: args.pageSize,
            ...(pagination ? { pagination } : {}),
          });
          compact.items = await this.enhanceItems(compact.items);
          // The message says what was searched (a resolved picklist filter, served from the shadow).
          responseText = JSON.stringify(message ? { message, ...compact } : compact);
        } else {
          const enhanced = await this.enhanceItems(result);
          responseText = JSON.stringify({ message, data: enhanced });
        }
      } else if (Array.isArray(result)) {
        const enhanced = await this.enhanceItems(result);
        responseText = JSON.stringify({ message, data: enhanced });
      } else if (result && typeof result === 'object' && !Array.isArray(result)) {
        const enhanced = await this.enhanceItems([result]);
        const data = enhanced[0] || result;
        // MCP Apps: attach the normalized card payload the ui:// ticket card
        // renders from. Best-effort — a null card just means no UI surface.
        // Skipped for declared unattended callers (n8n / cron): they never
        // render it, and building it costs extra Autotask calls per ticket.
        if (name === 'autotask_get_ticket_details' && ctx.source !== 'n8n' && ctx.source !== 'cron') {
          const card = await buildTicketCard(data, this.picklistCache, this.autotaskService, this.logger);
          if (card) data._card = card;
        }
        responseText = JSON.stringify({ message, data });
      } else {
        responseText = JSON.stringify({ message, data: result });
      }

      // MCP-007: a call that wrote (or claimed a key) returns and records its operation.
      if (opInput && (opClaimed || opScope.writes.length)) {
        responseText = withOperation(responseText, operationSummary(opInput, opScope.writes));
        await this.finishOperation(opInput, { status: 'ok', writes: opScope.writes, resultText: responseText });
      }

      this.logger.debug(`Successfully executed tool: ${name}`);
      const resultId =
        result && typeof result === 'object' && typeof (result as { id?: unknown }).id === 'number'
          ? (result as { id: number }).id
          : undefined;
      this.recordAudit(ctx, {
        tool: name,
        outcome: 'ok',
        durationMs: Date.now() - startedAt,
        ...(resultId !== undefined ? { resultId } : {}),
      });
      const finalResult: McpToolResult = { content: [{ type: 'text', text: responseText }] };
      // Cache successful mutations for idempotent replay. Errors and not-found
      // results are never cached, so a genuine failure can still be retried.
      if (idempotencyKey) this.idempotencyStore.set(idempotencyKey, finalResult);
      return finalResult;

    } catch (error) {
      this.logger.error(`Tool execution failed for ${name}:`, error);
      // Failed after writing = partial (never auto-retried under the same key); before = error (retryable).
      if (opInput && (opClaimed || opScope.writes.length)) {
        await this.finishOperation(opInput, { status: opScope.writes.length ? 'partial' : 'error', writes: opScope.writes, error: error instanceof Error ? error.message : String(error) });
      }
      this.recordAudit(ctx, {
        tool: name,
        outcome: 'error',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Surface rate-limit errors with a typed envelope so LLM clients can
      // distinguish them from generic failures and stop retrying. Issue #91.
      if (error instanceof AutotaskRateLimitError) {
        return errorToolResult({
          error_type: 'rate_limited',
          error: error.message,
          retry_after_seconds: error.retryAfterSeconds,
          tool: name,
          // Belt-and-suspenders for LLM clients that don't parse error_type.
          instruction: 'Do not retry this call. Ask the user to narrow the query (e.g. filter by date range, company, or ticket ID) before issuing another Autotask request.',
        });
      }
      return errorToolResult({
        error: error instanceof Error ? error.message : 'Unknown error',
        tool: name,
      });
    }
  }
}

/**
 * Build a tool-result envelope for an error. Three call sites in callTool()
 * had assembled this shape inline; this helper keeps the JSON envelope
 * consistent so future error fields don't drift between paths.
 */
function errorToolResult(payload: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}