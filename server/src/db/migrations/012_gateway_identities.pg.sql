-- Durable ownership of non-canonical gateway identities — PostgreSQL dialect.
--
-- Mirrors 012_gateway_identities.sql, which carries the full rationale. In
-- short: a provider's test consumer is a second Edge identity for the account,
-- and it used to be discoverable by the account teardown only through the
-- credential row written *after* its first append. This table registers the
-- identity before anything exists for it on the gateway, so a disable that
-- lands mid-issuance still finds it.
--
-- One row per identity name per namespace; the consumer id is filled in once
-- Edge has assigned one and may be NULL after a crash between the
-- registration and the create. The teardown resolves the identity by username.
CREATE TABLE gateway_identities (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  namespace          TEXT NOT NULL,
  ferrum_username    TEXT NOT NULL,
  ferrum_consumer_id TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_gateway_identities_username
  ON gateway_identities (namespace, ferrum_username);
CREATE INDEX ix_gateway_identities_user ON gateway_identities (user_id, namespace);
