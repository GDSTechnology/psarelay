# Admin console

A small web console for whoever runs the MCP. It shows how the server is doing,
lets administrators switch features on and off **without a restart**, and keeps a
log of every sign-in and change.

| You can… | Administrator | Read-only |
|---|:---:|:---:|
| See the dashboard: version, Autotask API usage, Postgres shadow health, busiest calls, audit ledger | ✓ | ✓ |
| See the Calls log: who is calling, recent tool calls and the Autotask calls each one made | ✓ | ✓ |
| See every setting and its default | ✓ | ✓ |
| Change settings (read-only mode, tool groups, shadow, read cache) | ✓ | |
| Start a shadow sync now | ✓ | |
| Add, disable, delete users; reset passwords; sign users out | ✓ | |
| See the activity log | ✓ | |

Give the **read-only** role to anyone who only needs the metrics.

## How it is put together

- The console runs **inside the MCP container**, on its **own port**
  (`MCP_ADMIN_PORT`, default `8090`). The MCP endpoint (`/mcp`) and the webhook
  receiver stay on `8080`. Publishing the console never publishes those.
- Users, sessions, settings and the activity log are stored in the MCP's
  **Postgres** database (migration `0004_admin.sql`). The console needs the
  Postgres layer (`MCP_PG_ENABLED=true`); see [POSTGRES.md](POSTGRES.md) and
  DEPLOY.md §8.
- **Secrets never reach the browser.** Autotask credentials, database passwords
  and the webhook secret stay in the env file; the console only shows whether each
  one is set.

## Setup

### 0. Get a version with the console onto the server

The console ships inside the MCP image, so the server has to be running a
release that includes it before anything else:

1. The change is merged to `main`. The release workflow then publishes a new
   image. Wait for the **last** release run to finish.
2. Deploy it with the routine command in DEPLOY.md §4. It pulls the image, runs
   the database migrations and restarts the MCP.
3. Check that `/health` reports the new `version`.

The console stays **off** after this step. Nothing changes for agents until you
run the wizard.

### 1. Run the wizard

Over SSH on the Docker host, from the compose project directory. Take the
wizard out of the image you just deployed, so it always matches your version:

```bash
docker run --rm --entrypoint cat ghcr.io/gdstechnology/psarelay:latest /app/deploy/admin-setup.sh > admin-setup.sh
```

Read the script first, then run it:

```bash
bash admin-setup.sh
```

It walks through six steps and changes nothing until you confirm:

1. **Find the MCP**: the compose directory and service (default `psarelay`; installs from before the rename keep `autotask-mcp`).
   Stops if the running image is too old to have the console.
2. **Check Postgres**: stops with instructions if the Postgres layer is off.
3. **Turn the console on**: adds `MCP_ADMIN_ENABLED=true` and `MCP_ADMIN_PORT`
   to the service's env file. A backup copy of the file is saved first.
4. **Migrate and restart**: runs the migrations and recreates the service, then
   waits until the console answers.
5. **First administrator**: creates `admin` (or a name you choose) with a
   **generated password, printed once** in your SSH session. You must choose your
   own password at first sign-in.
6. **Cloudflare Tunnel** (optional): a guided walkthrough. It shows each
   Cloudflare dashboard step, waits for you, and then checks the result from the
   server. The same steps, in more detail, follow below.

Re-running is safe, so you can stop at any point and come back later:
- settings already in place are kept;
- migrations apply only what is new;
- step 5 never overwrites an existing user;
- a saved tunnel token can be kept.

`--help` lists every option.

## Cloudflare Tunnel, step by step

A tunnel lets people open the console at an address like
`https://mcp-admin.your-company.com`. No port is opened on the server's
firewall: the server makes an outbound connection to Cloudflare.

Cloudflare renames dashboard menus from time to time. Where a newer name is
known, it is given in brackets.

### What you need first

- **A Cloudflare account.** The free plan is fine:
  <https://dash.cloudflare.com/sign-up>.
- **A domain whose DNS is hosted on Cloudflare.**
  - In the dashboard, open the domain → **Overview**. The status must say
    **Active**.
  - If the domain isn't on Cloudflare yet: **Add a domain**, then change the
    nameservers at your registrar to the two that Cloudflare shows. This can take
    up to a day to switch over.
  - A subdomain such as `mcp-admin` is created for you later, so you don't add a
    DNS record yourself.
