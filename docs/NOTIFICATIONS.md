# E-mailing customers from any chat (ticket notifications)

The Autotask API can't send e-mail: a note posted through the API e-mails **no one**. PSArelay gets around that
the way Autotask intends: a **workflow rule** sends the e-mail, and PSArelay only arms its trigger right before
it posts the note. Because the trigger is armed by a PSArelay tool, **every client can use it** — ChatGPT,
Microsoft 365 Copilot, Claude, Nexus, n8n — and tag the people who should get it.

## What the customer gets

The rule e-mails the note to the ticket's **Ticket Contact** and **every additional contact** on the ticket. In a
live check (30 days, 22 armed tickets) every ticket got exactly one e-mail, to the contact and all 10 additional
contacts on those tickets.

Tagging someone adds them to the ticket as an additional contact first, so the same e-mail reaches them. When
the ticket has no contact, the first tagged person becomes the Ticket Contact.

## Set it up once

1. **UDF:** Autotask → Admin → User-Defined Fields → Tickets: e.g. **Notify-Trigger**, *List (Single Select)*,
   values `Send` and `Sent`. (Nexus tenants already have **Nexus-Notify** — reuse it.)
2. **Workflow rule:** Admin → Workflow Rules → Service Desk → New.
   - **Event:** *Note Added by* → **Anyone** (this includes the API user).
   - **Conditions:** *Note Publish To* = **All Autotask Users**, and *UDF* = **Send**.
   - **Updates:** *UDF* = **Sent**, so it fires once.
   - **Notification:** recipients **Ticket Contact** and **Additional Contacts**; template: a note e-mail
     (e.g. "Ticket Note - Created or Edited"); send from your support address.
3. **PSArelay:** set the environment and restart:

| Variable | Default | |
| --- | --- | --- |
| `AUTOTASK_NOTIFY_UDF` | — (off) | The UDF's name. Unset: the tools answer `not_configured` and write nothing |
| `AUTOTASK_NOTIFY_VALUE` | `Send` | The value that arms it |
| `AUTOTASK_NOTIFY_PUBLISH` | `1` | `TicketNotes.publish` id the rule's condition matches (All Autotask Users) |
| `AUTOTASK_NOTIFY_NOTE_TYPE` | `1` | Note type when the caller gives none |

## The tools

**`autotask_notify_ticket`** — `ticketID`, `message`, optional `title`, `tag` (contact ids as strings, or e-mail
addresses, also `"Name <address>"`), `tagPrimaryContact`, `idempotencyKey`, `dryRun`.

- **Defaults to a dry run**: it answers who will get the e-mail (`recipients`, each with `as`: ticket contact /
  additional contact), what it will add, and a `warning` for anyone without an e-mail address. Show that to the
  user, then call again with `dryRun:false`.
- Order of writes: Ticket Contact (when missing) → additional contacts → arm the UDF → the note. If the note fails
  the UDF is disarmed again, so the rule can't fire on someone else's later note.
- **Refused before any write** (`validation_failed`): a tag that isn't found, is inactive, is on another company,
  or matches several contacts; no contact and nobody tagged; more than 30 additional contacts; a `publish` other
  than the rule's. Company 0 (your own company) works like any other.
- `idempotencyKey` already used on the ticket → `duplicate`, nothing armed or sent.
- After sending, `autotask_search_notification_history` with the ticket id shows who got it.

**`autotask_create_ticket_note`** with `notify: true` (plus `tag` / `tagPrimaryContact`) does the same and sends at
once; it still needs `noteType` and `publish` (the client-visible value the rule matches). Without `notify` it posts
a note as before and e-mails no one.

## Asking from a chat

> "Tell the customer on T20261120.0001 that the printer is fixed, and cc pat@example.com."

The model calls `autotask_notify_ticket` with the message and `tag: ["pat@example.com"]`, shows the recipients,
and sends after you say yes.

## Permissions

The tool is a normal (reversible) write, so technicians can use it where `MCP_PERMISSIONS_ENABLED` is on. Adding
an additional contact can be undone with `autotask_remove_ticket_additional_contact`; a sent e-mail can't.
