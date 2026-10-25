# Optional PostgreSQL layer — dev setup & operations

Phase 2 of the Expansion & Deployment spec (§17, issue #18). PostgreSQL is an
**optional** cache / correlation / history / work-buffer layer. Autotask stays
authoritative; every operational mutation still commits to Autotask. The whole
layer is **disabled by default** (`MCP_PG_ENABLED=false`) and every capability is
behind its own flag, so the server runs exactly as before with no database.

## Isolation (non-negotiable)

- Dedicated database **`gds_autotask_mcp`**, schema **`autotask_mcp`**.
- Three roles: **owner** (owns objects, NOLOGIN), **migrator** (LOGIN, runs DDL),
  **app** (LOGIN, DML only — the MCP's runtime identity, never DDL).
- **Never** reuse the n8n / Hermes / control-plane databases, schemas, or roles,
  and never point this at those. The prod target is its own VPS DB.

## Local test database (dev machine)

A standalone, opt-in Postgres in `dev-postgres/` — separate from the app compose so
it can never ship to production. Host port **5433** (avoids clashing with any other
local Postgres); the role model matches prod.

Bring it up:

```bash
docker compose -f dev-postgres/docker-compose.yml up -d
```

Verify roles, schema, and app-role connectivity:

```bash
docker exec gds-autotask-mcp-devpg psql -U gds_autotask_mcp_app -d gds_autotask_mcp -c "select current_user, current_schema; \du"
```

Tear down and wipe (also required before re-running the init script):

```bash
docker compose -f dev-postgres/docker-compose.yml down -v
```

Dev-only credentials (defaults in `dev-postgres/docker-compose.yml`, override via
its own env): superuser `postgres` / `devsuperpass`, migrator
`gds_autotask_mcp_migrator` / `devmigrate`, app `gds_autotask_mcp_app` / `devapp`.
These are throwaway local values — **never** used in production.

## Staged local database — no Docker required (Windows dev)

When Docker isn't available, `dev-postgres/local-db.ps1` runs a **portable Postgres**
staged under a gitignored runtime dir (`dev-postgres/.runtime/`), so the binaries
download **once** and the cluster persists between sessions — spin up/down on demand
without wasting cycles.

```powershell
./dev-postgres/local-db.ps1 provision   # one-time: download, initdb, roles/schema, migrate
./dev-postgres/local-db.ps1 up          # start (fast; provisions if needed)
./dev-postgres/local-db.ps1 status      # running? + audit_log row count
./dev-postgres/local-db.ps1 migrate     # build + run migrations
./dev-postgres/local-db.ps1 psql -- -c "select * from autotask_mcp.audit_log"
./dev-postgres/local-db.ps1 down        # stop, keep everything staged
./dev-postgres/local-db.ps1 reset       # drop + recreate the DB, re-migrate
./dev-postgres/local-db.ps1 purge       # delete the runtime dir (forces re-download)
```

Same DB/schema/role model as prod (owner/migrator/app, app = DML only). Dev-only
credentials are baked into the script and never used in production.

## Connecting the MCP

Copy the PG block from `.env.dev-pg.example` into the MCP's `.env` and set
`MCP_PG_ENABLED=true` plus whichever capability flags you're testing. For the local
test DB:

```
MCP_PG_ENABLED=true
MCP_PG_HOST=localhost
MCP_PG_PORT=5433
MCP_PG_DATABASE=gds_autotask_mcp
MCP_PG_SCHEMA=autotask_mcp
MCP_PG_USER=gds_autotask_mcp_app
MCP_PG_PASSWORD=devapp
MCP_PG_SSL=false
```

Production points the same vars at the VPS with `MCP_PG_SSL=require` and real
secrets. Migrations run as the **migrator** role (`MCP_PG_MIGRATOR_USER` /
`MCP_PG_MIGRATOR_PASSWORD`), separate from the runtime app role.

## Degraded modes (spec §24)

PG disabled → live Autotask only. PG outage → safe live ops continue, cached/job
features degrade. Schema behind the code → newer-schema features disable
themselves. The server must never hard-fail because Postgres is unavailable.

## Shadow — read-only Autotask mirror (`MCP_PG_SHADOW_ENABLED`)

Heavy reads (thousands of tickets / time entries, contract and labor sweeps,
reports) cost Autotask API calls, and every integration on the tenant shares one
**10,000 requests/hour** budget per database, with Autotask adding **0.5 s** of
latency per call past 50% and **1 s** past 75%, plus a **3 concurrent threads per
endpoint** limit. The shadow keeps a read-only copy of the busiest entities in
Postgres so those reads cost **0** Autotask calls. Autotask stays authoritative:
every write still goes to Autotask.

**Mirrored:** Tickets, TimeEntries, Tasks, Projects, Companies, Contacts, Contracts (incremental, by
their last-modified field), ContractServices, ContractBlocks, Resources (small;
refreshed in full hourly). One table, `shadow_record (entity, id, data jsonb, …)`,
plus `shadow_sync_state` (migration `0002_shadow.sql`).

**Ticket notes** (since 3.65, gap register MCP-004): TicketNotes, windowed by
`createDateTime`.
- **Sync mode.** `lastActivityDate` is the documented last-modified field. It
  is confirmed from the tenant's field list at start-up and used for
  incremental sync; if it isn't there, notes run in window-refresh mode
  (below).
- **What reads from the mirror.** The activity feed reads notes here at no API
  cost. Note queries bounded by `createDateTime` are served from the mirror
  when it covers the window.
- **What still goes live.** A by-ticket note search with no date bound, or a
  note created before the window on an old ticket.
- **New notes.** A note the MCP creates (`POST /Tickets/{id}/Notes` or
  `/TicketNotes`) is fetched into the mirror right after the write.

**Ticket history** cannot be mirrored the same way, because Autotask only
answers it one ticket at a time. Instead it is **indexed** in the audit ledger
(`audit_event`, `source = ticket_history`):
- **Indexing.** Every live read, from `autotask_get_ticket_change_history`,
  the activity feed, or the audit tools, stores the parsed rows and the time
  they were read.
- **Serving.** A later read comes from the index (0 calls) as long as the
  Tickets mirror is fresh, the ticket's `lastTrackedModificationDateTime` is
  not newer than that read, and the MCP hasn't just written the ticket.
- **Reporting.** `result.source` says `index` (with `indexedAt` /
  `ticketLastModified`) or `live`; `live: true` forces a fresh read.
- **What the index leaves out.** It skips timestamp-only rows, so
  `includeTimestampOnly` always reads live.

**Billing / financial review** (since 3.57): Invoices, BillingItems, and
TicketCharges, ProjectCharges and ContractCharges; **ExpenseItems** since 6.4
(windowed by `expenseDate`).

**Sales and assets** (since 6.4): **Opportunities** and **ConfigurationItems**, mirrored whole — incremental when the
tenant's field list offers a modified stamp, otherwise refreshed in full (hourly / every 6 hours). `search_opportunities`,
`search_configuration_items` (including the serial-number filter), `search_expense_items` and
`search_ticket_charges` are answered from the mirror while it is fresh.

**Text matching** in the mirror ignores case and whitespace differences (double spaces, line breaks, non-breaking
spaces), so "replaced the" finds "replaced  the". Time-entry text lives in `summaryNotes` and `internalNotes`.

- **Window.** Each is limited to the history window by its own date:
  `invoiceDateTime`, `itemDate` and `datePurchased`.
- **No reliable "last modified" field.** These records are edited after they are
  created: invoices get paid or voided, billing items get invoiced. So they run
  in **window-refresh** mode:
  - **New rows every run.** Autotask ids only grow, so new rows are the ones
    with an id above the highest mirrored one.
  - **The last `MCP_PG_SHADOW_REFRESH_DAYS` (30) re-read hourly**, to pick up
    those edits.
  - **The whole window re-read once a day.**
  - **Deletions.** A row that a complete re-read no longer returns is marked
    deleted, but only within the range that was re-read.

  Edits to these records can therefore be **up to an hour old**. New rows appear
  within one sync run.
- **Field check at start-up.** The sync reads each entity's field list once per
  start-up. If the tenant offers a queryable `lastModifiedDateTime` /
  `lastModifiedDate`, the entity uses normal incremental sync instead. If a
  needed date field is missing, the entity is skipped with a clear
  `last_error` instead of failing queries.
- **Cost.** Roughly the backfill (≈ 2 calls per 1,000 rows), plus about 1–20
  calls an hour for the recent-days re-read, depending on volume.

**How it stays fresh**
- **Backfill** — first load walks `id > cursor` in 500-row pages (Autotask returns
  ≤ 500 rows sorted by id), resumable across runs. About 750 calls for the whole
  tenant, spread over several runs.
- **Incremental** — every `MCP_PG_SHADOW_INTERVAL_SECONDS` (300): rows modified or
  created since the watermark (minus 2 min overlap). Typically a handful of calls.
- **Own writes** — rows the MCP writes are re-read at the start of the next run.
- **Deletions** — a nightly id-only sweep (`MCP_PG_SHADOW_RECONCILE_HOUR_UTC`).
- **Budget** — at most `MCP_PG_SHADOW_MAX_CALLS_PER_RUN` (100) calls per run; a
  run is **skipped** when tenant usage ≥ `MCP_PG_SHADOW_PAUSE_AT_PCT` (85), or while
  Autotask holds calls (a 429 cooldown or a login pause). The threshold is high on
  purpose: a run costs at most 100 calls, but a stale mirror sends every read to
  Autotask live. At the old 50%, a busy hour paused the sync, reads went live, and
  usage climbed to 429s. The nightly mirror check still skips from 50%. Calls are
  strictly sequential (1 of the 3 threads).
- **One instance** — a Postgres advisory lock means only one MCP syncs.
- **History window** — `MCP_PG_SHADOW_HISTORY_MONTHS` (6): Tickets backfill only
  rows active or created in the window **plus every open ticket**; TimeEntries
  only rows worked in the window. Companies, Contacts, Contracts, Tasks and the
  small tables are kept whole (reference data). A search is served from the
  shadow only when its filters stay inside the window (open tickets, or a
  date bound at/after the window start); anything reaching further back goes
  live. At GDS: ~305 calls for the first load instead of ~765.
- **Size** (measured at GDS, 6-month window): ≈ 215 MB of records, ≈ 350 MB
  with indexes — Companies + Contacts are three quarters of it. Grows ≈ 10 MB a
  month (rows that age out of the window are kept).

**Consistency check (does the mirror match Autotask?)**
Every read asks the shadow first, so a mirror fault would quietly reach
reports. The check runs nightly at `MCP_PG_SHADOW_VERIFY_HOUR_UTC` (8), from
the console's **Check now**, or with `autotask_shadow_sync` `action: "verify"`.
For each entity it does two things:

1. **Sample rows.** Take `MCP_PG_SHADOW_VERIFY_SAMPLE` (10) random mirrored rows,
   re-read them from Autotask in one `id in […]` query (always live), and
   compare every field.
2. **Count rows.** Compare the mirror's row count with Autotask's
   (`/query/count`) over the same window. It may differ by 5 rows or 0.5%.

Each differing row is classified:

| Class | Meaning | Mismatch? |
|---|---|---|
| `changed` | Autotask's modified date is newer than the copy, and recent | No: the next sync picks it up |
| `pending` | The entity has no modified date, and the copy is newer than the refresh interval | No: the next refresh picks it up |
| `differs` | Anything else: a missed update, a field that changes without the modified date moving, a translation bug | Yes |
| `missing` | Autotask no longer returns the row | Yes |

Real mismatches are **repaired from Autotask** right away. Results are kept in
`shadow_verify_run` (migration `0005`, last 60 runs) and shown on the dashboard.
A run costs about 2 Autotask calls per entity and is skipped above the
usage-pause threshold.

**Using it**
- `autotask_shadow_query` / `autotask_shadow_aggregate` — SQL over the mirror with
  the same filter format as the Autotask API; every answer reports data age.
- `MCP_PG_SHADOW_SERVE_READS=true` — the regular `search_*` tools (tickets, time
  entries, companies, contacts, resources, …) are answered from the shadow while
  the entity is backfilled and younger than `MCP_PG_SHADOW_MAX_AGE_SECONDS` (900) —
  or, for an entity re-copied on a schedule (Resources, ContractServices, ContractBlocks,
  the window-refresh billing entities), younger than its refresh interval + 5 min;
  otherwise, or for any filter the shadow can't translate, they go live.
  Verified: same ids, order and `hasMore` as the live API.
  **Every query and by-id read of the MCP's own tenant asks the shadow first**,
  not only the paged search tools: reports, invoice and billing tools, and the
  lookups inside other tools. They are answered from the shadow when it can,
  and go live in these cases:
  - the read was made while impersonating a user;
  - it asks for more than 5,000 rows;
  - its filters reach outside the window;
  - the MCP wrote that entity in the last 90 s (a just-created row isn't mirrored
    yet);
  - it is a by-id read of a row the MCP wrote since the last sync.

  `autotask_raw_request` reads are served too. n8n uses `POST /Tickets/query`
  through it.
  - A raw `POST /Entity/query` is answered from the shadow only when the shadow
    holds the **whole** result within the page size; the MCP asks the mirror for
    one extra row to find out. Otherwise the request goes to Autotask, so callers
    that page by `nextPageUrl` still get Autotask's real paging link.
  - A raw `GET /Entity/{id}` returns the mirrored row as `{ item }`.
- `autotask_shadow_status` — rows, backfill progress, age, calls spent, errors.
- `autotask_shadow_sync` — run now / re-read ids / reconcile one entity.
- `/health` shows `shadow.lastRunAt` / `lastRunCalls` (no DB round-trip).

### User-defined fields (migration 0016)

Autotask returns UDFs as an unordered list (`[{ "name": "Nexus-Status", "value": "2" }, …]`). Each mirrored row also keeps them **structured**: `udf jsonb`, e.g. `{ "Nexus-Status": "2", "Opp-Tag": "…" }`.

- It holds only UDFs that have a value; null and "" mean no value.
- It's a stored generated column, computed by Postgres from the record (`shadow_udf_map(data)`), so every sync keeps it right. It's GIN-indexed.
- `data` keeps Autotask's own shape for callers.

**Filters:** an Autotask UDF filter, `{ "op": "eq", "field": "Nexus-Status", "value": "7", "udf": true }`, is answered from the mirror when that UDF has values there. An unknown UDF name goes to Autotask. Supported ops: eq, noteq, contains, beginsWith, endsWith, in, notIn, exist / notExist, and numeric gt / lt.

**Grouping:** `autotask_shadow_aggregate` takes `groupBy: ["udf:Nexus-Status"]`, for example tickets per lifecycle state.

**Mirror check:** it compares UDFs as a set, so order and empty-vs-missing don't count as differences.

Adding the column rewrites `shadow_record` once when the migration runs (about a minute per ~50k rows). Reads go to Autotask meanwhile.

## Per-endpoint concurrency gate (always on)

Autotask allows **3 concurrent requests per integration per object endpoint**
and answers the 4th with **429**. Every upstream call now passes a gate keyed by
endpoint (Tickets, TimeEntries, …): at most `AUTOTASK_MAX_CONCURRENT_PER_ENDPOINT`
(default **2**, max 3) in flight, the rest **wait their turn** instead of failing.
Cached and shared (coalesced) reads never reach upstream, so they take no slot.

## Audit event ledger — resource activity / daily labor audit

Migration `0003_audit_events.sql` adds `audit_event` (one normalized row per
attributable event) and `ticket_history_fetch`. It powers
`autotask_search_audit_activity`, `autotask_report_resource_activity` and
`autotask_report_resource_daily_audit`.

- **Ticket history** can't be queried by resource in Autotask, so the tickets
  changed since the window opened are found (from the shadow: 0 calls) and their
  history read **per ticket, then cached here**. A past day's history never
  changes: measured at GDS, auditing one tech's day cost **199 calls the first
  time and 8 the second** (190 changed tickets), and the first pass serves every
  resource that day.
- **Webhooks** (Tickets, TicketNotes, Companies, Contacts, ConfigurationItems)
  arrive via n8n at `POST /ingest/autotask-webhook` (internal only). The MCP
  re-verifies Autotask's `X-Hook-Signature`, records `PersonID` as the actor, takes
  the new values from the callout and the **old values from the shadow row**.
  See [N8N_WEBHOOKS.md](N8N_WEBHOOKS.md#5-forward-to-the-mcp-audit-ledger).
- **Row diffs** — ServiceCalls and CompanyToDos are mirrored with watched fields;
  a change between syncs is recorded old → new. Autotask doesn't record who made
  these changes, so the actor is unknown (except who cancelled a service call).
- **Weak attribution is never counted as work** — e.g. a To-Do completed while
  assigned to someone (automations complete To-Dos too) is listed, not scored.
- **Timesheet status is not available** through the Autotask API (no entity); the
  daily audit reports it as unknown.

## Activity feed — incremental, cursor-paged (`autotask_get_activity_feed`)

Migration `0007_activity_feed.sql` adds `activity_feed_checkpoint` (one row per
source) and an index for per-ticket reads. The feed serves the same
`audit_event` ledger as one tenant-wide stream for learning pipelines and n8n
dispatchers: ticket field changes (TicketHistory, before → after), ticket notes,
and time entries (created and edited). Each event carries a classified actor
(human / service_account / integration / system / contact / unknown, the rule
that decided it, and the reference-technician flag from the console's Actors page).

- **Cursor = ingestion order** (`audit_event.id`), not `occurredAt`. An event
  that arrives late, such as a ticket whose history is read after newer events,
  gets a higher id. A reader that already passed its time still receives it.
  Replaying a cursor returns the same `eventId`s, because `event_key` is unique.
  Consumers dedupe on `eventId`.
- **Each call ingests first**, from per-source checkpoints, within `maxApiCalls`
  (default 40). Time entries and ticket notes come from the mirror when it
  covers the scan (otherwise live):

  | Source | Read from | Cost |
  |---|---|---|
  | Time entries | the shadow | 0 calls |
  | Ticket notes | the TicketNotes mirror (live by `createDateTime` when it doesn't cover the scan) | 0 calls (live: 1 per 500 notes) |
  | Ticket history | each ticket changed since the checkpoint, oldest change first | 1 call per changed ticket; skipped when it was already read after its last change |

  Each scan starts 15 minutes behind the watermark, so rows the shadow synced
  late are still caught. Whatever the budget leaves stays **pending**
  (`hasMore: true`) and is picked up on the next call. Nothing is dropped.
  An advisory lock stops two ingests from running at once; the second caller is
  served what is already stored.
- **Coverage**: the first ingest starts at the requested `since`, at most 90 days
  back. A later request for earlier events reports `coverage.complete: false`
  rather than silently returning a partial stream. `backfill: true` extends the
  coverage within the call budget; repeat the call until coverage is complete.
- `watermark` means every event before it is stored. `sourceLagSeconds` is
  how far behind now that is.
- Autotask 401 or 429 responses are not retried by the feed. The client's login
  protection and the concurrency gate apply, and the source is reported as
  incomplete.

## Operation log — correlation + durable idempotency (`autotask_get_operations`)

Migration `0008_operations.sql` adds `mcp_operation` (one row per tool call that
wrote to Autotask, or that carried an explicit idempotency key) and
`mcp_operation_write` (each Autotask write made by that call: method, path,
entity, id, time). Rows are purged after 90 days.

**What callers send in the MCP request `_meta`** (all optional):

| Field | Meaning |
|---|---|
| `correlationId` | ties calls together (generated when absent) |
| `decisionId` | the upstream decision being executed, e.g. a Hermes recommendation id |
| `idempotencyKey` | one key per logical action, e.g. `<eventId>:<action>` |
| `workflow`, `node`, `executionId`, `eventId` | where the call came from; recorded, never used for authorisation |

**What a write returns:** `_operation`, containing `{ operationId, correlationId,
decisionId, idempotencyKey, refs, writes[] }`.

**Idempotency** is enforced in Postgres, so it holds across retries,
concurrent duplicates and restarts. The rules are in [DESIGN.md](DESIGN.md).
In short: a repeat replays the stored result, while a different payload or an
unknown outcome is refused and never re-run.

**Tracing an Autotask change back to its decision:**
- In the activity feed and ticket change history, events by this MCP's API user
  carry `operation`, from the recorded write nearest in time.
- `autotask_get_operations` looks up by operationId, correlationId, decisionId,
  idempotencyKey or ticketId.

If the migration hasn't been run, the MCP logs a warning and idempotency falls
back to memory. Calls are not blocked.

## Historical backfill — bounded, resumable (`autotask_backfill_history`)

Migration `0009_history_backfill.sql` adds `history_backfill_job`. Learning
data from before the shadow window (or past the feed's 90-day reach) comes from
here. A job takes the tickets **completed** in a date range (at most 366 days)
and stores their field-change history, notes and time entries in
`audit_event`. Readers then get it from the activity feed (`ingest: false`,
`since` = range start) or the audit tools, at no API cost.

- **Plan first.** `dryRun: true` counts the tickets (1 call) and estimates the
  total Autotask calls. It creates nothing.
- **One step per call.** Each call advances the job by at most `maxApiCalls`
  (default 100). A step checks tenant usage, reads one page of tickets above
  the cursor, reads their notes and time entries in bulk (`ticketID in [...]`),
  then reads each ticket's history. History already indexed after the ticket's
  last change is skipped.
- **Resumable and idempotent.** The cursor only moves past tickets whose
  history is stored. A budget cut resumes exactly there, and every insert is
  deduplicated on `event_key`.
- **Safeguards:**
  - A step does nothing while tenant usage is at or above `pauseAtUsagePct`
    (default 50%).
  - An Autotask error stops the step without retrying and is recorded on the
    job (`lastError`).
  - Nothing runs in the background: n8n or a person drives the job, for example
    one step every 10 minutes.
- **Cost.** About 1 call per ticket for history, plus 2–4 calls per page of 50
  tickets. A month of roughly 1,500 completed tickets costs about 1,600 calls,
  spread over as many steps as you like.
