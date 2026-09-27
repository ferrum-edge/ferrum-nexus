-- Ferrum Nexus 003 — newest-message index per thread (PostgreSQL dialect).
--
-- Mirrors 003_messages_thread_latest.sql; see there for why `id` joins the key.
CREATE INDEX IF NOT EXISTS ix_messages_thread_latest ON messages (thread_id, created_at, id);
DROP INDEX IF EXISTS ix_messages_thread;
