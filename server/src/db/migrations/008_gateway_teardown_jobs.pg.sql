-- Durable gateway-revocation work for disabled accounts.
--
-- Disabling an account commits whether or not Ferrum Edge is reachable, so the
-- data-plane revocation that must follow it cannot be a best-effort side
-- effect: it is a job row, written in the same transaction as
-- `users.status = 'disabled'` and retried by the teardown worker until Edge
-- confirms the consumer has no groups and no credentials left.
--
-- One row per user (`ux_gateway_teardown_jobs_user`): re-disabling an account
-- resets the existing row rather than queueing a second revocation, and
-- re-enabling one deletes it so a retry can never land on a live account.
CREATE TABLE gateway_teardown_jobs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'done')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  -- The admin who asked for the disable; NULL once the row outlives them.
  requested_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT
);

CREATE UNIQUE INDEX ux_gateway_teardown_jobs_user ON gateway_teardown_jobs (user_id);
CREATE INDEX ix_gateway_teardown_jobs_due ON gateway_teardown_jobs (status, next_attempt_at);
