# PSArelay — Deploy & Rollback Runbook

Production target: **the production host** (the existing GDS environment — do not
introduce a second VPS). This runbook covers deploying the published image and
rolling it back. It follows the traceability rules in the implementation brief
§7.34: the deployed version is proven from the running container's `/health`,
never inferred from a repo/tag alone.

## Current production layout (verified 2026-09-29)

| What | Value |
|---|---|
| Host | the production host |
| Compose project | `n8n`, file `/opt/n8n/docker-compose.yml` |
| Service / container | `autotask-mcp` / `n8n-autotask-mcp-1` |
| Port | `127.0.0.1:18080 -> 8080` |
| Image | `ghcr.io/gdstechnology/psarelay:latest` |
| Sibling containers | `gds-openai-autotask-tunnel` (`ghcr.io/openai/tunnel-client:v0.0.11`), `n8n-autotask-cron-scheduler-1` |

Prod runs a **single** MCP instance that serves every consumer (ChatGPT via the
tunnel, n8n, cron). There is **no** `autotask-mcp-gpt` / `:18081` instance.
[`deploy/docker-compose.prod.yml`](deploy/docker-compose.prod.yml) describes a
two-instance split as the reference **target** design, not what is running.

## Upgrading from autotask-mcp (v3.x) to PSArelay (v4.0.0) — once

v4.0.0 renamed the project and its image: `ghcr.io/gdstechnology/autotask-mcp` → `ghcr.io/gdstechnology/psarelay`,
and `update-autotask-mcp` → `update-psarelay`. Nothing else changes on the host: **keep the compose service
name** (`autotask-mcp`), its env file and its port — n8n and tunnels reach the server by that name, and
`update-psarelay` finds it.

1. **Make the new package public, once** (new GHCR packages start private and the host pulls without logging in):
   GitHub → GDSTechnology → Packages → `psarelay` → Package settings → Change visibility → Public.
2. **On the host**, point the compose file at the new image, install the new updater and run it:

```bash
cd /opt/n8n && cp docker-compose.yml "docker-compose.yml.bak-$(date +%F)" && sed -i 's#ghcr.io/gdstechnology/autotask-mcp:#ghcr.io/gdstechnology/psarelay:#' docker-compose.yml && grep -n "gdstechnology/psarelay" docker-compose.yml
```

```bash
docker pull ghcr.io/gdstechnology/psarelay:latest && docker run --rm --entrypoint cat ghcr.io/gdstechnology/psarelay:latest /app/deploy/update-psarelay.sh > /usr/local/bin/update-psarelay && chmod +x /usr/local/bin/update-psarelay && rm -f /usr/local/bin/update-autotask-mcp
```

```bash
update-psarelay
```

`update-psarelay` sees the running container on the old image name (it accepts both), keeps it as
`ghcr.io/gdstechnology/psarelay:rollback`, migrates, restarts and prints `version: 4.0.0`. To go back, restore the
compose backup and `docker compose up -d autotask-mcp`.

## 0. Traceability principle

Every release records **three** facts, baked into the image at build time and
reported by `/health`:

- `VERSION` — the release version
- `COMMIT_SHA` — the exact source commit
- `BUILD_DATE` — UTC build timestamp

The image builds from public dependencies only — **no registry token**.

## 1. Prerequisites

- A shell on the production host with Docker + the compose plugin, and pull access to
  `ghcr.io/gdstechnology/psarelay`.
- A published release: `.github/workflows/release.yml` (semantic-release) builds
  and pushes `:<version>` **and** `:latest` on every releasable push to `main`,
  baking in VERSION/COMMIT_SHA/BUILD_DATE. Note the version it released (GitHub
  Release / tag) — that is what `/health` must report after the deploy.
- The Autotask API credentials for the GDS tenant (below), already configured for
  the `autotask-mcp` service in the `n8n` compose project.

## 2. Environment variables

Required (Autotask API):

| Var | Purpose |
|---|---|
| `AUTOTASK_USERNAME` | API user |
| `AUTOTASK_SECRET` | API secret |
| `AUTOTASK_INTEGRATION_CODE` | Integration code |
| `AUTOTASK_API_URL` | Optional — pin the zone URL to skip zone lookup |

Behavior / safety (set as needed):

