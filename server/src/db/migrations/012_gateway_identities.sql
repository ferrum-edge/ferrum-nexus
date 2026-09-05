-- Durable ownership of non-canonical gateway identities — SQLite dialect.
--
-- An account's canonical consumer (`nexus-user-<id>`) is recorded in
-- `consumers`, one row per user per namespace. A provider's test consumer
-- (`nexus-test-<api_id>`) is a *second* Edge identity for the same account,
-- and until now the only record that the account held it was the
-- `credential_metadata` row written once its first credential had been
-- appended. Account teardown enumerated identities from those rows, so a test
-- consumer whose first append was still in flight when the account was
-- disabled was invisible to the teardown: the disable reported `no_consumer`,
-- the append then landed, and the disabled provider kept a live key carrying
-- the API's approval group.
--
-- This table is the registration that closes the gap. A row is written
-- **before** anything is created for the identity on the gateway — inside the
-- account's lifecycle lock, so it is ordered against the status flip that
-- disables the account — and the teardown enumerates it whether or not any
-- credential metadata exists yet.
--
-- One row per identity name per namespace (`ux_gateway_identities_username`):
-- recreating a test consumer, possibly by a different administrator, moves the
-- registration to the new owner rather than duplicating it. The consumer id is
-- recorded once Edge has assigned one and may still be NULL when a process
-- died between the registration and the create; the teardown resolves the
-- identity by its username, which is known before the gateway is touched.
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
