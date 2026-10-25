-- 0019_user_autotask_link — link console users to their Autotask resource; self-service access tokens.
--
-- An administrator links each console user to the Autotask resource they are. That user can then create their own
-- access tokens (Account → Connect your AI): always "one person" tokens for THEIR linked resource, so writes run as
-- them and Autotask applies their own security level. A token stops working when its owner is disabled or deleted,
-- or linked to a different resource.

ALTER TABLE admin_user ADD COLUMN IF NOT EXISTS autotask_resource_id   bigint;
ALTER TABLE admin_user ADD COLUMN IF NOT EXISTS autotask_resource_name text;
ALTER TABLE mcp_token  ADD COLUMN IF NOT EXISTS owner_user_id bigint REFERENCES admin_user (id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS mcp_token_owner ON mcp_token (owner_user_id) WHERE owner_user_id IS NOT NULL;