| Var | Purpose |
|---|---|
| `AUTOTASK_DEFAULT_OWNER_RESOURCE_ID` | Default company owner when a create omits `ownerResourceID` (§6.1) |
| `AUTOTASK_PROTECTED_COMPANY_IDS` | Comma-separated extra protected company IDs (company `0` is always protected, §7.31) |
| `MCP_TRANSPORT` | `http` for the server deployment |
| `MCP_HTTP_PORT` / `MCP_HTTP_HOST` | Default `8080` / `0.0.0.0` |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` in production |
| `LAZY_LOADING` | Progressive tool discovery (optional) |

Webhooks (set when the MCP creates Autotask webhooks for n8n):

| Var | Purpose |
|---|---|
| `AUTOTASK_WEBHOOK_SECRET` | Shared signing secret (≤ 64 chars; Autotask recommends 10+). `autotask_create_webhook` uses it when `secretKey` is omitted, so the secret never appears in chat, and it is never echoed back. The **n8n service needs the same value** to verify `X-Hook-Signature` |
| `AUTOTASK_WEBHOOK_EXCLUDE_RESOURCE_IDS` | Extra resource IDs (comma-separated) whose changes must not fire new webhooks. The MCP's own API user is excluded automatically (`excludeSelf`, default on) |

Read cache and lookups (defaults are fine; tune only if needed):

| Var | Purpose |
|---|---|
| `AUTOTASK_CACHE` | `off` disables the Autotask read cache (on by default; writes always invalidate) |
| `AUTOTASK_CACHE_TTL_FIELDS_SECONDS` | Field/picklist metadata TTL (default `3600`) |
| `AUTOTASK_CACHE_TTL_REFERENCE_SECONDS` | Reference data, e.g. roles, work types (default `900`) |
| `AUTOTASK_CACHE_TTL_SLOW_REFERENCE_SECONDS` | Companies / contacts / contracts (default `300`) |
| `AUTOTASK_CACHE_TTL_VOLATILE_SECONDS` | Tickets, notes, time entries (default `30`) |
| `MCP_PG_SHADOW_VERIFY_HOUR_UTC` / `MCP_PG_SHADOW_VERIFY_SAMPLE` | Nightly mirror consistency check: UTC hour (default `8`) and random rows per entity (default `10`, max 50). About 2 Autotask calls per entity; differences are repaired from Autotask |
| `MCP_PG_SHADOW_REFRESH_DAYS` | Billing mirror (Invoices, BillingItems, charges): how many recent days are re-read hourly to catch paid / voided / invoiced edits (default `30`; the whole window is re-read daily) |
| `MCP_CALLER_LABELS` | Admin console names for clients that don't declare a `source`, e.g. `172.19.0.3=n8n,Python-urllib=cron` (IP or user-agent text = name). Editable in the console under Settings → Caller names |
| `AUTOTASK_AUTH_PAUSE_SECONDS` | After Autotask rejects the API credentials (HTTP 401), pause all calls for this long (default `300`, doubling per repeat up to 60 min) so failed logins don't lock the API user; `0` disables. Clear early with **Retry now** in the admin console |
| `AUTOTASK_AUTH_MAX_PROBES` | Test calls after a rejected login before Autotask calls are **held** until an admin presses Retry now (default `2`). The pause is saved in Postgres (migration 0006) so restarts respect it; changing the secret clears it |
| `AUTOTASK_COMPANY_PREWARM` | `on` restores the eager walk of every company at startup. Off by default: company names are looked up on demand |

Keep secrets in the server's env file / secret store — never in the image.

**Sharing the webhook secret with n8n.** In the production layout `autotask-mcp`
reads `/opt/n8n/autotask-mcp.env` (`env_file`), and the `n8n` service has only an
`environment:` map. Put the secret in both `autotask-mcp.env` and `/opt/n8n/.env`
(Compose reads `.env` for `${…}` interpolation, `chmod 600` both), and reference
it from n8n's block, so the value is never written into the compose file:

```yaml
    environment:
      AUTOTASK_WEBHOOK_SECRET: ${AUTOTASK_WEBHOOK_SECRET}