- **Zero Trust switched on.** You only do this once per account.
  1. Open **Zero Trust** from the dashboard's left menu.
  2. Choose a team name, e.g. `your-company`.
  3. Choose the **Free** plan. Cloudflare may ask for a payment card even on the
     Free plan; it is not charged.

### Step 1: Create the tunnel

1. **Zero Trust → Networks → Tunnels** [Networking → Tunnels] → **Create a
   tunnel**.
2. Connector type: **Cloudflared** → **Next**.
3. Name: `psarelay-admin` → **Save tunnel**.
4. The next page shows install commands. Pick the **Docker** tab. The command
   looks like this:

   ```text
   docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJhIjoi...
   ```

5. Copy **only the long value after `--token`**. Treat it like a password: anyone
   who has it can attach to your tunnel.
6. **Don't run that command.** The wizard runs `cloudflared` for you, on the
   MCP's Docker network. If you started it by hand, it couldn't reach the MCP
   container.

### Step 2: Give the token to the wizard

In the wizard, at step 6, choose **1) Set up a NEW Cloudflare Tunnel** and paste
the token when asked. The input is hidden. The wizard:

- saves the token to `psarelay-admin-tunnel/.env`, readable only by its
  owner;
- writes `psarelay-admin-tunnel/docker-compose.yml` and starts
  `cloudflared`;
- waits for **"Registered tunnel connection"**.

Back in the dashboard, refresh **Tunnels**. The tunnel should show **HEALTHY**.

### Step 3: Point a hostname at the console

1. Click the tunnel → **Edit** → **Public hostname** tab → **Add a public
   hostname** [the tunnel's **Routes** → **Add route** → **Published
   application**].
2. Fill in:

   | Field | Value |
   |---|---|
   | Subdomain | `mcp-admin` (any name) |
   | Domain | your domain, picked from the list |
   | Path | leave empty |
   | Service type | **HTTP** (not HTTPS: the tunnel already encrypts the traffic) |
   | URL | `psarelay:8090` (the MCP service name, then the console port) |

3. **Save**. Cloudflare creates the DNS record.

The wizard then asks for the hostname and tests it from the server. Open
`https://mcp-admin.your-domain.com` in a browser: you should see the console's
sign-in page.

### Step 4 (strongly recommended): Cloudflare Access

Access adds a second lock: people must prove their e-mail address to Cloudflare
before they even see the console's sign-in page.

1. **Zero Trust → Access → Applications** [Access controls → Applications] →
   **Add an application** → **Self-hosted**.
2. Application name: `PSArelay`. Session duration: `24 hours`.
3. **Add public hostname**: the same subdomain and domain as in Step 3.
4. **Next**, then **Add a policy**:

   | Field | Value |
   |---|---|
   | Policy name | `Team` |
   | Action | **Allow** |
   | Include | **Emails ending in** → `@your-company.com`, or **Emails** → the exact addresses |

5. **Next**, keep the defaults, then **Add application**.
6. Choose how people sign in to Access: **Zero Trust → Settings →
   Authentication**.
   - **One-time PIN** works with no setup: Cloudflare e-mails a code.
   - Microsoft Entra ID or Google can be added here later.

Test in a private browser window. You should get Cloudflare's "enter your
e-mail" page first, then the console's sign-in page. The wizard's check reports
"protected by Cloudflare Access" when this works.

### If it doesn't work

| What you see | Cause | Fix |
|---|---|---|
| Error **1033** / HTTP **530** | The tunnel isn't connected | `docker compose -f psarelay-admin-tunnel/docker-compose.yml logs --tail 30`. "Unauthorized" means a bad token: re-run the wizard and paste it again |
| HTTP **502** / "Bad gateway" | Cloudflare can't reach the console | The route's URL must be `psarelay:8090` with type **HTTP**. Check that the console is on: `/health` shows `"admin": {"running": true}` |
| The address doesn't resolve | No DNS record | The domain must be **Active** on Cloudflare DNS. Re-save the hostname route |
| The Access page loops or says "not authorized" | The Access policy doesn't match | Check the e-mail domain or list in the policy |
| The console says "admin tables are missing" | Migrations not run | `docker compose run --rm --no-deps -T psarelay node dist/db/migrate.js` |

### Other choices in the wizard

- **2) I already run cloudflared**:
  - the wizard prints the `docker network connect` command that lets your
    existing `cloudflared` reach the MCP container;
  - then you follow Steps 3–4.
