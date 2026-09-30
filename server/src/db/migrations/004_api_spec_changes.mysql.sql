-- Ferrum Nexus 004 — what each published specification revision changed (MySQL 8 dialect).
--
-- Mirrors 004_api_spec_changes.sql; see there for what the table records. A
-- single replayable CREATE with its keys and constraints inline, which is the
-- only statement shape the MySQL migration runner applies. The widths match
-- `api_specs`.
CREATE TABLE IF NOT EXISTS api_spec_changes (
  id               VARCHAR(64) NOT NULL,
  api_id           VARCHAR(64) NOT NULL,
  spec_id          VARCHAR(64) NOT NULL,
  previous_spec_id VARCHAR(64) NULL,
  kind             VARCHAR(16) NOT NULL,
  version          VARCHAR(64) NOT NULL,
  previous_version VARCHAR(64) NULL,
  revision_seq     INT         NOT NULL,
  report_json      LONGTEXT    NOT NULL,
  created_at       VARCHAR(32) NOT NULL,
  updated_at       VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_api_spec_changes_spec (spec_id),
  UNIQUE KEY ux_api_spec_changes_seq (api_id, revision_seq),
  CONSTRAINT ck_api_spec_changes_kind CHECK (kind IN ('update', 'rollback')),
  CONSTRAINT fk_api_spec_changes_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
