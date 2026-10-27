// Autotask Tool Definitions
// Declarative schema definitions for all MCP tools

import { McpTool } from './tool.handler.js';
import { TICKET_CARD_META } from './card.builder.js';

// Contract shell fields shared by autotask_create_contract and
// autotask_create_contracts_bulk (issue #237). Field names match the
// Autotask REST API exactly.
const CONTRACT_SHELL_PROPERTIES = {
  companyID: { type: 'number', description: 'Company ID the contract is associated with' },
  contractName: { type: 'string', description: 'Contract name' },
  contractType: { type: 'number', description: 'Contract type picklist ID' },
  contractCategory: { type: 'number', description: 'Contract category picklist ID' },
  startDate: { type: 'string', description: 'Contract start date (ISO YYYY-MM-DD)' },
  endDate: { type: 'string', description: 'Contract end date (ISO YYYY-MM-DD)' },
  contactID: { type: 'number', description: 'Primary contact ID for the contract' },
  contractNumber: { type: 'string', description: 'External-facing contract number' },
  contractPeriodType: { type: 'number', description: 'Period type picklist ID' },
  description: { type: 'string', description: 'Contract description / notes' },
  estimatedCost: { type: 'number', description: 'Estimated cost' },
  estimatedHours: { type: 'number', description: 'Estimated hours' },
  estimatedRevenue: { type: 'number', description: 'Estimated revenue' },
  setupFee: { type: 'number', description: 'Setup fee amount' },
  overageBillingRate: { type: 'number', description: 'Overage billing rate' },
  serviceLevelAgreementID: { type: 'number', description: 'SLA ID' },
  purchaseOrderNumber: { type: 'string', description: 'Customer purchase order number' },
  opportunityID: { type: 'number', description: 'Originating opportunity ID' },
  billingPreference: { type: 'number', description: 'Billing preference picklist ID' },
  billToCompanyID: { type: 'number', description: 'Bill-to company ID' },
  billToCompanyContactID: { type: 'number', description: 'Bill-to contact ID' },
  exclusionContractID: { type: 'number', description: 'Exclusion contract ID' },
  isDefaultContract: { type: 'boolean', description: 'Whether this is the default contract for the company' },
  internalCurrencySetupFee: { type: 'number', description: 'Setup fee in internal currency' },
  internalCurrencyOverageBillingRate: { type: 'number', description: 'Overage rate in internal currency' },
  organizationalLevelAssociationID: { type: 'number', description: 'Org level association ID' },
  contractExclusionSetID: { type: 'number', description: 'Contract exclusion set ID' },
  renewedContractID: { type: 'number', description: 'ID of the contract this renewed' },
  setupFeeBillingCodeID: { type: 'number', description: 'Billing code ID for the setup fee' },
  status: { type: 'number', description: 'Contract status (1=In Effect, 0=Inactive)' },
  timeReportingRequiresStartAndStopTimes: { type: 'number', description: 'Whether time entries require start/stop times' }
};

const CONTRACT_SHELL_REQUIRED = ['companyID', 'contractName', 'contractType', 'contractCategory', 'startDate', 'endDate'];

