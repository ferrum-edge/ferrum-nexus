ALTER TABLE api_assets ADD COLUMN policy_exception_id TEXT;

CREATE TABLE IF NOT EXISTS pending_publishes (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  raw_spec TEXT NOT NULL,
  publish_input JSONB NOT NULL,
  exception_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_exception_requests (
  id TEXT PRIMARY KEY,
  api_asset_id TEXT REFERENCES api_assets (id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  pending_publish_id TEXT REFERENCES pending_publishes (id) ON DELETE CASCADE,
  violations JSONB NOT NULL,
  justification TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewer_notes TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policy_exceptions_status ON policy_exception_requests (status);
CREATE INDEX IF NOT EXISTS idx_policy_exceptions_provider ON policy_exception_requests (provider_id);
CREATE INDEX IF NOT EXISTS idx_policy_exceptions_asset ON policy_exception_requests (api_asset_id);
CREATE INDEX IF NOT EXISTS idx_pending_publishes_provider ON pending_publishes (provider_id);

