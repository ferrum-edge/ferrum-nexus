-- Record the upstream Nexus wrote to the gateway, and the per-API CORS policy
-- — PostgreSQL dialect.
--
-- Mirrors 002_api_upstream_and_cors.sql column for column: `upstream_url` is
-- the normalized `scheme://host:port[/basePath]` backend the proxy was last
-- pointed at, `cors_json` is JSON text decoded at the adapter boundary exactly
-- like `rate_limit_json`. Both are NULL on pre-existing rows, and a NULL
-- `cors_json` means the gateway adds no CORS headers.

ALTER TABLE apis ADD COLUMN IF NOT EXISTS upstream_url TEXT NULL;
ALTER TABLE apis ADD COLUMN IF NOT EXISTS cors_json TEXT NULL;
