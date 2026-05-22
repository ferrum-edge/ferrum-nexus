ALTER TABLE api_assets ADD COLUMN policy_exception_id TEXT;

CREATE TABLE IF NOT EXISTS pending_publishes (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  raw_spec TEXT NOT NULL,
  publish_input TEXT NOT NULL,
  exception_request_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS policy_exception_requests (
  id TEXT PRIMARY KEY,
  api_asset_id TEXT,
  provider_id TEXT NOT NULL,
  pending_publish_id TEXT,
  violations TEXT NOT NULL,
  justification TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TEXT,
  reviewer_notes TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (api_asset_id) REFERENCES api_assets (id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (pending_publish_id) REFERENCES pending_publishes (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_policy_exceptions_status ON policy_exception_requests (status);
CREATE INDEX IF NOT EXISTS idx_policy_exceptions_provider ON policy_exception_requests (provider_id);
CREATE INDEX IF NOT EXISTS idx_policy_exceptions_asset ON policy_exception_requests (api_asset_id);
CREATE INDEX IF NOT EXISTS idx_pending_publishes_provider ON pending_publishes (provider_id);

