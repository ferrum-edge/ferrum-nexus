-- The credential revocation a trusted password reset owes, made durable.
-- The row is written in the same transaction as the reset, so a reset can
-- never commit without its revocation; a worker drains it with retry until it
-- succeeds, and credential issuance is refused while a row is outstanding.
CREATE TABLE IF NOT EXISTS account_recovery_jobs (
  id              TEXT PRIMARY KEY,
  generation      TEXT NOT NULL DEFAULT '',
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_account_recovery_jobs_user ON account_recovery_jobs (user_id);
CREATE INDEX IF NOT EXISTS ix_account_recovery_jobs_due ON account_recovery_jobs (status, next_attempt_at);