export const TOOL_DEFINITIONS: McpTool[] = [
  // Vendor purchasing & billing reconciliation (P0, read-only toward Autotask)
  {
    name: 'autotask_vendor_list_sources',
    description: 'READ-ONLY. Vendor billing sources: the supported vendor adapters and file formats, every imported invoice (vendor, invoice number/date, lines, total, warnings, who imported it) and mapping coverage — vendor customers mapped to Autotask companies, vendor SKUs mapped to manufacturer offerings, Autotask services linked to offerings. Start here before a reconciliation. Needs the Postgres store (migration 0010).',
    annotations: { title: 'Vendor billing sources', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { vendor: { type: 'string', description: 'Only this vendor (e.g. pax8)' } }, required: [] }
  },
  {
    name: 'autotask_vendor_import_invoice',
    description: 'Import a vendor billing file into the reconciliation store (Postgres only — nothing in Autotask changes). Accepts the Pax8 invoice CSV export (Pax8 → Billing → Invoices → export CSV: every line is kept — Microsoft and non-Microsoft products, prorations, arrears, minimum-commitment charges, surcharges, credits, NFR, zero-quantity rows — each classified by charge type and term MM / AM / AA / monthly / one-time) and the Pax8 company report (PSA admin → Mappings → Download company report: the vendor\'s own customer ↔ Autotask company crosswalk). Idempotent: the same file (SHA-256) is never imported twice. Verifies every line is accounted for: per-customer subtotals printed by the vendor vs the sum of the imported lines. Pass the file text in content.',
    annotations: { title: 'Import vendor invoice / crosswalk', readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: 'Original file name (Pax8: csv-p<account>-<invoice>-<date>.csv — the invoice number comes from it)' },
        content: { type: 'string', description: 'The file contents (CSV text). Max 10 MB.' },
        contentBase64: { type: 'string', description: 'Alternative to content: base64 of the file' },
        invoiceNumber: { type: 'string', description: 'Override when the file name does not carry it' }
      },
      required: ['fileName']
    }
  },
  {
    name: 'autotask_vendor_get_lines',
    description: 'READ-ONLY. Imported vendor invoice lines with filters, plus totals by charge class, cadence and customer. Each line: vendor customer, subscription id, SKU, description, charge class (recurring / usage / one_time / proration / credit / minimum_commitment / vendor_fee / nfr_internal), cadence, unit, quantity, unit cost, total, the vendor\'s suggested price (reference only — never GDS revenue), service period, renewal, and the customer / offering mapping it resolves to (or "unmapped").',
    annotations: { title: 'Vendor invoice lines', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        vendor: { type: 'string' }, invoiceDate: { type: 'string', description: 'YYYY-MM-DD (the invoice date)' }, documentId: { type: 'number' },
        vendorCustomerId: { type: 'string' }, sku: { type: 'string' },
        chargeClass: { type: 'string', description: 'Only this charge class' }, unmappedOnly: { type: 'boolean', description: 'Only lines whose customer or SKU is not mapped yet' },
        limit: { type: 'number', description: 'Lines to return (default 200, max 5000; totals always cover all matching lines)' }
      },
      required: []
    }
  },
  {
    name: 'autotask_reconcile_resolve_mapping',
    description: 'Review and decide the durable identity mappings reconciliation runs on (stored in the MCP\'s Postgres; nothing in Autotask changes). kind: customers (vendor customer → Autotask company, or internal / ignore), offerings (vendor SKU → manufacturer offering — the PRODUCT, not the sales channel, so a distributor change is only a remap), catalog (Autotask Service → offering + the term it sells, MM / AM / AA / monthly / annual). action: propose (suggestions with confidence and reason — nothing saved; customers come from the vendor crosswalk first, then exact Autotask names; an unmatched one is shown, never guessed), list (current decisions), set (decide specific items), accept (save every current proposal at or above minConfidence — an explicit decision by the caller). Every change keeps the previous decision (versioned).',
    annotations: { title: 'Resolve vendor mappings', readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['customers', 'offerings', 'catalog'] },
        action: { type: 'string', enum: ['propose', 'list', 'set', 'accept'] },
        vendor: { type: 'string', description: 'Vendor (default pax8)' },
        minConfidence: { type: 'string', enum: ['high', 'medium'], description: 'accept: lowest confidence to save (default high)' },
        includeMapped: { type: 'boolean', description: 'propose: also re-propose already-decided items' },
        items: {
          type: 'array',
          description: 'set: customers [{ vendorCustomerId, status: mapped|internal|ignore, autotaskCompanyId?, note? }]; offerings [{ sku, status: mapped|not_billable|ignore, offeringId? | offering: { manufacturer, name, unit?, kind? }, note? }]; catalog [{ autotaskId, offeringId, cadence, autotaskEntity? (default Services), note? }]',
          items: { type: 'object', additionalProperties: true }
        }
      },
      required: ['kind', 'action']
    }
  },
  {
    name: 'autotask_reconcile_vendor_to_autotask',
    description: 'READ-ONLY. Reconcile one imported vendor invoice (default: the latest) against what customers are actually billed: each vendor line → its mapped Autotask company → every Recurring Service contract IN EFFECT for the invoice month (active contracts that start later / ended earlier / are another type are named, not matched) → the contract services — and service BUNDLES whose component services — are the same PRODUCT (offering) → the unit period for the invoice month and the POSTED recurring billing items. Also the other direction: "not_purchased" (high) = the customer is billed for a product this vendor supplies but no longer charges us for (cancelled subscription still billed; annual-billed ones are checked against the last 13 months of invoices); and one row per bundle comparing its price with the landed cost of its components. Per (customer, product, term) row: quantity, cost should be (landed vendor cost), price should be (pricing policy, with its rule), current contract cost / price, billed rate, differences, monthly / annual exposure, margin, confidence. Exceptions by severity — critical: below landed cost, vendor charge not billed back; high: quantity short, term mismatch, cost not updated, inactive company; review: below target / margin floor, negotiated price, billed on several lines, quantity over, unmapped customer / SKU, prorations / credits; info: internal, NFR, vendor fees. A loss is "confirmed" only when a posted invoice shows the billed rate; unknown quantities are "unverified", never zero. Saves the run (exceptions keep their status / owner across runs). Nothing in Autotask changes.',
    annotations: { title: 'Reconcile vendor invoice vs contracts', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { vendor: { type: 'string', description: 'Default pax8' }, invoiceNumber: { type: 'string' }, documentId: { type: 'number' }, limit: { type: 'number', description: 'Rows returned (default 50; the run keeps all)' }, includeOk: { type: 'boolean', description: 'Also return matching / informational rows' } }, required: [] }
  },
  {
    name: 'autotask_reconcile_get_exceptions',
    description: 'Work the reconciliation exceptions. action=list (default): rows of a run (default the latest) filtered by severity (default critical / high / review), customer, exceptionType (below_cost, not_billed, qty_short, term_mismatch, cost_stale, below_target, …), sku, minExposure, status, owner, overdue (past dueOn and still undecided), undecided — with each exception’s status, owner, dueOn, reference; the result splits open exposure from absorbed. action=update: by exceptionKey set the OUTCOME (status: open | acknowledged | resolved = fixed in Autotask | accepted = expected variance | absorbed = GDS carries the cost, needs a note | billed_elsewhere = billed on another company / contract, needs reference | fix_planned = a change plan fixes it, reference = plan id), owner, dueOn (YYYY-MM-DD; null clears), a note — appended to the exception’s history and kept across monthly runs (a resolved one that reappears reopens; other outcomes stand). The vendor monitor reports overdue ones. Postgres only.',
    annotations: { title: 'Reconciliation exceptions', readOnlyHint: false },
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'update'] }, runId: { type: 'string' }, vendor: { type: 'string' }, severity: { type: 'array', items: { type: 'string', enum: ['critical', 'high', 'review', 'info', 'ok'] } }, customer: { type: 'string' }, exceptionType: { type: 'string' }, sku: { type: 'string' }, minExposure: { type: 'number' }, status: { type: 'string', enum: ['open', 'acknowledged', 'resolved', 'accepted', 'absorbed', 'billed_elsewhere', 'fix_planned'] }, owner: { type: 'string' }, note: { type: 'string' }, dueOn: { type: 'string', description: 'update: YYYY-MM-DD the decision is due' }, reference: { type: 'string', description: 'update: where it is billed (billed_elsewhere) or the plan id (fix_planned)' }, overdue: { type: 'boolean', description: 'list: only past due and undecided' }, undecided: { type: 'boolean', description: 'list: only open / acknowledged' }, keys: { type: 'array', items: { type: 'string' }, description: 'update: exceptionKey values' }, includeHistory: { type: 'boolean' }, limit: { type: 'number' } }, required: [] }
  },
  {
    name: 'autotask_vendor_pricing_policy',
    description: 'How "Price Should Be" is set (requirements §5). action=list; action=set { scope: "*" | manufacturer (e.g. "Microsoft") | "offering:<id>", mode: vendor_suggested (the vendor’s suggested retail price; with pct, retail × (1 + pct) — e.g. pct 5 = 5% over retail) | margin (price = cost / (1 − pct)) | markup (price = cost × (1 + pct)), pct, marginFloor (never propose below this margin on cost — the floor when retail is at or below cost; e.g. vendor_suggested + pct 0 + marginFloor 10 = retail, but at least a 10% margin), feePolicy: overhead | allocate (vendor fees such as the card surcharge added into landed cost) }; action=set_negotiated / remove_negotiated { companyId, offeringId, cadence?, price, reason, expiresOn? } — a negotiated customer price is honoured as the target and never flagged as below target. Default until set: the vendor’s suggested price, never below cost, fees as overhead. Postgres only.',
    annotations: { title: 'Pricing policy', readOnlyHint: false },
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'set', 'set_negotiated', 'remove_negotiated'] }, scope: { type: 'string' }, mode: { type: 'string', enum: ['vendor_suggested', 'margin', 'markup'] }, pct: { type: 'number' }, marginFloor: { type: 'number' }, feePolicy: { type: 'string', enum: ['overhead', 'allocate'] }, note: { type: 'string' }, companyId: { type: 'number' }, offeringId: { type: 'number' }, cadence: { type: 'string' }, price: { type: 'number' }, reason: { type: 'string' }, expiresOn: { type: 'string' } }, required: [] }
  },
  {
    name: 'autotask_reconcile_export_workbook',
    description: 'READ-ONLY. The reconciliation workbook (.xlsx, base64 in contentBase64) for a run (default the latest): Executive Summary, Exceptions, All Vendor Lines, Customer Contracts, Unmatched / Internal / NFR, Approved Changes, Execution Audit, Pricing Policy. Required columns first, in order: Customer Name | Autotask Contract | Vendor | Service / SKU | Commitment / Billing Term | Unit | Quantity | Cost Should Be | Price Should Be | Current Cost | Current Price | Difference on Cost | Difference on Price — then IDs, billed quantity / price, landed cost, exposure, margin, source invoice, confidence, reason, proposed action, status, owner.',
    annotations: { title: 'Export reconciliation workbook', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, vendor: { type: 'string' } }, required: [] }
  },
  {
    name: 'autotask_pricing_build_change_plan',
    description: 'Build (nothing is written) a frozen, numbered CONTRACT change plan from a reconciliation run. Kinds (include): cost (ContractServices.unitCost → landed cost; cost only); price (an adjustment with the target price — contract-service AND bundle prices change only through adjustments); quantity (the primary line follows the vendor quantity, UP or DOWN; vendor seats beyond a bundle become a standalone line next to it — a bundle is never shrunk automatically); missing_line (ONE adjustment adding the standard service, with its units and price, to the customer’s Recurring Service contract in effect); term (a line on a different term than the vendor sells moves to the standard service for the vendor’s term: add the new line, then end the old one — the second row runs only after the first); end_line (units → 0 on a line the vendor no longer charges for — approve only once you know it was cancelled); backbill (with backbillFrom=YYYY-MM: a ONE-TIME contract charge for the months from backbillFrom up to the effective date that the vendor charged and the customer was not billed — units missing × months × the contract price, or the target price with backbillPrice=target; on a material cost code with the same tax category as the service’s code (contract charges refuse recurring-service codes), linked to the contract line; blocked if billing was posted on the line inside that window). rows picks report rows. A line on a contract in effect with NO billing period for the month counts as 0 units (billing that stopped), so it is restored from the effective date and can be back-billed. Prospective by default: effective the 1st of next month; earlier months are only billed by an explicit backbill row. Blocked: not a Recurring Service contract in effect on the date, a period already invoiced (credits / rebills need separate approval), an ambiguous target contract (pass contractChoices { exceptionKey: contractId }), no standard service (run the catalog plan first). Vendor cost rising never raises a customer price by itself — every price row is a proposal a person approves (autotask_change_plan_review), then autotask_change_plan_execute re-reads each line first and skips it if its price / units changed since the plan.',
    annotations: { title: 'Plan: contract changes', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, vendor: { type: 'string' }, include: { type: 'array', items: { type: 'string', enum: ['cost', 'price', 'quantity', 'missing_line', 'term', 'end_line', 'backbill'] } }, backbillFrom: { type: 'string', description: 'backbill: the first month to back-bill, YYYY-MM' }, backbillPrice: { type: 'string', description: 'backbill: "contract" (default — the line’s current price), "target", or a number (e.g. the price in effect during those months)' }, backbillBillingCodeId: { type: 'number', description: 'backbill: the material cost code (BillingCodes useType 4) for the charge — default: the active material code with the service code’s tax category, preferring Software' }, rows: { type: 'array', items: { type: 'number' }, description: 'Report row numbers (default all)' }, effectiveDate: { type: 'string', description: 'YYYY-MM-DD (default the 1st of next month)' }, contractChoices: { type: 'object', additionalProperties: { type: 'number' }, description: 'For missing lines: { exceptionKey: contractId }' } }, required: [] }
  },
  {
    name: 'autotask_reconcile_check_sync_drift',
    description: 'READ-ONLY toward Autotask. Re-check every APPLIED catalog / contract plan row (last N days, default 120) against Autotask: a field that no longer holds the approved value — or a price adjustment whose effect (price / units from its effective date) was overwritten, e.g. by the Pax8 PSA sync — is recorded once and raised as a "sync.drift" notification. Nothing is re-applied automatically: decide which system owns the field first. Run it daily (n8n).',
    annotations: { title: 'Check sync drift', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { days: { type: 'number' } }, required: [] }
  },
  {
    name: 'autotask_vendor_sync',
    description: 'Pax8 Partner API (needs PAX8_CLIENT_ID / PAX8_CLIENT_SECRET in the server env; otherwise says how to set it up). what=status; what=invoices (import every Pax8 invoice since a date — same parser and checks as the CSV import, so API and CSV imports are identical); what=pricing (partner cost + suggested retail price for every mapped SKU and term MM / AM / AA / monthly, and the manufacturer’s own SKU recorded on the offering). A rejected key or a 429 is not retried. Writes to the MCP’s Postgres only.',
    annotations: { title: 'Sync from the Pax8 API', readOnlyHint: false },
    inputSchema: { type: 'object', properties: { what: { type: 'string', enum: ['status', 'invoices', 'pricing'] }, since: { type: 'string', description: 'invoices: YYYY-MM-DD (default 120 days ago)' }, vendorName: { type: 'string', description: 'pricing: limit the product scan to one manufacturer (e.g. Microsoft)' }, maxPages: { type: 'number' } }, required: [] }
  },
  {
    name: 'autotask_contract_plan_move_lines',
    description: 'Build (nothing is written) a frozen plan that MOVES contract lines onto another service — Autotask can’t change a contract line’s service, so each move is two rows: (1) an adjustment adding the target service to the same contract with the same units and price (or topping up the line it already has), then (2) an adjustment ending the old line (units → 0), which runs ONLY after row 1 is in, so the customer is never without the service and the bill does not change. source=duplicates (default): every line on an active contract whose service duplicates the STANDARD service for its product + term (after the catalog plan) → the standard service; rebuild the catalog plan afterwards to deactivate the emptied duplicates. source=lines: explicit [{ contractServiceId, toServiceId, reason? }] (e.g. old Dropsuite lines → NinjaOne). Effective the 1st of next month by default; blocked when the contract is not a Recurring Service contract in effect then, the target service is inactive, or the period is already invoiced. Approve both rows of a move, then autotask_change_plan_execute.',
    annotations: { title: 'Plan: move contract lines', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { source: { type: 'string', enum: ['duplicates', 'lines'] }, lines: { type: 'array', items: { type: 'object', properties: { contractServiceId: { type: 'number' }, toServiceId: { type: 'number' }, reason: { type: 'string' } }, required: ['contractServiceId', 'toServiceId'] } }, offeringIds: { type: 'array', items: { type: 'number' }, description: 'duplicates: only these offerings' }, effectiveDate: { type: 'string', description: 'YYYY-MM-DD (default the 1st of next month)' } }, required: [] }
  },
  {
    name: 'autotask_contract_plan_wording',
    description: 'Build (nothing is written) a frozen plan that updates the INVOICE TEXT of existing contract lines (ContractServices and ContractServiceBundles invoiceDescription) to the catalog’s current wording. A contract line keeps the text it had when it was added, so after a rename (e.g. Dropsuite → NinjaOne SaaS Backup) customers would still see the old name. match limits it to lines whose text contains a word (e.g. "Dropsuite"); offeringIds to some products. Text only — no prices or quantities. Exclude rows where customer-specific wording is intended, approve the rest, then autotask_change_plan_execute.',
    annotations: { title: 'Plan: contract invoice wording', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { match: { type: 'string', description: 'Only lines whose current invoice text contains this (case-insensitive)' }, offeringIds: { type: 'array', items: { type: 'number' } }, includeBundles: { type: 'boolean', description: 'Default true' } }, required: [] }
  },
  {
    name: 'autotask_change_plan_revert',
    description: 'Build (nothing is written) an UNDO plan for an executed change plan, from the before-images it kept: updated fields are put back (a field changed again since is skipped as stale); a service the plan created is deactivated (Autotask can’t delete services); a contract price / quantity / add / move adjustment gets a counter-adjustment restoring the line’s units and price from effectiveDate (default the 1st of next month, never before the original change). Periods already invoiced stay invoiced — credits are a separate decision. Only applied rows are undone; rows picks some. Approve it and run autotask_change_plan_execute like any plan.',
    annotations: { title: 'Plan: undo an executed plan', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, rows: { type: 'string', description: 'Original plan rows to undo: "all", "3-15", [row numbers] (default all applied)' }, effectiveDate: { type: 'string', description: 'YYYY-MM-DD for contract lines (default the 1st of next month)' } }, required: ['planId'] }
  },
  {
    name: 'autotask_billing_preinvoice_check',
    description: 'READ-ONLY. Run BEFORE Approve & Post. For the posting month (throughDate, default the end of this month; optional companyId — 0 is your own company) it lists: pending contract charges that bill at this posting (with $0 / below-cost warnings); DOUBLE BILLING — a back-bill charge for months another line of the same product already bills (e.g. a prepaid annual line); duplicate lines — one customer billed for the same product on two lines this month; contract plan changes taking effect this month and whether the customer notice is recorded; undecided critical reconciliation exceptions. Verdict stop | review | ready. Checks the customers with pending charges plus the latest reconciliation\u2019s customers.',
    annotations: { title: 'Pre-invoice check', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { throughDate: { type: 'string', description: 'YYYY-MM-DD — the date you will Approve & Post through' }, companyId: { type: 'number', description: 'Only this customer' } }, required: [] }
  },
  {
    name: 'autotask_pricing_customer_notices',
    description: 'Customer notice for a contract pricing plan (default: the newest open one). action=list: per customer the invoice changes the plan makes — price increases, new lines, back-bill charges, term moves, more seats — old → new, monthly and one-time difference, effective date, and whether the notice was recorded (and how many days before the effective date). action=export: the same as CSV (contentBase64) for a mail merge. action=mark_sent { companyIds | "all", sentOn (default today), method: email | letter | portal | call | waived | other, note (required for waived) } records the notice; action=unmark removes it. Executing a plan\u2019s approved customer-facing rows WAITS until that customer\u2019s notice (or waiver) is recorded. Writes only to the MCP store.',
    annotations: { title: 'Customer notices', readOnlyHint: false },
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'export', 'mark_sent', 'unmark'] }, planId: { type: 'string' }, companyIds: { type: 'array', items: { type: 'string' }, description: 'Autotask company ids, or ["all"]' }, sentOn: { type: 'string', description: 'YYYY-MM-DD' }, method: { type: 'string', enum: ['email', 'letter', 'portal', 'call', 'waived', 'other'] }, note: { type: 'string' }, minNoticeDays: { type: 'number', description: 'Warn when the notice is shorter than this (default 30)' } }, required: [] }
  },
  {
    name: 'autotask_report_gap',
    description: 'Tell the MCP\u2019s builders what you could NOT do. Call this whenever no tool does what the user needs (instead of guessing, or working around it with raw_request writes): title = one line of what was needed, detail = what the user asked and why the existing tools fell short, toolsTried, example (the input you would have sent). It lands on the admin console\u2019s Requests page; the same title again counts another occurrence. action=list shows open / planned requests — check before reporting a duplicate. Writes only to the MCP store.',
    annotations: { title: 'Report a missing capability', readOnlyHint: false },
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['report', 'list'] }, title: { type: 'string' }, detail: { type: 'string' }, toolsTried: { type: 'array', items: { type: 'string' } }, example: { type: 'object', description: 'The input you would have sent' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] }, status: { type: 'array', items: { type: 'string', enum: ['open', 'planned', 'built', 'declined', 'duplicate'] } }, search: { type: 'string' }, limit: { type: 'number' } }, required: [] }
  },
  {
    name: 'autotask_vendor_monitor',
    description: 'READ-ONLY toward Autotask. One monitoring pass, each finding sent once as a notification (console → Notifications): a vendor with no invoice imported for 35+ days; subscriptions on the latest invoice renewing within 30 days (annual commitments — confirm seat counts before they renew); contracts matched in the latest reconciliation that end within 45 days (plans are blocked past a contract’s end — renew first); and sync drift on applied plan changes (drift=false skips it). Runs daily by itself when MCP_VENDOR_MONITOR_HOUR_UTC is set; call it any time.',
    annotations: { title: 'Vendor monitor', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { drift: { type: 'boolean', description: 'Also check sync drift (default true)' } }, required: [] }
  },
  {
    name: 'autotask_vendor_prices',
    description: 'The vendor price reference reconciliation and catalog plans price from: partner cost and the vendor’s suggested price per SKU and term (MM / AM / monthly per month; AA / annual per year), each with its source and date. action: list (current price per SKU + term), refresh (record what the imported invoices show), set (add prices for terms not on an invoice yet — e.g. from the Pax8 catalog; items [{ sku, cadence, unitCost, suggestedPrice, effectiveDate? }]). Stored in the MCP’s Postgres only.',
    annotations: { title: 'Vendor price reference', readOnlyHint: false },
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'refresh', 'set'] }, vendor: { type: 'string', description: 'Default pax8' }, items: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: [] }
  },
  {
    name: 'autotask_catalog_plan_standardize',
    description: 'Build (read-only) a plan that brings the Autotask service catalog to one standard service per product and term, for the products we sell (on the vendor invoices or already in the catalog). Microsoft NCE products get MM / AM / AA; month-to-month products (e.g. NinjaOne SaaS Backup) get Monthly. Standard name "<Product> [NCE] - AM"; the description and invoice description spell the term out. Per product + term: KEEP the service most active contracts use and rename it; deactivate unused duplicates (an in-use duplicate is listed, never touched); CREATE missing terms with the vendor cost + suggested price and a sibling’s work type (blocked when a price is missing); optional catalog-price rows (reference only — customer contract prices never change here). Nothing is written: returns a frozen, numbered plan (id + hash) to approve with autotask_change_plan_review and apply with autotask_change_plan_execute.',
    annotations: { title: 'Plan: standardize service catalog', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { vendor: { type: 'string', description: 'Default pax8' }, offeringIds: { type: 'array', items: { type: 'number' }, description: 'Only these offerings' } }, required: [] }
  },
  {
    name: 'autotask_change_plan_review',
    description: 'Review and approve change plans (catalog standardization; contract pricing later). action: list (recent plans with row counts), get (every numbered row: action, before → after, reason, blocked, status), approve / exclude (rows "all", "3-15", "1,4,7-9" — with the plan hash you reviewed; blocked and information rows are never approvable). Approval is recorded with who and when. Nothing is written to Autotask here.',
    annotations: { title: 'Review / approve change plan', readOnlyHint: false },
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'get', 'approve', 'exclude'] }, planId: { type: 'string' }, hash: { type: 'string', description: 'approve / exclude: the plan hash you reviewed' }, rows: { type: 'string', description: '"all", "3-15" or "1,4,7-9"' }, actionableOnly: { type: 'boolean', description: 'get: only rows that can be approved' }, limit: { type: 'number' } }, required: [] }
  },
  {
    name: 'autotask_change_plan_execute',
    description: 'FINANCIAL — apply the APPROVED rows of a change plan to Autotask (confirm:true required). Each target is re-read first: a row whose record changed since the plan was built is skipped as STALE (rebuild the plan), never written over. Only that row’s fields are written, then read back and verified; failures are reported per row and re-running is safe (applied rows never run again; a create checks the record isn’t already there). An Autotask 401 / 429 stops the run. At most maxRows (default 25) per call — call again for the rest. Contract adjustments can’t be read back in Autotask, so they are verified by their EFFECT (the line’s units / price from the effective date); one written before Autotask shows that period is reported "not verifiable yet". A row that depends on another (the second row of a move) waits until that row is applied. rows runs only some approved rows — use it for a one-row PILOT before running a batch.',
    annotations: { title: 'Execute approved change plan rows', readOnlyHint: false, destructiveHint: false },
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, rows: { type: 'string', description: 'Only these approved rows: "3", "3-5" or "1,4" (e.g. a one-row pilot)' }, maxRows: { type: 'number', description: 'Rows per call (default 25, max 100)' }, confirm: { type: 'boolean', description: 'Must be true' } }, required: ['planId'] }
  },
  // Connection testing
  {
    name: 'autotask_setup_check',
    description: 'READ-ONLY. Is this PSArelay instance connected, and is its Autotask API user allowed to do what each module needs? Signs in (one usage read), names the API user, then probes READ access live for every entity the modules use — one 1-row query each, straight to Autotask (never the mirror / cache), ~30 calls — and reports per module: ready / blocked (no read access to …) / not fully checked, plus the write access each module needs from the security level (writes can\u2019t be probed without writing). Also: mirror backfill progress and how to connect ChatGPT, Claude and n8n (MCP endpoint from MCP_PUBLIC_URL). Modules: core, contracts, billing, vendor, cleanup, commerce. cached:true returns the last result without calling Autotask.',
    annotations: { title: 'Setup check (connection + permissions)', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { modules: { type: 'array', items: { type: 'string', enum: ['core', 'contracts', 'billing', 'vendor', 'cleanup', 'commerce'] } }, cached: { type: 'boolean' } }, required: [] }
  },
  {
    name: 'autotask_test_connection',
    description: 'Test Autotask API connection',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_get_api_usage',
    description: "Autotask API budget (read-only, one upstream call). Use when Autotask returns HTTP 429 / 'threshold exceeded', or to check headroom before a big job. Returns (1) Autotask's OWN live counter for this integration — requests used vs the limit in the current window, which counts EVERY caller sharing the API user (n8n, ChatGPT, automations), and (2) this MCP server's view since it started: upstream calls in the last hour / 5 minutes, the top upstream calls by method + entity (what is eating the budget), read-cache hits and shared in-flight reads (calls saved), and how many 429s it saw.",
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { title: 'Autotask API usage', readOnlyHint: true }
  },

  // Company tools
  {
    name: 'autotask_search_companies',
    description: 'Search companies. Plain mode: searchTerm (name contains) + isActive (+ classification label or id, + companyType with classification), paged, max 200/page; each row carries classification as {id, label} or null. IDENTITY mode (read-only, used when any of name / webDomain / emailDomain / phone / companyNumber / companyType is given): every plausible match with evidence (name_exact on the normalized name — suffixes like Inc/LLC ignored, name_partial, web_domain, contact_email_domain, phone on normalized digits, company_number) and conflicts, ranked; duplicate clusters; INACTIVE companies included unless isActive is set. Consumer email domains (gmail.com etc.) are never used to match a company. Returns id, name, web address, phone, type, active, owner, created date/by.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Plain mode: company name contains'
        },
        isActive: {
          type: 'boolean',
          description: 'Filter by active state. Identity mode includes inactive companies unless this is set.'
        },
        name: { type: 'string', description: 'Identity: company name, compared normalized (case, punctuation, Inc/LLC/Ltd/Co ignored)' },
        webDomain: { type: 'string', description: 'Identity: web domain or URL, e.g. edge-estimates.com' },
        emailDomain: { type: 'string', description: 'Identity: email domain — matches company web address and companies whose contacts use it' },
        phone: { type: 'string', description: 'Identity: phone in any format (compared on digits)' },
        companyNumber: { type: 'string', description: 'Identity: company number / external identifier (exact)' },
        companyType: { type: 'string', description: 'Identity: company type label or id (e.g. "Customer", "Prospect"). With classification it is a plain filter.' },
        classification: { type: 'string', description: 'Plain-mode filter: Classification exact label (case-insensitive) or picklist id, resolved against the tenant\'s live picklist. Combines with searchTerm (or name), isActive, companyType; not with webDomain / emailDomain / phone / companyNumber. Unknown or ambiguous → the choices. List the values: autotask_get_field_info { entityType: "Companies", fieldName: "classification" }.' },
        includeInactiveClassifications: { type: 'boolean', description: 'Let classification match an INACTIVE label (an id always matches). Default false.' },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 200',
          minimum: 1,
          maximum: 200
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_company',
    description: 'READ-ONLY. The complete company record by ID with creation metadata: every picklist labelled (company type, classification, territory, market segment, …), owner / created-by / impersonator resources and parent company named, UDFs with list labels. Use it to verify a user-supplied company ID.',
    annotations: { title: 'Get company (full)', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { companyID: { type: 'number', description: 'Company ID' } }, required: ['companyID'] }
  },
  {
    name: 'autotask_find_company_contact_candidates',
    description: 'READ-ONLY identity resolver — NEVER creates records. Given any of companyName, contactName, email, phone, domain, it searches contacts (exact email across all email fields, name, phone) and companies (normalized name, web domain, contacts\' email domain, phone), links them (a contact\'s company becomes a candidate; a contact inside a candidate company gains evidence), and returns for EACH side: a verdict (matched / ambiguous / unmatched) with confidence and reason, ranked candidates with evidence (email_exact, name_exact, web_domain, phone, linked_contact, …) and conflicting fields (different email than given, inactive, company mismatch), and duplicate clusters. A consumer email domain (gmail.com etc.) identifies the person, never the company.',
    annotations: { title: 'Find company/contact candidates', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        companyName: { type: 'string', description: 'Company name as given (e.g. from an email signature)' },
        contactName: { type: 'string', description: 'Person\'s name ("Daniel Lee")' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone in any format' },
        domain: { type: 'string', description: 'Company web domain if known (otherwise taken from a non-consumer email)' }
      },
      required: []
    }
  },
  {
    name: 'autotask_find_duplicate_companies',
    description: 'READ-ONLY. Likely duplicates of ONE company (searched around it, not a tenant scan): same normalized name, web domain, phone, or company number — inactive companies and creation dates included, each with evidence and conflicts.',
    annotations: { title: 'Find duplicate companies', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { companyID: { type: 'number', description: 'The company to look around' } }, required: ['companyID'] }
  },
  {
    name: 'autotask_bulk_inactivate',
    description: 'Bulk cleanup of PLACEHOLDER companies (e.g. the tens of thousands named "Gmail") and their contacts — prepared from the Postgres mirror, pushed to Autotask by a background worker at a set pace, so no chat ever loops thousands of writes. action=prepare { companyName (must be a placeholder name), createdByResourceId?, createdFrom?, createdTo?, includeContacts (default true), ratePerHour (default 3000 = off-hours rate), businessHours: { tz (default America/New_York), days [1-5], start 7, end 19, businessRate 1000 } | false, canary (default 50), quietHours (local hours with NO writes — another integration’s burst window;default "0-4, 21-22"; "none" for none) } → a job that prepares in the background: every matching company, its contacts, and a HISTORY check (tickets, projects, contracts, opportunities, quotes, sales orders, CIs, service calls, invoices, billing items, child companies, or a contact with a real name) — those are EXCLUDED (merge them in the UI). EMAIL SAFEGUARD (personal mail is also what real people use): every address on those contacts is checked across the whole tenant — a ticket on ANY contact with that address keeps its companies (excluded), excludeEmails [addresses] keeps them too, junkEmails [addresses a person confirmed as spam] waives the ticket rule for those addresses (company history / real names still exclude; keep wins), and an address that also lives on a contact of a real company is a duplicate (inactivated, shown); stats.emailSummary and stats.emailReview (per address: copies, decision, why, the real companies, tickets) — review them before approving. JUNK CONTACTS ON ONE REAL COMPANY: action=prepare { companyId, and either contactIds [ids on that company] or the domain rule: every active contact whose email domain is not the company’s own (its web address + keepDomains + non-webmail domains of contacts with history); onlyDomains? (only these), createdFrom? / createdTo?, includeNoEmail (default false), ticketsOk (default false: a contact on tickets is excluded; true = inactivate it anyway, tickets stay as they are), rates / businessHours as above, canary (default 25) }. The primary contact and contacts with projects, contracts, opportunities, quotes, CIs or to-dos are always EXCLUDED. stats.byDomain: per domain, inactivate / kept / excluded; stats.companyDomains: what was treated as the company’s own and why — review both before approving. action=status { jobId }: counts, pace now (business hours or not), ETA, pause reason. approve { jobId, hash } (the exact records). start / resume { jobId, confirm:true }: runs the canary first, then pauses for a check. pause, cancel, archive / unarchive { jobId } (a finished job — done, cancelled, failed — hidden from list unless includeArchived: true; nothing in Autotask changes), items { status: done (default) | pending | skipped | failed | excluded, limit } (the records with Autotask links — after the canary, open a few to check), excluded (the list), failed, retry_failed, list. action=activity { tz }: Autotask traffic per local hour (weekday / weekend) and a suggested business window. The worker re-reads tenant API usage every minute while writing, halves the pace from 40% usage, waits from 65%, writes nothing in quiet hours, pauses on a login problem or 20 failures in a row; it resumes after a restart.',
    annotations: { title: 'Bulk placeholder / junk-contact cleanup', readOnlyHint: false },
    inputSchema: { type: 'object', properties: { companyId: { type: 'number', description: 'Junk-contact cleanup on this one company' }, contactIds: { type: 'array', items: { type: 'number' } }, keepDomains: { type: 'array', items: { type: 'string' } }, onlyDomains: { type: 'array', items: { type: 'string' } }, includeNoEmail: { type: 'boolean' }, ticketsOk: { type: 'boolean' }, excludeEmails: { type: 'array', items: { type: 'string' }, description: 'Placeholder cleanup: addresses to keep (their companies are excluded)' }, junkEmails: { type: 'array', items: { type: 'string' }, description: 'Placeholder cleanup: addresses a person confirmed as junk; their tickets no longer keep their companies' }, quietHours: { type: 'string', description: 'Local hours with no writes, e.g. "0-4, 21-22" (default); "none" for none' }, action: { type: 'string', enum: ['prepare', 'status', 'approve', 'start', 'pause', 'resume', 'cancel', 'items', 'excluded', 'failed', 'retry_failed', 'archive', 'unarchive', 'list', 'activity'] }, includeArchived: { type: 'boolean' }, status: { type: 'string', enum: ['done', 'pending', 'skipped', 'failed', 'excluded'] }, jobId: { type: 'string' }, hash: { type: 'string' }, confirm: { type: 'boolean' }, companyName: { type: 'string' }, createdByResourceId: { type: 'number' }, createdFrom: { type: 'string' }, createdTo: { type: 'string' }, includeContacts: { type: 'boolean' }, ratePerHour: { type: 'number' }, businessRate: { type: 'number' }, businessHours: { type: 'object', properties: { tz: { type: 'string' }, days: { type: 'array', items: { type: 'number' } }, start: { type: 'number' }, end: { type: 'number' }, businessRate: { type: 'number' } } }, canary: { type: 'number' }, tz: { type: 'string' }, limit: { type: 'number' } }, required: [] }
  },
  {
    name: 'autotask_commerce_offerings',
    description: 'The OFFERING CATALOG for selling through Autotask: recurring plans / add-ons (an Autotask Service on a recurring service contract, optionally per unit — e.g. per user) and one-time services (a charge on a delivery ticket, with a MATERIAL billing code). Each offering can carry its delivery ticket (queue, title, description templates with {company} {quantity} {unitLabel} {offering}), contract defaults (contractCategory — required by Autotask — and termMonths), and the platform modules it unlocks. action=list { includeArchived?, platform? } | get { code } | set { offering: { code, name, kind: recurring|one_time, perUnit, unitLabel, autotaskServiceId, billingCodeId, unitPrice, delivery: { queueID, status, priority, issueType, subIssueType, title, description, estimatedHours }, contract: { contractCategory, termMonths, … }, charge: { chargeType, status, … }, modules: [..], platform } } — checks the Service exists and is active and the billing code is a material code (reads only) | archive { code } | restore { code }. Stored in Postgres; nothing in Autotask changes.',
    annotations: { title: 'Commerce: offering catalog', readOnlyHint: false },
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'get', 'set', 'archive', 'restore'] }, code: { type: 'string' }, platform: { type: 'string' }, includeArchived: { type: 'boolean' }, offering: { type: 'object' } }, required: [] }
  },
  {
    name: 'autotask_commerce_quote',
    description: 'READ-ONLY. Price an order before placing it: lines [{ offering, quantity, unitPrice? }] → each line\u2019s unit price (the offering\u2019s, or its Autotask Service\u2019s), totals one-time and recurring per period, and the modules it unlocks; problems (unknown / archived offering, bad quantity, no price).',
    annotations: { title: 'Commerce: quote', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { lines: { type: 'array', items: { type: 'object', properties: { offering: { type: 'string' }, quantity: { type: 'number' }, unitPrice: { type: 'number', description: 'Override the catalog price for this order' } }, required: ['offering'] } } }, required: ['lines'] }
  },
  {
    name: 'autotask_commerce_order',
    description: 'ORDERS — sell, set up and track in one flow. action=create { customer: { companyId } (existing) or { companyName, phone, address1, city, state, postalCode, webAddress } (new — refused if a company with that name exists), contacts: [{ firstName, lastName, emailAddress, phone?, title? }] (the users; the first is primary), lines: [{ offering, quantity }], startDate?, contractId? (use an existing contract), notes? } → ONE change plan (kind commerce_order): new company → its users (contacts) → a recurring service contract → each recurring line added by an adjustment (units = quantity, from the start date; Autotask prorates) → a delivery ticket per offering that has one → one-time charges on their ticket. Rows use the ids earlier rows create; every step is re-run safe. Approve with autotask_change_plan_review (planId, hash) and run with autotask_change_plan_execute. action=status { orderId }: where it stands — set up (company / contract / tickets), invoiced (its charges / contract lines on an Autotask invoice), paid (Invoices.paidDate, set when the payment syncs back) — tracked automatically every 5 minutes, with notifications commerce.order_ready / order_invoiced / order_paid / order_failed (a generic webhook channel lets a control plane react). action=change { contractId, lines: [{ offering, quantity }] (the NEW quantity per line; 0 removes it), effectiveDate? } — upgrades, add-ons, seat changes, downgrades on an existing recurring contract: one adjustment per changed line; increases from today (Autotask prorates the rest of the period — that is what gets invoiced now; the estimate is shown), decreases and removals from the next period start (no mid-period credit); existing lines keep their price, new ones take the catalog price; reports the recurring total and modules after the change. action=cancel_subscription { contractId, effectiveDate?, endContract? }: every catalog line to 0 at the next period start (and optionally the contract’s end date). Both are orders with a plan (kind commerce_change), tracked like any order; changes notify commerce.subscription_changed when they are in (entitlements follow). action=list { status? } | track (all open orders) | invoice_queue (set up, waiting for an invoice) | mark_paid { orderId, reference, method } (paid outside Autotask) | cancel { orderId } (only before it is set up). Invoices are not created through the API (Autotask doesn\u2019t allow it) — they come from Autotask\u2019s invoicing.',
    annotations: { title: 'Commerce: orders', readOnlyHint: false },
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'change', 'cancel_subscription', 'status', 'list', 'track', 'invoice_queue', 'mark_paid', 'cancel'] }, effectiveDate: { type: 'string', description: 'change / cancel_subscription: YYYY-MM-DD for every line (default: increases today, decreases at the next period start)' }, endContract: { type: 'boolean', description: 'cancel_subscription: also end the contract the day before the lines stop' }, orderId: { type: 'string' }, customer: { type: 'object' }, contacts: { type: 'array', items: { type: 'object', properties: { firstName: { type: 'string' }, lastName: { type: 'string' }, emailAddress: { type: 'string' }, phone: { type: 'string' }, title: { type: 'string' } } } }, lines: { type: 'array', items: { type: 'object', properties: { offering: { type: 'string' }, quantity: { type: 'number' }, unitPrice: { type: 'number', description: 'Override the catalog price for this order' } }, required: ['offering'] } }, startDate: { type: 'string' }, contractId: { type: 'number' }, notes: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' }, reference: { type: 'string' }, method: { type: 'string' } }, required: [] }
  },
  {
    name: 'autotask_merge_discover',
    description: 'READ-ONLY. Find candidate duplicate companies / contacts before a merge: by email (exact, across ALL THREE contact email fields, active and inactive, every page — no 200 cap), by company name (exact), or around given companyIds / contactIds (with their contacts). Returns exact totals, placeholders ("Gmail" companies, "Unknown Contact"), who created them (createdByResourceID → name) and when (per day, first / latest), each company\u2019s contact ids, deep links, and survivor HINTS (real, active, oldest) — a person decides; nothing is chosen. Same email is a candidate, never proof of the same person.',
    annotations: { title: 'Merge: discover duplicates', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { email: { type: 'string' }, name: { type: 'string', description: 'Exact company name, e.g. "Gmail"' }, companyIds: { type: 'array', items: { type: 'number' } }, contactIds: { type: 'array', items: { type: 'number' } }, includeInactive: { type: 'boolean', description: 'Default true' }, limit: { type: 'number', description: 'Rows listed (totals are always complete); default 500' } }, required: [] }
  },
  {
    name: 'autotask_merge_dependency_inventory',
    description: 'READ-ONLY. For each company id (and / or contact id): every record pointing at it, per entity — contacts, tickets, projects, contracts (active ones counted), opportunities, quotes, sales orders, configuration items, service calls, notes, to-dos, locations, alerts, invoices and billing items (financial history), child companies; for contacts: tickets, projects, contracts, opportunities, quotes, CIs, to-dos. Counts, the first 50 ids, whether the API could change the link (from live field info), and BLOCKERS (active contracts → billing review; financial history; parent of other companies; an entity that could not be checked). Up to 500 ids.',
    annotations: { title: 'Merge: dependency inventory', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { companyIds: { type: 'array', items: { type: 'number' } }, contactIds: { type: 'array', items: { type: 'number' } } }, required: [] }
  },
  {
    name: 'autotask_merge_build_plan',
    description: 'Build a MERGE PLAN — addressed ONLY by numeric Autotask ids, one kind per plan. entityType "company": survivorCompanyId + sourceCompanyIds; entityType "contact": survivorContactId + sourceContactIds; or a BATCH: csv (two columns per line: old id, correct id; header optional) or mappings [{ sourceId, survivorId }]. Names, emails and searches are refused as identifiers; so are repeated ids, a survivor among its sources, chains (A→B while B→C), company 0, and ids that are not that kind of record. The survivor must be a real (non-placeholder), active record. Autotask has no API merge, so the plan is a WORK LIST of Autotask UI steps with deep links: per source "MERGE #source → #survivor" (blocked while it has active contracts until billingReviewed: true), then "DELETE #source in Admin"; plus survivor fields a source could fill (suggestions) and, for companies, a reminder that their contacts are decided separately. Saved with a hash (autotask_change_plan_review shows it; execute refuses it — nothing is written by the MCP). Afterwards: autotask_merge_verify.',
    annotations: { title: 'Merge: build plan (ID-only)', readOnlyHint: false },
    inputSchema: { type: 'object', properties: { entityType: { type: 'string', enum: ['company', 'contact'] }, survivorCompanyId: { type: 'number' }, sourceCompanyIds: { type: 'array', items: { type: 'number' } }, survivorContactId: { type: 'number' }, sourceContactIds: { type: 'array', items: { type: 'number' } }, csv: { type: 'string', description: 'old_id,correct_id per line' }, mappings: { type: 'array', items: { type: 'object', properties: { sourceId: { type: 'number' }, survivorId: { type: 'number' } } } }, mode: { type: 'string', enum: ['native_ui'] }, billingReviewed: { type: 'boolean' }, allowInactiveSurvivor: { type: 'boolean' } }, required: ['entityType'] }
  },
  {
    name: 'autotask_merge_verify',
    description: 'READ-ONLY toward Autotask. After the UI merges: re-reads every survivor and source of a merge plan and everything that pointed at the sources. Per source: gone (merged and deleted — done), nothing left but still there (delete it in Admin), or still has records attached (not merged yet / the merge left them — listed per entity). Fails if a survivor is missing or inactive (merged the wrong way round?). Marks the plan\u2019s steps done (autotask_change_plan_review shows progress) and returns passed | partial | not_started | failed with the evidence. Deactivation alone is never reported as a merge.',
    annotations: { title: 'Merge: verify', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'] }
  },
  {
    name: 'autotask_create_company',
    description: 'Create new company record. Returns the new id; read it with autotask_get_company.',
    inputSchema: {
      type: 'object',
      properties: {
        companyName: {
          type: 'string',

        },
        companyType: {
          type: 'number',

        },
        phone: {
          type: 'string',

        },
        address1: {
          type: 'string',

        },
        address2: { type: 'string' },
        countryID: { type: 'number', description: 'Country ID (Autotask Countries entity)' },
        webAddress: { type: 'string', description: 'Website, e.g. https://example.com' },
        billToAddressToUse: { type: 'number', description: '1 = use the company address for billing' },
        invoiceTemplateID: { type: 'number', description: 'Invoice template. Omit to use the tenant default (console → Settings → Defaults); without one Autotask applies its own.' },
        quoteTemplateID: { type: 'number', description: 'Quote template (tenant default when omitted)' },
        taxRegionID: { type: 'number', description: 'Tax region (tenant default when omitted)' },
        invoiceEmailMessageID: { type: 'number', description: 'Email message used to send invoices (tenant default when omitted)' },
        quoteEmailMessageID: { type: 'number', description: 'Email message used to send quotes (tenant default when omitted)' },
        userDefinedFields: {
          type: 'array',
          description: 'Company UDFs as [{ name, value }] (e.g. [{ "name": "DBA / AKA", "value": "..." }])',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value']
          }
        },
        city: {
          type: 'string',
          
        },
        state: {
          type: 'string',
          
        },
        postalCode: {
          type: 'string',
          
        },
        ownerResourceID: {
          type: 'number',
          
        },
        isActive: {
          type: 'boolean',
          
        }
      },
      required: ['companyName', 'companyType']
    }
  },
  {
    name: 'autotask_update_company',
    description: 'Update company record. invoiceTemplateID sets payment terms (103=Due on Receipt, 104=NET 30). Billing address fields separate from regular address.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          
        },
        companyName: {
          type: 'string',
          
        },
        phone: {
          type: 'string',
          
        },
        address1: {
          type: 'string',
          description: 'Regular address (distinct from billingAddress1)'
        },
        address2: {
          type: 'string',
          
        },
        city: {
          type: 'string',
          
        },
        state: {
          type: 'string',
          
        },
        postalCode: {
          type: 'string',
          
        },
        countryID: {
          type: 'number',
          description: 'e.g. 237 for United States'
        },
        isActive: {
          type: 'boolean',
          
        },
        webAddress: {
          type: 'string',
          description: 'Website URL (field name is webAddress)'
        },
        // ---- Billing-to fields (used for Invoice Settings; SEPARATE from regular address) ----
        billingAddress1: {
          type: 'string',
          description: 'For invoices (separate from address1)'
        },
        billingAddress2: {
          type: 'string',
          description: 'Billing address line 2'
        },
        billToAttention: {
          type: 'string',
          description: 'Bill-to attention name'
        },
        billToAddressToUse: {
          type: 'number',
          description: '1 = use bill-to fields explicitly'
        },
        billToCity: {
          type: 'string',
          description: 'Bill-to city'
        },
        billToState: {
          type: 'string',
          description: 'Bill-to state/province'
        },
        billToZipCode: {
          type: 'string',
          description: 'Bill-to ZIP/postal code'
        },
        billToCountryID: {
          type: 'number',
          description: 'Bill-to country ID'
        },
        billToCompanyLocationID: {
          type: 'number',
          description: 'Bill-to company location ID'
        },
        // ---- Tax / invoice settings ----
        taxRegionID: {
          type: 'number',
          description: 'Tax region ID (capital ID suffix per Autotask convention)'
        },
        invoiceTemplateID: {
          type: 'number',
          description: 'Invoice template ID applied to this company. Acts as the payment-terms selector (e.g. 103=Due on Receipt, 104=NET 30).'
        },
        invoiceMethod: {
          type: 'number',
          description: 'Invoice delivery method picklist ID (e.g. 2=Email)'
        },
        invoiceEmailMessageID: {
          type: 'number',
          description: 'Default email-message template ID used when invoicing this company'
        },
        taxID: {
          type: 'string',
          description: 'Tax registration / FEIN / VAT identifier string'
        },
        isTaxExempt: {
          type: 'boolean',
          description: 'Whether the company is tax-exempt. Note: Autotask field name is `isTaxExempt` — not `taxExempt`.'
        },
        // ---- Quote / PO templates ----
        quoteEmailMessageID: {
          type: 'number',
          description: 'Default email-message template ID used when sending quotes'
        },
        quoteTemplateID: {
          type: 'number',
          description: 'Default quote template ID for this company'
        },
        purchaseOrderTemplateID: {
          type: 'number',
          description: 'Default purchase-order template ID for this company'
        },
        // ---- Ownership / classification ----
        ownerResourceID: {
          type: 'number',
          description: 'Resource ID of the account owner'
        },
        classification: {
          type: 'number',
          description: 'Company classification picklist ID'
        },
        companyType: {
          type: 'number',
          description: 'Company type picklist ID (e.g. Customer, Prospect, Vendor)'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_get_company_site_configuration',
    description: 'Get company site configuration records. Call first to discover available fields.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'The company ID whose site configuration records should be returned'
        }
      },
      required: ['companyId']
    }
  },
  {
    name: 'autotask_update_company_site_configuration',
    description: 'Update company site configuration. Fields are tenant-defined; call get first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The company site configuration record ID to update (obtained from autotask_get_company_site_configuration).'
        },
        updates: {
          type: 'object',
          description: 'Object containing the site configuration fields to update. Field names are tenant-specific.',
          additionalProperties: true
        }
      },
      required: ['id', 'updates']
    }
  },

  // Contact tools
  {
    name: 'autotask_search_contacts',
    description: 'Search contacts. Plain mode: searchTerm (name or email) + companyID + isActive, paged, max 200/page. IDENTITY mode (read-only, used when any of email / name / firstName / lastName / phone is given): EVERY match with evidence — email_exact across all three email fields (every exact-email duplicate is returned), name_exact / name_close (normalized, accents ignored), phone (normalized digits) — plus conflicts (inactive, different email than given) and duplicate clusters; inactive contacts included unless isActive is set. Returns id, full name, emails, phones, company id + name, active, created date.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for contact name or email'
        },
        email: { type: 'string', description: 'Identity: exact email (checked against all three email fields)' },
        name: { type: 'string', description: 'Identity: full name ("Daniel Lee" or "Lee, Daniel")' },
        firstName: { type: 'string', description: 'Identity: first name (with lastName)' },
        lastName: { type: 'string', description: 'Identity: last name (with firstName)' },
        phone: { type: 'string', description: 'Identity: phone in any format (phone / mobile / alternate, compared on digits)' },
        companyID: {
          type: 'number',
          description: 'Filter by company ID'
        },
        isActive: {
          type: 'number',
          description: 'Filter by active status (1=active, 0=inactive)'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 200',
          minimum: 1,
          maximum: 200
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_contact',
    description: 'READ-ONLY. The complete contact record by ID with creation metadata: company named, picklists labelled, UDFs with list labels. Use it to verify a user-supplied contact ID.',
    annotations: { title: 'Get contact (full)', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { contactID: { type: 'number', description: 'Contact ID' } }, required: ['contactID'] }
  },
  {
    name: 'autotask_find_duplicate_contacts',
    description: 'READ-ONLY. Likely duplicates of ONE contact across ALL companies (searched around it): any of its email addresses, its name, its phone — inactive contacts and creation dates included, each with evidence and conflicts.',
    annotations: { title: 'Find duplicate contacts', readOnlyHint: true },
    inputSchema: { type: 'object', properties: { contactID: { type: 'number', description: 'The contact to look around' } }, required: ['contactID'] }
  },
  {
    name: 'autotask_create_contact',
    description: 'Create new contact record',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: {
          type: 'number',
          description: 'Company ID for the contact'
        },
        firstName: {
          type: 'string',
          
        },
        lastName: {
          type: 'string',
          
        },
        emailAddress: {
          type: 'string',
          
        },
        phone: {
          type: 'string',
          
        },
        title: {
          type: 'string',

        },
        mobilePhone: { type: 'string' },
        note: { type: 'string', description: 'Contact note (max 50 characters in this tenant; longer is refused unless truncateNote)' },
        truncateNote: { type: 'boolean', description: 'Truncate a note over the limit instead of refusing' },
        primaryContact: { type: 'boolean' },
        billingContact: { type: 'boolean' },
        receivesEmailNotifications: { type: 'boolean' }
      },
      required: ['companyID', 'firstName', 'lastName']
    }
  },
  {
    name: 'autotask_find_or_create_contact',
    description: 'Find a contact in a company, or create it if none exists. Matches by email first (inactive contacts included — an inactive match is reactivated unless reactivate:false); with no email, by exact first + last name among the company\'s contacts. Two or more matches → status "ambiguous" with the candidate ids and NOTHING is created. Idempotent — a repeat returns the same contact instead of a duplicate. Returns { id, created, matchedBy, reactivated }. Prefer this over create_contact in automation.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Company the contact belongs to' },
        emailAddress: { type: 'string', description: 'Email used to match an existing contact (and set on create)' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        phone: { type: 'string' },
        mobilePhone: { type: 'string' },
        title: { type: 'string' },
        note: { type: 'string', description: 'Set on create only (max 50 characters unless truncateNote)' },
        truncateNote: { type: 'boolean' },
        primaryContact: { type: 'boolean', description: 'Set on create only' },
        billingContact: { type: 'boolean', description: 'Set on create only' },
        receivesEmailNotifications: { type: 'boolean', description: 'Set on create only' },
        reactivate: { type: 'boolean', description: 'Reactivate an inactive matched contact (default true)' }
      },
      required: ['companyID']
    }
  },
  {
    name: 'autotask_update_contact',
    description: 'Update contact record. Only provided fields are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'Contact ID to update'
        },
        firstName: {
          type: 'string',
          
        },
        lastName: {
          type: 'string',
          
        },
        emailAddress: {
          type: 'string',
          description: 'Primary email address'
        },
        phone: {
          type: 'string',
          description: 'Primary phone number'
        },
        title: {
          type: 'string',
          description: 'Job title'
        },
        isActive: {
          type: 'boolean',
          description: 'Whether the contact is active'
        },
        mobilePhone: {
          type: 'string',
          description: 'Mobile phone number'
        },
        addressLine: {
          type: 'string',
          description: 'Address line (primary)'
        },
        addressLine1: {
          type: 'string',
          description: 'Address line 1 (secondary)'
        },
        city: {
          type: 'string',
          description: 'City'
        },
        state: {
          type: 'string',
          description: 'State/province'
        },
        zipCode: {
          type: 'string',
          description: 'Postal/ZIP code'
        },
        countryID: {
          type: 'number',
          description: 'Country ID (Autotask Countries entity)'
        },
        primaryContact: {
          type: 'boolean',
          description: 'Whether this contact is the primary contact for their company'
        },
        billingContact: { type: 'boolean' },
        receivesEmailNotifications: { type: 'boolean' },
        note: { type: 'string', description: 'Contact note (max 50 characters in this tenant; longer is refused unless truncateNote)' },
        truncateNote: { type: 'boolean', description: 'Truncate a note over the limit instead of refusing' },
        userDefinedFields: {
          type: 'array',
          description: 'User-defined (custom) fields for the contact, as an array of { name, value } objects matching the Autotask REST API shape. Contacts support UDFs (hasUserDefinedFields: true).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'UDF name' },
              value: { type: 'string', description: 'UDF value (stringified)' }
            },
            required: ['name', 'value']
          }
        }
      },
      required: ['id']
    }
  },

  // Ticket tools
  {
    name: 'autotask_search_tickets',
    description: 'Search tickets by title keyword, ticket number, company, contact, queue, status, priority, assignee, dates. To find an EXISTING ticket about something (e.g. before creating one, or when reconciling a meeting), search by `title` keyword + `companyID` — Autotask filters server-side. "My tickets": `assignedToMe: true`, so it is ONE call returning only the matches. Do NOT list a whole company\'s open tickets and scan titles: every page re-fetches the pages before it and burns the shared Autotask API budget. Open tickets only unless `status` is given. Use autotask_get_ticket_details for full data. Max 500/page.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Keyword(s) the ticket TITLE contains (case-insensitive), e.g. "ThreatLocker", "Lenel", "passkey". Combine with companyID to find a specific existing ticket.'
        },
        searchTerm: {
          type: 'string',
          description: 'A ticket number or prefix (e.g. "T20260921.0086", "T20260921") matches ticket numbers; any other text is treated as a title keyword (same as `title`).'
        },
        contractID: {
          type: 'number',
          description: 'Filter by contract ID (contract reconciliation: which tickets are on this contract)'
        },
        noContract: {
          type: 'boolean',
          description: 'Only tickets with NO contract'
        },
        includeCompleted: {
          type: 'boolean',
          description: 'Include Complete tickets (default: open only). Needed for billing / contract sweeps.'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company ID'
        },
        contactID: {
          type: 'number',
          description: 'Filter by primary contact ID — returns only tickets where contactID matches'
        },
        status: {
          type: 'number',
          description: 'Filter by ticket status ID (omit for all open tickets)'
        },
        priority: {
          type: 'number',
          description: 'Filter by ticket priority ID. Use autotask_list_ticket_priorities to discover valid IDs.'
        },
        queueID: {
          type: 'number',
          description: 'Filter by queue ID. Use autotask_list_queues to discover valid IDs.'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Filter by assigned resource ID'
        },
        assignedToMe: {
          type: 'boolean',
          description: 'true = tickets assigned to the signed-in person ("my tickets"). PSArelay fills in their resource ID from the sign-in — no need to look it up.'
        },
        unassigned: {
          type: 'boolean',
          description: 'Set to true to find unassigned tickets'
        },
        createdAfter: {
          type: 'string',
          description: 'Filter tickets created on or after this date (ISO format, e.g. 2026-01-01)'
        },
        createdBefore: {
          type: 'string',
          description: 'Filter tickets created on or before this date (ISO format)'
        },
        lastActivityAfter: {
          type: 'string',
          description: 'Filter tickets with activity on or after this date (ISO format)'
        },
        externalID: {
          type: 'string',
          description: 'Filter by external correlation id (occurrence/idempotency key). For a dedicated idempotency check use autotask_find_ticket_by_external_id.'
        },
        page: {
          type: 'number',

          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 500',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_ticket_details',
    description: 'Get full ticket details including notes, time entries, and custom fields. The result carries `ticketUrl` — a link that opens the ticket in the Autotask web UI; give it to the user when they want the full detail rather than pasting long notes into chat.',
    _meta: TICKET_CARD_META,
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: {
          type: 'number',
          description: 'Ticket ID to retrieve'
        },
        fullDetails: {
          type: 'boolean',
          description: 'Whether to return full ticket details (default: false for optimized data)',
          default: false
        }
      },
      required: ['ticketID']
    }
  },
  {
    name: 'autotask_create_ticket',
    description: 'Create new ticket record',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: {
          type: 'number',
          description: 'Company ID for the ticket'
        },
        title: {
          type: 'string',
          
        },
        description: {
          type: 'string',
          
        },
        status: {
          type: 'number',
          
        },
        priority: {
          type: 'number',
          
        },
        assignedResourceID: {
          type: 'number',
          description: 'Assigned resource ID. If set, assignedResourceRoleID is also required by Autotask (auto-filled from the resource\'s default role when omitted). Use currentUser:true to assign to the calling user.'
        },
        assignedResourceRoleID: {
          type: 'number',
          description: 'Role ID for the assigned resource. Required by Autotask when assignedResourceID is set; auto-filled from the resource\'s defaultServiceDeskRoleID when omitted. Pass explicitly to override. Discover roles with autotask_search_roles / autotask_get_resource_roles.'
        },
        currentUser: {
          type: 'boolean',
          description: 'Assign to the calling user — resolves the caller to their Autotask resource (assignedResourceID) and auto-fills their default role. Alternative to assignedResourceID.'
        },
        contactID: {
          type: 'number',
          description: 'Contact ID for the ticket'
        },
        queueID: {
          type: 'number',
          description: 'Queue ID to route the ticket to. Use autotask_list_queues to discover valid IDs.'
        },
        ticketCategory: {
          type: 'number',
          description: 'Ticket category ID (picklist). Use autotask_get_field_info with entityType "Tickets" and fieldName "ticketCategory" to discover valid values.'
        },
        ticketType: {
          type: 'number',
          description: 'Ticket type ID (picklist, e.g. Service Request, Incident, Problem, Change).'
        },
        issueType: {
          type: 'number',
          description: 'First-level issue type ID (picklist). Required context for subIssueType. Use autotask_get_field_info (entityType "Tickets", fieldName "issueType") to discover valid values.'
        },
        subIssueType: {
          type: 'number',
          description: 'Sub issue type ID (picklist). Must be valid for the selected issueType. Use autotask_get_field_info (entityType "Tickets", fieldName "subIssueType") to discover valid values.'
        },
        source: {
          type: 'number',
          description: 'Ticket source ID (picklist, e.g. Phone, Email, Portal). Use autotask_get_field_info (entityType "Tickets", fieldName "source") to discover valid values.'
        },
        billingCodeID: {
          type: 'number',
          description: 'Work type / billing code ID used for billing this ticket.'
        },
        serviceLevelAgreementID: {
          type: 'number',
          description: 'Service Level Agreement (SLA) ID to apply to the ticket.'
        },
        estimatedHours: {
          type: 'number',
          description: 'Estimated hours of work for the ticket.'
        },
        projectID: {
          type: 'number',
          description: 'Project ID to associate the ticket with. Links the ticket to an existing project.'
        },
        ticketAdditionalContacts: {
          type: 'array',
          items: { type: 'number' },
          description: 'Additional contact IDs to associate with the ticket (beyond the primary contactID).'
        },
        resolution: {
          type: 'string',
          description: 'Ticket-level resolution text. This is the Resolution field on the ticket itself, NOT a ticket note.'
        },
        userDefinedFields: {
          type: 'array',
          description: 'User-defined (custom) fields for the ticket, as an array of { name, value } objects matching the Autotask REST API shape.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'UDF name' },
              value: { type: 'string', description: 'UDF value (stringified)' }
            },
            required: ['name', 'value']
          }
        },
        dueDateTime: {
          type: 'string',
          description: 'Ticket due date/time (ISO 8601). Setting it on create avoids a second update that retriggers workflow rules.'
        },
        companyLocationID: {
          type: 'number',
          description: 'Company location ID. Must belong to companyID. Use autotask_move_ticket_to_company when changing companies so the location stays compatible.'
        },
        configurationItemID: {
          type: 'number',
          description: 'Primary associated configuration item (asset) ID. Must belong to the same company.'
        },
        contractID: {
          type: 'number',
          description: 'Contract this ticket bills against / is delivered under.'
        },
        contractServiceID: {
          type: 'number',
          description: 'Contract service line the ticket is delivered under. Must belong to contractID.'
        },
        contractServiceBundleID: {
          type: 'number',
          description: 'Contract service bundle the ticket is delivered under. Must belong to contractID.'
        },
        externalID: {
          type: 'string',
          description: 'External correlation id (idempotency / occurrence key, e.g. "CS-88321:LOC-231:FIRMWARE:2026-09"). Search with autotask_find_ticket_by_external_id BEFORE creating to avoid duplicate occurrences.'
        },
        problemTicketId: {
          type: 'number',
          description: 'Parent problem ticket ID — files this ticket as an incident under a problem ticket.'
        },
        additionalConfigurationItemIDs: {
          type: 'array',
          items: { type: 'number' },
          description: 'Convenience: extra configuration item IDs to link (beyond the primary configurationItemID). When provided, the ticket is created, each CI is linked via TicketAdditionalConfigurationItems, and the ticket + associations are read back and returned enriched.'
        }
      },
      required: ['companyID', 'title', 'description']
    }
  },
  {
    name: 'autotask_find_ticket_by_external_id',
    description: 'Find ticket(s) by external correlation id (occurrence/idempotency key). Call this BEFORE creating a recurring/maintenance ticket: if a ticket already exists for the occurrence key, do NOT create a duplicate. Returns full matching ticket records (externalID preserved); externalID is not enforced-unique, so all matches are returned.',
    inputSchema: {
      type: 'object',
      properties: {
        externalID: { type: 'string', description: 'The external correlation id / occurrence key to look up' }
      },
      required: ['externalID']
    },
    annotations: { title: 'Find ticket by external ID', readOnlyHint: true }
  },
  {
    name: 'autotask_search_ticket_configuration_items',
    description: 'List the additional configuration items linked to a ticket (TicketAdditionalConfigurationItems — the CIs beyond the ticket\'s primary configurationItemID). Optionally filter to a single CI to check whether it is already linked.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'The ticket whose additional CI links to list' },
        configurationItemID: { type: 'number', description: 'Optional: only the association for this CI (existence check)' }
      },
      required: ['ticketID']
    },
    annotations: { title: 'List ticket additional configuration items', readOnlyHint: true }
  },
  {
    name: 'autotask_add_ticket_configuration_item',
    description: 'Link an additional configuration item to a ticket (creates a TicketAdditionalConfigurationItems association). Returns the new association id.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'The ticket to link the CI to' },
        configurationItemID: { type: 'number', description: 'The configuration item (asset) to link' }
      },
      required: ['ticketID', 'configurationItemID']
    }
  },
  {
    name: 'autotask_remove_ticket_configuration_item',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Removes an additional configuration item link from a ticket ' +
      '(deletes the TicketAdditionalConfigurationItems association by its association id — NOT the CI itself). ' +
      'Find the association id first with autotask_search_ticket_configuration_items. Confirm with the user before invoking.',
    annotations: {
      title: 'Remove ticket additional configuration item (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'The parent ticket ID (for context/safety)' },
        associationID: { type: 'number', description: 'The TicketAdditionalConfigurationItems association id to remove (from autotask_search_ticket_configuration_items)' }
      },
      required: ['associationID']
    }
  },
  {
    name: 'autotask_update_ticket',
    description: 'Update a ticket — only the fields given change. Covers status, priority, QUEUE (move between queues), assignee + role, contact, title/description, issue / sub-issue type, source, ticket type, category, SLA, due date, estimated hours, work type, resolution, location, configuration item, PO number, opportunity, problem ticket, external id. Picklist fields (status, priority, queueID, issueType, subIssueType, source, ticketType, ticketCategory, serviceLevelAgreementID) accept the id or the label ("Tier 1 Support"); an unknown value returns the choices and writes nothing. Reads the ticket back and reports each field old → new, warning if Autotask did not apply a value. Contract and company changes are NOT done here — use autotask_set_ticket_contract / autotask_move_ticket_to_company.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ID of the ticket to update'
        },
        title: {
          type: 'string',
          
        },
        description: {
          type: 'string',
          
        },
        status: {
          type: 'number',
          description: 'Ticket status ID (use autotask_list_ticket_statuses to find valid IDs)'
        },
        priority: {
          type: 'number',
          description: 'Ticket priority ID (use autotask_list_ticket_priorities to find valid IDs)'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Assigned resource ID. If set, assignedResourceRoleID is also required by Autotask (auto-filled from the resource\'s default role when omitted). Use currentUser:true to assign to the calling user.'
        },
        assignedResourceRoleID: {
          type: 'number',
          description: 'Role ID for the assigned resource. Required by Autotask when assignedResourceID is set; auto-filled from the resource\'s defaultServiceDeskRoleID when omitted. Pass explicitly to override. Discover roles with autotask_search_roles / autotask_get_resource_roles.'
        },
        currentUser: {
          type: 'boolean',
          description: 'Assign to the calling user — resolves the caller to their Autotask resource (assignedResourceID) and auto-fills their default role. Alternative to assignedResourceID.'
        },
        dueDateTime: {
          type: 'string',
          description: 'Due date and time in ISO 8601 format (e.g. 2026-03-15T17:00:00Z)'
        },
        contactID: {
          type: 'number',
          description: 'Contact ID for the ticket'
        },
        issueType: {
          type: 'number',
          description: 'First-level issue type ID (picklist). Required context for subIssueType. Use autotask_get_field_info (entityType "Tickets", fieldName "issueType") to discover valid values.'
        },
        subIssueType: {
          type: 'number',
          description: 'Sub issue type ID (picklist). Must be valid for the selected issueType. Use autotask_get_field_info (entityType "Tickets", fieldName "subIssueType") to discover valid values.'
        },
        companyLocationID: {
          type: 'number',
          description: 'Company location ID. Must belong to the ticket\'s company. To change companies, use autotask_move_ticket_to_company instead so the location stays compatible.'
        },
        configurationItemID: {
          type: 'number',
          description: 'Associated configuration item (asset) ID. Must belong to the ticket\'s company.'
        },
        queueID: {
          type: 'number',
          description: 'Move the ticket to another queue (queue id). Or pass `queue` with the name instead. Unknown → the active choices, nothing written. List with autotask_get_picklists { entity: "Tickets", fields: ["queueID"] }.'
        },
        queue: { type: 'string', description: 'Move the ticket to the queue with this NAME, e.g. "Tier 1 Support" (alternative to queueID).' },
        source: { type: 'number', description: 'Ticket source (picklist id or label, e.g. "Email", "Phone").' },
        ticketType: { type: 'number', description: 'Ticket type (picklist id or label, e.g. "Service Request", "Incident").' },
        ticketCategory: { type: 'number', description: 'Ticket category (picklist id or label).' },
        serviceLevelAgreementID: { type: 'number', description: 'Service level agreement (picklist id or label).' },
        estimatedHours: { type: 'number', description: 'Estimated hours.' },
        billingCodeID: { type: 'number', description: 'Work type (billing code) id for the ticket.' },
        resolution: { type: 'string', description: 'Resolution text.' },
        purchaseOrderNumber: { type: 'string', description: 'Purchase order number.' },
        opportunityID: { type: 'number', description: 'Linked opportunity id.' },
        problemTicketId: { type: 'number', description: 'Parent problem ticket id (group this ticket as an incident of a problem).' },
        externalID: { type: 'string', description: 'External id (integration / idempotency key).' },
        userDefinedFields: {
          type: 'array',
          description: 'Ticket UDFs to set, as [{ name, value }] (e.g. [{ "name": "Nexus-Status", "value": "4" }]). Only the UDFs listed change; each is read back and reported as udf:<name> in changes.',
          items: {
            type: 'object',
            properties: { name: { type: 'string', description: 'UDF name' }, value: { type: 'string', description: 'UDF value (stringified)' } },
            required: ['name', 'value']
          }
        }
      },
      required: ['ticketId']
    }
  },
  {
    name: 'autotask_move_ticket_to_company',
    description:
      'Safely move a ticket to another company. Resolves the target company\'s ' +
      'primary location and sets companyID + companyLocationID together (changing ' +
      'companyID alone leaves an incompatible location). Refuses to move a ticket ' +
      'linked to a configuration item unless force is set (that can break the ' +
      'RMM-to-Autotask device link), and clears the contact unless a target ' +
      'contact is supplied. companyLocationID picks a specific location of the target company (e.g. the matched contact\'s site) instead of the primary one. ' +
      'A contract belongs to one company: when the ticket\'s contract is not the target company\'s, contract + service + bundle are cleared as part of the move and reported as contractCleared. ' +
      'Routing in the same write: queueID, status, assignedResourceID + assignedResourceRoleID and userDefinedFields are sent in the SAME update as the company (one write, one workflow-rule firing) and verified too. Only these fields change — nothing else on the ticket is touched. ' +
      'Reads back to verify. Confirm with the user first.',
    annotations: { title: 'Move ticket to another company', readOnlyHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'number', description: 'The ticket to move' },
        companyID: { type: 'number', description: 'Target company ID' },
        contactID: { type: 'number', description: 'Optional target-company contact; the contact is cleared if omitted' },
        companyLocationID: { type: 'number', description: 'Optional: a location of the TARGET company to use instead of its primary location (refused if it belongs to another company)' },
        force: { type: 'boolean', description: 'Override the configuration-item safety block (not recommended)' },
        queueID: { type: 'number', description: 'Optional: queue to route to in the same write' },
        status: { type: 'number', description: 'Optional: status to set in the same write' },
        assignedResourceID: { type: 'number', description: 'Optional: primary resource (requires assignedResourceRoleID)' },
        assignedResourceRoleID: { type: 'number', description: 'Optional: role for assignedResourceID' },
        userDefinedFields: {
          type: 'array',
          description: 'Optional ticket UDFs to set in the same write, as [{ name, value }]',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value']
          }
        }
      },
      required: ['ticketId', 'companyID']
    }
  },

  // Ticket Charge tools
  {
    name: 'autotask_get_ticket_charge',
    description: 'Get a specific ticket charge by ID',
    inputSchema: {
      type: 'object',
      properties: {
        chargeId: {
          type: 'number',
          description: 'The ticket charge ID to retrieve'
        }
      },
      required: ['chargeId']
    }
  },
  {
    name: 'autotask_search_ticket_charges',
    description: 'Search ticket charges (materials, costs, expenses). Returns full rows (name, quantity, unit price/cost, billable amount, billed status, billing code, contract), so no per-charge reads are needed. Give ticketId, or ticketIds for many tickets in ONE call (e.g. a billing check over a month). Max 10 if unfiltered. Served from the Postgres mirror when it is on (0 Autotask calls).',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'Filter by ticket ID (recommended)'
        },
        ticketIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Charges of up to 500 tickets in one call'
        },
        isBilled: {
          type: 'boolean',
          description: 'true = already billed (on an invoice), false = not yet billed'
        },
        purchasedAfter: {
          type: 'string',
          description: 'Only charges purchased (dated) on or after this date (ISO, e.g. 2026-10-01). With the mirror on, a dated search costs 0 Autotask calls.'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, 500 with ticketIds; max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_ticket_charge',
    description: 'Create charge on ticket for materials, costs, or expenses.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: {
          type: 'number',
          description: 'Ticket ID to add the charge to'
        },
        name: {
          type: 'string',
          description: 'Charge name/title'
        },
        description: {
          type: 'string',
          description: 'Charge description'
        },
        chargeType: {
          type: 'number',
          description: 'Charge type picklist ID (use autotask_get_field_info with entityType "TicketCharges" to find valid values)'
        },
        unitQuantity: {
          type: 'number',
          description: 'Quantity of units'
        },
        unitPrice: {
          type: 'number',
          description: 'Price per unit'
        },
        unitCost: {
          type: 'number',
          description: 'Cost per unit'
        },
        datePurchased: {
          type: 'string',
          description: 'Date the charge was incurred (YYYY-MM-DD format)'
        },
        productID: {
          type: 'number',
          description: 'Associated product ID (optional)'
        },
        billingCodeID: {
          type: 'number',
          description: 'Billing code ID for categorization'
        },
        billableToAccount: {
          type: 'boolean',
          description: 'Whether this charge is billable to the client (default: true)'
        },
        status: {
          type: 'number',
          description: 'Charge status picklist ID'
        }
      },
      required: ['ticketID', 'name', 'chargeType']
    }
  },
  {
    name: 'autotask_update_ticket_charge',
    description: 'Update an existing ticket charge. Only fields provided will be changed.',
    inputSchema: {
      type: 'object',
      properties: {
        chargeId: {
          type: 'number',
          description: 'The charge ID to update'
        },
        name: {
          type: 'string',
          description: 'Updated charge name'
        },
        description: {
          type: 'string',
          description: 'Updated description'
        },
        unitQuantity: {
          type: 'number',
          description: 'Updated quantity'
        },
        unitPrice: {
          type: 'number',
          description: 'Updated unit price'
        },
        unitCost: {
          type: 'number',
          description: 'Updated unit cost'
        },
        billableToAccount: {
          type: 'boolean',
          description: 'Updated billable status'
        },
        status: {
          type: 'number',
          description: 'Updated status'
        }
      },
      required: ['chargeId']
    }
  },
  {
    name: 'autotask_delete_ticket_charge',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a ticket charge ' +
      'record and all associated billing data. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete ticket charge (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The parent ticket ID'
        },
        chargeId: {
          type: 'number',
          description: 'The charge ID to delete'
        }
      },
      required: ['ticketId', 'chargeId']
    }
  },

  // Ticket History tools (read-only audit trail of field changes)
  {
    name: 'autotask_get_ticket_history',
    description: 'Get a single ticket history entry by ID. Each entry records one audited change to a ticket field (who, when, before/after).',
    inputSchema: {
      type: 'object',
      properties: {
        historyId: {
          type: 'number',
          description: 'The ticket history entry ID to retrieve'
        }
      },
      required: ['historyId']
    }
  },
  {
    name: 'autotask_search_audit_activity',
    description: 'READ-ONLY. Normalized event stream of everything attributable to one or more resources in a time window — the evidence layer under the activity reports. Each event: eventId, timestamp, resourceId/Name, action (create/update/delete/complete/reopen/assign/note/time/cancel), entityType/Id/Reference, parent, company, field/oldValue/newValue, source, systemGenerated. Sources: ticket history (status/queue/priority/assignee/contract/… with old→new — fetched per changed ticket and cached, so a past day costs nothing the second time), ticket/task/project notes by creator (body, internal vs client-visible), time entries (date worked vs entered/modified, entered/edited by someone else, entered late), tasks created/completed, service calls created/cancelled, To-Dos created/completed, appointments, ticket charges, delete logs, plus Autotask webhook events (who changed companies/contacts/CIs/tickets in the UI) and row diffs (service-call/To-Do changes — editor unknown). "Touched" = an action; assignment alone is never reported as work. Bulk resourceIds; paginated (cursor); meta reports apiCallsUsed / recordsScanned and anything left incomplete by the call budget.',
    annotations: { title: 'Search audit activity (resource events)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        resourceIds: { type: 'array', items: { type: 'number' }, description: 'Resources to audit (bulk — one pass serves all)' },
        resourceId: { type: 'number', description: 'A single resource (alternative to resourceIds)' },
        date: { type: 'string', description: 'Local day YYYY-MM-DD (with timeZone) — or use startDateTime/endDateTime' },
        timeZone: { type: 'string', description: 'IANA/Windows timezone for date. Default: the first resource\'s location timezone.' },
        startDateTime: { type: 'string', description: 'Window start (ISO with offset), max 31 days' },
        endDateTime: { type: 'string', description: 'Window end (ISO with offset, exclusive)' },
        entityTypes: { type: 'array', items: { type: 'string', enum: ['ticket', 'ticketNote', 'taskNote', 'projectNote', 'timeEntry', 'task', 'project', 'serviceCall', 'todo', 'appointment', 'ticketCharge', 'company', 'contact', 'configurationItem'] }, description: 'Only these entity types (default all)' },
        includeSystemGenerated: { type: 'boolean', description: 'Include workflow/triage-rule and system-account events. Default false.' },
        includeUnattributed: { type: 'boolean', description: 'Include events whose actor Autotask does not record (service-call / To-Do changes). Default false.' },
        maxApiCalls: { type: 'number', description: 'Autotask call budget for this request (default 400, max 2000)' },
        limit: { type: 'number', description: 'Events per page (default 500, max 2000)' },
        cursor: { type: 'string', description: 'nextCursor from the previous page' }
      },
      required: []
    }
  },
  {
    name: 'autotask_backfill_history',
    description: 'Historical learning backfill (MCP-006), READ-ONLY toward Autotask: stores the history, notes and time entries of the tickets COMPLETED in a date range (max 366 days) in the MCP\'s ledger, so autotask_get_activity_feed (ingest:false, since = range start) and the audit tools can read periods older than the shadow window at 0 calls. Bounded and resumable: start a job with from/to (dryRun:true first — it counts the tickets and estimates the Autotask calls, 1 call), then call again with the returned jobId; each call advances the job by at most maxApiCalls and reports progress. A step is skipped (nothing read) while tenant API usage is at/above pauseAtUsagePct. Any Autotask error stops the step without retrying and is recorded on the job. Without arguments: lists recent jobs. Needs the Postgres store (migration 0009).',
    annotations: { title: 'Backfill ticket history (bounded)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'New job: range start (ISO), tickets completed at/after' },
        to: { type: 'string', description: 'New job: range end (ISO, exclusive). Default now.' },
        jobId: { type: 'string', description: 'Continue this job' },
        sources: { type: 'array', items: { type: 'string', enum: ['tickets', 'ticketNotes', 'timeEntries'] }, description: 'What to store (default all): tickets = field-change history' },
        dryRun: { type: 'boolean', description: 'New job: count the tickets and estimate the calls; creates nothing' },
        maxApiCalls: { type: 'number', description: 'Budget for this step (default 100, min 10, max 500)' },
        batchSize: { type: 'number', description: 'Tickets per page (default 50, max 200)' },
        pauseAtUsagePct: { type: 'number', description: 'Skip the step while tenant API usage is at/above this % (default 50)' }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_backpressure',
    description: 'READ-ONLY, 0 Autotask calls (unless refresh). Should a dispatcher (n8n, Hermes) send work to Autotask right now? Returns level ok / slow / stop, the reasons, retryAfterSeconds, and the inputs: tenant API usage % of the hourly limit (latest reading and its age; Autotask adds 0.5 s per call past 50% and 1 s past 75%), the login-protection state (paused after a failed login, or HELD until an administrator presses Retry now), the 429 cooldown, and requests queued behind the per-endpoint concurrency gate. stop = do not call (queue and retry after retryAfterSeconds); slow = essential calls only, one at a time, postpone bulk work. The same summary is on GET /health as backpressure.',
    annotations: { title: 'Backpressure (ok / slow / stop)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Take a fresh tenant usage reading first (1 Autotask call). Default false.' }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_operations',
    description: 'READ-ONLY. The operation log (correlation, MCP-007): which tool calls through this MCP wrote to Autotask, what each wrote (method, entity, id, time), and the ids that tie them to the caller — correlationId, decisionId (e.g. a Hermes recommendation), idempotencyKey, n8n workflow / node / executionId / eventId (pass these in the MCP request _meta). Look up by operationId (from a write result\'s _operation), correlationId, decisionId, idempotencyKey, or ticketId (operations that wrote that ticket or something under it, e.g. a note). Status: ok / error (nothing written) / partial (failed after writing) / running. Needs the Postgres store (migration 0008).',
    annotations: { title: 'Operation log (correlation)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', description: 'UUID from a write result (_operation.operationId)' },
        correlationId: { type: 'string', description: 'The caller-supplied (or generated) correlationId' },
        decisionId: { type: 'string', description: 'Upstream decision id passed as _meta.decisionId' },
        idempotencyKey: { type: 'string', description: 'The _meta.idempotencyKey of the call' },
        ticketId: { type: 'number', description: 'Operations that wrote this ticket or something under it' },
        since: { type: 'string', description: 'Only operations started at/after this ISO time' },
        limit: { type: 'number', description: 'Max operations (default 50, max 500), newest first' }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_activity_feed',
    description: 'READ-ONLY. Incremental, cursor-paged feed of ticket activity across the whole tenant — ticket field changes (status/queue/priority/assignee/contract/… with before → after, from TicketHistory), ticket notes and time entries (created and edited) — each event with a classified actor (human / service_account / integration / system / contact / unknown, the classification rule, and the reference-technician flag). For learning and n8n dispatchers: poll with the returned nextCursor; replaying a cursor returns the same eventIds. ORDER: by ingestion (feedId), not occurredAt — a late-arriving event (e.g. a ticket whose history was read later) still appears after your cursor, never skipped, but its occurredAt can be older than events you already saw; dedupe on eventId. Each call first brings the store up to date from per-source checkpoints within maxApiCalls (time entries from the shadow: 0 calls; notes: 1 call per 500; ticket history: 1 call per changed ticket, cached) and reports anything the budget left as pending (hasMore=true). Reports watermark (everything before it is stored), sourceLagSeconds and coverage: events before coverage.coveredFrom were never ingested — pass backfill:true (bounded, max 90 days) to fill them. Needs the Postgres store (migrations 0003 + 0007).',
    annotations: { title: 'Activity feed (incremental)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'First call: events occurring at/after this ISO instant (default 24 hours ago, max 90 days). Ignored when cursor is given (the cursor carries it).' },
        cursor: { type: 'string', description: 'nextCursor from the previous call' },
        limit: { type: 'number', description: 'Events per page (default 250, max 1000). A page can be shorter when actorTypes filters events out — keep following nextCursor while hasMore.' },
        entityTypes: { type: 'array', items: { type: 'string', enum: ['ticket', 'ticketNote', 'timeEntry', 'company', 'contact', 'configurationItem', 'serviceCall', 'todo'] }, description: 'Default ticket, ticketNote, timeEntry. company/contact/configurationItem/serviceCall/todo come from webhooks and mirror row-diffs when those are set up.' },
        actorTypes: { type: 'array', items: { type: 'string', enum: ['human', 'service_account', 'integration', 'system', 'contact', 'unknown'] }, description: 'Only events by these actor types (e.g. ["human"] for learning data). Default all.' },
        referenceOnly: { type: 'boolean', description: 'Only events by reference technicians (console → Actors).' },
        ticketIds: { type: 'array', items: { type: 'number' }, description: 'Only these tickets (their field changes, notes and time).' },
        includeBeforeAfter: { type: 'boolean', description: 'Include before/after values (default true).' },
        includeDetails: { type: 'boolean', description: 'Include source details — note body, time-entry hours/summary (default true).' },
        ingest: { type: 'boolean', description: 'Bring the store up to date before reading (default true). false = read only what is stored (0 Autotask calls).' },
        backfill: { type: 'boolean', description: 'Extend coverage back to since when it starts later (bounded by maxApiCalls per call; repeat until coverage.complete).' },
        maxApiCalls: { type: 'number', description: 'Autotask call budget for the ingest step (default 40, max 500).' }
      },
      required: []
    }
  },
  {
    name: 'autotask_report_resource_activity',
    description: 'READ-ONLY. Everything each resource did in Autotask in a window (date + timeZone, or start/end): per resource, the event stream from autotask_search_audit_activity plus counts by entity type and action. Bulk resourceIds share one pass (a 15-person team costs about the same as one). Meta reports Autotask calls used.',
    annotations: { title: 'Report resource activity', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        resourceIds: { type: 'array', items: { type: 'number' } },
        resourceId: { type: 'number' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        timeZone: { type: 'string' },
        startDateTime: { type: 'string' },
        endDateTime: { type: 'string' },
        includeSystemGenerated: { type: 'boolean' },
        includeUnattributed: { type: 'boolean' },
        maxApiCalls: { type: 'number' }
      },
      required: []
    }
  },
  {
    name: 'autotask_report_resource_daily_audit',
    description: 'READ-ONLY. End-of-day labor reconciliation for one or more resources on a date: TIME ENTERED (hours, entries); TICKETS and PROJECTS/TASKS TOUCHED (first/last activity, actions, whether time exists); SCHEDULING; CRM/ADMIN; CONFIGURATION; AFTER-HOURS activity (businessHoursStart/End, weekends; whether an after-hours time entry exists); ACTIVITY WITH NO CORRESPONDING TIME; POTENTIAL MISMATCHES (time with no other activity, time entered/edited by someone else); LATE/BACKFILLED TIME (entered after the day worked); CLOSED ITEMS WITH POSSIBLE MISSING LABOR (requiresReopenForBackfill); deletes. Activity timestamps are evidence, not hours worked — it never decides durations. Timesheet status is reported as unknown: Autotask does not expose it through the API.',
    annotations: { title: 'Resource daily audit (labor reconciliation)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        resourceIds: { type: 'array', items: { type: 'number' } },
        resourceId: { type: 'number' },
        date: { type: 'string', description: 'YYYY-MM-DD (local day)' },
        timeZone: { type: 'string', description: 'Default: the first resource\'s location timezone' },
        businessHoursStart: { type: 'string', description: 'HH:MM, default 08:00' },
        businessHoursEnd: { type: 'string', description: 'HH:MM, default 17:00' },
        maxApiCalls: { type: 'number', description: 'Autotask call budget (default 400)' }
      },
      required: ['date']
    }
  },
  {
    name: 'autotask_shadow_status',
    description: 'READ-ONLY. State of the Postgres shadow — the read-only mirror of Tickets, TimeEntries, Tasks, Projects, Companies, Contacts, Contracts, ContractServices, ContractBlocks and Resources: per entity row count, whether the backfill is done, data age, Autotask calls spent, last error; whether search tools are being served from it; the last sync run.',
    annotations: { title: 'Shadow status', readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'autotask_shadow_query',
    description: 'READ-ONLY, 0 Autotask API calls. Query the Postgres shadow with the SAME filter format as the Autotask API — [{op, field, value}], ops eq/noteq/gt/gte/lt/lte/beginsWith/endsWith/contains/exist/notExist/in/notIn, and {op:"and"|"or", items:[…]} groups. Use it for heavy reads (thousands of tickets / time entries / companies) instead of paging the live API. Text ops (contains/beginsWith/endsWith) ignore case and whitespace differences (double spaces, line breaks). Time-entry text is in summaryNotes AND internalNotes — search both with {op:"or",items:[…]}. Transactional tables hold a history window (the message says from when); older rows are not in the shadow. Returns rows, the total match count, and freshness (data age; "backfilling" means incomplete).',
    annotations: { title: 'Query the shadow (SQL)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Tickets, TimeEntries, Tasks, Projects, ServiceCalls, CompanyToDos, Companies, Contacts, Contracts, ContractServices, ContractBlocks, Resources, Invoices, BillingItems, TicketCharges, ProjectCharges, ContractCharges, TicketNotes, ExpenseItems, Opportunities or ConfigurationItems' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Autotask-style filters, AND-ed. E.g. [{"op":"eq","field":"contractID","value":29685345},{"op":"gte","field":"dateWorked","value":"2026-04-01"}]. A UDF filter adds "udf": true with the UDF name as field: {"op":"eq","field":"Nexus-Status","value":"7","udf":true}.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Only these fields (id always included). Omit for whole records.' },
        orderBy: { type: 'string', description: 'Field to sort by (default newest id first); "month:dateWorked" style also works' },
        desc: { type: 'boolean', description: 'Sort descending' },
        limit: { type: 'number', description: 'Rows to return (default 100, max 5000)' },
        offset: { type: 'number', description: 'Rows to skip' }
      },
      required: ['entity']
    }
  },
  {
    name: 'autotask_shadow_aggregate',
    description: 'READ-ONLY, 0 Autotask API calls. GROUP BY over the Postgres shadow — counts and numeric sums, e.g. hours by contract by month: { entity:"TimeEntries", filters:[{"op":"eq","field":"contractID","value":29685345}], groupBy:["resourceID","month:dateWorked"], sum:["hoursWorked","hoursToBill"] }. groupBy takes fields or "year:/month:/day:<dateField>".',
    annotations: { title: 'Aggregate over the shadow (SQL)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Shadow entity (see autotask_shadow_query)' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Autotask-style filters, AND-ed; UDF filters add "udf": true (field = the UDF name)' },
        groupBy: { type: 'array', items: { type: 'string' }, description: 'Fields, month:/day:/year:<dateField>, or udf:<UDF name> (e.g. "udf:Nexus-Status" counts tickets per lifecycle state)' },
        sum: { type: 'array', items: { type: 'string' }, description: 'Numeric fields to sum' },
        limit: { type: 'number', description: 'Max groups (default 1000)' }
      },
      required: ['entity']
    }
  },
  {
    name: 'autotask_shadow_sync',
    description: 'Run the Postgres shadow sync now (spends Autotask API calls within its per-run budget; skipped automatically above 50% hourly usage). action "run" (default): one incremental/backfill pass; "refresh": re-read specific ids of an entity; "reconcile": id-only sweep of one entity to catch deletions (big tables: ~one call per 500 rows); "verify": consistency check — random mirrored rows re-read from Autotask and compared field by field, plus mirror vs Autotask row counts, repairing differences (≈2 calls per entity; optional entity, sample). Never writes to Autotask.',
    annotations: { title: 'Run shadow sync' },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'refresh', 'reconcile', 'verify'], description: 'Default run' },
        sample: { type: 'number', description: 'For verify: rows per entity (default 10, max 50)' },
        entity: { type: 'string', description: 'For refresh / reconcile' },
        ids: { type: 'array', items: { type: 'number' }, description: 'For refresh' },
        maxCalls: { type: 'number', description: 'For reconcile: call budget (default 600, max 1000)' }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_actor_roster',
    description: 'READ-ONLY. Who is a person and who is automation: every Autotask resource classified as human, service_account, integration, system or unknown, with the reason (registry, system-resource, mcp-api-user = this MCP\'s own n8n/Nexus/ChatGPT writes, license-api-user, name-suggests-automation, licensed-user, not-found) and the reference flag (reference technicians = the trusted standard to learn from, set in the admin console). Use before learning from ticket history: only "human" is a person, "unknown" is never assumed human, and automated changes are never ground truth. Ticket history events carry the same actorType / classificationSource / reference.',
    annotations: { title: 'Actor roster (human vs automation)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        resourceIds: { type: 'array', items: { type: 'number' }, description: 'Classify just these resources' },
        actorTypes: { type: 'array', items: { type: 'string', enum: ['human', 'service_account', 'integration', 'system', 'unknown'] }, description: 'Only these types' },
        referenceOnly: { type: 'boolean', description: 'Only reference technicians' },
        includeInactive: { type: 'boolean', description: 'Include inactive resources (default false)' }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_ticket_by_number',
    description: 'READ-ONLY. The complete ticket by number (T20261005.0123 — the T is optional) or ID, fully resolved: every picklist labelled (status, priority, queue, source, ticket type, issue/sub-issue type, SLA, category, creator type) and every reference named — company, contact and created-by contact (name, email, active), assigned/creator/completed-by/last-activity resources, role, contract, opportunity, configuration item, work type, location, project, problem ticket — plus UDFs (list values labelled), the full description, and a direct Autotask link. For audits: pair with autotask_get_ticket_change_history and autotask_get_ticket_email_context.',
    annotations: { title: 'Get ticket (full, resolved)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ticketNumber: { type: 'string', description: 'Ticket number, e.g. T20261005.0123 (T optional, case-insensitive)' },
        ticketID: { type: 'number', description: 'Numeric ticket ID (alternative to ticketNumber)' }
      },
      required: []
    }
  },
  {
    name: 'autotask_set_ticket_contract',
    description: 'FINANCIAL — move a ticket to another contract, and its labor with it. A ticket\'s contractID does NOT carry its time entries: each entry has its own contractID, so by default (entries:"old_or_none") the ticket\'s time entries on the OLD contract or on NO contract move too; "none" = ticket only; "all_unposted" = every unposted entry. DRY RUN by default — returns the plan (from/to contracts, each entry and what happens to it, warnings) and writes nothing; dryRun:false + confirm:true executes. Validates: contract exists, same company as the ticket, active (allowInactive to override). Never changes POSTED entries (fix those via Autotask billing). Warns about entries outside the contract\'s dates. Clears a contract service/bundle from the old contract. Verifies by re-reading the ticket and entries.',
    annotations: { title: 'Set ticket contract (+ its labor)' },
    inputSchema: {
      type: 'object',
      properties: {
        ticketNumber: { type: 'string', description: 'Ticket number, e.g. T20260714.0198' },
        ticketID: { type: 'number', description: 'Numeric ticket ID (alternative to ticketNumber)' },
        contractID: { type: 'number', description: 'The contract the ticket should be on' },
        fromContractID: { type: 'number', description: 'The WRONG contract to move labor off. Default: the ticket\'s current contract. Needed when the ticket was already moved (e.g. in the UI) and only its time entries are still on the old contract.' },
        entries: { type: 'string', enum: ['old_or_none', 'none', 'all_unposted'], description: 'Which time entries follow the ticket. Default old_or_none.' },
        allowInactive: { type: 'boolean', description: 'Allow moving onto an INACTIVE contract. Default false.' },
        dryRun: { type: 'boolean', description: 'Default true — plan only. false (with confirm:true) to write.' }
      },
      required: ['contractID']
    }
  },
  {
    name: 'autotask_get_ticket_change_history',
    description: 'READ-ONLY. Who changed what on a ticket, oldest first: each TicketHistory event parsed into field / from / to ("Account changed from A to B" → field Account), with the actor named and classified — system (resource 4: workflow/triage rules, notifications), mcp-api-user (this MCP\'s API user, i.e. automation writing through it) or resource (a person). Timestamp-only events (Last Activity Date, Last Tracked Modification Date) are hidden by default and counted. Use it to find which automation changed the account, contact, queue, priority or status. With the Postgres store on, history is INDEXED: a read stores it, and later reads come from the index (0 Autotask calls) while the ticket has not changed since — result.source says index or live; live:true forces a fresh read.',
    annotations: { title: 'Get ticket change history (parsed)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ticketNumber: { type: 'string', description: 'Ticket number, e.g. T20261005.0123' },
        ticketID: { type: 'number', description: 'Numeric ticket ID (alternative to ticketNumber)' },
        includeTimestampOnly: { type: 'boolean', description: 'Include Last Activity / Last Tracked Modification date events (always read live — the index does not store them). Default false.' },
        live: { type: 'boolean', description: 'Skip the history index and read Autotask now. Default false.' }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_ticket_email_context',
    description: 'READ-ONLY. Where an email-created ticket came from, from the ORIGINAL message Autotask\'s email processor attached to the ticket ("Originating Email", message/rfc822): From (display name + address), Reply-To (and whether it differs from From), To, Cc, Subject, Date, Message-ID, Return-Path, Authentication-Results / ARC (SPF, DKIM, DMARC), Received-SPF, DKIM signing domains, the plain-text body (or text from HTML), and the MIME parts. Also the ticket source and creator (contact or resource). When no original message is attached it says so and why. Not exposed by the Autotask API: which mailbox received it and which email-processor rule created the ticket.',
    annotations: { title: 'Get ticket email context', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ticketNumber: { type: 'string', description: 'Ticket number, e.g. T20261005.0123' },
        ticketID: { type: 'number', description: 'Numeric ticket ID (alternative to ticketNumber)' },
        maxBodyChars: { type: 'number', description: 'Body text cap (default 8000, max 50000)' }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_picklists',
    description: 'READ-ONLY. Active values (value + label, and parentValue for dependent lists like subIssueType) of several picklist fields of an entity in ONE call, e.g. { entity: "Tickets", fields: ["queueID", "status", "priority", "source"] }. Omit fields for every picklist on the entity. Unknown and non-picklist field names are reported, not errors.',
    annotations: { title: 'Get picklists (several fields)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity, e.g. Tickets, Companies, Contacts, TicketNotes' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Picklist field names. Omit for all picklists on the entity.' }
      },
      required: ['entity']
    }
  },
  {
    name: 'autotask_search_ticket_history',
    description: 'Get the audit trail of field changes for a ticket (status transitions, assignment changes, priority edits, etc.) as RAW TicketHistory rows. For parsed field/from/to with named, classified actors use autotask_get_ticket_change_history. Returns entries ordered by Autotask; sort/filter client-side if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to get history for (required — Autotask does not support unscoped history queries)'
        },
        pageSize: {
          type: 'number',
          description: 'Number of history entries to return (default: 50, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: ['ticketId']
    }
  },

  // Time entry tools
  {
    name: 'autotask_get_time_entry_targets',
    description: "Time-entry target discovery (read-only) for EOD/backfill automation: given a resource, returns the valid things they can log time against — OPEN project tasks (completed tasks are excluded, since Autotask rejects time on a completed task) and non-complete assigned tickets — in one call, so the bot doesn't run several broad searches to answer 'where does this work go?'. Tasks include projectID + resolved projectName, phaseID, remainingHours, dates. Scope with companyID / projectID / searchTerm (matches task/ticket title, and ticket number).",
    inputSchema: {
      type: 'object',
      properties: {
        resourceID: { type: 'number', description: 'The resource (tech) whose targets to list' },
        companyID: { type: 'number', description: 'Limit tickets to one company' },
        projectID: { type: 'number', description: 'Limit tasks to one project' },
        searchTerm: { type: 'string', description: 'Filter by task/ticket title (and ticket number), case-insensitive' },
        maxRecords: { type: 'number', description: 'Cap per list (default 100, max 500)', minimum: 1, maximum: 500 }
      },
      required: ['resourceID']
    }
  },
  {
    name: 'autotask_list_regular_time_categories',
    description: "List the Regular Time categories (read-only) — the internal, non-ticket/non-task time categories from Autotask's Timesheet UI (e.g. Internal Meeting, Office Management, HR/Recruiting, Quote building, Research, Travel Time, Sick Time, Phone Call, Non-billable Meeting, Training). These are BillingCodes with useType=3 (Internal Allocation Code) — a DIFFERENT set from ticket/task WORK TYPES (Onsite Support, Remote Support, …). Use this to pick a categoryName for a Regular Time entry via autotask_create_time_entry / autotask_log_my_time. Returns { id, name, active }.",
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'autotask_create_time_entry',
    description: 'Create a time entry in Autotask. Three workflows: (1) TICKET time — pass ticketID (roleID auto-resolved); (2) project TASK time — pass taskID (project work is logged against a TASK, never a project directly); (3) REGULAR time — omit ticketID/taskID and pass a Regular Time category (e.g. "Internal Meeting", "Quote building") from autotask_list_regular_time_categories. Regular Time needs no ticket/task and sets timeEntryType=Activity automatically. Service-desk TICKET time requires a start+stop time — pass startDateTime/endDateTime (e.g. from the calendar event) to preserve the real span; if you give only hoursWorked, a span is derived on the work date so the create still succeeds. Task time on a COMPLETED task is rejected by Autotask (log against an open task).',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: {
          type: 'number',
          description: 'Ticket ID for the time entry (omit for Regular Time)'
        },
        taskID: {
          type: 'number',
          description: 'Task ID for the time entry. Project work is logged against a project TASK — use this (not projectID) for project time.'
        },
        projectID: {
          type: 'number',
          description: 'Deprecated: Autotask time entries have no projectID field. Project time attaches to a project task — pass that task as taskID. A project-only entry is rejected.'
        },
        resourceID: {
          type: 'number',
          description: 'Resource ID (user) logging the time. Can be omitted if resourceName is provided.'
        },
        resourceName: {
          type: 'string',
          description: 'Name of the resource/user (e.g., "Will Spence"). Will be resolved to a resourceID automatically. Use this instead of resourceID for convenience.'
        },
        currentUser: {
          type: 'boolean',
          description: 'Log the time as the calling user — resolves the caller to their Autotask resource. Alternative to resourceID/resourceName.'
        },
        roleID: {
          type: 'number',
          description: 'Role ID for the time entry (required by Autotask for ticket/task time; drives the bill rate and labour reporting). When SET it is validated against the resource\'s active roles — a role that is not theirs returns status "invalid_role" with the valid choices and writes nothing. When OMITTED it is auto-filled from the resource\'s default service-desk role, or its sole role; with multiple roles and no default it returns status "role_required" with the choices (roleID → name + department/queue) and writes nothing — it never guesses. The result reports roleID, roleName and roleSource (explicit / default / sole). Discover roles with autotask_get_resource_roles.'
        },
        category: {
          type: 'string',
          description: 'Category name for Regular Time entries (e.g., "Internal Meeting", "Office Management", "Training", "Research", "HR/Recruiting", "Travel Time", "Holiday", "PTO"). Required for Regular Time entries (when no ticket/task/project is specified).'
        },
        dateWorked: {
          type: 'string',
          description: 'Date worked (YYYY-MM-DD format)'
        },
        startDateTime: {
          type: 'string',
          description: 'Start date/time (ISO format)'
        },
        endDateTime: {
          type: 'string',
          description: 'End date/time (ISO format)'
        },
        hoursWorked: {
          type: 'number',
          description: 'Number of hours worked'
        },
        summaryNotes: {
          type: 'string',
          description: 'CLIENT-FACING and INVOICE-FACING summary of the work performed — the customer sees this, so keep it clean and concise (what was done, in plain terms). Required.'
        },
        internalNotes: {
          type: 'string',
          description: 'INTERNAL-ONLY notes for the team (never shown to the client or on invoices). Lets ONE time entry carry both a client-facing summary and private team notes — no need for a separate ticket note.'
        },
        billingCodeID: {
          type: 'number',
          description: 'Work type / billing code ID. Note: billable status also depends on contract config, so a work type alone does not guarantee the entry is billable.'
        },
        offsetHours: {
          type: 'number',
          description: 'Billing offset in hours to subtract from worked time — e.g. a 30-minute lunch on an 8h ticket = 0.5. The ONLY API lever on billed time: Autotask derives hoursToBill (read-only — not an input) from hoursWorked − offsetHours, then applies the contract/work-type rounding (e.g. a 0.25h minimum), so the stored hoursToBill can exceed the difference. The result reports the stored hoursToBill.'
        },
        showOnInvoice: {
          type: 'boolean',
          description: 'Whether the entry appears on the customer invoice.'
        },
        isNonBillable: {
          type: 'boolean',
          description: 'Mark the entry non-billable. Live-test: this (with showOnInvoice=false) is what makes an entry non-billable — a Sales/etc. work type alone does not.'
        },
        billingTreatment: {
          type: 'string',
          enum: ['billable', 'non_billable', 'contract_included'],
          description: 'High-level billing intent — resolves the field combo so you do not have to. "non_billable" → isNonBillable=true + showOnInvoice=false; "billable" → isNonBillable=false; "contract_included" → billable but not separately invoiced (showOnInvoice=false). Any explicit isNonBillable/showOnInvoice you also pass take precedence.'
        },
        timeZone: {
          type: 'string',
          description: 'IANA ("America/New_York") or Windows ("Eastern Standard Time") timezone for start/end given as LOCAL wall-clock time without an offset — converted to the correct UTC instant (DST-aware). Ignored when the timestamp already has an offset. If omitted, the resource\'s own location timezone is used (mirrors the Autotask UI). Offset-aware timestamps from a calendar source are always safest.'
        }
      },
      required: ['dateWorked', 'hoursWorked', 'summaryNotes']
    }
  },
  {
    name: 'autotask_create_task_time_entries_bulk',
    description: 'Create one time entry PER ATTENDEE against a single project TASK for the same day — built for meeting/closeout logging (e.g. an RPO meeting task with five GDS attendees). DRY-RUN FIRST: without dryRun:false it only returns a plan (resolves each resource + role, flags existing duplicates), writing nothing. Re-run with dryRun:false to commit. Rerun-safe: each write goes through the idempotent path (same resource + day + task + summary is not double-posted). Validate-all-before-write: if ANY entry fails to resolve a resource or needs a role choice, NOTHING is written — fix and re-run. Result is verification-shaped (planned / created / duplicates / errors + per-entry status) so a caller can gate a task closeout on all expected entries being present. For a single entry use autotask_log_my_time / autotask_create_time_entry.',
    inputSchema: {
      type: 'object',
      properties: {
        taskID: { type: 'number', description: 'The project TASK all entries are logged against (e.g. the meeting task).' },
        dateWorked: { type: 'string', description: 'Date worked for all entries (YYYY-MM-DD).' },
        dryRun: { type: 'boolean', description: 'Default TRUE — return a plan without writing. Set false to actually create the entries.' },
        entries: {
          type: 'array',
          description: 'One item per attendee.',
          items: {
            type: 'object',
            properties: {
              resourceID: { type: 'number', description: 'Resource (tech) ID. Provide this or resourceName.' },
              resourceName: { type: 'string', description: 'Resource name (e.g. "Jonathan Fitzgerald") — resolved to an active resource. Alternative to resourceID.' },
              hoursWorked: { type: 'number', description: 'Hours this attendee spent on the call.' },
              summaryNotes: { type: 'string', description: 'CLIENT/INVOICE-facing summary of this attendee\'s side of the call. Also the idempotency signal (same summary + resource + day + task = duplicate).' },
              internalNotes: { type: 'string', description: 'INTERNAL-only notes for this attendee (not client/invoice-visible).' },
              startDateTime: { type: 'string', description: 'Optional start (ISO 8601); a span is derived from hoursWorked when omitted.' },
              endDateTime: { type: 'string', description: 'Optional end (ISO 8601).' },
              roleID: { type: 'number', description: 'Optional role; auto-resolved from the resource\'s default when omitted (multiple roles with no default → that entry errors asking for roleID).' }
            },
            required: ['hoursWorked', 'summaryNotes']
          }
        }
      },
      required: ['taskID', 'dateWorked', 'entries']
    },
    annotations: { title: 'Bulk task time entries (attendees)' }
  },
  {
    name: 'autotask_log_ticket_collaboration',
    description: 'Capture a collaborative work event on a TICKET (e.g. a Teams triage thread keyed by ticket #) in one call: a ticket time entry PER contributing tech + an optional ticket note (the narrative). The ticket-oriented sibling of autotask_create_task_time_entries_bulk — built for reconstructing time+notes that happened in Teams/chat rather than the ticket. DRY-RUN FIRST (default): resolves each participant (by resourceID, resourceName, or email — a Teams user), auto-resolves each role, flags duplicates, and returns the plan without writing. Re-run with dryRun:false to commit. Rerun-safe (idempotent time via same resource+day+ticket+summary; note idempotent when note.idempotencyKey is set). Validate-all-before-write: if ANY participant fails to resolve or needs a role choice, NOTHING is written. Per-participant summaryNotes are client/invoice-facing; internalNotes are team-only; billingTreatment (billable|non_billable|contract_included) and timezone-aware start/end are supported per participant.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'The ticket the collaboration is logged against.' },
        dateWorked: { type: 'string', description: 'Date worked for all entries (YYYY-MM-DD).' },
        dryRun: { type: 'boolean', description: 'Default TRUE — return the plan without writing. Set false to commit.' },
        participants: {
          type: 'array',
          description: 'One item per contributing tech.',
          items: {
            type: 'object',
            properties: {
              resourceID: { type: 'number', description: 'Resource ID. Provide this, resourceName, or email.' },
              resourceName: { type: 'string', description: 'Resource name (resolved to an active resource).' },
              email: { type: 'string', description: 'Resource email (e.g. from a Teams participant) — resolved to an active resource.' },
              hoursWorked: { type: 'number', description: 'Hours this tech contributed.' },
              summaryNotes: { type: 'string', description: 'CLIENT/INVOICE-facing summary of this tech\'s contribution. Also the idempotency signal.' },
              internalNotes: { type: 'string', description: 'INTERNAL-only notes (not client/invoice-visible).' },
              roleID: { type: 'number', description: 'Optional role; auto-resolved from the resource\'s default when omitted (multiple roles with no default → that participant errors asking for roleID).' },
              billingTreatment: { type: 'string', enum: ['billable', 'non_billable', 'contract_included'], description: 'High-level billing intent for this entry.' },
              startDateTime: { type: 'string', description: 'Optional start (offset ISO, or local + timeZone).' },
              endDateTime: { type: 'string', description: 'Optional end.' },
              timeZone: { type: 'string', description: 'IANA/Windows timezone for local start/end (converted to UTC).' }
            },
            required: ['hoursWorked', 'summaryNotes']
          }
        },
        note: {
          type: 'object',
          description: 'Optional ticket note capturing the triage narrative (written last, after time).',
          properties: {
            title: { type: 'string', description: 'Note title (default "Ticket note").' },
            description: { type: 'string', description: 'Note body (the how-we-got-there narrative). Required if note is provided.' },
            noteType: { type: 'number', description: 'TicketNotes noteType picklist id (tenant-specific; see autotask_get_field_info).' },
            publish: { type: 'number', description: 'TicketNotes publish/visibility picklist id (controls client visibility).' },
            idempotencyKey: { type: 'string', description: 'Dedup key so a re-run does not duplicate the note (e.g. "TRIAGE:<ticket>:<thread>").' }
          },
          required: ['description']
        }
      },
      required: ['ticketID', 'dateWorked', 'participants']
    },
    annotations: { title: 'Log ticket collaboration (multi-tech)' }
  },
  {
    name: 'autotask_get_my_day',
    description: 'The acting user\'s working picture for a date (default today in your local timezone): tickets assigned to them, the time they have already logged that day (split ticket/task/Regular Time), their open tasks, their service calls that day, their open To-Dos starting in the 7 days up to that day, and missingTime — one row per service-call ticket with NO time logged that day. Built for a scheduled assistant to see what already exists and backfill only the gaps. Acts as the caller by default (currentUser) — or pass resourceID. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceID: { type: 'number', description: 'Whose day to read. Omit to use the calling user (currentUser).' },
        currentUser: { type: 'boolean', description: 'Read the calling user\'s day (default when resourceID is omitted).' },
        date: { type: 'string', description: 'Day to report (YYYY-MM-DD). Defaults to today in your local timezone.' },
        timeZone: { type: 'string', description: 'IANA or Windows timezone for the day boundaries. Default: your location timezone (else the tenant default).' }
      },
      required: []
    },
    annotations: { title: 'Get my day', readOnlyHint: true }
  },
  {
    name: 'autotask_log_my_time',
    description: 'Log a time entry as the acting user, idempotently. Before creating, it checks for an existing entry on the same day against the same ticket/task with the same summaryNotes and skips if found — so a scheduled end-of-day backfill (and retries) never double-posts. Acts as the caller by default (currentUser); role auto-fills from the user\'s default. Provide ticketID or taskID (or neither for Regular Time).',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'Ticket to log against (omit for a task or Regular Time)' },
        taskID: { type: 'number', description: 'Project task to log against (project time logs against a task)' },
        dateWorked: { type: 'string', description: 'Date worked (YYYY-MM-DD). Default: the local date of startDateTime, else today, in your local timezone.' },
        timeZone: { type: 'string', description: 'IANA ("America/New_York") or Windows ("Eastern Standard Time") timezone for the local day and for start/end given without an offset. Default: your location timezone.' },
        hoursWorked: { type: 'number', description: 'Hours worked (or provide startDateTime/endDateTime)' },
        startDateTime: { type: 'string', description: 'Start time (ISO 8601); alternative to hoursWorked' },
        endDateTime: { type: 'string', description: 'End time (ISO 8601); alternative to hoursWorked' },
        summaryNotes: { type: 'string', description: 'CLIENT- and INVOICE-facing summary — clean and concise. Also the idempotency signal (same summary on the same day/ticket/category = duplicate).' },
        internalNotes: { type: 'string', description: 'INTERNAL-only notes for the team (not shown to client/invoice) — carry both on one entry.' },
        resourceID: { type: 'number', description: 'Log as this resource. Omit to log as the calling user (currentUser).' },
        currentUser: { type: 'boolean', description: 'Log as the calling user (default when resourceID is omitted).' },
        roleID: { type: 'number', description: 'Role for the entry. Validated against the user\'s active roles when set (invalid → returns the valid choices, nothing written); auto-filled from the default (or sole) role when omitted; multiple roles → returns choices.' },
        billingCodeID: { type: 'number', description: 'Work type / billing code (ticket/task time)' },
        offsetHours: { type: 'number', description: 'Billing offset to subtract from worked time (e.g. 0.5 for a 30m lunch). Autotask derives the read-only hoursToBill from hoursWorked − offset plus contract/work-type rounding.' },
        category: { type: 'string', description: 'Category for Regular Time (no ticket/task), e.g. "Internal Meeting" (from autotask_list_regular_time_categories)' }
      },
      required: ['summaryNotes']
    }
  },
  {
    name: 'autotask_start_work_on_ticket',
    description: 'Start working a ticket as the acting user: set its status to In Progress (or `status`) and, if it is UNASSIGNED, assign it to you with your default role. A ticket assigned to someone else is left untouched unless takeOver:true (nothing written; the assignee is named). Rerun-safe: already In Progress and yours → nothing written. Returns startedAt — pass it as startDateTime to autotask_log_my_time when you finish. Acts as the caller by default (currentUser).',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'Ticket to start (numeric id)' },
        status: { type: 'string', description: 'Working status, by label or numeric id (as a string). Default "In Progress". Unknown → the choices, nothing written.' },
        takeOver: { type: 'boolean', description: 'Reassign a ticket that is assigned to someone else to you. Default false.' },
        roleID: { type: 'number', description: 'Role for the assignment. Default: your default role.' },
        resourceID: { type: 'number', description: 'Act as this resource. Omit to act as the calling user (currentUser).' },
        currentUser: { type: 'boolean', description: 'Act as the calling user (default when resourceID is omitted).' },
        dryRun: { type: 'boolean', description: 'Show the planned change without writing. Default false.' }
      },
      required: ['ticketID']
    },
    annotations: { title: 'Start work on ticket' }
  },
  {
    name: 'autotask_add_ticket_update',
    description: 'Post a progress update on a ticket in ONE call: a note, plus optionally a time entry and a status change. Everything is validated first (status label, note visibility, role, work type) — an invalid piece writes nothing. Runs note → time → status and stops at the first failure (the status is never changed after a failed time entry). Rerun-safe: the same note text within 24 h and the same time entry are not duplicated. The note is INTERNAL unless visibility is "client". Time needs summaryNotes (invoice-facing) unless the update is client-visible. Acts as the caller by default (currentUser).',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'Ticket to update (numeric id)' },
        update: { type: 'string', description: 'The note text — what was done / found / next steps.' },
        title: { type: 'string', description: 'Note title. Default "Update".' },
        visibility: { type: 'string', enum: ['internal', 'client', 'co-managed'], description: 'Who sees the note. Default internal (internal users only). "client" also shows it in the client portal.' },
        status: { type: 'string', description: 'Optional new ticket status, by label or numeric id (e.g. "Waiting Customer", "Complete"). Unknown → the choices, nothing written.' },
        hoursWorked: { type: 'number', description: 'Optional: log this much time on the ticket (or give startDateTime + endDateTime).' },
        startDateTime: { type: 'string', description: 'Optional time-entry start (ISO 8601), e.g. startedAt from autotask_start_work_on_ticket.' },
        endDateTime: { type: 'string', description: 'Optional time-entry end (ISO 8601).' },
        summaryNotes: { type: 'string', description: 'Time-entry summary — CLIENT- and INVOICE-facing. Required with time unless visibility is "client" (then the update text is used).' },
        internalNotes: { type: 'string', description: 'Time-entry internal notes (not on the invoice).' },
        dateWorked: { type: 'string', description: 'Time-entry date (YYYY-MM-DD). Default: the local date of startDateTime, else today, in your local timezone.' },
        timeZone: { type: 'string', description: 'IANA ("America/New_York") or Windows ("Eastern Standard Time") timezone for the local day and for start/end given without an offset. Default: your location timezone.' },
        roleID: { type: 'number', description: 'Time-entry role. Validated against your roles; default/sole role auto-fills.' },
        billingCodeID: { type: 'number', description: 'Time-entry work type. Validated; omit for the default.' },
        offsetHours: { type: 'number', description: 'Billing offset subtracted from worked time.' },
        noteType: { type: 'number', description: 'Note type id. Default "Task Summary" (the human note type).' },
        resourceID: { type: 'number', description: 'Act as this resource. Omit to act as the calling user (currentUser).' },
        currentUser: { type: 'boolean', description: 'Act as the calling user (default when resourceID is omitted).' },
        dryRun: { type: 'boolean', description: 'Validate and show the plan without writing. Default false.' }
      },
      required: ['ticketID', 'update']
    },
    annotations: { title: 'Add ticket update (note + time + status)' }
  },
  {
    name: 'autotask_get_time_entry',
    description:
      'READ-ONLY. Get a time entry by ID. The record distinguishes actual worked ' +
      'time (hoursWorked) from Autotask billing-rounded time (hoursToBill).',
    annotations: { title: 'Get time entry', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Time entry ID' } },
      required: ['id']
    }
  },
  {
    name: 'autotask_update_time_entry',
    description:
      'Update a time entry (collection PATCH). Only provided fields change. ' +
      'hoursWorked accepts fractional hours (e.g. 0.1 = six minutes).',
    annotations: { title: 'Update time entry', readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Time entry ID to update' },
        hoursWorked: { type: 'number', description: 'Actual hours worked (fractional allowed)' },
        offsetHours: { type: 'number', description: 'Billing offset in hours to subtract from worked time (e.g. 0.5 for a 30m lunch). hoursToBill itself is READ-ONLY (Autotask derives it from hoursWorked − offsetHours plus contract/work-type rounding) and is not an input; a request to set only it writes nothing and says so. To make an entry non-billable set isNonBillable/showOnInvoice.' },
        dateWorked: { type: 'string', description: 'Date worked (YYYY-MM-DD).' },
        startDateTime: { type: 'string', description: 'Start date/time. Offset-aware ISO (e.g. 2026-09-23T10:00:00-04:00) is stored as the correct UTC instant. To pass a local time, also send timeZone.' },
        endDateTime: { type: 'string', description: 'End date/time (see startDateTime).' },
        timeZone: { type: 'string', description: 'IANA timezone (e.g. "America/New_York") for start/end given as local wall-clock time WITHOUT an offset. Correctly handles DST. Ignored when the timestamp already carries an offset.' },
        summaryNotes: { type: 'string', description: 'CLIENT/INVOICE-facing summary notes.' },
        internalNotes: { type: 'string', description: 'INTERNAL-only notes (not shown to client/invoice).' },
        roleID: { type: 'number', description: 'Role for the entry (ticket/task time). Validated against the entry owner\'s active roles; an invalid role returns the valid choices and writes nothing.' },
        billingCodeID: { type: 'number', description: 'Work type / billing code ID (ticket/task time). NOTE: work type does not by itself set billability — use isNonBillable / billingTreatment.' },
        internalBillingCodeID: { type: 'number', description: 'Internal (Regular Time) category id.' },
        isNonBillable: { type: 'boolean', description: 'Mark the entry non-billable. Live-test: this (with showOnInvoice=false) is what actually makes an entry non-billable — showOnInvoice=false alone does not.' },
        showOnInvoice: { type: 'boolean', description: 'Whether the entry appears on the customer invoice.' },
        billingTreatment: { type: 'string', enum: ['billable', 'non_billable', 'contract_included'], description: 'High-level billing intent — resolves the correct field combo so you do not have to. "non_billable" → isNonBillable=true + showOnInvoice=false; "billable" → isNonBillable=false; "contract_included" → billable but showOnInvoice=false. Explicit isNonBillable/showOnInvoice you also pass take precedence.' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_delete_time_entry',
    description: '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete one time entry. DRY-RUN FIRST (default): reads the entry + lock state, deletes nothing; to delete pass dryRun:false AND confirm:true. Refuses locked time with a clear reason — posted/billing-approved (incl. contract auto-approve; allowApproved:true to attempt) or a locked timesheet (waiting-for-approval / approved). Runs AS the entry\'s owner (impersonation) — Autotask lets only the owner delete their time, even for an admin. Idempotent (missing id → "already_deleted"); verifies the entry is gone.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Time entry ID to delete.' },
        dryRun: { type: 'boolean', description: 'Default TRUE — inspect + return the plan without deleting. Set false (with confirm:true) to delete.' },
        allowApproved: { type: 'boolean', description: 'Attempt deletion even when the entry is posted/billing-approved. Default false. Autotask may still refuse.' }
      },
      required: ['id']
    },
    annotations: { title: 'Delete time entry', readOnlyHint: false, destructiveHint: true }
  },

  // Project tools
  {
    name: 'autotask_search_projects',
    description: 'Search for projects in Autotask. Returns 25 results per page by default. Use page parameter for more results.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for project name'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company ID'
        },
        status: {
          type: 'number',
          description: 'Filter by project status'
        },
        projectLeadResourceID: {
          type: 'number',
          description: 'Filter by project lead resource ID'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_project',
    description: 'Get a single project by ID with its full field set (status, type, lead, department, dates, estimated/actual time, contract, opportunity, UDFs, etc.).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Project ID' } },
      required: ['id']
    },
    annotations: { title: 'Get project', readOnlyHint: true }
  },
  {
    name: 'autotask_get_project_structure',
    description: 'Get the normalized project outline: the project plus its phases nested by parentPhaseID, with tasks bucketed under each phase and any unphased tasks listed separately, plus a summary (phase/task counts, max phase depth, estimated hours). Preserves Autotask-native fields. The prerequisite for reliable project blueprint export and cloning.',
    inputSchema: {
      type: 'object',
      properties: { projectID: { type: 'number', description: 'Project ID' } },
      required: ['projectID']
    },
    annotations: { title: 'Get project structure', readOnlyHint: true }
  },
  {
    name: 'autotask_get_complete_project_context',
    description: 'Assemble the complete read-only context for a project in one call (the Project Builder input): the project, its nested phase/task hierarchy, the task dependency graph, the labor rollup, project notes and attachments, the owning company, and commercial linkage (contract + milestones, opportunity). Best-effort — a section that fails to load is recorded under `errors` instead of failing the whole call. Configuration items are opt-in (can be large per company); set includeCommercial:false to skip contract/opportunity fetches.',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: { type: 'number', description: 'Project ID' },
        includeConfigurationItems: { type: 'boolean', description: 'Also fetch the company\'s configuration items (can be large; default false)' },
        includeCommercial: { type: 'boolean', description: 'Fetch contract/milestones/opportunity linkage (default true)' }
      },
      required: ['projectID']
    },
    annotations: { title: 'Get complete project context', readOnlyHint: true }
  },
  {
    name: 'autotask_get_project_labor_summary',
    description: 'Project labor summary: estimated vs actual and billable hours, variance, first/last worked dates, and a per-phase rollup. Aggregated through the task hierarchy (project tasks → task time entries) because project-scoped time queries are unreliable.',
    inputSchema: {
      type: 'object',
      properties: { projectID: { type: 'number', description: 'Project ID' } },
      required: ['projectID']
    },
    annotations: { title: 'Project labor summary', readOnlyHint: true }
  },
  {
    name: 'autotask_export_project_blueprint',
    description: 'Export a project as a reusable, tenant-agnostic blueprint: the phase/task hierarchy with titles, estimated hours, and task type, WITHOUT tenant-specific ids, resource assignments, or absolute dates. Use an existing project (e.g. a standard low-voltage or onboarding project) as a starting template for a new one.',
    inputSchema: {
      type: 'object',
      properties: { projectID: { type: 'number', description: 'Source project ID to export' } },
      required: ['projectID']
    },
    annotations: { title: 'Export project blueprint', readOnlyHint: true }
  },
  {
    name: 'autotask_calculate_project_schedule',
    description: 'Deterministically schedule a project build plan (no Autotask writes, no AI, no reference-project inference). Each task\'s duration = ceil(estimatedHours ÷ (crewSize × hoursPerDay)) working days; tasks are laid out in dependency order across a configurable working week (weekends/holidays skipped); target completion is the latest task finish. Returns per-task start/end dates, the project start → target completion span, the driving (critical) path, and milestone dates. Same inputs always yield the same schedule. The `plan` uses client-side string refs (not Autotask ids) so it can be scheduled before anything exists in the tenant.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          description: 'Normalized project build plan.',
          properties: {
            name: { type: 'string', description: 'Project name' },
            archetype: { type: 'string', description: 'Optional GDS archetype classification' },
            phases: {
              type: 'array',
              description: 'Phases (optional). Each: { ref, title, parentRef? } — ref is a unique client-side id; parentRef nests a sub-phase.',
              items: {
                type: 'object',
                properties: {
                  ref: { type: 'string' },
                  title: { type: 'string' },
                  parentRef: { type: 'string' },
                  description: { type: 'string' }
                },
                required: ['ref', 'title']
              }
            },
            tasks: {
              type: 'array',
              description: 'Tasks. Each: { ref, title, estimatedHours, phaseRef?, crewSize?, predecessors?, lagDays?, milestone? }. predecessors are task refs that must finish first; set milestone:true for a zero-duration date marker.',
              items: {
                type: 'object',
                properties: {
                  ref: { type: 'string' },
                  title: { type: 'string' },
                  estimatedHours: { type: 'number' },
                  phaseRef: { type: 'string' },
                  crewSize: { type: 'number', description: 'Parallel resources on this task (overrides defaultCrewSize)' },
                  predecessors: { type: 'array', items: { type: 'string' }, description: 'Refs of tasks that must finish before this one starts' },
                  lagDays: { type: 'number', description: 'Working-day gap after predecessors finish' },
                  taskType: { type: 'number' },
                  milestone: { type: 'boolean' },
                  description: { type: 'string' }
                },
                required: ['ref', 'title', 'estimatedHours']
              }
            }
          },
          required: ['name', 'tasks']
        },
        startDate: { type: 'string', description: 'Earliest project start, ISO date (YYYY-MM-DD). Rolled forward to the next working day if needed.' },
        hoursPerDay: { type: 'number', description: 'Productive hours per working day (default 8)', default: 8 },
        defaultCrewSize: { type: 'number', description: 'Parallel resources per task when a task does not set its own crewSize (default 1)', default: 1 },
        workweek: { type: 'array', items: { type: 'number' }, description: 'Working weekdays as ISO numbers (Mon=1 … Sun=7). Default [1,2,3,4,5] (Mon–Fri).' },
        holidays: { type: 'array', items: { type: 'string' }, description: 'Non-working dates (holidays), ISO YYYY-MM-DD.' },
        targetCompletionDate: { type: 'string', description: 'Optional deadline (ISO date). A target completion beyond it produces a warning.' }
      },
      required: ['plan', 'startDate']
    },
    annotations: { title: 'Calculate project schedule', readOnlyHint: true }
  },
  {
    name: 'autotask_extract_project_scope',
    description: "Front of the SOW-to-project pipeline (#46 §8): deterministically parse a Statement of Work into a normalized, reviewable scope envelope — NO Autotask writes, NO AI, and it NEVER infers scope from a reference project (only from what you give it). Section-parses `sowText` into the canonical buckets — included / excluded / byOthers / assumptions / allowances / customerProvided / vendorProvided / dependencies / milestones — using heading detection (markdown headings, 'X:' labels, or known section names like 'Out of Scope', 'By Others', 'Assumptions'). Extracts BOM-style quantities from in-scope lines ('(12) drops', '12x cameras', '48 jacks') into a structured quantities list (feeds §9 BOM → calculated hours). Merges a caller-supplied partial `scope` (e.g. from an LLM) with the parsed text. Anything it can't classify goes to `unclassified` (never dropped), plus data-quality `warnings`. The output scope is the reviewable artifact to approve before generate_project_labor_plan / calculate_project_schedule / build_project_from_plan.",
    inputSchema: {
      type: 'object',
      properties: {
        sowText: { type: 'string', description: 'Raw SOW text to section-parse (headings + bullet lines). Optional if `scope` is supplied.' },
        scope: {
          type: 'object',
          description: 'A partial scope to merge with the parsed text (e.g. pre-structured by an LLM caller). Same shape as the output; string[] buckets + milestones[] + quantities[].',
          properties: {
            included: { type: 'array', items: { type: 'string' } },
            excluded: { type: 'array', items: { type: 'string' } },
            byOthers: { type: 'array', items: { type: 'string' } },
            assumptions: { type: 'array', items: { type: 'string' } },
            allowances: { type: 'array', items: { type: 'string' } },
            customerProvided: { type: 'array', items: { type: 'string' } },
            vendorProvided: { type: 'array', items: { type: 'string' } },
            dependencies: { type: 'array', items: { type: 'string' } },
            milestones: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, date: { type: 'string' } }, required: ['text'] } },
            quantities: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, quantity: { type: 'number' }, unit: { type: 'string' }, source: { type: 'string' } }, required: ['item', 'quantity'] } }
          }
        },
        source: { type: 'string', description: 'Provenance label recorded on the scope (e.g. SOW/quote id or filename)' },
        quantityBuckets: { type: 'array', items: { type: 'string', enum: ['included', 'excluded', 'byOthers', 'assumptions', 'allowances', 'customerProvided', 'vendorProvided', 'dependencies'] }, description: 'Which buckets to scan for quantities (default ["included"])' }
      },
      required: []
    },
    annotations: { title: 'Extract project scope from SOW', readOnlyHint: true }
  },
  {
    name: 'autotask_classify_project',
    description: "Project classification (#46 §7): deterministically map a project/scope to an archetype (e.g. construction/low-voltage, tech deployment, recurring consulting, compliance program, operational onboarding) so the pipeline can pick the right blueprint/defaults. No Autotask writes, no AI — it keyword-scores the supplied text + scope against a CALLER-PROVIDED archetype set (archetypes are tenant-specific, so you define them: name + keywords, optional per-hit weight), ranks them, and returns the top match with a confidence (none/low/medium/high), the full ranked scores, the matched keywords, and a plain rationale (explainable, not a black box). Below the minimum score it stays the default (e.g. 'Unclassified') and says why. Feed it the name/description as `text` and/or the `scope` from autotask_extract_project_scope.",
    inputSchema: {
      type: 'object',
      properties: {
        archetypes: {
          type: 'array',
          description: 'Caller-defined archetypes to classify against. Each: { name, keywords[], weight? }.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              keywords: { type: 'array', items: { type: 'string' }, description: 'Case-insensitive substrings that signal this archetype' },
              weight: { type: 'number', description: 'Per-keyword-hit weight (default 1)', exclusiveMinimum: 0 }
            },
            required: ['name', 'keywords']
          }
        },
        text: { type: 'string', description: 'Project name/description or any free text to classify' },
        scope: {
          type: 'object',
          description: 'Scope to mine for signals (from autotask_extract_project_scope): included[], assumptions[], quantities[{item}].',
          properties: {
            included: { type: 'array', items: { type: 'string' } },
            assumptions: { type: 'array', items: { type: 'string' } },
            quantities: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } }
          }
        },
        minScore: { type: 'number', description: 'Minimum top score to accept a classification (default 1)', minimum: 0 },
        defaultArchetype: { type: 'string', description: 'Name used when nothing reaches minScore (default "Unclassified")' }
      },
      required: ['archetypes']
    },
    annotations: { title: 'Classify project archetype', readOnlyHint: true }
  },
  {
    name: 'autotask_calculate_bom_labor',
    description: "BOM → calculated labor (#46 §9): deterministically turn BOM/scope quantities into CALCULATED labor hours using a caller-provided rate catalog, and normalize the quantities into repeated tasks. No Autotask writes, no AI. Feed it the `quantities` from autotask_extract_project_scope (or supply items directly) plus `rates` (minutes/hours per unit per item type — tenant-specific, so you provide them). For each item it finds the first matching rate (case-insensitive keyword), computes hours = quantity × per-unit × laborMultiplier, and groups into `calculatedHoursByPhase` (ready to pass straight to autotask_generate_project_labor_plan as the CALCULATED view) plus a `tasks` list (title/estimatedHours/phaseRef/quantity) for the build plan. Items matching no rate are flagged in `unmatched` (never guessed) unless you set a defaultHoursPerUnit. This is the bottom-up number that §10 compares against QUOTED and PLANNED — it never overwrites quoted labor.",
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'BOM/scope quantities. Each: { item, quantity, unit? }. Use the quantities[] from autotask_extract_project_scope.',
          items: { type: 'object', properties: { item: { type: 'string' }, quantity: { type: 'number' }, unit: { type: 'string' } }, required: ['item', 'quantity'] }
        },
        rates: {
          type: 'array',
          description: 'Labor rate catalog (tenant-specific — you provide it). First matching rate wins. Each: { match | matchAny[], minutesPerUnit | hoursPerUnit, laborMultiplier?, phaseRef?, taskTitle? }.',
          items: {
            type: 'object',
            properties: {
              match: { type: 'string', description: 'Case-insensitive substring matched against the item name' },
              matchAny: { type: 'array', items: { type: 'string' }, description: 'Any of these substrings matches' },
              minutesPerUnit: { type: 'number', description: 'Labor minutes per unit (or use hoursPerUnit)' },
              hoursPerUnit: { type: 'number', description: 'Labor hours per unit' },
              laborMultiplier: { type: 'number', description: 'Multiplies computed hours (e.g. 2 terminations per drop)', exclusiveMinimum: 0 },
              phaseRef: { type: 'string', description: 'Phase this item’s hours roll into (matches your plan phase refs)' },
              taskTitle: { type: 'string', description: 'Task title for the generated repeated task (default: the item name)' }
            }
          }
        },
        defaultHoursPerUnit: { type: 'number', description: 'Fallback hours/unit for items no rate matches (default: none → flagged as unmatched)', minimum: 0 },
        defaultPhaseRef: { type: 'string', description: 'Phase for matched rates that specify none (default "unphased")' }
      },
      required: ['items', 'rates']
    },
    annotations: { title: 'Calculate labor from BOM', readOnlyHint: true }
  },
  {
    name: 'autotask_generate_project_labor_plan',
    description: "Deterministic labor plan for a project build plan (no Autotask writes, no AI). Compares three views of labor per phase — PLANNED (sum of the plan's task estimatedHours), QUOTED (what was sold, from the SOW/quote — you supply it), and CALCULATED (derived from BOM/scope quantities — you supply it) — and flags phases whose planned hours differ from quoted/calculated by more than the variance threshold (default 15%). Never overwrites quoted labor; it only reports variance for review (flags like over_quoted / under_quoted). Returns per-phase and total hours + deltas. Feed the same `plan` as autotask_calculate_project_schedule.",
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          description: 'Normalized project build plan (same shape as autotask_calculate_project_schedule): { name, phases:[{ref,title,parentRef?}], tasks:[{ref,title,estimatedHours,phaseRef?,...}] }.',
          properties: {
            name: { type: 'string' },
            phases: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, title: { type: 'string' }, parentRef: { type: 'string' } }, required: ['ref', 'title'] } },
            tasks: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, title: { type: 'string' }, estimatedHours: { type: 'number' }, phaseRef: { type: 'string' } }, required: ['ref', 'title', 'estimatedHours'] } }
          },
          required: ['name', 'tasks']
        },
        quotedHoursByPhase: { type: 'object', description: 'Quoted labor hours keyed by phase ref, e.g. {"p1": 40, "p2": 16}', additionalProperties: { type: 'number' } },
        calculatedHoursByPhase: { type: 'object', description: 'Labor hours calculated from BOM/scope quantities, keyed by phase ref', additionalProperties: { type: 'number' } },
        quotedHoursTotal: { type: 'number', description: 'Total quoted hours when a per-phase breakdown is not available' },
        calculatedHoursTotal: { type: 'number', description: 'Total calculated hours when a per-phase breakdown is not available' },
        varianceThresholdPct: { type: 'number', description: 'Fractional variance that counts as material (default 0.15 = 15%)', minimum: 0 }
      },
      required: ['plan']
    },
    annotations: { title: 'Generate project labor plan', readOnlyHint: true }
  },
  {
    name: 'autotask_build_project_from_plan',
    description: "Build engine: realize a validated project build plan as a real Autotask project — project → phases (parent-first) → tasks → task dependencies. SAFE BY DEFAULT: unless you pass dryRun:false, NOTHING is written and the tool returns the planned mutation counts for review. Idempotent + resumable: it tags the project with a build key and, on a re-run (same buildKey, or same company+name), reuses the existing project and creates only the phases/tasks/dependencies still missing (matched by title), so a retry after a partial failure never duplicates. Returns the shared write-plan envelope (status: dry_run | built | built_with_errors | validation_failed) with the Autotask projectId, a per-ref → id map, and a created/reused summary. Produce the plan with the SOW→project pipeline (or autotask_calculate_project_schedule for dates); this tool only builds an approved plan.",
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          description: 'Normalized project build plan (same shape as autotask_calculate_project_schedule). Tasks/phases use client-side string refs; the engine maps them to Autotask ids.',
          properties: {
            name: { type: 'string', description: 'Project name (also the idempotency name)' },
            archetype: { type: 'string', description: 'Optional GDS archetype classification' },
            source: { type: 'string', description: 'Optional provenance (SOW/quote id) — recorded in the project description, not built' },
            phases: {
              type: 'array',
              description: 'Phases (optional). Each: { ref, title, parentRef?, description? } — ref is a unique client-side id; parentRef nests a sub-phase.',
              items: {
                type: 'object',
                properties: {
                  ref: { type: 'string' },
                  title: { type: 'string' },
                  parentRef: { type: 'string' },
                  description: { type: 'string' }
                },
                required: ['ref', 'title']
              }
            },
            tasks: {
              type: 'array',
              description: 'Tasks. Each: { ref, title, estimatedHours, phaseRef?, predecessors?, lagDays?, taskType?, description? }. predecessors are task refs that must finish first.',
              items: {
                type: 'object',
                properties: {
                  ref: { type: 'string' },
                  title: { type: 'string' },
                  estimatedHours: { type: 'number' },
                  phaseRef: { type: 'string' },
                  predecessors: { type: 'array', items: { type: 'string' }, description: 'Refs of tasks that must finish before this one starts' },
                  lagDays: { type: 'number' },
                  taskType: { type: 'number' },
                  description: { type: 'string' }
                },
                required: ['ref', 'title', 'estimatedHours']
              }
            }
          },
          required: ['name', 'tasks']
        },
        companyID: { type: 'number', description: 'Company the project belongs to' },
        buildKey: { type: 'string', description: 'Stable idempotency key for this build (default: "<companyID>:<plan.name>"). Re-running with the same key resumes instead of duplicating.' },
        projectDefaults: {
          type: 'object',
          description: 'Autotask project fields applied on create (e.g. status, projectType, startDate, endDate, projectLeadResourceID, department). projectType is required by Autotask to create a project.',
          properties: {
            status: { type: 'number', description: 'Project status (e.g. 1=New, 2=In Progress)' },
            projectType: { type: 'number', description: 'Project type (2=Proposal, 3=Template, 4=Internal, 5=Client, 8=Baseline)' },
            startDate: { type: 'string', description: 'Project start date (YYYY-MM-DD)' },
            endDate: { type: 'string', description: 'Project end date (YYYY-MM-DD)' },
            projectLeadResourceID: { type: 'number', description: 'Project manager resource ID' },
            department: { type: 'number', description: 'Department id' }
          }
        },
        dryRun: { type: 'boolean', description: 'When true (DEFAULT), validate and return the plan without writing. Pass false to actually build.', default: true }
      },
      required: ['plan', 'companyID']
    },
    annotations: { title: 'Build project from plan' }
  },
  {
    name: 'autotask_extend_project',
    description: "Project extension (#46 §2.4): add phases / tasks / dependencies to an EXISTING project by id — a change order, an added phase, a recurring month, a new site, or extra tasks. SAFE BY DEFAULT: unless you pass dryRun:false, NOTHING is written and it returns what WOULD be added (the phases/tasks not already present by title). IDEMPOTENT MERGE: phases and tasks already in the project (matched by title) are reused, never duplicated, so re-running is safe and resumable. Same normalized plan shape and build engine as autotask_build_project_from_plan, but targets a known projectID instead of creating/finding a project. Returns the shared write-plan envelope (status: dry_run | validation_failed | extended | extended_with_errors) with a created/reused summary. Produce the `plan` with the SOW→project pipeline (extract_project_scope → calculate_bom_labor → calculate_project_schedule).",
    inputSchema: {
      type: 'object',
      properties: {
        projectID: { type: 'number', description: 'The existing Autotask project to extend' },
        plan: {
          type: 'object',
          description: 'Normalized build plan fragment to merge in (same shape as autotask_build_project_from_plan): { name, phases:[{ref,title,parentRef?,description?}], tasks:[{ref,title,estimatedHours,phaseRef?,predecessors?,lagDays?,taskType?,description?}] }. Only phases/tasks not already present (by title) are created.',
          properties: {
            name: { type: 'string', description: 'Label for the plan fragment (not used to find the project — projectID is authoritative)' },
            phases: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, title: { type: 'string' }, parentRef: { type: 'string' }, description: { type: 'string' } }, required: ['ref', 'title'] } },
            tasks: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, title: { type: 'string' }, estimatedHours: { type: 'number' }, phaseRef: { type: 'string' }, predecessors: { type: 'array', items: { type: 'string' } }, lagDays: { type: 'number' }, taskType: { type: 'number' }, description: { type: 'string' } }, required: ['ref', 'title'] } }
          },
          required: ['name', 'tasks']
        },
        dryRun: { type: 'boolean', description: 'Default true — plan only, no writes. Pass false to apply.' }
      },
      required: ['projectID', 'plan']
    },
    annotations: { title: 'Extend an existing project' }
  },
  {
    name: 'autotask_create_project',
    description: 'Create a new project in Autotask',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: {
          type: 'number',
          description: 'Company ID for the project'
        },
        projectName: {
          type: 'string',
          description: 'Project name'
        },
        description: {
          type: 'string',
          description: 'Project description'
        },
        status: {
          type: 'number',
          description: 'Project status (1=New, 2=In Progress, 5=Complete)'
        },
        startDate: {
          type: 'string',
          description: 'Project start date (YYYY-MM-DD)'
        },
        endDate: {
          type: 'string',
          description: 'Project end date (YYYY-MM-DD)'
        },
        projectLeadResourceID: {
          type: 'number',
          description: 'Project manager resource ID'
        },
        estimatedHours: {
          type: 'number',
          description: 'Estimated hours for the project'
        },
        projectType: {
          type: 'number',
          description: 'Project type (2=Proposal, 3=Template, 4=Internal, 5=Client, 8=Baseline). Required.'
        }
      },
      required: ['companyID', 'projectName', 'status', 'projectType']
    }
  },
  {
    name: 'autotask_link_project_commercial',
    description: 'Link a project to its commercial records — contract and/or opportunity. Validates that each reference belongs to the SAME company as the project (Autotask will otherwise let a project bill against a contract owned by a different company) and that the contract is active and not expired, then writes and reads the link back to confirm it took. Returns the safe-orchestration envelope: status is validation_failed | duplicate | dry_run | linked; anything other than "linked" means nothing was written. Set dryRun:true to validate and see the planned change without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: {
          type: 'number',
          description: 'The project to link'
        },
        contractID: {
          type: 'number',
          description: 'Contract the project bills against. Must belong to the same company as the project, be active, and not be expired.'
        },
        opportunityID: {
          type: 'number',
          description: 'Opportunity the project was won from. Must belong to the same company as the project.'
        },
        dryRun: {
          type: 'boolean',
          description: 'Validate and return the planned change without writing (default false)'
        }
      },
      required: ['projectID']
    }
  },
  {
    name: 'autotask_update_project',
    description: 'Update an existing project in Autotask. Only the fields you provide will be updated. Common use case: set status=5 to mark a project Complete.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'The ID of the project to update'
        },
        projectName: {
          type: 'string',
          description: 'Project name'
        },
        description: {
          type: 'string',
          description: 'Project description'
        },
        status: {
          type: 'number',
          description: 'Project status (1=New, 2=In Progress, 5=Complete). Set to 5 to mark the project complete.'
        },
        department: {
          type: 'number',
          description: 'Department picklist ID owning the project. (The Projects field is "department"; "departmentID" is accepted as a legacy alias.)'
        },
        departmentID: {
          type: 'number',
          description: 'Legacy alias for "department". Prefer "department".'
        },
        contractID: {
          type: 'number',
          description: 'Contract this project bills against. Must belong to the same company as the project. Prefer autotask_link_project_commercial, which validates ownership and reads the link back.'
        },
        opportunityID: {
          type: 'number',
          description: 'Opportunity this project was won from. Must belong to the same company as the project. Prefer autotask_link_project_commercial, which validates ownership and reads the link back.'
        },
        statusDetail: {
          type: 'string',
          description: 'Free-text status detail shown alongside the status picklist'
        },
        purchaseOrderNumber: {
          type: 'string',
          description: 'Customer purchase order number for this project'
        },
        assignedResourceID: {
          type: 'number',
          description: 'IGNORED — not a Projects field in Autotask (it belongs to Tasks). Accepted for backward compatibility but never sent. Use projectLeadResourceID.'
        },
        assignedResourceRoleID: {
          type: 'number',
          description: 'IGNORED — not a Projects field in Autotask (it belongs to Tasks). Accepted for backward compatibility but never sent.'
        },
        projectLeadResourceID: {
          type: 'number',
          description: 'Project lead resource ID'
        },
        startDateTime: {
          type: 'string',
          description: 'Project start date/time (ISO 8601)'
        },
        endDateTime: {
          type: 'string',
          description: 'Project end date/time (ISO 8601)'
        },
        estimatedTime: {
          type: 'number',
          description: 'IGNORED — read-only on Projects in Autotask (it is rolled up from tasks). Accepted for backward compatibility but never sent.'
        },
        userDefinedFields: {
          type: 'array',
          description: 'User-defined field values to set on the project (Autotask REST-native shape)',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'UDF name' },
              value: { type: 'string', description: 'UDF value' }
            },
            required: ['name', 'value']
          }
        }
      },
      required: ['projectId']
    }
  },

  // Resource tools
  {
    name: 'autotask_search_resources',
    description: 'Search for resources (users) in Autotask. Returns 25 results per page by default. Use page parameter for more results.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for resource name or email'
        },
        isActive: {
          type: 'boolean',
          
        },
        resourceType: {
          type: 'number',
          description: 'Filter by resource type (1=Employee, 2=Contractor, 3=Temporary)'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 500',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_search_roles',
    description: 'Search Autotask Roles (the roles used for ticket assignment and time entries). Returns id, name, hourlyRate, roleType, isActive. Use to discover a roleID for assignedResourceRoleID or a time-entry roleID.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: { type: 'string', description: 'Match against the role name (e.g. "Technician", "Engineer")' },
        isActive: { type: 'boolean', description: 'Filter by active state' },
        pageSize: { type: 'number', description: 'Max rows (default 100, max 500)', minimum: 1, maximum: 500 }
      }
    },
    annotations: { title: 'Search roles', readOnlyHint: true }
  },
  {
    name: 'autotask_get_resource_roles',
    description: 'List the roles a resource (user) may act in (from ResourceRoles), enriched with roleName, departmentName, and queueName, and flagging the resource\'s default service-desk role. Built so an LLM can pick the CORRECT roleID for the work when a resource has multiple roles (e.g. "Engineer" in Information Technology for a support ticket vs "Administrative" in Administration). NOTE: the REST API only exposes defaultServiceDeskRoleID as a default; the UI\'s "Default Department and Role" is NOT exposed, so when it is unset a resource with several roles has no API-visible default and you should choose by role/department context. Rows with roleExists:false are hidden Autotask SYSTEM roles (unnamed, not returned by the Roles entity — e.g. 110/112) — never use them for time; the time-entry tools neither offer nor accept them. Use to resolve a valid roleID before logging time / assigning work.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceID: { type: 'number', description: 'The resource (user) whose roles to list' }
      },
      required: ['resourceID']
    },
    annotations: { title: 'Get resource roles', readOnlyHint: true }
  },
  {
    name: 'autotask_report_resource_burden',
    description: 'Per-resource labour-burden report for cost / utilisation pages. Returns the fields real cost math needs: internalCost (Autotask\'s labour-burden basis — a PER-HOUR internal cost as entered), the employment basis (payrollType: Salary/Hourly/Contractor/Salary Non Exempt; resourceType: Employee/Contractor — which decide whether an unlogged hour is cash already gone vs capacity uncaptured), licenseType, plus isActive and hireDate. Active, real-staff resources only by default — API/integration accounts (licenseType = API User) are EXCLUDED (they have no cost and would pollute utilisation); pass includeApiUsers:true to include them. IMPORTANT: the API does NOT say whether internalCost is fully loaded (wage + employer taxes + benefits) or wage-only — a `notes` array surfaces this and flags resources with no internalCost set. Department is not a Resource field (use autotask_get_resource_roles). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        includeInactive: { type: 'boolean', description: 'Include inactive resources (leavers). Default false — leavers must not drag utilisation down.' },
        includeApiUsers: { type: 'boolean', description: 'Include API/integration accounts (licenseType = API User). Default false — they are not real staff.' },
        resourceType: { type: 'string', description: 'Filter by resourceType label, e.g. "Employee" or "Contractor".' },
        resourceIDs: { type: 'array', items: { type: 'number' }, description: 'Limit to specific resource IDs.' }
      },
      required: []
    },
    annotations: { title: 'Resource labour burden', readOnlyHint: true }
  },

  // Ticket Notes tools
  {
    name: 'autotask_get_ticket_note',
    description: 'Get a specific ticket note by ticket ID and note ID',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID'
        },
        noteId: {
          type: 'number',
          description: 'The note ID to retrieve'
        }
      },
      required: ['ticketId', 'noteId']
    }
  },
  {
    name: 'autotask_search_ticket_notes',
    description: 'Search for notes on a specific ticket. By default returns only notes PEOPLE wrote (techs, contacts, portal, email): Autotask\'s own bookkeeping — "Workflow Rule … fired" notes, "Service Desk Notification" email-recipient logs, forward/modify records — is hidden and counted in the message; pass includeSystemNotes:true for the raw stream. Iterating across many tickets trips Autotask\'s per-integration API threshold — scope the parent list first.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to search notes for'
        },
        includeSystemNotes: {
          type: 'boolean',
          description: 'Include Autotask system notes (workflow-rule, Service Desk Notification, forward/modify). Default false.'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['ticketId']
    }
  },
  {
    name: 'autotask_create_ticket_note',
    description: 'Create a new note for a ticket',
    _meta: TICKET_CARD_META,
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to add the note to'
        },
        title: {
          type: 'string',
          description: 'Note title'
        },
        description: {
          type: 'string',
          description: 'Note content'
        },
        noteType: {
          type: 'number',
          description: 'Note type picklist ID. Tenant-specific — call autotask_get_field_info with entityType "TicketNotes" and fieldName "noteType" to discover the exact label-to-ID mapping before calling this tool. Do not assume values from other Autotask instances apply here.'
        },
        publish: {
          type: 'number',
          description: 'Publish/visibility picklist ID. Tenant-specific and security-sensitive (controls whether the note is visible to clients). Call autotask_get_field_info with entityType "TicketNotes" and fieldName "publish" to discover the exact label-to-ID mapping before calling this tool. Never guess — the wrong value can expose internal notes to clients.'
        },
        idempotencyKey: {
          type: 'string',
          description: 'Optional dedup key so a re-run does not duplicate this note (e.g. "RPO-MTG:T20260922.0189:PARKWOOD-IPAD"). When set, a deterministic marker [MCP-ID:<key>] is appended to the note body; before creating, the ticket\'s existing notes are scanned for that marker and the prior note is returned instead of a second copy. Keep the note internal (publish) if the key should not be client-visible. Use a stable key per logical note.'
        }
      },
      required: ['ticketId', 'description', 'noteType', 'publish']
    }
  },

  // Ticket Checklist Items tools (sub-resource of Tickets)
  {
    name: 'autotask_search_ticket_checklist_items',
    description: 'List all checklist items on a ticket, including their completion status. Checklist items are a sub-resource of a ticket and cannot be queried without a ticket ID.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID whose checklist items should be listed'
        }
      },
      required: ['ticketId']
    }
  },
  {
    name: 'autotask_create_ticket_checklist_item',
    description: 'Add a new checklist item to a ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to add the checklist item to'
        },
        itemName: {
          type: 'string',
          description: 'The checklist item text'
        },
        position: {
          type: 'number',
          description: 'Optional ordering position for the item'
        },
        isCompleted: {
          type: 'boolean',
          description: 'Whether the item starts in the completed state (default: false)'
        }
      },
      required: ['ticketId', 'itemName']
    }
  },
  {
    name: 'autotask_update_ticket_checklist_item',
    description: 'Update a checklist item on a ticket — edit text, mark complete/incomplete, or change position.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The parent ticket ID'
        },
        itemId: {
          type: 'number',
          description: 'The checklist item ID to update'
        },
        itemName: {
          type: 'string',
          description: 'New text for the checklist item'
        },
        isCompleted: {
          type: 'boolean',
          description: 'Mark the item complete (true) or incomplete (false)'
        },
        position: {
          type: 'number',
          description: 'New ordering position for the item'
        }
      },
      required: ['ticketId', 'itemId']
    }
  },
  {
    name: 'autotask_delete_ticket_checklist_item',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a checklist item ' +
      'from a ticket. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete ticket checklist item (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The parent ticket ID'
        },
        itemId: {
          type: 'number',
          description: 'The checklist item ID to delete'
        }
      },
      required: ['ticketId', 'itemId']
    }
  },
  {
    name: 'autotask_search_checklist_libraries',
    description: 'Search reusable checklist libraries (standardized work-instruction checklists). Filter by isActive, entityType (which entity the library targets), or name searchTerm. Use to pick the right library (e.g. "Managed Network - Firmware Maintenance") before applying it to a ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: { type: 'string', description: 'Match against the library name' },
        isActive: { type: 'boolean', description: 'Filter by active state' },
        entityType: { type: 'number', description: 'Filter by target entity type (picklist; libraries are scoped to an entity such as tickets)' },
        pageSize: { type: 'number', description: 'Max rows to return (default 100, max 500)', minimum: 1, maximum: 500 }
      }
    },
    annotations: { title: 'Search checklist libraries', readOnlyHint: true }
  },
  {
    name: 'autotask_get_checklist_library',
    description: 'Get a checklist library by id, including its ordered items (from ChecklistLibraryChecklistItems: itemName, isImportant, position, knowledgebaseArticleID). Preview what applying it to a ticket will add.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'ChecklistLibrary id' } },
      required: ['id']
    },
    annotations: { title: 'Get checklist library', readOnlyHint: true }
  },
  {
    name: 'autotask_apply_checklist_library_to_ticket',
    description: 'Apply a checklist library to a ticket — expands the library\'s items into checklist items on the ticket (itemName / isImportant / position / knowledgebaseArticleID carried over). Autotask has no native apply endpoint, so this creates one TicketChecklistItem per library item. Each item is created independently; failures are reported per-item without aborting the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'The ticket to add the checklist items to' },
        checklistLibraryID: { type: 'number', description: 'The checklist library to apply' }
      },
      required: ['ticketID', 'checklistLibraryID']
    }
  },

  // Project Notes tools
  {
    name: 'autotask_get_project_note',
    description: 'Get a specific project note by project ID and note ID',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'The project ID'
        },
        noteId: {
          type: 'number',
          description: 'The note ID to retrieve'
        }
      },
      required: ['projectId', 'noteId']
    }
  },
  {
    name: 'autotask_search_project_notes',
    description: 'Search for notes on a specific project. Fan-out across many projects trips Autotask\'s API threshold (see issue #69) — scope the parent list (status, company, date range) first.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'The project ID to search notes for'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'autotask_create_project_note',
    description: 'Create a new note for a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'The project ID to add the note to'
        },
        title: {
          type: 'string',
          description: 'Note title'
        },
        description: {
          type: 'string',
          description: 'Note content'
        },
        noteType: {
          type: 'number',
          description: 'Note type (1=General, 2=Appointment, 3=Task, 4=Ticket, 5=Project, 6=Opportunity)'
        },
        publish: {
          type: 'number',
          description: 'Publish visibility (1=All Autotask Users, 2=Internal Project Team, 3=Project Team). Defaults to 1.'
        },
        isAnnouncement: {
          type: 'boolean',
          description: 'Whether this note is an announcement. Defaults to false.'
        }
      },
      required: ['projectId', 'description']
    }
  },
  {
    name: 'autotask_get_task_note',
    description: 'Get a specific project-task note by task ID and note ID.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID' },
        noteId: { type: 'number', description: 'The note ID' }
      },
      required: ['taskId', 'noteId']
    },
    annotations: { title: 'Get task note', readOnlyHint: true }
  },
  {
    name: 'autotask_search_task_notes',
    description: 'List the notes on a project task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID' },
        pageSize: { type: 'number', description: 'Number of results (default 25)', minimum: 1, maximum: 100 }
      },
      required: ['taskId']
    },
    annotations: { title: 'Search task notes', readOnlyHint: true }
  },
  {
    name: 'autotask_create_task_note',
    description: 'Create a note on a project task. Resolve noteType/publish values from tenant metadata (autotask_get_field_info(TaskNotes)) rather than assuming constants.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID to add the note to' },
        title: { type: 'string', description: 'Note title' },
        description: { type: 'string', description: 'Note content' },
        noteType: { type: 'number', description: 'Note type id (resolve via metadata)' },
        publish: { type: 'number', description: 'Publish/visibility id (resolve via metadata)' }
      },
      required: ['taskId', 'description']
    }
  },
  {
    name: 'autotask_search_project_attachments',
    description: 'List attachment metadata on a project (name, type, size, attach date). Read-only; binary upload/download is a separate capability.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'The project ID' },
        pageSize: { type: 'number', description: 'Number of results (default 25)', minimum: 1, maximum: 100 }
      },
      required: ['projectId']
    },
    annotations: { title: 'List project attachments', readOnlyHint: true }
  },
  {
    name: 'autotask_search_task_attachments',
    description: 'List attachment metadata on a project task. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID' },
        pageSize: { type: 'number', description: 'Number of results (default 25)', minimum: 1, maximum: 100 }
      },
      required: ['taskId']
    },
    annotations: { title: 'List task attachments', readOnlyHint: true }
  },
  {
    name: 'autotask_get_project_attachment',
    description: 'Get a project attachment. With includeData=false (default) returns metadata only — fast, suitable for browsing. With includeData=true returns the base64 binary content via the top-level /ProjectAttachments/{id} endpoint (the child endpoint never populates data). The attachment is verified to belong to the given projectId. Oversized binaries are stripped with a dataOmittedReason field (base64 can exceed the MCP client tool-result limit of ~1 MB).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'The project ID the attachment belongs to' },
        attachmentId: { type: 'number', description: 'The attachment ID to retrieve' },
        includeData: { type: 'boolean', description: 'Set true to fetch the base64-encoded file bytes. Default false returns metadata only.', default: false },
        maxInlineBase64Bytes: { type: 'number', description: 'Cap on base64 string length before data is stripped (default 750_000, ~560 KB raw). Only relevant when includeData=true. Raise carefully — your MCP client may reject oversized tool results.', minimum: 1024 }
      },
      required: ['projectId', 'attachmentId']
    },
    annotations: { title: 'Get project attachment', readOnlyHint: true }
  },
  {
    name: 'autotask_create_project_attachment',
    description: 'Upload a file attachment to an existing project. The file content must be passed as a base64-encoded string in the `data` field (MCP is JSON-RPC, so binary bytes must be base64-encoded). Autotask enforces a 3 MB hard limit; this tool validates the decoded size before calling the API. Example: { projectId: 152, title: "SOW.pdf", data: "JVBERi0xLjc..." }',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'The project ID to attach the file to' },
        title: { type: 'string', description: 'Display title for the attachment (typically the filename, e.g. "SOW.pdf")' },
        data: { type: 'string', description: 'Base64-encoded file content. Maximum decoded size: 3 MB.' },
        fullPath: { type: 'string', description: 'Original filename including any path. Defaults to `title` if not provided.' },
        contentType: { type: 'string', description: 'MIME type of the file (e.g. "application/pdf", "image/png"). Optional.' },
        publish: { type: 'number', description: 'Visibility: 1 = All Autotask Users (default), 2 = Internal Users Only', default: 1 }
      },
      required: ['projectId', 'title', 'data']
    }
  },
  {
    name: 'autotask_get_task_attachment',
    description: 'Get a project-task attachment. With includeData=false (default) returns metadata only. With includeData=true returns the base64 binary content via the top-level /TaskAttachments/{id} endpoint (the child endpoint never populates data). The attachment is verified to belong to the given taskId. Oversized binaries are stripped with a dataOmittedReason field.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID the attachment belongs to' },
        attachmentId: { type: 'number', description: 'The attachment ID to retrieve' },
        includeData: { type: 'boolean', description: 'Set true to fetch the base64-encoded file bytes. Default false returns metadata only.', default: false },
        maxInlineBase64Bytes: { type: 'number', description: 'Cap on base64 string length before data is stripped (default 750_000, ~560 KB raw). Only relevant when includeData=true. Raise carefully — your MCP client may reject oversized tool results.', minimum: 1024 }
      },
      required: ['taskId', 'attachmentId']
    },
    annotations: { title: 'Get task attachment', readOnlyHint: true }
  },
  {
    name: 'autotask_create_task_attachment',
    description: 'Upload a file attachment to an existing project task. The file content must be passed as a base64-encoded string in the `data` field. Autotask enforces a 3 MB hard limit; this tool validates the decoded size before calling the API. Example: { taskId: 45678, title: "as-built.pdf", data: "JVBERi0xLjc..." }',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID to attach the file to' },
        title: { type: 'string', description: 'Display title for the attachment (typically the filename, e.g. "as-built.pdf")' },
        data: { type: 'string', description: 'Base64-encoded file content. Maximum decoded size: 3 MB.' },
        fullPath: { type: 'string', description: 'Original filename including any path. Defaults to `title` if not provided.' },
        contentType: { type: 'string', description: 'MIME type of the file (e.g. "application/pdf", "image/png"). Optional.' },
        publish: { type: 'number', description: 'Visibility: 1 = All Autotask Users (default), 2 = Internal Users Only', default: 1 }
      },
      required: ['taskId', 'title', 'data']
    }
  },

  // Company Notes tools
  {
    name: 'autotask_get_company_note',
    description: 'Get a specific company note by company ID and note ID',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'The company ID'
        },
        noteId: {
          type: 'number',
          description: 'The note ID to retrieve'
        }
      },
      required: ['companyId', 'noteId']
    }
  },
  {
    name: 'autotask_search_company_notes',
    description: 'Search for notes on a specific company. Iterating across many companies trips Autotask\'s API threshold — scope the parent list first.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'The company ID to search notes for'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['companyId']
    }
  },
  {
    name: 'autotask_create_company_note',
    description: 'Create a new note for a company',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'The company ID to add the note to'
        },
        title: {
          type: 'string',
          description: 'Note title'
        },
        description: {
          type: 'string',
          description: 'Note content'
        },
        actionType: {
          type: 'number',
          description: 'Action type for the note'
        }
      },
      required: ['companyId', 'description']
    }
  },

  // Ticket Attachments tools
  {
    name: 'autotask_get_ticket_attachment',
    description: 'Get a ticket attachment. With includeData=false (default) returns metadata only — fast, suitable for browsing. With includeData=true returns the base64 binary content via the top-level /TicketAttachments/{id} endpoint (the child endpoint never populates data). The attachment is verified to belong to the given ticketId. Oversized binaries are stripped from the response with a dataOmittedReason field — Autotask attachments can be up to 3 MB, which is ~4 MB as base64 and may exceed the MCP client tool-result limit (~1 MB).',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID the attachment belongs to'
        },
        attachmentId: {
          type: 'number',
          description: 'The attachment ID to retrieve'
        },
        includeData: {
          type: 'boolean',
          description: 'Set true to fetch the base64-encoded file bytes. Default false returns metadata only.',
          default: false
        },
        maxInlineBase64Bytes: {
          type: 'number',
          description: 'Cap on base64 string length before data is stripped (default 750_000, ~560 KB raw). Only relevant when includeData=true. Raise carefully — your MCP client may reject oversized tool results.',
          minimum: 1024
        }
      },
      required: ['ticketId', 'attachmentId']
    }
  },
  {
    name: 'autotask_search_ticket_attachments',
    description: 'Search for attachments on a specific ticket. Each parent triggers a separate query — scope the parent ticket list before iterating.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to search attachments for'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 10, max: 50)',
          minimum: 1,
          maximum: 50
        }
      },
      required: ['ticketId']
    }
  },
  {
    name: 'autotask_create_ticket_attachment',
    description:
      'Upload a file attachment to an existing ticket. The file content must be passed as a base64-encoded string in the `data` field (MCP is JSON-RPC, so binary bytes must be base64-encoded). Autotask enforces a 3 MB hard limit on ticket attachments; this tool validates the decoded size before calling the API and returns a clear error if the limit is exceeded. Example: { ticketId: 12345, title: "screenshot.png", data: "iVBORw0KGgoAAAANSUhEUgAA..." }',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to attach the file to'
        },
        title: {
          type: 'string',
          description: 'Display title for the attachment (typically the filename, e.g. "screenshot.png")'
        },
        data: {
          type: 'string',
          description:
            'Base64-encoded file content. Maximum decoded size: 3 MB (Autotask ticket attachment limit). Example: read a file and pass its base64 representation here.'
        },
        fullPath: {
          type: 'string',
          description: 'Original filename including any path. Defaults to `title` if not provided.'
        },
        contentType: {
          type: 'string',
          description: 'MIME type of the file (e.g. "image/png", "application/pdf"). Optional.'
        },
        publish: {
          type: 'number',
          description: 'Visibility: 1 = All Autotask Users (default), 2 = Internal Users Only',
          default: 1
        }
      },
      required: ['ticketId', 'title', 'data']
    }
  },

  // Expense Reports tools
  {
    name: 'autotask_get_expense_report',
    description: 'Get a specific expense report by ID',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: {
          type: 'number',
          description: 'The expense report ID to retrieve'
        }
      },
      required: ['reportId']
    }
  },
  {
    name: 'autotask_search_expense_reports',
    description: 'Search for expense reports with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        submitterId: {
          type: 'number',
          description: 'Filter by submitter resource ID'
        },
        status: {
          type: 'number',
          description: 'Filter by status (1=New, 2=Submitted, 3=Approved, 4=Paid, 5=Rejected, 6=InReview)'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_expense_report',
    description: 'Create a new expense report',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Expense report name'
        },
        description: {
          type: 'string',
          description: 'Expense report description'
        },
        submitterId: {
          type: 'number',
          description: 'The resource ID of the submitter'
        },
        weekEndingDate: {
          type: 'string',
          description: 'Week ending date (YYYY-MM-DD format)'
        }
      },
      required: ['name', 'submitterId', 'weekEndingDate']
    }
  },

  // Expense Item tools
  {
    name: 'autotask_search_expense_items',
    description: 'Search expense items (parking, mileage, meals, materials bought). Filter by ticketId to read the expenses on a ticket (the "Charges & Expenses" tab: charges are separate, autotask_search_ticket_charges), or by expenseReportId. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'Expense items logged against this ticket'
        },
        expenseReportId: {
          type: 'number',
          description: 'Expense items on this expense report'
        },
        startDate: {
          type: 'string',
          description: 'Expense date on or after (YYYY-MM-DD)'
        },
        endDate: {
          type: 'string',
          description: 'Expense date on or before (YYYY-MM-DD)'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_expense_item',
    description: 'Create an expense item on an existing expense report',
    inputSchema: {
      type: 'object',
      properties: {
        expenseReportId: { type: 'number', description: 'The expense report ID to add the item to' },
        description: { type: 'string', description: 'Line item description' },
        expenseDate: { type: 'string', description: 'Date of expense (YYYY-MM-DD format)' },
        expenseCategory: { type: 'number', description: 'Expense category picklist ID' },
        amount: { type: 'number', description: 'Expense amount' },
        companyId: { type: 'number', description: 'Associated company ID (0 for internal)' },
        haveReceipt: { type: 'boolean', description: 'Whether a receipt is attached' },
        isBillableToCompany: { type: 'boolean', description: 'Whether billable to company' },
        isReimbursable: { type: 'boolean', description: 'Whether this expense is reimbursable' },
        paymentType: { type: 'number', description: 'Payment type picklist ID' }
      },
      required: ['expenseReportId', 'description', 'expenseDate', 'expenseCategory', 'amount']
    }
  },

  // Quotes tools
  {
    name: 'autotask_get_quote',
    description: 'Get a specific quote by ID',
    inputSchema: {
      type: 'object',
      properties: {
        quoteId: {
          type: 'number',
          description: 'The quote ID to retrieve'
        }
      },
      required: ['quoteId']
    }
  },
  {
    name: 'autotask_search_quotes',
    description: 'Search for quotes with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'Filter by company ID'
        },
        contactId: {
          type: 'number',
          description: 'Filter by contact ID'
        },
        opportunityId: {
          type: 'number',
          description: 'Filter by opportunity ID'
        },
        searchTerm: {
          type: 'string',
          description: 'Search term for quote name or description'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_quote',
    description: 'Create a new quote',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Quote name'
        },
        description: {
          type: 'string',
          description: 'Quote description'
        },
        companyId: {
          type: 'number',
          description: 'Company ID for the quote'
        },
        contactId: {
          type: 'number',
          description: 'Contact ID for the quote'
        },
        opportunityId: {
          type: 'number',
          description: 'Associated opportunity ID'
        },
        effectiveDate: {
          type: 'string',
          description: 'Effective date (YYYY-MM-DD format)'
        },
        expirationDate: {
          type: 'string',
          description: 'Expiration date (YYYY-MM-DD format)'
        }
      },
      required: ['companyId']
    }
  },

  // Opportunity tools
  {
    name: 'autotask_get_opportunity',
    description: 'Get a specific opportunity by ID',
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: {
          type: 'number',
          description: 'The opportunity ID to retrieve'
        }
      },
      required: ['opportunityId']
    }
  },
  {
    name: 'autotask_search_opportunities',
    description: 'Search for opportunities with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'Filter by company ID'
        },
        searchTerm: {
          type: 'string',
          description: 'Search term for opportunity title'
        },
        status: {
          type: 'number',
          description: 'Filter by status'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },

  {
    name: 'autotask_create_opportunity',
    description: 'Create a new sales opportunity in Autotask',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Opportunity name/title'
        },
        companyId: {
          type: 'number',
          description: 'Company ID for the opportunity'
        },
        ownerResourceId: {
          type: 'number',
          description: 'Owner resource ID (the sales rep or account manager)'
        },
        status: {
          type: 'number',
          description: 'Status: 0=Not Ready To Buy, 1=Active, 2=Lost, 3=Closed, 4=Implemented'
        },
        stage: {
          type: 'number',
          description: 'Stage picklist value ID (use autotask_get_field_info to find valid values)'
        },
        projectedCloseDate: {
          type: 'string',
          description: 'Projected close date (YYYY-MM-DD)'
        },
        startDate: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD)'
        },
        probability: {
          type: 'number',
          description: 'Win probability percentage (0-100, default: 50)'
        },
        amount: {
          type: 'number',
          description: 'Revenue amount (default: 0, set useQuoteTotals=true to calculate from quotes)'
        },
        cost: {
          type: 'number',
          description: 'Cost amount (default: 0)'
        },
        useQuoteTotals: {
          type: 'boolean',
          description: 'Whether to calculate totals from linked quotes (default: true)'
        },
        totalAmountMonths: {
          type: 'number',
          description: 'Number of months to calculate totals for (e.g., 12 for annual)'
        },
        contactId: {
          type: 'number',
          description: 'Contact ID for the opportunity'
        },
        description: {
          type: 'string',
          description: 'Opportunity description'
        },
        opportunityCategoryID: {
          type: 'number',
          description: 'Opportunity category picklist value ID'
        }
      },
      required: ['title', 'companyId', 'ownerResourceId', 'status', 'stage', 'projectedCloseDate', 'startDate']
    }
  },
  {
    name: 'autotask_update_opportunity',
    description:
      'Update a sales opportunity. Uses the Autotask collection PATCH convention ' +
      '(the item route does not work in the GDS zone). To close an opportunity, ' +
      'set status (e.g. 2=Lost, 3=Closed) — confirm with the user first for an ' +
      'ambiguous request, then read it back with autotask_get_opportunity.',
    annotations: { title: 'Update opportunity', readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'number', description: 'Opportunity ID to update' },
        title: { type: 'string', description: 'Opportunity name/title' },
        status: { type: 'number', description: 'Status: 0=Not Ready To Buy, 1=Active, 2=Lost, 3=Closed, 4=Implemented' },
        stage: { type: 'number', description: 'Stage picklist value ID' },
        projectedCloseDate: { type: 'string', description: 'Projected close date (YYYY-MM-DD)' },
        startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        amount: { type: 'number', description: 'Revenue amount' },
        cost: { type: 'number', description: 'Cost amount' },
        probability: { type: 'number', description: 'Win probability percentage (0-100)' },
        contactId: { type: 'number', description: 'Contact ID' },
        description: { type: 'string', description: 'Opportunity description' }
      },
      required: ['opportunityId']
    }
  },

  // Product tools
  {
    name: 'autotask_get_product',
    description: 'Get a specific product by ID',
    inputSchema: {
      type: 'object',
      properties: {
        productId: {
          type: 'number',
          description: 'The product ID to retrieve'
        }
      },
      required: ['productId']
    }
  },
  {
    name: 'autotask_search_products',
    description: 'Search for products with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for product name'
        },
        isActive: {
          type: 'boolean',
          
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_find_product',
    description: "Clean, normalized product search across ALL identifiers — the usable layer over Autotask's weak native search. Matches the query against sku, internalProductID, externalProductID, manufacturerProductName, vendorProductNumber (+ name/description tokens), scores each product, and returns ranked matches with which fields matched. An exact identifier hit ranks highest; token overlap catches e.g. \"cat6 keystone\" → \"Blue Cat6 Keystone\". Use this instead of autotask_search_products when a plain name search misses. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part number, manufacturer/vendor number, or name terms' },
        limit: { type: 'number', description: 'Max matches to return (default 25)', minimum: 1, maximum: 200 },
        activeOnly: { type: 'boolean', description: 'Only active products (default false — dedup/cleanup often needs inactive ones too)' },
        maxProducts: { type: 'number', description: 'Cap on catalog rows scanned (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: ['query']
    },
    annotations: { title: 'Find product (clean search)', readOnlyHint: true }
  },
  {
    name: 'autotask_list_product_categories',
    description: "List the productCategory picklist as a parent→child tree (categories are a hierarchical picklist named 'Parent>Child>Grandchild', not a REST entity). Flags malformed labels (a label that reads like a description, not a name) and, with withCounts, tallies products per category. The map for standardizing/reclassifying the catalog. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        withCounts: { type: 'boolean', description: 'Tally product counts per category (scans the catalog; default false)' },
        maxProducts: { type: 'number', description: 'Cap on products scanned for counts (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'List product categories', readOnlyHint: true }
  },
  {
    name: 'autotask_find_catalog_gaps',
    description: 'Find products with data gaps for cleanup (read-only): missing productCategory, missing MSRP, or a weak description (empty, too short, or identical to the name). Returns counts plus sample product refs per gap type. Scope with activeOnly (default true).',
    inputSchema: {
      type: 'object',
      properties: {
        activeOnly: { type: 'boolean', description: 'Only active products (default true)' },
        minDescriptionLength: { type: 'number', description: 'Descriptions shorter than this count as weak (default 10)', minimum: 1 },
        maxSamples: { type: 'number', description: 'Sample product refs per gap type (default 25)', minimum: 1 },
        maxProducts: { type: 'number', description: 'Cap on catalog rows scanned (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'Find catalog gaps', readOnlyHint: true }
  },
  {
    name: 'autotask_find_duplicate_products',
    description: 'Find duplicate-product candidate groups (read-only): products sharing a normalized identifier (sku, else manufacturerProductName, else name) are grouped, each with a suggested survivor (active > most complete > lowest id) — the item to keep when merging the rest down. Includes inactive products by default so existing dupes surface. Returns groups ranked by size. Use before a Phase B merge.',
    inputSchema: {
      type: 'object',
      properties: {
        activeOnly: { type: 'boolean', description: 'Only active products (default false)' },
        limit: { type: 'number', description: 'Max duplicate groups to return (default all)', minimum: 1 },
        maxProducts: { type: 'number', description: 'Cap on catalog rows scanned (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'Find duplicate products', readOnlyHint: true }
  },
  {
    name: 'autotask_bulk_update_products',
    description: "Bulk-update products for catalog cleanup (dry-run-first). Pass an `updates` array of per-product patches ({ id, plus any of: name, description, sku, internalProductID, manufacturerName, manufacturerProductName, vendorProductNumber, productCategory, unitCost, unitPrice, msrp, isActive, isSerialized, link, defaultVendorID }). Each patch is diffed against current values, so only real changes are written and no-ops are skipped. SAFE BY DEFAULT: unless dryRun:false, nothing is written and the planned before→after changes are returned for review. Returns per-item results with partial-failure reporting. Use for mass reclassify / description / MSRP / part-number standardization.",
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          description: 'Per-product patches; each needs id + at least one field to change.',
          items: { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' }, description: { type: 'string' }, sku: { type: 'string' }, internalProductID: { type: 'string' }, manufacturerName: { type: 'string' }, manufacturerProductName: { type: 'string' }, vendorProductNumber: { type: 'string' }, productCategory: { type: 'number' }, unitCost: { type: 'number' }, unitPrice: { type: 'number' }, msrp: { type: 'number' }, isActive: { type: 'boolean' }, isSerialized: { type: 'boolean' }, link: { type: 'string' }, defaultVendorID: { type: 'number' } }, required: ['id'] }
        },
        dryRun: { type: 'boolean', description: 'When true (DEFAULT) validate + return planned changes without writing. Pass false to apply.', default: true }
      },
      required: ['updates']
    },
    annotations: { title: 'Bulk update products' }
  },
  {
    name: 'autotask_merge_products',
    description: "Merge duplicate products (dry-run-first): keep `survivorId`, enrich it with any fields it's missing from the duplicates (description/MSRP/category/part numbers/pricing), and mark the duplicate products inactive. Never moves inventory — duplicates that still hold on-hand stock are flagged (onHandWarnings) so you reconcile/transfer counts first. SAFE BY DEFAULT: unless dryRun:false, nothing is written and the plan (survivor enrichment + which dups would deactivate + stock warnings) is returned. Get candidate groups from autotask_find_duplicate_products.",
    inputSchema: {
      type: 'object',
      properties: {
        survivorId: { type: 'number', description: 'Product to keep' },
        duplicateIds: { type: 'array', items: { type: 'number' }, description: 'Products to merge into the survivor (deactivated)' },
        enrichSurvivor: { type: 'boolean', description: 'Copy missing fields from dups onto the survivor (default true)' },
        dryRun: { type: 'boolean', description: 'When true (DEFAULT) return the plan without writing. Pass false to apply.', default: true }
      },
      required: ['survivorId', 'duplicateIds']
    },
    annotations: { title: 'Merge duplicate products' }
  },
  {
    name: 'autotask_create_product',
    description: 'Create a product in the catalog. Common fields: name, description, sku, internalProductID, manufacturerName, manufacturerProductName, vendorProductNumber, productCategory (picklist id — see autotask_list_product_categories), unitCost, unitPrice, msrp, isActive, isSerialized, defaultVendorID, link.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Product name' },
        description: { type: 'string' },
        sku: { type: 'string', description: 'Your internal/clean part number' },
        internalProductID: { type: 'string' },
        manufacturerName: { type: 'string' },
        manufacturerProductName: { type: 'string', description: 'Manufacturer part number' },
        vendorProductNumber: { type: 'string', description: 'Supplier part number' },
        productCategory: { type: 'number', description: 'Category picklist id' },
        unitCost: { type: 'number' }, unitPrice: { type: 'number' }, msrp: { type: 'number' },
        isActive: { type: 'boolean' }, isSerialized: { type: 'boolean' },
        defaultVendorID: { type: 'number' }, link: { type: 'string', description: 'Product/reference URL' }
      },
      required: ['name']
    }
  },
  {
    name: 'autotask_update_product',
    description: 'Update a catalog product by id. Pass id plus any fields to change (name, description, sku, internalProductID, manufacturerProductName, vendorProductNumber, productCategory, unitCost, unitPrice, msrp, isActive, link, …). Use to standardize part numbers, fix categories/descriptions, set MSRP, or deactivate a duplicate (isActive:false).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Product id' },
        name: { type: 'string' }, description: { type: 'string' }, sku: { type: 'string' },
        internalProductID: { type: 'string' }, manufacturerName: { type: 'string' }, manufacturerProductName: { type: 'string' },
        vendorProductNumber: { type: 'string' }, productCategory: { type: 'number' },
        unitCost: { type: 'number' }, unitPrice: { type: 'number' }, msrp: { type: 'number' },
        isActive: { type: 'boolean' }, isSerialized: { type: 'boolean' }, link: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_search_inventory_products',
    description: "A product's stock levels per location (InventoryProducts): onHandUnits, availableUnits, reservedUnits, pickedUnits, unitsOnOrder, quantityMinimum/Maximum, bin, referenceNumber. Filter by productID and/or inventoryLocationID.",
    inputSchema: { type: 'object', properties: { productID: { type: 'number' }, inventoryLocationID: { type: 'number' }, pageSize: { type: 'number', minimum: 1, maximum: 500 } }, required: [] },
    annotations: { title: 'Search inventory products', readOnlyHint: true }
  },
  { name: 'autotask_get_inventory_product', description: 'Get one InventoryProducts record (a product\'s stock at a location) by id.', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }, annotations: { title: 'Get inventory product', readOnlyHint: true } },
  {
    name: 'autotask_create_inventory_product',
    description: 'Stock a product at a location: create an InventoryProducts record. Required: productID, inventoryLocationID, quantityMinimum, quantityMaximum, availableUnits. Optional: bin, referenceNumber.',
    inputSchema: { type: 'object', properties: { productID: { type: 'number' }, inventoryLocationID: { type: 'number' }, quantityMinimum: { type: 'number' }, quantityMaximum: { type: 'number' }, availableUnits: { type: 'number' }, bin: { type: 'string' }, referenceNumber: { type: 'string' } }, required: ['productID', 'inventoryLocationID', 'quantityMinimum', 'quantityMaximum', 'availableUnits'] }
  },
  {
    name: 'autotask_update_inventory_product',
    description: 'Update an InventoryProducts record (stock levels/min-max/bin) by id. Note: on-hand counts are changed via stock add/remove or transfers, not here — this sets quantityMinimum/Maximum, bin, referenceNumber.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, quantityMinimum: { type: 'number' }, quantityMaximum: { type: 'number' }, bin: { type: 'string' }, referenceNumber: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'autotask_search_inventory_locations',
    description: 'Inventory locations (warehouses / tech vans): locationName, isActive, isDefault, resourceID (a resource-linked location = a tech van). Optionally filter by isActive.',
    inputSchema: { type: 'object', properties: { isActive: { type: 'boolean' }, pageSize: { type: 'number', minimum: 1, maximum: 500 } }, required: [] },
    annotations: { title: 'Search inventory locations', readOnlyHint: true }
  },
  { name: 'autotask_get_inventory_location', description: 'Get one InventoryLocations record by id.', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }, annotations: { title: 'Get inventory location', readOnlyHint: true } },
  {
    name: 'autotask_create_inventory_location',
    description: 'Create an inventory location (warehouse or tech van). Required: locationName, isActive. Optional: isDefault, resourceID (link to a resource for a tech-van location).',
    inputSchema: { type: 'object', properties: { locationName: { type: 'string' }, isActive: { type: 'boolean' }, isDefault: { type: 'boolean' }, resourceID: { type: 'number' } }, required: ['locationName', 'isActive'] }
  },
  {
    name: 'autotask_update_inventory_location',
    description: 'Update an inventory location by id (locationName, isActive, isDefault, resourceID).',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, locationName: { type: 'string' }, isActive: { type: 'boolean' }, isDefault: { type: 'boolean' }, resourceID: { type: 'number' } }, required: ['id'] }
  },
  {
    name: 'autotask_search_inventory_stocked_items',
    description: 'Individual stocked units (InventoryStockedItems): onHandUnits, availableUnits, serialNumber, statusID, unitCost, currentInventoryLocationID, vendorID, and consumption links (ticketChargeID / projectChargeID / pickedRemovedDateTime). Filter by inventoryProductID, currentInventoryLocationID, and/or serialNumber.',
    inputSchema: { type: 'object', properties: { inventoryProductID: { type: 'number' }, currentInventoryLocationID: { type: 'number' }, serialNumber: { type: 'string' }, pageSize: { type: 'number', minimum: 1, maximum: 500 } }, required: [] },
    annotations: { title: 'Search stocked items', readOnlyHint: true }
  },
  { name: 'autotask_get_inventory_stocked_item', description: 'Get one InventoryStockedItems record by id.', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }, annotations: { title: 'Get stocked item', readOnlyHint: true } },
  {
    name: 'autotask_search_inventory_transfers',
    description: 'Stock transfers between locations (InventoryTransfers): productID, fromLocationID, toLocationID, quantityTransferred, transferDate, notes, serialNumber. Filter by productID / fromLocationID / toLocationID.',
    inputSchema: { type: 'object', properties: { productID: { type: 'number' }, fromLocationID: { type: 'number' }, toLocationID: { type: 'number' }, pageSize: { type: 'number', minimum: 1, maximum: 500 } }, required: [] },
    annotations: { title: 'Search inventory transfers', readOnlyHint: true }
  },
  {
    name: 'autotask_create_inventory_transfer',
    description: 'Move stock between locations (creates an InventoryTransfers record; mutates on-hand at both locations). Required: fromLocationID, toLocationID, productID, quantityTransferred. Optional: serialNumber (serialized), notes, transferByResourceID, transferDate. Inventory-movement — requires confirm:true.',
    inputSchema: { type: 'object', properties: { fromLocationID: { type: 'number' }, toLocationID: { type: 'number' }, productID: { type: 'number' }, quantityTransferred: { type: 'number' }, serialNumber: { type: 'string' }, notes: { type: 'string' }, transferByResourceID: { type: 'number' }, transferDate: { type: 'string' }, confirm: { type: 'boolean', description: 'Must be true to execute (inventory movement)' } }, required: ['fromLocationID', 'toLocationID', 'productID', 'quantityTransferred'] }
  },
  {
    name: 'autotask_add_inventory_stock',
    description: 'Add/receive stock — raise on-hand for an inventory product (InventoryStockedItemsAdd). Use to correct a phantom under-count or receive units. Required: inventoryProductID, quantityBeingAdded, vendorID, determineCostUsing. Optional: unitCost, serialNumber, vendorInvoiceNumber, reasonForUpdate. Inventory-movement — requires confirm:true.',
    inputSchema: { type: 'object', properties: { inventoryProductID: { type: 'number' }, quantityBeingAdded: { type: 'number' }, vendorID: { type: 'number' }, determineCostUsing: { type: 'number', description: 'Cost source (Autotask picklist)' }, unitCost: { type: 'number' }, serialNumber: { type: 'string' }, vendorInvoiceNumber: { type: 'string' }, reasonForUpdate: { type: 'string' }, confirm: { type: 'boolean', description: 'Must be true to execute (inventory movement)' } }, required: ['inventoryProductID', 'quantityBeingAdded', 'vendorID', 'determineCostUsing'] }
  },
  {
    name: 'autotask_remove_inventory_stock',
    description: '⚠ DESTRUCTIVE/HIGH-IMPACT: Remove stock — lower on-hand for an inventory product (InventoryStockedItemsRemove), a write-down that is not easily reversible. Use to correct a phantom over-count / write off dead stock. Required: quantityBeingRemoved, plus inventoryProductID (or a specific inventoryStockedItemID). Optional: reasonForUpdate. Requires confirm:true.',
    inputSchema: { type: 'object', properties: { inventoryProductID: { type: 'number' }, inventoryStockedItemID: { type: 'number' }, quantityBeingRemoved: { type: 'number' }, reasonForUpdate: { type: 'string' }, confirm: { type: 'boolean', description: 'Must be true to execute (destructive stock write-down)' } }, required: ['quantityBeingRemoved'] },
    annotations: { title: 'Remove inventory stock', destructiveHint: true }
  },
  {
    name: 'autotask_report_inventory_reorder',
    description: 'Inventory reorder-control report. Lists stocked products at or below their minimum (across all locations) with a suggested order quantity (up to max, net of on-order) and estimated cost. The monthly "what to order" report. Each line notes whether the location is a warehouse or a resource/tech-van.',
    inputSchema: {
      type: 'object',
      properties: {
        locationID: { type: 'number', description: 'Limit to one inventory location (omit for all)' },
        warehouseOnly: { type: 'boolean', description: 'Exclude resource/tech-van locations (default: false — all locations)' }
      },
      required: []
    },
    annotations: { title: 'Inventory reorder report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_inventory_closeouts',
    description: 'Inventory close-out report. Ticket charges marked to-order (Need to Order / On Order) whose product already has stock on hand — candidates to fulfill from stock and close out instead of ordering. Generic/catch-all products (no SKU, Misc/Equipment/etc.) are flagged because their stock counts are unreliable.',
    inputSchema: {
      type: 'object',
      properties: {
        includeGenerics: { type: 'boolean', description: 'Include generic/catch-all products, flagged (default: true)' }
      },
      required: []
    },
    annotations: { title: 'Inventory close-out report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_inventory_stale',
    description: 'Inventory stale/trending report. On-hand stock aged by receipt date with recent-movement counts, flagging dead stock (in stock longer than the stale threshold with no recent removals) and ranking by tied-up value. Each stale line carries an aging `bucket` (lt90 / d90_180 / d180_365 / d365plus, with per-bucket totals in `byBucket`) and a `classification`: "phantom" = never decremented in Autotask (no removal ever on record — likely a stock-count error to reconcile against physical) vs "dead-stock" = had movement but has stalled (genuine dead inventory). Summary includes phantomCount/phantomValue and deadStockCount/deadStockValue. The "is it selling, rotting on the shelf, or never really there" report.',
    inputSchema: {
      type: 'object',
      properties: {
        staleDays: { type: 'number', description: 'Days on hand before stock is considered stale (default: 180)', minimum: 1 },
        recentDays: { type: 'number', description: 'Window for counting recent movement (default: 180)', minimum: 1 }
      },
      required: []
    },
    annotations: { title: 'Inventory stale-stock report', readOnlyHint: true }
  },

  // Service tools
  {
    name: 'autotask_get_service',
    description: 'Get a specific service by ID',
    inputSchema: {
      type: 'object',
      properties: {
        serviceId: {
          type: 'number',
          description: 'The service ID to retrieve'
        }
      },
      required: ['serviceId']
    }
  },
  {
    name: 'autotask_search_services',
    description: 'Search for services with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for service name'
        },
        isActive: {
          type: 'boolean',
          
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },

  // Service Bundle tools
  {
    name: 'autotask_get_service_bundle',
    description: 'Get a specific service bundle by ID',
    inputSchema: {
      type: 'object',
      properties: {
        serviceBundleId: {
          type: 'number',
          description: 'The service bundle ID to retrieve'
        }
      },
      required: ['serviceBundleId']
    }
  },
  {
    name: 'autotask_search_service_bundles',
    description: 'Search for service bundles with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for service bundle name'
        },
        isActive: {
          type: 'boolean',
          
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },

  // Quote Item tools
  {
    name: 'autotask_get_quote_item',
    description: 'Get a specific quote item by ID',
    inputSchema: {
      type: 'object',
      properties: {
        quoteItemId: {
          type: 'number',
          description: 'The quote item ID to retrieve'
        }
      },
      required: ['quoteItemId']
    }
  },
  {
    name: 'autotask_search_quote_items',
    description: 'Search for quote items, typically filtered by quote ID',
    inputSchema: {
      type: 'object',
      properties: {
        quoteId: {
          type: 'number',
          description: 'Filter by quote ID (recommended)'
        },
        searchTerm: {
          type: 'string',
          description: 'Search term for quote item name'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 50, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_quote_item',
    description: 'Create a line item on a quote. Set exactly ONE item reference (serviceID, productID, or serviceBundleID). Required: quoteId, quantity. Defaults: unitDiscount=0, lineDiscount=0, percentageDiscount=0, isOptional=false.',
    inputSchema: {
      type: 'object',
      properties: {
        quoteId: {
          type: 'number',
          description: 'The quote ID to add this item to'
        },
        name: {
          type: 'string',
          description: 'Item name (auto-populated for service/product types)'
        },
        description: {
          type: 'string',
          description: 'Item description'
        },
        quantity: {
          type: 'number',
          description: 'Quantity of the item'
        },
        unitPrice: {
          type: 'number',
          description: 'Unit price for the item'
        },
        unitCost: {
          type: 'number',
          description: 'Unit cost for the item'
        },
        unitDiscount: {
          type: 'number',
          description: 'Per-unit discount amount (default: 0)'
        },
        lineDiscount: {
          type: 'number',
          description: 'Line-level discount amount (default: 0)'
        },
        percentageDiscount: {
          type: 'number',
          description: 'Percentage discount (default: 0)'
        },
        isOptional: {
          type: 'boolean',
          description: 'Whether this is an optional line item (default: false)'
        },
        serviceID: {
          type: 'number',
          description: 'Service ID to link (mutually exclusive with productID/serviceBundleID)'
        },
        productID: {
          type: 'number',
          description: 'Product ID to link (mutually exclusive with serviceID/serviceBundleID)'
        },
        serviceBundleID: {
          type: 'number',
          description: 'Service Bundle ID to link (mutually exclusive with serviceID/productID)'
        },
        sortOrderID: {
          type: 'number',
          description: 'Sort order for display'
        },
        quoteItemType: {
          type: 'number',
          description: 'Quote item type (auto-determined if omitted): 1=Product, 2=Cost, 3=Labor, 4=Expense, 6=Shipping, 11=Service, 12=ServiceBundle'
        }
      },
      required: ['quoteId', 'quantity']
    }
  },
  {
    name: 'autotask_update_quote_item',
    description: 'Update an existing quote item (quantity, price, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        quoteItemId: {
          type: 'number',
          description: 'The quote item ID to update'
        },
        quantity: {
          type: 'number',
          description: 'Updated quantity'
        },
        unitPrice: {
          type: 'number',
          description: 'Updated unit price'
        },
        unitDiscount: {
          type: 'number',
          description: 'Updated per-unit discount'
        },
        lineDiscount: {
          type: 'number',
          description: 'Updated line discount'
        },
        percentageDiscount: {
          type: 'number',
          description: 'Updated percentage discount'
        },
        isOptional: {
          type: 'boolean',
          description: 'Updated optional status'
        },
        sortOrderID: {
          type: 'number',
          description: 'Updated sort order'
        }
      },
      required: ['quoteItemId']
    }
  },
  {
    name: 'autotask_delete_quote_item',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a quote item ' +
      '(line item) from a quote. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete quote item (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        quoteId: {
          type: 'number',
          description: 'The parent quote ID'
        },
        quoteItemId: {
          type: 'number',
          description: 'The quote item ID to delete'
        }
      },
      required: ['quoteId', 'quoteItemId']
    }
  },

  // Configuration Item tools
  {
    name: 'autotask_search_configuration_items',
    description: 'Search configuration items (assets) with optional filters, including native contract/service entitlement links. Combine filters (e.g. contractID + isActive) to find the assets a recurring service covers. Returns full CI records — all entitlement fields (contractID, contractServiceID, serviceID, etc.) are included.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term matched against the CI reference title (name)'
        },
        serialNumber: {
          type: 'string',
          description: 'Exact serial number (case-insensitive) — matched against the serial number and the reference number (asset tag). Use it to find the asset behind a UPS / firewall / backup alert.'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company ID'
        },
        companyLocationID: {
          type: 'number',
          description: 'Filter by company location ID (the site the asset lives at)'
        },
        contractID: {
          type: 'number',
          description: 'Filter by the contract the asset is entitled through'
        },
        contractServiceID: {
          type: 'number',
          description: 'Filter by the specific contract service line the asset is covered by'
        },
        contractServiceBundleID: {
          type: 'number',
          description: 'Filter by the contract service bundle the asset is covered by'
        },
        serviceID: {
          type: 'number',
          description: 'Filter by the service the asset maps to'
        },
        serviceBundleID: {
          type: 'number',
          description: 'Filter by the service bundle the asset maps to'
        },
        parentConfigurationItemID: {
          type: 'number',
          description: 'Filter by parent CI — returns the child assets of a given configuration item'
        },
        isActive: {
          type: 'boolean',
          description: 'Filter by active state. Set true to exclude sunset/inactive assets from a maintenance run.'
        },
        productID: {
          type: 'number',
          description: 'Filter by product ID'
        },
        configurationItemType: {
          type: 'number',
          description: 'Filter by configuration item type (numeric picklist value)'
        },
        configurationItemCategoryID: {
          type: 'number',
          description: 'Filter by configuration item category ID'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_configuration_item',
    description: 'Create a configuration item (managed asset) for a company. Created through the Companies/{companyID}/ConfigurationItems child route because companyID is read-only on the entity: it is fixed at creation and a CI can never be moved between companies afterwards. productID is required by Autotask. Validates that a referenced contract or parent CI belongs to the same company, since Autotask does not, and a CI covered by another company contract reports false entitlement. Fields Autotask does not accept (the rmm*/ssl* audit surface it populates itself) are dropped with a warning rather than failing the write.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Company that owns this CI. Required, and permanent: companyID is read-only after creation.' },
        isActive: { type: 'boolean', description: 'Active state (default true). There is no separate lifecycle/status field on ConfigurationItems: isActive:false is how a CI is retired.' },
        productID: { type: 'number', description: 'Product this CI is an instance of' },
        companyLocationID: { type: 'number', description: 'Site/location the CI is installed at' },
        contactID: { type: 'number', description: 'Contact who owns or is custodian of this CI' },
        parentConfigurationItemID: { type: 'number', description: 'Parent CI, for child/component relationships. Must belong to the same company.' },
        vendorID: { type: 'number', description: 'Vendor company the CI was supplied by' },
        contractID: { type: 'number', description: 'Contract covering this CI. Must belong to the same company as the CI.' },
        contractServiceID: { type: 'number', description: 'Specific contract service line covering this CI' },
        contractServiceBundleID: { type: 'number', description: 'Contract service bundle covering this CI' },
        serviceID: { type: 'number', description: 'Service this CI is an instance of' },
        serviceBundleID: { type: 'number', description: 'Service bundle this CI belongs to' },
        serviceLevelAgreementID: { type: 'number', description: 'SLA picklist ID. Use autotask_get_field_info (ConfigurationItems, serviceLevelAgreementID) for valid values.' },
        configurationItemCategoryID: { type: 'number', description: 'CI category ID' },
        configurationItemType: { type: 'number', description: 'CI type picklist ID. Use autotask_get_field_info (ConfigurationItems, configurationItemType) for valid values.' },
        referenceNumber: { type: 'string', description: 'Reference number (asset tag)' },
        referenceTitle: { type: 'string', description: 'Reference title / friendly name' },
        serialNumber: { type: 'string', description: 'Serial number' },
        location: { type: 'string', description: 'Free-text location within the site (e.g. MDF rack 3)' },
        notes: { type: 'string', description: 'Notes' },
        installDate: { type: 'string', description: 'Install date (ISO 8601)' },
        warrantyExpirationDate: { type: 'string', description: 'Warranty expiration date (ISO 8601)' },
        numberOfUsers: { type: 'number', description: 'Number of users this CI serves' },
        dailyCost: { type: 'number', description: 'Daily cost' },
        hourlyCost: { type: 'number', description: 'Hourly cost' },
        monthlyCost: { type: 'number', description: 'Monthly cost' },
        perUseCost: { type: 'number', description: 'Per-use cost' },
        setupFee: { type: 'number', description: 'Setup fee' },
      },
      required: ['companyID', 'productID']
    }
  },
  {
    name: 'autotask_update_configuration_item',
    description: 'Update a configuration item: the same lifecycle surface as create, minus companyID, which Autotask will not let you change (a CI cannot be moved between companies; retire it with isActive:false and create a new one under the correct company). Use isActive:false to retire/deactivate and isActive:true to reactivate; there is no separate lifecycle/status field on ConfigurationItems. Use companyLocationID to move a CI between sites, parentConfigurationItemID to re-parent it, and the contract/service fields to change its coverage. Fields Autotask does not accept are dropped with a warning.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The configuration item to update' },
        isActive: { type: 'boolean', description: 'Set false to retire/deactivate the CI, true to reactivate it' },
        productID: { type: 'number', description: 'Product this CI is an instance of' },
        companyLocationID: { type: 'number', description: 'Site/location the CI is installed at' },
        contactID: { type: 'number', description: 'Contact who owns or is custodian of this CI' },
        parentConfigurationItemID: { type: 'number', description: 'Parent CI, for child/component relationships. Must belong to the same company.' },
        vendorID: { type: 'number', description: 'Vendor company the CI was supplied by' },
        contractID: { type: 'number', description: 'Contract covering this CI. Must belong to the same company as the CI.' },
        contractServiceID: { type: 'number', description: 'Specific contract service line covering this CI' },
        contractServiceBundleID: { type: 'number', description: 'Contract service bundle covering this CI' },
        serviceID: { type: 'number', description: 'Service this CI is an instance of' },
        serviceBundleID: { type: 'number', description: 'Service bundle this CI belongs to' },
        serviceLevelAgreementID: { type: 'number', description: 'SLA picklist ID. Use autotask_get_field_info (ConfigurationItems, serviceLevelAgreementID) for valid values.' },
        configurationItemCategoryID: { type: 'number', description: 'CI category ID' },
        configurationItemType: { type: 'number', description: 'CI type picklist ID. Use autotask_get_field_info (ConfigurationItems, configurationItemType) for valid values.' },
        referenceNumber: { type: 'string', description: 'Reference number (asset tag)' },
        referenceTitle: { type: 'string', description: 'Reference title / friendly name' },
        serialNumber: { type: 'string', description: 'Serial number' },
        location: { type: 'string', description: 'Free-text location within the site (e.g. MDF rack 3)' },
        notes: { type: 'string', description: 'Notes' },
        installDate: { type: 'string', description: 'Install date (ISO 8601)' },
        warrantyExpirationDate: { type: 'string', description: 'Warranty expiration date (ISO 8601)' },
        numberOfUsers: { type: 'number', description: 'Number of users this CI serves' },
        dailyCost: { type: 'number', description: 'Daily cost' },
        hourlyCost: { type: 'number', description: 'Hourly cost' },
        monthlyCost: { type: 'number', description: 'Monthly cost' },
        perUseCost: { type: 'number', description: 'Per-use cost' },
        setupFee: { type: 'number', description: 'Setup fee' },
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_get_configuration_item',
    description: 'Get a single configuration item (asset) by ID with all current details, including entitlement fields (companyID, companyLocationID, contractID, contractServiceID, serviceID, isActive, serialNumber, installDate, warrantyExpirationDate). Set enrichReferences=true to also resolve human-readable names for the linked company, contract, service, product, and parent CI.',
    inputSchema: {
      type: 'object',
      properties: {
        configurationItemId: {
          type: 'number',
          description: 'The configuration item (asset) ID to retrieve'
        },
        enrichReferences: {
          type: 'boolean',
          description: 'When true, resolve reference names (companyName, contractName, contractStatus, serviceName, contractServiceName, productName, parentConfigurationItemName) best-effort into an `_enriched` object. Adds extra read calls; default false.'
        }
      },
      required: ['configurationItemId']
    }
  },
  {
    name: 'autotask_get_configuration_item_entitlement',
    description: 'Determine whether a configuration item is entitled to recurring service, and why. Returns { isEntitled, reason, evidence }. Normalized reasons: ACTIVE_CI_ACTIVE_CONTRACT_SERVICE (entitled), ACTIVE_CI_NO_CONTRACT, CONTRACT_EXPIRED, CONTRACT_TERMINATED, CONTRACT_SERVICE_MISMATCH, SERVICE_NOT_MAPPED, CI_INACTIVE. Contract active/expired is judged by the tenant status label + endDate, not a hardcoded value.',
    inputSchema: {
      type: 'object',
      properties: {
        configurationItemId: { type: 'number', description: 'The configuration item (asset) ID to evaluate' }
      },
      required: ['configurationItemId']
    },
    annotations: { title: 'Get configuration item entitlement', readOnlyHint: true }
  },
  {
    name: 'autotask_search_configuration_item_coverage_gaps',
    description: 'List ACTIVE configuration items with no contract coverage (no contractID and no contractServiceID) — the uncovered assets for Sales / Account Management review. Scope to one company or the whole org. Coverage is computed in-memory because Autotask\'s null filters on CI foreign keys are unreliable.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Limit to one company (omit for the whole org)' },
        pageSize: { type: 'number', description: 'Max active CIs to scan (default 500, max 500)', minimum: 1, maximum: 500 }
      }
    },
    annotations: { title: 'Search configuration item coverage gaps', readOnlyHint: true }
  },
  {
    name: 'autotask_create_maintenance_ticket',
    description: 'High-level maintenance-ticket orchestrator. Validates company → contract (active/not-expired) → contract service → CI ownership/activity, checks externalID for an existing occurrence (idempotency — no duplicate), then creates the ticket, links additional CIs, applies a checklist library, and reads everything back. Set dryRun:true to validate and return the plan WITHOUT writing (recommended for pilot/manual-approval runs). The MCP does not own recurrence scheduling — the caller decides when an occurrence is due.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Company the ticket is for' },
        title: { type: 'string', description: 'Ticket title' },
        description: { type: 'string', description: 'Structured ticket description (whitespace preserved verbatim)' },
        configurationItemID: { type: 'number', description: 'Primary configuration item (asset). Validated for company ownership + active state.' },
        additionalConfigurationItemIDs: { type: 'array', items: { type: 'number' }, description: 'Additional CIs to link via TicketAdditionalConfigurationItems' },
        contractID: { type: 'number', description: 'Contract to deliver/bill under. Validated active + not expired.' },
        contractServiceID: { type: 'number', description: 'Contract service line. Validated to belong to contractID.' },
        companyLocationID: { type: 'number', description: 'Site/location for the ticket' },
        externalID: { type: 'string', description: 'Occurrence/idempotency key. If a ticket already exists with it, no duplicate is created (unless allowDuplicate).' },
        checklistLibraryID: { type: 'number', description: 'Checklist library to apply to the created ticket' },
        ticketFields: { type: 'object', description: 'Additional ticket fields to set (queueID, priority, status, ticketType, billingCodeID, dueDateTime, etc.)' },
        dryRun: { type: 'boolean', description: 'Validate only and return the plan without creating anything (default false)' },
        allowDuplicate: { type: 'boolean', description: 'Create even if a ticket with the externalID already exists (default false)' },
        requireEntitlement: { type: 'boolean', description: 'Require the primary CI to be entitled (ACTIVE_CI_ACTIVE_CONTRACT_SERVICE) before creating (default false)' }
      },
      required: ['companyID', 'title', 'description']
    }
  },

  // Contract tools
  {
    name: 'autotask_search_contracts',
    description: 'Search for contracts in Autotask with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for contract name'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company ID'
        },
        status: {
          type: 'number',
          description: 'Filter by contract status (1=In Effect, 3=Terminated)'
        },
        contractType: {
          type: 'number',
          description: 'Filter by contract type picklist ID'
        },
        endDateFrom: {
          type: 'string',
          description: 'Only contracts ending on or after this date (ISO YYYY-MM-DD)'
        },
        endDateTo: {
          type: 'string',
          description: 'Only contracts ending on or before this date (ISO YYYY-MM-DD)'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_contract',
    description: 'Get a single contract by ID (header fields only, no service lines)',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'Contract ID'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_list_expiring_contracts',
    description: 'List contracts whose end date falls within the next N days (expiring-contracts report). Optionally include already-expired contracts, and scope to one company or the whole org.',
    inputSchema: {
      type: 'object',
      properties: {
        daysAhead: {
          type: 'number',
          description: 'Look-ahead window in days (default: 60)',
          minimum: 0
        },
        companyID: {
          type: 'number',
          description: 'Limit the report to one company (omit for the whole org)'
        },
        includeExpired: {
          type: 'boolean',
          description: 'Also include contracts whose end date is already in the past (default: false)'
        },
        status: {
          type: 'number',
          description: 'Filter by contract status (1=In Effect, 3=Terminated)'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 100, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_report_block_hour_usage',
    description: 'Block-hour contract usage report. For block-hour contracts (monthly, use-it-or-lose-it), returns per-month allocated vs used hours with billable overage and forfeited (expired) hours, plus contract totals and the current month in progress. Scope to one contract, one company, or all active block-hour contracts (default).',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: {
          type: 'number',
          description: 'Report on a single block-hour contract'
        },
        companyID: {
          type: 'number',
          description: 'Limit to one company (omit for all active block-hour contracts)'
        },
        includeInactive: {
          type: 'boolean',
          description: 'Also include inactive/expired contracts (default: false — active only)'
        }
      },
      required: []
    },
    annotations: { title: 'Block-hour usage report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_ticket_charges',
    description: 'Ticket-charge report. Charges in a recent window with a fulfillment-status breakdown, billed vs unbilled counts, total billable amount, and a per-ticket rollup. Set unbilledOnly to surface the to-bill queue (charges not yet billed). Optional company/status/date-window filters.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceDays: { type: 'number', description: 'Look-back window in days (default: 90)', minimum: 1 },
        unbilledOnly: { type: 'boolean', description: 'Only charges not yet billed — the to-bill queue (default: false)' },
        status: { type: 'number', description: 'Filter by fulfillment status (1=Pending, 3=Need to Order, 4=On Order, 6=Ready to Ship, 7=Delivered, 8=Canceled)' },
        companyID: { type: 'number', description: 'Limit to one company (omit for all)' }
      },
      required: []
    },
    annotations: { title: 'Ticket-charge report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_unbilled',
    description: 'Unbilled-work / revenue-leakage report. Billable work that has been posted but not yet invoiced (uninvoiced billing items — time and charges), aged into 0-30 / 31-60 / 61-90 / 90+ day buckets with an at-risk (>30 days) total and a per-company rollup. Catches billable time and charges that age out unbilled because only recent items get reviewed. Optional company filter and minimum age.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Limit to one company (omit for all)' },
        minAgeDays: { type: 'number', description: 'Only items at least this many days old (e.g. 30 for the at-risk backlog)', minimum: 0 }
      },
      required: []
    },
    annotations: { title: 'Unbilled-work report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_unbilled_time',
    description: 'Unbilled-TIME leakage — the pre-invoice stage. Billable time entries that have NOT been approved for billing yet (billingApprovalDateTime not set), so they cannot reach an invoice until someone approves them. Per resource, aged by dateWorked (0-30/31-60/61-90/90+), with an at-risk (>30d) total, an estimated $ value (billable hours × the role\'s bill rate; hours with no resolvable rate are surfaced separately, never counted as $0), and the average write-up lag (createDateTime − dateWorked). Also splits the time by the contract\'s labour-billing basis (byContractBasis) so you can tell a real leak from work absorbed by design: no_contract (company has NO contract — billable-until-proven-otherwise, surfaced NOT filtered), billed (T&M/Per-Ticket), block (draws a prepaid block, overage billable), unknown, vs. absorbed (Fixed/Retainer/Recurring) and umbrella. totals.needsReviewHours = no_contract + billed + block + unknown (excludes absorbed/umbrella). Complements autotask_report_unbilled (which covers posted-but-not-invoiced billing items) — together they cover logged → approved → posted → invoiced. Read-only. NOTE: this does NOT find hours never logged at all (calendar/Teams work with no time entry) — that is the reconstruction side (get_time_entry_targets).',
    inputSchema: {
      type: 'object',
      properties: {
        fromDate: { type: 'string', description: 'dateWorked on/after (YYYY-MM-DD). Default: last 365 days (guardrail against a full-history scan) — pass an earlier date to widen.' },
        toDate: { type: 'string', description: 'dateWorked on/before (YYYY-MM-DD).' },
        resourceID: { type: 'number', description: 'Limit to one resource (tech).' },
        includeApproved: { type: 'boolean', description: 'Also include already-approved billable time (default false — only the unapproved pre-invoice backlog).' }
      },
      required: []
    },
    annotations: { title: 'Unbilled time (pre-invoice)', readOnlyHint: true }
  },
  {
    name: 'autotask_report_sla_compliance',
    description: "SLA compliance report (read-only). Classifies each ticket's three SLA stages — Triage/First-Response, Tech-Engagement/Resolution-Plan, Resolved — as met (actual ≤ due) / missed (actual > due) / pending (open, due in future) / breached (open, due passed) / no_target (no SLA due set). Returns per-stage counts + compliance % (met ÷ closed), a breach queue (open+overdue, worst first) for 'what needs attention now', and optional grouping. Scope by createDate window (default last 30 days) + optional company/queue; group by queue, resource, company, week, or month. For n8n/chat dashboards.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Tickets created on/after (YYYY-MM-DD); default 30 days ago' },
        to: { type: 'string', description: 'Tickets created on/before (YYYY-MM-DD)' },
        companyID: { type: 'number', description: 'Limit to one company' },
        queueID: { type: 'number', description: 'Limit to one queue' },
        openOnly: { type: 'boolean', description: 'Only non-complete tickets (default false)' },
        groupBy: { type: 'string', enum: ['queue', 'resource', 'company', 'week', 'month'], description: 'Break the report down by this dimension' },
        maxTickets: { type: 'number', description: 'Cap on tickets evaluated (default 2000, max 10000)', minimum: 1, maximum: 10000 }
      },
      required: []
    },
    annotations: { title: 'SLA compliance report', readOnlyHint: true }
  },
  {
    name: 'autotask_generate_sla_framework',
    description: "ITIL SLA setup helper (advisory, deterministic, no Autotask writes). Generates the standardized SLA build to ENTER IN THE AUTOTASK UI, because SLA and priority definitions are UI-only (no REST entity for ServiceLevelAgreements; the priority picklist is not API-writable). Output: (1) an Impact × Urgency → Priority matrix (decision guidance — Autotask has no impact/urgency field); (2) a clean P1–P4 (or P5) priority scheme with names/descriptions to replace a drifted picklist; (3) an SLA target matrix — first-response / resolution-plan / resolution per priority × request type (Incident vs Service Request) × customer tier, with 24x7-vs-8x5 coverage; (4) UI steps and caveats. Optionally pass your CURRENT priority values to get a classified migration map (severity → Pn, response-time → SLA, work-type → queue, planned → Change). All numbers are ITIL-typical starting templates — tune via overrides. Pairs with autotask_report_sla_compliance, which measures met/missed once the SLAs are entered and assigned.",
    inputSchema: {
      type: 'object',
      properties: {
        levels: { type: 'number', enum: [4, 5], description: 'Priority levels: 4 (P1–P4, default) or 5 (adds P5 Planning lane)' },
        requestTypes: { type: 'array', items: { type: 'string', enum: ['Incident', 'ServiceRequest'] }, description: 'Request types to generate targets for (default both)' },
        tiers: {
          type: 'array',
          description: 'Customer tiers. Each: { name, multiplier, coverage? }. multiplier scales all target durations (>1 = looser); coverage overrides the level default. Omit for a single Standard tier (×1).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              multiplier: { type: 'number', description: 'Duration multiplier (e.g. 1 premier, 1.5 standard, 2 break-fix)', exclusiveMinimum: 0 },
              coverage: { type: 'string', enum: ['24x7', '8x5'], description: 'Force this tier\'s coverage regardless of priority default' }
            },
            required: ['name', 'multiplier']
          }
        },
        currentPriorities: { type: 'array', items: { type: 'string' }, description: 'Your existing (possibly messy) priority picklist values, to classify and map to the clean scheme' },
        businessHoursPerDay: { type: 'number', description: 'Business hours per working day for business-day math (default 8)', exclusiveMinimum: 0 },
        serviceRequestResolutionMultiplier: { type: 'number', description: 'How much looser Service Request plan/resolution is vs Incident at the same priority (default 2)', exclusiveMinimum: 0 },
        overrides: {
          type: 'object',
          description: 'Override default targets per priority code (P1..P5). Each value: { firstResponse?, resolutionPlan?, resolution? } in MINUTES, and/or { coverage }.',
          additionalProperties: {
            type: 'object',
            properties: {
              firstResponse: { type: 'number', description: 'Minutes' },
              resolutionPlan: { type: 'number', description: 'Minutes' },
              resolution: { type: 'number', description: 'Minutes' },
              coverage: { type: 'string', enum: ['24x7', '8x5'] }
            }
          }
        }
      },
      required: []
    },
    annotations: { title: 'Generate ITIL SLA framework', readOnlyHint: true }
  },
  {
    name: 'autotask_report_sla_coverage',
    description: "SLA coverage / readiness check (read-only, #102). Reports which contracts have NO SLA linked (Contracts.serviceLevelAgreementID empty) and whether any SLA definitions exist at all — the empty serviceLevelAgreementID picklist is the root of a 'no SLAs anywhere' tenant. Returns: the available SLA definitions (picklist values), counts of linked vs unlinked, the unlinked contract list (id, name, company, type, status, endDate), and a readiness verdict (no_sla_definitions | unlinked_contracts | all_linked). Active-status detection is derived from the status picklist labels; scope by company or explicit status, or activeOnly:false for every status. Pairs with autotask_generate_sla_framework (make the spec) and autotask_assign_contract_sla (link them).",
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Limit to one company' },
        status: { type: 'number', description: 'Limit to one contract status value (overrides activeOnly)' },
        activeOnly: { type: 'boolean', description: 'Only active-status contracts (default true; active values derived from the status picklist labels)' },
        maxContracts: { type: 'number', description: 'Cap on contracts evaluated (default 2000, max 10000)', minimum: 1, maximum: 10000 }
      },
      required: []
    },
    annotations: { title: 'SLA coverage report', readOnlyHint: true }
  },
  {
    name: 'autotask_assign_contract_sla',
    description: "Bulk-assign an SLA to contracts (#102). SAFE BY DEFAULT: unless you pass dryRun:false, NOTHING is written — it returns the planned assignments for review. serviceLevelAgreementID IS API-writable (unlike SLA definitions, which are UI-only), so this links existing SLAs to contracts. FAILS CLOSED if the tenant has no SLA definitions yet, or if a serviceLevelAgreementID isn't a valid active picklist value (returns the valid values). Skips no-ops (already set) and reports contracts not found. Give either assignments:[{contractID, serviceLevelAgreementID}] or the shorthand serviceLevelAgreementID + contractIDs:[...]. Returns the shared write-plan envelope (status: dry_run | validation_failed | assigned | assigned_with_errors). Reversible — it only sets a picklist link. Use autotask_report_sla_coverage to find the unlinked contracts and autotask_get_field_info('Contracts','serviceLevelAgreementID') to see valid SLA values.",
    inputSchema: {
      type: 'object',
      properties: {
        assignments: {
          type: 'array',
          description: 'Explicit per-contract assignments. Each: { contractID, serviceLevelAgreementID }.',
          items: {
            type: 'object',
            properties: {
              contractID: { type: 'number' },
              serviceLevelAgreementID: { type: ['number', 'string'], description: 'A valid active value from the Contracts.serviceLevelAgreementID picklist' }
            },
            required: ['contractID', 'serviceLevelAgreementID']
          }
        },
        serviceLevelAgreementID: { type: ['number', 'string'], description: 'Shorthand: assign this one SLA to every id in contractIDs' },
        contractIDs: { type: 'array', items: { type: 'number' }, description: 'Shorthand: contracts to assign serviceLevelAgreementID to' },
        dryRun: { type: 'boolean', description: 'Default true — plan only, no writes. Pass false to apply.' }
      },
      required: []
    },
    annotations: { title: 'Assign SLA to contracts', readOnlyHint: false }
  },
  {
    name: 'autotask_report_time_entry_compliance',
    description: "Time-entry compliance / team hours (read-only, #100). Answers 'is the team doing real-time time entry, and are the hours there?' from TimeEntries. Per resource × week (or month): hours logged vs EXPECTED (utilization % and billable utilization %), billable vs non-billable split (non-billable is still paid time), APPROVED vs UNAPPROVED hours (billingApprovalDateTime — the timesheet check-and-balance; unapproved can't be billed/applied to contracts), and LATE entries (createDateTime logged > lateThresholdDays after dateWorked — the real-time-discipline signal). Flags resources: no_time, under_logged, low_billable_utilization, chronic_late_entry. Returns per-resource per-bucket rows + totals + overall + a data-quality block. Scope by dateWorked window (default last 4 weeks) + optional resource. For n8n/chat dashboards; no scheduling/notification here.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Work done on/after (YYYY-MM-DD); default 28 days ago' },
        to: { type: 'string', description: 'Work done on/before (YYYY-MM-DD); default today' },
        bucket: { type: 'string', enum: ['week', 'month'], description: 'Aggregation bucket (default week)' },
        resourceID: { type: 'number', description: 'Limit to one resource' },
        expectedHoursPerBucket: { type: 'number', description: 'Expected loggable hours per bucket (overrides expectedHoursPerWeek)', exclusiveMinimum: 0 },
        expectedHoursPerWeek: { type: 'number', description: 'Expected hours per week (default 40); month expected derived from this', exclusiveMinimum: 0 },
        lateThresholdDays: { type: 'number', description: 'Entries created more than this many days after the day worked count as late (default 2)', minimum: 0 },
        maxEntries: { type: 'number', description: 'Cap on time entries evaluated (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'Time-entry compliance report', readOnlyHint: true }
  },
  {
    name: 'autotask_search_notification_history',
    description: "Notification history (read-only): the e-mails Autotask actually SENT — ticket/time-entry notifications, workflow-rule e-mails, quote notes, surveys — and to whom. Use it to verify \"was the customer told?\" after a ticket update, time entry or close. Rows are grouped into SENDS (Autotask stores one row per recipient): each send has sentAt, type, template, who initiated it (a tech, a contact, or Autotask for workflow/system e-mails), the subject (ticket/time entry/task/project + number/title), the recipient list, and toExternal (true when anyone outside your own e-mail domain(s) received it). Newest first, paged by send. Scope with ticketID / timeEntryID / taskID / projectID / initiatingResourceID / recipientEmail / templateName, or a from+to window of at most 31 days. NOTE: the Autotask API cannot SEND notifications — this only reads what was sent; ticket-close e-mails belong in an Autotask workflow rule (they fire on API edits too).",
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'E-mails about this ticket' },
        timeEntryID: { type: 'number', description: 'E-mails sent from this time entry' },
        taskID: { type: 'number', description: 'E-mails about this project task' },
        projectID: { type: 'number', description: 'E-mails about this project' },
        initiatingResourceID: { type: 'number', description: 'E-mails triggered by this tech' },
        recipientEmail: { type: 'string', description: 'Recipient address contains this (e.g. a customer domain)' },
        templateName: { type: 'string', description: 'Template name contains this (e.g. "Ticket Ready to Bill")' },
        from: { type: 'string', description: 'Sent on/after (YYYY-MM-DD or ISO)' },
        to: { type: 'string', description: 'Sent on/before (YYYY-MM-DD inclusive, or ISO)' },
        page: { type: 'number', minimum: 1, description: 'Page of SENDS (default 1)' },
        pageSize: { type: 'number', minimum: 1, maximum: 200, description: 'Sends per page (default 25, max 200)' }
      },
      required: []
    },
    annotations: { title: 'Search notification history', readOnlyHint: true }
  },
  {
    name: 'autotask_report_activity_without_time',
    description: "Activity without time — the Autotask side of a billable-time leakage audit (read-only). For each tech × day, lists TICKETS where Autotask shows evidence of their work but they logged NO time on that ticket that day. Evidence is graded: HIGH = a substantive note they wrote; MEDIUM = a ticket they completed; bare 'Closed' / 'Closed - <reason>' resolution notes and notification e-mails they sent are attached as supporting context but never create a gap on their own. Time on the same ticket within toleranceDays (default 1) either side counts as covered. Excluded by default and counted under 'excluded': internal-company tickets, monitoring alerts, mail-loop junk (auto-replies/bounces), and backlog cleanup (an old ticket closed with no substantive note). Each gap carries ticket number/title/company, the evidence lines, the tech's time on that ticket on other days, and an Open-in-Autotask link — a lead to confirm (then backfill with autotask_create_time_entry), not proof. Days are the tech's local days. Window default: last 7 days, max 31. External evidence (Teams, email, meetings, phone) is not read here — correlate it separately.",
    inputSchema: {
      type: 'object',
      properties: {
        resourceID: { type: 'number', description: 'The tech to audit (or use resourceIDs)' },
        resourceIDs: { type: 'array', items: { type: 'number' }, maxItems: 10, description: 'Up to 10 techs to audit' },
        from: { type: 'string', description: 'First local day (YYYY-MM-DD); default 6 days before `to`' },
        to: { type: 'string', description: 'Last local day (YYYY-MM-DD); default today' },
        timeZone: { type: 'string', description: 'IANA timezone for day boundaries; default each tech\'s location timezone' },
        toleranceDays: { type: 'number', minimum: 0, maximum: 7, description: 'Time on the ticket this many days either side counts as covered (default 1)' },
        minConfidence: { type: 'string', enum: ['high', 'medium'], description: 'Report only high, or high + medium (default)' },
        includeMonitoring: { type: 'boolean', description: 'Also flag completed monitoring-alert tickets (default false)' },
        includeInternal: { type: 'boolean', description: 'Also flag tickets on your own (internal) company — not client-billable (default false)' },
        staleDays: { type: 'number', minimum: 1, description: 'A ticket at least this many days old, closed with no substantive note, counts as backlog cleanup, not a gap (default 30)' }
      },
      required: []
    },
    annotations: { title: 'Activity without time report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_tickets_needing_scheduling',
    description: "Tickets needing scheduling (read-only, #100). Open tickets that should be on the calendar but aren't — extends the service-call reconciliation in report_service_call_leakage (that fixes leakage on tickets that HAD a service call; this catches the ones that never got one). Classifies each candidate as unscheduled (no service call linked), past_service_call (only stale/past calls — likely needs rescheduling), or scheduled (a future service call; excluded from the list, still counted). By default limits to open tickets with hoursToBeScheduled > 0 (the native 'hours remain to schedule' signal); pass requireHoursToSchedule:false to consider every open ticket, or ticketType to scope to install/project types. Returns the needs-scheduling list (worst backlog first — most hours, then oldest) with age + due date, counts, total hours to schedule, and optional grouping. For n8n/chat dashboards.",
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Limit to one company' },
        queueID: { type: 'number', description: 'Limit to one queue' },
        ticketType: { type: 'number', description: 'Limit to one ticket type (e.g. install/project)' },
        requireHoursToSchedule: { type: 'boolean', description: 'Only tickets with hoursToBeScheduled > 0 (default true); false = every open ticket' },
        groupBy: { type: 'string', enum: ['queue', 'company', 'resource'], description: 'Summarize the backlog by this dimension' },
        maxTickets: { type: 'number', description: 'Cap on tickets evaluated (default 2000, max 10000)', minimum: 1, maximum: 10000 }
      },
      required: []
    },
    annotations: { title: 'Tickets needing scheduling', readOnlyHint: true }
  },
  {
    name: 'autotask_report_ticket_throughput',
    description: "Ticket throughput / work-queue KPIs (read-only, #100). Two views: FLOW over a window — created vs completed vs completion ratio + net backlog change (is the team keeping up with intake?); and the current BACKLOG snapshot — open tickets by age bucket (default 0-7 / 8-30 / 31-90 / 90+ days), by status (raw value + resolved label; open/waiting/on-hold splits stay tenant-specific), and oldest-open. Optional grouping by queue/resource/company gives per-team throughput (open + created + completed + ratio). Scope by createDate/completedDate window (default last 30 days) + optional company/queue. For n8n/chat dashboards.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Window start (YYYY-MM-DD); bounds created & completed. Default 30 days ago' },
        to: { type: 'string', description: 'Window end (YYYY-MM-DD); default today' },
        companyID: { type: 'number', description: 'Limit to one company' },
        queueID: { type: 'number', description: 'Limit to one queue' },
        agingThresholds: { type: 'array', items: { type: 'number' }, description: 'Ascending day thresholds for backlog age buckets (default [7,30,90])' },
        groupBy: { type: 'string', enum: ['queue', 'resource', 'company'], description: 'Per-team throughput breakdown' },
        maxTickets: { type: 'number', description: 'Cap per query — created/completed/open each (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'Ticket throughput / work-queue KPIs', readOnlyHint: true }
  },
  {
    name: 'autotask_report_request_segmentation',
    description: "Request segmentation dimension (read-only, #100). The 'what kind of work is this?' lens: split tickets into delivery segments — project / install / recurring (managed) / support (reactive), or any scheme you define — and report per-segment KPIs (volume, open backlog, completed, avg open age, share %). Segment RULES are caller-provided because queues/types are tenant-specific: each rule matches when EVERY criterion it lists is satisfied (OR within each value set), first match wins. With NO rules it falls back to the universal ITIL classification by ticketType (Service Request / Incident / Problem / Change / Alert). Scope by createDate window (default 90 days) or openOnly for the current backlog, + optional company/queue. For n8n/chat dashboards and for reading the other #100 reports through a work-type lens.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Created on/after (YYYY-MM-DD); default 90 days ago (ignored when openOnly)' },
        to: { type: 'string', description: 'Created on/before (YYYY-MM-DD); default today (ignored when openOnly)' },
        openOnly: { type: 'boolean', description: 'Segment the current open backlog instead of a created-date window' },
        companyID: { type: 'number', description: 'Limit to one company' },
        queueID: { type: 'number', description: 'Limit to one queue' },
        segments: {
          type: 'array',
          description: 'Ordered segment rules (first match wins). Each rule matches when every criterion it specifies is satisfied.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              ticketType: { type: 'array', items: { type: 'number' }, description: '1=Service Request 2=Incident 3=Problem 4=Change 5=Alert' },
              queueID: { type: 'array', items: { type: 'number' } },
              priority: { type: 'array', items: { type: 'number' } },
              issueType: { type: 'array', items: { type: 'number' } },
              titleContains: { type: 'array', items: { type: 'string' }, description: 'Case-insensitive title substrings (any match)' }
            },
            required: ['name']
          }
        },
        defaultSegmentName: { type: 'string', description: 'Name for tickets matching no rule (default "Unsegmented", or "Other" for the ITIL fallback)' },
        maxTickets: { type: 'number', description: 'Cap on tickets evaluated (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'Request segmentation', readOnlyHint: true }
  },
  {
    name: 'autotask_report_project_pl',
    description: "Profitability (P&L) for a project, task, or ticket, bucketed by week or month — real burden cost vs realized revenue, not assumed margins. COST = every time entry's hoursWorked × the resource's burden (Resources.internalCost), billable or not, posted or not — because paid time is a cost the moment it's worked (non-billable hours drag margin). REVENUE = totalAmount of POSTED billing items only (realized). Also reports pendingBillableHours (approved/posted lag = revenue-in-waiting) and a costCoverage flag (hours whose resource has NO burden set → cost understated; also the HR to-fix list). Give exactly one of projectID / taskId / ticketId. Read-only; for review (n8n/chat).",
    inputSchema: {
      type: 'object',
      properties: {
        projectID: { type: 'number', description: 'Report P&L for this project (rolls up its tasks’ time + project billing items)' },
        taskId: { type: 'number', description: 'Report P&L for a single task' },
        ticketId: { type: 'number', description: 'Report P&L for a single ticket' },
        bucket: { type: 'string', enum: ['week', 'month'], description: 'Time bucket (default month)' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD) — bounds time entries + billing items' },
        to: { type: 'string', description: 'End date (YYYY-MM-DD)' }
      },
      required: []
    },
    annotations: { title: 'Project / task / ticket P&L', readOnlyHint: true }
  },

  // Invoice tools
  {
    name: 'autotask_search_invoices',
    description: "Search Autotask invoices (the Invoice Batch screen). Returns the QuickBooks-sync markers a billing-gap check needs: invoiceNumber (blank = never synced to QuickBooks), batchID, invoiceDateTime, invoiceTotal, isVoided + voidedDate, paidDate, webServiceDate (QuickBooks Online sync), orderNumber (free-text PO), dueDate, fromDate/toDate (billing period), invoiceStatus, comments. Missing values come back null (never coerced to 0/false) — treat null as 'unknown'. Use unsyncedOnly (typically with isVoided:false) to find invoices Autotask billed but QuickBooks never received. For the work an invoice covers, call autotask_get_invoice_details (returns linkedTicketIDs/ProjectIDs/TaskIDs).",
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Filter by company ID' },
        invoiceNumber: { type: 'string', description: 'Filter by invoice number' },
        isVoided: { type: 'boolean', description: 'Filter by voided status (voids legitimately have no invoiceNumber)' },
        batchID: { type: 'number', description: 'Filter to one invoice batch' },
        unsyncedOnly: { type: 'boolean', description: 'Only invoices with a blank invoiceNumber (never synced to QuickBooks). Pair with isVoided:false to exclude voids.' },
        fromDate: { type: 'string', description: 'invoiceDateTime on/after (YYYY-MM-DD) — how long it has been sitting' },
        toDate: { type: 'string', description: 'invoiceDateTime on/before (YYYY-MM-DD)' },
        pageSize: { type: 'number', description: 'Number of results to return (default: 25, max: 500)', minimum: 1, maximum: 500 }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_invoice_details',
    description: "Get a single Autotask invoice with its full field set (sync/paid/void markers, billing period, totals) plus its line items (BillingItems posted to it) and the WORK it billed: linkedTicketIDs, linkedProjectIDs, linkedTaskIDs (distinct, derived from the line items) — so an unsynced-invoice finding can name the job, not just a dollar value. Missing values are null, not 0/false.",
    inputSchema: {
      type: 'object',
      properties: {
        invoiceId: {
          type: 'number',
          description: 'The invoice ID to fetch'
        }
      },
      required: ['invoiceId']
    }
  },

  // Task tools
  {
    name: 'autotask_search_tasks',
    description: 'Search for tasks in Autotask. Returns 25 results per page by default. Use page parameter for more results.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for task title'
        },
        projectID: {
          type: 'number',
          description: 'Filter by project ID'
        },
        status: {
          type: 'number',
          description: 'Filter by task status (1=New, 2=In Progress, 5=Complete)'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Filter by assigned resource ID'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_task',
    description: 'Create a new task in Autotask',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: {
          type: 'number',
          description: 'Project ID for the task'
        },
        title: {
          type: 'string',
          description: 'Task title'
        },
        description: {
          type: 'string',
          description: 'Task description'
        },
        phaseID: {
          type: 'number',
          description: 'Phase to associate the task with (for phased project structure)'
        },
        status: {
          type: 'number',
          description: 'Task status ID. Resolve valid values from tenant metadata via autotask_get_field_info(Tasks) — do not assume constants.'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Assigned resource ID'
        },
        assignedResourceRoleID: {
          type: 'number',
          description: 'Role for the assigned resource'
        },
        departmentID: {
          type: 'number',
          description: 'Department ID'
        },
        billingCodeID: {
          type: 'number',
          description: 'Work type / billing code ID'
        },
        estimatedHours: {
          type: 'number',
          description: 'Estimated hours for the task'
        },
        taskType: {
          type: 'number',
          description: 'Task type (1=FixedWork, 2=FixedDuration). Defaults to 1.'
        },
        startDateTime: {
          type: 'string',
          description: 'Task start date/time (ISO format)'
        },
        endDateTime: {
          type: 'string',
          description: 'Task end date/time (ISO format)'
        }
      },
      required: ['projectID', 'title', 'status']
    }
  },
  {
    name: 'autotask_get_task',
    description: 'Get a single project task by ID with its full fields (projectID, phaseID, status, taskType, dates, estimatedHours, assigned resource + role, department, billing code, etc.).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Task ID' } },
      required: ['id']
    },
    annotations: { title: 'Get task', readOnlyHint: true }
  },
  {
    name: 'autotask_get_task_by_number',
    description: 'Look up a project task by its human-facing task number (e.g. "T20260922.0189") and return the FULL task object in one call. Exact match on taskNumber. Returns { status: "found" | "not-found" | "ambiguous", task, matches }. Use this when you have the task number (from a URL, a meeting title, or the user) — it saves a resolve+get round trip and returns every task field (projectID, phaseID, status, assigned resource + role, dates, remainingHours, completedDateTime, etc.). For fuzzy title search use autotask_search_tasks; when the number could be a ticket OR a task use autotask_resolve_record_reference.',
    inputSchema: {
      type: 'object',
      properties: { taskNumber: { type: 'string', description: 'Human-facing task number, e.g. "T20260922.0189"' } },
      required: ['taskNumber']
    },
    annotations: { title: 'Get task by number', readOnlyHint: true }
  },
  {
    name: 'autotask_update_task',
    description: 'Update a project task. projectID is required (task update is a child-route PATCH). Only provided fields are changed. Supports moving between phases via phaseID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Task ID' },
        projectID: { type: 'number', description: 'Project the task belongs to (required)' },
        phaseID: { type: 'number' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'number', description: 'Resolve via autotask_get_field_info(Tasks)' },
        assignedResourceID: { type: 'number' },
        assignedResourceRoleID: { type: 'number' },
        departmentID: { type: 'number' },
        billingCodeID: { type: 'number' },
        estimatedHours: { type: 'number' },
        startDateTime: { type: 'string' },
        endDateTime: { type: 'string' }
      },
      required: ['id', 'projectID']
    }
  },
  {
    name: 'autotask_complete_task',
    description: 'Mark a task complete. Sets the tenant\'s "Complete" status (resolved from metadata, not hard-coded) and completedDateTime. projectID is looked up from the task if not supplied.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Task ID' },
        projectID: { type: 'number', description: 'Optional — looked up from the task if omitted' },
        statusId: { type: 'number', description: 'Optional explicit complete-status id (overrides metadata resolution)' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_delete_task',
    description: 'Inspect a project task for deletion. NOTE: Autotask does NOT allow deleting a project task via the REST API (Tasks canDelete=false) — tasks are deleted in the UI only. This tool therefore inventories the task (time entries, notes, attachments, secondary resources, dependencies) and returns status "ui_delete_required" with clear guidance; it never attempts an (impossible) API delete. To clear the API-deletable time entries first, use autotask_delete_task_with_time, then delete the task in the UI (its notes & dependencies cascade). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Task ID to inspect.' },
        projectID: { type: 'number', description: 'Optional — looked up from the task if omitted.' }
      },
      required: ['id']
    },
    annotations: { title: 'Delete task (inspect / UI-required)', readOnlyHint: true }
  },
  {
    name: 'autotask_delete_task_with_time',
    description: '⚠ DESTRUCTIVE — IRREVERSIBLE. Obsolete-task cleanup: deletes its TIME ENTRIES (each as its owner via impersonation), optionally removes secondary resources, then you delete the task itself in the UI (the API cannot delete tasks). Dry-run first (default); execute with dryRun:false AND confirm:true. Locks beyond billing-post (submitted timesheet / owner delete-permission) surface at execution — not pre-detectable. Returns "time_cleared" or "partial".',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'Task ID.' },
        projectID: { type: 'number', description: 'Optional.' },
        dryRun: { type: 'boolean', description: 'Default TRUE; false+confirm to run.' },
        allowApproved: { type: 'boolean', description: 'Attempt posted entries.' },
        removeSecondaryResources: { type: 'boolean', description: 'Also remove crew rows.' }
      },
      required: ['taskId']
    },
    annotations: { title: 'Delete task time + UI handoff', readOnlyHint: false, destructiveHint: true }
  },
  {
    name: 'autotask_verify_task_time_entries',
    description: 'Read-only check of the time entries logged against a project TASK on a given day. With expectedResourceIDs, reports how many of the expected resources have an entry (found/expected), which are missing, and which have more than one entry (duplicate). Without it, summarizes all entries on the task that day. Use this to gate a meeting-task closeout on "everyone\'s time is in".',
    inputSchema: {
      type: 'object',
      properties: {
        taskID: { type: 'number', description: 'The project task to check.' },
        dateWorked: { type: 'string', description: 'Day to check (YYYY-MM-DD).' },
        expectedResourceIDs: { type: 'array', items: { type: 'number' }, description: 'Resource IDs expected to have logged time (the meeting attendees). Omit to just list what is there.' }
      },
      required: ['taskID', 'dateWorked']
    },
    annotations: { title: 'Verify task time entries', readOnlyHint: true }
  },
  {
    name: 'autotask_close_meeting_task',
    description: 'Finalize a meeting/closeout TASK safely — verify the downstream work, then mark the task complete. Does NOT create tickets itself; the caller supplies the verified outputs. DRY-RUN FIRST: without dryRun:false it reports what it would do and every blocker, changing nothing; re-run with dryRun:false to act. REFUSES to close (status "blocked") when: requireTimeEntries is set and any expectedResourceIDs lack an entry that day; a duplicate time entry is detected; requireCloseoutNote is set and no closeoutNote is given; or any relatedTicketIDs cannot be found. An already-complete task is recognized safely (status "already_complete", no-op) so re-runs are safe. When it acts it optionally writes a closeout note to the task (idempotent) and completes it, then reads it back.',
    inputSchema: {
      type: 'object',
      properties: {
        taskID: { type: 'number', description: 'The meeting/closeout task to finalize.' },
        projectID: { type: 'number', description: 'Optional — looked up from the task if omitted (needed for the completion PATCH).' },
        dryRun: { type: 'boolean', description: 'Default TRUE — report the plan + blockers without changing anything. Set false to write the note and complete the task.' },
        dateWorked: { type: 'string', description: 'Day the time entries should exist on (YYYY-MM-DD). Required with expectedResourceIDs for the time-entry gate.' },
        expectedResourceIDs: { type: 'array', items: { type: 'number' }, description: 'Attendee resource IDs that must have logged time (the closeout gate).' },
        requireTimeEntries: { type: 'boolean', description: 'When true, refuse to close if any expected resource is missing an entry.' },
        relatedTicketIDs: { type: 'array', items: { type: 'number' }, description: 'Follow-up ticket IDs that must exist; missing ones block the close.' },
        closeoutNote: { type: 'string', description: 'Closeout note body to write to the task before completing (referencing time posted, tickets touched/created, deferred items).' },
        closeoutNoteTitle: { type: 'string', description: 'Optional title for the closeout note (default "Meeting Closeout").' },
        closeoutNoteType: { type: 'number', description: 'Optional TaskNotes noteType picklist id (tenant-specific — see autotask_get_field_info).' },
        closeoutNotePublish: { type: 'number', description: 'Optional TaskNotes publish/visibility picklist id (tenant-specific; controls client visibility).' },
        requireCloseoutNote: { type: 'boolean', description: 'When true, refuse to close unless a closeoutNote is supplied.' }
      },
      required: ['taskID']
    },
    annotations: { title: 'Close meeting task (verified)' }
  },
  {
    name: 'autotask_list_task_resources',
    description: 'List the secondary (additional crew) resources on a task, with their roles. The primary assignee is the task\'s assignedResourceID.',
    inputSchema: { type: 'object', properties: { taskID: { type: 'number', description: 'Task ID' } }, required: ['taskID'] },
    annotations: { title: 'List task resources', readOnlyHint: true }
  },
  {
    name: 'autotask_add_task_resource',
    description: 'Add a secondary resource (additional crew member) to a task, optionally with a role.',
    inputSchema: {
      type: 'object',
      properties: {
        taskID: { type: 'number', description: 'Task ID' },
        resourceID: { type: 'number', description: 'Resource to add' },
        roleID: { type: 'number', description: 'Optional resource role' }
      },
      required: ['taskID', 'resourceID']
    }
  },
  {
    name: 'autotask_remove_task_resource',
    description: '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a secondary resource from a task by the TaskSecondaryResources row id (from list_task_resources). Re-adding requires autotask_add_task_resource.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'TaskSecondaryResources id' } }, required: ['id'] },
    annotations: { title: 'Remove task resource', destructiveHint: true }
  },
  {
    name: 'autotask_list_task_predecessors',
    description: 'List the predecessor dependencies for a task (tasks that must precede it), with lag days.',
    inputSchema: { type: 'object', properties: { taskID: { type: 'number', description: 'Successor task ID' } }, required: ['taskID'] },
    annotations: { title: 'List task predecessors', readOnlyHint: true }
  },
  {
    name: 'autotask_add_task_predecessor',
    description: 'Add a predecessor dependency: predecessorTaskID must precede successorTaskID, with optional lag days.',
    inputSchema: {
      type: 'object',
      properties: {
        successorTaskID: { type: 'number', description: 'The task that depends on the predecessor' },
        predecessorTaskID: { type: 'number', description: 'The task that must come first' },
        lagDays: { type: 'number', description: 'Optional lag in days' }
      },
      required: ['successorTaskID', 'predecessorTaskID']
    }
  },
  {
    name: 'autotask_remove_task_predecessor',
    description: '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a task predecessor dependency by the TaskPredecessors row id (from list_task_predecessors or search_task_predecessors). Re-adding requires autotask_add_task_predecessor.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'TaskPredecessors id' } }, required: ['id'] },
    annotations: { title: 'Remove task predecessor', destructiveHint: true }
  },
  {
    name: 'autotask_get_task_predecessor',
    description: 'Get a single TaskPredecessors dependency row by its id. Returns { id, predecessorTaskID, successorTaskID, lagDays }.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'TaskPredecessors row id' } }, required: ['id'] },
    annotations: { title: 'Get task predecessor', readOnlyHint: true }
  },
  {
    name: 'autotask_search_task_predecessors',
    description: 'Search task dependency rows by either endpoint. Filter by successorTaskID (what a task waits on) and/or predecessorTaskID (what waits on a task); both may be combined. Provide at least one — an unfiltered search returns nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        successorTaskID: { type: 'number', description: 'Return rows whose successor is this task' },
        predecessorTaskID: { type: 'number', description: 'Return rows whose predecessor is this task' },
        pageSize: { type: 'number', description: 'Max rows to return (default 500)' }
      }
    },
    annotations: { title: 'Search task predecessors', readOnlyHint: true }
  },
  {
    name: 'autotask_update_task_predecessor',
    description: 'Update a task dependency. Only lagDays can be changed — Autotask marks predecessorTaskID and successorTaskID readonly, so to re-point a dependency remove this row and add a new one instead.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'TaskPredecessors row id' },
        lagDays: { type: 'number', description: 'New lag in days' }
      },
      required: ['id', 'lagDays']
    }
  },

  // Phase tools
  {
    name: 'autotask_list_phases',
    description: 'List phases for a project in Autotask',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: {
          type: 'number',
          description: 'Project ID to list phases for'
        },
        page: {
          type: 'number',
          description: 'Page number (1-based, default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['projectID']
    }
  },
  {
    name: 'autotask_create_phase',
    description: 'Create a new phase in an Autotask project',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: {
          type: 'number',
          description: 'Project ID for the phase'
        },
        title: {
          type: 'string',
          description: 'Phase title'
        },
        description: {
          type: 'string',
          description: 'Phase description'
        },
        startDate: {
          type: 'string',
          description: 'Phase start date (ISO format)'
        },
        dueDate: {
          type: 'string',
          description: 'Phase due date (ISO format)'
        },
        estimatedHours: {
          type: 'number',
          description: 'Estimated hours for the phase'
        },
        parentPhaseID: {
          type: 'number',
          description: 'Parent phase ID to nest this phase under (Autotask supports nested phases)'
        },
        phaseNumber: {
          type: 'string',
          description: 'Phase number / external ordering label'
        }
      },
      required: ['projectID', 'title']
    }
  },
  {
    name: 'autotask_get_phase',
    description: 'Get a single project phase by ID with its full fields (parentPhaseID, title, description, start/due dates, estimatedHours, phaseNumber, isScheduled).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Phase ID' } },
      required: ['id']
    },
    annotations: { title: 'Get phase', readOnlyHint: true }
  },
  {
    name: 'autotask_update_phase',
    description: 'Update a project phase. Only provided fields are changed. Supports re-parenting via parentPhaseID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Phase ID' },
        title: { type: 'string' },
        description: { type: 'string' },
        startDate: { type: 'string', description: 'ISO date' },
        dueDate: { type: 'string', description: 'ISO date' },
        estimatedHours: { type: 'number' },
        parentPhaseID: { type: 'number', description: 'Parent phase ID (nest/re-parent)' },
        phaseNumber: { type: 'string' }
      },
      required: ['id']
    }
  },

  // Picklist / Queue tools
  {
    name: 'autotask_list_queues',
    description: 'List all available ticket queues in Autotask. Use this to find queue IDs for filtering tickets by queue.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_list_ticket_statuses',
    description: 'List all available ticket statuses in Autotask. Use this to find status values for filtering or creating tickets.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_list_ticket_priorities',
    description: 'List all available ticket priorities in Autotask. Use this to find priority values for filtering or creating tickets.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_get_field_info',
    description: 'Get field definitions for an Autotask entity type, including picklist values. Useful for discovering valid values for any picklist field.',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          description: 'The Autotask entity type (e.g., "Tickets", "Companies", "Contacts", "Projects", "ProjectTasks", "TicketNotes"). Note: project tasks use "ProjectTasks" (or "Tasks" which auto-maps). See Autotask REST API entity names.'
        },
        fieldName: {
          type: 'string',
          description: 'Optional: filter to a specific field name'
        }
      },
      required: ['entityType']
    }
  },
  {
    name: 'autotask_resolve_picklist_value',
    description: 'Resolve a picklist label to its tenant-specific value id for any entity/field (e.g. Tasks/status/"Complete", Projects/status/"In Progress", Tickets/queueID). Use this instead of hard-coding status/type/department/role/billing-code ids. Returns matched / ambiguous / not-found (with suggestions and the full active value list).',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Autotask entity (e.g. "Tasks", "Projects", "Tickets")' },
        field: { type: 'string', description: 'Picklist field name (e.g. "status", "taskType", "departmentID")' },
        label: { type: 'string', description: 'The label to resolve (case-insensitive)' }
      },
      required: ['entity', 'field', 'label']
    },
    annotations: { title: 'Resolve picklist value', readOnlyHint: true }
  },

  {
    name: 'autotask_resolve_record_reference',
    description:
      'READ-ONLY. Resolve a canonical Autotask display reference like ' +
      '"T20260825.0006" to a single Ticket or Task. Tickets and project Tasks ' +
      'share the same T… form, so this searches BOTH and never infers the type ' +
      'from the prefix. Returns { status: "matched" | "ambiguous" | "not-found" }: ' +
      'on "matched" it includes entityType ("ticket"|"task"), id, and title; on ' +
      '"ambiguous" it lists every candidate and selects nothing. Use it before ' +
      'building UI links or performing any write keyed off a T… reference.',
    annotations: {
      title: 'Resolve canonical record reference',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        reference: {
          type: 'string',
          description: 'The canonical display reference to resolve, e.g. "T20260825.0006".',
        },
      },
      required: ['reference'],
    }
  },
  {
    name: 'autotask_whoami',
    description:
      'READ-ONLY. Resolve the calling user to their Autotask resource — used for ' +
      'permissions and as the acting/proxy resource for data input (time entries, ' +
      'To-Dos, assignments). Resolves from the caller context (ChatGPT / Hermes-Teams ' +
      '/ Telegram email or mapped handle) or an explicit resourceId / resourceEmail / ' +
      'resourceName. Returns { status: "resolved", resource } or { status: ' +
      '"user_identification_required", reason, candidates?, message }. When ' +
      'identification is required, ask the user who they are and call again with ' +
      'resourceId / resourceEmail / resourceName.',
    annotations: { title: 'Resolve calling user to Autotask resource', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'number', description: 'Explicit Autotask resource ID to identify as' },
        resourceEmail: { type: 'string', description: 'Resolve by resource email' },
        resourceName: { type: 'string', description: 'Resolve by resource name' }
      },
      required: []
    }
  },

  // Billing Items tools (Approve and Post workflow)
  {
    name: 'autotask_search_billing_items',
    description: 'Search for billing items in Autotask. Billing items represent approved and posted billable items from the "Approve and Post" workflow. Returns 25 results per page by default.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'Filter by company ID'
        },
        ticketId: {
          type: 'number',
          description: 'Filter by ticket ID'
        },
        projectId: {
          type: 'number',
          description: 'Filter by project ID'
        },
        contractId: {
          type: 'number',
          description: 'Filter by contract ID'
        },
        invoiceId: {
          type: 'number',
          description: 'Filter by invoice ID'
        },
        isInvoiced: {
          type: 'boolean',
          description: 'If true, only return billing items that have been attached to an invoice (invoiceID is set). If false, only return items that have not yet been invoiced. Answers "what has and hasn\'t been invoiced yet".'
        },
        dateFrom: {
          type: 'string',
          description: 'Filter billing items with itemDate on or after this date (ISO format, e.g. 2026-01-01)'
        },
        dateTo: {
          type: 'string',
          description: 'Filter billing items with itemDate on or before this date (ISO format)'
        },
        postedAfter: {
          type: 'string',
          description: 'Filter items posted on or after this date (ISO format, e.g. 2026-01-01)'
        },
        postedBefore: {
          type: 'string',
          description: 'Filter items posted on or before this date (ISO format)'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 500',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_billing_item',
    description: 'Get detailed information for a specific billing item by ID',
    inputSchema: {
      type: 'object',
      properties: {
        billingItemId: {
          type: 'number',
          description: 'The billing item ID to retrieve'
        }
      },
      required: ['billingItemId']
    }
  },

  // Billing Item Approval Levels tools
  {
    name: 'autotask_search_billing_item_approval_levels',
    description: 'Search for billing item approval levels. These describe multi-level approval records for Autotask time entries, enabling visibility into tiered approval workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        timeEntryId: {
          type: 'number',
          description: 'Filter by time entry ID'
        },
        approvalResourceId: {
          type: 'number',
          description: 'Filter by approver resource ID'
        },
        approvalLevel: {
          type: 'number',
          description: 'Filter by approval level (1, 2, 3, etc.)'
        },
        approvedAfter: {
          type: 'string',
          description: 'Filter approvals on or after this date (ISO format)'
        },
        approvedBefore: {
          type: 'string',
          description: 'Filter approvals on or before this date (ISO format)'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 500',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },

  // Time Entries search tool
  {
    name: 'autotask_search_time_entries',
    description: 'Search for time entries in Autotask. Returns 25 results per page by default. Time entries can be filtered by resource, ticket, project, task, date range, or approval status. Use approvalStatus="unapproved" to find entries not yet posted. Common fan-out target — scope by date range first to avoid Autotask\'s API threshold.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: {
          type: 'number',
          description: 'Filter by resource (user) ID'
        },
        contractID: {
          type: 'number',
          description: 'Filter by the contract the time entry is billed against (each entry has its own contractID, independent of its ticket\'s)'
        },
        noContract: {
          type: 'boolean',
          description: 'Only time entries with NO contract'
        },
        ticketId: {
          type: 'number',
          description: 'Filter by ticket ID'
        },
        projectId: {
          type: 'number',
          description: 'Filter by project ID'
        },
        taskId: {
          type: 'number',
          description: 'Filter by task ID'
        },
        approvalStatus: {
          type: 'string',
          enum: ['unapproved', 'approved', 'all'],
          description: 'Filter by approval status: "unapproved" = not yet posted (billingApprovalDateTime is null), "approved" = already posted, "all" = no filter (default)'
        },
        billable: {
          type: 'boolean',
          description: 'Filter by billable status (true = billable only, false = non-billable only)'
        },
        dateWorkedAfter: {
          type: 'string',
          description: 'Filter entries worked on or after this date (ISO format, e.g. 2026-01-01)'
        },
        dateWorkedBefore: {
          type: 'string',
          description: 'Filter entries worked on or before this date (ISO format)'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 500',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },

  // === Meta-tools for progressive discovery (lazy loading mode) ===
  {
    name: 'autotask_list_categories',
    description: 'List available tool categories. Use this to discover what types of Autotask operations are available before loading specific tools.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_list_category_tools',
    description: 'List tools in a specific category with full schemas. Use after autotask_list_categories to see available tools and their parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Category name from autotask_list_categories (e.g., "tickets", "financial", "companies")'
        }
      },
      required: ['category']
    }
  },
  {
    name: 'autotask_execute_tool',
    description: 'Execute any Autotask tool by name. Use after discovering tools via autotask_list_category_tools.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: {
          type: 'string',
          description: 'The tool name to execute (e.g., "autotask_search_tickets")'
        },
        arguments: {
          type: 'object',
          description: 'Arguments to pass to the tool'
        }
      },
      required: ['toolName']
    }
  },
  {
    name: 'autotask_router',
    description: 'Intelligent tool router - describe what you want to do and get the right tool suggestion with pre-filled parameters. Use this when unsure which tool to call.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: 'Natural language description of what you want to do (e.g., "find tickets for Acme Corp", "log 2 hours on ticket 12345", "create a quote for client")'
        }
      },
      required: ['intent']
    }
  },

  // Service Call tools
  {
    name: 'autotask_get_service_call',
    description: 'Get a specific service call by ID',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: {
          type: 'number',
          description: 'The service call ID to retrieve'
        }
      },
      required: ['serviceCallId']
    }
  },
  {
    name: 'autotask_search_service_calls',
    description: 'Search for service calls in Autotask. Filter by company, status, or date range.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'Filter by company ID'
        },
        status: {
          type: 'number',
          description: 'Filter by status picklist ID (use autotask_get_field_info with entityType "ServiceCalls" to find valid values)'
        },
        startAfter: {
          type: 'string',
          description: 'Filter service calls starting on or after this date/time (ISO 8601 format)'
        },
        startBefore: {
          type: 'string',
          description: 'Filter service calls starting on or before this date/time (ISO 8601 format)'
        },
        page: {
          type: 'number',
          description: 'Page number (1-based, default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_reconcile_service_call',
    description: "Reconcile ONE service call against its linked ticket to catch billing leakage (read-only). Detects: done-not-closed (open service call, scheduled window in the past, time logged on the ticket in that window — techs recovered from ticket history if the assignment was later cleared by an owner change); no-time-logged (past-scheduled, no time in window); parts-unfulfilled (ticket charges still 'Need to Order/Fulfill', i.e. not pulled from inventory, with $ value); and unbilled-time (billable time not yet approved/posted, in hours). Give a serviceCallId, or a ticketId (uses the first service call linked to it). Returns per-flag evidence + an `issues` list.",
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: { type: 'number', description: 'Service call to reconcile' },
        ticketId: { type: 'number', description: 'Alternatively, a ticket — reconciles the first service call linked to it' }
      }
    },
    annotations: { title: 'Reconcile service call', readOnlyHint: true }
  },
  {
    name: 'autotask_report_service_call_leakage',
    description: "Weekly billing-leakage sweep (read-only): scans past-scheduled service calls in a look-back window and reconciles each, returning the ones with issues plus a digest — counts of done-not-closed / no-time-logged / parts-unfulfilled / unbilled-time, total parts $ at risk, and total unbilled hours. By default only OPEN calls are scanned (prevention — catch orphans before they close); set includeCompleted to also scan COMPLETED calls, whose ticket-level leakage (parts never pulled from inventory, billable time never approved) persists after close (recovery). Canceled calls are always excluded. Built for a scheduled run (e.g. an n8n weekly cron): bounded by maxServiceCalls so cost is predictable. Scope with lookbackDays and optional companyID.",
    inputSchema: {
      type: 'object',
      properties: {
        lookbackDays: { type: 'number', description: 'How many days back to scan service calls by scheduled start date (default 30)', minimum: 1 },
        companyID: { type: 'number', description: 'Limit the sweep to one company (omit for all)' },
        maxServiceCalls: { type: 'number', description: 'Cap on service calls examined (default 100, max 500) — keeps a scheduled run bounded', minimum: 1, maximum: 500 },
        includeCompleted: { type: 'boolean', description: 'Also scan COMPLETED service calls (closed work) for parts-unfulfilled / unbilled-time — the recovery pass (default false = open calls only). done-not-closed / no-time-logged never fire for completed calls.' },
        includeClean: { type: 'boolean', description: 'Include reconciled calls with no issues in `items` (default false — only flagged)' }
      },
      required: []
    },
    annotations: { title: 'Service-call billing leakage sweep', readOnlyHint: true }
  },
  {
    name: 'autotask_analyze_ticket_billing_gaps',
    description: "Ticket-anchored billing-completeness check for review (read-only). For one ticket, flags: work-not-logged (a tech email-reply note or a completed ticket but ZERO time entries); note-without-time (a tech reply landed as an Email Note but no time entry by that tech on the same day — the classic 'CC'd the ticket, note added, time never finished'); and billable-marked-non-billable (a non-billable time entry that looks billable — its work type is client labor / not a Non-Billable code, and/or the contract is Time & Materials, and/or the ticket also has billable time). Returns per-entry evidence + which signals fired, for a human to decide. Use autotask_report_ticket_billing_gaps to sweep many tickets.",
    inputSchema: {
      type: 'object',
      properties: { ticketId: { type: 'number', description: 'Ticket to analyze' } },
      required: ['ticketId']
    },
    annotations: { title: 'Ticket billing gaps', readOnlyHint: true }
  },
  {
    name: 'autotask_report_ticket_billing_gaps',
    description: "Weekly ticket billing-gaps sweep for review (read-only). Scans tickets active in a look-back window — OPEN and (default on) COMPLETED, so 'all tickets' are covered — and returns the ones with gaps plus a digest: counts of work-not-logged / note-without-time / billable-marked-non-billable, total suspect non-billable hours, and total uncaptured notes. This is a REVIEW report — no changes are made; you decide. Built for a scheduled run (n8n weekly cron); bounded by maxTickets. Scope with lookbackDays and optional companyID.",
    inputSchema: {
      type: 'object',
      properties: {
        lookbackDays: { type: 'number', description: 'Scan tickets with activity in the last N days (default 14)', minimum: 1 },
        companyID: { type: 'number', description: 'Limit to one company (omit for all)' },
        maxTickets: { type: 'number', description: 'Cap on tickets examined (default 100, max 500) — keeps a scheduled run bounded', minimum: 1, maximum: 500 },
        includeCompleted: { type: 'boolean', description: 'Also scan COMPLETED tickets (default true — "all tickets"). Set false for open-only.' },
        includeClean: { type: 'boolean', description: 'Include tickets with no gaps in `items` (default false — only flagged)' }
      },
      required: []
    },
    annotations: { title: 'Ticket billing-gaps sweep', readOnlyHint: true }
  },
  {
    name: 'autotask_create_service_call',
    description: 'Create a new service call in Autotask. Service calls are used to schedule and plan work on tickets.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Description of the service call'
        },
        status: {
          type: 'number',
          description: 'Status picklist ID (use autotask_get_field_info with entityType "ServiceCalls" to find valid values)'
        },
        startDateTime: {
          type: 'string',
          description: 'Scheduled start date/time (ISO 8601 format, e.g. 2026-03-22T09:00:00Z)'
        },
        endDateTime: {
          type: 'string',
          description: 'Scheduled end date/time (ISO 8601 format)'
        },
        companyID: {
          type: 'number',
          description: 'Company ID this service call is for'
        },
        companyLocationID: {
          type: 'number',
          description: 'Company location ID (optional)'
        },
        complete: {
          type: 'boolean',
          description: 'Whether this service call is complete (default: false)'
        }
      },
      required: ['description', 'startDateTime', 'endDateTime']
    }
  },
  {
    name: 'autotask_update_service_call',
    description: 'Update an existing service call. Use this to change status, times, or description. To complete/close a service call, set complete: true or update the status.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: {
          type: 'number',
          description: 'The service call ID to update'
        },
        description: {
          type: 'string',
          description: 'Updated description'
        },
        status: {
          type: 'number',
          description: 'Updated status picklist ID'
        },
        startDateTime: {
          type: 'string',
          description: 'Updated start date/time (ISO 8601 format)'
        },
        endDateTime: {
          type: 'string',
          description: 'Updated end date/time (ISO 8601 format)'
        },
        complete: {
          type: 'boolean',
          description: 'Set to true to mark the service call as complete/closed'
        }
      },
      required: ['serviceCallId']
    }
  },
  {
    name: 'autotask_delete_service_call',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a service call ' +
      'and all associated data. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete service call (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: {
          type: 'number',
          description: 'The service call ID to delete'
        }
      },
      required: ['serviceCallId']
    }
  },

  // ServiceCallTicket tools
  {
    name: 'autotask_search_service_call_tickets',
    description: 'Search for ticket associations on service calls. Use this to find which tickets are linked to a service call, or which service calls contain a specific ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: {
          type: 'number',
          description: 'Filter by service call ID'
        },
        ticketId: {
          type: 'number',
          description: 'Filter by ticket ID'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_service_call_ticket',
    description: 'Link a ticket to a service call. This associates the ticket with the service call for scheduling purposes.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallID: {
          type: 'number',
          description: 'The service call ID to link the ticket to'
        },
        ticketID: {
          type: 'number',
          description: 'The ticket ID to link to the service call'
        }
      },
      required: ['serviceCallID', 'ticketID']
    }
  },
  {
    name: 'autotask_delete_service_call_ticket',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a ticket ' +
      'association from a service call. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete service call ticket association (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTicketId: {
          type: 'number',
          description: 'The service call ticket record ID to delete'
        }
      },
      required: ['serviceCallTicketId']
    }
  },

  // ServiceCallTicketResource tools
  {
    name: 'autotask_search_service_call_ticket_resources',
    description: 'Search for resource (technician) assignments on service call tickets.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTicketId: {
          type: 'number',
          description: 'Filter by service call ticket ID'
        },
        resourceId: {
          type: 'number',
          description: 'Filter by resource (technician) ID'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_service_call_ticket_resource',
    description: 'Assign a resource (technician) to a service call ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTicketID: {
          type: 'number',
          description: 'The service call ticket ID to assign the resource to'
        },
        resourceID: {
          type: 'number',
          description: 'The resource (technician) ID to assign. (Autotask service-call assignments carry no role — the role goes on the time entry.)'
        }
      },
      required: ['serviceCallTicketID', 'resourceID']
    }
  },
  {
    name: 'autotask_delete_service_call_ticket_resource',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a resource ' +
      'assignment from a service call ticket. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete service call ticket resource assignment (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTicketResourceId: {
          type: 'number',
          description: 'The service call ticket resource record ID to delete'
        }
      },
      required: ['serviceCallTicketResourceId']
    }
  },

  // ServiceCallTask tools — attach a service call to a PROJECT TASK so scheduled
  // work (e.g. a recurring meeting task) carries its resources onto the calendar.
  {
    name: 'autotask_search_service_call_tasks',
    description: 'Search service-call ↔ project-task associations. Use to find which service call schedules a task, or which task a service call is for.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: { type: 'number', description: 'Filter by service call ID' },
        taskId: { type: 'number', description: 'Filter by project task ID' },
        pageSize: { type: 'number', description: 'Number of results to return (default: 25)', minimum: 1, maximum: 100 }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_service_call_task',
    description: 'Link a PROJECT TASK to a service call — the task equivalent of autotask_create_service_call_ticket. This schedules the task on the Autotask dispatch calendar so its assigned resources (added via autotask_create_service_call_task_resource) appear there. Lets scheduled project work (e.g. a recurring meeting task) go on the calendar directly, without a placeholder scheduling ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallID: { type: 'number', description: 'The service call ID to link the task to' },
        taskID: { type: 'number', description: 'The project task ID to link to the service call' }
      },
      required: ['serviceCallID', 'taskID']
    }
  },
  {
    name: 'autotask_delete_service_call_task',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a task association from a ' +
      'service call. This action cannot be undone. Confirm with the user before invoking.',
    annotations: {
      title: 'Delete service call task association (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTaskId: { type: 'number', description: 'The service call task record ID to delete' }
      },
      required: ['serviceCallTaskId']
    }
  },
  {
    name: 'autotask_search_service_call_task_resources',
    description: 'Search for resource (technician/attendee) assignments on service-call tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTaskId: { type: 'number', description: 'Filter by service call task ID' },
        resourceId: { type: 'number', description: 'Filter by resource ID' },
        pageSize: { type: 'number', description: 'Number of results to return (default: 25)', minimum: 1, maximum: 100 }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_service_call_task_resource',
    description: 'Assign a resource (technician/attendee) to a service-call task — the task equivalent of autotask_create_service_call_ticket_resource. Repeat to put multiple resources (e.g. all four meeting attendees) on the calendar for the scheduled task.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTaskID: { type: 'number', description: 'The service call task ID to assign the resource to' },
        resourceID: { type: 'number', description: 'The resource ID to assign. (Autotask service-call assignments carry no role — the role goes on the time entry.)' }
      },
      required: ['serviceCallTaskID', 'resourceID']
    }
  },
  {
    name: 'autotask_delete_service_call_task_resource',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a resource assignment from a ' +
      'service call task. This action cannot be undone. Confirm with the user before invoking.',
    annotations: {
      title: 'Delete service call task resource assignment (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTaskResourceId: { type: 'number', description: 'The service call task resource record ID to delete' }
      },
      required: ['serviceCallTaskResourceId']
    }
  },

  // Company To-Dos (CRM calendar follow-ups) — brief §4.1
  {
    name: 'autotask_get_company_todo',
    description:
      'READ-ONLY. Get a Company To-Do (CRM calendar follow-up) by ID. A Company ' +
      'To-Do is NOT a ticket checklist item, project task, time entry, ' +
      'appointment, or service call. `completedDate == null` means it is still open.',
    annotations: { title: 'Get Company To-Do', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The CompanyToDo ID' } },
      required: ['id']
    }
  },
  {
    name: 'autotask_search_company_todos',
    description:
      'READ-ONLY. Search Company To-Dos (CRM calendar follow-ups). Set openOnly ' +
      'to return only incomplete To-Dos (completedDate is null).',
    annotations: { title: 'Search Company To-Dos', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Filter by company' },
        assignedToResourceID: { type: 'number', description: 'Filter by assigned resource' },
        ticketID: { type: 'number', description: 'Filter by associated ticket' },
        contactID: { type: 'number', description: 'Filter by associated contact' },
        opportunityID: { type: 'number', description: 'Filter by associated opportunity' },
        contractID: { type: 'number', description: 'Filter by associated contract' },
        openOnly: { type: 'boolean', description: 'When true, return only To-Dos with no completedDate (open)' },
        pageSize: { type: 'number', description: 'Results per page (default 25, max 200)', minimum: 1, maximum: 200 }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_company_todo',
    description:
      'Create a Company To-Do (CRM calendar follow-up) via the company child ' +
      'route. Provide exactly one of actionType (numeric) or actionTypeName ' +
      '(e.g. "Sales", "Phone Call", "Meeting", resolved case-insensitively from ' +
      'live metadata); if neither is given it defaults to General. All ' +
      'associated contact/contract/opportunity/ticket records must belong to the ' +
      'same company.',
    annotations: { title: 'Create Company To-Do', readOnlyHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Owning company (required)' },
        assignedToResourceID: { type: 'number', description: 'Resource the To-Do is assigned to. Provide this, or set currentUser to assign it to the calling user.' },
        currentUser: { type: 'boolean', description: 'Assign the To-Do to the calling user (resolves the caller to their Autotask resource). Alternative to assignedToResourceID.' },
        actionType: { type: 'number', description: 'Numeric action type ID. Provide this OR actionTypeName, not both.' },
        actionTypeName: { type: 'string', description: 'Action type label resolved from metadata (e.g. "Sales"). Provide this OR actionType.' },
        activityDescription: { type: 'string', description: 'Free-text description' },
        startDateTime: { type: 'string', description: 'Start (ISO 8601, required)' },
        endDateTime: { type: 'string', description: 'End (ISO 8601, required)' },
        contactID: { type: 'number', description: 'Associated contact (same company)' },
        contractID: { type: 'number', description: 'Associated contract (same company)' },
        opportunityID: { type: 'number', description: 'Associated opportunity (same company)' },
        ticketID: { type: 'number', description: 'Associated ticket (same company)' }
      },
      required: ['companyID', 'startDateTime', 'endDateTime']
    }
  },
  {
    name: 'autotask_update_company_todo',
    description:
      'Update a Company To-Do via the company child route. companyID is resolved ' +
      'from the record if not supplied. Use actionTypeName to change the action ' +
      'type by label. To mark a To-Do complete, prefer autotask_complete_company_todo.',
    annotations: { title: 'Update Company To-Do', readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The CompanyToDo ID (required)' },
        companyID: { type: 'number', description: 'Owning company (optional; resolved from the record if omitted)' },
        actionType: { type: 'number', description: 'Numeric action type ID' },
        actionTypeName: { type: 'string', description: 'Action type label resolved from metadata' },
        activityDescription: { type: 'string', description: 'Free-text description' },
        startDateTime: { type: 'string', description: 'Start (ISO 8601)' },
        endDateTime: { type: 'string', description: 'End (ISO 8601)' },
        contactID: { type: 'number', description: 'Associated contact' },
        contractID: { type: 'number', description: 'Associated contract' },
        opportunityID: { type: 'number', description: 'Associated opportunity' },
        ticketID: { type: 'number', description: 'Associated ticket' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_complete_company_todo',
    description:
      'Complete a Company To-Do by setting its completedDate to now (there is no ' +
      'isComplete field). companyID is resolved from the record if not supplied. ' +
      'After this, open-only searches exclude the To-Do.',
    annotations: { title: 'Complete Company To-Do', readOnlyHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The CompanyToDo ID (required)' },
        companyID: { type: 'number', description: 'Owning company (optional; resolved from the record if omitted)' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_delete_company_todo',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a Company To-Do. This ' +
      'cannot be undone. Confirm with the user before invoking. companyID is ' +
      'resolved from the record if not supplied.',
    annotations: {
      title: 'Delete Company To-Do (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The CompanyToDo ID to delete (required)' },
        companyID: { type: 'number', description: 'Owning company (optional; resolved from the record if omitted)' }
      },
      required: ['id']
    }
  },

  // Contracts (write) and ContractServices CRUD
  {
    name: 'autotask_create_contract',
    description: 'Create a new Contract in Autotask. Field names match the Autotask REST API exactly. status: 1=In Effect, 0=Inactive. Dates are ISO format (YYYY-MM-DD).',
    inputSchema: {
      type: 'object',
      properties: CONTRACT_SHELL_PROPERTIES,
      required: CONTRACT_SHELL_REQUIRED
    }
  },
  {
    name: 'autotask_create_contracts_bulk',
    description: 'Create multiple contract shells (header records, no service lines) in one call — e.g. onboarding a customer with several location-based contracts. Shells are created one at a time; a failure on one shell does not stop the rest, and each item reports its own success or error.',
    inputSchema: {
      type: 'object',
      properties: {
        contracts: {
          type: 'array',
          description: 'Contract shells to create, in order. Same fields as autotask_create_contract.',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: CONTRACT_SHELL_PROPERTIES,
            required: CONTRACT_SHELL_REQUIRED
          }
        }
      },
      required: ['contracts']
    }
  },
  {
    name: 'autotask_update_contract',
    description: 'Update an existing Contract in Autotask (PATCH). Pass only fields you want to change; everything except id is optional. status: 1=In Effect, 0=Inactive.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Contract ID to update' },
        companyID: { type: 'number', description: 'Company ID' },
        contractName: { type: 'string', description: 'Contract name' },
        contractType: { type: 'number', description: 'Contract type picklist ID' },
        contractCategory: { type: 'number', description: 'Contract category picklist ID' },
        startDate: { type: 'string', description: 'Contract start date (ISO YYYY-MM-DD)' },
        endDate: { type: 'string', description: 'Contract end date (ISO YYYY-MM-DD)' },
        contactID: { type: 'number', description: 'Primary contact ID' },
        contractNumber: { type: 'string', description: 'External-facing contract number' },
        contractPeriodType: { type: 'number', description: 'Period type picklist ID' },
        description: { type: 'string', description: 'Contract description / notes' },
        estimatedCost: { type: 'number', description: 'Estimated cost' },
        estimatedHours: { type: 'number', description: 'Estimated hours' },
        estimatedRevenue: { type: 'number', description: 'Estimated revenue' },
        setupFee: { type: 'number', description: 'Setup fee amount' },
        overageBillingRate: { type: 'number', description: 'Overage billing rate' },
        serviceLevelAgreementID: { type: 'number', description: 'SLA ID' },
        purchaseOrderNumber: { type: 'string', description: 'Customer purchase order number' },
        opportunityID: { type: 'number', description: 'Originating opportunity ID' },
        billingPreference: { type: 'number', description: 'Billing preference picklist ID' },
        billToCompanyID: { type: 'number', description: 'Bill-to company ID' },
        billToCompanyContactID: { type: 'number', description: 'Bill-to contact ID' },
        exclusionContractID: { type: 'number', description: 'Exclusion contract ID' },
        isDefaultContract: { type: 'boolean', description: 'Whether this is the default contract for the company' },
        internalCurrencySetupFee: { type: 'number', description: 'Setup fee in internal currency' },
        internalCurrencyOverageBillingRate: { type: 'number', description: 'Overage rate in internal currency' },
        organizationalLevelAssociationID: { type: 'number', description: 'Org level association ID' },
        contractExclusionSetID: { type: 'number', description: 'Contract exclusion set ID' },
        renewedContractID: { type: 'number', description: 'ID of the contract this renewed' },
        setupFeeBillingCodeID: { type: 'number', description: 'Billing code ID for the setup fee' },
        status: { type: 'number', description: 'Contract status (1=In Effect, 0=Inactive)' },
        timeReportingRequiresStartAndStopTimes: { type: 'number', description: 'Whether time entries require start/stop times' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_create_contract_service',
    description: 'Add a ContractService (service line item) to an existing Contract.',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Parent Contract ID' },
        serviceID: { type: 'number', description: 'Service catalog ID being attached to the contract' },
        unitPrice: { type: 'number', description: 'Unit price for the service line' },
        unitCost: { type: 'number', description: 'Unit cost for the service line' },
        quoteItemID: { type: 'number', description: 'Originating quote item ID, if any' },
        internalCurrencyUnitPrice: { type: 'number', description: 'Unit price in internal currency' },
        adjustedPrice: { type: 'number', description: 'Adjusted price' },
        invoiceDescription: { type: 'string', description: 'Override invoice description for this line' }
      },
      required: ['contractID', 'serviceID', 'unitPrice']
    }
  },
  {
    name: 'autotask_update_contract_service',
    description: 'Update an existing ContractService line on a Contract. Pass only fields you want to change. Writable in Autotask: unitCost, invoiceDescription, internalDescription. unitPrice / internalCurrencyUnitPrice / adjustedPrice and serviceID are READ-ONLY on ContractServices (Autotask ignores them) — change a customer price or quantity with a ContractServiceAdjustment via autotask_pricing_build_change_plan.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ContractService record ID to update' },
        contractID: { type: 'number', description: 'Parent Contract ID' },
        serviceID: { type: 'number', description: 'Read-only in Autotask (ignored)' },
        unitPrice: { type: 'number', description: 'Read-only in Autotask (ignored) — use autotask_pricing_build_change_plan' },
        unitCost: { type: 'number', description: 'Unit cost for the service line (writable)' },
        quoteItemID: { type: 'number', description: 'Read-only in Autotask (ignored)' },
        internalCurrencyUnitPrice: { type: 'number', description: 'Read-only in Autotask (ignored)' },
        adjustedPrice: { type: 'number', description: 'Read-only in Autotask (ignored) — use autotask_pricing_build_change_plan' },
        invoiceDescription: { type: 'string', description: 'Override invoice description for this line' }
      },
      required: ['id', 'contractID']
    }
  },
  {
    name: 'autotask_get_contract_service',
    description: 'Get a single ContractService line by ID — the service entitlement on a contract (contractID, serviceID, quoteItemID, unitPrice, unitCost, internalDescription, invoiceDescription). Used to confirm a configuration item is still entitled through an active contract service.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'ContractService record ID' } },
      required: ['id']
    },
    annotations: { title: 'Get contract service', readOnlyHint: true }
  },
  {
    name: 'autotask_search_contract_services',
    description: 'Search ContractService lines (service entitlements on contracts). Filter by contractID (all service lines on a contract), serviceID, and/or quoteItemID. Answers "which services does this contract cover?" and "is this service entitled on any contract?". With no filter, returns the first page of contract services.',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Return service lines on this contract' },
        serviceID: { type: 'number', description: 'Return service lines for this service' },
        quoteItemID: { type: 'number', description: 'Return the service line originating from this quote item' },
        pageSize: { type: 'number', description: 'Max rows to return (default 25, max 500)', minimum: 1, maximum: 500 }
      }
    },
    annotations: { title: 'Search contract services', readOnlyHint: true }
  },
  {
    name: 'autotask_get_contract_billed_units',
    description: 'Billed units per contract service line (read-only). Returns the actual per-period ContractServiceUnits rows (and, unless excluded, ContractServiceBundleUnits) for a contract: units, price (the prorated amount billed for that period — partial first/last months are prorated), cost, and the period start/end. Service/bundle names are attached. Scope to a whole contract (contractID), a single line (contractServiceID), and/or a start-date window (startAfter/startBefore). Use this for "what was actually billed on this contract per month?"; for a summarized monthly/annual recurring total use autotask_report_contract_recurring_revenue.',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Return billed-unit rows for this contract' },
        contractServiceID: { type: 'number', description: 'Return billed-unit rows for a single ContractService line (bundle units are omitted when set)' },
        startAfter: { type: 'string', description: 'Only periods starting on/after this date (YYYY-MM-DD)' },
        startBefore: { type: 'string', description: 'Only periods starting on/before this date (YYYY-MM-DD)' },
        includeBundles: { type: 'boolean', description: 'Include ContractServiceBundleUnits (default true; ignored when contractServiceID is set)' },
        pageSize: { type: 'number', description: 'Max rows per entity (default 100, max 500)', minimum: 1, maximum: 500 }
      }
    },
    annotations: { title: 'Contract billed units', readOnlyHint: true }
  },
  {
    name: 'autotask_report_contract_recurring_revenue',
    description: "Recurring-revenue roll-up for a contract (read-only): monthly (MRR) and annual (ARR) recurring revenue from its recurring service + bundle lines as of a date. Per line, monthly = current units × rate (adjustedPrice, else unitPrice); the prorated per-period billed amount is reported per line but is NOT what MRR sums, so partial first/last months don't distort the steady-state figure. Lines with no allocation covering the date are listed as inactive and excluded from MRR. Use asOfDate to value the contract at a point in time (default today).",
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Contract to roll up' },
        asOfDate: { type: 'string', description: 'Value recurring lines active on this date (YYYY-MM-DD; default today)' }
      },
      required: ['contractID']
    },
    annotations: { title: 'Contract recurring revenue (MRR/ARR)', readOnlyHint: true }
  },
  {
    name: 'autotask_report_contract_labour_basis',
    description: 'Contract labour-billing basis — the "is labour included in the fee" flag (dashboard gap #4). Per contract, DERIVES from contractType whether labour is billed on top (Time & Materials / Per Ticket → basis "billed"), drawn from a prepaid block (Block Hours → "block", overage billable), or absorbed in the fee (Fixed Price / Retainer / Recurring Service → "absorbed"); Umbrella and unknown are separate. Each row carries leakageRelevant (true when unbilled/unapproved time on it is worth chasing), billingPreference (why time may sit unapproved — Manually / On timesheet approval defer billing), overageBillingRate, setupFee, and the exclusion set. Autotask has NO direct labour-included field — this is the derivation. Cross-reference with report_unbilled_time / report_unbilled to scope the $ leak to leakageRelevant contracts. Read-only; active contracts by default.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Limit to one company (omit for all).' },
        contractType: { type: 'number', description: 'Filter by contractType id (1=T&M, 3=Fixed Price, 4=Block Hours, 6=Retainer, 7=Recurring Service, 8=Per Ticket, 9=Umbrella).' },
        includeInactive: { type: 'boolean', description: 'Include inactive contracts (status ≠ Active). Default false.' }
      },
      required: []
    },
    annotations: { title: 'Contract labour basis', readOnlyHint: true }
  },
  {
    name: 'autotask_get_contract_milestone',
    description: 'Get a single ContractMilestone by id — a commercial milestone payment on a contract (title, amount, dateDue, status, description, billingCodeID, isInitialPayment).',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ContractMilestone id' } }, required: ['id'] },
    annotations: { title: 'Get contract milestone', readOnlyHint: true }
  },
  {
    name: 'autotask_search_contract_milestones',
    description: 'Search contract milestones, primarily by contractID (all milestones on a contract). Optionally narrow by status. Provide at least one filter — an unfiltered search returns nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Return milestones on this contract' },
        status: { type: 'number', description: 'Optional status picklist id to filter by (tenant-specific — see autotask_get_field_info entityType "ContractMilestones" fieldName "status")' },
        pageSize: { type: 'number', description: 'Max rows to return (default 500)' }
      }
    },
    annotations: { title: 'Search contract milestones', readOnlyHint: true }
  },
  {
    name: 'autotask_create_contract_milestone',
    description: 'Create a ContractMilestone on a contract. contractID is required and immutable after create. status is a tenant-specific picklist — resolve the id with autotask_get_field_info (entityType "ContractMilestones", fieldName "status") or autotask_resolve_picklist_value.',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Parent Contract ID (immutable after create)' },
        title: { type: 'string', description: 'Milestone title' },
        amount: { type: 'number', description: 'Milestone amount' },
        dateDue: { type: 'string', description: 'Due date (ISO 8601, e.g. 2026-09-18)' },
        status: { type: 'number', description: 'Status picklist id (tenant-specific)' },
        isInitialPayment: { type: 'boolean', description: 'Whether this is the initial payment' },
        description: { type: 'string', description: 'Optional description' },
        billingCodeID: { type: 'number', description: 'Optional billing/labor code id' }
      },
      required: ['contractID', 'title', 'amount', 'dateDue', 'status', 'isInitialPayment']
    }
  },
  {
    name: 'autotask_update_contract_milestone',
    description: 'Update a ContractMilestone. Pass only fields to change. contractID is readonly and ignored if sent. (Autotask does not support deleting milestones — set status or amount instead.)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ContractMilestone id to update' },
        title: { type: 'string', description: 'Milestone title' },
        amount: { type: 'number', description: 'Milestone amount' },
        dateDue: { type: 'string', description: 'Due date (ISO 8601)' },
        status: { type: 'number', description: 'Status picklist id (tenant-specific)' },
        isInitialPayment: { type: 'boolean', description: 'Whether this is the initial payment' },
        description: { type: 'string', description: 'Description' },
        billingCodeID: { type: 'number', description: 'Billing/labor code id' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_raw_request',
    description: 'Escape hatch for Autotask REST endpoints not yet wrapped by a typed tool. Use sparingly — typed tools are preferred for safety. The existing Content-Type, Accept, ApiIntegrationcode, UserName, Secret headers are added automatically. The path is resolved against the zone-resolved base URL (https://webservices<N>.autotask.net/ATServicesRest/v1.0). Pass queryParams as a flat object of string/number/boolean values; they will be URL-encoded and appended to the path.',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
          description: 'HTTP method'
        },
        path: {
          type: 'string',
          description: 'Path under the Autotask REST v1.0 base (e.g. "/Companies/175" or "/Companies/query")'
        },
        body: {
          type: 'object',
          description: 'Optional JSON body for POST/PATCH requests',
          additionalProperties: true
        },
        queryParams: {
          type: 'object',
          description: 'Optional flat key-value query parameters (e.g. { includeFields: "id,name" })',
          additionalProperties: true
        }
      },
      required: ['method', 'path']
    }
  },
  // Webhook management (#23 §16) — read/discovery layer
  {
    name: 'autotask_list_webhook_entities',
    description: "Prerequisite/discovery for webhook management (read-only, no I/O): lists the Autotask entities that support outbound webhooks (tickets, companies, contacts, configurationItems, ticketNotes) and the REST entity names behind each — the parent `<Entity>Webhooks` record and its child collections for monitored fields, UDF fields, and EXCLUDED RESOURCES. The excluded-resources child is the loop-prevention hook: exclude the MCP integration user's resourceID so the MCP's own writes don't trigger the webhook back into itself. Call this first to know which `entity` values the other webhook tools accept.",
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { title: 'List webhook-capable entities', readOnlyHint: true }
  },
  {
    name: 'autotask_search_webhooks',
    description: "List existing webhooks configured on a webhook-capable entity (read-only). Pass `entity` (tickets / companies / contacts / configurationItems / ticketNotes — see autotask_list_webhook_entities). Returns the parent webhook records (name, URL, active flag, event subscriptions). Use activeOnly to see only enabled ones.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key (tickets/companies/contacts/configurationItems/ticketNotes)' },
        activeOnly: { type: 'boolean', description: 'Only active webhooks' },
        pageSize: { type: 'number', description: 'Max webhooks to return (default 100, max 500)', minimum: 1, maximum: 500 }
      },
      required: ['entity']
    },
    annotations: { title: 'Search webhooks', readOnlyHint: true }
  },
  {
    name: 'autotask_get_webhook',
    description: "Get one webhook with its full configuration (read-only): the parent record plus its monitored standard fields, UDF fields, and EXCLUDED RESOURCES (the resources whose changes don't fire it — the loop-prevention list). Pass `entity` and the webhook `id`.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key (see autotask_list_webhook_entities)' },
        id: { type: 'number', description: 'Webhook id' }
      },
      required: ['entity', 'id']
    },
    annotations: { title: 'Get webhook', readOnlyHint: true }
  },
  {
    name: 'autotask_create_webhook',
    description: "Create an outbound webhook on a webhook-capable entity (STANDING CONFIGURATION). SAFE BY DEFAULT: unless you pass dryRun:false, NOTHING is written — it returns the planned webhook, fields, and excluded resources. Creates the parent webhook then its monitored `fields` and `excludedResourceIDs`. LOOP PREVENTION IS AUTOMATIC: this MCP's own API user is excluded by default (its writes — and any automation sharing that user — won't re-trigger the webhook), plus any ids in AUTOTASK_WEBHOOK_EXCLUDE_RESOURCE_IDS; the dry run lists every excluded resource with why. SECRET: omit secretKey — the MCP uses AUTOTASK_WEBHOOK_SECRET from the host so the secret never appears in chat (give the receiver, e.g. n8n, the same variable to verify the X-Hook-Signature: sha1=<base64 HMAC-SHA1 of the raw body>). A secret is never echoed back. Autotask REQUIRES name, https webhookUrl, https deactivationUrl (called if the webhook auto-deactivates), a secret (10–64 chars), and at least one event subscription. Returns the write-plan envelope (status: dry_run | validation_failed | created | created_with_errors) plus receiverGuide: a tested n8n Code node that verifies the signature (Webhook node Raw Body ON).",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key (see autotask_list_webhook_entities)' },
        name: { type: 'string', description: 'Webhook name' },
        webhookUrl: { type: 'string', description: 'The https:// callback URL (e.g. an n8n webhook node)' },
        deactivationUrl: { type: 'string', description: 'REQUIRED https:// URL Autotask calls if it auto-deactivates the webhook' },
        secretKey: { type: 'string', description: 'Usually OMIT: the MCP uses AUTOTASK_WEBHOOK_SECRET from its host so the secret never enters the conversation. Only pass one if that variable is not set. 10–64 characters; never echoed back.' },
        isActive: { type: 'boolean', description: 'Active on create (default true)' },
        subscribeCreate: { type: 'boolean', description: 'Fire on record create' },
        subscribeUpdate: { type: 'boolean', description: 'Fire on record update' },
        subscribeDelete: { type: 'boolean', description: 'Fire on record delete' },
        sendThresholdExceededNotification: { type: 'boolean', description: 'Default false' },
        notificationEmailAddress: { type: 'string' },
        fields: {
          type: 'array', description: 'Standard fields to monitor. Each: { fieldID, isSubscribedField?, isDisplayAlwaysField? } (isSubscribedField default true).',
          items: { type: 'object', properties: { fieldID: { type: 'number' }, isSubscribedField: { type: 'boolean' }, isDisplayAlwaysField: { type: 'boolean' } }, required: ['fieldID'] }
        },
        excludedResourceIDs: { type: 'array', items: { type: 'number' }, description: 'EXTRA resource ids whose changes do NOT fire the webhook (e.g. another automation\'s API user). This MCP\'s own API user is added automatically.' },
        excludeSelf: { type: 'boolean', description: 'Exclude this MCP\'s own API user (default true). Set false only if the webhook SHOULD fire on the MCP\'s own writes.' },
        dryRun: { type: 'boolean', description: 'Default true — plan only, no writes. Pass false to create.' }
      },
      required: ['entity', 'name', 'webhookUrl', 'deactivationUrl']
    },
    annotations: { title: 'Create webhook' }
  },
  {
    name: 'autotask_update_webhook',
    description: "Update a webhook's parent settings — activate/deactivate (isActive), change webhookUrl, toggle event subscriptions, notifications, owner, or secret (STANDING CONFIGURATION). SAFE BY DEFAULT (dryRun:true) — returns the planned patch and writes nothing until dryRun:false. Manage monitored fields / excluded resources with their own tools. Returns the write-plan envelope.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key' },
        id: { type: 'number', description: 'Webhook id' },
        name: { type: 'string' },
        webhookUrl: { type: 'string', description: 'New https:// callback URL' },
        deactivationUrl: { type: 'string', description: 'New https:// auto-deactivation URL' },
        isActive: { type: 'boolean', description: 'Enable/disable the webhook' },
        subscribeCreate: { type: 'boolean' },
        subscribeUpdate: { type: 'boolean' },
        subscribeDelete: { type: 'boolean' },
        sendThresholdExceededNotification: { type: 'boolean' },
        notificationEmailAddress: { type: 'string' },
        secretKey: { type: 'string', description: 'New secret (avoid: it enters the chat). Prefer useEnvSecret.' },
        useEnvSecret: { type: 'boolean', description: 'Rotate the secret to AUTOTASK_WEBHOOK_SECRET from the MCP host — the secret never appears in chat. Update the receiver (n8n) to the same value at the same time.' },
        dryRun: { type: 'boolean', description: 'Default true — plan only. Pass false to apply.' }
      },
      required: ['entity', 'id']
    },
    annotations: { title: 'Update webhook' }
  },
  {
    name: 'autotask_delete_webhook',
    description: "⚠ DESTRUCTIVE: Permanently delete a webhook (STANDING CONFIGURATION — cannot be undone). Requires confirm:true. The callback stops firing immediately for everyone. Prefer autotask_update_webhook with isActive:false to disable without deleting.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key' },
        id: { type: 'number', description: 'Webhook id to delete' }
      },
      required: ['entity', 'id']
    },
    annotations: { title: 'Delete webhook', destructiveHint: true }
  },
  {
    name: 'autotask_set_webhook_excluded_resources',
    description: "Manage a webhook's excluded resources — the loop-prevention list (resources whose changes do NOT fire the webhook). mode: 'add' (create missing), 'remove' (delete matching), or 'replace' (make the set exactly match resourceIDs). SAFE BY DEFAULT (dryRun:true) — returns what would change and writes nothing until dryRun:false. Use this to exclude the MCP integration user so its own writes don't re-trigger the webhook.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key' },
        webhookID: { type: 'number', description: 'The webhook to modify' },
        resourceIDs: { type: 'array', items: { type: 'number' }, description: 'Resource ids to add/remove (or the exact set for replace)' },
        mode: { type: 'string', enum: ['add', 'remove', 'replace'], description: 'Default add' },
        dryRun: { type: 'boolean', description: 'Default true — plan only. Pass false to apply.' }
      },
      required: ['entity', 'webhookID', 'resourceIDs']
    },
    annotations: { title: 'Set webhook excluded resources' }
  }
];

