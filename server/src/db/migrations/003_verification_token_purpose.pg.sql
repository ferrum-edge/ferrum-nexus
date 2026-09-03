-- PostgreSQL: give every email token a purpose.
--
-- Before this column the table held one kind of token, so a lookup by hash was
-- unambiguous. Password-reset links share the table, and a verification link
-- must never be redeemable as a reset link (or the reverse), so every lookup
-- now carries the purpose it expects. Rows written by 001 are all verification
-- tokens, which is exactly what the default backfills them to.

ALTER TABLE email_verification_tokens
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'email_verification';

CREATE INDEX IF NOT EXISTS ix_verification_tokens_user_purpose
  ON email_verification_tokens (user_id, purpose);
