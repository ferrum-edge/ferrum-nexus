-- Ferrum Nexus 004 — identity-provider links (PostgreSQL dialect).
--
-- Mirrors 004_user_identities.sql; see there for what the table records.
CREATE TABLE IF NOT EXISTS user_identities (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id   TEXT NOT NULL,
  subject       TEXT NOT NULL,
  email         TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CONSTRAINT ux_user_identities_subject UNIQUE (provider_id, subject),
  CONSTRAINT ux_user_identities_user_provider UNIQUE (user_id, provider_id)
);
