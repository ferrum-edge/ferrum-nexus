-- Index behind the per-account messaging budget — SQLite dialect.
--
-- `MessageRepo.countBySenderSince` runs on the write path of every posted
-- message, so without this index the abuse control would itself be an abuse
-- vector: a full scan of a table whose whole point is that it grows.
--
-- `(sender_user_id, created_at)` answers "how many did this account post since
-- T" from the index alone. The existing `ix_messages_thread` cannot: it leads
-- with `thread_id`, and the budget spans every thread.

CREATE INDEX IF NOT EXISTS ix_messages_sender
  ON messages (sender_user_id, created_at);
