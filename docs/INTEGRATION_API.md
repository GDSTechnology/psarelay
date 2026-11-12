# Integration API (`/api/v1`)

Other systems — a time module, a CRM module, a report job — work with Autotask through PSArelay instead of calling
Autotask themselves, so all of the tenant's traffic goes through one place that knows Autotask's limits.

- **Reads come from the Postgres mirror** and cost **no Autotask call**: these systems stop counting against the
  tenant's 10,000 calls/hour and stop holding Autotask's 3 threads per endpoint.
- **Writes go through PSArelay's own Autotask connection** (per key, off by default). They share its per-endpoint
  thread gate and 429 cooldown, wait when the tenant is near its limit, and the mirror re-reads what they changed.
  See [Writes](#writes).
- **Same request shapes as Autotask's REST API.** An Autotask client switches over by changing its base URL and
  its key.
- **One key per system**, managed in the admin console (**Integrations**). Each key can read only the entities you
  tick, and has hourly caps. It can be edited or revoked at any time, and the change applies to the next call.
- A key (`psk_…`) opens **only** `/api/v1`, never `/mcp`. An MCP token (`psr_…`) never opens `/api/v1`.

Needs the Postgres layer (`MCP_PG_ENABLED`, migrations `0024`–`0025`) and the mirror (`MCP_PG_SHADOW_ENABLED`). The API
reads the mirror whether or not `MCP_PG_SHADOW_SERVE_READS` is on: that setting only controls the MCP's own reads.

## Endpoints

The API listens on the MCP port (8080), next to `/mcp`. Every call sends `Authorization: Bearer psk_…`.

| Call | Answer |
|---|---|
| `GET /api/v1` | What this key may read, its caps and this hour's use, and how fresh each entity's copy is |
| `POST /api/v1/{Entity}/query` | `{ items, pageDetails, hasMore }`. The body is Autotask's: `{ filter, MaxRecords?, IncludeFields? }` |
| `GET /api/v1/{Entity}/{id}` | `{ item }`. `item` is `null` when the record is not there, as Autotask answers |
| `POST /api/v1/{Entity}` | Create. Autotask's answer (`{ itemId }`) |
| `PATCH /api/v1/{Entity}` | Update: `{ id, …only the fields to change }` → `{ itemId }` |
| `DELETE /api/v1/{Entity}/{id}` | Delete, when the key may delete |
| `POST` / `PATCH /api/v1/{Parent}/{id}/{Child}` | Autotask's child URLs, e.g. `/Tickets/{id}/Notes`, `/Companies/{id}/Contacts`; `DELETE …/{Child}/{id}` |

```http
POST /api/v1/TimeEntries/query
Authorization: Bearer psk_…
Content-Type: application/json

{ "filter": [ { "op": "gte", "field": "dateWorked", "value": "2026-11-01" },
              { "op": "gt",  "field": "id",         "value": 0 } ],
  "MaxRecords": 500,
  "IncludeFields": ["resourceID", "ticketID", "dateWorked", "hoursWorked", "summaryNotes"] }
```

### Filters

These work as in Autotask: `eq noteq gt gte lt lte beginsWith endsWith contains exist notExist in notIn`, plus
`and` / `or` groups with `items`, and `"udf": true` for user-defined fields. A filter can have at most 100
conditions and 4 levels of nesting. Field names may contain only letters, digits and `_`.

### Paging

Rows come back in **ascending id order**, from the mirror and from Autotask alike. `MaxRecords` is 1–500 (default
500). While `hasMore` is true, ask again with `{ "op": "gt", "field": "id", "value": <last id> }` added.
`pageDetails.nextPageUrl` is always `null`, because Autotask's own paging link is never passed on.

### Where an answer came from

| Header | Meaning |
|---|---|
| `X-PSArelay-Source` | `mirror` (no Autotask call) or `live` |
| `X-PSArelay-Age` | From the mirror: how old the copy is, in seconds |
| `X-PSArelay-Mirror-Miss` | Why the mirror couldn't answer (see below) |

## When the mirror can't answer

The mirror answers when the entity is mirrored, its copy is fresh enough, the filter stays inside the mirrored
history (Tickets and TimeEntries keep `MCP_PG_SHADOW_HISTORY_MONTHS`) and every filter field is in the copy.
Otherwise the miss has a reason:

| Reason | Meaning |
|---|---|
| `mirror_off` | The mirror isn't running |
| `not_ready` | The mirror's first copy isn't finished |
| `stale` | The copy is older than its freshness limit (`MCP_PG_SHADOW_MAX_AGE_SECONDS`, or the entity's refresh interval) |
| `outside_window` | The filter reaches further back than the mirrored history |
| `unknown_field` | A filter field isn't in the copy |
| `recently_written` | PSArelay just changed this entity; the next sync picks the change up |
| `not_in_mirror` | By id: the record isn't in the copy (it may be newer than the last sync) |

What happens next depends on the key:

- **Mirror only** (the default): the API answers **HTTP 503** with `reason`, `live: "live_off"` and `Retry-After`.
  Nothing is sent to Autotask. The exception is a by-id read of a record that isn't in the copy: it answers
  `{ "item": null }`.
- **Live allowed**: the API makes **one** Autotask call, but only within the key's **live calls per hour** cap, and
  never while the tenant's backpressure is `stop` (usage near the limit, a 429 cooldown, or the login on hold). When
  either stops it, the answer is 503 with `live: "live_cap"` or `live: "pressure"`, and `Retry-After`.

Give live access only to systems that need up-to-the-minute data. Most can wait for the next sync. Incremental
entities sync every 5 minutes (`MCP_PG_SHADOW_INTERVAL_SECONDS`).

## Writes

A key writes only the entities ticked under **May write** (none by default, so a read-only key stays read-only).
Writable: TimeEntries, Tickets, TicketNotes, Tasks, TaskNotes, Projects, ProjectNotes, ServiceCalls,
ServiceCallTickets, ServiceCallTicketResources, CompanyToDos, Companies, CompanyNotes, Contacts, ConfigurationItems,
Opportunities. Financial records (contracts, services, charges, invoices) are not: they go through the MCP's
confirm-gated tools. A child URL needs the child entity: `POST /Tickets/{id}/Notes` needs **TicketNotes**.

```http
POST /api/v1/TimeEntries
Authorization: Bearer psk_…
Idempotency-Key: time-module-entry-8812
Content-Type: application/json

{ "ticketID": 4567, "resourceID": 123, "roleID": 456,
  "startDateTime": "2026-11-11T14:00:00Z", "endDateTime": "2026-11-11T15:00:00Z",
  "hoursWorked": 1, "summaryNotes": "Replaced the switch" }
```

- **The body is Autotask's**, sent as given: Autotask validates it and its answer comes back.
- **PATCH, never PUT.** PATCH sends the record's `id` and only the fields to change. PUT is refused (405): in
  Autotask it replaces the whole record and blanks every field left out.
- **`Idempotency-Key`** (recommended on every create). The key is claimed before the write runs. A repeat with the
  same key gets the first answer back (`X-PSArelay-Source: replay`) and nothing is written again. A repeat while
  the first is still running gets 409. If Autotask refused the first, the repeat runs again (nothing was written).
  If the first got no clear answer, the repeat gets 409: check the record before using a new key.
- **Writes / hour** (default 200) caps each key. Every write is an Autotask call.
- **Load.** Under backpressure "stop" (usage near the limit, a 429 cooldown, the login on hold) a write gets 503
  with `Retry-After` and is not sent. The console's read-only switch and a read-only plan answer 503 too.
- **When Autotask refuses** a write, the answer is 502 with `outcome: "not_written"` and `autotaskStatus`. When
  the write reached Autotask without a clear answer (timeout), it is 502 with `outcome: "unknown"`: it may have been
  applied, so read the record before retrying.
- **The mirror follows.** The changed record is re-read on the next sync. Until then a read of it goes live if the
  key allows live reads (`recently_written`), otherwise it gets 503.
- **Tenant quirks still apply.** `Contacts.isActive` is 0 / 1, not a boolean. In some zones contacts update only
  through `PATCH /Companies/{id}/Contacts`. `TimeEntries.hoursToBill` is read-only (use `offsetHours`).

Every write is logged (key, Autotask call, record, outcome) and listed on the Integrations page under **Recent writes**.

## Errors

| Status | When |
|---|---|
| 400 | The filter, `MaxRecords` or `IncludeFields` is invalid |
| 401 | No key, or an unknown, revoked or expired key (with `WWW-Authenticate: Bearer`) |
| 403 | The key may not read / write / delete this entity, or it is limited to the private network and the call came through a proxy or tunnel |
| 405 | Wrong method: queries are `POST`; `PUT` is never accepted (use `PATCH`) |
| 409 | An `Idempotency-Key` that is still running, was used for a different call, or got no clear answer |
| 429 | The key's requests-per-hour or writes-per-hour cap is used up (`Retry-After` = until the next hour) |
| 502 | Autotask answered with an error to a live call or a write (`outcome` says whether a write was applied) |
| 503 | The mirror can't answer and the call couldn't go live (see above), a write under load or with writes switched off, or the Postgres layer is off |

## Keys (admin console → Integrations)

| Setting | Default | |
|---|---|---|
| May read | — | The mirrored entities this key may read |
| May write | none | The entities it may create / update (a key needs at least one entity to read or write) |
| May delete | off | Also delete what it may write |
| Writes / hour | 200 | Writes sent to Autotask |
| Ask Autotask live | off | Lets a mirror miss go to Autotask, within the live cap |
| Outside use | off | Off: the key works only from the private network, and calls through a tunnel or proxy get 403 |
| Requests / hour | 3600 | Every request, wherever it is answered from |
| Live calls / hour | 100 | Of those, how many may go to Autotask |
| Expiry | none | 1–3650 days |

- **The key is shown once.** Only its SHA-256 is stored.
- **The Keys table shows** this hour's use, the last 24 hours (how much the mirror answered, the writes, and how
  many calls were refused) and when the key was last used.
- **Every create, edit and revoke** goes to the console's Activity log.
- **The caps are counted per PSArelay process.** A normal install runs one.
