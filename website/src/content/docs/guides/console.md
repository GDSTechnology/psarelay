---
title: Admin console
description: The web console for the people running the server — usage, callers, mirror health, switches, requests, bulk jobs.
---

A small web UI for whoever runs the MCP. Administrators change settings; read-only users look. It needs the
Postgres layer, and is set up with a guided wizard that also walks you through publishing it with a Cloudflare
Tunnel.

## Pages

| Page | What it shows |
|---|---|
| **Dashboard** | Server version and uptime, Autotask API usage for the whole tenant vs this MCP's share, reads answered locally, tool gaps, warnings such as Autotask's latency tiers, mirror sync state and the nightly **mirror check** (with *Check now*). |
| **Calls** | Who is calling (by caller and background job), errors and not-found results, Autotask calls per tool, reads per entity with what could be mirrored, the server log. |
| **Actors** | Which Autotask resources are people, integrations or the system — and which technicians are the reference standard. |
| **Requests** | Capabilities the MCP is missing: reported by AI agents (`autotask_report_gap`), added by people, or captured when a client calls a tool that doesn't exist. |
| **Setup** | Connection and API user, live read-permission probes per module (Ready / Blocked / Not fully checked) with the write access each needs, mirror backfill progress, and copy-ready steps to connect ChatGPT, Claude and n8n. |
| **Bulk jobs** | Prepare, review, approve, start, pause, resume, retry, cancel and archive mass changes, with live progress and per-record lists. Plus *When does the team work?* — activity per hour by person, integration or this MCP, with a drill-down by hour. |
| **Notifications** | Discord, Teams or Slack channels for events such as backpressure, login holds, overdue billing exceptions and bulk-job pauses. |
| **Settings** | Switches applied **without a restart**: read-only mode, serving reads from the mirror, sync thresholds, caller names, the actor registry. |
| **Users / Activity** | Console users and the audit log of everything done in the console. |

## Setup

```bash
docker run --rm --entrypoint cat ghcr.io/gdstechnology/psarelay:latest /app/deploy/admin-setup.sh > admin-setup.sh
bash admin-setup.sh
```

The wizard enables the console, runs migrations, creates the first administrator with a generated password (shown
once) and, if you want, publishes it through a Cloudflare Tunnel step by step.

Full details: [docs/ADMIN.md](https://github.com/GDSTechnology/psarelay/blob/main/docs/ADMIN.md).
