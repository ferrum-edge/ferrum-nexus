-- Mirrors 014_api_plugin_config_id.sql: the Edge plugin config id a palette
-- save created, so ownership is a recorded id rather than a plugin name that a
-- proxy may legitimately carry twice (issue #153). NULL on every existing row;
-- `plugins/service.ts` backfills by name on the next save and never deletes a
-- config it cannot prove it owns.
ALTER TABLE api_plugins ADD COLUMN ferrum_plugin_config_id TEXT;
