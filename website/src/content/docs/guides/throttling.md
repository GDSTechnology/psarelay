---
title: Throttling
description: Autotask's real API limits, what the server does on its own to stay inside them, and how a dispatcher should react.
---

## Autotask's limits

| Limit | Value |
|---|---|
| Requests per hour | **10,000 per database** — shared by *every* integration on the tenant |
| Added latency | **+0.5 s per call from 50%** usage, **+1 s from 75%** |
| Past the limit | HTTP **429** until the hour rolls |
| Concurrency | **3** concurrent requests per integration per endpoint |
| Query size | at most 500 rows per page, sorted by id |

The limit is the tenant's, not yours: one integration's burst slows every other integration down.

## What the server does

| Mechanism | Behaviour |
|---|---|
| **Mirror and cache** | Most reads never reach Autotask (see [Postgres mirror](/guides/mirror/)). |
| **429 cooldown** | A 429 starts a local cooldown; calls fail fast with "do not retry" instead of extending the penalty. |
| **Concurrency gate** | At most 2 (configurable up to 3) calls per endpoint; extra calls queue. |
| **Caller and tenant caps** | At most 4 calls in flight per caller and 8 for the tenant (configurable); extra calls queue, so one chat burst can't starve the dispatchers. |
| **Transient retry** | A read that hits a network error, timeout or 502/503/504 is retried twice with jittered backoff. Writes and HTTP 500 (Autotask's validation errors) never are. |
| **Outage breaker** | Per module: 5 network errors / 5xx answers in a minute on one endpoint (say Quotes) and calls to *it* fail locally for 30 s, then one test call decides — every other module carries on. Failures across 3+ endpoints pause the whole tenant. |
| **Mirror sync** | Skips a run above 85% usage or during a cooldown; capped at 100 calls a run. |
| **Bulk jobs** | Re-read tenant usage every minute while writing; half pace from 40%, stop from 65%; quiet hours. |
| **Login protection** | A rejected login pauses everything, so retries can't lock the API user. |

## For dispatchers (n8n, cron, agents)

Call `autotask_get_backpressure` (0 Autotask calls; also on `GET /health`). It answers **ok**, **slow** (essential
calls only, one at a time, postpone bulk work) or **stop** (queue and retry after `retryAfterSeconds`), with the
reasons. Scope searches by date range and parent records before iterating — fan-out is what burns the hour.

## Finding the heavy integration

The console shows tenant usage against this MCP's share and who calls it. For **other** integrations, Autotask's own
**API Activity By Hour** report (Admin → Extensions & Integrations) breaks each hour down per API user — reads
included. Bulk-job quiet hours exist because that report showed one integration bursting to 9,000 calls an hour.

Full details: [docs/THROTTLING.md](https://github.com/GDSTechnology/psarelay/blob/main/docs/THROTTLING.md).
