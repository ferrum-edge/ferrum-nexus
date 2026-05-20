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

Rotate the key with care: encrypted settings stored before the rotation will
no longer be decryptable. Re-enter SMTP and CAPTCHA secrets through the admin
UI after rotation.

## Database

The driver is selected by `NEXUS_DB_DRIVER`. The default is SQLite, which
writes to `./data/nexus.sqlite` (the directory is created on startup).

For PostgreSQL / MySQL / MongoDB, set `NEXUS_DB_URL` to a standard connection
string. Migrations live in `server/src/db/migrations/` and run automatically
at startup.

**MongoDB caveat:** multi-document transactions require a replica set. With a
standalone MongoDB instance Nexus will log a warning at boot and execute
multi-document workflows without atomicity (the same caveat that applies to
Ferrum Edge's own MongoDB support).

## Email

If `NEXUS_SMTP_HOST` is unset the email service logs messages instead of
delivering them — useful for local development. Configure SMTP through the
admin UI to encrypt the password at rest.

The outbox worker polls every five seconds and retries failed messages with
exponential backoff up to five attempts.

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
