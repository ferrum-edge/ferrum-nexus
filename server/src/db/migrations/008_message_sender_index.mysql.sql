-- Index behind the per-account messaging budget — MySQL 8 dialect.
--
-- Mirrors 008_message_sender_index.sql. MySQL has no `CREATE INDEX IF NOT
-- EXISTS`, so the index is added through ALTER TABLE and the migration runner's
-- `schema_migrations` bookkeeping is what makes it run exactly once — the same
-- treatment every other MySQL step gets.

ALTER TABLE messages
  ADD INDEX ix_messages_sender (sender_user_id, created_at);
