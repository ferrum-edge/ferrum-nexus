-- The gateway half of a targeted grant revocation or an access approval, made
-- durable (issue #651). The row is written in the transaction that claims the
-- decision: a grant moving active to revoked (kind 'revoke'), or a request
-- moving pending to approved (kind 'approve'). It is deleted once the Edge ACL
-- write it owes has landed, or, for an approval, in the transaction that
-- commits the grant. A row a crash or a failed compensation leaves behind is
-- driven to completion by the access gateway worker: a revocation's group
-- comes off, and an approval whose grant never committed has its groups taken
-- back and its request returned to pending.
-- subject_id is the grant (revoke) or the access request (approve); both are
-- UUIDs, so one unique key covers both kinds.
CREATE TABLE IF NOT EXISTS access_gateway_jobs (
  id              VARCHAR(64) NOT NULL,
  generation      VARCHAR(64) NOT NULL DEFAULT '',
  kind            VARCHAR(16) NOT NULL,
  subject_id      VARCHAR(64) NOT NULL,
  api_id          VARCHAR(64) NOT NULL,
  user_id         VARCHAR(64) NOT NULL,
  application_id  VARCHAR(64) DEFAULT NULL,
  requested_by    VARCHAR(64) DEFAULT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at VARCHAR(32) DEFAULT NULL,
  last_error      TEXT,
  created_at      VARCHAR(32) NOT NULL,
  updated_at      VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_access_gateway_jobs_subject (subject_id),
  KEY ix_access_gateway_jobs_due (status, next_attempt_at),
  CONSTRAINT ck_access_gateway_jobs_kind CHECK (kind IN ('revoke', 'approve')),
  CONSTRAINT ck_access_gateway_jobs_status CHECK (status IN ('pending', 'sending')),
  CONSTRAINT fk_access_gateway_jobs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_access_gateway_jobs_requested_by FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
