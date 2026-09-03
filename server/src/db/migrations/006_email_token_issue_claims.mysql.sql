-- Atomic per-account throttle claims for verification and password-reset mail
-- — MySQL 8 dialect.
--
-- One row per (user, purpose) holding the last time a link was issued; the
-- auth service claims the row with INSERT-or-conditional-UPDATE so concurrent
-- requests for one account can mint at most one token per throttle window.
-- Column types mirror `users.id` (VARCHAR(64), utf8mb4_bin) exactly: an
-- InnoDB foreign key refuses columns whose type or collation differ.

CREATE TABLE IF NOT EXISTS email_token_issue_claims (
  user_id   VARCHAR(64) NOT NULL,
  purpose   VARCHAR(32) NOT NULL,
  issued_at VARCHAR(30) NOT NULL,
  PRIMARY KEY (user_id, purpose),
  CONSTRAINT fk_token_issue_claim_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
