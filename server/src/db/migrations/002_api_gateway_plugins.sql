-- Ferrum Nexus 002 — first-class gateway plugin ownership (SQLite dialect).
--
-- The Edge plugin config id Nexus created for each of an API's first-class
-- plugins: the auth plugin, the `access_control` gate, the `rate_limiting`
-- quota and the `cors` policy. Edge lets a proxy carry several configs of one
-- plugin name, so the portal addresses these by recorded id rather than by
-- name, exactly as `api_plugins.ferrum_plugin_config_id` does for the palette.
--
-- Every API published since has one row per role, with a NULL config id
-- where the portal owns no config in that role. A forward migration: an API
-- published before it has no rows, which the publishing service treats as
-- "not yet recorded", role by role (docs/operations.md, "Schema versioning and
-- upgrades").
CREATE TABLE IF NOT EXISTS api_gateway_plugins (
  api_id                  TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  role                    TEXT NOT NULL
                            CHECK (role IN ('auth', 'access_control', 'rate_limit', 'cors')),
  ferrum_plugin_config_id TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (api_id, role)
);
