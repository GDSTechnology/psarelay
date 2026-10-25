# Deployment & caller-container attribution

How to answer "which container is making this request?" on a shared server, and
how impersonation is scoped per deployment.

## The three attribution signals

Every audit record now carries up to three independent signals, most-trusted
first:

| Field (audit log)        | Source            | Trust | Set by |
|--------------------------|-------------------|-------|--------|
| `instanceLabel`          | operator env      | high  | `MCP_INSTANCE_LABEL` on the container |
| `originRemoteAddr` / `originForwardedFor` / `originUserAgent` | transport | medium | captured server-side from the HTTP request |
| `source`                 | client `_meta`    | low   | the calling app declares it (`chatgpt`, `hermes-teams`, `n8n`, `cron`, …) |

- **`instanceLabel`** is the reliable answer to "which of my containers": the
  operator sets it per compose service, so it can't be spoofed by a caller.
- **origin** is what actually connected — the peer address (an internal Docker
  IP on the compose network, or a tunnel address), the first `X-Forwarded-For`
  hop a tunnel/proxy adds, and the `User-Agent`. Captured automatically; no
  config. Logged, never used for authorization.
- **`source`** is what the client *says* it is. Useful, but only as trustworthy
  as the caller — which is why impersonation is gated by instance, not by source.

`impersonationMode` is also recorded on every entry so you can see the posture
the serving instance enforced.

## Impersonation posture — per instance

Set `AUTOTASK_IMPERSONATION_MODE` on each container:

| Mode      | Behaviour |
|-----------|-----------|
| `off` (default) | Never impersonate. Writes are attributed to the integration (API) user. Use for n8n / cron / any unattended automation. |
| `caller`  | Tunnel writes as the calling user via `ImpersonationResourceId` — **only when an access token vouches for them** (a token naming a person, or a delegate token), unless `MCP_TRUST_UNVERIFIED_IDENTITY=true`. Degrades to the integration user when the caller can't be identified — never blocks. Use for the ChatGPT / Teams instance. |

Legacy `AUTOTASK_IMPERSONATION=on` (no mode set) maps to `caller`; unset maps to
`off`. Native impersonation also requires the API user's Autotask security level
to permit it.

Optional, `caller` mode only: `AUTOTASK_IMPERSONATION_SOURCES` is a
comma-separated allowlist of declared sources permitted to impersonate on a
shared instance (e.g. `chatgpt,hermes-teams`). Unset = all sources allowed.
Belt-and-suspenders on top of instance isolation.

## Environment flag reference (exact accepted values)

Do not assume a flag accepts `on` / `1` / `yes` — the accepted truthy value
**differs per flag**. Each flag's exact "on" value, default, and effect:

| Env var | Turn ON with (exact) | Default (unset) | Effect |
|---------|----------------------|-----------------|--------|
| `AUTOTASK_IMPERSONATION_MODE` | `caller` | `off` | Impersonation posture (see table above). `off` disables it. |
| `AUTOTASK_IMPERSONATION` (legacy) | `on`, `true`, `1`, or `yes` | off | Back-compat only; maps to `caller`. Prefer `_MODE`. Ignored when `_MODE` is set. |
| `AUTOTASK_IMPERSONATION_SOURCES` | comma list, e.g. `chatgpt,hermes-teams` | empty = **all** sources may impersonate | `caller` mode only: allowlist of declared sources permitted to impersonate. Valid sources: `chatgpt`, `hermes-teams`, `telegram`, `n8n`, `cron`. |
| `MCP_INSTANCE_LABEL` | any non-empty string, e.g. `gpt-teams` | empty = field omitted from audit | Stamps `instanceLabel` on every audit record. Observability only. |
| `MCP_TRUST_UNVERIFIED_IDENTITY` | `true` | off | `caller` mode: also trust the identity a client declares without an access token. Off = writes run as a person only when a token vouches for them (see docs/ADMIN.md → Access). |
| `MCP_TRANSPORT` | `http` | `stdio` | Serve over HTTP vs stdio. |
| `LAZY_LOADING` | `true` or `1` **only** (not `on`/`yes`) | off | Expose only the 3 discovery meta-tools initially. |
| `MCP_PERMISSIONS_ENABLED` | `true` **only** | off | Enforce role→risk permission intersection on mutating tools. Needs `AUTOTASK_ROLE_MAP`. |
| `MCP_PG_ENABLED` | `true` **only** | off | Master switch for the PostgreSQL layer. Every `MCP_PG_*` capability flag below is inert unless this is on. |
| `MCP_PG_AUDIT_ENABLED` | `true` **only** (and `MCP_PG_ENABLED=true`) | off | Persist audit records to Postgres in addition to the log. |
| `PAX8_CLIENT_ID` / `PAX8_CLIENT_SECRET` | Pax8 Partner API credentials | empty = `autotask_vendor_sync` off | Optional. Enables Pax8 invoice and pricing sync (docs/VENDOR_BILLING.md). Needs `MCP_PG_ENABLED=true`. |
| `MCP_VENDOR_MONITOR_HOUR_UTC` | `0`–`23` | empty = off | Optional. Daily vendor monitor at that UTC hour: stale imports, renewals, contracts ending, sync drift → Notifications (docs/VENDOR_BILLING.md). Needs `MCP_PG_ENABLED=true`. |
| `PAX8_TOKEN_URL` / `PAX8_AUDIENCE` / `PAX8_API_URL` | URLs | `https://login.pax8.com/oauth/token`, `api://p8p.client`, `https://api.pax8.com/v1` | Override only if Pax8 changes them. |

