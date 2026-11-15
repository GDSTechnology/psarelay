---
title: Postgres mirror
description: How the optional Postgres layer mirrors Autotask, answers most reads without an API call, and checks itself every night.
---

The Postgres layer is optional, but in production it is what keeps the tenant's shared hourly API limit in reach.
Besides the mirror it holds change plans, bulk jobs, the operation log, the ticket-history index and the console's
users and settings.

## What is mirrored

22 entities: tickets, ticket notes, time entries, tasks, projects, service calls, company to-dos, companies,
contacts, contracts, contract services and blocks, resources, invoices, billing items, ticket / project / contract
charges, expense items, opportunities, configuration items and calendar appointments.

| Sync mode | Used for | How |
|---|---|---|
| **Incremental** | entities with a reliable modified stamp | every run, rows changed since the watermark (with overlap) |
| **Window refresh** | entities without one (notes, billing) | new rows every run; recent days hourly, the whole window daily |
| **Full refresh** | small reference tables | periodically |

Rows the MCP itself writes are re-read on the next run, and a new note or time entry also queues its ticket and
task — Autotask moves their "last activity" fields without moving the modified stamp. A nightly id-only sweep
marks rows Autotask no longer returns as deleted.

## Serving reads

While the mirror is fresh, searches and by-id reads are answered from Postgres — about **80% of reads** in
production, with **no Autotask call**. User-defined fields are a structured column, so UDF filters and group-bys
work too. A row the MCP just wrote is read live until the mirror has it.

`autotask_shadow_query` and `autotask_shadow_aggregate` give clients direct read-only access (counts, sums,
group-by) at no API cost. Other systems read the same copy over REST through the
[Integration API](/guides/integration-api/).

## The mirror checks itself

Every night (and on demand from the console) the **mirror check** re-reads a random sample of each entity from
Autotask, compares it field by field and compares row counts. Expected lag is classified as such; real
differences are reported and **repaired from Autotask**, which is always authoritative.

## Budget

A sync run spends at most 100 calls and skips while the tenant is above 85% usage or in a 429 cooldown. The
threshold is high on purpose: pausing the sync makes the mirror stale, and a stale mirror sends every read live.

Full details: [docs/POSTGRES.md](https://github.com/GDSTechnology/psarelay/blob/main/docs/POSTGRES.md).
