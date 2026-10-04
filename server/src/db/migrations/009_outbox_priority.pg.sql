-- Delivery lanes: low = 0, normal = 1, high = 2. Retained rows default to normal.
ALTER TABLE email_outbox ADD COLUMN priority INTEGER NOT NULL DEFAULT 1;

-- These durable namespaces identify verification and password-reset mail,
-- including sealed messages. Do not infer a template from editable content.
UPDATE email_outbox SET priority = 2
WHERE priority = 1 AND (SUBSTR(idempotency_key, 1, 7) = 'verify:' OR SUBSTR(idempotency_key, 1, 6) = 'reset:');

-- Keep ix_email_outbox_due for due-time filtering and add the claim-order index.
CREATE INDEX ix_email_outbox_priority
ON email_outbox (status, priority DESC, next_attempt_at ASC NULLS FIRST, created_at ASC, id ASC);
