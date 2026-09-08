-- Mirrors 015_api_plugin_config_id.sql. Additive, resumable DDL; the matching
-- postcondition is in mysql/migrations.ts. VARCHAR(64) rather than the TEXT the
-- other dialects use, to match the id columns already on this table.
ALTER TABLE api_plugins ADD COLUMN ferrum_plugin_config_id VARCHAR(64) DEFAULT NULL;
