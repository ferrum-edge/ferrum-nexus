-- Ferrum Nexus 004 — what each published specification revision changed (SQLite dialect).
--
-- One row per revision that replaced another (an upload or a rollback), holding
-- the consumer-facing comparison of the two documents as JSON. It is kept
-- apart from `api_specs` so that it outlives the documents
-- `NEXUS_SPEC_HISTORY_LIMIT` prunes, which is why `spec_id` and
-- `previous_spec_id` are plain references rather than foreign keys. Retention
-- is bounded separately, by `SPEC_CHANGE_HISTORY_LIMIT` rows per API.
--
-- A forward migration that copies no data: revisions published before it have
-- no summary, and the change history starts with the first revision after the
-- upgrade (docs/operations.md, "Schema versioning and upgrades").
CREATE TABLE IF NOT EXISTS api_spec_changes (
  id               TEXT PRIMARY KEY,
  api_id           TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  spec_id          TEXT NOT NULL,
  previous_spec_id TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('update', 'rollback')),
  version          TEXT NOT NULL,
  previous_version TEXT,
  -- The revision's `api_specs.revision_seq`: publication order, as for revisions.
  revision_seq     INTEGER NOT NULL,
  report_json      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_api_spec_changes_spec ON api_spec_changes (spec_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_api_spec_changes_seq ON api_spec_changes (api_id, revision_seq);
