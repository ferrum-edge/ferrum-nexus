-- Ferrum Nexus 006 — identity-provider links and address proofs (MySQL 8 dialect).
--
-- Mirrors 006_user_identities.sql; see there for what the tables record.
-- Replayable CREATEs with their keys and constraints inline, the only
-- statement shape the MySQL migration runner applies. `subject` is as wide as
-- OpenID Connect allows a `sub` to be and `issuer` as wide as the portal
-- accepts one, which keeps the three-column key inside InnoDB's limit; the
-- binary collation keeps both case-sensitive, as the specification requires.
CREATE TABLE IF NOT EXISTS user_identities (
  id            VARCHAR(64)  NOT NULL,
  user_id       VARCHAR(64)  NOT NULL,
  provider_id   VARCHAR(64)  NOT NULL,
  issuer        VARCHAR(255) NOT NULL,
  subject       VARCHAR(255) NOT NULL,
  email         VARCHAR(320) DEFAULT NULL,
  provisioned   TINYINT      NOT NULL DEFAULT 0,
  last_login_at VARCHAR(32)  DEFAULT NULL,
  created_at    VARCHAR(32)  NOT NULL,
  updated_at    VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_user_identities_subject (provider_id, issuer, subject),
  UNIQUE KEY ux_user_identities_user_provider (user_id, provider_id),
  CONSTRAINT ck_user_identities_provisioned CHECK (provisioned IN (0, 1)),
  CONSTRAINT fk_user_identities_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS user_email_proofs (
  user_id    VARCHAR(64)  NOT NULL,
  email      VARCHAR(320) NOT NULL,
  method     VARCHAR(32)  NOT NULL,
  proven_at  VARCHAR(32)  NOT NULL,
  created_at VARCHAR(32)  NOT NULL,
  updated_at VARCHAR(32)  NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT ck_user_email_proofs_method
    CHECK (method IN ('verification_link', 'password_reset', 'identity_provider')),
  CONSTRAINT fk_user_email_proofs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