```

Recreate both (`docker compose up -d autotask-mcp n8n`) and confirm they match
without printing the secret:

```bash
cd /opt/n8n && for s in autotask-mcp n8n; do echo "$s: $(docker compose exec -T $s sh -c 'printf %s "$AUTOTASK_WEBHOOK_SECRET" | sha256sum | cut -c1-8')"; done
```

To rotate: change it in both files, recreate both services, then run
`autotask_update_webhook` with `useEnvSecret: true` on each webhook.

## 3. Where the image comes from

The routine path needs no manual build: the release workflow publishes
`ghcr.io/gdstechnology/psarelay:<version>` and `:latest` from the release
commit with VERSION/COMMIT_SHA/BUILD_DATE baked in. The GitHub Release records
the version + commit.

`scripts/build-image.sh <version>` remains for out-of-band builds (e.g. an
air-gapped `docker save` / `docker load` transfer). It bakes the same three facts
and prints the digest, but it is **not** part of the routine deploy.

## 4. Deploy on the production host

**Wait for the last release run.** Each merge to `main` cuts its own release; when
several PRs merge together, pull only after the **last** release workflow has
finished, or you deploy a version that is already superseded.

Save the current `/health` (it names the version you are rolling back to, if it
comes to that):

```bash
curl -s http://127.0.0.1:18080/health > ~/autotask-mcp-prev-health.json
```

Then run the deploy: **`update-psarelay`**. It is re-run-safe: it pulls, and *only if the
pull brought a new image* it tags the previous one `:rollback`, runs the migrations,
recreates the service, prunes the old untagged image, waits for `/health` and prints
the version. With nothing new released it changes nothing. It also refuses while a
bulk job is **preparing** (a restart fails the preparation; `--force` overrides).
`update-psarelay --recreate` restarts on the same image after an env-file change;
`update-psarelay --help` lists the options.

Install it once (from the image, no download from the internet). After that it
refreshes itself from each new image:

```bash
docker run --rm --entrypoint cat ghcr.io/gdstechnology/psarelay:latest /app/deploy/update-psarelay.sh > /usr/local/bin/update-psarelay && chmod +x /usr/local/bin/update-psarelay
```

```bash
update-psarelay
```

The same steps as one command, for a host without the script (or an image older
than the script):

```bash
cd /opt/n8n && OLD=$(docker inspect n8n-autotask-mcp-1 --format '{{.Image}}') && docker compose pull autotask-mcp && NEW=$(docker image inspect ghcr.io/gdstechnology/psarelay:latest --format '{{.Id}}') && if [ "$OLD" != "$NEW" ]; then docker tag "$OLD" ghcr.io/gdstechnology/psarelay:rollback && docker compose run --rm --no-deps -T autotask-mcp node dist/db/migrate.js && docker compose up -d autotask-mcp && docker image prune -f; else echo "Already on the latest image - nothing changed"; fi; sleep 3; curl -s http://127.0.0.1:18080/health
```

Only the `autotask-mcp` service is recreated — the tunnel and cron scheduler are
left untouched. The health JSON reports `version` (and `apiUsage`) — it must
equal the version the release workflow just published. Right after a restart
`/health` can be empty for a moment; re-run the `curl`.

Why it is shaped this way:

- **Tag before prune.** `docker compose pull` moves `:latest`, leaving the
  previous image untagged ("dangling"). `docker image prune -f` deletes dangling
  images, so the previous image must get the `:rollback` tag first or the
  rollback target is deleted.
- **Prune every deploy.** Without it each release leaves the old image untagged (~300 MB; ~750 MB before the image was slimmed)
  behind; months of releases filled the host disk (one cleanup reclaimed 25 GB).
  `prune -f` removes only dangling images, never tagged or running ones.
- **Compare OLD vs NEW.** An earlier two-step version tagged the *running* image
  as `:rollback` unconditionally. Re-run with no new release, it pointed
  `:rollback` at the current version and the prune deleted the real previous
  one. The `if` makes a re-run a no-op.

**What an update keeps.** The deploy replaces only the `autotask-mcp`
container. The admin console's web pages ship inside the image, so they update
with each release. Everything you configured lives outside the image and is
kept:

| What | Where it lives | Touched by a deploy? |
|---|---|---|
| Console on/off, port | `autotask-mcp.env` | No |
| Console users, settings, activity log; the shadow | Postgres volume `autotask-mcp-pg` | No (migrations only add) |
| Cloudflare Tunnel + its token | `autotask-mcp-admin-tunnel/` (own compose project) | No |

After a deploy, `/health` shows `"admin": {"running": true, "schemaReady": true}`
when the console came back up. **Never** run `docker compose down -v` in
`/opt/n8n` — `-v` deletes the volumes, including the console's users and the
shadow.

Check what is kept at any time:

```bash
docker images ghcr.io/gdstechnology/psarelay
#   -> :latest (running) and :rollback (the previous release); nothing <none>
```

## 5. Verify (acceptance — brief §7.34)

More than a health ping:

```bash
# 1. Version matches the release that was published
curl -s http://127.0.0.1:18080/health | jq '{status, version}'
#    -> version must equal the new release version

