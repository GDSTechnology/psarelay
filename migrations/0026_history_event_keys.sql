-- 0026_history_event_keys — ticket history events keep every field changed in one save (issue #210).
--
-- The rows of ONE TicketHistory save (several fields changed at once) share a TicketHistory id and a timestamp. The
-- ledger keyed them `th:<id>`, so ON CONFLICT kept only the first: ticket 211214 had 10 rows live and 3 indexed, and
-- a company / queue change made in the same save as another field disappeared from the indexed history.
--
-- New key: `th:<id>:<12 hex>` = md5(historyAction | field | old | new | unparsed detail), built only from columns the
-- ledger stores (historyEventKey in src/utils/audit-events.ts computes the same), so a re-read of a ticket finds its
-- stored rows again and adds only the ones that were dropped.
--
-- 1. Re-key the stored rows.
-- 2. Forget which tickets' history was indexed, so the next read of each ticket goes to Autotask once and fills in
--    the rows that were dropped (one call per ticket, as and when it is read; no sweep).

UPDATE audit_event
   SET event_key = event_key || ':' || left(md5(
         coalesce(details->>'historyAction', '') || '|' || coalesce(field, '') || '|' || coalesce(old_value, '') || '|' ||
         coalesce(new_value, '') || '|' || coalesce(details->>'detail', '')), 12)
 WHERE source = 'ticket_history' AND event_key ~ '^th:[0-9]+$';

DELETE FROM ticket_history_fetch;
