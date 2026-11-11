# Integration read API (`/api/v1`)

Other systems — a time module, a CRM module, a report job — can read Autotask data from PSArelay's **Postgres
mirror** instead of calling Autotask. A read from the mirror costs **no Autotask call**, so these systems stop
counting against the tenant's 10,000 calls/hour, and they also stop holding Autotask's 3 threads per endpoint.

- **Read-only.** Writes still go through the MCP tools: they send only the fields you give (never a full-record
  PUT), use idempotency keys and are logged.
- **Same request shapes as Autotask's REST API.** An Autotask client switches over by changing its base URL and
  its key.
- **One key per system**, managed in the admin console (**Integrations**). Each key can read only the entities you
  tick, and has hourly caps. It can be edited or revoked at any time, and the change applies to the next call.
- A key (`psk_…`) opens **only** `/api/v1`, never `/mcp`. An MCP token (`psr_…`) never opens `/api/v1`.

Needs the Postgres layer (`MCP_PG_ENABLED`, migration `0024`) and the mirror (`MCP_PG_SHADOW_ENABLED`). The API
reads the mirror whether or not `MCP_PG_SHADOW_SERVE_READS` is on: that setting only controls the MCP's own reads.

## Endpoints

The API listens on the MCP port (8080), next to `/mcp`. Every call sends `Authorization: Bearer psk_…`.

| Call | Answer |
|---|---|
| `GET /api/v1` | What this key may read, its caps and this hour's use, and how fresh each entity's copy is |
| `POST /api/v1/{Entity}/query` | `{ items, pageDetails, hasMore }`. The body is Autotask's: `{ filter, MaxRecords?, IncludeFields? }` |
| `GET /api/v1/{Entity}/{id}` | `{ item }`. `item` is `null` when the record is not there, as Autotask answers |

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

## Errors

| Status | When |
|---|---|
| 400 | The filter, `MaxRecords` or `IncludeFields` is invalid |
| 401 | No key, or an unknown, revoked or expired key (with `WWW-Authenticate: Bearer`) |
| 403 | The key may not read this entity, or it is limited to the private network and the call came through a proxy or tunnel |
| 405 | Wrong method: queries are `POST`, everything else is `GET` |
| 429 | The key's requests-per-hour cap is used up (`Retry-After` = until the next hour) |
| 502 | Autotask answered with an error to a live call |
| 503 | The mirror can't answer and the call couldn't go live (see above), or the Postgres layer is off |

## Keys (admin console → Integrations)

| Setting | Default | |
|---|---|---|
| May read | — | The mirrored entities this key may read (at least one) |
| Ask Autotask live | off | Lets a mirror miss go to Autotask, within the live cap |
| Outside use | off | Off: the key works only from the private network, and calls through a tunnel or proxy get 403 |
| Requests / hour | 3600 | Every request, wherever it is answered from |
| Live calls / hour | 100 | Of those, how many may go to Autotask |
| Expiry | none | 1–3650 days |

- **The key is shown once.** Only its SHA-256 is stored.
- **The Keys table shows** this hour's use, the last 24 hours (how much the mirror answered, and how many calls
  were refused) and when the key was last used.
- **Every create, edit and revoke** goes to the console's Activity log.
- **The caps are counted per PSArelay process.** A normal install runs one.
