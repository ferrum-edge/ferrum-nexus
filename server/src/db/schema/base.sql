-- Ferrum Nexus base schema — SQLite dialect.
--
-- Until Ferrum Nexus 1.0 this file is the whole schema: there are no
-- migrations and no upgrade path between releases. Change the schema by
-- editing this file (and its other dialect variants) directly. A database
-- created by an earlier version of the schema is refused at startup, never
-- migrated, and must be recreated (server/src/db/schema.ts; docs/operations.md,
-- "Schema and upgrades before 1.0").
--
-- Conventions shared by every dialect variant of this schema:
--   * every id is a TEXT string UUID;
--   * every timestamp is a TEXT ISO-8601 string (UTC, millisecond precision);
--   * booleans are INTEGER 0/1 and are converted at the adapter boundary;
--   * structured values live in `*_json` TEXT columns holding JSON text.
--
-- The `.pg.sql` and `.mysql.sql` variants must keep the same table names,
-- column names, uniqueness guarantees and index coverage.

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
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  last_login_at  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  email_lifecycle_fence TEXT NOT NULL DEFAULT ''
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
  id                   TEXT PRIMARY KEY,
  upstream_url         TEXT,
  cors_json            TEXT,
  allowed_methods_json TEXT,
  timeouts_json        TEXT,
  circuit_breaker      INTEGER NOT NULL DEFAULT 0 CHECK (circuit_breaker IN (0, 1)),
  spec_enforcement     TEXT NOT NULL DEFAULT 'docs_only' CHECK (spec_enforcement IN ('docs_only', 'routes')),
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL,
  description          TEXT,
  owner_user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  ferrum_proxy_id      TEXT,
  namespace            TEXT NOT NULL,
  version              TEXT NOT NULL,
  spec_format          TEXT NOT NULL DEFAULT 'openapi' CHECK (spec_format IN ('openapi')),
  requestable          INTEGER NOT NULL DEFAULT 0 CHECK (requestable IN (0, 1)),
  auth_plugin          TEXT NOT NULL CHECK (auth_plugin IN ('key_auth', 'basic_auth', 'jwt_auth')),
  rate_limit_json      TEXT,
  status               TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'retired')),
  -- `internal` is *unlisted*: kept out of the browse view, readable by anyone
  -- holding the link. `private` is *permission enforced*: invisible and
  -- unopenable unless the viewer is the owner, an admin, an approved client,
  -- or someone the provider explicitly authorized in `api_viewers`. The two
  -- are deliberately separate values so adding the second does not silently
  -- change what the first already means for existing APIs (issue #288).
  visibility           TEXT NOT NULL DEFAULT 'public'
                         CHECK (visibility IN ('public', 'internal', 'private')),
  -- Whether the gateway is believed to be serving this API. Written
  -- `repair_required` only when the portal has established that it is not, and
  -- cleared only by a successful restore — never derived from
  -- `ferrum_proxy_id`, which a repair clears for a live orphan and a restore
  -- refills (issue #284).
  gateway_state        TEXT NOT NULL DEFAULT 'deployed'
                         CHECK (gateway_state IN ('deployed', 'repair_required')),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  agents_json          TEXT DEFAULT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_apis_slug ON apis (lower(slug));
CREATE UNIQUE INDEX IF NOT EXISTS ux_apis_proxy_id ON apis (ferrum_proxy_id)
  WHERE ferrum_proxy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_apis_owner ON apis (owner_user_id);
CREATE INDEX IF NOT EXISTS ix_apis_status_visibility ON apis (status, visibility);
CREATE INDEX IF NOT EXISTS ix_apis_created_at ON apis (created_at);
-- Reconciliation counts the unrestored deployments on every pass.
CREATE INDEX IF NOT EXISTS ix_apis_gateway_state ON apis (namespace, gateway_state);

-- ── Applications (per-integration identities) ──────────────────────────────
--
-- A developer running several integrations needs each one approved for its own
-- set of APIs — least privilege between their own systems, not just between
-- accounts. An application is that boundary: it is owned by a portal account,
-- it carries its own access requests, grants and credentials, and it gets its
-- own Ferrum consumer (`nexus-app-<application_id>`) so the separation is
-- enforced in Edge's identity/ACL mapping rather than in a credential label
-- (issue #289).
--
-- Account-scoped access is unchanged and is still the default: every row that
-- can be scoped carries a nullable `application_id`, and `NULL` means "the
-- account itself", exactly as before this table existed. Nothing migrates on
-- its own.
CREATE TABLE IF NOT EXISTS applications (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  -- `disabled` keeps the rows and the gateway identity but refuses new
  -- requests, approvals and credentials; deleting the application is the
  -- destructive option and takes its consumer with it.
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_applications_owner_name
  ON applications (owner_user_id, lower(name));
CREATE INDEX IF NOT EXISTS ix_applications_owner ON applications (owner_user_id, created_at);

-- ── API viewers (private documentation access) ─────────────────────────────
--
-- Who a provider has authorized to *read* a private API's catalog entry and
-- specification. Deliberately not a grant: it confers no ACL group, touches no
-- consumer and reaches no gateway. Being able to read the documentation and
-- being able to call the API are two different permissions, and conflating
-- them is how a "share the docs" click becomes an authorization bug.
CREATE TABLE IF NOT EXISTS api_viewers (
  id         TEXT PRIMARY KEY,
  api_id     TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The provider or admin who authorized them; NULL once that account is gone.
  granted_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_api_viewers_api_user ON api_viewers (api_id, user_id);
-- Every catalog read resolves "which private APIs may this account see?".
CREATE INDEX IF NOT EXISTS ix_api_viewers_user ON api_viewers (user_id);
CREATE INDEX IF NOT EXISTS ix_api_viewers_api ON api_viewers (api_id, created_at);

-- ── API specs ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_specs (
  id             TEXT PRIMARY KEY,
  api_id         TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  version        TEXT NOT NULL,
  raw_spec       TEXT NOT NULL,
  parsed_title   TEXT,
  parsed_version TEXT,
  is_current     INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  revision_seq   INTEGER NOT NULL,
  -- Who published this revision. `ON DELETE SET NULL` rather than RESTRICT: a
  -- revision outlives the account that uploaded it, and history that could
  -- block a user deletion would be history nobody keeps. Rows written before
  -- the column existed, and rows whose author has since been removed, read
  -- back `null` — which the history view renders as an unknown author rather
  -- than attributing them to somebody.
  created_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  -- What this revision was restoring, when it was published by a rollback.
  -- `ON DELETE SET NULL` because retention deletes the target long before the
  -- rollback that restored it: the link is provenance, not a dependency.
  rolled_back_from_id TEXT REFERENCES api_specs (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- At most one current revision per API.
CREATE UNIQUE INDEX IF NOT EXISTS ux_api_specs_current ON api_specs (api_id)
  WHERE is_current = 1;
-- Publication order, and the index every `api_id` lookup uses. `created_at`
-- has millisecond resolution and ids are random UUIDs, so two revisions
-- published in the same millisecond had no stable order and bounded retention
-- discarded the newer one (issue #270). The per-API sequence is that order;
-- the uniqueness is what stops two writers claiming one position.
CREATE UNIQUE INDEX IF NOT EXISTS ux_api_specs_seq ON api_specs (api_id, revision_seq);

-- ── Access requests ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_requests (
  id            TEXT PRIMARY KEY,
  api_id        TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The application this access is for, or NULL for the account itself.
  application_id TEXT REFERENCES applications (id) ON DELETE CASCADE,
  justification TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'denied', 'revoked', 'cancelled')),
  decided_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  decided_at    TEXT,
  decision_note TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  requested_tools_json TEXT DEFAULT NULL,
  approved_tools_json  TEXT DEFAULT NULL,
  grant_id      TEXT NULL
);

-- One open request per API and identity. `COALESCE` is what keeps the
-- account-scoped case unique: SQL treats NULLs as distinct, so a bare
-- three-column index would let one account open any number of identical
-- account-scoped requests.
CREATE UNIQUE INDEX IF NOT EXISTS ux_access_requests_pending
  ON access_requests (api_id, user_id, COALESCE(application_id, ''))
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_access_requests_application
  ON access_requests (application_id, status);
CREATE INDEX IF NOT EXISTS ix_access_requests_api_status ON access_requests (api_id, status);
CREATE INDEX IF NOT EXISTS ix_access_requests_user ON access_requests (user_id, created_at);

-- ── Grants ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grants (
  id                TEXT PRIMARY KEY,
  api_id            TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The identity this grant belongs to: an application, or NULL for the
  -- account. It decides which Ferrum consumer carries the ACL group, which is
  -- what makes two applications of one owner genuinely separate.
  application_id    TEXT REFERENCES applications (id) ON DELETE CASCADE,
  access_request_id TEXT REFERENCES access_requests (id) ON DELETE SET NULL,
  acl_group         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_by        TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  revoked_by        TEXT REFERENCES users (id) ON DELETE SET NULL,
  revoked_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  approved_tools_json TEXT DEFAULT NULL
);

-- At most one active grant per API and identity; see the note on
-- `ux_access_requests_pending` for why `COALESCE` is there.
CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_active
  ON grants (api_id, user_id, COALESCE(application_id, ''))
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_grants_application ON grants (application_id, status);
CREATE INDEX IF NOT EXISTS ix_grants_user_status ON grants (user_id, status);
CREATE INDEX IF NOT EXISTS ix_grants_api_status ON grants (api_id, status);

-- ── Consumers (Edge mapping cache) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumers (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The application whose identity this consumer is, or NULL for the
  -- account's canonical `nexus-user-<user_id>` consumer. `user_id` is the
  -- owner either way, so every teardown and repair that walks an account's
  -- consumers finds its applications' too.
  application_id     TEXT REFERENCES applications (id) ON DELETE CASCADE,
  namespace          TEXT NOT NULL,
  ferrum_consumer_id TEXT NOT NULL,
  ferrum_username    TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_consumers_user_namespace
  ON consumers (user_id, namespace, COALESCE(application_id, ''));
CREATE INDEX IF NOT EXISTS ix_consumers_application ON consumers (application_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_consumers_ferrum_id ON consumers (namespace, ferrum_consumer_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_consumers_username ON consumers (namespace, ferrum_username);

-- ── Credential metadata (show-once: fingerprint + last4 only) ──────────────
CREATE TABLE IF NOT EXISTS credential_metadata (
  id                   TEXT PRIMARY KEY,
  edge_ordinal         INTEGER,
  user_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The application this credential authenticates as, or NULL for the
  -- account. Descriptive, unlike `label`: it names the identity the material
  -- was appended to, and rotation and revocation follow it.
  application_id       TEXT REFERENCES applications (id) ON DELETE CASCADE,
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

CREATE UNIQUE INDEX IF NOT EXISTS ux_credentials_ordinal
  ON credential_metadata (ferrum_consumer_id, credential_type, edge_ordinal);

CREATE UNIQUE INDEX IF NOT EXISTS ux_credentials_fingerprint ON credential_metadata (fingerprint);
CREATE INDEX IF NOT EXISTS ix_credentials_user_status ON credential_metadata (user_id, status);
CREATE INDEX IF NOT EXISTS ix_credentials_application
  ON credential_metadata (application_id, status);
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
  broadcast      INTEGER NOT NULL DEFAULT 0 CHECK (broadcast IN (0, 1)),
  thread_id      TEXT NOT NULL REFERENCES message_threads (id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_messages_sender
  ON messages (sender_user_id, created_at);

-- The newest message of a thread is the first row in `(created_at DESC, id DESC)`
-- order; carrying `id` makes that lookup one index seek per thread, and every
-- oldest-first or newest-first read of a thread walks the same index.
CREATE INDEX IF NOT EXISTS ix_messages_thread_latest ON messages (thread_id, created_at, id);

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
  generation      TEXT NOT NULL DEFAULT '',
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
  updated_at      TEXT NOT NULL,
  recipient_user_id TEXT NULL,
  priority        INTEGER NOT NULL DEFAULT 1
);

-- At-most-once semantics for keyed sends (verification, mass email).
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_outbox_idempotency ON email_outbox (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_email_outbox_due ON email_outbox (status, next_attempt_at);
-- Claim order; ix_email_outbox_due stays for due-time filtering.
CREATE INDEX IF NOT EXISTS ix_email_outbox_priority
  ON email_outbox (status, priority DESC, next_attempt_at ASC, created_at ASC, id ASC);

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
  encrypted  INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1)),
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
  purpose    TEXT NOT NULL DEFAULT 'email_verification',
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_verification_tokens_user_purpose
  ON email_verification_tokens (user_id, purpose);

CREATE UNIQUE INDEX IF NOT EXISTS ux_verification_tokens_hash
  ON email_verification_tokens (token_hash);
CREATE INDEX IF NOT EXISTS ix_verification_tokens_user ON email_verification_tokens (user_id);
CREATE INDEX IF NOT EXISTS ix_verification_tokens_expires
  ON email_verification_tokens (expires_at);

-- ── Email token issue claims ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_token_issue_claims (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose   TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  PRIMARY KEY (user_id, purpose)
);

-- ── API palette plugins ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_plugins (
  id                      TEXT PRIMARY KEY,
  ferrum_plugin_config_id TEXT,
  api_id                  TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  plugin_name             TEXT NOT NULL,
  enabled                 INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json             TEXT NOT NULL,
  trigger_json            TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_api_plugins_api_name
  ON api_plugins (api_id, plugin_name);
CREATE INDEX IF NOT EXISTS ix_api_plugins_api ON api_plugins (api_id, created_at);

-- ── Gateway teardown jobs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gateway_teardown_jobs (
  id              TEXT PRIMARY KEY,
  generation      TEXT NOT NULL DEFAULT '',
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'done')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  -- The admin who asked for the disable; NULL once the row outlives them.
  requested_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_gateway_teardown_jobs_user ON gateway_teardown_jobs (user_id);
CREATE INDEX IF NOT EXISTS ix_gateway_teardown_jobs_due ON gateway_teardown_jobs (status, next_attempt_at);

-- ── Edge leases ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS edge_leases (
  key        TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_edge_leases_expires ON edge_leases (expires_at);

-- ── Gateway identities ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gateway_identities (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  namespace          TEXT NOT NULL,
  ferrum_username    TEXT NOT NULL,
  ferrum_consumer_id TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_gateway_identities_username
  ON gateway_identities (namespace, ferrum_username);
CREATE INDEX IF NOT EXISTS ix_gateway_identities_user ON gateway_identities (user_id, namespace);

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
  api_id                  TEXT NOT NULL REFERENCES apis (id) ON DELETE CASCADE,
  role                    TEXT NOT NULL
                            CHECK (role IN ('auth', 'access_control', 'rate_limit', 'cors')),
  ferrum_plugin_config_id TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (api_id, role)
);

-- ── API specification changes ──────────────────────────────────────────────
--
-- One row per revision that replaced another (an upload or a rollback), holding
-- the consumer-facing comparison of the two documents as JSON. It is kept
-- apart from `api_specs` so that it outlives the documents
-- `NEXUS_SPEC_HISTORY_LIMIT` prunes, which is why `spec_id` and
-- `previous_spec_id` are plain references rather than foreign keys. Retention
-- is bounded separately, by `SPEC_CHANGE_HISTORY_LIMIT` rows per API.
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

-- ── Notification preferences ───────────────────────────────────────────────
--
-- One row per account that has changed a preference; an account without one
-- gets each notice's default, which is what each column defaults to. The first
-- preferences are the spec-change notice's two channels (issue #447): in-app,
-- on by default, and email, off until the account turns it on.
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id                 TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  api_spec_updated_in_app INTEGER NOT NULL DEFAULT 1 CHECK (api_spec_updated_in_app IN (0, 1)),
  api_spec_updated_email  INTEGER NOT NULL DEFAULT 0 CHECK (api_spec_updated_email IN (0, 1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

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
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id   TEXT NOT NULL,
  issuer        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  email         TEXT,
  provisioned   INTEGER NOT NULL DEFAULT 0 CHECK (provisioned IN (0, 1)),
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

-- ── Account recovery jobs ──────────────────────────────────────────────────
--
-- The credential revocation a trusted password reset owes, made durable.
-- The row is written in the same transaction as the reset, so a reset can
-- never commit without its revocation; a worker drains it with retry until it
-- succeeds, and credential issuance is refused while a row is outstanding.
-- unblocked_at records when a job that kept failing stopped refusing
-- issuance; its eventual success revokes only credentials created before it.
CREATE TABLE IF NOT EXISTS account_recovery_jobs (
  id              TEXT PRIMARY KEY,
  generation      TEXT NOT NULL DEFAULT '',
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  unblocked_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_account_recovery_jobs_user ON account_recovery_jobs (user_id);
CREATE INDEX IF NOT EXISTS ix_account_recovery_jobs_due ON account_recovery_jobs (status, next_attempt_at);

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
  id              TEXT PRIMARY KEY,
  generation      TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL CHECK (kind IN ('revoke', 'approve')),
  subject_id      TEXT NOT NULL,
  api_id          TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  application_id  TEXT,
  requested_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_access_gateway_jobs_subject ON access_gateway_jobs (subject_id);
CREATE INDEX IF NOT EXISTS ix_access_gateway_jobs_due ON access_gateway_jobs (status, next_attempt_at);
