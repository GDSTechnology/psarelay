/**
 * Compact Response Formatter
 * Reduces response size for LLM context windows by selecting only essential fields
 * per entity type and providing pagination metadata.
 */

export type EntityType = 'tickets' | 'companies' | 'contacts' | 'projects' | 'tasks' | 'resources' | 'billingItems' | 'billingItemApprovalLevels' | 'timeEntries' | 'ticketCharges';

export interface CompactResponse {
  summary: {
    returned: number;
    hasMore: boolean;
    page: number;
    pageSize: number;
    hint?: string;
  };
  items: Record<string, any>[];
}

/**
 * Fields to include in compact responses, per entity type.
 * These are the minimum fields needed for identification and triage.
 */
const SUMMARY_FIELDS: Record<EntityType, string[]> = {
  tickets: ['id', 'ticketNumber', 'title', 'status', 'statusLabel', 'priority', 'priorityLabel', 'queueLabel', 'companyID', 'assignedResourceID', 'createDate', 'dueDateTime', 'ticketUrl'],
  companies: ['id', 'companyName', 'isActive', 'phone', 'city', 'state', 'classification'],
  contacts: ['id', 'firstName', 'lastName', 'emailAddress', 'companyID'],
  projects: ['id', 'projectName', 'status', 'companyID', 'projectLeadResourceID', 'startDate', 'endDate'],
  tasks: ['id', 'title', 'status', 'projectID', 'assignedResourceID', 'percentComplete'],
  resources: ['id', 'firstName', 'lastName', 'email', 'isActive'],
  billingItems: ['id', 'itemName', 'companyID', 'ticketID', 'projectID', 'postedDate', 'totalAmount', 'invoiceID', 'billingItemType'],
  billingItemApprovalLevels: ['id', 'timeEntryID', 'approvalLevel', 'approvalResourceID', 'approvalDateTime'],
  timeEntries: ['id', 'resourceID', 'ticketID', 'projectID', 'taskID', 'dateWorked', 'hoursWorked', 'summaryNotes'],
  // Everything a billing check needs, so it never reads each charge again.
  ticketCharges: ['id', 'ticketID', 'name', 'description', 'chargeType', 'status', 'datePurchased', 'createDate', 'unitQuantity', 'unitPrice', 'unitCost', 'extendedCost', 'billableAmount', 'isBillableToCompany', 'isBilled', 'billingCodeID', 'productID', 'contractID', 'contractServiceID', 'contractServiceBundleID', 'purchaseOrderNumber'],
};

/** Fields shown even when null — "not set" is the answer (search_companies: classification {id, label} or null). */
const KEEP_NULL: Partial<Record<EntityType, string[]>> = { companies: ['classification'] };

/**
 * Pick only the summary fields from an item, inlining any _enhanced names.
 */
function pickSummaryFields(item: Record<string, any>, entityType: EntityType): Record<string, any> {
  const fields = SUMMARY_FIELDS[entityType];
  const compact: Record<string, any> = {};

  for (const field of fields) {
    if (item[field] !== undefined && item[field] !== null) {
      compact[field] = item[field];
    } else if (item[field] === null && KEEP_NULL[entityType]?.includes(field)) {
      compact[field] = null;
    }
  }

  // Inline _enhanced names directly into the item (no separate _enhanced object)
  if (item._enhanced) {
    if (item._enhanced.companyName) {
      compact.company = item._enhanced.companyName;
    }
    if (item._enhanced.assignedResourceName) {
      compact.assignedTo = item._enhanced.assignedResourceName;
    }
    if (item._enhanced.resourceName) {
      compact.resourceName = item._enhanced.resourceName;
    }
  }

  return compact;
}

/**
 * Honest pagination state for one page of search results, resolved by the
 * service layer rather than inferred from the returned page's length.
 */
export interface PageMeta {
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * Format a list of items into a compact response with pagination metadata.
 */
export function formatCompactResponse(
  items: Record<string, any>[],
  entityType: EntityType,
  options: { page?: number; pageSize?: number; totalFetched?: number; pagination?: PageMeta }
): CompactResponse {
  // Prefer the real pagination state resolved by the service layer. The
  // `items.length >= pageSize` fallback only applies to search tools that do not
  // yet return a PagedResult; it reports a full final page as "there is more",
  // costing the caller one wasted empty request.
  const page = options.pagination?.page ?? options.page ?? 1;
  const pageSize = options.pagination?.pageSize ?? options.pageSize ?? 25;
  const hasMore = options.pagination?.hasMore ?? items.length >= pageSize;

  const compactItems = items.map(item => pickSummaryFields(item, entityType));

  const hint = hasMore
    ? `Use page:${page + 1} for more results, or use get_ticket_details/show commands for full data on specific items`
    : undefined;

  return {
    summary: {
      returned: compactItems.length,
      hasMore,
      page,
      pageSize,
      ...(hint && { hint }),
    },
    items: compactItems,
  };
}

/**
 * Detect entity type from tool name.
 */
export function detectEntityType(toolName: string): EntityType | null {
  // Order matters - check more specific patterns first
  if (toolName.includes('billing_item_approval')) return 'billingItemApprovalLevels';
  if (toolName.includes('billing_item')) return 'billingItems';
  if (toolName.includes('time_entr')) return 'timeEntries';
  // Before 'ticket': a charge is not a ticket (it used to be cut down to ticket fields — only its id survived).
  if (toolName.includes('ticket_charge')) return 'ticketCharges';
  if (toolName.includes('ticket')) return 'tickets';
  if (toolName.includes('compan')) return 'companies';
  if (toolName.includes('contact')) return 'contacts';
  if (toolName.includes('project')) return 'projects';
  if (toolName.includes('task')) return 'tasks';
  if (toolName.includes('resource')) return 'resources';
  return null;
}

/**
 * List of search tool names that should use compact formatting.
 */
export const COMPACT_SEARCH_TOOLS = new Set([
  'autotask_search_tickets',
  'autotask_search_companies',
  'autotask_search_contacts',
  'autotask_search_projects',
  'autotask_search_tasks',
  'autotask_search_resources',
  'autotask_search_billing_items',
  'autotask_search_billing_item_approval_levels',
  'autotask_search_time_entries',
  'autotask_search_ticket_charges',
]);
