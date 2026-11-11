-- 0024_integration_api — read API keys for other systems (time / CRM modules) served from the Postgres mirror.
--
-- A key (`psk_…`) opens /api/v1 only — never /mcp; MCP tokens (0018) never open /api/v1. Only the SHA-256 of the
-- key is stored; the key is shown once. Each key names the mirrored entities it may read, whether a read the mirror
-- can't answer may go to Autotask live, whether it may be used from outside the private network, and hourly caps.
-- Revoked keys stay listed (who had access, until when).

CREATE TABLE IF NOT EXISTS api_key (
  id                 bigserial   PRIMARY KEY,
  name               text        NOT NULL,
  token_hash         text        NOT NULL UNIQUE,              -- hex sha256 of the full key
  token_prefix       text        NOT NULL,                     -- first characters, to recognise it in lists
  entities           text[]      NOT NULL DEFAULT '{}',        -- mirrored entity names this key may read
  allow_live         boolean     NOT NULL DEFAULT false,       -- a read the mirror can't answer may go to Autotask
  allow_external     boolean     NOT NULL DEFAULT false,       -- usable from outside the private network
  hourly_limit       integer     NOT NULL DEFAULT 3600,        -- requests per hour (all sources)
  live_hourly_limit  integer     NOT NULL DEFAULT 100,         -- of those, Autotask calls per hour
  created_by         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz,
  updated_by         text,
  last_used_at       timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  revoked_by         text
);
CREATE INDEX IF NOT EXISTS api_key_active ON api_key (revoked_at) WHERE revoked_at IS NULL;

-- Requests per key per hour, by how they were answered.
CREATE TABLE IF NOT EXISTS api_key_usage (
  key_id    bigint      NOT NULL REFERENCES api_key (id) ON DELETE CASCADE,
  hour      timestamptz NOT NULL,
  mirror    integer     NOT NULL DEFAULT 0,   -- answered from the mirror (0 Autotask calls)
  live      integer     NOT NULL DEFAULT 0,   -- answered by Autotask
  refused   integer     NOT NULL DEFAULT 0,   -- 4xx / 429 / 503 to the caller
  PRIMARY KEY (key_id, hour)
);
