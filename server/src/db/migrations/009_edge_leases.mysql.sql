-- Cross-instance leases over Ferrum Edge resources — MySQL 8 dialect.
--
-- `PUT /consumers/{id}` and `PUT /proxies/{id}` are whole-resource replaces
-- with no concurrency token, so every Nexus GET-edit-PUT has to be serialised.
-- The in-process queue in `ferrum-admin/client.ts` only orders one Node
-- process; this table is what orders *all* of them, so a revoke on one
-- instance can no longer be overwritten by a stale approval on another.
--
-- One row per lock key (a Ferrum consumer id, or `proxy:<id>`) held by exactly
-- one owner until `expires_at`. A crashed holder is not a deadlock: the row is
-- simply taken over once its expiry passes.
--
-- `key` is reserved in MySQL and has to be quoted, exactly as `app_settings`
-- quotes its own. VARCHAR(255) rather than TEXT because InnoDB cannot index a
-- TEXT column without a prefix length, and the primary key is what makes the
-- conditional upsert atomic.

CREATE TABLE IF NOT EXISTS edge_leases (
  `key`      VARCHAR(255) NOT NULL,
  owner      VARCHAR(64)  NOT NULL,
  expires_at VARCHAR(32)  NOT NULL,
  created_at VARCHAR(32)  NOT NULL,
  updated_at VARCHAR(32)  NOT NULL,
  PRIMARY KEY (`key`),
  KEY ix_edge_leases_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
