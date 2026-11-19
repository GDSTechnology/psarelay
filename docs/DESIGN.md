# GDS PSArelay — Design

Architecture and design decisions for the Expansion & Deployment work. This is
the companion to the spec (the *what*); this doc is the *how* and *why*. Tracked
in the [Expansion epic](https://github.com/GDSTechnology/psarelay/issues/12).

## Principles

1. **Autotask is authoritative.** Every operational mutation commits to Autotask.
   PostgreSQL (when enabled) is a cache / correlation / history / work-buffer
   layer, never an alternate master. Results state whether data came from live
   Autotask or shadow, with freshness.
2. **Typed tools are the interface.** `autotask_raw_request` is an
   administrator-only escape hatch, audited, DELETE-disabled through Hermes.
3. **Canonical names + system ids together.** Every returned relationship carries
   both the Autotask id and a human-facing name/number.
4. **Multi-user safety.** The Autotask API user is only the transport identity;
   the requesting person travels with each call and drives permissions + proxy input.
5. **PostgreSQL is optional.** Disabled by default; all direct-Autotask tools work
   with `MCP_PG_ENABLED=false`.
6. **Definition of Done** (§28): typed tool · canonical ids+names · live metadata ·
   server-side permissions/confirmation · idempotent + audited · partial-failure
   reporting · PG-off still works · tests.

## Foundation (Phase 1) — shared-service layer

The substrate every tool inherits. Built in `callTool` so it applies uniformly.

### Caller context — **implemented**
`types/context.ts`. `CallerContext { source (chatgpt|hermes-teams|telegram|unknown),
requestingUserEmail, teamsObjectId, autotaskResourceId, conversationId,
correlationId, idempotencyKey, intent, timestamp }`. Extracted from the MCP
request `_meta` or a reserved `_context` argument (`_meta` wins); the reserved key
is stripped before tool logic. Threaded into every dispatch handler.

### Operation log + durable idempotency (MCP-007) — **implemented**
`db/operation-store.ts` (migration 0008) with `utils/operation-context.ts`. Every
tool call runs inside an operation scope. The HTTP client reports each Autotask
write into it (method, path, entity, id), so a call that wrote is recorded in
`mcp_operation` / `mcp_operation_write` together with:
- `correlationId`;
- `decisionId` (`_meta.decisionId`, e.g. a Hermes recommendation);
- the caller's `refs` (`_meta.workflow` / `node` / `executionId` / `eventId`).

The write result returns these as `_operation`.

**Idempotency.** An explicit `_meta.idempotencyKey` on a call that can write is
claimed in Postgres before the call runs:

| What happens next | Result |
|---|---|
| Same key again, same tool and payload | the stored result is replayed (`_operation.replayed`) |
| Same key, different payload | refused (`idempotency_conflict`) |
| Same key while the first call is still running | refused (`in_progress`) |
| The first call failed after writing | refused (`previous_attempt_partial`); nothing is written twice |
| The first call failed before writing | the key can be retried |

Derived (conversation) keys keep the in-memory store.

**Tracing back.** Activity-feed and ticket-history events made by this MCP's
API user carry the `operation` whose write is nearest in time.
`autotask_get_operations` looks operations up by operationId, correlationId,
decisionId, idempotencyKey or ticket. Rows are kept for 90 days.

### Audit — **implemented (log-only)**
`utils/audit.ts` emits one structured record per invocation (tool, outcome,
duration, caller identity, correlation, idempotency, intent, result id). No
secrets/bodies. Also persisted to the `audit_log` table when `MCP_PG_AUDIT_ENABLED`
(`db/audit-sink.ts`, #18) — the handler's `recordAudit` dual-writes log + PG; the
PG write is fire-and-forget and never blocks or fails a call. The log shape is the
source of truth for the table.

### Caller → resource resolution — **implemented**
`utils/caller-resolution.ts` + `handler.resolveCaller`. Order: explicit
id/email/name → static `AUTOTASK_USER_MAP` (non-email handles) → in-memory cache
→ live email match against `Resources`. On no unambiguous match, returns a
structured `user_identification_required` prompt (no-identity / not-found /
ambiguous + candidates) so the client asks the human, whose answer is cached and
reused. `autotask_whoami` resolves/establishes it. When PG identity is enabled,
the mapping persists across restarts.

### Proxy data input — **implemented (partial)**
`ACTING_RESOURCE_TOOLS` maps a tool to its resource field; `currentUser: true`
resolves the caller and writes their resource id into that field (or returns the
identity prompt). Wired for time entries + To-Dos; ticket-assignment/owner tools
follow once role/owner semantics are handled (#15).

### Permissions & roles — **implemented, off by default (#15)**
`utils/permissions.ts`. Effective permission = the caller's functional role ∩ the
tool's risk class (GDS/Hermes policy layers on later). Functional roles: Staff,
Dispatcher, Project Manager, Sales, Finance, Executive, Administrator, each with a
max-risk ceiling (`ROLE_MAX_RISK`) on the risk ladder — staff/dispatcher/PM →
reversible-update, sales/finance → financial, executive → inventory-movement,
administrator → destructive. Reads are open to everyone; an unmapped caller may
read but not mutate (fail-closed). Roles come from `AUTOTASK_ROLE_MAP`
(`key=role`, keyed by email / Teams object id / resource id; config first, PG
identity later), with an `AUTOTASK_DEFAULT_ROLE` fallback. `callTool` denies before
dispatch *and* before the confirmation prompt, returning a structured
`permission_denied` (audited `permission-denied`). **Gating runs only when
`MCP_PERMISSIONS_ENABLED=true`** — disabled by default so the live server is
unaffected until roles are mapped. Per-tool area/scope refinements (owner-only
edits, area-scoped roles) follow as policy firms up.

### Risk & confirmation — **implemented (#13)**
`utils/risk.ts`. Per-tool risk level (read-only / reversible-update / external-comm
/ financial / inventory-movement / destructive), derived once at startup from the
tool annotations plus the `FINANCIAL_TOOLS` / `INVENTORY_MOVEMENT_TOOLS` /
`EXTERNAL_COMM_TOOLS` registries: `readOnlyHint` → read-only, `destructiveHint` →
destructive, financial/inventory registry membership next, else reversible-update.
`callTool` gates before dispatch: destructive / financial / inventory mutations
require an explicit `confirm: true`, else they return a structured
`confirmation_required` response (audited as `confirmation-required`) instead of
running. `confirm` is a control flag and is stripped before the tool sees it.
External-comm (show recipients) and inventory (show source/dest/qty/serials) detail
displays land with their feature phases; the reversible-update "confirm when
ambiguous" softer path is deferred.

### Idempotency — **implemented (#14)**
`utils/idempotency.ts`. `deriveIdempotencyKey` uses a caller-supplied
`idempotencyKey` when present, else derives one from source + actor + conversation
+ tool + normalized payload (sorted-key hash) — and returns nothing when there's no
conversation context, so a context-free CLI call is never deduped. `callTool`
gates only mutating tools (`isMutatingTool` — read/`get_`/`search_`/`list_` and the
meta tools are excluded regardless of annotation coverage): on a key hit it replays
the stored result (audited `idempotent-replay`) instead of dispatching; on success
it caches the result. Errors and not-found are never cached, so a genuine failure
can still be retried. Bounded, TTL'd in-memory store (`InMemoryIdempotencyStore`,
FIFO eviction); the PG-backed `jobs_*` store lands in Phase 2 behind
`MCP_PG_JOBS_ENABLED`, reusing this interface.

### Canonical resolution — **foundation implemented (#16)**
`utils/canonical.ts`. `parseReference` classifies any input — bare id, Autotask
deep-link URL (entity + id pulled from the query string), email, ticket/task
display number, or free-text name — into a typed lookup hint. `resolveCanonical`
collapses candidate records into one `{ id, canonicalName }` (matched), a short
choice list (ambiguous), or not-found — never guessing. `pickCanonicalName` derives
a human label from the fields Autotask entities commonly carry. Pure/HTTP-free,
complementing `reference.resolver.ts` (ticket-vs-task display numbers). Per-entity
live wiring — feeding each tool's search results through this layer, plus SKU/serial
forms — is adopted incrementally by the entity tools.

### Raw-request gatekeeping — **implemented (#17)**
`utils/raw-gate.ts`. The HTTP layer already rejects absolute URLs, auth-header
overrides, path traversal, and off-zone hosts. On top of that, `callTool` runs a
policy gate for `autotask_raw_request`: administrator-only when
`MCP_PERMISSIONS_ENABLED=true` (raw bypasses the typed surface, so it is never
subject to the ordinary role→risk ladder); DELETE disabled unless
`MCP_RAW_ALLOW_DELETE=true` (deletes should go through a typed, risk-gated,
idempotent tool); and a production read-only switch `MCP_RAW_READONLY=true` that
blocks every mutating method, leaving only GET. Denials return a structured
`raw_request_denied` (audited `permission-denied`). Raw is excluded from
idempotency (a raw GET must never be replayed) and handled by this gate, not the
general permission gate.

## Optional PostgreSQL layer (Phase 2)

Disabled by default. Feature flags gate each capability
(`MCP_PG_SHADOW/JOBS/AUDIT/SNAPSHOTS/IDENTITY/PRICING/WEBHOOK_BUFFER_ENABLED`).

- **Isolation:** dedicated DB `gds_autotask_mcp`, schema `autotask_mcp`, roles
  `app` / `owner` / `migrator`. Never touch n8n / Hermes / control-plane DBs,
  schemas, or roles. App role has no DDL; migrations use a separate login with an
  advisory lock + checksum registry, fail-closed on mismatch.
- **Degraded modes:** PG disabled → live Autotask only. Outage → safe live ops
  continue, cached/job features degrade. Shadow stale → report age, query live.
  Schema behind → disable newer-schema features. Interrupted job → resume from
  last checkpoint. (Spec §24 matrix.)
- **Shadow + snapshots:** current-state tables (id, canonical name/number, source
  + sync timestamps, checksum, active) refreshed via staging → validate → atomic
  publish (readers see prior-complete or new-complete, never partial). History via
  6-hour/daily/monthly retention + checksums, not wasteful full duplication.
- **Jobs:** draft → validated → awaiting_confirmation → queued → running →
  partially_completed → completed / failed → resumable. Backs project builds,
  category reclassification, pricing imports, relationship repair, approval queues.

## Later phases (design notes)

- **Phase 3 — inventory/catalog:** query live `entityInformation` first to choose
  the InventoryItems vs InventoryProducts/StockedItems model. Transfers use
  Autotask inventory transactions (never emulated balance edits). Consumption ties
  to a charge + optional configuration item; low-confidence product matches never
  auto-create customer charges.
- **Phase 4 — project/sales:** project blueprint is JSON/YAML; build is checkpointed
  and resumable (never duplicates on retry). Sales-cycle correlation uses native
  fields where they exist, else a GDS UDF or the PG relationship registry, with the
  link type labeled. Shipped (native only): `autotask_report_sales_cycle` +
  `autotask_link_to_opportunity` — Quotes / Contracts / Projects `opportunityID`;
  inferred links are suggestions, never stored without a confirmed dry-run repair.
- **Phase 5 — calendar/staff:** Appointments are first-class (never a future time
  entry); accept local time + zone, return UTC + local. `my_day` unions tickets,
  tasks, service calls, appointments, open To-Dos, and missing time entries.
- **Phase 6 — contracts/reporting:** monthly allocations (a 12-month, 2-block/month
  agreement is not one annual pool). Labor separated: actual / billable / covered /
  block-hour / riser / non-contract / effective revenue / burden / remaining.
- **Phase 7 — pricing/proactive:** ingest → normalize → match → validate → price
  rules → exception review → approval → update → verify. Margin guards (below-cost,
  below-min-margin, stale, discontinued). Webhooks optional/admin-managed with the
  MCP API resource excluded to prevent feedback loops; polling where unsupported.

## Cross-cutting

- **Performance:** central request queue, per-user + global concurrency caps, retry
  with backoff + jitter, circuit breaker, metadata/picklist cache, bounded fan-out,
  stable pagination, correlation ids across ChatGPT/Hermes → MCP → PG → Autotask.
- **Deployment:** live on the production host (docker-compose). Automated release
  (semantic-release → GHCR image). Pinned image / rollback per `DEPLOY.md`.
- **Testing:** unit (resolution, ambiguity, permission intersection, risk,
  idempotency, tz, inventory math, pricing, dependency ordering, sales-cycle) +
  integration (PG on/off, isolation, migrations, atomic publish, job resume,
  transfers, receiving, notification verification) + safety (raw gating, confirmation
  gates, no-secrets-in-logs).
