-- Keep mail bound to the original account after an address is released.
-- Retained legacy rows remain unbound and are cancelled by address on release.
ALTER TABLE email_outbox ADD COLUMN recipient_user_id VARCHAR(36) NULL;