- **3) Skip**: the console stays private. The wizard prints how to reach it
  through an SSH port-forward instead.

## Updates

**Updating the MCP keeps your console.** The routine deploy (DEPLOY.md §4)
replaces only the MCP container. The console's web pages are part of the image,
so they update along with it.

| What | Where it lives | Changed by an update? |
|---|---|---|
| Console on/off and port | the env file (`psarelay.env`) | No |
| Users, settings, activity log | the MCP's Postgres volume | No (migrations only add tables) |
| Cloudflare Tunnel and its token | `psarelay-admin-tunnel/`, its own compose project | No |

After a deploy, `/health` should include `"admin": {"enabled": true, "running": true, "schemaReady": true}`.

To update `cloudflared` itself, now and then:

```bash
docker compose -f psarelay-admin-tunnel/docker-compose.yml pull && docker compose -f psarelay-admin-tunnel/docker-compose.yml up -d
```

**Never** run `docker compose down -v` in the MCP's compose directory. The `-v`
deletes the volumes, and with them the console's users and the shadow.

## Day-to-day

**After a deploy, an open console tab shows a banner:** *"Version X was
deployed — Reload"*. The page's script URLs carry the release version, so a
reload always gets the new code. Neither the browser nor Cloudflare can keep
serving the old copy.

Sign in and change the temporary password. Then open **Users → Add a user**: each
new user gets a generated password shown once, and they choose their own at
first sign-in.

### Settings

| Setting | What it does | Default from |
|---|---|---|
| Allow write tools | Off = **read-only MCP**: every tool that creates, updates or deletes is hidden from agents and refused if called | always on |
| Disabled tool groups | Hide whole groups (e.g. `financial`, `webhooks`) from agents | none |
| Scheduled sync | Pause the shadow's background sync | on |
| Serve searches from the shadow | Answer searches from Postgres while it is fresh | `MCP_PG_SHADOW_SERVE_READS` |
| Max mirror age (seconds) | How stale the shadow may be and still answer | `MCP_PG_SHADOW_MAX_AGE_SECONDS` |
| Pause sync at API usage % | Skip sync runs while tenant usage is high (default 85; keep it high — a stale mirror sends reads live) | `MCP_PG_SHADOW_PAUSE_AT_PCT` |
| Read cache | The short-lived Autotask read cache | `AUTOTASK_CACHE` |
| Caller names | Names for clients that don't declare a `source`, one `pattern=name` rule per line. The pattern matches the IP address exactly, or appears in the user agent. Example: `172.19.0.3=n8n`, `Python-urllib=cron`, `Go-http-client=ChatGPT`. Applies to calls logged from then on. | `MCP_CALLER_LABELS` (comma-separated) |

Changes apply at once and are kept in Postgres, so they survive restarts.
**Reset to default** returns a setting to the env file's value. A server without
the console behaves exactly as its env file says.

How tool switches reach agents:

- Agents that connect after a change see the new tool list.
- Agents that are already connected get a clear error, "disabled by an
  administrator", if they call a switched-off tool.
- Discovery tools (`list_categories`, `execute_tool`, `router`, `whoami`,
  `test_connection`) are never switched off.

### Actors (who is a person, who is automation)

The **Actors** page classifies every Autotask resource, because a resource is
not always a person. Ticket history and anything that learns from technicians
(such as Hermes) use this classification.

| Type | Meaning | How it is decided |
|---|---|---|
| **Person** | A technician or staff member | A licensed user with no signs of automation, or set in the registry |
| **Integration** | An integration account (RMM, security tools, sync apps) | License type **API User** |
| **Service account** | This MCP's own API user: the changes n8n, Nexus and ChatGPT make through it | Matches the MCP's credentials |
| **System** | Autotask's built-in system account (resource 4) | Fixed |
| **Unknown** | Can't tell yet | No resource record, or a name or email that looks like automation. **Never treated as a person** until you confirm it |

The **Why** column shows which rule applied.

Administrators can make two kinds of change on the page. Both are stored as
settings, so no names are kept in code:

- **Set type:** override the automatic type, for example to confirm an
  *Unknown* account. This is the *Actor registry* setting.
- **★ Reference:** mark the technicians whose ticket work is the trusted
  standard to learn from. This is the *Reference technicians* setting.

