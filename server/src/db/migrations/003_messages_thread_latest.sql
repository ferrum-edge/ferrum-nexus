-- Ferrum Nexus 003 — newest-message index per thread (SQLite dialect).
--
-- The newest message of a thread is the first row in `(created_at DESC,
-- id DESC)` order. `ix_messages_thread (thread_id, created_at)` leaves the `id`
-- tie-break to a sort, so this replaces it with an index that carries `id` too:
-- the newest-message lookup is then one index seek per thread, and every
-- oldest-first or newest-first read of a thread's history still walks it in
-- order. Index-only, so an upgraded database keeps every row as it was.
CREATE INDEX IF NOT EXISTS ix_messages_thread_latest ON messages (thread_id, created_at, id);
DROP INDEX IF EXISTS ix_messages_thread;
