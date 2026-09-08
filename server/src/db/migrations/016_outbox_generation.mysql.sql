-- Additive, resumable DDL; the matching postcondition is in mysql/migrations.ts.
-- Drain all old application instances before upgrading; see operations.md.
ALTER TABLE email_outbox ADD COLUMN generation VARCHAR(64) NOT NULL DEFAULT '';
