-- Provider-configured Edge plugins from the palette — SQLite dialect.
--
-- One row per (API, Edge plugin name). The row is the *portal's* record of
-- what the provider asked for; the gateway objects it produces — a
-- proxy-scoped `plugin_config` plus its entry in `Proxy.plugins[]` — stay the
-- runtime source of truth, exactly as they already are for `rate_limiting` and
-- `cors`. As with those, the Edge config id is deliberately **not** stored:
-- publishing looks configs up by `proxy_id` and `plugin_name`, so an operator
-- who recreates one by hand reconciles automatically.
--
-- `config_json` holds only the keys the plugin's descriptor in
-- `shared/src/plugins.ts` declares — Edge's config key sets are closed, so an
-- extra key is a 400 rather than a silently ignored field. `trigger_json` is
-- the portal's `{ methods?, path_prefix? }` slice of Edge's predicate tree,
-- NULL when the plugin runs for every request.
--
-- `enabled = 0` keeps the gateway config and its association in place but stops
-- Edge running it, so a provider can switch a plugin off for an afternoon
-- without retyping its settings.
--
-- The unique `(api_id, plugin_name)` pair is the whole concurrency story: two
-- browser tabs saving the same plugin resolve to one row, and the palette is
-- deliberately one instance per plugin per API (Edge allows several, but a
-- second `bot_detection` is an operator's tool, not a product control).

CREATE TABLE IF NOT EXISTS api_plugins (
  id           TEXT PRIMARY KEY,
  api_id       TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  plugin_name  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json  TEXT NOT NULL,
  trigger_json TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_api_plugins_api_name
  ON api_plugins (api_id, plugin_name);
CREATE INDEX IF NOT EXISTS ix_api_plugins_api ON api_plugins (api_id, created_at);
