-- A real write orders account-bound mail with address release.
-- Kept internal: it neither changes the account nor enters the user DTO.
ALTER TABLE users ADD COLUMN email_lifecycle_fence VARCHAR(36) NOT NULL DEFAULT '';
