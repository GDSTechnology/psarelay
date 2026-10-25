---
title: Configuration
description: Environment variables for credentials, transport, the Postgres layer, the console and bulk jobs.
---

| Variable | Default | |
|---|---|---|
| `AUTOTASK_USERNAME` / `AUTOTASK_SECRET` / `AUTOTASK_INTEGRATION_CODE` | — | API user credentials (required) |
| `AUTOTASK_API_URL` | auto-detected | Override the zone URL |
| `AUTOTASK_IMPERSONATION` | `off` | `on`: writes are recorded as the identified requesting user |
| `MCP_TRANSPORT` | `stdio` | `http` for remote clients |
| `MCP_REQUIRE_TOKEN` | `false` | Require an access token (`Authorization: Bearer psr_…`, created in the console) on every `/mcp` call |
| `MCP_CORS_ORIGINS` | AI clients | Web origins allowed to call `/mcp` from a browser; `none` = none. Never `*` |
| `MCP_HTTP_PORT` / `MCP_HTTP_HOST` | `8080` / `0.0.0.0` | HTTP transport |
| `MCP_PG_ENABLED` and `MCP_PG_*` | off | The Postgres layer (connection, schema, roles) |
| `MCP_PG_SHADOW_ENABLED`, `MCP_PG_SHADOW_SERVE_READS` | off | Mirror sync, and answering reads from it |
| `MCP_PG_SHADOW_PAUSE_AT_PCT` | `85` | Skip a sync run above this tenant usage (kept high: a stale mirror sends reads live) |
| `MCP_ADMIN_ENABLED` / `MCP_ADMIN_PORT` | off / `8090` | The admin console |
| `MCP_BULK_SLOW_AT_PCT` / `MCP_BULK_STOP_AT_PCT` | `40` / `65` | Bulk jobs halve their pace / wait at this tenant usage |
| `AUTOTASK_MAX_CONCURRENT_PER_ENDPOINT` | `2` | Concurrent calls per endpoint (Autotask allows 3) |
| `AUTOTASK_AUTH_PAUSE_SECONDS` | `300` | Pause after a rejected login (doubles up to an hour) |
| `MCP_PUBLIC_URL` | — | The address AI clients use for this server (e.g. your tunnel); shown on the Setup page |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `simple` | `json` for production |

Many operational settings — the read-only switch, serving reads from the mirror, mirror pause threshold, caller
names, the actor registry, notification channels — are changed live in the [console](/guides/console/)
and override the environment.

The complete list, with production values explained, is in the
[deploy runbook](https://github.com/GDSTechnology/psarelay/blob/main/DEPLOY.md).
