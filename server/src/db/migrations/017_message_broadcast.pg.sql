-- Mark the message rows a god-mode broadcast writes — PostgreSQL dialect.
--
-- Mirrors 017_message_broadcast.sql, which carries the full rationale. In
-- short: broadcast rows are written with the acting super admin as the sender,
-- so counting them against that administrator's rolling per-account budget let
-- one announcement disable their ordinary messaging for a day. The flag is what
-- `countBySenderSince` filters them out with; the broadcast path carries its
-- own bounds instead.

ALTER TABLE messages
  ADD COLUMN broadcast SMALLINT NOT NULL DEFAULT 0 CHECK (broadcast IN (0, 1));
