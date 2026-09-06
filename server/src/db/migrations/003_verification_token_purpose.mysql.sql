-- MySQL: give every email token a purpose.
--
-- Before this column the table held one kind of token, so a lookup by hash was
-- unambiguous. Password-reset links share the table, and a verification link
-- must never be redeemable as a reset link (or the reverse), so every lookup
-- now carries the purpose it expects. Rows written by 001 are all verification
-- tokens, which is exactly what the default backfills them to.
--
-- MySQL has no ADD COLUMN IF NOT EXISTS. One atomic ALTER keeps the column
-- and index together. The runner validates both definitions before recognizing
-- an interrupted upgrade whose DDL committed without its ledger entry.
ALTER TABLE email_verification_tokens
  ADD COLUMN purpose VARCHAR(32) NOT NULL DEFAULT 'email_verification',
  ADD KEY ix_verification_tokens_user_purpose (user_id, purpose);
