-- Mark the message rows a god-mode broadcast writes — SQLite dialect.
--
-- `GodService.broadcast` writes one `messages` row per recipient with the
-- acting super admin as the sender, and the rolling per-account message budget
-- counts rows by sender. One broadcast to a portal larger than the budget
-- therefore spent the whole of that administrator's own allowance, so every
-- ordinary message they sent for the next 24 hours was refused — including the
-- support follow-up an incident broadcast tends to generate — while further
-- broadcasts, which were never budget-checked at all, stayed available.
--
-- Broadcast rows carry `broadcast = 1` and `countBySenderSince` skips them. The
-- broadcast path is bounded on its own terms instead, before any row is
-- written: `NEXUS_MAX_BROADCAST_RECIPIENTS` caps one announcement's audience
-- and `NEXUS_MAX_BROADCASTS_PER_DAY` caps how many an administrator may send.
--
-- Existing rows default to 0. That is the honest reading of history: nothing
-- recorded which of them a broadcast wrote, and treating a past broadcast as an
-- ordinary message only over-counts a window that ages out within a day.

ALTER TABLE messages ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0 CHECK (broadcast IN (0, 1));
