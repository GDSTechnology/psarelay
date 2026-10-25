// Autotask Entity Type Definitions
// Based on the autotask-node library types

export interface AutotaskCompany {
  id?: number;
  companyName?: string;
  companyType?: number;
  phone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryID?: number;
  isActive?: boolean;
  ownerResourceID?: number;
  createDate?: string;
  lastActivityDate?: string;
  lastTrackedModifiedDateTime?: string;
  [key: string]: any;
}

export interface AutotaskContact {
  id?: number;
  companyID?: number;
  firstName?: string;
  lastName?: string;
  emailAddress?: string;
  phone?: string;
  title?: string;
  isActive?: number; // Note: autotask-node uses number, not boolean
  createDate?: string;
  lastModifiedDate?: string;
  [key: string]: any;
}

export interface AutotaskTicket {
  id?: number;
  ticketNumber?: string;
  companyID?: number;
  contactID?: number;
  assignedResourceID?: number;
  title?: string;
  description?: string;
  status?: number;
  priority?: number;
  ticketType?: number;
  issueType?: number;
  subIssueType?: number;
  createDate?: string;
  createdByContactID?: number;
  createdByResourceID?: number;
  dueDateTime?: string;
  completedDate?: string;
  lastActivityDate?: string;
  estimatedHours?: number;
  hoursToBeScheduled?: number;
  queueID?: number;
  ticketCategory?: number;
  source?: number;
  billingCodeID?: number;
  serviceLevelAgreementID?: number;
  projectID?: number;
  ticketAdditionalContacts?: number[];
  resolution?: string;
  userDefinedFields?: AutotaskUserDefinedField[];
  [key: string]: any;
}

export interface AutotaskResource {
  id?: number;
  firstName?: string;
  lastName?: string;
  userName?: string;
  email?: string;
  isActive?: boolean;
  title?: string;
  resourceType?: number;
  userType?: number;
  [key: string]: any;
}

export interface AutotaskProject {
  id?: number;
  companyID?: number;
  projectName?: string;
  projectNumber?: string;
  description?: string;
  status?: number;
  projectType?: number;
  department?: number;
  startDate?: string;
  endDate?: string;
  startDateTime?: string;
  endDateTime?: string;
  projectLeadResourceID?: number;
  estimatedHours?: number;
  actualHours?: number;
  laborEstimatedRevenue?: number;
  createDate?: string;
  completedDate?: string;
  contractID?: number;
  originalEstimatedRevenue?: number;
  [key: string]: any;
}

export interface AutotaskTimeEntry {
  id?: number;
  resourceID?: number;
  ticketID?: number;
  projectID?: number;
  taskID?: number;
  dateWorked?: string;
  startDateTime?: string;
  endDateTime?: string;
  hoursWorked?: number;
  hoursToBill?: number;
  offsetHours?: number;
  summaryNotes?: string;
  internalNotes?: string;
  billableToAccount?: boolean;
  isNonBillable?: boolean;
  createDate?: string;
  createdByResourceID?: number;
  lastModifiedDate?: string;
  lastModifiedByResourceID?: number;
  // Approval/posting status fields
  billingApprovalDateTime?: string;  // null = not yet approved
  billingApprovalLevelMostRecent?: number;  // references BillingItemApprovalLevels
  billingApprovalResourceID?: number;  // who approved it
  [key: string]: any;
}

// Additional interfaces that were missing
export interface AutotaskConfigurationItem {
  id?: number;
  companyID?: number;
  serialNumber?: string;
  configurationItemName?: string;
  configurationItemType?: number;
  configurationItemCategoryID?: number;
  isActive?: boolean;
  warrantyExpirationDate?: string;
  lastActivityDate?: string;
  [key: string]: any;
}

export interface AutotaskContract {
  id?: number;
  companyID?: number;
  contractName?: string;
  contractNumber?: string;
  startDate?: string;
  endDate?: string;
  status?: number;
  contactID?: number;
  [key: string]: any;
}

export interface AutotaskInvoice {
  id?: number;
  companyID?: number;
  // QuickBooks sync markers — a blank invoiceNumber means "never synced". These
  // stay null when Autotask doesn't know them (null must survive — never coerce a
  // missing sync/paid/void date to a boolean or 0).
  invoiceNumber?: string | null;
  batchID?: number | null;
  invoiceDateTime?: string | null;
  dueDate?: string | null;
  fromDate?: string | null;   // billing period start
  toDate?: string | null;     // billing period end
  invoiceTotal?: number | null;
  totalTaxValue?: number | null;
  isVoided?: boolean | null;
  voidedDate?: string | null;
  paidDate?: string | null;         // control group: paid ⇒ definitely synced
  webServiceDate?: string | null;   // QuickBooks Online sync timestamp (blank on Desktop)
  orderNumber?: string | null;      // free-text PO/order (doc called it purchaseOrderNumber)
  invoiceStatus?: number | null;
  paymentTerm?: number | null;
  comments?: string | null;
  createDateTime?: string | null;
  creatorResourceID?: number | null;
  /**
   * Composed by getInvoiceDetails() — line items from BillingItems filtered by
   * invoiceID, plus the distinct tickets/projects/tasks this invoice billed.
   */
  lineItems?: AutotaskBillingItem[];
  linkedTicketIDs?: number[];
  linkedProjectIDs?: number[];
  linkedTaskIDs?: number[];
  [key: string]: any;
}

