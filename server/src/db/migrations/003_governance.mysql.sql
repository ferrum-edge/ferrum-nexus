ALTER TABLE api_assets ADD COLUMN policy_exception_id VARCHAR(64);

CREATE TABLE IF NOT EXISTS pending_publishes (
  id VARCHAR(64) PRIMARY KEY,
  provider_id VARCHAR(64) NOT NULL,
  raw_spec MEDIUMTEXT NOT NULL,
  publish_input JSON NOT NULL,
  exception_request_id VARCHAR(64),
  created_at DATETIME NOT NULL,
  INDEX idx_pending_publishes_provider (provider_id),
  CONSTRAINT fk_pending_publishes_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

CREATE TABLE IF NOT EXISTS policy_exception_requests (
  id VARCHAR(64) PRIMARY KEY,
  api_asset_id VARCHAR(64),
  provider_id VARCHAR(64) NOT NULL,
  pending_publish_id VARCHAR(64),
  violations JSON NOT NULL,
  justification TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  reviewed_by VARCHAR(64),
  reviewed_at DATETIME,
  reviewer_notes TEXT,
  expires_at DATETIME,
  created_at DATETIME NOT NULL,
  INDEX idx_policy_exceptions_status (status),
  INDEX idx_policy_exceptions_provider (provider_id),
  INDEX idx_policy_exceptions_asset (api_asset_id),
  CONSTRAINT fk_policy_exceptions_asset FOREIGN KEY (api_asset_id) REFERENCES api_assets (id) ON DELETE CASCADE,
  CONSTRAINT fk_policy_exceptions_provider FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_policy_exceptions_pending FOREIGN KEY (pending_publish_id) REFERENCES pending_publishes (id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET=utf8mb4;

