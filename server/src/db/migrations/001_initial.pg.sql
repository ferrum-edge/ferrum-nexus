-- Ferrum Nexus initial schema — PostgreSQL dialect.
--
-- Mirrors 001_initial.sql table for table, column for column and index for
-- index. The conventions are identical to the SQLite variant:
--   * every id is a TEXT string UUID;
--   * every timestamp is a TEXT ISO-8601 string (UTC, millisecond precision) —
--     deliberately *not* a native timestamp type, so one logical schema works
--     across SQLite/PostgreSQL/MySQL/Mongo without per-driver conversions;
--   * booleans are SMALLINT 0/1 and are converted at the adapter boundary;
--   * structured values live in `*_json` TEXT columns holding JSON text.
--
-- PostgreSQL supports partial (`WHERE ...`) unique indexes and expression
-- indexes natively, so every uniqueness rule maps across unchanged.

-- ── Organizations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_organizations_name ON organizations (lower(name));

-- ── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('client', 'provider', 'admin', 'super_admin')),
  org_id         TEXT REFERENCES organizations (id) ON DELETE SET NULL,
  company        TEXT,
  phone          TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  email_verified SMALLINT NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  last_login_at  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Email uniqueness is case-insensitive; the adapter also lowercases on write.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (lower(email));
CREATE INDEX IF NOT EXISTS ix_users_role_status ON users (role, status);
CREATE INDEX IF NOT EXISTS ix_users_org ON users (org_id);
CREATE INDEX IF NOT EXISTS ix_users_created_at ON users (created_at);

-- ── Sessions ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_token_hash ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expires_at ON sessions (expires_at);

-- ── APIs ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apis (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  owner_user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  ferrum_proxy_id TEXT,
  namespace       TEXT NOT NULL,
  version         TEXT NOT NULL,
  spec_format     TEXT NOT NULL DEFAULT 'openapi' CHECK (spec_format IN ('openapi')),
  requestable     SMALLINT NOT NULL DEFAULT 0 CHECK (requestable IN (0, 1)),
  auth_plugin     TEXT NOT NULL CHECK (auth_plugin IN ('key_auth', 'basic_auth', 'jwt_auth')),
  rate_limit_json TEXT,
  status          TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'retired')),
  visibility      TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'internal')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_apis_slug ON apis (lower(slug));
CREATE UNIQUE INDEX IF NOT EXISTS ux_apis_proxy_id ON apis (ferrum_proxy_id)
  WHERE ferrum_proxy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_apis_owner ON apis (owner_user_id);
CREATE INDEX IF NOT EXISTS ix_apis_status_visibility ON apis (status, visibility);
CREATE INDEX IF NOT EXISTS ix_apis_created_at ON apis (created_at);

-- ── API specs ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_specs (
  id             TEXT PRIMARY KEY,
  api_id         TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  version        TEXT NOT NULL,
  raw_spec       TEXT NOT NULL,
  parsed_title   TEXT,
  parsed_version TEXT,
  is_current     SMALLINT NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- At most one current revision per API.
CREATE UNIQUE INDEX IF NOT EXISTS ux_api_specs_current ON api_specs (api_id)
  WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS ix_api_specs_api ON api_specs (api_id, created_at);

-- ── Access requests ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_requests (
  id            TEXT PRIMARY KEY,
  api_id        TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  justification TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'denied', 'revoked', 'cancelled')),
  decided_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  decided_at    TEXT,
  decision_note TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- One open request per API/user pair.
CREATE UNIQUE INDEX IF NOT EXISTS ux_access_requests_pending ON access_requests (api_id, user_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_access_requests_api_status ON access_requests (api_id, status);
CREATE INDEX IF NOT EXISTS ix_access_requests_user ON access_requests (user_id, created_at);

-- ── Grants ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grants (
  id                TEXT PRIMARY KEY,
  api_id            TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  access_request_id TEXT REFERENCES access_requests (id) ON DELETE SET NULL,
  acl_group         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_by        TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  revoked_by        TEXT REFERENCES users (id) ON DELETE SET NULL,
  revoked_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- At most one active grant per API/user pair.
CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_active ON grants (api_id, user_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_grants_user_status ON grants (user_id, status);
CREATE INDEX IF NOT EXISTS ix_grants_api_status ON grants (api_id, status);

-- ── Consumers (Edge mapping cache) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumers (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  namespace          TEXT NOT NULL,
  ferrum_consumer_id TEXT NOT NULL,
  ferrum_username    TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_consumers_user_namespace ON consumers (user_id, namespace);
CREATE UNIQUE INDEX IF NOT EXISTS ux_consumers_ferrum_id ON consumers (namespace, ferrum_consumer_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_consumers_username ON consumers (namespace, ferrum_username);

-- ── Credential metadata (show-once: fingerprint + last4 only) ──────────────
CREATE TABLE IF NOT EXISTS credential_metadata (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ferrum_consumer_id   TEXT NOT NULL,
  credential_type      TEXT NOT NULL CHECK (credential_type IN ('keyauth', 'basicauth', 'jwt')),
  ferrum_credential_id TEXT NOT NULL,
  fingerprint          TEXT NOT NULL,
  last4                TEXT NOT NULL,
  label                TEXT,
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'retiring', 'revoked')),
  rotated_from_id      TEXT REFERENCES credential_metadata (id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_credentials_fingerprint ON credential_metadata (fingerprint);
CREATE INDEX IF NOT EXISTS ix_credentials_user_status ON credential_metadata (user_id, status);
CREATE INDEX IF NOT EXISTS ix_credentials_consumer
  ON credential_metadata (ferrum_consumer_id, credential_type, created_at);

-- ── Messaging ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_threads (
  id              TEXT PRIMARY KEY,
  subject         TEXT NOT NULL,
  api_id          TEXT REFERENCES apis (id) ON DELETE SET NULL,
  created_by      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  participant_a   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  participant_b   TEXT REFERENCES users (id) ON DELETE SET NULL,
  last_message_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_threads_participant_a ON message_threads (participant_a, last_message_at);
CREATE INDEX IF NOT EXISTS ix_threads_participant_b ON message_threads (participant_b, last_message_at);
CREATE INDEX IF NOT EXISTS ix_threads_api ON message_threads (api_id);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES message_threads (id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_messages_thread ON messages (thread_id, created_at);

-- ── Notifications ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications (user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

-- ── Email outbox ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_outbox (
  id              TEXT PRIMARY KEY,
  to_email        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body_html       TEXT NOT NULL,
  body_text       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  idempotency_key TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- At-most-once semantics for keyed sends (verification, mass email).
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_outbox_idempotency ON email_outbox (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_email_outbox_due ON email_outbox (status, next_attempt_at);

-- ── Audit log (append-only) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  actor_role    TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT,
  details_json  TEXT NOT NULL DEFAULT '{}',
  ip            TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_audit_created_at ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS ix_audit_actor ON audit_logs (actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_logs (action, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_target ON audit_logs (target_type, target_id);

-- ── Application settings ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  encrypted  SMALLINT NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── Email templates ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_templates (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body_html  TEXT NOT NULL,
  body_text  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_email_templates_key ON email_templates (key);

-- ── Email verification tokens ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_verification_tokens_hash
  ON email_verification_tokens (token_hash);
CREATE INDEX IF NOT EXISTS ix_verification_tokens_user ON email_verification_tokens (user_id);
CREATE INDEX IF NOT EXISTS ix_verification_tokens_expires
  ON email_verification_tokens (expires_at);
