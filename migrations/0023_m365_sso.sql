-- 0023_m365_sso — Microsoft 365 Copilot single sign-on (Entra SSO): staff use PSArelay from Copilot with no separate
-- login. Copilot sends the person's Microsoft Entra access token; PSArelay verifies it against Microsoft's published
-- signing keys (no secret is stored anywhere) and runs the call as the Autotask resource linked to that person.
--
-- m365_tenant   the Microsoft 365 tenants whose tokens this instance accepts (a list: hosted customers are added
--               later) and the audiences (Application ID URIs) / scope their Copilot agent uses.
-- m365_link     Microsoft 365 person → Autotask resource. Made automatically when exactly one active resource matches
--               the person's sign-in name, or by an administrator (also before the person ever signs in: by UPN).
-- m365_waiting  people who tried and could not be linked — the administrator links them from the console.

CREATE TABLE IF NOT EXISTS m365_tenant (
  tenant_id   text        PRIMARY KEY,                 -- Entra tenant id (GUID, lower case)
  label       text        NOT NULL DEFAULT '',
  client_id   text        NOT NULL DEFAULT '',         -- the Entra app that secures this MCP (shown in setup steps)
  audiences   jsonb       NOT NULL DEFAULT '[]',       -- accepted token audiences: Application ID URI(s), client id
  scope       text        NOT NULL DEFAULT '',         -- required delegated scope (scp), empty = any
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS m365_link (
  id             bigserial   PRIMARY KEY,
  tenant_id      text        NOT NULL,
  oid            text,                                 -- Entra object id; null for a preload made by UPN
  upn            text        NOT NULL,
  resource_id    bigint      NOT NULL,
  resource_name  text        NOT NULL DEFAULT '',
  matched_by     text        NOT NULL,                 -- auto:email | auto:username | admin
  linked_by      text,
  linked_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS m365_link_oid ON m365_link (tenant_id, oid) WHERE oid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS m365_link_upn ON m365_link (tenant_id, lower(upn));

CREATE TABLE IF NOT EXISTS m365_waiting (
  tenant_id   text        NOT NULL,
  oid         text        NOT NULL,
  upn         text        NOT NULL,
  name        text        NOT NULL DEFAULT '',
  reason      text        NOT NULL,                    -- no-match | several
  candidates  jsonb       NOT NULL DEFAULT '[]',       -- [{id, name}] when several matched (admin view only)
  first_at    timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now(),
  attempts    integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, oid)
);
