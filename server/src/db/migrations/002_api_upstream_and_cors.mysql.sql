-- Record the upstream Nexus wrote to the gateway, and the per-API CORS policy
-- — MySQL 8 dialect.
--
-- Mirrors 002_api_upstream_and_cors.sql column for column: `upstream_url` is
-- the normalized `scheme://host:port[/basePath]` backend the proxy was last
-- pointed at, `cors_json` is JSON text decoded at the adapter boundary exactly
-- like `rate_limit_json`. Both are NULL on pre-existing rows, and a NULL
-- `cors_json` means the gateway adds no CORS headers.
--
-- MySQL has no `ADD COLUMN IF NOT EXISTS` and no transactional DDL, so both
-- columns are added by a single ALTER: a half-applied migration would be left
-- pending by the runner and fail on the retry.

ALTER TABLE apis
  ADD COLUMN upstream_url TEXT NULL,
  ADD COLUMN cors_json    TEXT NULL;
