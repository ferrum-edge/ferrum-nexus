-- Ferrum Nexus initial schema — MySQL 8 dialect.
--
-- Mirrors 001_initial.sql table for table, column for column and index for
-- index. The conventions are identical to the SQLite variant:
--   * every id is a string UUID (VARCHAR(64), never a native UUID/BINARY type);
--   * every timestamp is an ISO-8601 string in a VARCHAR column — deliberately
--     *not* DATETIME/TIMESTAMP, so one logical schema works across
--     SQLite/PostgreSQL/MySQL/Mongo without per-driver conversions;
--   * booleans are TINYINT 0/1 and are converted at the adapter boundary;
--   * structured values live in `*_json` TEXT columns holding JSON text.
--
-- Three MySQL-specific adaptations, each chosen to preserve SQLite behaviour
-- exactly rather than merely approximate it:
--
-- 1. **utf8mb4_bin everywhere.** SQLite compares TEXT with BINARY collation, so
--    `fingerprint`, `token_hash`, `idempotency_key` and friends are
--    case-sensitive there. MySQL's default `utf8mb4_0900_ai_ci` would make
--    those unique indexes and equality lookups case-*insensitive*, which is
--    both a behaviour change and a hazard for base64 material. `utf8mb4_bin`
--    restores byte comparison; the deliberately case-insensitive lookups all
--    go through `lower(...)` in the adapter and through the functional indexes
--    below.
--
-- 2. **Functional indexes replace SQLite's expression indexes.** SQLite has
--    `CREATE UNIQUE INDEX ... ON users (lower(email))`; MySQL 8.0.13+ spells
--    the same thing `UNIQUE KEY ux_users_email ((lower(email)))`.
--
-- 3. **Generated columns emulate partial unique indexes.** MySQL has no
--    `CREATE UNIQUE INDEX ... WHERE <predicate>`. Two cases:
--      * *"unique when not null"* (`ux_apis_proxy_id`,
--        `ux_email_outbox_idempotency`) needs no emulation at all — a plain
--        MySQL UNIQUE index already permits unlimited NULLs, which is exactly
--        the partial-index semantics.
--      * *"unique when a status column has a particular value"*
--        (`ux_api_specs_current`, `ux_access_requests_pending`,
--        `ux_grants_active`) is emulated with a VIRTUAL generated column that
--        evaluates to the key tuple while the predicate holds and to NULL
--        otherwise, plus a plain UNIQUE index over it. Rows failing the
--        predicate collapse to NULL and are therefore exempt, matching the
--        partial index row for row. The generated columns are never written
--        or read by the adapter (INSERTs name their columns explicitly and the
--        row mappers pick fields by name), so they are invisible above the
--        adapter boundary.
--
-- MySQL does not support `CREATE INDEX IF NOT EXISTS`, so every index is
-- declared inline in its `CREATE TABLE IF NOT EXISTS` statement — which keeps
-- the whole migration idempotent. The declared index set matches the SQLite
-- one exactly; InnoDB additionally auto-creates a helper index for any foreign
-- key column not already covered, which is a storage-engine requirement rather
-- than a schema difference.