export interface AutotaskTask {
  id?: number;
  projectID?: number;
  title?: string;
  description?: string;
  assignedResourceID?: number;
  status?: number;
  priority?: number;
  startDate?: string;
  endDate?: string;
  estimatedHours?: number;
  actualHours?: number;
  [key: string]: any;
}

export interface AutotaskPhase {
  id?: number;
  projectID?: number;
  title?: string;
  description?: string;
  startDate?: string;
  dueDate?: string;
  estimatedHours?: number;
  sortOrder?: number;
  scheduled?: boolean;
  createDate?: string;
  lastActivityDateTime?: string;
  [key: string]: any;
}

export interface AutotaskTicketNote {
  id?: number;
  ticketID?: number;
  noteType?: number;
  title?: string;
  description?: string;
  createDate?: string;
  createdByResourceID?: number;
  isVisibleToClientPortal?: boolean;
  [key: string]: any;
}

export interface AutotaskTicketChecklistItem {
  id?: number;
  ticketID?: number;
  itemName?: string;
  isCompleted?: boolean;
  position?: number;
  completedByResourceID?: number;
  completedDateTime?: string;
  [key: string]: any;
}

// Read-only entity (GET only). Each row represents a single audited change to a
// ticket field — value-before, value-after, who, when. Surface is intentionally
// open-ended because Autotask returns a wide, picklist-dependent field set.
export interface AutotaskTicketHistory {
  id?: number;
  ticketID?: number;
  resourceID?: number;
  dateChanged?: string;
  [key: string]: any;
}

export interface AutotaskProjectNote {
  id?: number;
  projectID?: number;
  noteType?: number;
  title?: string;
  description?: string;
  createDate?: string;
  createdByResourceID?: number;
  [key: string]: any;
}

export interface AutotaskCompanyNote {
  id?: number;
  companyID?: number;
  noteType?: number;
  title?: string;
  description?: string;
  createDate?: string;
  createdByResourceID?: number;
  [key: string]: any;
}

export interface AutotaskTicketAttachment {
  id?: number;
  ticketID?: number;
  fileName?: string;
  fileSize?: number;
  contentType?: string;
  data?: string; // Base64 encoded file data
  createDate?: string;
  createdByResourceID?: number;
  [key: string]: any;
}

/**
 * Request payload for creating a ticket attachment via
 * POST /Tickets/{id}/Attachments. Autotask expects the file bytes
 * as a base64-encoded string in `data`.
 */
export interface AutotaskTicketAttachmentCreateRequest {
  title: string;
  fullPath: string;
  data: string; // base64-encoded file bytes
  attachmentType?: string; // defaults to 'FILE_ATTACHMENT'
  contentType?: string;
  publish?: number; // 1 = All Autotask Users, 2 = Internal Users Only
}

/**
 * Project/Task attachment shape (child of Projects / Tasks). `data` is
 * populated only when fetched from the top-level entity endpoint by id.
 */
export interface AutotaskProjectAttachment {
  id?: number;
  parentID?: number;
  projectID?: number;
  fileName?: string;
  fileSize?: number;
  contentType?: string;
  data?: string; // Base64 encoded file data
  createDate?: string;
  attachedByResourceID?: number;
  [key: string]: any;
}

export interface AutotaskTaskAttachment {
  id?: number;
  parentID?: number;
  taskID?: number;
  fileName?: string;
  fileSize?: number;
  contentType?: string;
  data?: string; // Base64 encoded file data
  createDate?: string;
  attachedByResourceID?: number;
  [key: string]: any;
}

/**
 * Request payload for creating a project or task attachment. Same shape as the
 * ticket variant — the parent (project/task) is established by the child
 * endpoint URL, so no parent id/type is carried here. Bytes are base64-encoded.
 */
export interface AutotaskAttachmentCreateRequest {
  title: string;
  fullPath: string;
  data: string; // base64-encoded file bytes
  attachmentType?: string; // defaults to 'FILE_ATTACHMENT'
  contentType?: string;
  publish?: number; // 1 = All Autotask Users, 2 = Internal Users Only
}