# 2. The container is running the newly pulled image
docker inspect n8n-autotask-mcp-1 --format '{{.Image}}'
docker image inspect ghcr.io/gdstechnology/psarelay:rollback --format '{{.Id}}'
#    -> the two IDs differ (unless nothing new was released)

# 3. A real MCP read works end-to-end (initialize + a read tool), not just /health.
#    From the ChatGPT connector / n8n, call autotask_test_connection (read-only,
#    changes nothing) and confirm a successful response.
```

Then confirm the **MCP tunnel (`gds-openai-autotask-tunnel`) and the ChatGPT
connector** reach the server and list tools. For the n8n path, confirm it calls
this MCP directly (no Hermes/LLM hop) and that a controlled run verifies business
fields + audit-note readback.

## 6. Rollback

If verification fails, point the service at the `:rollback` image the deploy
saved. `:latest` already points at the bad build, so re-pulling it would fetch
the same bad image.

Back up the compose file, then edit `/opt/n8n/docker-compose.yml` and set the
`autotask-mcp` service's image:

```bash
cp /opt/n8n/docker-compose.yml ~/n8n-docker-compose.yml.bak
```

```yaml
  autotask-mcp:
    image: ghcr.io/gdstechnology/psarelay:rollback   # ROLLBACK — was ghcr.io/gdstechnology/psarelay:latest
```

Recreate **without pulling** and confirm the old version is back:

```bash
cd /opt/n8n && docker compose up -d autotask-mcp && sleep 3 && curl -s http://127.0.0.1:18080/health
```

`version` must match `~/autotask-mcp-prev-health.json`. The `:rollback` tag is
local, so rollback needs no rebuild and no registry.

**If `:rollback` is missing or wrong** (e.g. pruned by an older deploy routine),
pin a version tag instead — the release workflow keeps every one in the registry:

```bash
docker pull ghcr.io/gdstechnology/psarelay:<prev-version>
```

and use `image: ghcr.io/gdstechnology/psarelay:<prev-version>` in the
compose file.

**While pinned, `docker compose pull` will not pick up new releases.** Once a
fixed release is published, restore
`image: ghcr.io/gdstechnology/psarelay:latest` (or restore
`~/n8n-docker-compose.yml.bak`) and run the §4 deploy again.

## 7. Release checklist

- [ ] `main` green in CI; release workflow published `:<version>` + `:latest`.
- [ ] Released VERSION + COMMIT_SHA recorded (GitHub Release).
- [ ] The **last** release run of the batch has finished.
- [ ] Saved the current `/health` to `~/autotask-mcp-prev-health.json`.
- [ ] Ran the §4 re-run-safe deploy command in `/opt/n8n`.
- [ ] `/health` on `127.0.0.1:18080` reports the expected version.
- [ ] `autotask_test_connection` succeeds through the ChatGPT connector.
- [ ] `docker images ghcr.io/gdstechnology/psarelay` shows `:latest` and
      `:rollback`, and no `<none>` images.

## 8. Postgres shadow (optional — cuts Autotask API load)

A dedicated Postgres for the MCP (never n8n's database or roles), holding a
read-only mirror of Tickets, TimeEntries, Companies, Contacts and Contracts so
heavy reads cost no Autotask calls. Details: [docs/POSTGRES.md](docs/POSTGRES.md).

**1. Passwords** — generated into `/opt/n8n/.env` (for the database container)
and `autotask-mcp.env` (for the MCP), never displayed. Run once:

```bash
cd /opt/n8n && SU=$(openssl rand -hex 24) MIG=$(openssl rand -hex 24) APP=$(openssl rand -hex 24) && printf 'MCP_PG_SUPERUSER_PASSWORD=%s
MCP_PG_MIGRATOR_PASSWORD=%s
MCP_PG_APP_PASSWORD=%s
' "$SU" "$MIG" "$APP" >> .env && printf '
MCP_PG_ENABLED=true
MCP_PG_HOST=autotask-mcp-db
MCP_PG_PORT=5432
MCP_PG_DATABASE=gds_autotask_mcp
MCP_PG_SCHEMA=autotask_mcp
MCP_PG_USER=gds_autotask_mcp_app
MCP_PG_PASSWORD=%s
MCP_PG_MIGRATOR_USER=gds_autotask_mcp_migrator
MCP_PG_MIGRATOR_PASSWORD=%s
MCP_PG_SSL=false
MCP_PG_SHADOW_ENABLED=true
' "$APP" "$MIG" >> autotask-mcp.env && chmod 600 .env autotask-mcp.env && unset SU MIG APP && echo written
```

**2. Init script** — the role/schema setup from this repo:

```bash
mkdir -p /opt/n8n/autotask-mcp-pg-init && curl -fsSL https://raw.githubusercontent.com/GDSTechnology/psarelay/main/deploy/postgres-init/01-roles-schema.sh -o /opt/n8n/autotask-mcp-pg-init/01-roles-schema.sh && chmod 755 /opt/n8n/autotask-mcp-pg-init/01-roles-schema.sh
```

**3. Compose** — add this service to `/opt/n8n/docker-compose.yml` (no host
port: only the MCP container reaches it), add `autotask-mcp-pg:` under the
top-level `volumes:`, and make `autotask-mcp` `depends_on` it:

```yaml
  autotask-mcp-db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${MCP_PG_SUPERUSER_PASSWORD}
      POSTGRES_DB: gds_autotask_mcp
      MCP_PG_MIGRATOR_PASSWORD: ${MCP_PG_MIGRATOR_PASSWORD}
      MCP_PG_APP_PASSWORD: ${MCP_PG_APP_PASSWORD}
    volumes:
      - autotask-mcp-pg:/var/lib/postgresql/data
      - ./autotask-mcp-pg-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d gds_autotask_mcp"]
      interval: 10s
      timeout: 5s
      retries: 10
