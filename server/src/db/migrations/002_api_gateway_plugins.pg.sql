-- Ferrum Nexus 002 — first-class gateway plugin ownership (PostgreSQL dialect).
--
-- Mirrors 002_api_gateway_plugins.sql; see there for what the table records.
CREATE TABLE IF NOT EXISTS api_gateway_plugins (
  api_id                  TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  role                    TEXT NOT NULL
                            CHECK (role IN ('auth', 'access_control', 'rate_limit', 'cors')),
  ferrum_plugin_config_id TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (api_id, role)
);