// Every tool that only READS gets readOnlyHint, so clients don't ask "Confirm" before a lookup (Microsoft 365
// Copilot confirms every tool that isn't marked read-only). Autotask's own security levels still decide what each
// person may see. A tool whose annotations already say read-only / not / destructive keeps them.
const READ_PREFIXES = ['autotask_get_', 'autotask_search_', 'autotask_list_', 'autotask_find_', 'autotask_query_', 'autotask_count_', 'autotask_report_'];
const READ_BY_NAME = new Set(['autotask_test_connection', 'autotask_router']);
/** Named like a read but writes. */
export const WRITES_DESPITE_READ_NAME = new Set(['autotask_find_or_create_contact']);
for (const t of TOOL_DEFINITIONS) {
  const a = t.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
  if (a?.readOnlyHint !== undefined || a?.destructiveHint || WRITES_DESPITE_READ_NAME.has(t.name)) continue;
  if (READ_PREFIXES.some((x) => t.name.startsWith(x)) || READ_BY_NAME.has(t.name)) t.annotations = { ...(t.annotations ?? {}), readOnlyHint: true };
}

export const TOOL_CATEGORIES: Record<string, { description: string; tools: string[] }> = {
  vendor_billing: {
    description: 'Vendor purchasing & billing reconciliation (Pax8 first): import every invoice line, map vendor customers and SKUs to Autotask companies and manufacturer offerings',
    tools: ['autotask_vendor_list_sources', 'autotask_vendor_import_invoice', 'autotask_vendor_get_lines', 'autotask_reconcile_resolve_mapping', 'autotask_vendor_prices', 'autotask_catalog_plan_standardize', 'autotask_change_plan_review', 'autotask_change_plan_execute', 'autotask_reconcile_vendor_to_autotask', 'autotask_reconcile_get_exceptions', 'autotask_vendor_pricing_policy', 'autotask_reconcile_export_workbook', 'autotask_pricing_build_change_plan', 'autotask_reconcile_check_sync_drift', 'autotask_vendor_sync', 'autotask_contract_plan_move_lines', 'autotask_contract_plan_wording', 'autotask_change_plan_revert', 'autotask_vendor_monitor', 'autotask_billing_preinvoice_check', 'autotask_pricing_customer_notices']
  },
  utility: {
    description: 'Connection testing and field/picklist discovery',
    tools: ['autotask_test_connection', 'autotask_setup_check', 'autotask_report_gap', 'autotask_get_api_usage', 'autotask_get_actor_roster', 'autotask_get_operations', 'autotask_get_backpressure', 'autotask_shadow_status', 'autotask_shadow_query', 'autotask_shadow_aggregate', 'autotask_shadow_sync', 'autotask_list_queues', 'autotask_list_ticket_statuses', 'autotask_list_ticket_priorities', 'autotask_get_field_info', 'autotask_get_picklists', 'autotask_resolve_picklist_value', 'autotask_resolve_record_reference', 'autotask_whoami']
  },
  companies: {
    description: 'Search, create, and update companies',
    tools: ['autotask_search_companies', 'autotask_get_company', 'autotask_find_company_contact_candidates', 'autotask_find_duplicate_companies', 'autotask_merge_discover', 'autotask_merge_dependency_inventory', 'autotask_merge_build_plan', 'autotask_merge_verify', 'autotask_bulk_inactivate', 'autotask_create_company', 'autotask_update_company', 'autotask_get_company_site_configuration', 'autotask_update_company_site_configuration']
  },
  contacts: {
    description: 'Search and create contacts',
    tools: ['autotask_search_contacts', 'autotask_get_contact', 'autotask_find_duplicate_contacts', 'autotask_create_contact', 'autotask_update_contact', 'autotask_find_or_create_contact']
  },
  tickets: {
    description: 'Search, create, update tickets and manage ticket notes, attachments, charges, audit history, and the notification e-mails Autotask sent',
    tools: ['autotask_search_tickets', 'autotask_get_ticket_details', 'autotask_set_ticket_contract', 'autotask_get_ticket_by_number', 'autotask_get_ticket_change_history', 'autotask_get_ticket_email_context', 'autotask_create_ticket', 'autotask_update_ticket', 'autotask_start_work_on_ticket', 'autotask_add_ticket_update', 'autotask_move_ticket_to_company', 'autotask_find_ticket_by_external_id', 'autotask_search_ticket_configuration_items', 'autotask_add_ticket_configuration_item', 'autotask_remove_ticket_configuration_item', 'autotask_get_ticket_note', 'autotask_search_ticket_notes', 'autotask_create_ticket_note', 'autotask_get_ticket_attachment', 'autotask_search_ticket_attachments', 'autotask_create_ticket_attachment', 'autotask_get_ticket_charge', 'autotask_search_ticket_charges', 'autotask_create_ticket_charge', 'autotask_update_ticket_charge', 'autotask_delete_ticket_charge', 'autotask_get_ticket_history', 'autotask_search_ticket_history', 'autotask_search_notification_history', 'autotask_report_ticket_throughput', 'autotask_report_request_segmentation', 'autotask_search_checklist_libraries', 'autotask_get_checklist_library', 'autotask_apply_checklist_library_to_ticket', 'autotask_create_maintenance_ticket', 'autotask_search_ticket_checklist_items', 'autotask_create_ticket_checklist_item', 'autotask_update_ticket_checklist_item', 'autotask_delete_ticket_checklist_item']
  },
  projects: {
    description: 'Search and create projects, tasks, phases, and project notes',
    tools: ['autotask_search_projects', 'autotask_get_project', 'autotask_update_project', 'autotask_get_project_structure', 'autotask_get_complete_project_context', 'autotask_get_project_labor_summary', 'autotask_export_project_blueprint', 'autotask_calculate_project_schedule', 'autotask_extract_project_scope', 'autotask_classify_project', 'autotask_calculate_bom_labor', 'autotask_generate_project_labor_plan', 'autotask_build_project_from_plan', 'autotask_extend_project', 'autotask_create_project', 'autotask_link_project_commercial', 'autotask_search_tasks', 'autotask_get_task', 'autotask_get_task_by_number', 'autotask_create_task', 'autotask_update_task', 'autotask_complete_task', 'autotask_delete_task', 'autotask_delete_task_with_time', 'autotask_verify_task_time_entries', 'autotask_close_meeting_task', 'autotask_list_task_resources', 'autotask_add_task_resource', 'autotask_remove_task_resource', 'autotask_list_task_predecessors', 'autotask_add_task_predecessor', 'autotask_remove_task_predecessor', 'autotask_get_task_predecessor', 'autotask_search_task_predecessors', 'autotask_update_task_predecessor', 'autotask_list_phases', 'autotask_create_phase', 'autotask_get_phase', 'autotask_update_phase', 'autotask_get_project_note', 'autotask_search_project_notes', 'autotask_create_project_note', 'autotask_get_task_note', 'autotask_search_task_notes', 'autotask_create_task_note', 'autotask_search_project_attachments', 'autotask_search_task_attachments', 'autotask_get_project_attachment', 'autotask_create_project_attachment', 'autotask_get_task_attachment', 'autotask_create_task_attachment']
  },
  time_and_billing: {
    description: 'Time entries, billing items, and expense management',
    tools: ['autotask_create_time_entry', 'autotask_create_task_time_entries_bulk', 'autotask_log_ticket_collaboration', 'autotask_log_my_time', 'autotask_list_regular_time_categories', 'autotask_get_time_entry_targets', 'autotask_get_my_day', 'autotask_search_time_entries', 'autotask_get_time_entry', 'autotask_update_time_entry', 'autotask_delete_time_entry', 'autotask_search_billing_items', 'autotask_get_billing_item', 'autotask_search_billing_item_approval_levels', 'autotask_report_time_entry_compliance', 'autotask_report_activity_without_time', 'autotask_search_audit_activity', 'autotask_get_activity_feed', 'autotask_backfill_history', 'autotask_report_resource_activity', 'autotask_report_resource_daily_audit', 'autotask_report_unbilled_time', 'autotask_get_expense_report', 'autotask_search_expense_reports', 'autotask_create_expense_report', 'autotask_search_expense_items', 'autotask_create_expense_item']
  },
  financial: {
    description: 'Quotes, quote items, opportunities, invoices, and contracts',
    tools: ['autotask_get_quote', 'autotask_search_quotes', 'autotask_create_quote', 'autotask_get_quote_item', 'autotask_search_quote_items', 'autotask_create_quote_item', 'autotask_update_quote_item', 'autotask_delete_quote_item', 'autotask_get_opportunity', 'autotask_search_opportunities', 'autotask_create_opportunity', 'autotask_update_opportunity', 'autotask_search_invoices', 'autotask_get_invoice_details', 'autotask_search_contracts', 'autotask_get_contract', 'autotask_list_expiring_contracts', 'autotask_create_contract', 'autotask_create_contracts_bulk', 'autotask_update_contract', 'autotask_create_contract_service', 'autotask_update_contract_service', 'autotask_get_contract_service', 'autotask_search_contract_services', 'autotask_get_contract_billed_units', 'autotask_report_contract_recurring_revenue', 'autotask_report_contract_labour_basis', 'autotask_get_contract_milestone', 'autotask_search_contract_milestones', 'autotask_create_contract_milestone', 'autotask_update_contract_milestone', 'autotask_report_block_hour_usage', 'autotask_report_ticket_charges', 'autotask_report_unbilled', 'autotask_report_project_pl', 'autotask_report_sla_compliance', 'autotask_generate_sla_framework', 'autotask_report_sla_coverage', 'autotask_assign_contract_sla', 'autotask_analyze_ticket_billing_gaps', 'autotask_report_ticket_billing_gaps']
  },
  products_and_services: {
    description: 'Products, services, and service bundles catalog',
    tools: ['autotask_get_product', 'autotask_search_products', 'autotask_find_product', 'autotask_list_product_categories', 'autotask_find_catalog_gaps', 'autotask_find_duplicate_products', 'autotask_bulk_update_products', 'autotask_merge_products', 'autotask_create_product', 'autotask_update_product', 'autotask_search_inventory_products', 'autotask_get_inventory_product', 'autotask_create_inventory_product', 'autotask_update_inventory_product', 'autotask_search_inventory_locations', 'autotask_get_inventory_location', 'autotask_create_inventory_location', 'autotask_update_inventory_location', 'autotask_search_inventory_stocked_items', 'autotask_get_inventory_stocked_item', 'autotask_search_inventory_transfers', 'autotask_create_inventory_transfer', 'autotask_add_inventory_stock', 'autotask_remove_inventory_stock', 'autotask_report_inventory_reorder', 'autotask_report_inventory_closeouts', 'autotask_report_inventory_stale', 'autotask_get_service', 'autotask_search_services', 'autotask_get_service_bundle', 'autotask_search_service_bundles']
  },
  resources: {
    description: 'Search Autotask resources (technicians/staff) and roles (for assignment / time entries)',
    tools: ['autotask_search_resources', 'autotask_search_roles', 'autotask_get_resource_roles', 'autotask_report_resource_burden']
  },
  configuration_items: {
    description: 'Search and read configuration items (assets/devices), including contract/service entitlement links and coverage gaps',
    tools: ['autotask_search_configuration_items', 'autotask_get_configuration_item', 'autotask_create_configuration_item', 'autotask_update_configuration_item', 'autotask_get_configuration_item_entitlement', 'autotask_search_configuration_item_coverage_gaps']
  },
  company_notes: {
    description: 'Get, search, and create company notes',
    tools: ['autotask_get_company_note', 'autotask_search_company_notes', 'autotask_create_company_note']
  },
  service_calls: {
    description: 'Service call dispatching, ticket linking, and resource assignments',
    tools: ['autotask_reconcile_service_call', 'autotask_report_service_call_leakage', 'autotask_report_tickets_needing_scheduling', 'autotask_search_service_calls', 'autotask_get_service_call', 'autotask_create_service_call', 'autotask_update_service_call', 'autotask_delete_service_call', 'autotask_search_service_call_tickets', 'autotask_create_service_call_ticket', 'autotask_delete_service_call_ticket', 'autotask_search_service_call_ticket_resources', 'autotask_create_service_call_ticket_resource', 'autotask_delete_service_call_ticket_resource', 'autotask_search_service_call_tasks', 'autotask_create_service_call_task', 'autotask_delete_service_call_task', 'autotask_search_service_call_task_resources', 'autotask_create_service_call_task_resource', 'autotask_delete_service_call_task_resource']
  },
  company_todos: {
    description: 'Company To-Dos — CRM calendar follow-ups (distinct from tasks, checklist items, time entries, appointments, and service calls)',
    tools: ['autotask_get_company_todo', 'autotask_search_company_todos', 'autotask_create_company_todo', 'autotask_update_company_todo', 'autotask_complete_company_todo', 'autotask_delete_company_todo']
  },
  commerce: {
    description: 'Sell through Autotask: an offering catalog (recurring plans / add-ons, one-time services), quotes, and orders that set up the customer, users, contract, services, delivery ticket and charges in one approved plan, then track it to its invoice and payment',
    tools: ['autotask_commerce_offerings', 'autotask_commerce_quote', 'autotask_commerce_order']
  },
  webhooks: {
    description: 'Autotask outbound webhook management — discover webhook-capable entities and inspect existing webhooks (read/discovery)',
    tools: ['autotask_list_webhook_entities', 'autotask_search_webhooks', 'autotask_get_webhook', 'autotask_create_webhook', 'autotask_update_webhook', 'autotask_delete_webhook', 'autotask_set_webhook_excluded_resources']
  }
};
