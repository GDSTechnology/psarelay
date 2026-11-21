---
title: Customer notifications
description: E-mail a ticket update to the contact and anyone you tag, from any chat or agent — through an Autotask workflow rule.
---

The Autotask API can't send e-mail, so a note posted through it reaches no one. PSArelay arms an Autotask
**workflow rule** right before it posts the note; the rule e-mails that note to the **Ticket Contact and every
additional contact**. Because it's a PSArelay tool, ChatGPT, Copilot, Claude and agents such as Nexus can all use it.

## Set up once

1. A ticket UDF (List: `Send`, `Sent`).
2. A workflow rule: *Note Added by Anyone*; conditions *Note Publish To = All Autotask Users* and *UDF = Send*;
   update *UDF = Sent*; notify **Ticket Contact** and **Additional Contacts**.
3. `AUTOTASK_NOTIFY_UDF=<the UDF name>` on the server (also `AUTOTASK_NOTIFY_VALUE`, `AUTOTASK_NOTIFY_PUBLISH`,
   `AUTOTASK_NOTIFY_NOTE_TYPE`; defaults `Send`, `1`, `1`).

## Use it

`autotask_notify_ticket` takes the ticket, the message, and people to **tag** — contact ids or e-mail addresses, or
the company's primary contact. Tagged people are added to the ticket so they get the same e-mail; with no contact
on the ticket, the first one becomes it.

- It **previews first**: who gets it, who will be added, and anyone without an address. Send with `dryRun:false`.
- Nothing is written unless every tag resolves to one active contact of the ticket's company.
- An `idempotencyKey` stops a re-run from e-mailing twice.
- `autotask_create_ticket_note` with `notify: true` does the same in one step.

Try: *"Tell the customer on T20261120.0001 the printer is fixed and cc pat@example.com."*
