-- Atomic per-account throttle claims for verification and password-reset mail.
CREATE TABLE email_token_issue_claims (
  user_id VARCHAR(36) NOT NULL,
  purpose VARCHAR(32) NOT NULL,
  issued_at VARCHAR(30) NOT NULL,
  PRIMARY KEY (user_id, purpose),
  CONSTRAINT fk_token_issue_claim_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
