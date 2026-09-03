-- How much of an API's OpenAPI document the gateway enforces — SQLite dialect.
--
-- `docs_only` is the historical behaviour and the column default, so every row
-- that predates this migration reads back exactly as it already behaved: the
-- document is catalog metadata and the proxy forwards whatever reaches it.
-- `routes` additionally attaches an `openapi_validator` plugin that rejects a
-- path/method pair the document does not declare.
--
-- Stored as text with a CHECK rather than a boolean because the level is an
-- open-ended enum: a future `validate_requests` is a third value here, not a
-- second flag column. The adapter still falls back to `docs_only` for anything
-- it does not recognise, so a row written by a newer schema cannot make an
-- older binary enforce something it has no code for.

ALTER TABLE apis ADD COLUMN spec_enforcement TEXT NOT NULL DEFAULT 'docs_only'
  CHECK (spec_enforcement IN ('docs_only', 'routes'));
