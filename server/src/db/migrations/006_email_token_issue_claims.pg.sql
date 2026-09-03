-- Atomic per-account throttle claims for verification and password-reset mail.
CREATE TABLE email_token_issue_claims (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  PRIMARY KEY (user_id, purpose)
);
