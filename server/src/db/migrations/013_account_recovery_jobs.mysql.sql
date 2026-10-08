-- The credential revocation a trusted password reset owes, made durable.
-- The row is written in the same transaction as the reset, so a reset can
-- never commit without its revocation; a worker drains it with retry until it
-- succeeds, and credential issuance is refused while a row is outstanding.
CREATE TABLE IF NOT EXISTS account_recovery_jobs (
  id              VARCHAR(64) NOT NULL,
  generation      VARCHAR(64) NOT NULL DEFAULT '',
  user_id         VARCHAR(64) NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at VARCHAR(32) DEFAULT NULL,
  last_error      TEXT,
  created_at      VARCHAR(32) NOT NULL,
  updated_at      VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_account_recovery_jobs_user (user_id),
  KEY ix_account_recovery_jobs_due (status, next_attempt_at),
  CONSTRAINT ck_account_recovery_jobs_status CHECK (status IN ('pending', 'sending')),
  CONSTRAINT fk_account_recovery_jobs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;