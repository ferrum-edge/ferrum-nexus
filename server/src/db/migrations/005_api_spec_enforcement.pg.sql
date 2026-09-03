-- How much of an API's OpenAPI document the gateway enforces — PostgreSQL
-- dialect.
--
-- Mirrors 005_api_spec_enforcement.sql column for column. `docs_only` is the
-- column default, so every row published before this migration reads back as
-- the behaviour it already had; `routes` attaches an `openapi_validator` that
-- rejects an undeclared path/method pair.

ALTER TABLE apis ADD COLUMN IF NOT EXISTS spec_enforcement TEXT NOT NULL DEFAULT 'docs_only'
  CHECK (spec_enforcement IN ('docs_only', 'routes'));
