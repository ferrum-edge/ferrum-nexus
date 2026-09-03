-- Provider-configured Edge plugins from the palette — MySQL 8 dialect.
--
-- Mirrors 007_api_plugins.sql. One row per (API, Edge plugin name); the
-- gateway's proxy-scoped `plugin_config` plus its `Proxy.plugins[]` entry stay
-- the runtime source of truth, and the Edge config id is deliberately not
-- stored.
--
-- `plugin_name` is VARCHAR(64) rather than the TEXT the other dialects use so
-- it can take part in the unique key — MySQL cannot index a TEXT column
-- without a prefix length. `config_json`/`trigger_json` follow 001's treatment
-- of the other JSON payload columns (LONGTEXT, decoded at the adapter
-- boundary) rather than the native JSON type, so all four adapters store the
-- same bytes.
--
-- One CREATE TABLE and its indexes inline: MySQL has no transactional DDL, so
-- a migration that needed several writes could be left half-applied and then
-- fail on the retry.

CREATE TABLE IF NOT EXISTS api_plugins (
  id           VARCHAR(64) NOT NULL,
  api_id       VARCHAR(64) NOT NULL,
  plugin_name  VARCHAR(64) NOT NULL,
  enabled      TINYINT     NOT NULL DEFAULT 1,
  config_json  LONGTEXT    NOT NULL,
  trigger_json LONGTEXT    DEFAULT NULL,
  created_at   VARCHAR(32) NOT NULL,
  updated_at   VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_api_plugins_api_name (api_id, plugin_name),
  KEY ix_api_plugins_api (api_id, created_at),
  CONSTRAINT ck_api_plugins_enabled CHECK (enabled IN (0, 1)),
  CONSTRAINT fk_api_plugins_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
