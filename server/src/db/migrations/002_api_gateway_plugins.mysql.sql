-- Ferrum Nexus 002 — first-class gateway plugin ownership (MySQL 8 dialect).
--
-- Mirrors 002_api_gateway_plugins.sql; see there for what the table records.
-- A single replayable CREATE with its keys and constraints inline, which is
-- the only statement shape the MySQL migration runner applies. The config id
-- is as wide as Edge allows a resource id to be.
CREATE TABLE IF NOT EXISTS api_gateway_plugins (
  api_id                  VARCHAR(64) NOT NULL,
  role                    VARCHAR(32) NOT NULL,
  ferrum_plugin_config_id VARCHAR(254) NULL,
  created_at              VARCHAR(32) NOT NULL,
  updated_at              VARCHAR(32) NOT NULL,
  PRIMARY KEY (api_id, role),
  CONSTRAINT ck_api_gateway_plugins_role
    CHECK (role IN ('auth', 'access_control', 'rate_limit', 'cors')),
  CONSTRAINT fk_api_gateway_plugins_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
