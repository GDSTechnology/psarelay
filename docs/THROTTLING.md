# Throttling, backoff and backpressure

What the MCP does on its own to protect the Autotask tenant, and how a
dispatcher (n8n, Hermes, cron) should react. Gap register **MCP-008**.

Autotask's limits, per the official docs:
- **10,000 requests per hour per database**, shared by every integration.
- **Added latency** per call: 0.5 s at 50–75% of the hourly limit, 1 s above 75%.
- **3 concurrent requests per integration per object endpoint.** The 4th gets a 429.

## What the MCP does

| Situation | MCP behaviour | Retries? |
|---|---|---|
| **401** (login rejected) | Login protection: the first 401 pauses **all** calls for the tenant (`AUTOTASK_AUTH_PAUSE_SECONDS`, default 300 s, doubling up to 1 h). The zone is re-looked-up, and the request is retried once only if the zone changed. At most `AUTOTASK_AUTH_MAX_PROBES` (2) single test calls follow; if those fail, the tenant is **held** until an administrator presses **Retry now** in the console. The pause is saved in Postgres, so restarts and deploys keep it. | Never automatic beyond the probes |
| **429** (threshold) | A cooldown starts for the `Retry-After` time (default 60 s, capped at 5 min). Every call for that tenant fails **locally**, with no upstream request, until it passes. The error says "Do NOT retry". | No |
| **Concurrency** | Each endpoint has a gate, `AUTOTASK_MAX_CONCURRENT_PER_ENDPOINT` (default 2, max 3). Extra calls **queue**; they do not fail. Cached and coalesced reads take no slot. | n/a |
| **Caller and tenant caps** | At most `MCP_MAX_CONCURRENT_PER_CALLER` (default 4) calls in flight per caller (the tool call's source + user) and `AUTOTASK_MAX_CONCURRENT_TOTAL` (default 8) for the whole tenant, so one chat burst can't take every slot from the dispatchers. Extra calls **queue**. Background work (mirror sync, bulk worker) counts toward the tenant cap only. | n/a |
| **Network error, timeout, 502 / 503 / 504** | A **read** (GET, POST …/query) is retried up to `AUTOTASK_READ_RETRIES` (default 2) times, with exponential backoff and full jitter (≤ 0.5 s, ≤ 1 s, …, capped at 4 s); its slots are released while it waits. A **write** is never retried — it may have landed. **HTTP 500 is never retried**: Autotask answers validation errors with 500. | Reads only, automatically |
| **Outage** | `AUTOTASK_OUTAGE_FAILURES` (default 5) network errors / 502–504 answers within a minute open a **breaker**: for 30 s every call fails **locally** with a retryable `AutotaskOutageError` ("NOT sent", `retryAfterSeconds`). Then one test call goes through; success closes it, failure re-opens it twice as long (up to 5 min). Any HTTP answer other than 502–504 counts as "Autotask is up". | After the wait |
| **Truncated / empty 2xx body** | Fails closed with a retryable `AutotaskResponseError`. It is never treated as "no records". | Caller decides |
| **Shadow sync** | Skips a run when tenant usage is at or above `MCP_PG_SHADOW_PAUSE_AT_PCT` (default 85%; kept high because a stale mirror sends reads live), and during a 429 cooldown or login pause. Each run is capped at `MCP_PG_SHADOW_MAX_CALLS_PER_RUN`. | Next run |
| **Bulk jobs** | The worker halves its pace from 40% tenant usage and stops at 65% (`MCP_BULK_SLOW_AT_PCT`, `MCP_BULK_STOP_AT_PCT`), well before the dispatcher thresholds (50% / 90%). It also stops during a 429 cooldown or login pause, and for the read-only switch. | Resumes by itself |
| **Bulk tools** | The activity feed, history backfill and audit tools take `maxApiCalls` and report anything they cut off as pending. The backfill also pauses at `pauseAtUsagePct`. | Caller continues |

There is **no per-client hourly budget** — callers are capped on concurrency, not volume. Budgets are per call
(`maxApiCalls`) and per sync run. Use the console's **Calls** page to see which caller sends
what.

## What a dispatcher should do

Check backpressure before a batch, and after any error, using one of:
- `GET /health` → `backpressure: { level, reasons, retryAfterSeconds, usedPct }`, with no MCP auth and no Autotask call;
- the tool `autotask_get_backpressure`, which gives the full detail. `refresh: true` takes a fresh usage reading, which costs 1 call.

| level | Meaning | Do |
|---|---|---|
| `ok` | No pressure | Proceed normally |
| `slow` | Usage ≥ 50% (Autotask is adding latency), a login re-test is in progress, or requests are queuing | Essential calls only, one at a time. Postpone backfills, bulk syncs and reports. |
| `stop` | Login paused or held, a 429 cooldown, the outage breaker open, or usage ≥ 90% | Send nothing. Queue the work and retry after `retryAfterSeconds`. If the login is **held** (`retryAfterSeconds: null`), wait for an administrator. |

**Errors returned by tools:**
- `error_type: rate_limited` carries `retry_after_seconds`. Wait that long and don't retry before.
- A 401 / login-paused error means stop. Don't loop: every retry while paused fails locally anyway.
- For writes, send `_meta.idempotencyKey` (see [POSTGRES.md](POSTGRES.md#operation-log--correlation--durable-idempotency-autotask_get_operations)). A retry after an unclear failure then replays, or is refused, instead of writing twice.
