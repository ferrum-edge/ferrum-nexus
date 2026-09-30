-- Ferrum Nexus 004 — identity-provider links (MySQL 8 dialect).
--
-- Mirrors 004_user_identities.sql; see there for what the table records.
-- A single replayable CREATE with its keys and constraints inline, which is
-- the only statement shape the MySQL migration runner applies. `subject` is as
-- wide as OpenID Connect allows a `sub` to be, and the binary collation keeps
-- it case-sensitive, as the specification requires.
CREATE TABLE IF NOT EXISTS user_identities (
  id            VARCHAR(64)  NOT NULL,
  user_id       VARCHAR(64)  NOT NULL,
  provider_id   VARCHAR(64)  NOT NULL,
  subject       VARCHAR(255) NOT NULL,
  email         VARCHAR(320) DEFAULT NULL,
  last_login_at VARCHAR(32)  DEFAULT NULL,
  created_at    VARCHAR(32)  NOT NULL,
  updated_at    VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_user_identities_subject (provider_id, subject),
  UNIQUE KEY ux_user_identities_user_provider (user_id, provider_id),
  CONSTRAINT fk_user_identities_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
