-- 0020_autotask_credential — the Autotask API user, entered and verified in the console.
--
-- One row (id = 1). The secret and integration code are encrypted (AES-256-GCM, key MCP_SECRET_KEY in the env file,
-- never here). When the row exists it is used instead of the AUTOTASK_* environment variables. `database_ci` is the
-- Autotask database the credentials belong to (zoneInformation ci): a different database is refused, so the mirror
-- never mixes two tenants.

CREATE TABLE IF NOT EXISTS autotask_credential (
  id                    int         PRIMARY KEY CHECK (id = 1),
  username              text        NOT NULL,
  secret_enc            text        NOT NULL,
  integration_code_enc  text        NOT NULL,
  api_url               text,
  database_ci           bigint,
  verified_as           text,
  verified_at           timestamptz NOT NULL,
  updated_by            text        NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
