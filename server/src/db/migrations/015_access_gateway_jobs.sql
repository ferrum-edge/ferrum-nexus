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
  id              TEXT PRIMARY KEY,
  generation      TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL CHECK (kind IN ('revoke', 'approve')),
  subject_id      TEXT NOT NULL,
  api_id          TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  application_id  TEXT,
  requested_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_access_gateway_jobs_subject ON access_gateway_jobs (subject_id);
CREATE INDEX IF NOT EXISTS ix_access_gateway_jobs_due ON access_gateway_jobs (status, next_attempt_at);
