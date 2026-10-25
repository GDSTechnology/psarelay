-- 0018_mcp_tokens — access tokens for the /mcp endpoint (zero trust).
--
-- A client (n8n, a script, an AI connector) sends `Authorization: Bearer psr_…`. Only the SHA-256 of the token
-- is stored; the token itself is shown once, when it is created. A token can carry WHO it is for:
--   resource_id set  → calls run as that Autotask resource (client-declared identities are ignored);
--   delegate = true  → a service (e.g. n8n for Teams) that may name the person it acts for;
--   neither          → a service account: calls run as the API user, client-declared identities are dropped.
-- Revoked tokens stay listed (who had access, until when).

CREATE TABLE IF NOT EXISTS mcp_token (
  id            bigserial   PRIMARY KEY,
  name          text        NOT NULL,
  token_hash    text        NOT NULL UNIQUE,              -- hex sha256 of the full token
  token_prefix  text        NOT NULL,                     -- first characters, to recognise it in lists
  resource_id   bigint,                                   -- acts as this Autotask resource
  delegate      boolean     NOT NULL DEFAULT false,       -- may name the person it acts for
  created_by    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    text
);
CREATE INDEX IF NOT EXISTS mcp_token_active ON mcp_token (revoked_at) WHERE revoked_at IS NULL;
