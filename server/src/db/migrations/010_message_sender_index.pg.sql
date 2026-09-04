-- Index behind the per-account messaging budget — PostgreSQL dialect.
--
-- Mirrors 010_message_sender_index.sql. `countBySenderSince` runs on the write
-- path of every posted message; `(sender_user_id, created_at)` keeps that count
-- an index range scan rather than a sequential scan of `messages`.

CREATE INDEX IF NOT EXISTS ix_messages_sender
  ON messages (sender_user_id, created_at);
