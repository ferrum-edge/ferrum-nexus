-- Durable ownership of non-canonical gateway identities — MySQL 8 dialect.
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
--
-- Column types mirror `consumers` exactly, and `user_id` mirrors `users.id`
-- (VARCHAR(64), utf8mb4_bin): an InnoDB foreign key refuses columns whose type
-- or collation differ. Indexes are declared inline because MySQL has no
-- `CREATE INDEX IF NOT EXISTS`.
CREATE TABLE IF NOT EXISTS gateway_identities (
  id                 VARCHAR(64)  NOT NULL,
  user_id            VARCHAR(64)  NOT NULL,
  namespace          VARCHAR(128) NOT NULL,
  ferrum_username    VARCHAR(255) NOT NULL,
  ferrum_consumer_id VARCHAR(128) DEFAULT NULL,
  created_at         VARCHAR(32)  NOT NULL,
  updated_at         VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_gateway_identities_username (namespace, ferrum_username),
  KEY ix_gateway_identities_user (user_id, namespace),
  CONSTRAINT fk_gateway_identities_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
