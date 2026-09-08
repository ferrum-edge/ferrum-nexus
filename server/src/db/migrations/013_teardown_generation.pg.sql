-- Existing jobs acquire an ownership token when next claimed or requeued.
-- Drain all old application instances before upgrading; see operations.md.
ALTER TABLE gateway_teardown_jobs ADD COLUMN generation TEXT NOT NULL DEFAULT '';