Automated changes, including this MCP's own n8n and Nexus writes, are never
ground truth. The same classification (`actorType`, `classificationSource`,
`reference`) appears on every event from
`autotask_get_ticket_change_history`, and in `autotask_get_actor_roster`.

### Setup

Is this server connected to Autotask, and is its API user allowed to do what each module needs? **Run check** (admins; about 30 Autotask calls) signs in, names the API user, and probes **read** access live for every entity the modules use — straight to Autotask, never the mirror. Each module (Service desk & time, Contracts & financial, Billing & reports, Vendor billing reconciliation, Merges & bulk cleanup, Commerce) shows **Ready**, **Blocked** (no read access to …) or **Not fully checked**, with the **write** access it needs from the API user's security level (writes can't be probed without writing). Below: mirror backfill progress, and **Connect your AI** — the MCP endpoint (`MCP_PUBLIC_URL`) with copy-ready steps for ChatGPT, Claude and n8n. The same check is the tool `autotask_setup_check`.

### Access (tokens for the MCP endpoint)

Admins only. **Zero trust: a call is only as trusted as the token it carries.** Create one token per client (n8n, a
script, a connector) so each can be revoked on its own. The token is shown **once**; only its SHA-256 is stored. The
client sends it on every call as `Authorization: Bearer psr_…`. A token decides who the call runs as:

| Kind | Runs as | Use for |
|---|---|---|
| **Service** | the API user; anything the client claims about a person is dropped | n8n workflows, scripts, cron |
| **One person** | that Autotask resource — writes are recorded as them (impersonation), whatever the client claims | a technician's own client |
| **Delegate** | the person the client names (vouched for by this token) | a bot acting for many people, e.g. n8n for Teams |

A presented token must be valid even while tokens are optional: an unknown, revoked or expired one gets **HTTP 401**,
so a revoked client never silently keeps working. When every client has its token, turn on **Settings → Security →
Require an access token on /mcp**; from then on a call without one gets 401. ChatGPT and Claude connectors can't send
a token yet (they will sign in with OAuth) — keep the requirement off while they connect directly, and protect the
endpoint at the tunnel (Cloudflare Access) meanwhile.

**Who a call runs as, without a token.** The email a client declares (`requestingUserEmail`) is recorded but never
used to write as that person: any client could claim to be anyone, so caller-mode impersonation only follows a token.
**Settings → Security → Trust identities a client declares without a token** restores the old behaviour — don't.

The **Security** panel on the Setup page lists what this server exposes and who it trusts — open endpoint, trusted
declared identities, role gating, raw requests, CORS, the public health check, the webhook receiver — worst first,
each with the fix.

### Plan

