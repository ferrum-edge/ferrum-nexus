-- Additive, resumable DDL; the matching postcondition is in mysql/migrations.ts.
-- Drain all old application instances before upgrading; see operations.md.
ALTER TABLE gateway_teardown_jobs ADD COLUMN generation VARCHAR(64) NOT NULL DEFAULT '';
