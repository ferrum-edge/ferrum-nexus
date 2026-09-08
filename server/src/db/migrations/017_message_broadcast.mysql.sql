-- Mark the message rows a god-mode broadcast writes — MySQL 8 dialect.
--
-- Mirrors 017_message_broadcast.sql, which carries the full rationale. In
-- short: broadcast rows are written with the acting super admin as the sender,
-- so counting them against that administrator's rolling per-account budget let
-- one announcement disable their ordinary messaging for a day. The flag is what
-- `countBySenderSince` filters them out with; the broadcast path carries its
-- own bounds instead.
--
-- Column and constraint go on in one `ALTER`, so the MySQL DDL-recovery guard
-- in `adapters/mysql/migrations.ts` can treat the pair as a single applied or
-- not-applied step rather than a half-migrated table.

ALTER TABLE messages
  ADD COLUMN broadcast TINYINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_messages_broadcast CHECK (broadcast IN (0, 1));
