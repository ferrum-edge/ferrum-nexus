-- Index behind the per-account messaging budget — MySQL 8 dialect.
--
-- Mirrors 010_message_sender_index.sql. MySQL has no `CREATE INDEX IF NOT
-- EXISTS`, so the index is added through ALTER TABLE. The runner validates its
-- ordered columns and uniqueness when recovering DDL committed before its
-- progress or migration ledger entry.

ALTER TABLE messages
  ADD INDEX ix_messages_sender (sender_user_id, created_at);
