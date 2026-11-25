# GDS Autotask MCP — Fork Changelog

This file records the GDS-specific divergence of this fork from upstream
(`WYRE-AI/autotask-mcp`). It is maintained by hand (the automated `CHANGELOG.md`
is managed by semantic-release) so the "what shipped and why" survives
independently of GitHub PR pages — e.g. after leaving the fork network.

Each entry lists the merge commit and the PR number. Brief section references
(§x.y) point at the GDS Autotask MCP Fork Implementation Brief.

---

## v6.31.0 — 2026-11-25 — Replies say numbers and names, not internal ids (voice)

- **Bug**: in ChatGPT / Copilot voice mode the assistant read out Autotask's internal ticket id ("logged time entry
  41234", "ticket 209477") instead of the ticket number and title — the tool messages only had ids to read.
- **Spoken replies name things.** A ticket is "T20261124.0042 — Printer offline", a task is its title and project,
  people are their names; ids stay in `result` for the next call. Covered: create / log / update time entry
  ("Logged 1.5 hours on T… — title for Pat Lee as Engineer — work type Remote Support"; Regular Time names its
  category), create / update ticket, add ticket update (now with the title), ticket and task notes, task get /
  create / update / complete, service-call ticket / task links and resource assignments, and create company /
  contact / project / To-Do / service call. A failed lookup falls back to "ticket 123" — it never fails the tool.
- **No ids spoken**: the time-entry role is "as Engineer", not "as Engineer (12345)"; update_ticket says "assigned
  to Pat Lee → Sam Roe", "queue → Tier 1 Support", "contact", "work type", "company" by name instead of
  `assignedResourceID 123 → 456`; "none" instead of "∅".
- **Server instructions** (sent to every AI client) gained "Speaking to people": tickets by number and title, tasks
  by title and project, labels not numbers, ids only for the next call. The stale "39 tools" list is gone.

## v6.30.0 — 2026-11-23 — Work types stay live while they're being reorganised

- **Why**: the MSP is renaming and reorganising its work types in Autotask. The v6.29.0 matching read them through
  the reference cache (up to 15 min old), and its aliases and regions were environment variables (a restart to change).
- **A name that misses is re-checked live**: before any "did you mean" / "which one?" / "no such work type", the work
  types are read again straight from Autotask (cache and mirror skipped), so a work type renamed or added minutes ago
  is found. A sure match on the cached list costs no extra call. `autotask_list_work_types` does the same before it
  reports a miss or a broken alias, and takes `refresh: true` to read live.
- **Console settings, live**: **Work type aliases** and **Regional work types** (Defaults group) take effect at once;
  `AUTOTASK_WORK_TYPE_ALIASES` / `AUTOTASK_WORK_TYPE_REGIONS` are now only their defaults. One rule per line:
  `rush=Onsite Support - Priority`, `CT=CT/Connecticut` (states with "/" or ","; the same tag on two lines adds states).
- **A region tag counts anywhere in the name**, as a whole word: "CT - Priority", "Remote Priority (CT)" and
  "Onsite - CT - Emergency" are all CT, and the tag is ignored when matching ("remote priority" → "Remote Priority (CT)"
  for a Connecticut client). Renaming work types needs no settings change as long as the tag stays in the name.

## v6.29.0 — 2026-11-23 — Work types by name ("remote priority")

- **Bug**: voice and chat users (Copilot, ChatGPT voice) said "priority remote" / "remote priority work" and the
  assistant could not log the time: the time-entry tools only took a numeric `billingCodeID` and nothing listed the
  work types, so it had no way to find the id.
- **`workType` by name** on `create_time_entry`, `log_my_time`, `add_ticket_update` and `update_time_entry` (a
  label sent in `billingCodeID` works too). Used directly only when sure: the id, an operator alias, the exact
  label, or the same words in another order ("support remote"). Filler ("work", "type") is ignored and "on-site" /
  "after hours" / "remotely" are folded, and "service" = "support" (real labels read "Remote~Priority Service";
  people say "priority remote support"). The result names the work type used so a voice user hears what was logged.
- **Never assumed**: anything looser writes nothing and asks. "priority remote" → `needs_confirmation`: "Did you
  mean Remote Support - Priority?" plus a numbered list of the similar work types (sharing a word, closest first);
  several equally good fits → that list to pick from (at most 8 offered); no fit → the similar ones, else all (the message names 8 and counts the rest). The assistant asks the
  person and re-runs with the exact name. Inactive work types never match.
- **`AUTOTASK_WORK_TYPE_ALIASES`**: tenant shorthand (`rush=Onsite Support - Priority; hot remote=102`, or JSON). An
  alias to a work type the tenant doesn't have is reported, never guessed.
