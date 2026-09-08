-- Existing outbox rows acquire an ownership token when next claimed or requeued.
-- Drain all old application instances before upgrading; see operations.md.
ALTER TABLE email_outbox ADD COLUMN generation TEXT NOT NULL DEFAULT '';
