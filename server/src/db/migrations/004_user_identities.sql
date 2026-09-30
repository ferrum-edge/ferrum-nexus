-- Ferrum Nexus 004 — identity-provider links (SQLite dialect).
--
-- One row per portal account linked to one subject (`sub`) at one OpenID
-- Connect provider. A returning single sign-on is matched on
-- `(provider_id, subject)`, never on the email address, so the first unique
-- key is what decides whose account a sign-in opens; the second keeps an
-- account to one identity per provider. The account's own row is unchanged:
-- an account provisioned from single sign-on is an ordinary `users` row.
--
-- A forward migration that only adds a table, so an upgraded database keeps
-- every row as it was (docs/operations.md, "Schema versioning and upgrades").
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
