-- 0027_sla_outage_claims — Autotask outage log + monthly SLA credit claims.
--
-- autotask_outage: one row per time the tenant-wide outage breaker opened (5+ network errors / 5xx answers in a
-- minute across 3+ modules). started_at = when PSArelay detected it; ended_at = when a call got through again
-- (confirmed_back) or, after a restart cut the watch short, the last time it was still seen (ended_reason 'restart').
-- http_statuses holds the 5xx codes Autotask answered with; network_errors counts failures with no HTTP answer
-- (those could also be this server's own connection, so a claim lists them apart).
--
-- sla_claim: one draft per tenant and month, built on the 1st (or from the console) when the month's confirmed
-- Autotask downtime reaches the threshold. An admin reviews it and presses Send; it is emailed from the
-- configured Microsoft 365 mailbox (plain text; a draft's subject and text can be edited first). Sent claims are never rebuilt.

CREATE TABLE IF NOT EXISTS autotask_outage (
  id              bigserial   PRIMARY KEY,
  tenant          text        NOT NULL,
  started_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  ended_at        timestamptz,
  confirmed_back  boolean     NOT NULL DEFAULT false,
  ended_reason    text,                                   -- 'back' | 'restart'
  failures        integer     NOT NULL DEFAULT 0,         -- most failures counted in one minute
  endpoints       text[]      NOT NULL DEFAULT '{}',
  http_statuses   integer[]   NOT NULL DEFAULT '{}',
  network_errors  integer     NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, started_at)
);
CREATE INDEX IF NOT EXISTS autotask_outage_started ON autotask_outage (tenant, started_at);
CREATE INDEX IF NOT EXISTS autotask_outage_open ON autotask_outage (tenant) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS sla_claim (
  id                bigserial   PRIMARY KEY,
  tenant            text        NOT NULL,
  month             date        NOT NULL,               -- first day of the month claimed for
  status            text        NOT NULL DEFAULT 'draft', -- draft | sent | dismissed
  downtime_seconds  integer     NOT NULL,
  incidents         integer     NOT NULL,
  uptime_pct        numeric(8,4) NOT NULL,
  to_addresses      text[]      NOT NULL DEFAULT '{}',
  cc_addresses      text[]      NOT NULL DEFAULT '{}',
  subject           text        NOT NULL,
  body_text         text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  sent_by           text,
  sent_from         text,
  dismissed_by      text,
  UNIQUE (tenant, month)
);
