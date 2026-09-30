-- Ferrum Nexus 006 — identity-provider links and address proofs (SQLite dialect).
--
-- `user_identities`: one row per portal account linked to one subject (`sub`)
-- at one OpenID Connect provider. A returning single sign-on is matched on
-- `(provider_id, issuer, subject)`, never on the email address, so the first
-- unique key is what decides whose account a sign-in opens — and a provider
-- id reused for another issuer matches none of the old links. The second keeps
-- an account to one identity per provider. `provisioned` marks the identity
-- that created the account, which then has no local password to fall back on.
--
-- `user_email_proofs`: evidence that an account's holder controls its address
-- — a redeemed verification link, a completed password reset, or a provider
-- that asserted the address verified. `users.email_verified` alone is not
-- evidence: with verification off a registration is marked verified without
-- any. Only a proof for the account's current address allows single sign-on
-- to link to it; accounts that predate this table have none.
--
-- A forward migration that only adds tables, so an upgraded database keeps
-- every row as it was (docs/operations.md, "Schema versioning and upgrades").
CREATE TABLE IF NOT EXISTS user_identities (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id   TEXT NOT NULL,
  issuer        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  email         TEXT,
  provisioned   INTEGER NOT NULL DEFAULT 0 CHECK (provisioned IN (0, 1)),
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CONSTRAINT ux_user_identities_subject UNIQUE (provider_id, issuer, subject),
  CONSTRAINT ux_user_identities_user_provider UNIQUE (user_id, provider_id)
);

CREATE TABLE IF NOT EXISTS user_email_proofs (
  user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  method     TEXT NOT NULL
               CHECK (method IN ('verification_link', 'password_reset', 'identity_provider')),
  proven_at  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
