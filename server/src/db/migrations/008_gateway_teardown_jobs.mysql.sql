-- Durable gateway-revocation work for disabled accounts — MySQL 8 dialect.
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
--
-- `user_id` and `requested_by` mirror `users.id` (VARCHAR(64), utf8mb4_bin)
-- exactly: an InnoDB foreign key refuses columns whose type or collation
-- differ. Indexes are declared inline because MySQL has no
-- `CREATE INDEX IF NOT EXISTS`.
CREATE TABLE IF NOT EXISTS gateway_teardown_jobs (
  id              VARCHAR(64) NOT NULL,
  user_id         VARCHAR(64) NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at VARCHAR(32) DEFAULT NULL,
  last_error      TEXT,
  requested_by    VARCHAR(64) DEFAULT NULL,
  created_at      VARCHAR(32) NOT NULL,
  updated_at      VARCHAR(32) NOT NULL,
  completed_at    VARCHAR(32) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_gateway_teardown_jobs_user (user_id),
  KEY ix_gateway_teardown_jobs_due (status, next_attempt_at),
  CONSTRAINT ck_gateway_teardown_jobs_status CHECK (status IN ('pending', 'sending', 'done')),
  CONSTRAINT fk_gateway_teardown_jobs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_gateway_teardown_jobs_requested_by FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
