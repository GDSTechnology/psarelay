# PSArelay (formerly autotask-mcp)

Task management: Task Master (`task-master` CLI; config in `.taskmaster/`).
Workflow defaults (commits, changelog, memory) come from the global `~/.claude/CLAUDE.md`.

## Learnings
## Learnings - 2026-10-26

- **Microsoft 365 Copilot's MCP connector registers by DCR but refuses a registration without a `client_secret`**
  (Microsoft Learn, "Configure dynamic client registration"); PKCE stays on. ChatGPT / Claude / Codex register as
  public clients (`none`). `/oauth/register` now issues a secret for `client_secret_post` / `_basic` (required at
  the token endpoint) and for an unspecified method (`auto`: checked only when sent, so no existing client breaks).
  The auth config lives in each tenant's token store (Agents Toolkit creates it), so no prebuilt agent zip can
  work across MSPs — each admin runs the toolkit once against their own address.
- **Copilot Entra SSO** (src/security/entra.ts, m365*.ts, migration 0023): Copilot sends the person's Entra access
  token; it is accepted only from client `ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b` (Microsoft Enterprise token store)
  for a trusted tenant + configured audience. An unlinked person gets `TokenAuth.unlinkedMessage` and every tool
  call answers it — a token with `resourceId: null` would otherwise run as the API USER (service-token path), so
  any new code reading `getRequestAuth()` must check `unlinkedMessage` first. NOT yet verified live: the
  Resources fields `email2` / `email3` / `userName` (the lookup asks only for fields in the live field list) and
  whether Copilot sends v1 or v2 tokens (both accepted).

## Learnings - 2026-10-22

- **`Projects` has no `contactID` in this tenant**: querying it → HTTP 500 "Unable to find contactID in the Project
  Entity". The contact history list (`CONTACT_REFS`) included it, so every junk-contact preparation failed and every
  merge inventory showed projects as "could not be checked". Reference lists are now checked against the LIVE field
  list first: a link field the tenant lacks is skipped (count 0); an unknown field list still queries and fails closed.
- Autotask's own **API Activity By Hour** report (Admin → Extensions & Integrations) breaks calls down per
  integration (API user), reads included — the only place other integrations' reads show. An email-to-ticket
  connector made 63k calls/day with 6–9k bursts at 21:00 and 00–04; bulk jobs now keep quiet hours there.
- **A note / time entry moves `Tickets.lastActivityDate` and `Tasks.lastActivityResourceID` WITHOUT moving their
  modified stamp** (mirror check: Tickets / Tasks "differ"), so the incremental sync never re-read them. The sync now
  queues the parent ticket / task of every new or changed TicketNote / TimeEntry for a re-read (`markParentsStale`,
  not `markDirty`: that one sends searches live for minutes).

## Learnings - 2026-10-20

- **Pausing the mirror under load makes the load worse.** A bulk job pushed tenant usage past 50%, the shadow
  sync paused (`MCP_PG_SHADOW_PAUSE_AT_PCT` 50), the mirror went stale, and the ~80% of reads it answers went to
  Autotask live: usage hit 91.9% and then 429s. The sync now pauses at 85% (a run is <= 100 calls); bulk jobs halve
  at 40% and wait at 65% (`BULK_THRESHOLDS`), so background writes yield long before the mirror or the dispatchers.
  Anything that can stop the sync must be weighed against the live reads a stale mirror causes.
- In a 429 cooldown every call fails LOCALLY, the usage check included: the sync used to read that as "usage
  unknown" and run, failing every entity with the cooldown error. It now skips the run.

## Learnings - 2026-10-19

- **`Contacts.isActive` is an INTEGER (0 / 1)**; `Companies.isActive` is a boolean. Sending `false` to a
  contact fails the whole update with HTTP 500 "Unexpected character encountered while parsing value: f.
  Path 'isActive'" (seen live: ChatGPT deactivating placeholder contacts). update/create_contact now send 0 / 1.
- This zone updates contacts ONLY via PATCH /Companies/{id}/Contacts (PATCH /Contacts 404, PUT 405);
  the service remembers that per tenant after the first fallback, so bulk updates don't pay 2 failing calls each.
