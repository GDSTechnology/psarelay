---
title: SLA credits
description: PSArelay logs every Autotask outage it sees and drafts a monthly SLA credit request to Kaseya, which an administrator reviews and sends from a Microsoft 365 mailbox.
---

When Autotask is down, your agreement with Kaseya may entitle you to a service credit. Getting it means asking
for it, with evidence. PSArelay calls Autotask all day, so it is in a good position to collect that evidence.

## What is logged

PSArelay logs an outage whenever its [outage breaker](/guides/throttling/) pauses the whole tenant. That
happens when it gets 5 or more network errors or 5xx answers within a minute, spread across 3 or more modules.
Each logged outage records:

- **When it started:** the moment PSArelay detected it.
- **When it ended:** the moment a call got through again. If the server restarted mid-outage, the end is the
  last time the outage was seen, and it is marked as cut short by a restart.
- **What failed:** the modules (Tickets, Companies, …), the HTTP status codes and the last error.

An outage where Autotask answered with HTTP **5xx** is counted as Autotask's side. An outage with **no HTTP
answer** at all (a network error or timeout) could be your server's own connection. It is listed in the claim but
not counted, unless you turn that on.

Overlapping outages are merged, and each one is clipped to the month it falls in. All times in the email are UTC.

## The monthly claim

On the 1st of each month at 06:00 UTC, PSArelay looks at last month's outages. If the counted downtime reaches your
threshold, it drafts a claim. The draft includes:

- the total downtime and the measured uptime percentage;
- the uptime figure from your agreement, if you entered one;
- your account reference;
- one line per outage: when it started and ended, how long it lasted, the status code and the failing modules.

The draft waits on the console's **SLA credits** page (administrators only). The **SLA credit claim ready**
notification tells you it's there. On that page you can:

- edit the subject and text, then **Send to Kaseya**;
- **Dismiss** the draft;
- **Build claim draft** for this month or last month at any time.

A claim that has been sent is kept as sent and is never rebuilt.

Kaseya's credit terms aren't public; they're in your agreement. Check it for:

- where SLA credit requests go;
- the uptime you are promised;
- how long after a month you have to claim.

Then fill in **Claim settings**: To, Cc, the threshold in minutes, the uptime in your agreement, and your account
reference.

## Sending from Microsoft 365

Claims are sent through Microsoft Graph from a mailbox you choose, for example your support mailbox. Each one is
saved in that mailbox's Sent Items.

1. In **Entra admin center → App registrations → New registration**, create an app (single tenant, no redirect
   URI).
2. Under **API permissions**, add **Microsoft Graph → Application permissions → Mail.Send**, then
   **Grant admin consent**.
3. Limit the app to that one mailbox. Use an Exchange Online **application access policy**
   (`New-ApplicationAccessPolicy -AccessRight RestrictAccess -PolicyScopeGroupId <mailbox or group>`) or
   **RBAC for Applications**. Without this, Mail.Send lets the app send as any mailbox in your tenant.
4. Under **Certificates & secrets**, create a client secret.
5. On the console's **SLA credits** page, enter the tenant ID, client ID, client secret and sender mailbox. Then
   press **Send test (to itself)**.

The client secret is stored encrypted with `MCP_SECRET_KEY`. It is never shown again; leave the field empty to keep
it.

The page also shows this month and last month: each outage, whether it is counted, and the running uptime.

Setup needs Postgres and migration `0027`, which `update-psarelay` runs for you.