export interface AutotaskExpenseReport {
  id?: number;
  name?: string;
  submittedByResourceID?: number;
  submitDate?: string;
  approvedDate?: string;
  status?: number;
  totalAmount?: number;
  [key: string]: any;
}

export interface AutotaskExpenseItem {
  id?: number;
  expenseReportID?: number;
  expenseDate?: string;
  description?: string;
  amount?: number;
  billableToAccount?: boolean;
  [key: string]: any;
}

export interface AutotaskQuote {
  id?: number;
  companyID?: number;
  contactID?: number;
  quoteNumber?: string;
  quoteDate?: string;
  title?: string;
  description?: string;
  totalAmount?: number;
  status?: number;
  [key: string]: any;
}

export interface AutotaskOpportunity {
  id?: number;
  companyID?: number;
  title?: string;
  description?: string;
  amount?: number;
  cost?: number;
  probability?: number;
  projectedCloseDate?: string;
  status?: number;
  stage?: number;
  ownerResourceID?: number;
  useQuoteTotals?: boolean;
  createDate?: string;
  lastActivityDate?: string;
  [key: string]: any;
}

export interface AutotaskProduct {
  id?: number;
  name?: string;
  description?: string;
  unitPrice?: number;
  unitCost?: number;
  isActive?: boolean;
  isSerialized?: boolean;
  [key: string]: any;
}

export interface AutotaskServiceEntity {
  id?: number;
  name?: string;
  description?: string;
  unitPrice?: number;
  unitCost?: number;
  isActive?: boolean;
  periodType?: number;
  billingCodeID?: number;
  [key: string]: any;
}

export interface AutotaskServiceBundle {
  id?: number;
  name?: string;
  description?: string;
  unitPrice?: number;
  unitCost?: number;
  isActive?: boolean;
  periodType?: number;
  billingCodeID?: number;
  [key: string]: any;
}

export interface AutotaskQuoteItem {
  id?: number;
  quoteID?: number;
  name?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  unitDiscount?: number;
  unitCost?: number;
  lineDiscount?: number;
  percentageDiscount?: number;
  isOptional?: boolean;
  productID?: number;
  serviceID?: number;
  serviceBundleID?: number;
  chargeID?: number;
  laborID?: number;
  expenseID?: number;
  shippingID?: number;
  quoteItemType?: number;
  sortOrderID?: number;
  totalEffectiveTax?: number;
  averageDiscount?: number;
  internalCurrencyUnitPrice?: number;
  [key: string]: any;
}

/**
 * TicketCharge - represents a charge (material, cost, or expense) associated with a ticket.
 * Charges can be used to bill clients for parts, travel, or other non-labor costs.
 */
export interface AutotaskTicketCharge {
  id?: number;
  ticketID?: number;
  productID?: number;
  name?: string;
  description?: string;
  chargeType?: number;
  unitQuantity?: number;
  unitPrice?: number;
  unitCost?: number;
  billingCodeID?: number;
  billableToAccount?: boolean;
  datePurchased?: string;
  createDate?: string;
  creatorResourceID?: number;
  status?: number;
  contractServiceID?: number;
  contractServiceBundleID?: number;
  internalCurrencyUnitPrice?: number;
  internalCurrencyUnitCost?: number;
  [key: string]: any;
}

export interface AutotaskServiceCall {
  id?: number;
  description?: string;
  status?: number;
  startDateTime?: string;
  endDateTime?: string;
  duration?: number;
  companyID?: number;
  companyLocationID?: number;
  complete?: boolean;
  createDate?: string;
  lastModifiedDateTime?: string;
  creatorResourceID?: number;
  [key: string]: any;
}

export interface AutotaskServiceCallTicket {
  id?: number;
  serviceCallID?: number;
  ticketID?: number;
  [key: string]: any;
}

export interface AutotaskServiceCallTicketResource {
  id?: number;
  serviceCallTicketID?: number;
  resourceID?: number;
  [key: string]: any;
}

export interface AutotaskServiceCallTask {
  id?: number;
  serviceCallID?: number;
  taskID?: number;
  [key: string]: any;
}

export interface AutotaskServiceCallTaskResource {
  id?: number;
  serviceCallTaskID?: number;
  resourceID?: number;
  [key: string]: any;
}

export interface AutotaskCompanyLocation {
  id?: number;
  companyID?: number;
  name?: string;
  isPrimary?: boolean;
  isActive?: boolean;
  [key: string]: any;
}

// CompanyToDos — Autotask calendar/CRM follow-ups. Distinct from ticket
// checklist items, project tasks, time entries, appointments, and service
// calls. No `isComplete` field: `completedDate == null` means open.
export interface AutotaskCompanyToDo {
  id?: number;
  companyID?: number;
  assignedToResourceID?: number;
  actionType?: number;
  activityDescription?: string;
  startDateTime?: string;
  endDateTime?: string;
  completedDate?: string | null;
  contactID?: number;
  contractID?: number;
  opportunityID?: number;
  ticketID?: number;
  [key: string]: any;
}


