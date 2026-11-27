---
title: Parts on tickets
description: A tech adds the parts they used to a ticket by voice or chat, priced from the catalog, and hears up front which ones will land on the order sheet.
---

A tech says *"add 200 feet of plenum cable and 2 keystones to T20261005.0123, from my van"*. The assistant
calls `autotask_add_ticket_materials`. That tool matches each part to one catalog product, prices it from the
catalog and checks the ticket for parts already charged. It writes nothing until the tech confirms.

## Where the parts came from

Pass `fromLocation`. It can be a stock location name (`Van 3`, `Warehouse`), its id, or `my van` (the
location linked to the caller in Autotask). Before anything is written, PSArelay checks that location's
stock for every line. If the name is unknown or matches several locations, nothing is written and the
locations are listed.

## The order sheet

**The API can't pick stock against a charge.** The charge's status is read-only, and so is the stocked
item's link to the charge. Autotask gives a new charge its status itself:

| Autotask sees | Status | Order sheet? |
| --- | --- | --- |
| The product is in stock | Ready to Deliver/Ship | No |
| The product is marked *does not require procurement* | Ready to Deliver/Ship | No |
| No stock | Need to Order/Fulfill | **Yes** |

The dry run flags each line that will land on the order sheet (`onOrderSheet`), and the reply says so:
*"Line 2 will land on the order sheet as Need to Order…"*. The tech hears this before they confirm. After
writing, each charge's real status is read back and said by name. The charge ids stay in the result and
are never read out.

A part the tech already has but Autotask shows as out of stock still goes to the order sheet. Pick it in
Autotask, or correct the stock count first. For consumables that are never ordered per job (cable, jacks,
screws), you can tick **does not require procurement** on the product, and they will never land on the
order sheet.

`status` passed to the charge tools is ignored, and the reply says so. Older callers still work.
