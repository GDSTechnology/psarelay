---
title: Self-hosted or hosted
description: PSArelay is free to self-host under the AGPL. If you'd rather not run it yourself, we host it for you.
---

PSArelay follows the model MSPs know from CIPP: **the software is free and open source to self-host**, and
**hosting is a paid service** for teams who'd rather not run it themselves. Both run the same code.

## Self-hosted — free

- **Everything is included.** All tools, the Postgres mirror, change plans, bulk jobs and the admin console.
- **Your infrastructure, your data.** It runs next to your other services; it talks only to your Autotask tenant
  with your own API user.
- **Open source under the AGPL-3.0.** Use it, change it, run it for your MSP. If you offer a modified version
  to others as a network service, the AGPL asks you to share those changes with its users.
- **Updates** are one command — see [Installation](/getting-started/installation/).
- **Support** through [GitHub issues](https://github.com/GDSTechnology/psarelay/issues).

## Hosted — paid

We run PSArelay for you:

- your own instance, **updated, backed up and monitored**;
- the web portal at **[psarelay.app](https://psarelay.app)** — sign in, watch usage, approve bulk jobs, manage users;
- connect ChatGPT, Claude or n8n with a URL — nothing to install;
- direct support from the team that builds it.

Hosted plans include modules (service desk, contracts, billing, reports, vendor reconciliation, cleanup, commerce, webhooks). Modules that aren't on your plan stay visible in the console's **Plan** page and in your AI client's tool list, marked 🔒 with the plan or add-on that adds them — one click asks for the upgrade.

Plans and sign-up: **[psarelay.com](https://psarelay.com)**.

## Which one?

| | Self-hosted | Hosted |
|---|---|---|
| Cost | Free | Subscription |
| Who runs it | You (Docker, Postgres) | Us |
| Updates | `update-psarelay` when you choose | Automatic |
| Web portal | On your own domain | psarelay.app |
| Support | GitHub issues | Direct |

Either way, your Autotask credentials belong to an API user in **your** tenant, and you can move between the two:
the data that matters lives in Autotask.
