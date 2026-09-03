-- Provider-configured Edge plugins from the palette — PostgreSQL dialect.
--
-- Mirrors 007_api_plugins.sql column for column: one row per (API, Edge plugin
-- name), holding only what the provider chose. The gateway objects it produces
-- — a proxy-scoped `plugin_config` and its entry in `Proxy.plugins[]` — remain
-- the runtime source of truth, and the Edge config id is deliberately not
-- stored (configs are looked up by `proxy_id` + `plugin_name`).
--
-- `is_current`-style booleans are SMALLINT 0/1 here for the same reason the
-- rest of the schema is: the adapters convert at the boundary and the services
-- only ever see real booleans.

CREATE TABLE IF NOT EXISTS api_plugins (
  id           TEXT PRIMARY KEY,
  api_id       TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  plugin_name  TEXT NOT NULL,
  enabled      SMALLINT NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json  TEXT NOT NULL,
  trigger_json TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_api_plugins_api_name
  ON api_plugins (api_id, plugin_name);
CREATE INDEX IF NOT EXISTS ix_api_plugins_api ON api_plugins (api_id, created_at);