Note the inconsistency deliberately called out above: impersonation accepts
several truthy spellings, but `LAZY_LOADING`, `MCP_PERMISSIONS_ENABLED`, and all
`MCP_PG_*` flags accept **only** the literal string `true` (or `1` for
`LAZY_LOADING`). Anything else — including `on`, `yes`, `True` in the strict
ones — reads as **off**. When in doubt, use the exact value in this table.

To turn a feature OFF, set it to `off`/`false` **or remove the line** — every
flag defaults to off/inert when unset. There is no separate "disable" value to
remember.

## Recommended topology: one instance per consumer class

> **Target design, not current prod.** Production today runs a **single**
> instance (`autotask-mcp` on `:18080`) that serves every consumer. There is no
> `autotask-mcp-gpt` / `:18081`. For the live deploy and rollback procedure, see
> [`DEPLOY.md`](../DEPLOY.md). This section and the migration below describe
> where the layout is headed.

Rather than sniff the network to tell consumers apart, isolate them by instance.
See [`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml):

- `autotask-mcp` (`:18080`) — n8n + cron. `AUTOTASK_IMPERSONATION_MODE=off`,
  `MCP_INSTANCE_LABEL=n8n-cron`. Physically cannot impersonate.
- `autotask-mcp-gpt` (`:18081`) — ChatGPT + Teams.
  `AUTOTASK_IMPERSONATION_MODE=caller`, `MCP_INSTANCE_LABEL=gpt-teams`.

"Which container" = which port received it, and the security boundary is set by
config, not by a spoofable field.

## Migrating to the two-instance split

Commands below run **on the production host**, in the compose project directory
that already holds the `autotask-mcp` service. Take the backups in
[`DEPLOY.md`](../DEPLOY.md) §4 first.

1. Add the second service and the new env keys to the live `docker-compose.yml`
   (model it on `deploy/docker-compose.prod.yml`), keeping the existing
   `autotask-mcp` service but adding `MCP_INSTANCE_LABEL` and
   `AUTOTASK_IMPERSONATION_MODE=off` to it.
2. Both services track `image: ghcr.io/gdstechnology/psarelay:latest`, so
   every deploy — first cutover and each subsequent release — is the same two
   commands, with no version to edit in the YAML (semantic-release publishes
   `:latest` alongside each version tag). The first release carrying per-instance
   mode is >= 3.2.0.

   ```bash
   docker compose pull autotask-mcp autotask-mcp-gpt    # fetch the newest :latest image
   docker compose up -d autotask-mcp autotask-mcp-gpt   # recreate just these two
   ```

   Name the services explicitly. If the compose project also runs n8n or other
   stacks, a bare `pull` / `up -d` would pull and recreate those too.

   To pin a known-good build or roll back, replace `:latest` with a specific tag
   (`:3.2.0`) or a digest and re-run `up -d`.
3. Point the ChatGPT connector / Teams relay at `:18081`; leave n8n and cron on
   `:18080`.
4. Verify attribution — each instance stamps its label:

   ```bash
   docker compose logs -f autotask-mcp-gpt | grep '"audit":true'
   ```
   You should see `instanceLabel`, `impersonationMode`, and the `origin*` fields
   on each call.

To validate write-attribution end-to-end you need a real POST from the
identified user (the read-only test account can't write); confirm the created
record's `createdByResourceID` is the impersonated user, not the API user.
