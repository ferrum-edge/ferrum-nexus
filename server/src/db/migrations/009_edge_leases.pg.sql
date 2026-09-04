-- Cross-instance leases over Ferrum Edge resources.
--
-- `PUT /consumers/{id}` and `PUT /proxies/{id}` are whole-resource replaces
-- with no concurrency token, so every Nexus GET-edit-PUT has to be serialised.
-- The in-process queue in `ferrum-admin/client.ts` orders one Node process;
-- this table is what orders *all* of them, so a revoke on one instance can no
-- longer be overwritten by a stale approval on another.
--
-- One row per lock key (a Ferrum consumer id, or `proxy:<id>`) held by exactly
-- one owner until `expires_at`. A crashed holder is not a deadlock: the row is
-- taken over as soon as its expiry passes.
CREATE TABLE edge_leases (
  key        TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ix_edge_leases_expires ON edge_leases (expires_at);