-- ── Organizations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id          VARCHAR(64)  NOT NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  created_at  VARCHAR(32)  NOT NULL,
  updated_at  VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_organizations_name ((lower(name)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             VARCHAR(64)  NOT NULL,
  email          VARCHAR(320) NOT NULL,
  password_hash  VARCHAR(512) NOT NULL,
  display_name   VARCHAR(255) NOT NULL,
  role           VARCHAR(32)  NOT NULL,
  org_id         VARCHAR(64)  DEFAULT NULL,
  company        VARCHAR(255) DEFAULT NULL,
  phone          VARCHAR(64)  DEFAULT NULL,
  status         VARCHAR(16)  NOT NULL DEFAULT 'active',
  email_verified TINYINT      NOT NULL DEFAULT 0,
  last_login_at  VARCHAR(32)  DEFAULT NULL,
  created_at     VARCHAR(32)  NOT NULL,
  updated_at     VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  -- Email uniqueness is case-insensitive; the adapter also lowercases on write.
  UNIQUE KEY ux_users_email ((lower(email))),
  KEY ix_users_role_status (role, status),
  KEY ix_users_org (org_id),
  KEY ix_users_created_at (created_at),
  CONSTRAINT ck_users_role CHECK (role IN ('client', 'provider', 'admin', 'super_admin')),
  CONSTRAINT ck_users_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT ck_users_email_verified CHECK (email_verified IN (0, 1)),
  CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Sessions ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id         VARCHAR(64)  NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  user_id    VARCHAR(64)  NOT NULL,
  csrf_token VARCHAR(255) NOT NULL,
  expires_at VARCHAR(32)  NOT NULL,
  ip         VARCHAR(64)  DEFAULT NULL,
  user_agent TEXT,
  created_at VARCHAR(32)  NOT NULL,
  updated_at VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_sessions_token_hash (token_hash),
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_expires_at (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── APIs ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apis (
  id              VARCHAR(64)  NOT NULL,
  name            VARCHAR(255) NOT NULL,
  slug            VARCHAR(255) NOT NULL,
  description     TEXT,
  owner_user_id   VARCHAR(64)  NOT NULL,
  ferrum_proxy_id VARCHAR(128) DEFAULT NULL,
  namespace       VARCHAR(128) NOT NULL,
  version         VARCHAR(64)  NOT NULL,
  spec_format     VARCHAR(32)  NOT NULL DEFAULT 'openapi',
  requestable     TINYINT      NOT NULL DEFAULT 0,
  auth_plugin     VARCHAR(32)  NOT NULL,
  rate_limit_json TEXT,
  status          VARCHAR(32)  NOT NULL DEFAULT 'published',
  visibility      VARCHAR(32)  NOT NULL DEFAULT 'public',
  created_at      VARCHAR(32)  NOT NULL,
  updated_at      VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_apis_slug ((lower(slug))),
  -- A plain UNIQUE index tolerates unlimited NULLs, matching SQLite's
  -- `WHERE ferrum_proxy_id IS NOT NULL` partial unique index.
  UNIQUE KEY ux_apis_proxy_id (ferrum_proxy_id),
  KEY ix_apis_owner (owner_user_id),
  KEY ix_apis_status_visibility (status, visibility),
  KEY ix_apis_created_at (created_at),
  CONSTRAINT ck_apis_spec_format CHECK (spec_format IN ('openapi')),
  CONSTRAINT ck_apis_requestable CHECK (requestable IN (0, 1)),
  CONSTRAINT ck_apis_auth_plugin CHECK (auth_plugin IN ('key_auth', 'basic_auth', 'jwt_auth')),
  CONSTRAINT ck_apis_status CHECK (status IN ('published', 'retired')),
  CONSTRAINT ck_apis_visibility CHECK (visibility IN ('public', 'internal')),
  CONSTRAINT fk_apis_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── API specs ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_specs (
  id             VARCHAR(64)  NOT NULL,
  api_id         VARCHAR(64)  NOT NULL,
  version        VARCHAR(64)  NOT NULL,
  raw_spec       LONGTEXT     NOT NULL,
  parsed_title   VARCHAR(255) DEFAULT NULL,
  parsed_version VARCHAR(64)  DEFAULT NULL,
  is_current     TINYINT      NOT NULL DEFAULT 0,
  created_at     VARCHAR(32)  NOT NULL,
  updated_at     VARCHAR(32)  NOT NULL,
  -- Emulates `CREATE UNIQUE INDEX ux_api_specs_current ON api_specs (api_id)
  --           WHERE is_current = 1` — non-current revisions collapse to NULL,
  -- which a MySQL UNIQUE index ignores.
  current_key    VARCHAR(64)
                   GENERATED ALWAYS AS (CASE WHEN is_current = 1 THEN api_id ELSE NULL END)
                   VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_api_specs_current (current_key),
  KEY ix_api_specs_api (api_id, created_at),
  CONSTRAINT ck_api_specs_is_current CHECK (is_current IN (0, 1)),
  CONSTRAINT fk_api_specs_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Access requests ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_requests (
  id            VARCHAR(64) NOT NULL,
  api_id        VARCHAR(64) NOT NULL,
  user_id       VARCHAR(64) NOT NULL,
  justification TEXT        NOT NULL,
  status        VARCHAR(32) NOT NULL DEFAULT 'pending',
  decided_by    VARCHAR(64) DEFAULT NULL,
  decided_at    VARCHAR(32) DEFAULT NULL,
  decision_note TEXT,
  created_at    VARCHAR(32) NOT NULL,
  updated_at    VARCHAR(32) NOT NULL,
  -- One open request per API/user pair; emulates SQLite's
  -- `... (api_id, user_id) WHERE status = 'pending'`.
  pending_key   VARCHAR(160)
                  GENERATED ALWAYS AS (
                    CASE WHEN status = 'pending' THEN CONCAT(api_id, ':', user_id) ELSE NULL END
                  ) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_access_requests_pending (pending_key),
  KEY ix_access_requests_api_status (api_id, status),
  KEY ix_access_requests_user (user_id, created_at),
  CONSTRAINT ck_access_requests_status
    CHECK (status IN ('pending', 'approved', 'denied', 'revoked', 'cancelled')),
  CONSTRAINT fk_access_requests_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE,
  CONSTRAINT fk_access_requests_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_access_requests_decider
    FOREIGN KEY (decided_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Grants ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grants (
  id                VARCHAR(64)  NOT NULL,
  api_id            VARCHAR(64)  NOT NULL,
  user_id           VARCHAR(64)  NOT NULL,
  access_request_id VARCHAR(64)  DEFAULT NULL,
  acl_group         VARCHAR(255) NOT NULL,
  status            VARCHAR(32)  NOT NULL DEFAULT 'active',
  granted_by        VARCHAR(64)  NOT NULL,
  revoked_by        VARCHAR(64)  DEFAULT NULL,
  revoked_at        VARCHAR(32)  DEFAULT NULL,
  created_at        VARCHAR(32)  NOT NULL,
  updated_at        VARCHAR(32)  NOT NULL,
  -- At most one active grant per API/user pair; emulates SQLite's
  -- `... (api_id, user_id) WHERE status = 'active'`.
  active_key        VARCHAR(160)
                      GENERATED ALWAYS AS (
                        CASE WHEN status = 'active' THEN CONCAT(api_id, ':', user_id) ELSE NULL END
                      ) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_grants_active (active_key),
  KEY ix_grants_user_status (user_id, status),
  KEY ix_grants_api_status (api_id, status),
  CONSTRAINT ck_grants_status CHECK (status IN ('active', 'revoked')),
  CONSTRAINT fk_grants_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE,
  CONSTRAINT fk_grants_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_grants_request
    FOREIGN KEY (access_request_id) REFERENCES access_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_grants_granted_by FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grants_revoked_by FOREIGN KEY (revoked_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Consumers (Edge mapping cache) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumers (
  id                 VARCHAR(64)  NOT NULL,
  user_id            VARCHAR(64)  NOT NULL,
  namespace          VARCHAR(128) NOT NULL,
  ferrum_consumer_id VARCHAR(128) NOT NULL,
  ferrum_username    VARCHAR(255) NOT NULL,
  created_at         VARCHAR(32)  NOT NULL,
  updated_at         VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_consumers_user_namespace (user_id, namespace),
  UNIQUE KEY ux_consumers_ferrum_id (namespace, ferrum_consumer_id),
  UNIQUE KEY ux_consumers_username (namespace, ferrum_username),
  CONSTRAINT fk_consumers_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Credential metadata (show-once: fingerprint + last4 only) ──────────────
CREATE TABLE IF NOT EXISTS credential_metadata (
  id                   VARCHAR(64)  NOT NULL,
  user_id              VARCHAR(64)  NOT NULL,
  ferrum_consumer_id   VARCHAR(128) NOT NULL,
  credential_type      VARCHAR(32)  NOT NULL,
  ferrum_credential_id VARCHAR(128) NOT NULL,
  fingerprint          VARCHAR(255) NOT NULL,
  last4                VARCHAR(16)  NOT NULL,
  label                VARCHAR(255) DEFAULT NULL,
  status               VARCHAR(32)  NOT NULL DEFAULT 'active',
  rotated_from_id      VARCHAR(64)  DEFAULT NULL,
  created_at           VARCHAR(32)  NOT NULL,
  updated_at           VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_credentials_fingerprint (fingerprint),
  KEY ix_credentials_user_status (user_id, status),
  KEY ix_credentials_consumer (ferrum_consumer_id, credential_type, created_at),
  CONSTRAINT ck_credentials_type CHECK (credential_type IN ('keyauth', 'basicauth', 'jwt')),
  CONSTRAINT ck_credentials_status CHECK (status IN ('active', 'retiring', 'revoked')),
  CONSTRAINT fk_credentials_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_credentials_rotated_from
    FOREIGN KEY (rotated_from_id) REFERENCES credential_metadata (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Messaging ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_threads (
  id              VARCHAR(64)  NOT NULL,
  subject         VARCHAR(255) NOT NULL,
  api_id          VARCHAR(64)  DEFAULT NULL,
  created_by      VARCHAR(64)  NOT NULL,
  participant_a   VARCHAR(64)  NOT NULL,
  participant_b   VARCHAR(64)  DEFAULT NULL,
  last_message_at VARCHAR(32)  DEFAULT NULL,
  created_at      VARCHAR(32)  NOT NULL,
  updated_at      VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  KEY ix_threads_participant_a (participant_a, last_message_at),
  KEY ix_threads_participant_b (participant_b, last_message_at),
  KEY ix_threads_api (api_id),
  CONSTRAINT fk_threads_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE SET NULL,
  CONSTRAINT fk_threads_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_threads_participant_a
    FOREIGN KEY (participant_a) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_threads_participant_b
    FOREIGN KEY (participant_b) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS messages (
  id             VARCHAR(64) NOT NULL,
  thread_id      VARCHAR(64) NOT NULL,
  sender_user_id VARCHAR(64) NOT NULL,
  body           TEXT        NOT NULL,
  created_at     VARCHAR(32) NOT NULL,
  updated_at     VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_messages_thread (thread_id, created_at),
  CONSTRAINT fk_messages_thread
    FOREIGN KEY (thread_id) REFERENCES message_threads (id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_sender
    FOREIGN KEY (sender_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Notifications ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         VARCHAR(64)  NOT NULL,
  user_id    VARCHAR(64)  NOT NULL,
  type       VARCHAR(64)  NOT NULL,
  title      VARCHAR(255) NOT NULL,
  body       TEXT         NOT NULL,
  link       VARCHAR(512) DEFAULT NULL,
  read_at    VARCHAR(32)  DEFAULT NULL,
  created_at VARCHAR(32)  NOT NULL,
  updated_at VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  KEY ix_notifications_user (user_id, created_at),
  -- SQLite indexes only the unread rows; MySQL has no partial index, and since
  -- this one is a *lookup* index (not a uniqueness rule) the equivalent
  -- coverage is a plain composite that leads with the same column.
  KEY ix_notifications_unread (user_id, read_at),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Email outbox ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_outbox (
  id              VARCHAR(64)  NOT NULL,
  to_email        VARCHAR(320) NOT NULL,
  subject         VARCHAR(998) NOT NULL,
  body_html       LONGTEXT     NOT NULL,
  body_text       LONGTEXT     NOT NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT 'pending',
  attempts        INT          NOT NULL DEFAULT 0,
  next_attempt_at VARCHAR(32)  DEFAULT NULL,
  last_error      TEXT,
  idempotency_key VARCHAR(255) DEFAULT NULL,
  created_at      VARCHAR(32)  NOT NULL,
  updated_at      VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  -- At-most-once semantics for keyed sends; NULLs are exempt, exactly like
  -- SQLite's `WHERE idempotency_key IS NOT NULL` partial unique index.
  UNIQUE KEY ux_email_outbox_idempotency (idempotency_key),
  KEY ix_email_outbox_due (status, next_attempt_at),
  CONSTRAINT ck_email_outbox_status CHECK (status IN ('pending', 'sending', 'sent', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Audit log (append-only) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id            VARCHAR(64)  NOT NULL,
  actor_user_id VARCHAR(64)  DEFAULT NULL,
  actor_role    VARCHAR(32)  DEFAULT NULL,
  action        VARCHAR(128) NOT NULL,
  target_type   VARCHAR(64)  NOT NULL,
  target_id     VARCHAR(128) DEFAULT NULL,
  details_json  TEXT         NOT NULL DEFAULT ('{}'),
  ip            VARCHAR(64)  DEFAULT NULL,
  created_at    VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  KEY ix_audit_created_at (created_at),
  KEY ix_audit_actor (actor_user_id, created_at),
  KEY ix_audit_action (action, created_at),
  KEY ix_audit_target (target_type, target_id),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Application settings ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  `key`      VARCHAR(191) NOT NULL,
  value_json LONGTEXT     NOT NULL,
  encrypted  TINYINT      NOT NULL DEFAULT 0,
  created_at VARCHAR(32)  NOT NULL,
  updated_at VARCHAR(32)  NOT NULL,
  PRIMARY KEY (`key`),
  CONSTRAINT ck_app_settings_encrypted CHECK (encrypted IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Email templates ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_templates (
  id         VARCHAR(64)  NOT NULL,
  `key`      VARCHAR(64)  NOT NULL,
  subject    VARCHAR(998) NOT NULL,
  body_html  LONGTEXT     NOT NULL,
  body_text  LONGTEXT     NOT NULL,
  created_at VARCHAR(32)  NOT NULL,
  updated_at VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_email_templates_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Email verification tokens ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         VARCHAR(64)  NOT NULL,
  user_id    VARCHAR(64)  NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  expires_at VARCHAR(32)  NOT NULL,
  used_at    VARCHAR(32)  DEFAULT NULL,
  created_at VARCHAR(32)  NOT NULL,
  updated_at VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_verification_tokens_hash (token_hash),
  KEY ix_verification_tokens_user (user_id),
  KEY ix_verification_tokens_expires (expires_at),
  CONSTRAINT fk_verification_tokens_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
