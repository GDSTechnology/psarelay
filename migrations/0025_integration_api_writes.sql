-- 0025_integration_api_writes — the integration API (0024) can also WRITE, per key.
--
-- A time module has to log time, not only read it. Each key now says which entities it may create / update
-- (`write_entities`, none by default: existing keys stay read-only), whether it may delete them, and how many writes
-- an hour it may make (every write is an Autotask call). PUT is never accepted: it blanks the fields left out.
--
-- Every write is logged in api_key_write — who (key), what (method, Autotask path, entity, record id), the outcome —
-- and an Idempotency-Key header is claimed there BEFORE the write runs, so a retried request never writes twice.

ALTER TABLE api_key ADD COLUMN IF NOT EXISTS write_entities     text[]  NOT NULL DEFAULT '{}';
ALTER TABLE api_key ADD COLUMN IF NOT EXISTS allow_delete       boolean NOT NULL DEFAULT false;
ALTER TABLE api_key ADD COLUMN IF NOT EXISTS write_hourly_limit integer NOT NULL DEFAULT 200;

ALTER TABLE api_key_usage ADD COLUMN IF NOT EXISTS writes integer NOT NULL DEFAULT 0;  -- writes sent to Autotask

CREATE TABLE IF NOT EXISTS api_key_write (
  id               bigserial   PRIMARY KEY,
  key_id           bigint      NOT NULL REFERENCES api_key (id) ON DELETE CASCADE,
  at               timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  method           text        NOT NULL,                 -- POST | PATCH | DELETE
  path             text        NOT NULL,                 -- the Autotask path, e.g. /TimeEntries or /Tickets/123/Notes
  entity           text        NOT NULL,
  record_id        bigint,                               -- the id written (from the body, the path or Autotask's itemId)
  status           text        NOT NULL DEFAULT 'running', -- running | ok | failed | unknown
  http_status      integer,                              -- what the caller got
  idempotency_key  text,
  response         jsonb,                                -- the answer replayed for a repeated Idempotency-Key
  error            text
);
CREATE UNIQUE INDEX IF NOT EXISTS api_key_write_idem ON api_key_write (key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS api_key_write_recent ON api_key_write (at DESC);
