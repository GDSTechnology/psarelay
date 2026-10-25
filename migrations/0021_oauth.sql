-- 0021_oauth — sign-in for AI clients (ChatGPT, Claude, Codex connectors): an OAuth 2.1 authorization server in the
-- instance, as the MCP authorization spec asks (protected-resource metadata, dynamic client registration, PKCE S256,
-- resource indicators).
--
-- A person signs in with their console login and approves the client; the access token is a self-service token
-- (mcp_token, owner = that person, runs as their linked Autotask resource, 1 hour). Only hashes of codes and tokens
-- are stored. Refresh tokens rotate on every use; reuse of an old one revokes the whole chain.

CREATE TABLE IF NOT EXISTS oauth_client (
  client_id      text        PRIMARY KEY,
  client_name    text        NOT NULL,
  redirect_uris  jsonb       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_ip     text,
  last_used_at   timestamptz
);

CREATE TABLE IF NOT EXISTS oauth_code (
  code_hash       text        PRIMARY KEY,
  client_id       text        NOT NULL REFERENCES oauth_client (client_id) ON DELETE CASCADE,
  user_id         bigint      NOT NULL REFERENCES admin_user (id) ON DELETE CASCADE,
  redirect_uri    text        NOT NULL,
  code_challenge  text        NOT NULL,
  resource        text        NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);

CREATE TABLE IF NOT EXISTS oauth_refresh (
  token_hash   text        PRIMARY KEY,
  family       text        NOT NULL,                                -- one sign-in; every rotation stays in it
  client_id    text        NOT NULL REFERENCES oauth_client (client_id) ON DELETE CASCADE,
  user_id      bigint      NOT NULL REFERENCES admin_user (id) ON DELETE CASCADE,
  resource     text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_refresh_family ON oauth_refresh (family);

ALTER TABLE mcp_token ADD COLUMN IF NOT EXISTS oauth_client_id text REFERENCES oauth_client (client_id) ON DELETE CASCADE;
ALTER TABLE mcp_token ADD COLUMN IF NOT EXISTS audience text;
ALTER TABLE mcp_token ADD COLUMN IF NOT EXISTS oauth_family text;
