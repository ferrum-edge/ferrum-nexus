-- Ferrum Nexus 004 — what each published specification revision changed (PostgreSQL dialect).
--
-- Mirrors 004_api_spec_changes.sql; see there for what the table records.
CREATE TABLE IF NOT EXISTS api_spec_changes (
  id               TEXT PRIMARY KEY,
  api_id           TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  spec_id          TEXT NOT NULL,
  previous_spec_id TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('update', 'rollback')),
  version          TEXT NOT NULL,
  previous_version TEXT,
  revision_seq     INTEGER NOT NULL,
  report_json      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_api_spec_changes_spec ON api_spec_changes (spec_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_api_spec_changes_seq ON api_spec_changes (api_id, revision_seq);