```

**4. Start, migrate, restart the MCP:**

```bash
cd /opt/n8n && docker compose config --quiet && docker compose up -d autotask-mcp-db && sleep 10 && docker compose exec -T autotask-mcp node dist/db/migrate.js && docker compose up -d autotask-mcp && sleep 5 && curl -s http://127.0.0.1:18080/health
```

`/health` gains a `shadow` block. The backfill then runs in the background
(≤ 100 calls per 5-minute run, paused above 50% tenant usage); follow it with
`autotask_shadow_status`. Once every entity is `ready`, set
`MCP_PG_SHADOW_SERVE_READS=true` in `autotask-mcp.env` and recreate
`autotask-mcp` to have the search tools answered from the shadow.

**Turn it off** — `MCP_PG_SHADOW_ENABLED=false` (or `MCP_PG_ENABLED=false`) and
recreate `autotask-mcp`; the MCP goes back to live-only. The data volume stays.

## 9. Admin console (optional — web UI for status, switches and users)

Needs §8 (the console keeps its users and settings in that Postgres). Full
guide: [docs/ADMIN.md](docs/ADMIN.md).

**Order:** merge → wait for the last release run → deploy it with §4 (pulls the
image and runs the migrations) → confirm `/health` shows the new version → then
run the setup wizard from the compose directory. It turns the console on in
`autotask-mcp.env` (backup kept), runs the migrations, restarts the MCP,
prints a **generated first-admin password once**, and walks through a Cloudflare Tunnel step by step (checking each step from the
host); the dashboard steps are written out in docs/ADMIN.md:

```bash
cd /opt/n8n && docker run --rm --entrypoint cat ghcr.io/gdstechnology/psarelay:latest /app/deploy/admin-setup.sh > admin-setup.sh && bash admin-setup.sh
```

The console listens on its own port (`MCP_ADMIN_PORT`, default `8090`) inside
the container — not published on the host. A tunnel route points at
`autotask-mcp:8090`, so the MCP endpoint and webhook receiver on `8080` are never
reachable through it.

| Var | Purpose |
|---|---|
| `MCP_ADMIN_ENABLED` | `true` starts the console (HTTP transport + Postgres layer required) |
| `MCP_ADMIN_PORT` / `MCP_ADMIN_HOST` | Default `8090` / `0.0.0.0` |
| `MCP_ADMIN_COOKIE_SECURE` | `auto` (Secure behind HTTPS), `true`, `false` |
| `MCP_ADMIN_TRUST_PROXY` | `true` (default): client IP from `CF-Connecting-IP` / `X-Forwarded-For` |

Locked out: `docker compose exec autotask-mcp node dist/admin/cli.js reset-password admin`.

**Turn it off** — `MCP_ADMIN_ENABLED=false` and recreate `autotask-mcp`. Settings
saved in the console stop applying, so the env file rules again. To pause the
tunnel only: `docker compose -f autotask-mcp-admin-tunnel/docker-compose.yml down`.
