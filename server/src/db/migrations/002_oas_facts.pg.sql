ALTER TABLE api_assets ADD COLUMN proxy_hosts JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE api_assets ADD COLUMN proxy_paths JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE api_assets ADD COLUMN proxy_upstream_url TEXT;
ALTER TABLE api_assets ADD COLUMN timeout_connect_ms INTEGER;
ALTER TABLE api_assets ADD COLUMN timeout_read_ms INTEGER;
ALTER TABLE api_assets ADD COLUMN timeout_write_ms INTEGER;
ALTER TABLE api_assets ADD COLUMN body_size_limit_bytes INTEGER;
ALTER TABLE api_assets ADD COLUMN rate_limit_per_minute INTEGER;
ALTER TABLE api_assets ADD COLUMN operation_paths JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE api_assets ADD COLUMN operation_summaries JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE api_assets ADD COLUMN source_format TEXT NOT NULL DEFAULT 'openapi3';

