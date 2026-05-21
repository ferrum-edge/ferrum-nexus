-- MySQL variant. JSON columns are MySQL JSON; booleans are TINYINT(1).

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  email VARCHAR(320) NOT NULL,
  email_normalized VARCHAR(320) NOT NULL UNIQUE,
  name VARCHAR(255),
  phone VARCHAR(64),
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  email_verified_at DATETIME,
  password_hash VARCHAR(512) NOT NULL,
  last_login_at DATETIME,
  failed_login_count INT NOT NULL DEFAULT 0,
  organization_id VARCHAR(64),
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  INDEX idx_users_status (status)
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id VARCHAR(64) NOT NULL,
  role VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (user_id, role),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS organizations (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  domain VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  created_at DATETIME NOT NULL,
  PRIMARY KEY (organization_id, user_id)
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  csrf_token VARCHAR(128) NOT NULL,
  user_agent VARCHAR(512),
  ip VARCHAR(64),
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  INDEX idx_sessions_user (user_id),
  INDEX idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_verifications (
  token VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME,
  CONSTRAINT fk_email_verifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_resets (
  token VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME,
  CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS ferrum_consumers (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64),
  organization_id VARCHAR(64),
  namespace VARCHAR(128) NOT NULL,
  ferrum_consumer_id VARCHAR(128) NOT NULL,
  username VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  acl_groups JSON NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uniq_consumers_user_ns (user_id, namespace),
  INDEX idx_consumers_user (user_id)
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS credential_metadata (
  id VARCHAR(64) PRIMARY KEY,
  consumer_id VARCHAR(64) NOT NULL,
  type VARCHAR(32) NOT NULL,
  label VARCHAR(255) NOT NULL,
  fingerprint VARCHAR(255) NOT NULL,
  last4 VARCHAR(16),
  ferrum_credential_index INT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL,
  rotated_at DATETIME,
  expires_at DATETIME,
  INDEX idx_credentials_consumer (consumer_id),
  CONSTRAINT fk_credential_consumer FOREIGN KEY (consumer_id) REFERENCES ferrum_consumers (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_assets (
  id VARCHAR(64) PRIMARY KEY,
  api_spec_id VARCHAR(64) NOT NULL,
  proxy_id VARCHAR(128) NOT NULL,
  namespace VARCHAR(128) NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  slug VARCHAR(255) NOT NULL UNIQUE,
  version VARCHAR(64) NOT NULL,
  visibility VARCHAR(32) NOT NULL DEFAULT 'private',
  requestable TINYINT(1) NOT NULL DEFAULT 0,
  lifecycle VARCHAR(32) NOT NULL DEFAULT 'draft',
  tags JSON NOT NULL,
  contact_email VARCHAR(320),
  support_notes TEXT,
  operation_count INT NOT NULL DEFAULT 0,
  content_hash VARCHAR(255),
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  INDEX idx_api_assets_visibility (visibility),
  INDEX idx_api_assets_provider (provider_id),
  INDEX idx_api_assets_lifecycle (lifecycle),
  CONSTRAINT fk_api_assets_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_spec_versions (
  id VARCHAR(64) PRIMARY KEY,
  api_asset_id VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  content_hash VARCHAR(255) NOT NULL,
  submitted_by VARCHAR(64) NOT NULL,
  raw_spec MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_spec_versions_asset (api_asset_id),
  CONSTRAINT fk_spec_versions_asset FOREIGN KEY (api_asset_id) REFERENCES api_assets (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS access_requests (
  id VARCHAR(64) PRIMARY KEY,
  api_asset_id VARCHAR(64) NOT NULL,
  client_user_id VARCHAR(64) NOT NULL,
  client_consumer_id VARCHAR(64),
  justification TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  provider_reason TEXT,
  reviewed_by VARCHAR(64),
  created_at DATETIME NOT NULL,
  reviewed_at DATETIME,
  INDEX idx_access_requests_status (status),
  INDEX idx_access_requests_client (client_user_id),
  INDEX idx_access_requests_asset (api_asset_id),
  CONSTRAINT fk_access_requests_asset FOREIGN KEY (api_asset_id) REFERENCES api_assets (id) ON DELETE CASCADE,
  CONSTRAINT fk_access_requests_client FOREIGN KEY (client_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS access_grants (
  id VARCHAR(64) PRIMARY KEY,
  api_asset_id VARCHAR(64) NOT NULL,
  client_user_id VARCHAR(64) NOT NULL,
  client_consumer_id VARCHAR(64) NOT NULL,
  acl_group VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  approved_by VARCHAR(64) NOT NULL,
  approved_at DATETIME NOT NULL,
  revoked_by VARCHAR(64),
  revoked_at DATETIME,
  revoked_reason TEXT,
  INDEX idx_grants_consumer (client_consumer_id),
  INDEX idx_grants_asset (api_asset_id),
  CONSTRAINT fk_grants_asset FOREIGN KEY (api_asset_id) REFERENCES api_assets (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS conversations (
  id VARCHAR(64) PRIMARY KEY,
  api_asset_id VARCHAR(64),
  request_id VARCHAR(64),
  grant_id VARCHAR(64),
  type VARCHAR(32) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  participants JSON NOT NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_conversations_asset (api_asset_id)
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(64) PRIMARY KEY,
  conversation_id VARCHAR(64) NOT NULL,
  sender_id VARCHAR(64) NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  read_by JSON NOT NULL,
  INDEX idx_messages_conversation (conversation_id),
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(64) PRIMARY KEY,
  recipient_id VARCHAR(64) NOT NULL,
  type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  read_at DATETIME,
  created_at DATETIME NOT NULL,
  INDEX idx_notifications_recipient (recipient_id),
  INDEX idx_notifications_unread (recipient_id, read_at),
  CONSTRAINT fk_notifications_recipient FOREIGN KEY (recipient_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_outbox (
  id VARCHAR(64) PRIMARY KEY,
  to_address VARCHAR(320) NOT NULL,
  subject VARCHAR(998) NOT NULL,
  template_id VARCHAR(64),
  payload JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  scheduled_at DATETIME NOT NULL,
  sent_at DATETIME,
  created_at DATETIME NOT NULL,
  idempotency_key VARCHAR(255),
  headers JSON,
  INDEX idx_outbox_status (status, scheduled_at),
  UNIQUE KEY uniq_outbox_idempotency (idempotency_key)
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_templates (
  `key` VARCHAR(64) PRIMARY KEY,
  subject_template TEXT NOT NULL,
  body_template MEDIUMTEXT NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_settings (
  `key` VARCHAR(128) PRIMARY KEY,
  value JSON NOT NULL,
  encrypted TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  actor_id VARCHAR(64),
  actor_email VARCHAR(320),
  action VARCHAR(128) NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(64),
  reason TEXT,
  before JSON,
  after JSON,
  ip VARCHAR(64),
  user_agent VARCHAR(512),
  created_at DATETIME NOT NULL,
  INDEX idx_audit_actor (actor_id),
  INDEX idx_audit_action (action),
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS mass_email_campaigns (
  id VARCHAR(64) PRIMARY KEY,
  created_by VARCHAR(64) NOT NULL,
  recipient_filter JSON NOT NULL,
  subject VARCHAR(998) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  completed_at DATETIME
) ENGINE=InnoDB CHARACTER SET=utf8mb4;
