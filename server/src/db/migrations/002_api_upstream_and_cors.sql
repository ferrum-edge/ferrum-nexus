-- Record the upstream Nexus wrote to the gateway, and the per-API CORS policy
-- — SQLite dialect.
--
-- `upstream_url` is the normalized `scheme://host:port[/basePath]` form of the
-- backend the proxy was last pointed at, so the portal can show and reason
-- about it without a round trip to Edge. `cors_json` follows the existing
-- `rate_limit_json` convention: JSON text, decoded at the adapter boundary.
--
-- Both are NULL on rows published before this migration; NULL `cors_json`
-- means no `cors` plugin is attached and the gateway adds no CORS headers.

ALTER TABLE apis ADD COLUMN upstream_url TEXT NULL;
ALTER TABLE apis ADD COLUMN cors_json TEXT NULL;
