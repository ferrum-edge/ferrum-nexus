-- Ferrum Nexus 005 — per-account notification preferences (PostgreSQL dialect).
--
-- Mirrors 005_notification_preferences.sql; see there for what the table records.
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id                 TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  api_spec_updated_in_app SMALLINT NOT NULL DEFAULT 1 CHECK (api_spec_updated_in_app IN (0, 1)),
  api_spec_updated_email  SMALLINT NOT NULL DEFAULT 1 CHECK (api_spec_updated_email IN (0, 1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
