# Operations

## Configuration

All runtime configuration is read from environment variables (see
[`.env.example`](../.env.example)). The only secrets the server will refuse to
start without are `NEXUS_SECRET_KEY`, `FERRUM_ADMIN_URL`, and
`FERRUM_ADMIN_JWT_SECRET`.

`NEXUS_SECRET_KEY` is used to derive HKDF keys for:

- Cookie signing (sessions, CSRF).
- AES-256-GCM encryption of sensitive `app_settings` rows (SMTP password,
  CAPTCHA secret).

### Rotating `NEXUS_SECRET_KEY`

There is no automatic key derivation envelope yet, so rotation is a manual
re-encrypt operation. Plan a maintenance window and follow this order:

1. **Capture the current secrets.** Before changing the key, log in as an
   admin and copy the plaintext values of every encrypted setting (SMTP
   password, CAPTCHA secret) from your password manager / configuration source
   of record. You will re-enter them after rotation.
2. **Stop all Nexus instances.** Sessions are signed with HKDF-derived keys,
   so a mid-flight key swap will invalidate every active session and trigger
   re-logins anyway — easier to do it cleanly while no traffic is in flight.
3. **Generate the new key:** `openssl rand -hex 32`. Update every deployment's
   environment (`NEXUS_SECRET_KEY=<new>`) and the secret store you back up to.
4. **Start one instance and confirm boot.** It will read encrypted
   `app_settings` rows and fail to decrypt them; that is expected. The error
   path falls back to empty (e.g. SMTP appears unconfigured) but the server
   still starts.
5. **Re-enter the secrets via the admin UI** (SMTP, CAPTCHA, anything else
   that lives in `app_settings` with `encrypted=true`). The new writes are
   encrypted under the new key.
6. **Bring the rest of the fleet online.** All sessions are gone; users will
   log in again. The CSRF cookie is regenerated on the next anonymous request.

Back up both old and new keys until step 5 is complete in case you need to
roll back and decrypt the pre-rotation rows.

Set `NEXUS_TRUST_PROXY=true` only when Nexus is behind a trusted reverse proxy
that controls `X-Forwarded-*` headers. Leaving it disabled prevents direct
clients from spoofing audit and rate-limit IP addresses.

## Database

The driver is selected by `NEXUS_DB_DRIVER`. The default is SQLite, which
writes to `./data/nexus.sqlite` (the directory is created on startup).

For PostgreSQL / MySQL / MongoDB, set `NEXUS_DB_URL` to a standard connection
string. Migrations live in `server/src/db/migrations/` and run automatically
at startup.

**MongoDB caveat:** multi-document transactions require a replica set. Nexus
refuses to start against a standalone MongoDB by default — credential
rotation and grant approval rely on transactional guarantees. If you
explicitly accept the risk (development, single-node test deployments) set
`NEXUS_DB_ALLOW_STANDALONE=true`; the server will boot and log a warning,
but the workflows above will not be atomic.

## Email

If `NEXUS_SMTP_HOST` is unset the email service simulates delivery only outside
production, without logging body content. Production treats missing SMTP as a
delivery failure. Configure SMTP through the admin UI to encrypt the password
at rest.

The outbox worker polls every five seconds and retries failed messages with
exponential backoff up to five attempts. After the fifth failure the row
transitions to `status='failed'` and an error-level log line is emitted so
alerting picks it up. Failed messages can be inspected and re-queued through
`GET /api/admin/email/failed` and `POST /api/admin/email/failed/:id/requeue`.

Callers that need at-most-once semantics (mass-email broadcasts, verification
emails) supply an `idempotencyKey` to `EmailService.enqueue`; a second enqueue
with the same key is a no-op courtesy of the unique partial index on
`email_outbox.idempotency_key`.

## Backups

Back up:

1. The Nexus database (single source of truth for portal state).
2. `NEXUS_SECRET_KEY` (without it, encrypted app_settings rows cannot be
   decrypted).
3. Ferrum Edge's database (separate backup story; out of scope here).

## Drift sync

Ferrum Foundry or direct Admin API usage may mutate gateway state outside
Nexus. Admins can detect this via `GET /api/admin/drift` and re-sync metadata
via `POST /api/admin/drift/sync`.

For unmanaged APIs that exist on Edge but not in Nexus, use
`POST /api/admin/imports/api-spec { specId, ownerId, namespace? }` to claim
ownership in the catalog.

## Observability

- Pino structured logs to stdout. In production, `LOG_LEVEL=info` is the
  default; bump to `debug` for request-level details.
- `/api/health` returns the BFF status and probes the Ferrum Edge Admin API.
- Audit logs (`audit_logs` table) capture every security-relevant mutation
  with actor, target, before/after, IP, and user agent.

## Scaling notes

- Sessions live in the configured database and are validated on every
  request. There's no in-process session cache — horizontal scaling works
  without sticky sessions.
- The email worker runs in every instance; idempotency depends on the
  outbox `status = 'pending'` claim. For very high volume, run the worker as
  a single-replica deployment or partition by `id` modulo.
- Heavy mass-email campaigns are processed inline; if you need higher
  throughput, swap the outbox claim for a queue-based processor.