Which modules this account has. **Self-hosted** (no licence set): every module is unlocked, and the page says so. **Hosted**: the instance carries a licence signed by the PSArelay control plane (`PSARELAY_LICENSE`, verified with `PSARELAY_LICENSE_PUBLIC_KEY` — it can't be edited locally). Included modules show a ✓; the others stay visible as upgrade cards — what the module does, which plans include it or which add-on adds it — with **Request upgrade**, which sends the `platform.upgrade_requested` notification (set a channel for it under Notifications). A tool from a locked module is refused with the same wording ("🔒 Merges & bulk cleanup is not on this account (your plan: Starter) — it is included in the Pro / MSP plans …"), so an AI client can explain it; locked tools stay in the tool list, marked 🔒, unless **Settings → Show locked tools** is off. An expired licence keeps working for 7 days, then only the core module (service desk & time) is available; an invalid one gives core only and the page shows why. Setup, the plan and the console's own tools are never locked.

### Bulk jobs (mass changes, paced)

Mass changes are prepared from the mirror, **approved by a person here**, and pushed to Autotask by the server at a set pace. Today that means inactivating placeholder companies ("Gmail", "Outlook", "Unknown…") and their contacts, or the junk contacts on one real company. A chat assistant can prepare a job and watch it (`autotask_bulk_inactivate`), but some assistants refuse to approve tens of thousands of writes, and a person should decide that anyway.

- **New placeholder cleanup** (admins). Fields:
  - the placeholder name;
  - optionally, the resource that created the records and a creation date range;
  - whether to include their contacts;
  - **email addresses to keep** (real people; their placeholder companies are left alone), and **addresses to treat as junk** (confirmed spam senders, whose tickets would otherwise keep their companies);
  - the off-hours rate (default 3,000 writes/hour);
  - the business-hours rate and window (default 1,000/hour, Mon–Fri 07:00–19:00 America/New_York);
  - **quiet hours**, local hours with no writes at all (default `0-4, 21-22`: another integration's burst window; empty for none);
  - the canary size (default 50).

  **Prepare** writes nothing. It reads the records and checks each for history in the background; companies with history are excluded.
- **Junk contacts on one company** (admins): a company ID, then either a list of contact IDs or the domain rule (every active contact not on the company's own domains). Optional: extra own domains, only some domains, a creation date range, contacts with no email, contacts on tickets. Rates and business hours come from the form above; the canary defaults to 25. The primary contact and contacts with projects, contracts, opportunities, quotes, CIs or to-dos are always excluded. The job card shows **Kept as the company's own** (each domain and why) and **By email domain** (inactivate / kept / excluded / already inactive) to review before approving. Details: [MERGE.md](MERGE.md).
- **Each job shows:**
  - status and progress (done / left / failed / excluded);
  - the pace right now (business or off hours), how many writes happened in the last hour, and the time left;
  - per-entity counts, who prepared, approved and started it, and the pause reason;
  - **Recently done / Failed / Excluded / Next up** lists, each record with its Autotask link.
- **Buttons** (admins; each asks for confirmation):
  - **Approve:** a ready job, bound to its hash, so it covers exactly the records shown.
  - **Start:** runs the canary first, then pauses for you to check the records.
  - **Pause / Resume**, **Retry failed**, **Cancel:** records already written stay as they are.
  - **Archive** (a done, cancelled or failed job): hides it from the list; **Show archived** brings it back, with **Restore**. The job and its records are kept; nothing in Autotask changes.
- **When does the team work?** Time entries and ticket notes per local hour on an average weekday, over the last 28 days, from the mirror (no Autotask calls), **stacked by resource** (one colour each). Tabs: **People** (licensed users), **Via this MCP** (written through this MCP by n8n, Nexus or ChatGPT, from its operation log, even when Autotask credits a person), **Integrations** (API users such as RMM or integration platforms, and unconfirmed resources), **Everything**. Who is who comes from the Actors classification (Resources mirror + the Actors settings). Only **people** set the suggested business hours: people active per hour (one person catching up 20 entries in an hour counts once), the longest run of hours at 35% of the peak or more, outlined on the chart. **Click an hour** to drill down: entries vs notes, day of week, who (with their type), and the latest records by **Ticket Number, Ticket Title and Company Name**.
- **Stopping it:** the worker stops for the read-only switch (Settings → writes off). It halves its pace from 40% tenant API usage and waits from 65%, so the rest of the tenant keeps room. It also stops during a 429 cooldown, on a login problem, or after 20 failures in a row. It continues after a restart.
- Notifications: `bulk.paused` and `bulk.done` (subscribe a channel under Notifications).

### Requests (what the MCP can't do yet)

A list of capabilities to build, so a missing tool is captured instead of worked around:

- **From AI agents:** `autotask_report_gap`. The server instructions tell every client (ChatGPT included) to call it when no tool fits, and it works even in read-only mode.
- **From people:** the **Add a request** form on this page.
- **Captured automatically:** a client called a tool that doesn't exist.
- **Seen by the server, not reported yet:** raw_request shapes from the last 7 days that no tool covers. **Add as request** turns one into a request.

The same request again (same title, ignoring case and punctuation) counts another occurrence instead of adding a row. Admins set the status (open → planned → built, or declined / duplicate) and priority. A resolution note says which tool or release covers it. A request marked built or declined that is reported again reopens. Stored in Postgres (migration 0014).

### Notifications (Discord, Teams, Slack, any webhook)

The **Notifications** page posts an alert to a chat channel when something
trips. Each channel picks its own events:

| Event | Severity |
|---|---|
| Autotask login **held** (needs *Retry now*) | critical |
| Autotask login paused after a failed login; working again | warning / info |
| Backpressure **stop** (usage ≥ 90%, a 429, the login); back to ok | warning / info |
| Autotask 429 (threshold exceeded) | warning |
| Mirror sync error on an entity; mirror consistency check needs attention | warning |
| A write **failed after writing** (half-applied: n8n / Hermes change) | critical |
| A burst of tool errors (5+ in 5 minutes) | warning |

**How often you hear about it**
- The server checks every 20 seconds.
- A condition that continues is reported **once**, and its recovery once.
- The same event goes to a channel at most once every 15 minutes.
- Delivery never slows down or fails the MCP itself. A failed send shows under
  the channel ("last failure …").

**Add a Discord channel**
1. In Discord, open the server → **Server Settings → Integrations → Webhooks →
   New Webhook**.
2. Pick the channel, name it (e.g. *PSArelay*), then **Copy Webhook URL**.
3. In the console, go to **Notifications → Add a channel**:
   - **Type:** Discord;
   - **Webhook URL:** paste it;
   - tick the events, then **Add channel**.
4. Press **Send test**. A test message should appear in the channel.

**Add a Microsoft Teams channel** (Teams Workflows; the old "Incoming Webhook"
connectors are being retired)
1. In the Teams channel, open **••• → Workflows**.
2. Choose **"Post to a channel when a webhook request is received"**.
3. Name the workflow, confirm the team and channel, then **Add workflow**.
4. Copy the URL it shows. It contains `logic.azure.com` or `powerplatform.com`.
5. In the console, add a channel with **Type:** Microsoft Teams and paste the
   URL. Then press **Send test**.
   - The message arrives as an Adaptive Card, posted by the Workflows app.

**Slack:** create an app at api.slack.com/apps, turn on **Incoming Webhooks**,
then **Add New Webhook to Workspace**. The URL looks like
`https://hooks.slack.com/services/…`.

**Other (JSON webhook):** use this for anything that takes an https POST, such
as an n8n Webhook node, PagerDuty or Opsgenie.
- The body is `{ event, severity, title, detail, fields, at, server }`.
- With a **signing secret** (16+ characters), each request carries
  `X-PSArelay-Signature: sha256=<HMAC-SHA256 of the body>` (the same value is also sent as the deprecated `X-Atmcp-Signature` until the next major release), so the receiver can
  verify it.

**Security**
- The webhook URL is stored on the server (Postgres). It is never shown again
  in full, not in the export, and not in the activity log.
- To replace a URL, use **Change URL**.
- Only https and public hosts are accepted. Each type checks its service's
  host (`discord.com`, `hooks.slack.com`, the Teams Workflows hosts).
- Read-only users can see the channels, but can't add, change or test them.
- The server name in each message comes from `MCP_NOTIFY_SERVER_NAME`
  (default *PSArelay*). Set it to tell prod from dev.

### Mirror check

The Dashboard's **Mirror check** panel shows whether the Postgres shadow matches Autotask. Every night, random rows of every mirrored entity are re-read from Autotask and compared field by field, and the row counts are compared too. The panel shows *Matches Autotask* or *Needs attention*, with the entities, counts and example ids involved. Rows that were simply edited since the last sync are not counted as problems. Real differences are fixed from Autotask automatically. Administrators can press **Check now**; a run costs about 2 Autotask calls per entity.

### Calls (diagnostics)

The **Calls** page shows whether the MCP is working and who is using it.
It refreshes every 10 seconds.

**Who is calling (last hour).** One row per caller, with how many tool calls it
made, how many failed, and how many Autotask calls they cost. A caller is the
`source` the client declares (`n8n`, `chatgpt`, `cron`), plus the IP address
and client name the request actually came from.
Background work, such as the shadow sync and the console's own usage check, is
listed separately.

**Tool calls.** Each tool call with its result and how long it took. Click a row
to see every Autotask request that call made, with each request's status code
and duration. Each row also shows how many requests were answered from the read
cache or the Postgres shadow instead of going to Autotask.

The **Dashboard** shows the two numbers below for the last 24 hours, for this
MCP's own traffic only:
- **Reads Autotask answered live**, with the busiest entities;
- **Tool gaps**: `raw_request` calls no tool covers.

Their buttons open the matching tab here.

**Reads by entity (what to cache next).** For each Autotask entity (Invoices,
Tickets, BillingItems…), where its reads were answered over the last 1, 6 or 24
hours, or 7 days:

- **Autotask reads:** sent to Autotask.
- **From cache:** answered by the short-lived read cache.
- **From shadow:** answered by the Postgres mirror.

Each row also shows how the entity is kept locally today: whether it is mirrored
and serving reads, and the read cache's time-to-live for it. It names the tools
or jobs that caused its Autotask reads.

An entity is marked **Candidate to mirror** when it meets all three:
- 50 or more Autotask reads per 24 hours;
- under 50% answered locally;
- not mirrored yet.

Those are the ones worth adding to the shadow next. The table can also be
downloaded as a CSV and is part of the diagnostics bundle.

**Tool gaps (what to build next).** Shows where work goes around the MCP's tools.

- **raw_request use.** `autotask_raw_request` is the escape hatch for sending
  any request straight to Autotask. Each kind of request is listed (for example
  `POST /Tickets/query`, `PATCH /TicketNotes`) with how often it was used, how
  often it failed, and who used it. Each row is marked one of two ways:
  - **Covered by** an existing tool (matched by name): switch that caller to the
    tool so it gets the cache, the shadow and the safety checks.
  - **No tool covers this**: a tool to build.
- **Fallbacks.** A tool failed, and the same caller used `raw_request` within
  10 minutes. That points to the tool missing something; the tool's error is
  shown.
- **Other integrations** (a footnote, not part of this MCP). Autotask's usage
  counter covers the whole database, so the tenant total minus this MCP's own
  calls estimates the calls made by other integrations with their own API
  users (Pax8, Datto RMM, IT Glue…). The MCP can't see those calls, so it can't
  say whose they are; Autotask's API usage report lists calls per integration.

Reads by entity and Tool gaps are kept for **7 days, across restarts and
deploys** (hourly counts in Postgres, migration 0013; in memory only without
Postgres). Both are also available as a CSV and in the diagnostics bundle.

**Autotask API calls.** Every request sent to Autotask, with its status code and
the tool call or job that caused it.

What the log reads like:

- **401 errors** usually mean the API credentials are wrong. Each 401 shows up
  as two requests, because the MCP retries once after looking up the tenant's
  Autotask address again.
- **429 errors** mean Autotask is throttling the tenant.
- **"No answer"** is a network error or a timeout.

What the log keeps:

- It is held in memory: the last 500 tool calls and 2,000 Autotask calls since
  the server started. A restart clears it.
- Tool arguments and response bodies are **never** recorded. It keeps the tool
  name, caller, result, timings, and a shortened error message.

### Autotask login protection

Autotask **locks an API user** after repeated failed logins. Every client of this
MCP (n8n, cron, ChatGPT) shares that one user, so a lock stops all of them.

When Autotask rejects a request with HTTP 401, the MCP does the following:

1. **It stops everything else at once.** While the MCP checks this one 401,
   every other Autotask request is held back. Requests that were already in
   flight and also come back 401 don't trigger checks of their own.
2. **It looks up the Autotask address again.** This lookup needs no login. If
   the tenant moved to another data centre, the request is retried once at the
   new address; otherwise it is **not** retried.
3. **It checks it's really the login.** The MCP makes one request that every API
   user is allowed to make (Autotask's usage counter). If that works, the 401
   was about one entity only, and nothing is paused.
4. **It pauses.** Every call for that API user fails at once inside the MCP and
   never reaches Autotask.
5. **It tests again, twice at most.** After 5 minutes, then 10, the MCP sends
   **one** test call, and every other call waits for its answer.
   - If a test works, normal service resumes.
   - If both fail, Autotask calls are **HELD**. The MCP sends **no more logins
     on its own**, however long it takes, until an administrator presses
     **Retry now**.

   A lockout costs at most about 4 failed logins, plus any requests that were
   already in flight at the first 401.
6. **It survives restarts.** The pause is saved in Postgres (migration
   `0006`), so a restart or deploy during a lockout doesn't start sending
   logins again. A saved pause is tied to the credentials: **changing the
   secret in the env file clears it automatically.**
7. **It shows up in the console.**
   - The Dashboard shows a red banner: *paused until …*, or *HELD*. It includes
     the error and a **Retry now** button (administrators).
   - `/health` gains an `autotaskAuth` block.

**After a lock:**

1. Unlock the API user in Autotask. If the secret changed, update the env file
   and recreate the MCP; the pause then clears by itself.
2. Press **Retry now**.
3. Watch the **Calls** page: new Autotask calls should show **200**.

**Settings:**
- `AUTOTASK_AUTH_PAUSE_SECONDS` (default `300`) sets the first pause. `0`
  turns the protection off; that is not recommended.
- `AUTOTASK_AUTH_MAX_PROBES` (default `2`) sets how many test calls are made
  before holding.

### Export (testing and issue tracking)

The **Calls** page has download links:

| Download | Contents |
|---|---|
| **Diagnostics bundle (JSON)** | One file for a support ticket or a bug report: <br>- dashboard status and settings <br>- callers for the last 24 hours <br>- every logged tool call and Autotask call <br>- the server log <br>- for administrators, the console activity log |
| **Tool calls / Autotask calls / Server log (CSV)** | For a spreadsheet |

**Server log tab:** the warnings and errors the server logged since it started
(the last 500). This is the same text `docker compose logs` shows, without
SSH. Fields whose names look like credentials are replaced with
`[redacted]`.

**What exports never contain:** credentials, tool arguments, or response
bodies. Every export is recorded in the activity log.

### Locked out?

On the host:

```bash
docker compose exec psarelay node dist/admin/cli.js reset-password admin
```

This prints a new temporary password and signs that user out everywhere. Other
commands:

| Command | What it does |
|---|---|
| `init [username]` | Create the first administrator |
| `create-user <username> [admin\|viewer]` | Add a user |
| `enable <username>` | Re-enable a disabled user |
| `list-users` | List the users |

## Security

**Passwords**
- Stored as scrypt hashes.
- Generated passwords are about 117 bits and never logged.
- Chosen passwords need at least 12 characters and may not contain the username.

**Sessions**
- The session is a random token in an `HttpOnly`, `SameSite=Strict` cookie, which
  is `Secure` and `__Host-` behind HTTPS.
- Only a SHA-256 of the token is stored.
- Sessions expire after 12 h idle or 7 days.
- Changing a password signs out the user's other sessions. Disabling a user signs
  them out everywhere.

**The MCP endpoint**
- **Access tokens** (Access page): random 256-bit, shown once, stored as SHA-256, revocable, optional expiry; a bad
  token is always refused. Required on every call once **Require an access token** is on.
- **Identity comes from the token, not the client** — see Access above.
- **CORS** only for the web origins in `MCP_CORS_ORIGINS` (default: claude.ai, chatgpt.com, chat.openai.com), never `*`.
- **`/health` from outside** (through a tunnel or proxy) answers only status and version; usage, backpressure and
  login state are for the host's own services (n8n on the compose network).

**Requests**
- **Cross-site requests are refused.** Every change needs the `X-PSArelay` header,
  which a foreign page can't send, and a same-host `Origin`.
- **Sign-ins are throttled:** 6 failures per username, or 20 per IP, in 15 minutes.
- **Strict Content-Security-Policy:** no inline script, nothing loaded from other
  sites, and the page can't be framed.

**Admin accounts**
- The last active administrator can't be demoted, disabled or deleted.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `MCP_ADMIN_ENABLED` | `false` | Start the console (HTTP transport + Postgres layer required) |
| `MCP_ADMIN_PORT` | `8090` | Console port inside the container |
| `MCP_ADMIN_HOST` | `0.0.0.0` | Bind address |
| `MCP_ADMIN_COOKIE_SECURE` | `auto` | `auto` = Secure cookie when the proxy says HTTPS (`X-Forwarded-Proto`); `true` / `false` to force |
| `AUTOTASK_AUTH_PAUSE_SECONDS` | `300` | First pause after Autotask rejects the API credentials (doubles per repeat, max 60 min); `0` disables. See "Autotask login protection" |
| `MCP_ADMIN_TRUST_PROXY` | `true` | Use `CF-Connecting-IP` / `X-Forwarded-For` for the client IP (throttling, activity log). Set `false` if the port is reachable without a proxy |
| `MCP_NOTIFY_SERVER_NAME` | `PSArelay` | Server name shown in notifications (tell prod from dev) |
| `PSARELAY_LICENSE` | — | Hosted only: the signed licence from the control plane. Unset = self-hosted, everything unlocked |
| `MCP_REQUIRE_TOKEN` | `false` | Start value of **Settings → Security → Require an access token on /mcp** (the console setting wins once saved) |
| `MCP_TRUST_UNVERIFIED_IDENTITY` | `false` | Start value of **Trust identities a client declares without a token** — keep off |
| `MCP_CORS_ORIGINS` | claude.ai, chatgpt.com, chat.openai.com | Web origins that may call `/mcp` from a browser (comma-separated); `none` = no browser access. Never `*` |
| `PSARELAY_LICENSE_PUBLIC_KEY` | — | Hosted only: the control plane's Ed25519 public key (PEM; `\n` escapes allowed) |