- **Regional work types — `AUTOTASK_WORK_TYPE_REGIONS`**: some MSPs keep a copy of their work types per state for a
  tax rule (e.g. "CT - Priority" marks labour taxable in that state). Which copy applies depends on the CLIENT, not on
  what the tech says, so a prefix is mapped to the company State values it covers (`CT=CT,Connecticut; TX=TX`, or
  JSON). The client's state comes from the ticket's company (task → project → company; `update_time_entry` from the
  entry's ticket / task). Client in a region: only that region's work types match, prefix ignored ("priority" → "CT -
  Priority"); a name none of them fits falls back to an ordinary work type only for confirmation, with a note.
  Client elsewhere: other regions' work types are never offered. State unknown: a regional match is only suggested.
  Saying the prefix ("CT priority"), an id or an alias is explicit. Not set → nothing changes. Nothing is tenant-specific
  in the code.
- **`autotask_list_work_types`** (read-only): the active work types with their aliases and region; `name` tests what a
  spoken name matches without writing (add `ticketID` / `taskID` to match as for that client).

## v6.28.1 — 2026-11-22 — Outage breaker per module, not per tenant

- **Fix (before v6.28.0 reaches prod):** the outage breaker counted every endpoint together, so a module-only
  outage — Autotask's Quotes / Opportunities went down for 19 minutes recently, stalling a signed proposal — would
  have stopped EVERY Autotask call after 5 failures. It now keeps a breaker per endpoint: Quotes failing opens
  Quotes' breaker only (its calls fail locally, saying other modules are not affected) while tickets, companies,
  contacts and the rest carry on. The tenant-wide breaker opens only when the failures in a minute span 3 or more
  endpoints.
- Backpressure reports a module outage as `slow` with `moduleOutages: [{ endpoint, seconds }]` (hold work that needs
  it, carry on with the rest); only the tenant-wide breaker is `stop`.

## v6.28.0 — 2026-11-22 — Upstream guard: caller caps, transient retry, outage breaker (#23 §24)

- **Per-caller and tenant concurrency caps**: at most `MCP_MAX_CONCURRENT_PER_CALLER` (4) Autotask calls in flight per
  caller (the tool call's source + user) and `AUTOTASK_MAX_CONCURRENT_TOTAL` (8) for the tenant, in front of the
  per-endpoint gate. Extra calls queue; background work (mirror sync, bulk worker) counts toward the tenant cap only.
- **Transient retry for reads**: a GET / query that fails with a network error, a timeout or HTTP 502 / 503 / 504 is
  retried up to `AUTOTASK_READ_RETRIES` (2) times with exponential backoff and full jitter, its slots released while
  it waits. Writes are never retried (they may have landed), nor HTTP 500 (Autotask's validation errors), nor a
  truncated 2xx body (still fail-closed for the caller).
- **Outage breaker**: `AUTOTASK_OUTAGE_FAILURES` (5) transient failures within a minute → calls fail locally for 30 s
  with a retryable `AutotaskOutageError`; then one test call; a failed test doubles the wait (max 5 min). Backpressure
  reports it as `stop` with `outageSeconds`; the queue depth now includes the new caps.
- Closes the last item of #23 (spec §24); the rest of §24 (endpoint queue, field cache, bounded fan-out, id paging,
  correlation ids) was already in place and is now listed in docs/DESIGN.md.

## v6.27.0 — 2026-11-21 — E-mail a ticket note to the customer from any chat

- **`autotask_notify_ticket`**: posts a client-visible note and arms the tenant's notification trigger (a ticket UDF
  an Autotask workflow rule watches), so Autotask e-mails the note to the Ticket Contact and every additional contact.
  ChatGPT, Copilot, Claude and Nexus can all use it. **Tag** people by contact id or e-mail address (or the company's
  primary contact): they're added to the ticket first so they get the same e-mail; with no Ticket Contact the first
  one becomes it. Defaults to a dry run listing the recipients; every tag must resolve to one active contact of the
  ticket's company or nothing is written; a failed note disarms the trigger; `idempotencyKey` stops a second send.
- **`autotask_create_ticket_note` `notify: true`** (with `tag` / `tagPrimaryContact`; publish must be the rule's client-visible value) does the same in one call;
  without it a note still e-mails no one, and the description now says so.
- New settings `AUTOTASK_NOTIFY_UDF` (off when unset), `AUTOTASK_NOTIFY_VALUE`, `AUTOTASK_NOTIFY_PUBLISH`,
  `AUTOTASK_NOTIFY_NOTE_TYPE`; set-up in docs/NOTIFICATIONS.md.
- Checked live first (read-only, 30 days): the existing Nexus rule sent on all 22 armed tickets, to the contact and
  all 10 additional contacts on them — the gap was only that nothing but four Nexus plans could arm it.

## v6.26.0 — 2026-11-19 — Integration API: picklist labels (company type for CRM sync)

- **`PicklistLabels`** on `/api/v1` reads: a query with `"PicklistLabels": true` (or a by-id read with
  `?picklistLabels=true`) adds `picklistLabels: { field: label }` to each row, so a CRM sync shows a company's type
  (Customer, Lead, Prospect, Vendor, Partner …) and every other picklist by the tenant's own labels. An unknown id
  gives `null`; if the field list can't be loaded the rows still come back and `X-PSArelay-Labels: unavailable`
  says so.
- **`GET /api/v1/{Entity}/entityInformation/fields`**: Autotask's field list (picklist values and labels included)
  for any entity the key may read or write, for systems that keep their own lookup table. Cached by the HTTP layer
  (1 h), so at most one Autotask call per entity per hour.

## v6.25.0 — 2026-11-19 — Sales-cycle correlation, checks and repair (#20 §7)

- **`autotask_report_sales_cycle`** (read-only): each opportunity with the quotes, contracts and projects that carry
  its `opportunityID` (Autotask's own links — nothing inferred is stored), its outcome from the status label (Closed /
  Won / Implemented = won, Lost = lost, else open) and findings: `company_mismatch` (a linked record on another
  company), `won_no_delivery`, `lost_with_delivery`, `won_no_quote`, and `unlinked_delivery` — a contract / project
  with no opportunity on a company whose won deal has none of that kind, starting 30 days before to a year after the
  close. One candidate → a suggested link with a ready dry-run repair call; several → listed for the user to pick.
  Scope by opportunity, company or `createdSince` (capped, `truncated` flag). Each entity's `opportunityID` is checked
  against the live field list first; a tenant without it skips that entity and says so.
- **`autotask_link_to_opportunity`** (repair, dry run by default): sets a contract's or project's `opportunityID`.
  Same-company check, writable-field check, an existing link is replaced and reported, read back after the write;
  already linked → nothing written. Projects go through `autotask_link_project_commercial`'s path.
- Not yet exercised against the live tenant (whether `Contracts.opportunityID` is writable here is unverified — the
  tool checks entityInformation and refuses if not).

## v6.24.0 — 2026-11-19 — Contract labour report: covered vs excluded, burn, forecast (#22)

- **`autotask_report_contract_labour`**: one contract, month by month (default the last 6 months, max 24). Each time
  entry is classified as covered, excluded (an excluded role or work type from the contract's terms — billed
  separately) or non-billable. Block hours drawn apply the contract's block-hour factors to `hoursToBill` (else
  `hoursWorked`). For block-hour contracts each month shows allocated, remaining, overage, forfeited (ended months
  only, use-it-or-lose-it) and burn %. Totals by role and by resource with names, up to 50 excluded entries to
  check, and a current-month forecast: calendar-day pace and the trailing 3-month average against the allocation
  (`under` / `on_track` / `over`). Read-only; one time-entry query scoped to the contract and the window.
- `autotask_report_block_hour_usage` is unchanged (all contracts, no factors / exclusions).
- Not yet exercised against the live tenant.
## v6.23.0 — 2026-11-19 — Ticket additional contacts (#266)

- **`autotask_list_ticket_additional_contacts {ticketID}`**: the contacts on a ticket besides its Ticket Contact
  (TicketAdditionalContacts), each with contactID, name, e-mail and active flag, plus the ticket's company and
  Ticket Contact.
- **`autotask_add_ticket_additional_contact {ticketID, contactID}`**: safe to repeat — a contact already on the
  ticket answers `already_there` and nothing is written. Refuses, writing nothing:
  - a contact from another company than the ticket's (company 0 safe);
  - an inactive contact (`isActive` 0 / 1);
  - the ticket's own Ticket Contact (`already_ticket_contact`), because Autotask would clear the Ticket Contact field;
  - a 31st contact (Autotask's limit is 30).

  Writes through `/Tickets/{id}/AdditionalContacts` and reads the link back. A create that errors but landed is
  reported as added.
- **`autotask_remove_ticket_additional_contact {ticketID, contactID}`**: removes the link only, never the contact,
  and needs `confirm:true`. A contact not on the ticket answers `not_there`.
- **Fix:** `ticketAdditionalContacts` on `autotask_create_ticket` / `autotask_update_ticket` was copied into the
  Tickets payload, but Tickets has no such field (it is a child entity). Those ids are now added after the ticket
  write through the guarded add, and each one's outcome is in the result.
- **`autotask_search_contacts` (plain mode)**:
  - every item now carries **`primaryContact`**, always `true` / `false` (Autotask may send 0 / 1 or leave it out);
  - a new optional `primaryContact` boolean filter: `{companyID, primaryContact: true}` returns the account's primary
    contact in one call. Before, the flag was only on `get_contact`, one read per contact.
- Use case: Nexus reboot reminders e-mail one ticket note to the device contact and the account's primary contact.
- Not yet exercised against the live tenant. The URL shape and rules follow the Autotask REST reference.

## v6.22.0 — 2026-11-18 — Contract terms: blocks, rates, exclusions, retainers, ticket purchases (#22)

- **`autotask_list_contract_terms`**: every billing term on a contract in one read — prepaid hour blocks,
  block-hour factors, role rates, role costs, excluded work types and roles, retainer purchases, ticket purchases —
  with the contract type and counts. A kind that fails to read is reported, the rest still come back.
- **`autotask_create_contract_term` / `update_contract_term` / `delete_contract_term`**: one family, `kind` picks the
  entity. Writes go through `/Contracts/{id}/{Child}`; fields are checked against the live field list (unknown and
  read-only fields refused, required ones enforced, picklists such as status / paymentType by exact label). A block
  must be on a Block Hours contract, a retainer on a Retainer one, a ticket purchase on a Per Ticket one. A create
  matching an existing row (same role / billing code, or same dates and quantity) is a duplicate unless
  `allowDuplicate`; a create that errors but landed is reported, never posted twice. Only the operations Autotask
  allows per kind (exclusions: create / delete; blocks, role costs, retainers, ticket purchases: create / update).
  Dry run by default, `confirm:true` for the write, read back afterwards.
- Not yet exercised against the live tenant (entity operations follow the Autotask REST reference).

## v6.21.0 — 2026-11-18 — Resumable project build with resources, dates and notes; clone a project (#46, #20)

- **`autotask_clone_project`**: copy a project's phases (nested), tasks, hours, task types, descriptions and
  dependencies into a new project for any company (0 included). Task dates move with the new start date (default
  today); resources and the project lead only with `includeResources`. Dry run by default; built by the build
  engine, so re-running the same clone finishes a partial one (build key `clone:<source>:<company>:<name>`).
- **Build engine** (`build_project_from_plan`, `extend_project`): tasks can carry their resource (role defaults to
  the resource's default role) and dates; plans can carry project notes (never written twice, by title). On resume a
  reused task missing its planned resource or dates gets them; the dry run of a resume says what is still missing.
- **Fixed: same-titled tasks were merged.** Resume matched tasks by title across the whole project, so "Install AP"
  under Site A and Site B became one task. Phases now match by (parent, title) and tasks by (phase, title), each
  existing record used once; a task moved to another phase still matches when its title is unique.
- **Fixed: resume on a project with more than 100 tasks re-created tasks 101+** (the existing tasks were read through
  a 100-row page). The build now reads phases / tasks / notes directly, and if that read fails it creates nothing.
- **Fixed: `projectDefaults` never reached Autotask** — `projectType` / `startDate` / `endDate` were sent under those
  names. They map to `type` / `startDateTime` / `endDateTime`; a new project's missing type, status and dates
  default to Client, New, first task start (or today) and last task end (or start + 30 days), listed in
  `defaultsApplied`.
- Not yet exercised against the live tenant.

## v6.20.0 — 2026-11-17 — Close an opportunity as won or lost, with its delivery project (#20)

- `autotask_close_opportunity` (financial, **dry run by default**; the write needs `dryRun:false` + `confirm:true`):
  won → status "Closed", lost → "Lost", resolved by label from the tenant's picklist (`status` overrides a renamed
  label). Sets the close date (default today; noon UTC so the day never shifts), lost date, probability 100 / 0 and the
  win / loss reason + detail — only the fields this tenant has and can write; a missing one is reported (`notSent`),
  an unknown reason label returns the choices. Already closed that way (won also counts "Implemented") → nothing written.
- Won + `createProject:true` also creates the delivery project: type Client, status New, linked by `opportunityID`,
  lead = the opportunity owner, start = close date, 30 days unless dates are given. A project already linked to the
  opportunity is reused, never duplicated; a project failure after the close is reported as `partial` and a re-run
  retries only the project. Read back after writing (`notApplied`).
- `autotask_update_opportunity` now points to it for closing.
- Not yet exercised against the live tenant: the win / loss reason and date field names come from the API reference
  and are only sent when the live field list has them.

## v6.19.0 — 2026-11-17 — Project charges, company locations, sales follow-ups (#20, #21, #22)

- **Project charges** (#20): `autotask_get/search/create/update/delete_project_charge(s)` — the ticket-charge tools for
  projects. Writes go through the project (POST / PATCH /Projects/{id}/Charges); create and update are financial
  (`confirm:true`) and refuse internal text in the invoice name / description; update PATCHes only the given fields and
  reads back old → new (shared with `update_ticket_charge`); delete reads first and refuses a billed charge.
- **Company locations** (#22): `autotask_get/search/create/update_company_location(s)` through
  /Companies/{id}/Locations. Company 0 works. Create returns an active location with the same name instead of a second
  one; update sends only fields that differ and reads back. No delete in the API: retire with `isActive:false` (the
  primary is refused — make another primary first).
- **`autotask_create_sales_followup`** (#21 §9, the last staff tool): a Company To-Do for the caller (or a named
  salesperson) on an opportunity, contact or company — the company is taken from the opportunity / contact and a
  mismatch is refused. Due `when` (local, offset ISO, or a date → 09:00), `inDays` business days, or the next business
  day 09:00 in the salesperson's timezone; action type "Sales" (or the closest label); the same open follow-up on that
  day is returned instead of a second one; `dryRun` previews.
- Not yet exercised against the live tenant: ProjectCharges / CompanyLocations writes and their field lists are taken
  from the API reference.

## v6.18.0 — 2026-11-16 — Appointment tools: book, move, cancel, and find free time (#21)

- Six tools in a new `appointments` category: `autotask_get_appointment`, `autotask_search_appointments` (overlap
  window, one or more resources, from the mirror), `autotask_create_appointment`, `autotask_update_appointment`,
  `autotask_delete_appointment` and `autotask_get_resource_availability`.
- Times: offset ISO, or local wall-clock + `timeZone` (default the resource's location timezone); stored in UTC,
  answered with `startLocal` / `endLocal` too.
- Booking checks the person's other appointments and the service calls they are on: an overlap returns `conflict` and
  writes nothing unless `allowOverlap`. The same resource + title + start + end returns the existing appointment
  (`exists`), so a retry never double-books. Updates PATCH only what changed; moving keeps the length. Delete reads
  first and says what it removed. Create acts as the caller when no resource is named.
- Availability: per person, busy blocks + free slots inside working hours (default 08:00–17:00, weekdays, 30+ minutes,
  nothing before now); with several people, `allFree` = when all of them are free. Up to 10 people, 14 days.
- `autotask_get_my_day` now lists the day's appointments (one more read; from the mirror when it is on).
- Not yet exercised against the live tenant: the Appointments field list was taken from the API reference.

## v6.17.3 — 2026-11-15 — update-psarelay removes old PSArelay images still tagged

- `docker image prune -f` only removes untagged images, so images under the pre-rename name
  (`ghcr.io/gdstechnology/autotask-mcp:latest` / `:rollback`, ~330 MB each) and stray version tags stayed on disk
  after the cutover. Every run now removes them by name, keeping `psarelay:latest`, `psarelay:rollback` and any tag
  a container is named by (`docker rmi` without `-f`; only the two PSArelay names are touched).
- The prod host was cleaned by hand the same day; the script covers other installs and future version tags.

## v6.17.2 — 2026-11-15 — Ticket history index keeps every field changed in one save (#210)

- The rows of one TicketHistory save share an id and a timestamp; the ledger keyed them `th:<id>`, so only the first
  was kept (ticket 211214: 10 rows live, 3 indexed; a company change in the same save as another field vanished).
  Nexus reads this history to learn from technicians' spam and queue moves.
- Keys are now `th:<id>:<12 hex>` = md5(historyAction | field | old | new | unparsed detail), built only from stored
  columns. The index read no longer maps parsed values by history id (it collided the same way).
- Migration 0026 re-keys the stored rows in SQL (same hash; checked against the code on Postgres 16) and clears
  `ticket_history_fetch`, so each ticket's next history read goes live once and fills in the dropped rows. No sweep.

## v6.17.1 — 2026-11-15 — Webhooks refresh every mirrored entity without sending searches live

- TicketNotes and ConfigurationItems webhook callouts now queue the changed row for a re-read, like Tickets,
  Companies and Contacts (they were only written to the audit log: the mapping predated those entities' mirrors).
- A webhook callout queues the row with the new `markStale` instead of `markDirty`. `markDirty` means "PSArelay just
  wrote this" and sends every search of the entity live (or to 503 for a mirror-only API key) for 90 s, so busy
  Tickets / Contacts webhooks could keep the mirror from answering at all. Now only a by-id read of the changed row
  goes live until the next run re-reads it.

## v6.17.0 — 2026-11-15 — Webhooks can watch user-defined fields (#256, e8a136a)

- `autotask_create_webhook` takes `udfFields`: `[{ udfFieldID }]` or `[{ name }]`, plus `isSubscribedField` /
  `isDisplayAlwaysField`. A name is looked up in the webhook's UDF list (the `udfFieldID` picklist of
  `<Entity>WebhookUdfFields`), on the dry run too, so the plan shows the ids. An unknown, ambiguous or unreadable name
  fails before anything is written and lists the UDFs that exist. Duplicates are sent once.
- Why: a Contacts webhook must watch an app-user UDF so the mirror hears about link changes that don't move
  `lastModifiedDate`. Before this, the UDF row needed a raw request.
- Not verified live: that the picklist lists UDFs by name (if not, a name fails cleanly and asks for the id).

## v6.16.0 — 2026-11-12 — Appointments mirrored and writable through the integration API (#255, bc384bd)

- Mirror: `Appointments`, windowed by `startDateTime` (every future booking is mirrored); incremental on
  `updateDateTime` when the tenant's field list has it, otherwise re-read hourly. No migration.
- Integration API: Appointments is writable (create, PATCH to move / rename, DELETE to cancel when the key may delete).
- `docs/INTEGRATION_API.md` gains a Bookings section (Appointments vs service calls).

## v6.15.0 — 2026-11-11 — Integration API writes (#254, 7668e1a)

- Keys may create, update and delete through PSArelay: per key "May write" entities (none by default), "May delete"
  and writes per hour (default 200). Migration 0025 (`api_key.write_entities`, `allow_delete`,
  `write_hourly_limit`; `api_key_write` log).
- `POST /api/v1/{Entity}`, `PATCH /api/v1/{Entity}` (`{ id, …fields }`), `DELETE /api/v1/{Entity}/{id}` and
  Autotask's child URLs. PUT is refused (it blanks unsent fields). Financial entities aren't writable here.
- Writes use PSArelay's own Autotask connection (thread gate, 429 cooldown), are refused under backpressure "stop"
  and when the read-only switch or a read-only plan is on, and the mirror re-reads what they changed.
- `Idempotency-Key` is claimed before the write: a repeat replays the first answer; an unclear one (timeout) is never
  re-sent. Every write is logged; the Integrations page lists recent writes.
- Why: the time module needs to log time, and the point of the API is that all of a tenant's Autotask traffic goes
  through PSArelay, which knows the limits.
- Fix: the Keys panel showed the text "null", and the key name box was unstyled.

## v6.14.0 — 2026-11-11 — Integration read API (#253, 21d49de)

- `/api/v1` on the MCP port, in Autotask's request shapes: `POST /{Entity}/query`, `GET /{Entity}/{id}`, `GET /`
  (key, caps, use, freshness). Answered from the Postgres mirror (no Autotask call); headers say mirror / live and the
  copy's age.
- A mirror miss answers 503 with the reason, unless the key allows live reads (one call, within its live cap, never
  under backpressure).
- Keys (`psk_`, migration 0024): their own table, so a key never opens `/mcp` and an MCP token never opens `/api/v1`.
  SHA-256 only, shown once. Per key: entities, live, outside use (off = private network only), hourly caps, expiry.
  New console page **Integrations**; create / edit / revoke are logged.
- Why: time / CRM modules and report jobs stop counting against the tenant's 10,000 calls/hour and 3 threads per
  endpoint.

## v6.13.0 — 2026-11-05 — Create and update catalog Services (#252, 16c429c)

- `autotask_create_service` / `autotask_update_service`: financial, dry run by default, writes need
  `dryRun:false` + `confirm:true`. Fields checked against the tenant's live Services field list; `periodType` by id or
  label; the billing code must exist and be active; 0 is a valid price or cost.
- Duplicates: an exact SKU always refuses; an exact name refuses unless `allowDuplicateName`.
- Update PATCHes only changed fields and shows every before → after (a PUT-only zone gets the full merged record);
  read back after every write. A create whose POST errors re-reads the catalog instead of posting twice.
- Read-only: `autotask_get_service_field_info`, `autotask_find_service_by_sku`, `autotask_validate_service`.
- Customer-facing text is refused if it carries cost / markup / supplier notes.

## v6.12.1 — 2026-11-05 — Ticket charges can be corrected; no cost on invoice text (#251, df5b068)

- `update_ticket_charge` PATCHes `/Tickets/{ticketID}/Charges` (TicketCharges has no top-level update route: PATCH
  404, PUT 405), reads the charge back and reports each field old → new.
- Charge names / descriptions print on the invoice: create / update refuse cost figures, markup, supplier / pickup,
  serial-number or PO notes (`allowInternalText` for a false alarm); `add_ticket_materials` likewise.
- Why: a charge went on with our cost and markup in its description, and the correction failed.

## v6.12.0 — 2026-11-05 — Ticket materials (#249, b68ed2d) and customer re-engagement report (#250, 1a5abef)

- `autotask_add_ticket_materials`: ticket number + `{ query or productId, quantity }` per line; resolves only when
  unambiguous, prices from the catalog, charge type / status from picklist defaults; a product already on the ticket
  is skipped. Dry run by default; writes need `confirm:true`; each charge is read back. `find_product` returns prices;
  `billableToAccount` now maps to `isBillableToCompany` (it was ignored).
- `autotask_report_customer_reengagement`: last customer-facing touchpoint per active customer company, from the
  mirror in three SQL reads (0 Autotask calls). Only work by a person counts (published notes, time, CRM to-dos,
  opportunities, service calls; never resource 4, API users or the MCP). Optional .xlsx.

## v6.11.0 — 2026-11-02 — Every read tool is marked read-only (#248, 5ce83b9)

- 63 read tools had no `readOnlyHint`, so Microsoft 365 Copilot asked the person to Confirm every lookup. Every
  get / search / list / find / query / count / report tool is now read-only unless it writes; a test checks the
  marker reaches clients in a real `tools/list`.

## v6.10.2 — 2026-10-27 — "My day" readable; "my tickets" (#247, a013480)

- `autotask_get_my_day` assigned tickets carry status / priority / queue labels, the company name and a ticket link;
  missing-time items name their ticket.
- `search_tickets` `assignedToMe: true` fills the resource from the verified sign-in.

## v6.10.1 — 2026-10-26 — "Act as me" knows a signed-in person (#246, 9271299)

- `resolveCaller` uses the identity of a verified token (Copilot SSO, console-login sign-ins), so my-day, log-my-time
  and the other act-as tools stop asking "who are you?".
- `search_tickets` rows carry status / priority / queue labels and a ticket link.
- Microsoft 365 links record "Last used" (at most one write per person per 5 minutes).

## v6.10.0 — 2026-10-26 — Microsoft 365 Copilot single sign-on (#245, a351b18)

- Copilot's Entra SSO sends the person's Entra token on `/mcp`; PSArelay verifies it against Microsoft's published
  keys (trusted tenants, audience, the Enterprise token store as client, expiry, scope, no guests).
- The person is linked to their Autotask resource when exactly one active resource matches (email / email2 / email3,
  then userName); API users (`licenseType` 7) and resource 4 are never linked. Unlinked people are told to ask their
  administrator and nothing runs. New console page **Microsoft 365**. Migration 0023.

## v6.9.0 — 2026-10-26 — Copilot can connect; administrators choose AI clients (#244, c4123c4)

- Copilot's connector registers by DCR but needs a client secret: `/oauth/register` issues one for
  `client_secret_post` / `_basic` and for an unspecified method (checked only when sent). Public clients unchanged.
  Only the hash is stored (migration 0022).
- Settings → Security → **AI clients allowed to connect** (default all; `MCP_AI_CLIENTS`): an unticked client is
  refused at registration and sign-in, its sign-ins end at the next refresh, and its card is hidden on Connect.

## Unreleased — Console: free-trial strip and "Choose a plan"

- A strip under the top bar on every page while the plan is a trial or read-only: days left, read-only, and
  **Choose a plan**; an ended trial shows it in red.
- Plan page: a "Keep PSArelay after your trial" panel (plan picker, note, **Request this plan** → `platform.plan_requested`).
- Settings: **Allow write tools** is disabled with the reason while the plan is read-only; the dashboard no longer
  shows the generic read-only banner for a read-only plan.

## Unreleased — Free trials and read-only plans in the licence

- Licence claims `trial` and `readOnly` (a trial is read-only unless `readOnly: false`). A read-only plan
  locks every write tool like a missing module (refused with how to choose a plan, listed as 🔒), stops the
  bulk worker, and refuses turning **Allow write tools** on (`409 plan_read_only`; the setting shows `lockedByPlan`).
- An ended trial has no grace period: every module is locked until a plan is chosen; discovery tools, setup and
  the console stay open. The Plan view adds `trial`, `readOnly` and `writeLock`; the detail shows days left.
- `PSARELAY_LICENSE_FILE`: the control plane can rewrite the licence file to renew, upgrade or end a trial
  without a restart (re-read every minute). A missing, unreadable or empty file gives core only, never self-hosted.
- `POST /api/plan/request` with `plan` sends the new `platform.plan_requested` notification (billing stays
  with the provider: GDS invoices).

## Unreleased — Deploy runbook matches the live layout

- `DEPLOY.md` described a `scripts/build-image.sh` + `docker run --name autotask-mcp`
  deploy that is not what runs. Prod (verified 2026-09-29) is a single `autotask-mcp`
  service in the `n8n` compose project (`/opt/n8n`, container `n8n-autotask-mcp-1`,
  `127.0.0.1:18080`) tracking the `:latest` image published by `release.yml`. The
  runbook now covers that path: back up `{{.Image}}` of the live container, then
  `docker compose pull/up -d autotask-mcp`, then check `version` in `/health`.
  Rollback re-pins the saved image ID in the compose file.
- `deploy/docker-compose.prod.yml` is kept but now opens with a header saying it
  is the reference **target** two-instance design. There is no `autotask-mcp-gpt` /
  `:18081` in prod.

## Unreleased — Phase 2 P0 repair & foundation

Completes the P0 "Repair & Foundation" block of the Phase 2 Development &
Testing punch list (2026-09-16) — items 1-5 (the reported defects and the
contract tests around them) and items 6-8 (the write foundation).

Two defects were reported; both turned out to be instances of wider classes, and
two of the three remaining items turned out to be partly built already. The audit
is what this entry mostly records. Field names and mutability below were read from
this tenant's live `entityInformation/fields`, not assumed.

### Safe orchestration — MCP-CORE-004 / MCP-CORE-005
- `dryRun` existed on exactly one tool (`create_maintenance_ticket`), written inline.
  Extracted to `utils/write-plan.ts` as the shared envelope every orchestrating
  write now returns: `{ status, validation, ... }` where status is
  `validation_failed` | `duplicate` | `dry_run` | a tool-specific success label,
  and anything but the success label means **nothing was written**. `validation`
  is the ordered trail of every precondition checked, including the ones that
  passed — that is what makes a dry run reviewable. The orchestrator was
  refactored onto it with its 16 existing tests unchanged, which is the evidence
  the abstraction did not bend its contract.
- Read-after-write coverage extended: `create_configuration_item` is registered
  in `CREATE_TOOL_META` with `verifyRead`, and `link_project_commercial` confirms
  field-by-field that the write actually landed.

### Configuration item lifecycle writes — MCP-CI-001
- CI reads (search, entitlement, coverage gaps) were strong; there were **no CI
  write tools**. Adds `autotask_create_configuration_item` and
  `autotask_update_configuration_item`.
- The service had `createConfigurationItem`/`updateConfigurationItem` already, but
  they were unguarded passthroughs over the top-level `POST /ConfigurationItems`
  route with **no callers anywhere** — dead code. Replaced.
- Live schema (`ConfigurationItems/entityInformation/fields`) drove the design:
  `companyID` is REQUIRED but READ-ONLY, so creation goes through the
  `Companies/{id}/ConfigurationItems` child route (§4.2 precedent) and a CI can
  **never be moved between companies** — the update path refuses it with that
  explanation. There is no lifecycle/status picklist on the entity either, so
  retire is `isActive: false`.
- Writes are filtered to the 33 fields Autotask actually accepts; the read-only
  `rmm*`/`ssl*` audit surface it populates from the RMM integration is dropped
  with a warning instead of failing the write.
- Guards Autotask does not enforce: a referenced contract or parent CI must
  belong to the same company as the CI. A CI covered by another company's
  contract reports false entitlement.

### Project commercial linkage — MCP-PROJ-001
- Neither `create_project` nor `update_project` exposed `contractID` or
  `opportunityID`, so a project could not be attached to the commercial record it
  bills against. Both are writable on Projects (verified live).
- Adds `autotask_link_project_commercial`: validates that contract and
  opportunity belong to the **same company as the project** (Autotask will
  happily point a project at another company's contract, silently misrouting its
  billing), that the contract is active and unexpired, skips a no-op re-link as
  `duplicate`, supports `dryRun`, and reads the link back field-by-field.
- Three fields `update_project` advertised are not writable Projects fields at
  all and were being forwarded to no effect: `estimatedTime` (read-only, rolled
  up from tasks) and `assignedResourceID`/`assignedResourceRoleID` (Task fields).
  They remain accepted as arguments so nothing breaks, are marked IGNORED in
  their descriptions, and are no longer sent upstream.
- The department field is `department`, not the advertised `departmentID`, so
  that value was silently dropped on every update. Both spellings now work.

### Tests (items 6-8)
- `tests/phase2-write-foundation.test.ts` — the envelope's no-write invariant, CI
  child-route creation, the read-only `companyID` refusal, unwritable-field
  stripping, both cross-company ownership guards, dry-run, duplicate detection,
  and `verified: false` when a write is accepted but not applied.
### Pagination — MCP-DEF-001 / MCP-CORE-001
- **`page` was accepted and discarded by 7 of the 9 search tools that advertised it.**
  Only `searchCompanies` and `searchTasks` honored it; every other search read
  `pageSize` into `maxRecords` and ignored `page`, so page 2 re-issued the same
  first-N query and returned page 1's records while reporting itself as page 2.
  Reported against `autotask_search_time_entries`; also affected tickets,
  contacts, projects, resources, billing items and approval levels. `page` is now
  also exposed on `search_service_calls` and `list_phases`, whose services gained
  paging here.
- Added `AutotaskService.paginate()` / `queryPaged()` — one implementation of the
  fetch-and-slice pattern Autotask's cursor-only API forces (no offset parameter),
  replacing the copy that existed in two methods and was missing from eight.
- Search methods now return `PagedResult<T>` (`items`, `page`, `pageSize`,
  `hasMore`) instead of a bare array, and the handler carries that metadata into
  the compact response. **`hasMore` is now honest:** it comes from over-fetching a
  single record past the window, not from `items.length >= pageSize`, which
  reported every exactly-full final page as "there is more".

### Service call date filtering — MCP-DEF-002 / MCP-CORE-002
- `autotask_search_service_calls` advertised `startAfter`/`startBefore`/`companyId`
  while the service only read `startDate`/`endDate`. Every filter was dropped and
  the query fell through to the MATCH_ALL sentinel — a request scoped to 2026
  returned service calls from 2007. Both bounds now constrain `startDateTime`
  (the old upper bound filtered `endDateTime`, dropping any call that started
  inside the window but ran past it); `startDate`/`endDate` remain as aliases.
- `searchResources` likewise dropped the advertised `isActive` and `resourceType`.

### Tool catalog parity — MCP-CORE-003
- 8 registered business tools were unreachable through category discovery:
  `update_contact`, `find_or_create_contact`, `update_project`,
  `get_invoice_details` and the four `ticket_checklist_item` tools. All are now
  categorized; the 5 remaining uncategorized tools are meta-tools (discovery,
  router, raw escape hatch) and are allowlisted as deliberate.

### Tests (items 1-5)
- `tests/phase2-pagination-contract.test.ts` — table-driven across all 10
  paginated searches: page advances, no duplicate ids across pages, the walk
  terminates, `pageSize` is respected, a full final page reports `hasMore: false`,
  and a page past the end is empty rather than a repeat of page 1. Plus an
  end-to-end check that the metadata survives into the tool response.
- `tests/phase2-date-filter-contract.test.ts` — asserts on the filter payload sent
  upstream, so a rename on either side of the schema/service boundary fails here
  instead of silently returning the whole table.
- `tests/phase2-tool-catalog-parity.test.ts` — registered tools == category union
  (minus the meta-tool allowlist), no phantom or duplicated entries. Closes the
  drift class that had gone unenforced for months.

---

## 2.19.0-gds — 2026-08-26 — First GDS production release

Cut over live on **the production host** (docker-compose, local build from this fork,
`/health` → `2.19.0-gds`), replacing the upstream `ghcr.io/wyre-technology/autotask-mcp`
pinned image. All items below verified against the code with mocked-HTTP unit
tests (316 passing at release).

### Route & payload correctness (Phase 1)
- **#2 (`fd69545`) — child-route creates + ticket role (§4.2–4.4).**
  `createContact` → `POST /Companies/{companyID}/Contacts` (companyID required);
  `createServiceCallTicket` → `POST /ServiceCalls/{id}/Tickets`;
  `createServiceCallTicketResource` → `POST /ServiceCallTickets/{id}/Resources`;
  restored `assignedResourceRoleID` to the ticket writable-field allowlist so
  typed assignment updates keep the role Autotask requires.

### HTTP layer
- **#3 (`bf78601`) — batched `in` query helper (§7.19).** `AutotaskHttpClient.queryByIds()`:
  dedupe + sort IDs → 200-per-chunk `in` queries under bounded concurrency →
  paginate each chunk → dedupe by id → surface per-chunk failures. (Cursor
  pagination §7.18 and 429/threshold handling §7.2 already existed in `query()`/`request()`.)

### Safety & resolution
- **#4 (`ad108a8`) — canonical reference resolver + protected-company guards (§7.30–7.31).**
  Read-only `autotask_resolve_record_reference` resolves a `T…` number to a
  single Ticket **or** Task (queries both, never infers from the prefix;
  matched/ambiguous/not-found). `utils/company-guard.ts`: `updateCompany` refuses
  to rename/reclassify/deactivate protected accounts (company `0` +
  `AUTOTASK_PROTECTED_COMPANY_IDS`); `createCompany` rejects non-company names
  (webmail/greeting/CTA/sentence).

### Response normalization
- **#5 (`3eabb99`) — one create-result contract (§5/§7.1).** Every create tool
  returns `{ id, entityType, parentType?, parentId? }` as `data`, normalized once
  centrally in `callTool` via `utils/create-result.ts` + `CREATE_TOOL_META`. (BREAKING:
  create `data` was a bare number → now `data.id`.)
- `c5cddf9` — follow-up: register `autotask_create_company_todo` in `CREATE_TOOL_META`.

### Calendar / executive-assistant objects (Phase 2)
- **#6 (`57618c4`) — CompanyToDos + router intent (§4.1/§4.10).** Six typed tools
  (get/search/create/update/complete/delete) via company child routes; actionType
  resolved from live picklist metadata (default "General"); `completedDate`
  completion; open-only search. Router matches a To-Do/follow-up intent before
  time-tracking so "sales follow-up To-Do" no longer misroutes to a time entry.

### Validation & tenant-aware resolution
- **#8 (`f65543e`) — owner / note limit / name search / opportunity update (§6.1–6.3, §4.7).**
  `createCompany` resolves `ownerResourceID` (supplied or
  `AUTOTASK_DEFAULT_OWNER_RESOURCE_ID`) and fails fast otherwise; contact `note`
  validated to 50 chars (opt-in `truncateNote`); contact search builds a combined
  firstName+lastName group + exact-email match; added `updateOpportunity` +
  `autotask_update_opportunity` via collection `PATCH /Opportunities`.

### Ticket & time completeness (Phase 3)
- **#9 (`355c50c`) — ticket-create fields, move-ticket, time-entry CRUD (§4.5/4.6/4.8).**
  Added `dueDateTime`/`companyLocationID`/`configurationItemID` to ticket create/update;
  `autotask_move_ticket_to_company` (resolves the target company's primary
  `CompanyLocations`, sets companyID+companyLocationID together, clears the
  contact unless supplied, refuses to move a CI-linked ticket unless forced,
  reads back); `autotask_get_time_entry` + `autotask_update_time_entry` (fractional
  hours, `hoursWorked` vs `hoursToBill`, `showOnInvoice`/`billingCodeID`).

### Build, dependency & release (Phase 5)
- **#7 (`7cdd90f`) — dependency source (deps).** Repointed dev-only `autotask-node`
  from the private `@wyre-technology` GitHub Packages alias to the public
  `github:GDSTechnology/autotask-node` fork (pinned), so `npm ci` needs no
  registry token.
- **#10 (`d088931`) — token-free Docker + release tooling (Phase 5).** Dockerfile
  drops the private-registry `.npmrc`/`GITHUB_TOKEN`; `scripts/build-image.sh`
  builds a traceable image (VERSION/COMMIT_SHA/BUILD_DATE → `/health`);
  `DEPLOY.md` deploy + rollback runbook for the production host.

### Housekeeping
- `fa5918f` — removed a stray `file:../autotask-node` link + lockfile churn that
  the initial Phase-1 PR (#1, `e476e5b`/`701c7df`) had bundled onto `main`.

---

### Notes
- **autotask-node** is a public GDS fork (`github:GDSTechnology/autotask-node`),
  dev-only — the runtime is a native-`fetch` client; the SDK is pruned from the
  production image.
- **Independent project:** this is a standalone GDS Technology project, originally
  derived from `WYRE-AI/autotask-mcp` (Apache-2.0) and now developed separately.
  The GitHub fork relationship and the `upstream` tracking remote have been
  removed; the codebases have diverged and are no longer reconciled.
