-- Ferrum Nexus base schema — MySQL 8 dialect.
--
-- FROZEN. This is the Ferrum Nexus 1.0 baseline, unchanged since v0.6.0
-- first shipped it (ledger id 000_base_v0_6). Never edit it: a database
-- created from it never reads this file again, so an edit would make new and
-- upgraded databases diverge. Every schema change is a numbered forward
-- migration in server/src/db/migrations/ (docs/operations.md, "Schema and
-- upgrades"). server/src/db/frozen-baseline.test.ts fails on any change here.
--
-- Mirrors base.sql table for table, column for column and index for
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
-- the whole schema replayable. The declared index set matches the SQLite
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
  email_lifecycle_fence VARCHAR(36) NOT NULL DEFAULT '',
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
  id                   VARCHAR(64)  NOT NULL,
  upstream_url         TEXT,
  cors_json            TEXT,
  allowed_methods_json TEXT,
  timeouts_json        TEXT,
  circuit_breaker      TINYINT NOT NULL DEFAULT 0,
  spec_enforcement     VARCHAR(32) NOT NULL DEFAULT 'docs_only',
  name                 VARCHAR(255) NOT NULL,
  slug                 VARCHAR(255) NOT NULL,
  description          LONGTEXT     DEFAULT NULL,
  owner_user_id        VARCHAR(64)  NOT NULL,
  ferrum_proxy_id      VARCHAR(128) DEFAULT NULL,
  namespace            VARCHAR(128) NOT NULL,
  version              LONGTEXT     NOT NULL,
  spec_format          VARCHAR(32)  NOT NULL DEFAULT 'openapi',
  requestable          TINYINT      NOT NULL DEFAULT 0,
  auth_plugin          VARCHAR(32)  NOT NULL,
  rate_limit_json      TEXT,
  status               VARCHAR(32)  NOT NULL DEFAULT 'published',
  visibility           VARCHAR(32)  NOT NULL DEFAULT 'public',
  gateway_state        VARCHAR(32)  NOT NULL DEFAULT 'deployed',
  created_at           VARCHAR(32)  NOT NULL,
  updated_at           VARCHAR(32)  NOT NULL,
  agents_json          LONGTEXT DEFAULT NULL,
  CONSTRAINT ck_apis_spec_enforcement CHECK (spec_enforcement IN ('docs_only', 'routes')),
  PRIMARY KEY (id),
  UNIQUE KEY ux_apis_slug ((lower(slug))),
  -- A plain UNIQUE index tolerates unlimited NULLs, matching SQLite's
  -- `WHERE ferrum_proxy_id IS NOT NULL` partial unique index.
  UNIQUE KEY ux_apis_proxy_id (ferrum_proxy_id),
  KEY ix_apis_owner (owner_user_id),
  KEY ix_apis_status_visibility (status, visibility),
  KEY ix_apis_created_at (created_at),
  KEY ix_apis_gateway_state (namespace, gateway_state),
  CONSTRAINT ck_apis_circuit_breaker CHECK (circuit_breaker IN (0, 1)),
  CONSTRAINT ck_apis_spec_format CHECK (spec_format IN ('openapi')),
  CONSTRAINT ck_apis_requestable CHECK (requestable IN (0, 1)),
  CONSTRAINT ck_apis_auth_plugin CHECK (auth_plugin IN ('key_auth', 'basic_auth', 'jwt_auth')),
  CONSTRAINT ck_apis_status CHECK (status IN ('published', 'retired')),
  CONSTRAINT ck_apis_visibility CHECK (visibility IN ('public', 'internal', 'private')),
  CONSTRAINT ck_apis_gateway_state CHECK (gateway_state IN ('deployed', 'repair_required')),
  CONSTRAINT fk_apis_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── API specs ──────────────────────────────────────────────────────────────
-- ── Applications (per-integration identities) ──────────────────────────────
--
-- Owned by a portal account, with their own access requests, grants,
-- credentials and Ferrum consumer (`nexus-app-<application_id>`). Every row
-- that can be scoped carries a nullable `application_id`; `NULL` means "the
-- account itself", which is what every existing row is (issue #289).
CREATE TABLE IF NOT EXISTS applications (
  id            VARCHAR(64)  NOT NULL,
  owner_user_id VARCHAR(64)  NOT NULL,
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  status        VARCHAR(32)  NOT NULL DEFAULT 'active',
  created_at    VARCHAR(32)  NOT NULL,
  updated_at    VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_applications_owner_name (owner_user_id, (lower(name))),
  KEY ix_applications_owner (owner_user_id, created_at),
  CONSTRAINT ck_applications_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT fk_applications_owner FOREIGN KEY (owner_user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS api_viewers (
  id         VARCHAR(64) NOT NULL,
  api_id     VARCHAR(64) NOT NULL,
  user_id    VARCHAR(64) NOT NULL,
  granted_by VARCHAR(64) DEFAULT NULL,
  note       TEXT,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_api_viewers_api_user (api_id, user_id),
  KEY ix_api_viewers_user (user_id),
  KEY ix_api_viewers_api (api_id, created_at),
  CONSTRAINT fk_api_viewers_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE,
  CONSTRAINT fk_api_viewers_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_api_viewers_granted_by FOREIGN KEY (granted_by) REFERENCES users (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS api_specs (
  id             VARCHAR(64)  NOT NULL,
  api_id         VARCHAR(64)  NOT NULL,
  version        LONGTEXT     NOT NULL,
  raw_spec       LONGTEXT     NOT NULL,
  parsed_title   LONGTEXT     DEFAULT NULL,
  parsed_version LONGTEXT     DEFAULT NULL,
  is_current     TINYINT      NOT NULL DEFAULT 0,
  revision_seq   INT          NOT NULL,
  created_by     VARCHAR(64)  DEFAULT NULL,
  rolled_back_from_id VARCHAR(64) DEFAULT NULL,
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
  -- Publication order; see the SQLite schema for why the timestamp is not it.
  UNIQUE KEY ux_api_specs_seq (api_id, revision_seq),
  KEY ix_api_specs_created_by (created_by),
  KEY ix_api_specs_rolled_back_from (rolled_back_from_id),
  CONSTRAINT ck_api_specs_is_current CHECK (is_current IN (0, 1)),
  CONSTRAINT fk_api_specs_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE,
  CONSTRAINT fk_api_specs_created_by FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE SET NULL,
  CONSTRAINT fk_api_specs_rolled_back_from FOREIGN KEY (rolled_back_from_id)
    REFERENCES api_specs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Access requests ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_requests (
  id            VARCHAR(64) NOT NULL,
  api_id        VARCHAR(64) NOT NULL,
  user_id       VARCHAR(64) NOT NULL,
  application_id VARCHAR(64) DEFAULT NULL,
  justification TEXT        NOT NULL,
  status        VARCHAR(32) NOT NULL DEFAULT 'pending',
  decided_by    VARCHAR(64) DEFAULT NULL,
  decided_at    VARCHAR(32) DEFAULT NULL,
  decision_note TEXT,
  created_at    VARCHAR(32) NOT NULL,
  updated_at    VARCHAR(32) NOT NULL,
  requested_tools_json LONGTEXT DEFAULT NULL,
  approved_tools_json  LONGTEXT DEFAULT NULL,
  grant_id      VARCHAR(64) NULL,
  -- One open request per API and identity; emulates SQLite's
  -- `... (api_id, user_id, COALESCE(application_id, '')) WHERE status = 'pending'`.
  -- `COALESCE` rather than the bare column for the same reason SQLite needs
  -- it: a NULL would make every account-scoped request distinct.
  pending_key   VARCHAR(240)
                  GENERATED ALWAYS AS (
                    CASE
                      WHEN status = 'pending'
                        THEN CONCAT(api_id, ':', user_id, ':', COALESCE(application_id, ''))
                      ELSE NULL
                    END
                  ) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_access_requests_pending (pending_key),
  KEY ix_access_requests_api_status (api_id, status),
  KEY ix_access_requests_user (user_id, created_at),
  KEY ix_access_requests_application (application_id, status),
  CONSTRAINT ck_access_requests_status
    CHECK (status IN ('pending', 'approved', 'denied', 'revoked', 'cancelled')),
  CONSTRAINT fk_access_requests_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE,
  CONSTRAINT fk_access_requests_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_access_requests_decider
    FOREIGN KEY (decided_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_access_requests_application
    FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Grants ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grants (
  id                VARCHAR(64)  NOT NULL,
  api_id            VARCHAR(64)  NOT NULL,
  user_id           VARCHAR(64)  NOT NULL,
  application_id    VARCHAR(64)  DEFAULT NULL,
  access_request_id VARCHAR(64)  DEFAULT NULL,
  acl_group         VARCHAR(255) NOT NULL,
  status            VARCHAR(32)  NOT NULL DEFAULT 'active',
  granted_by        VARCHAR(64)  NOT NULL,
  revoked_by        VARCHAR(64)  DEFAULT NULL,
  revoked_at        VARCHAR(32)  DEFAULT NULL,
  created_at        VARCHAR(32)  NOT NULL,
  updated_at        VARCHAR(32)  NOT NULL,
  approved_tools_json LONGTEXT DEFAULT NULL,
  -- At most one active grant per API and identity; emulates SQLite's
  -- `... (api_id, user_id, COALESCE(application_id, '')) WHERE status = 'active'`.
  active_key        VARCHAR(240)
                      GENERATED ALWAYS AS (
                        CASE
                          WHEN status = 'active'
                            THEN CONCAT(api_id, ':', user_id, ':', COALESCE(application_id, ''))
                          ELSE NULL
                        END
                      ) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_grants_active (active_key),
  KEY ix_grants_user_status (user_id, status),
  KEY ix_grants_api_status (api_id, status),
  KEY ix_grants_application (application_id, status),
  CONSTRAINT ck_grants_status CHECK (status IN ('active', 'revoked')),
  CONSTRAINT fk_grants_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE,
  CONSTRAINT fk_grants_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_grants_request
    FOREIGN KEY (access_request_id) REFERENCES access_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_grants_granted_by FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grants_revoked_by FOREIGN KEY (revoked_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_grants_application
    FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Consumers (Edge mapping cache) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumers (
  id                 VARCHAR(64)  NOT NULL,
  user_id            VARCHAR(64)  NOT NULL,
  application_id     VARCHAR(64)  DEFAULT NULL,
  namespace          VARCHAR(128) NOT NULL,
  -- Emulates SQLite's `(user_id, namespace, COALESCE(application_id, ''))`.
  identity_key       VARCHAR(320)
                       GENERATED ALWAYS AS (
                         CONCAT(user_id, ':', namespace, ':', COALESCE(application_id, ''))
                       ) VIRTUAL,
  ferrum_consumer_id VARCHAR(128) NOT NULL,
  ferrum_username    VARCHAR(255) NOT NULL,
  created_at         VARCHAR(32)  NOT NULL,
  updated_at         VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_consumers_user_namespace (identity_key),
  KEY ix_consumers_application (application_id),
  UNIQUE KEY ux_consumers_ferrum_id (namespace, ferrum_consumer_id),
  UNIQUE KEY ux_consumers_username (namespace, ferrum_username),
  CONSTRAINT fk_consumers_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_consumers_application
    FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Credential metadata (show-once: fingerprint + last4 only) ──────────────
CREATE TABLE IF NOT EXISTS credential_metadata (
  id                   VARCHAR(64)  NOT NULL,
  edge_ordinal         INT DEFAULT NULL,
  user_id              VARCHAR(64)  NOT NULL,
  application_id       VARCHAR(64)  DEFAULT NULL,
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
  UNIQUE KEY ux_credentials_ordinal (ferrum_consumer_id, credential_type, edge_ordinal),
  PRIMARY KEY (id),
  UNIQUE KEY ux_credentials_fingerprint (fingerprint),
  KEY ix_credentials_user_status (user_id, status),
  KEY ix_credentials_application (application_id, status),
  KEY ix_credentials_consumer (ferrum_consumer_id, credential_type, created_at),
  CONSTRAINT ck_credentials_type CHECK (credential_type IN ('keyauth', 'basicauth', 'jwt')),
  CONSTRAINT ck_credentials_status CHECK (status IN ('active', 'retiring', 'revoked')),
  CONSTRAINT fk_credentials_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_credentials_rotated_from
    FOREIGN KEY (rotated_from_id) REFERENCES credential_metadata (id) ON DELETE SET NULL,
  CONSTRAINT fk_credentials_application
    FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Messaging ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_threads (
  id              VARCHAR(64)  NOT NULL,
  subject         VARCHAR(300) NOT NULL,
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
  broadcast      TINYINT NOT NULL DEFAULT 0,
  thread_id      VARCHAR(64) NOT NULL,
  sender_user_id VARCHAR(64) NOT NULL,
  body           TEXT        NOT NULL,
  created_at     VARCHAR(32) NOT NULL,
  updated_at     VARCHAR(32) NOT NULL,
  CONSTRAINT ck_messages_broadcast CHECK (broadcast IN (0, 1)),
  KEY ix_messages_sender (sender_user_id, created_at),
  PRIMARY KEY (id),
  -- InnoDB appends the primary key to every secondary index, so this is
  -- (thread_id, created_at, id): the newest-message lookup's `id` tie-break
  -- is served by the index, as `ix_messages_thread_latest` does elsewhere.
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
  title      VARCHAR(300) NOT NULL,
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
  generation      VARCHAR(64) NOT NULL DEFAULT '',
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
  recipient_user_id VARCHAR(36) NULL,
  priority        INT NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  -- At-most-once semantics for keyed sends; NULLs are exempt, exactly like
  -- SQLite's `WHERE idempotency_key IS NOT NULL` partial unique index.
  UNIQUE KEY ux_email_outbox_idempotency (idempotency_key),
  KEY ix_email_outbox_due (status, next_attempt_at),
  -- Claim order; ix_email_outbox_due stays for due-time filtering.
  KEY ix_email_outbox_priority (status, priority DESC, next_attempt_at, created_at, id),
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
  details_json  LONGTEXT     NOT NULL DEFAULT ('{}'),
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
  purpose    VARCHAR(32) NOT NULL DEFAULT 'email_verification',
  user_id    VARCHAR(64)  NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  expires_at VARCHAR(32)  NOT NULL,
  used_at    VARCHAR(32)  DEFAULT NULL,
  created_at VARCHAR(32)  NOT NULL,
  updated_at VARCHAR(32)  NOT NULL,
  KEY ix_verification_tokens_user_purpose (user_id, purpose),
  PRIMARY KEY (id),
  UNIQUE KEY ux_verification_tokens_hash (token_hash),
  KEY ix_verification_tokens_user (user_id),
  KEY ix_verification_tokens_expires (expires_at),
  CONSTRAINT fk_verification_tokens_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Email token issue claims ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_token_issue_claims (
  user_id   VARCHAR(64) NOT NULL,
  purpose   VARCHAR(32) NOT NULL,
  issued_at VARCHAR(30) NOT NULL,
  PRIMARY KEY (user_id, purpose),
  CONSTRAINT fk_token_issue_claim_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── API palette plugins ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_plugins (
  id                      VARCHAR(64) NOT NULL,
  ferrum_plugin_config_id VARCHAR(64) DEFAULT NULL,
  api_id                  VARCHAR(64) NOT NULL,
  plugin_name             VARCHAR(64) NOT NULL,
  enabled                 TINYINT     NOT NULL DEFAULT 1,
  config_json             LONGTEXT    NOT NULL,
  trigger_json            LONGTEXT    DEFAULT NULL,
  created_at              VARCHAR(32) NOT NULL,
  updated_at              VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_api_plugins_api_name (api_id, plugin_name),
  KEY ix_api_plugins_api (api_id, created_at),
  CONSTRAINT ck_api_plugins_enabled CHECK (enabled IN (0, 1)),
  CONSTRAINT fk_api_plugins_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Gateway teardown jobs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gateway_teardown_jobs (
  id              VARCHAR(64) NOT NULL,
  generation      VARCHAR(64) NOT NULL DEFAULT '',
  user_id         VARCHAR(64) NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at VARCHAR(32) DEFAULT NULL,
  last_error      TEXT,
  requested_by    VARCHAR(64) DEFAULT NULL,
  created_at      VARCHAR(32) NOT NULL,
  updated_at      VARCHAR(32) NOT NULL,
  completed_at    VARCHAR(32) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_gateway_teardown_jobs_user (user_id),
  KEY ix_gateway_teardown_jobs_due (status, next_attempt_at),
  CONSTRAINT ck_gateway_teardown_jobs_status CHECK (status IN ('pending', 'sending', 'done')),
  CONSTRAINT fk_gateway_teardown_jobs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_gateway_teardown_jobs_requested_by FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Edge leases ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS edge_leases (
  `key`      VARCHAR(255) NOT NULL,
  owner      VARCHAR(64)  NOT NULL,
  expires_at VARCHAR(32)  NOT NULL,
  created_at VARCHAR(32)  NOT NULL,
  updated_at VARCHAR(32)  NOT NULL,
  PRIMARY KEY (`key`),
  KEY ix_edge_leases_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Gateway identities ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gateway_identities (
  id                 VARCHAR(64)  NOT NULL,
  user_id            VARCHAR(64)  NOT NULL,
  namespace          VARCHAR(128) NOT NULL,
  ferrum_username    VARCHAR(255) NOT NULL,
  ferrum_consumer_id VARCHAR(128) DEFAULT NULL,
  created_at         VARCHAR(32)  NOT NULL,
  updated_at         VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_gateway_identities_username (namespace, ferrum_username),
  KEY ix_gateway_identities_user (user_id, namespace),
  CONSTRAINT fk_gateway_identities_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── API gateway plugins (first-class plugin ownership) ─────────────────────
--
-- The Edge plugin config id Nexus created for each of an API's first-class
-- plugins: the auth plugin, the `access_control` gate, the `rate_limiting`
-- quota and the `cors` policy. Edge lets a proxy carry several configs of one
-- plugin name, so the portal addresses these by recorded id rather than by
-- name, exactly as `api_plugins.ferrum_plugin_config_id` does for the palette.
-- Every published API has one row per role, with a NULL config id where the
-- portal owns no config in that role.
CREATE TABLE IF NOT EXISTS api_gateway_plugins (
  api_id                  VARCHAR(64) NOT NULL,
  role                    VARCHAR(32) NOT NULL,
  ferrum_plugin_config_id VARCHAR(254) NULL,
  created_at              VARCHAR(32) NOT NULL,
  updated_at              VARCHAR(32) NOT NULL,
  PRIMARY KEY (api_id, role),
  CONSTRAINT ck_api_gateway_plugins_role
    CHECK (role IN ('auth', 'access_control', 'rate_limit', 'cors')),
  CONSTRAINT fk_api_gateway_plugins_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── API specification changes ──────────────────────────────────────────────
--
-- One row per revision that replaced another (an upload or a rollback), holding
-- the consumer-facing comparison of the two documents as JSON. It is kept
-- apart from `api_specs` so that it outlives the documents
-- `NEXUS_SPEC_HISTORY_LIMIT` prunes, which is why `spec_id` and
-- `previous_spec_id` are plain references rather than foreign keys. Retention
-- is bounded separately, by `SPEC_CHANGE_HISTORY_LIMIT` rows per API.
CREATE TABLE IF NOT EXISTS api_spec_changes (
  id               VARCHAR(64) NOT NULL,
  api_id           VARCHAR(64) NOT NULL,
  spec_id          VARCHAR(64) NOT NULL,
  previous_spec_id VARCHAR(64) NULL,
  kind             VARCHAR(16) NOT NULL,
  version          LONGTEXT    NOT NULL,
  previous_version LONGTEXT    DEFAULT NULL,
  revision_seq     INT         NOT NULL,
  report_json      LONGTEXT    NOT NULL,
  created_at       VARCHAR(32) NOT NULL,
  updated_at       VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_api_spec_changes_spec (spec_id),
  UNIQUE KEY ux_api_spec_changes_seq (api_id, revision_seq),
  CONSTRAINT ck_api_spec_changes_kind CHECK (kind IN ('update', 'rollback')),
  CONSTRAINT fk_api_spec_changes_api FOREIGN KEY (api_id) REFERENCES apis (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Notification preferences ───────────────────────────────────────────────
--
-- One row per account that has changed a preference; an account without one
-- gets each notice's default, which is what each column defaults to. The first
-- preferences are the spec-change notice's two channels (issue #447): in-app,
-- on by default, and email, off until the account turns it on.
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id                 VARCHAR(64) NOT NULL,
  api_spec_updated_in_app TINYINT     NOT NULL DEFAULT 1,
  api_spec_updated_email  TINYINT     NOT NULL DEFAULT 0,
  created_at              VARCHAR(32) NOT NULL,
  updated_at              VARCHAR(32) NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT ck_user_notification_preferences_in_app CHECK (api_spec_updated_in_app IN (0, 1)),
  CONSTRAINT ck_user_notification_preferences_email CHECK (api_spec_updated_email IN (0, 1)),
  CONSTRAINT fk_user_notification_preferences_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Identity-provider links, address proofs and password locks ────────────
--
-- `user_identities`: one row per portal account linked to one subject (`sub`)
-- at one OpenID Connect provider. A returning single sign-on is matched on
-- `(provider_id, issuer, subject)`, never on the email address, so the first
-- unique key is what decides whose account a sign-in opens — and a provider
-- id reused for another issuer matches none of the old links. The second keeps
-- an account to one identity per provider. `provisioned` marks the identity
-- that created the account, which then has no local password to fall back on.
--
-- `user_email_proofs`: evidence that an account's holder controls its address
-- — a redeemed verification link, a completed password reset, or a provider
-- that asserted the address verified. `users.email_verified` alone is not
-- evidence: with verification off a registration is marked verified without
-- any. Only a proof for the account's current address allows single sign-on
-- to link to it.
--
-- `user_password_locks`: accounts that may never use a local password, because
-- an identity provider created them. Kept apart from the links on purpose:
-- removing the provider or unlinking the identity must not hand the account a
-- password (through a reset) that outlives the provider's offboarding.
CREATE TABLE IF NOT EXISTS user_identities (
  id            VARCHAR(64)  NOT NULL,
  user_id       VARCHAR(64)  NOT NULL,
  provider_id   VARCHAR(64)  NOT NULL,
  issuer        VARCHAR(255) NOT NULL,
  subject       VARCHAR(255) NOT NULL,
  email         VARCHAR(320) DEFAULT NULL,
  provisioned   TINYINT      NOT NULL DEFAULT 0,
  last_login_at VARCHAR(32)  DEFAULT NULL,
  created_at    VARCHAR(32)  NOT NULL,
  updated_at    VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_user_identities_subject (provider_id, issuer, subject),
  UNIQUE KEY ux_user_identities_user_provider (user_id, provider_id),
  CONSTRAINT ck_user_identities_provisioned CHECK (provisioned IN (0, 1)),
  CONSTRAINT fk_user_identities_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS user_email_proofs (
  user_id    VARCHAR(64)  NOT NULL,
  email      VARCHAR(320) NOT NULL,
  method     VARCHAR(32)  NOT NULL,
  proven_at  VARCHAR(32)  NOT NULL,
  created_at VARCHAR(32)  NOT NULL,
  updated_at VARCHAR(32)  NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT ck_user_email_proofs_method
    CHECK (method IN ('verification_link', 'password_reset', 'identity_provider')),
  CONSTRAINT fk_user_email_proofs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS user_password_locks (
  user_id     VARCHAR(64) NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  created_at  VARCHAR(32) NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_password_locks_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Account recovery jobs ──────────────────────────────────────────────────
--
-- The credential revocation a trusted password reset owes, made durable.
-- The row is written in the same transaction as the reset, so a reset can
-- never commit without its revocation; a worker drains it with retry until it
-- succeeds, and credential issuance is refused while a row is outstanding.
-- unblocked_at records when a job that kept failing stopped refusing
-- issuance; its eventual success revokes only credentials created before it.
CREATE TABLE IF NOT EXISTS account_recovery_jobs (
  id              VARCHAR(64) NOT NULL,
  generation      VARCHAR(64) NOT NULL DEFAULT '',
  user_id         VARCHAR(64) NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at VARCHAR(32) DEFAULT NULL,
  last_error      TEXT,
  unblocked_at    VARCHAR(32) DEFAULT NULL,
  created_at      VARCHAR(32) NOT NULL,
  updated_at      VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_account_recovery_jobs_user (user_id),
  KEY ix_account_recovery_jobs_due (status, next_attempt_at),
  CONSTRAINT ck_account_recovery_jobs_status CHECK (status IN ('pending', 'sending')),
  CONSTRAINT fk_account_recovery_jobs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── Access gateway jobs ────────────────────────────────────────────────────
--
-- The gateway half of a targeted grant revocation or an access approval, made
-- durable (issue #651). The row is written in the transaction that claims the
-- decision: a grant moving active to revoked (kind 'revoke'), or a request
-- moving pending to approved (kind 'approve'). It is deleted once the Edge ACL
-- write it owes has landed, or, for an approval, in the transaction that
-- commits the grant. A row a crash or a failed compensation leaves behind is
-- driven to completion by the access gateway worker: a revocation's group
-- comes off, and an approval whose grant never committed has its groups taken
-- back and its request returned to pending.
-- subject_id is the grant (revoke) or the access request (approve); both are
-- UUIDs, so one unique key covers both kinds.
CREATE TABLE IF NOT EXISTS access_gateway_jobs (
  id              VARCHAR(64) NOT NULL,
  generation      VARCHAR(64) NOT NULL DEFAULT '',
  kind            VARCHAR(16) NOT NULL,
  subject_id      VARCHAR(64) NOT NULL,
  api_id          VARCHAR(64) NOT NULL,
  user_id         VARCHAR(64) NOT NULL,
  application_id  VARCHAR(64) DEFAULT NULL,
  requested_by    VARCHAR(64) DEFAULT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at VARCHAR(32) DEFAULT NULL,
  last_error      TEXT,
  created_at      VARCHAR(32) NOT NULL,
  updated_at      VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_access_gateway_jobs_subject (subject_id),
  KEY ix_access_gateway_jobs_due (status, next_attempt_at),
  CONSTRAINT ck_access_gateway_jobs_kind CHECK (kind IN ('revoke', 'approve')),
  CONSTRAINT ck_access_gateway_jobs_status CHECK (status IN ('pending', 'sending')),
  CONSTRAINT fk_access_gateway_jobs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_access_gateway_jobs_requested_by FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