- **No REST merge** for Companies / Contacts, Companies can't be deleted, and `Contacts.companyID` is
  read-only: only the web UI merge moves a contact. 48,355 "Gmail" placeholder companies (Nexus Z - API,
  2026-08-27 → 10-08) — see docs/MERGE.md.

## Learnings - 2026-10-13

- **Company 0 is the tenant's OWN company** (Autotask's owner account): internal
  tickets, contacts, contracts and quotes live on it. Never truthiness-check a
  company id (`!a.companyID`, `if (options.companyId)`, `id > 0`, `Number(x) ||`):
  use `!= null` / `>= 0`, and turn empty values into "missing" BEFORE `Number()`
  (`Number(null)` is 0). 15 such spots were fixed (#192); `tests/company-zero.test.ts`
  covers the main paths. Contact / ticket / resource ids are never 0.

## Learnings - 2026-10-11 (first live contract writes)

- **Creating a `ContractServiceAdjustments` answers 2xx WITHOUT an itemId** — the
  adjustment IS applied. `http.create` threw "response did not include an
  itemId", so the row was marked failed after writing. Adjustments go through
  `http.createWithoutId` and are verified by effect. The adjustment also set the
  line's `unitPrice` / `unitCost` (ContractServices) to the adjusted values.
- **`ContractCharges` need a MATERIAL COST billing code** (BillingCodes.useType 4);
  a service's recurring code (useType 5) → HTTP 500 "billingCodeID is not a
  material cost code". Created under the contract: POST /Contracts/{id}/Charges.
  New charges come back status 6 "Ready to Deliver/Ship", isBilled false.
- Reactivating an inactive contract (status 0 → 1) does NOT recreate the unit
  periods a line lost — billing only resumes from an adjustment.

## Learnings - 2026-10-11 (contracts & services)

- **`ContractServiceAdjustments` / `ContractServiceBundleAdjustments`: NOTHING is
  queryable** (every field `isQueryable:false`, entityInformation/fields). They
  can't be found again or read back — verify by EFFECT on
  `ContractServiceUnits` / `ContractServiceBundleUnits` from the effective date
  (`src/vendors/contract-io.ts`). The first version queried them for re-run
  safety and would have failed on the first live write.
- An adjustment with `contractID` + `serviceID` and no `contractServiceID` is the
  API's way to ADD a service mid-contract (`allowRepeatService` exists for it).
  Not yet exercised live — pilot one row first.
- Bundles: `ServiceBundleServices` (serviceBundleID, serviceID; create-only) are
  the components; `ServiceBundles.unitCost` is read-only (derived);
  `ContractServiceBundles.unitPrice`/`adjustedPrice`/`invoiceDescription` writable;
  BillingItems carry `contractServiceBundleID`.
- Only `contractType` 7 (Recurring Service) contracts hold services. "Active"
  (status 1) includes future renewals — match on dates overlapping the period.

## Learnings - 2026-10-11

- **`ContractServices.unitPrice` is READ-ONLY** (and `serviceID`, `quoteItemID`,
  `internalCurrencyUnitPrice`). Only `unitCost`, `invoiceDescription` and
  `internalDescription` are writable. Customer price and quantity changes go
  through `ContractServiceAdjustments` (`adjustedUnitPrice`, `unitChange`,
  `effectiveDate`); the per-period `ContractServiceUnits` row shows the result.
- A vendor loss is only "confirmed" when a posted recurring BillingItem
  (`billingItemType` 6) exists for the month; the contract price alone is a guess.
- Contracts have no `createDate` field — asking for it in includeFields fails the query.
- `.gitignore`'s `plans/` also ignores `src/plans/` — the change-plan engine lives
  in `src/change-plans/` for that reason. Check `git status` shows new dirs.

## Learnings - 2026-10-09

- **`PUT` replaces the whole record; fields left out are BLANKED** (confirmed
  from TicketHistory). The n8n routers' partial `PUT /Tickets` blanked 729
  fields on 446 tickets (location, estimated hours, contract, PO, resource +
  role). `PUT /Contacts` does the same to contacts. Typed tools PATCH only the
  fields given. `move_ticket_to_company` now carries queue / status / resource /
  UDF routing in the same write (#180).
- The activity feed (`autotask_get_activity_feed`, migration 0007) pages
  `audit_event` by **id = ingestion order**, not occurred_at. That is the only
  ordering under which late-arriving history is never skipped. Watermarks are
  re-scanned with a 15-min overlap; ingest is behind a pg advisory lock.
- Contact `note` is capped at 50 characters in this tenant (`CONTACT_NOTE_MAX_LENGTH`).
- MCP-004: TicketNotes is a shadow entity (window `createDateTime`; watermark
  `lastActivityDate` resolved from the field list; NOT yet verified live).
  TicketHistory can't be mirrored (per-ticket only). It is indexed in
  `audit_event` and served from there while the ticket's
  lastTrackedModificationDateTime ≤ indexedAt (`getTicketHistoryEvents` →
  `source`).
- MCP-007: writes are captured per tool call via AsyncLocalStorage
  (`noteOperationWrite` in `AutotaskHttpClient.request`), so any tool,
  raw_request included, gets an `_operation` with no per-tool code. Durable
  idempotency claims the key BEFORE running; "failed after writing" (partial)
  is never auto-retried.
- Shell heredoc → `node -e`/`replace()` edits silently drop backslashes and
  escaped-quote (backslash + ') sequences; use the Edit tool, or build backslashes with String.fromCharCode(92).

## Learnings - 2026-10-07

- **TicketHistory is NOT queryable by resource** ("ResourceID is not queryable") —
  only per ticket. Resource-centric audit = changed tickets first, then history
  per ticket, cached in `audit_event` (199 calls first pass → 8 cached).
- **Webhook callouts carry `PersonID`** ("the Resource ID of the user whose action
  triggered the callout in the UI") and only NEW values (update = changed fields
  only). Webhook-capable: Tickets, TicketNotes, Companies, Contacts, CIs only.
- **Who-changed is not recorded** on ServiceCalls / CompanyToDos / Opportunities /
  CIs (no lastModifiedBy); creators are. TimeEntries DO record `creatorUserID` and
  `lastModifiedUserID`; Tasks `completedByResourceID`.
- An automation completes To-Dos hourly at :17 — attributing a To-Do completion
  to its assignee produced 26 false "after-hours / missing labor" items. Such
  weak attributions are shown but never counted.
- Delete logs exist: DeletedTicketActivityLogs, DeletedTaskActivityLogs,
  DeletedTicketLogs (deletedByResourceID, deletedDateTime). No TimeSheets entity.

## Learnings - 2026-10-06

- **Autotask API limits** (official docs): **10,000 requests/hour per DATABASE**
  across all integrations; usage-based latency +0.5 s/call at 50–75%, +1 s past
  75%; **3 concurrent threads per integration per object endpoint** (4th → 429);
  queries return ≤ 500 rows **sorted by id** — loop on `id > max seen`.
- The "gds-n8n" integration in Autotask's API report IS this MCP (n8n and cron
  call Autotask through it) — ~88% of tenant calls, ~2,300/h around the clock.
- Postgres shadow (`src/db/shadow-*`, migration 0002): entity watermark fields
  verified live — Tickets `lastTrackedModificationDateTime`, TimeEntries
  `lastModifiedDateTime`, Companies `lastTrackedModifiedDateTime`, Contacts
  `lastModifiedDate`, Contracts `lastModifiedDateTime`; ContractServices /
  ContractBlocks / Resources have none (full refresh). Whole-tenant backfill ≈
  750 calls. Bulk walks pass `noCache` so pages don't sit in the HTTP cache.
- `searchContracts` uses `http.query` directly, not `queryPaged`, so it is NOT
  served from the shadow — route it through `queryPaged` to get that.

## Learnings - 2026-10-05

- **Email-created tickets keep the original message**: the email processor
  attaches it as a `message/rfc822` TicketAttachment titled "Originating
  Email" — real From / Reply-To / To / Subject / Authentication-Results.
  `utils/rfc822.ts` parses it. Which mailbox / processor rule made the ticket
  is NOT exposed by the API.
- **`GET /TicketAttachments/{id}` answers in the QUERY shape**
  `{ items: [record], pageDetails }`, not `{ item }`. `unwrapEntity` handled
  only `{ item }`, so `get_ticket_attachment` includeData returned the wrapper
  and silently skipped its parent-scope check and size cap. Fixed in
  `unwrapEntity`; check new by-id GETs for this shape.
- **TicketHistory** rows are `{action, date, detail, resourceID}`; `detail` is
  "X changed from A to B" (values may contain " to " — anchor on picklist
  labels). Actor 4 = system (workflow/triage rules); the MCP's API user shows
  up as itself. ~40% of rows are timestamp-only noise.
- Ticket UDF definitions (with list values) come from
  `Tickets/entityInformation/userDefinedFields` (`http.udfInfo`).

## Learnings - 2026-10-02

- **`ServiceCalls` has no resource field.** "My service calls on a day" is
  calls-in-window → `ServiceCallTickets` (`in` serviceCallID) →
  `ServiceCallTicketResources` (`in` serviceCallTicketID + resourceID). Scope
  the calls by date FIRST; a resource's assignment history is unbounded.
- **Open `CompanyToDos` pile up**: a live tech had 500+ never-completed To-Dos,
  all 1–12 months old, nearly all ticket-linked. "Open and due" is noise —
  window by `startDateTime` (my_day uses 7 days).
- A ticket can sit on **two service calls the same day**; a per-call gap list
  double-counts it. Gaps are per ticket.
- Status / note picklists resolve by **label** (`utils/staff-tools.ts`
  `matchPicklist`): exact label wins over a partial ("Waiting Customer" vs
  "Waiting Customer stage 2"); an ambiguous partial ("waiting") returns the
  choices. TicketNotes publish: 1 All Autotask Users (client-visible),
  2 Internal Project Team, 4 Internal & Co-Managed.

## Learnings - 2026-09-30

- **`TimeEntries.hoursToBill` is read-only** (entityInformation `isReadOnly`).
  Autotask derives it from `hoursWorked − offsetHours` plus contract/work-type
  rounding and silently ignores a supplied value — an update "succeeds" and
  changes nothing. `offsetHours` is the only API lever (#139).
- **`ResourceRoles` is query-only** (no create/update/delete) and has an
  `isActive` column. Roles 110/112 on many resources are hidden system roles:
  the `Roles` entity doesn't return them. Resolve role names with an exact
  `in` lookup of the resource's roleIDs, not one capped Roles page (#141).
- **Resource 4 is "Autotask Administrator"**, the built-in system account. It
  writes workflow-rule notes AND "Notification sent via Workflow Rule" notes
  as `noteType` 1 (the human type), so note type alone can't spot system notes.
  `noteType` 2 ("Task Detail") is almost all automation (#143/#144).
- Techs record their work in **time-entry summaries**, not ticket notes — a
  ticket can have 17 notes and none human. Anything summarising "what was
  done" must read TimeEntries (#144).
- **Notifications can't be sent through the API**: `NotificationHistory` is
  query-only and no create call triggers the UI's "notify" emails. But
  **workflow rules DO fire on API edits** (verified: API closes of client
  tickets in business hours fired "Ticket Closed - Billing Cross Check"), so
  close notifications belong in an Autotask workflow rule, not in code.
- The timesheet lock on a time-entry **create** is only knowable from the
  error (no timesheet entity); `utils/time-entry-errors.ts` maps it. Its exact
  create-time wording is still unconfirmed — extend the classifier from the
  first real case.
- GitHub occasionally **drops the push event of a merge** (no CI, no Release).
  `release.yml` has `workflow_dispatch` for that; semantic-release refuses to
  publish from a commit behind `main`, so a later merge releases everything
  since the last tag (#142).
- Ticket deep link: `<webUrl>Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketID=<id>`;
  `webUrl` comes from zoneInformation (cached with the API url).

## Learnings - 2026-09-16

- Search-tool params drift from their schemas in two directions, and **nothing
  caught either**: (a) `page` was advertised by 9 tools and honored by 2 —
  the rest read `pageSize` into `maxRecords` and dropped `page`, so page 2 returned
  page 1; (b) `search_service_calls` advertised `startAfter`/`startBefore`/`companyId`
  while the service read `startDate`/`endDate`, so every filter fell through to the
  MATCH_ALL sentinel and a 2026 query returned 2007 records. When adding a search
  tool, assert on the **filter payload sent upstream**, not on the returned rows —
  a dropped filter looks like a successful broad search.
- Autotask has **no offset parameter**; `page` is emulated by fetching `page*pageSize`
  and slicing (`AutotaskService.paginate`/`queryPaged`). Cost is O(page), so deep
  paging is expensive by construction — scope by date range first.
- `hasMore` must come from over-fetching one record past the window. The old
  `items.length >= pageSize` heuristic reported every exactly-full final page as
  "there is more".
- `childQuery` does NOT walk `nextPageUrl` — child reads (e.g. project Phases) are
  capped at one 500-record page, so paging over a child collection has a ceiling.
- `return somePromise` inside `try/catch` does not catch the rejection. The search
  methods need `return await` to keep their `catch` logging.
- `TOOL_CATEGORIES` drift is now enforced by `tests/phase2-tool-catalog-parity.test.ts`
  (registered == category union minus a meta-tool allowlist). It had silently hidden
  8 business tools from discovery, `update_contact` among them.
<!-- Record non-obvious discoveries as dated entries: "## Learnings - YYYY-MM-DD" -->

## Learnings - 2026-09-11

- The `AutotaskHttpClient` read path now FAILS CLOSED (`AutotaskResponseError`, retryable): a 2xx whose body is empty / aborted mid-read / not valid JSON (truncation) throws instead of collapsing to `null`/`[]`. Void writes opt into an empty 2xx via `allowEmptyBody`. Don't reintroduce "return undefined on parse failure" — it masquerades as not-found/zero-records.
- Autotask returns **HTTP 200 `{item:null}`** for a missing-by-id GET on several entities (not a 404). `get()`/`childGet()` route through `unwrapEntity()` which maps that to `null`; the old `res?.item ?? res` returned the truthy wrapper.
- Read-after-write: a freshly-created entity can briefly 404 (replication lag). `getWithRetry()` retries a genuine null but never a payload anomaly. Create tools flagged `verifyRead` in `CREATE_TOOL_META` (project/task/phase) attach `verified`+`item`; the create's itemId stays authoritative, so verification never fails a successful create (avoids duplicate-on-rerun).
- `TaskPredecessor` live schema (verified via entityInformation): only 4 fields — `id`, `lagDays`, `predecessorTaskID`, `successorTaskID`. The two task refs are **readonly**, so `update_task_predecessor` can only change `lagDays`; re-point = delete + recreate. Partial surface (`list`/`add`/`remove_task_predecessor`) already shipped in #46 — `get`/`search`/`update` were the real gaps (another stale-doc / #237 pattern).

## Learnings - 2026-08-10

- Issue asks can be stale: #237 claimed "no Contracts tools" but search/create/update already existed (added after the issue was filed). Always scope against `src/handlers/tool.definitions.ts` before implementing "missing" tools.
- `TOOL_CATEGORIES` in `tool.definitions.ts` is hand-maintained and drifts from `TOOL_DEFINITIONS` — nothing enforces parity (the contract write tools were absent from `financial` for months). A parity test would prevent this class of drift.
- The intent router's entity regexes (`tool.handler.ts` `routeIntent`) matched only singular nouns (`\bcontract\b` missed "contracts") until #238 added `s?`; check the other entity branches if router misses are reported.
- `exactOptionalPropertyTypes` is on: optional result-object fields need explicit `| undefined` in their type when assigned from possibly-undefined sources.
