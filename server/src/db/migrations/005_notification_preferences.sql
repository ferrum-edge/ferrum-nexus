-- Ferrum Nexus 005 — per-account notification preferences (SQLite dialect).
--
-- One row per account that has changed a preference; an account without one
-- gets each notice's default, which is what each column defaults to. The first
-- preferences are the spec-change notice's two channels (issue #447): in-app,
-- on by default, and email, off until the account turns it on.
--
-- A forward migration that copies no data: every existing account gets the
-- defaults until it changes one.
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id                 TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  api_spec_updated_in_app INTEGER NOT NULL DEFAULT 1 CHECK (api_spec_updated_in_app IN (0, 1)),
  api_spec_updated_email  INTEGER NOT NULL DEFAULT 0 CHECK (api_spec_updated_email IN (0, 1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
