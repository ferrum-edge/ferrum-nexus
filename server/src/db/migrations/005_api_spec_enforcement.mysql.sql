-- How much of an API's OpenAPI document the gateway enforces — MySQL 8
-- dialect.
--
-- Mirrors 005_api_spec_enforcement.sql. `docs_only` is the column default, so
-- every row published before this migration reads back as the behaviour it
-- already had; `routes` attaches an `openapi_validator` that rejects an
-- undeclared path/method pair. `VARCHAR(32)` with a named CHECK follows 001's
-- treatment of the other enum-valued text columns (`status`, `visibility`,
-- `auth_plugin`).
--
-- One ALTER statement: MySQL has no transactional DDL, so a migration that
-- needed two writes could be left half-applied and fail on the retry.

ALTER TABLE apis
  ADD COLUMN spec_enforcement VARCHAR(32) NOT NULL DEFAULT 'docs_only',
  ADD CONSTRAINT ck_apis_spec_enforcement CHECK (spec_enforcement IN ('docs_only', 'routes'));
