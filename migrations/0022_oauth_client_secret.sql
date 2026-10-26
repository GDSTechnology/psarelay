-- 0022_oauth_client_secret — confidential AI clients (Microsoft 365 Copilot).
--
-- Copilot's MCP connector registers itself (dynamic client registration) but only accepts a registration that issues
-- a client secret. ChatGPT, Claude and Codex register as public clients (token_endpoint_auth_method "none") and keep
-- working unchanged. Only the SHA-256 hash of a secret is stored.
--
-- token_auth_method: 'none' (public, PKCE only), 'client_secret_post' / 'client_secret_basic' (the secret is required
-- at the token endpoint), or 'auto' (the client did not say: a secret is issued and checked when sent, PKCE always).

ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS token_auth_method  text NOT NULL DEFAULT 'none';
ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS client_secret_hash text;
