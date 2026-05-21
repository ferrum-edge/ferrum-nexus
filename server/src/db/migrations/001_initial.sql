-- Ferrum Nexus initial schema.
-- This SQL targets SQLite syntax. PostgreSQL and MySQL adapters apply
-- equivalent migrations from `001_initial.pg.sql` / `001_initial.mysql.sql`
-- via the same migration runner.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  email_verified_at TEXT,
  password_hash TEXT NOT NULL,
  last_login_at TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  organization_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS email_verifications (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS password_resets (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ferrum_consumers (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  organization_id TEXT,
  namespace TEXT NOT NULL,
  ferrum_consumer_id TEXT NOT NULL,
  username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  acl_groups TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (user_id, namespace)
);

CREATE INDEX IF NOT EXISTS idx_consumers_user ON ferrum_consumers (user_id);

CREATE TABLE IF NOT EXISTS credential_metadata (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  last4 TEXT,
  ferrum_credential_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (consumer_id) REFERENCES ferrum_consumers (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credentials_consumer ON credential_metadata (consumer_id);

CREATE TABLE IF NOT EXISTS api_assets (
  id TEXT PRIMARY KEY,
  api_spec_id TEXT NOT NULL,
  proxy_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  slug TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  requestable INTEGER NOT NULL DEFAULT 0,
  lifecycle TEXT NOT NULL DEFAULT 'draft',
  tags TEXT NOT NULL DEFAULT '[]',
  contact_email TEXT,
  support_notes TEXT,
  operation_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_assets_visibility ON api_assets (visibility);
CREATE INDEX IF NOT EXISTS idx_api_assets_provider ON api_assets (provider_id);
CREATE INDEX IF NOT EXISTS idx_api_assets_lifecycle ON api_assets (lifecycle);

CREATE TABLE IF NOT EXISTS api_spec_versions (
  id TEXT PRIMARY KEY,
  api_asset_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  raw_spec TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (api_asset_id) REFERENCES api_assets (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_spec_versions_asset ON api_spec_versions (api_asset_id);

CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  api_asset_id TEXT NOT NULL,
  client_user_id TEXT NOT NULL,
  client_consumer_id TEXT,
  justification TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_reason TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  FOREIGN KEY (api_asset_id) REFERENCES api_assets (id) ON DELETE CASCADE,
  FOREIGN KEY (client_user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests (status);
CREATE INDEX IF NOT EXISTS idx_access_requests_client ON access_requests (client_user_id);
CREATE INDEX IF NOT EXISTS idx_access_requests_asset ON access_requests (api_asset_id);

CREATE TABLE IF NOT EXISTS access_grants (
  id TEXT PRIMARY KEY,
  api_asset_id TEXT NOT NULL,
  client_user_id TEXT NOT NULL,
  client_consumer_id TEXT NOT NULL,
  acl_group TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_by TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  FOREIGN KEY (api_asset_id) REFERENCES api_assets (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_grants_consumer ON access_grants (client_consumer_id);
CREATE INDEX IF NOT EXISTS idx_grants_asset ON access_grants (api_asset_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  api_asset_id TEXT,
  request_id TEXT,
  grant_id TEXT,
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  participants TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_asset ON conversations (api_asset_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_by TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  read_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (recipient_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications (recipient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (recipient_id, read_at);

CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  template_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  scheduled_at TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  idempotency_key TEXT,
  headers TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON email_outbox (status, scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotency
  ON email_outbox (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_templates (
  key TEXT PRIMARY KEY,
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  reason TEXT,
  before TEXT,
  after TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at);

CREATE TABLE IF NOT EXISTS mass_email_campaigns (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  recipient_filter TEXT NOT NULL DEFAULT '{}',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