export interface AutotaskBillingCode {
  id?: number;
  name?: string;
  description?: string;
  isActive?: boolean;
  hourlyRate?: number;
  [key: string]: any;
}

export interface AutotaskDepartment {
  id?: number;
  name?: string;
  description?: string;
  isActive?: boolean;
  [key: string]: any;
}

/**
 * BillingItem - represents an approved and posted billable item in Autotask.
 * These are items that have gone through the "Approve and Post" workflow.
 */
export interface AutotaskBillingItem {
  readonly id?: number;
  itemName?: string;
  description?: string;
  billingItemType?: number;
  companyID?: number;
  contractID?: number;
  ticketID?: number;
  taskID?: number;
  projectID?: number;
  timeEntryID?: number;
  expenseItemID?: number;
  milestoneID?: number;
  itemApproverID?: number;
  postedDate?: string;
  itemDate?: string;
  quantity?: number;
  rate?: number;
  extendedPrice?: number;
  totalAmount?: number;
  internalCurrencyExtendedPrice?: number;
  internalCurrencyRate?: number;
  internalCurrencyTotalAmount?: number;
  invoiceID?: number;
  accountManagerWhenApprovedID?: number;
  businessDivisionSubdivisionID?: number;
  nonBillable?: number;
  taxDollars?: number;
  webServiceDate?: string;
  [key: string]: any;
}

/**
 * BillingItemApprovalLevel - describes a multi-level approval record for an Autotask time entry.
 * This entity enables developers to implement tiered approval workflows through the REST API.
 */
export interface AutotaskBillingItemApprovalLevel {
  readonly id?: number;
  timeEntryID?: number;
  approvalLevel?: number;
  approvalResourceID?: number;
  approvalDateTime?: string;
  [key: string]: any;
}

export interface AutotaskUserDefinedField {
  name: string;
  value: string;
}

// API Response wrapper types
export interface AutotaskApiResponse<T> {
  items: T[];
  pageDetails?: {
    count: number;
    requestCount: number;
    prevPageUrl?: string;
    nextPageUrl?: string;
  };
}

export interface AutotaskApiSingleResponse<T> {
  item: T;
}

// Filter and query types that match autotask-node structure
export interface AutotaskQueryOptions {
  filter?: Record<string, any>;
  sort?: string;
  page?: number;
  pageSize?: number;
  // Common search filters (Issue #8 fix)
  searchTerm?: string;
  companyID?: number;
  isActive?: boolean | number;
}

// Extended query options for more advanced queries
export interface AutotaskQueryOptionsExtended extends AutotaskQueryOptions {
  includeFields?: string[];
  excludeFields?: string[];
  expand?: string[];
  submitterId?: number;
  companyId?: number;
  companyID?: number;
  contactId?: number;
  contactID?: number;
  opportunityId?: number;
  searchTerm?: string;
  /** Ticket title contains (case-insensitive keyword search). */
  title?: string;
  status?: number;
  priority?: number;
  queueID?: number;
  assignedResourceID?: number;
  unassigned?: boolean;
  // Date filters for ticket searches
  createdAfter?: string;
  createdBefore?: string;
  lastActivityAfter?: string;
  // Idempotency: the caller-supplied external correlation id (occurrence key)
  externalID?: string;
  // Expense item filters
  expenseReportId?: number;
  /** Expense items logged against this ticket (its "Charges & Expenses"). */
  ticketId?: number;
  startDate?: string;
  endDate?: string;
}

// Note: Ticket status values are instance-specific picklist values.
// Use autotask_list_ticket_statuses to discover valid values at runtime.

export enum TicketPriority {
  Low = 1,
  Medium = 2,
  High = 3,
  Critical = 4,
  Urgent = 5
}

export enum CompanyType {
  Customer = 1,
  Lead = 2,
  Prospect = 3,
  DeadLead = 4,
  Vendor = 5,
  Partner = 6
} 
/**
 * One offset-style page of search results, plus pagination metadata the caller
 * can trust.
 *
 * Autotask's REST API paginates by cursor (`pageDetails.nextPageUrl`) and has
 * no offset parameter, so a caller-supplied `page` is emulated by fetching
 * `page * pageSize` records and slicing. `hasMore` is derived by over-fetching
 * a single extra record rather than from `items.length >= pageSize`, which
 * false-positives whenever the final page happens to be exactly full.
 */
export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Set when the page came from the Postgres shadow instead of the live API. */
  servedFrom?: { source: 'shadow'; ageSeconds: number };
}
