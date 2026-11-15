---
title: Integration API
description: How other systems — a time module, a booking module, a report job — read Autotask data from the mirror and write through PSArelay over REST.
---

Other systems work with Autotask through PSArelay instead of calling Autotask themselves, so all of a tenant's
Autotask traffic goes through one place that knows the limits (10,000 calls/hour per database, 3 threads per
endpoint).

- **Reads come from the Postgres mirror** and cost no Autotask call.
- **Writes go through PSArelay's own Autotask connection**: its thread gate, 429 cooldown and backpressure, and the
  mirror re-reads what they changed. Off per key until you allow them.
- **Same request shapes as Autotask's REST API**: an Autotask client switches over by changing its base URL and
  its key.

## Get a key

Admin console → **Integrations** → one key per system. Tick what it may read and write, set its caps, copy the key
(`psk_…`, shown once). A key opens only `/api/v1`, never `/mcp`. Edits and revokes apply to the next call.

## Calls

`http://<psarelay>:8080/api/v1`, with `Authorization: Bearer psk_…`. From another container on the same host, call it
by service name (`http://psarelay:8080`). From outside the private network the key needs **Outside use**.

| Call | What it does |
|---|---|
| `GET /api/v1` | What the key may read and write, its caps and use, how fresh each entity's copy is |
| `POST /api/v1/{Entity}/query` | Autotask's query body (`filter`, `MaxRecords`, `IncludeFields`); rows in id order, page with `id > last` |
| `GET /api/v1/{Entity}/{id}` | One record (`{ item }`, `null` when missing) |
| `POST /api/v1/{Entity}` | Create (send an `Idempotency-Key`) |
| `PATCH /api/v1/{Entity}` | Update `{ id, …only the fields to change }`. PUT is refused: Autotask blanks every field left out |
| `DELETE /api/v1/{Entity}/{id}` | Delete, when the key may delete |
| `/api/v1/{Parent}/{id}/{Child}` | Autotask's child URLs, e.g. `/Tickets/{id}/Notes`, `/Companies/{id}/Contacts` |

```http
POST /api/v1/Contacts/query
Authorization: Bearer psk_…
Content-Type: application/json

{ "filter": [ { "op": "exist", "field": "PortalUserId", "udf": true } ],
  "IncludeFields": ["id", "companyID", "isActive", "lastModifiedDate", "userDefinedFields"] }
```

## Good to know

- **Readable**: the 22 mirrored entities (tickets, notes, time, tasks, projects, service calls, to-dos, companies,
  contacts, contracts, resources, billing, opportunities, configuration items, appointments), user-defined fields
  included.
- **Writable**: time entries, tickets and notes, tasks, projects, service calls, to-dos, companies, contacts,
  configuration items, opportunities, appointments. Financial records go through the MCP's confirm-gated tools.
- **Freshness**: the mirror is current within about 5 minutes. Headers say where an answer came from
  (`X-PSArelay-Source: mirror | live | replay`) and how old it is.
- **When the mirror can't answer**, a mirror-only key gets 503 with the reason; a key allowed to go live makes one
  Autotask call within its live cap.
- **No push events**: to react to changes, poll the mirror (free). Autotask webhooks forwarded to PSArelay make the
  mirror re-read changed tickets, ticket notes, companies, contacts and configuration items on the next run.
- **Every write is logged** and listed on the Integrations page.

Full reference — filters, errors, idempotency, bookings, key settings:
[docs/INTEGRATION_API.md](https://github.com/GDSTechnology/psarelay/blob/main/docs/INTEGRATION_API.md).
