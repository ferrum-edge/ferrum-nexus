-- Ferrum Nexus 005 — per-account notification preferences (SQLite dialect).
--
-- One row per account that has changed a preference; an account without one
-- receives every optional notice, which is what each column defaults to. The
-- first preferences are the spec-change notice's two channels (issue #447):
-- in-app, and email.
--
-- A forward migration that copies no data: every existing account keeps
-- receiving everything until it opts out.
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id                 TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  api_spec_updated_in_app INTEGER NOT NULL DEFAULT 1 CHECK (api_spec_updated_in_app IN (0, 1)),
  api_spec_updated_email  INTEGER NOT NULL DEFAULT 1 CHECK (api_spec_updated_email IN (0, 1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
