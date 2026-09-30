-- Ferrum Nexus 006 — identity-provider links, address proofs and password locks (PostgreSQL dialect).
--
-- Mirrors 006_user_identities.sql; see there for what the tables record.
CREATE TABLE IF NOT EXISTS user_identities (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id   TEXT NOT NULL,
  issuer        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  email         TEXT,
  provisioned   SMALLINT NOT NULL DEFAULT 0 CHECK (provisioned IN (0, 1)),
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CONSTRAINT ux_user_identities_subject UNIQUE (provider_id, issuer, subject),
  CONSTRAINT ux_user_identities_user_provider UNIQUE (user_id, provider_id)
);

CREATE TABLE IF NOT EXISTS user_email_proofs (
  user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  method     TEXT NOT NULL
               CHECK (method IN ('verification_link', 'password_reset', 'identity_provider')),
  proven_at  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_password_locks (
  user_id     TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
