-- MySQL: give every email token a purpose.
--
-- Before this column the table held one kind of token, so a lookup by hash was
-- unambiguous. Password-reset links share the table, and a verification link
-- must never be redeemable as a reset link (or the reverse), so every lookup
-- now carries the purpose it expects. Rows written by 001 are all verification
-- tokens, which is exactly what the default backfills them to.
--
-- MySQL has no `IF NOT EXISTS` for either statement; the migration runner only
-- calls this once per database, which is what makes that safe.

-- One ALTER, not two: MySQL DDL is not transactional, so a column added by a
-- first statement whose index statement then failed would leave the migration
-- pending and unable to re-run. A single statement either applies or does not.
ALTER TABLE email_verification_tokens
  ADD COLUMN purpose VARCHAR(32) NOT NULL DEFAULT 'email_verification',
  ADD KEY ix_verification_tokens_user_purpose (user_id, purpose);
