# Operations

Running Ferrum Nexus in production: configuration, databases, containers, TLS,
backups, key rotation, the email outbox, scaling limits, and health checks.

- Architecture background: [`architecture.md`](architecture.md)
- Security posture: [`security.md`](security.md)
- First-run walkthrough: [`getting-started.md`](getting-started.md)

---

## 1. Environment variables

`server/src/config/index.ts` is the **only** reader of `process.env`. It
validates everything with zod at startup and refuses to boot half-configured:
the process prints every offending variable and exits non-zero. The repo-root
[`.env.example`](../.env.example) mirrors this table.

### Required

| Variable                  | Notes                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_SECRET_KEY`        | **Required.** Minimum 32 characters. The master secret; the settings-encryption key and the session-token HMAC key are both HKDF-derived from it. Generate with `openssl rand -hex 32`. |
| `FERRUM_ADMIN_JWT_SECRET` | **Required.** Minimum 32 characters. Must match the gateway's `FERRUM_ADMIN_JWT_SECRET` exactly.                                                                                        |

### Server

| Variable                   | Default                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_ENV`                | inferred from `NODE_ENV`, else `development` | `development` \| `test` \| `production`. `test` forces rate limiting off and quietens the logger.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `NODE_ENV`                 | —                                            | Only consulted when `NEXUS_ENV` is unset, and only `production`/`test` are honoured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `NEXUS_HOST`               | `127.0.0.1`                                  | Bind address. Use `0.0.0.0` in a container.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `NEXUS_PORT`               | `8787`                                       | 0–65535.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `NEXUS_PUBLIC_URL`         | `http://127.0.0.1:5173`                      | Public origin of the portal. Used to build verification links, catalog/credential/thread URLs in email. Must be an absolute URL; a trailing slash is stripped.                                                                                                                                                                                                                                                                                                                                                                                           |
| `NEXUS_TRUSTED_PROXIES`    | _(unset)_                                    | Which proxies may set `X-Forwarded-For`. Unset trusts none: `request.ip` is the socket address, which is what the auth rate limiter and every audit row key on. Accepts an integer hop count counted from the right of the header (`1`), or a comma-separated allowlist of IPs/CIDR blocks (`10.0.0.0/8,192.168.1.7`; `loopback`, `linklocal` and `uniquelocal` are also accepted). An allowlist reaches Fastify's `trustProxy` unchanged; a hop count is compiled into the equivalent predicate, because Fastify maps a bare number to "trust nothing". |
| `NEXUS_TRUST_PROXY`        | `false`                                      | **Deprecated.** `true` is an alias for `NEXUS_TRUSTED_PROXIES=1`. It no longer affects cookies or HSTS — see `NEXUS_COOKIE_SECURE`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `NEXUS_COOKIE_SECURE`      | `true` unless `NEXUS_ENV=development`        | Marks `nexus_session` and `nexus_csrf` `Secure` and turns on HSTS. Set `false` only to serve the portal over plaintext `http://`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `NEXUS_LOG_LEVEL`          | `info`                                       | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `NEXUS_SESSION_TTL`        | `43200` (12 h)                               | Session idle lifetime in seconds; 60 – 2 592 000. Sliding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `NEXUS_RATE_LIMIT_ENABLED` | `true`                                       | Installs the 20 req/min limiter on `/api/auth/*`. Forced off when `NEXUS_ENV=test`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `NEXUS_WEB_DIST`           | _(unset)_                                    | Directory of the built SPA to serve. When unset, the server looks for `../../web/dist` relative to itself and then `./web/dist` under the CWD; if neither has an `index.html`, static serving is disabled and only the API is exposed.                                                                                                                                                                                                                                                                                                                   |

### Database

| Variable                    | Default               | Notes                                                                                    |
| --------------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `NEXUS_DB_DRIVER`           | `sqlite`              | `sqlite` \| `postgres` \| `mysql` \| `mongodb`.                                          |
| `NEXUS_DB_URL`              | _(empty)_             | **Required for every driver except sqlite** — startup fails without it.                  |
| `NEXUS_SQLITE_PATH`         | `./data/nexus.sqlite` | sqlite only. `:memory:` is honoured (tests). The parent directory is created if missing. |
| `NEXUS_DB_ALLOW_STANDALONE` | `false`               | MongoDB only. See [MongoDB](#mongodb) — do not set this in production.                   |

### Ferrum Edge integration

| Variable                           | Default                 | Notes                                                                                                                                                                                                                                     |
| ---------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FERRUM_ADMIN_URL`                 | `http://127.0.0.1:9000` | Base URL of the **Admin** API (not the proxy listener). Must be absolute `http://` or `https://`; a trailing slash is stripped. Plaintext `http://` to a **non-loopback** host is refused unless `FERRUM_ADMIN_ALLOW_INSECURE_HTTP=true`. |
| `FERRUM_ADMIN_JWT_TTL`             | `60`                    | Admin JWT lifetime in seconds, 5 – 3600. Edge caps it at 3600. Short is correct — tokens are minted per call and cached.                                                                                                                  |
| `FERRUM_ADMIN_JWT_ISSUER`          | `ferrum-edge`           | The `iss` claim. **Must equal the gateway's configured issuer** or every call is rejected.                                                                                                                                                |
| `FERRUM_ADMIN_JWT_AUDIENCE`        | _(unset)_               | Only set when the gateway configures an audience. An unexpected `aud` claim is rejected by the gateway, so Nexus omits it entirely by default.                                                                                            |
| `FERRUM_NAMESPACE`                 | `nexus`                 | Namespace Nexus manages, sent as `X-Ferrum-Namespace` on every call. Must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, ≤ 254 chars. Also becomes the first segment of every listen path (`/<namespace>/<slug>`).                                 |
| `FERRUM_ADMIN_CA_FILE`             | _(unset)_               | Path to a PEM CA bundle for a TLS-protected Admin API. An unreadable file fails startup.                                                                                                                                                  |
| `FERRUM_ADMIN_ALLOW_INSECURE_HTTP` | `false`                 | Permits plaintext `http://` Admin URLs on non-loopback hosts. Container-network-only deployments are the intended use.                                                                                                                    |
| `FERRUM_ADMIN_TIMEOUT_MS`          | `5000`                  | Per-request deadline for Admin API calls, 250 – 60 000.                                                                                                                                                                                   |
| `FERRUM_MAX_CREDENTIALS_PER_TYPE`  | `2`                     | 1 – 10. **Mirror of the gateway's own setting** — set them to the same value. Values above 1 are what make append-then-delete rotation gapless.                                                                                           |

#### Set on the gateway, not on Nexus

Two gateway-side variables change what Nexus can successfully publish, so they
belong in the same checklist even though Nexus never reads them:

| Variable (on Ferrum Edge)       | Notes                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FERRUM_ADMIN_JWT_SECRET`       | Must equal Nexus's own value exactly. This shared secret is the whole trust relationship; a mismatch makes every Admin API call `401`.                                                                                                                                                                    |
| `FERRUM_BASIC_AUTH_HMAC_SECRET` | At least 32 bytes. The key the gateway HMACs Basic-auth passwords with. **Required before any `basic_auth` API is published** — without it the gateway refuses to construct the plugin and the publish fails with `EDGE_ERROR`; the gateway's own message is passed through in `details.gateway_message`. |

### Email

All optional; an admin can also configure SMTP from the UI, and the stored
settings **override** these at runtime (see [key rotation](#7-rotating-nexus_secret_key)).

| Variable              | Default                               |
| --------------------- | ------------------------------------- |
| `NEXUS_SMTP_HOST`     | _(unset — mail stays queued)_         |
| `NEXUS_SMTP_PORT`     | `587`                                 |
| `NEXUS_SMTP_SECURE`   | `false`                               |
| `NEXUS_SMTP_USER`     | _(unset)_                             |
| `NEXUS_SMTP_PASSWORD` | _(unset)_                             |
| `NEXUS_EMAIL_FROM`    | `Ferrum Nexus <no-reply@example.com>` |

### Test-only

Not read by `config/index.ts`; consumed directly by the cross-adapter smoke
test: `NEXUS_TEST_POSTGRES_URL`, `NEXUS_TEST_MYSQL_URL`,
`NEXUS_TEST_MONGO_URL`. See [`contributing.md`](contributing.md).

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`. An empty
string is treated as "unset" everywhere, so `FOO=` in an env file means the
default applies.

---

## 2. Databases and migrations

### Migration behaviour

Migrations are **applied automatically at startup**: `main()` calls
`store.init()` then `store.migrate()` before building the server. Running them
is idempotent — applied ids are recorded in a `schema_migrations` table (or
collection) and skipped on the next boot.

For deployments that prefer a separate schema step:

```bash
npm run migrate                      # from the repo root
# or, from a built image:
node server/dist/db/migrate-cli.ts   # (tsx in dev: npx tsx src/db/migrate-cli.ts)
```

Run the **root** script, not `npm run migrate --workspace server`: the server
resolves `@ferrum-nexus/shared` through that workspace's `dist/`, and only the
root script builds it first. On a clean clone the workspace-level script fails
until you have run `npm run build --workspace shared` yourself.

The CLI loads the same env, applies pending migrations, prints
`Migrations applied (driver: postgres).` and exits. It exits non-zero on
failure.

Migration files live in `server/src/db/migrations/` with three dialect
variants: `NNN_name.sql` (SQLite), `NNN_name.pg.sql`, `NNN_name.mysql.sql`.
The id is the `NNN_name` prefix, shared across dialects. The Docker image
copies `server/src/db/migrations` into the runtime stage explicitly, because
`tsc` does not copy `.sql` assets.

### SQLite

Default, and a perfectly reasonable choice for a single-instance portal.

```bash
NEXUS_DB_DRIVER=sqlite
NEXUS_SQLITE_PATH=/var/lib/ferrum-nexus/nexus.sqlite
```

- The parent directory is created on open.
- Pragmas: `foreign_keys = ON`, `busy_timeout = 5000`, and for file-backed
  databases `journal_mode = WAL` + `synchronous = NORMAL`.
- **WAL means three files**: `nexus.sqlite`, `-wal` and `-shm`. Copying only
  the main file while the process is running gives you a torn backup.
- The driver is synchronous; transactions are serialised through an in-process
  queue. Only one process may write. Do not point two Nexus instances at the
  same file, and do not put it on NFS.

### PostgreSQL

```bash
NEXUS_DB_DRIVER=postgres
NEXUS_DB_URL=postgres://nexus:secret@db.internal:5432/nexus
```

- Connection pool: `max: 10`, `idleTimeoutMillis: 30_000`. A transaction holds
  one client for the whole body.
- TLS and other options go in the URL (`?sslmode=require`).
- The pool installs an `error` listener for idle clients dropped by the server;
  without it that becomes an unhandled exception.

### MySQL

```bash
NEXUS_DB_DRIVER=mysql
NEXUS_DB_URL=mysql://nexus:secret@db.internal:3306/nexus
```

- Pool: `connectionLimit: 10`, `waitForConnections: true`.
- `charset: utf8mb4_general_ci`, `multipleStatements: false` (every statement
  is single and parameter-bound), `dateStrings: true`.
- Timestamps are ISO-8601 strings in `VARCHAR` columns, never `DATETIME`, so
  server timezone settings cannot reinterpret them.
- Use a `utf8mb4` database/collation.

### MongoDB

```bash
NEXUS_DB_DRIVER=mongodb
NEXUS_DB_URL=mongodb://mongo-a:27017,mongo-b:27017/nexus?replicaSet=rs0
```

**A replica set (or a sharded cluster) is required.** `init()` probes the
deployment with `hello`; a standalone `mongod` reports no `setName` and no
`isdbgrid`, and Nexus **refuses to start**:

```
MongoDB is running as a standalone server, which cannot execute the
multi-document transactions credential rotation and grant approval depend on.
Deploy a replica set …
```

`NEXUS_DB_ALLOW_STANDALONE=true` overrides that check. It is a
development/evaluation escape hatch, and the caveat is real: with it set,
`transaction()` **degrades to sequential execution**. The body still runs and is
still serialised against other bodies, but there is no atomic commit — a
failure part-way through an approval or a rotation leaves the earlier writes in
place, and you can end up with a grant row whose ACL group was never written
(or vice versa). Do not set it in production.

Collections and indexes are created in code on `init()`; there are no `.sql`
files for Mongo, but the same `schema_migrations` bookkeeping applies.

---

## 3. Docker

### Single container

```bash
docker build -t ferrum-nexus -f docker/Dockerfile .

docker run --rm -p 8787:8787 \
  -e NEXUS_SECRET_KEY="$(openssl rand -hex 32)" \
  -e FERRUM_ADMIN_URL=http://host.docker.internal:9000 \
  -e FERRUM_ADMIN_JWT_SECRET=change-me-at-least-32-characters-long \
  -e NEXUS_PUBLIC_URL=https://portal.example.com \
  -v nexus-data:/app/data \
  ferrum-nexus
```

The image is a two-stage build on `node:22-bookworm-slim`. What it bakes in:

- `NEXUS_HOST=0.0.0.0`, `NEXUS_PORT=8787`
- `NEXUS_SQLITE_PATH=/app/data/nexus.sqlite`, with `/app/data` declared as a
  `VOLUME` — **mount it or your SQLite database dies with the container**
- `NEXUS_WEB_DIST=/app/web/dist`, so the container serves the SPA and the API
  on one origin
- `NODE_ENV=production`, runs as the unprivileged `node` user
- `server/src/db/migrations` copied explicitly (tsc does not copy `.sql`)

There is no `HEALTHCHECK` in the image; wire your orchestrator to
`GET /api/health` (see [§9](#9-health-checks)).

### Compose

[`docker/docker-compose.example.yml`](../docker/docker-compose.example.yml)
brings up Nexus + PostgreSQL + a Ferrum Edge gateway:

```bash
cp docker/docker-compose.example.yml docker-compose.yml
export NEXUS_SECRET_KEY=$(openssl rand -hex 32)
export NEXUS_DB_PASSWORD=$(openssl rand -hex 16)
export FERRUM_ADMIN_JWT_SECRET=$(openssl rand -hex 32)
export FERRUM_BASIC_AUTH_HMAC_SECRET=$(openssl rand -hex 32)
docker compose up -d
```

All four are required — every one of them is declared `${VAR:?...}`, so compose
refuses to start rather than falling back to a shipped default.

Portal on `http://127.0.0.1:8787`, gateway proxy listener on
`http://127.0.0.1:8000`. Points worth understanding before adapting it:

- Both services read `FERRUM_ADMIN_JWT_SECRET` from the **same** shell
  variable. That shared value is the entire trust relationship — if they
  diverge, every Admin API call comes back `401`.
- `FERRUM_NAMESPACE: nexus` is set on both sides.
- `FERRUM_ADMIN_ALLOW_INSECURE_HTTP: 'true'` (and Edge's
  `FERRUM_ALLOW_INSECURE_ADMIN_HTTP`) are acceptable only because the Admin API
  is reachable only on the compose network. Publish the Admin port and that
  stops being true.
- Postgres has a `pg_isready` healthcheck and Nexus waits on it, so the first
  boot's migrations do not race the database. The Postgres password comes from
  `NEXUS_DB_PASSWORD` and is interpolated into both `POSTGRES_PASSWORD` and
  `NEXUS_DB_URL`, so there is one value to rotate and none hard-coded.
- A `ferrum-edge-init` one-shot container `chown`s the `ferrumdata` volume to
  `65532:65532` before the gateway starts, and the gateway `depends_on` it with
  `condition: service_completed_successfully`. The Edge image is distroless
  `nonroot` and ships no `/data`, so without this a fresh named volume is
  root-owned and SQLite cannot create its database file.
- `FERRUM_BASIC_AUTH_HMAC_SECRET` must be set **before** anyone publishes a
  `basic_auth` API — see the gateway env table in [§1](#ferrum-edge-integration).

---

## 4. Running behind TLS and a reverse proxy

Nexus does not terminate TLS. Put it behind nginx / Caddy / an ALB and set:

```bash
NEXUS_TRUSTED_PROXIES=10.0.0.0/8   # or: 1, meaning "one hop"
NEXUS_COOKIE_SECURE=true           # the default outside development
NEXUS_PUBLIC_URL=https://portal.example.com
```

These are two independent decisions, and conflating them is a security bug:

1. `NEXUS_COOKIE_SECURE` adds `Secure` to both `nexus_session` and `nexus_csrf`
   and sends HSTS (`max-age=31536000; includeSubDomains`). It is on by default;
   turn it off only for a plaintext `http://` deployment.
2. `NEXUS_TRUSTED_PROXIES` decides whether `X-Forwarded-For` may set
   `request.ip` — the value that lands in session rows, audit rows, and the
   `/api/auth/*` rate-limit key.

**Name the proxy, or count the hops — never "trust everything".** Proxies
_append_ to `X-Forwarded-For`, so the left-most entry is whatever the client
sent. A configuration that trusts every proxy takes that left-most value, which
lets any client forge the IP in your audit log and rotate past the login rate
limit one header at a time. An allowlist (`10.0.0.0/8`) or a hop count (`1`, if
exactly one proxy sits in front of Nexus) reads the address the proxy itself
recorded. `NEXUS_TRUST_PROXY=true` still works and means `1`, but it is
deprecated.

Serve the SPA and the API on **one origin**. Cookies are `SameSite=Lax` and
there is no CORS configuration; a split-origin deployment will not authenticate.
The simplest arrangement is to let Nexus serve the built SPA itself (set
`NEXUS_WEB_DIST`, or use the Docker image, which does it for you) and proxy the
whole origin to it. Non-`/api` 404s fall back to `index.html` so client-side
routes work on refresh.

A minimal nginx front end:

```nginx
location / {
    proxy_pass         http://127.0.0.1:8787;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

Nexus sets its own security headers via helmet (CSP, `frame-ancestors: none`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`). Do not have the proxy
overwrite them; see [`security.md`](security.md#8-csp-and-response-headers).

---

## 5. Backups

Back up **two** things: the Nexus database and `NEXUS_SECRET_KEY`. A database
restored without its original secret key loses every encrypted setting and
every live session (see [§7](#7-rotating-nexus_secret_key)). Store the key in a
secret manager, not next to the dump.

What is _not_ in the Nexus database: proxies, plugins, consumers and
credentials — those live in Ferrum Edge and need their own backup. A Nexus
restore alone leaves grant rows pointing at consumers that may not exist.

| Driver     | Backup                                                               | Notes                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SQLite     | `sqlite3 nexus.sqlite ".backup '/backups/nexus-$(date +%F).sqlite'"` | Use the `.backup` command or `VACUUM INTO`, never a bare `cp` of a live WAL database. Stopping the service and copying all three files (`.sqlite`, `-wal`, `-shm`) also works. |
| PostgreSQL | `pg_dump --format=custom nexus > nexus.dump`                         | Restore with `pg_restore`. Point-in-time recovery via WAL archiving if you need it.                                                                                            |
| MySQL      | `mysqldump --single-transaction --routines nexus > nexus.sql`        | `--single-transaction` gives a consistent snapshot on InnoDB.                                                                                                                  |
| MongoDB    | `mongodump --uri="$NEXUS_DB_URL" --out /backups/$(date +%F)`         | Restore with `mongorestore`. On a replica set, dump from a secondary to spare the primary.                                                                                     |

Rehearse the restore. Verify afterwards by signing in and opening the admin
settings page: if `smtp.password_set` and `captcha.secret_set` are `true` and
mail still sends, the secret key survived the round trip.

---

## 6. The email outbox

Nothing sends mail inline. `EmailService.enqueue` renders a template and
inserts an `email_outbox` row; the worker polls every 5 seconds and drains it.

### Statuses

| Status    | Meaning                                                                                |
| --------- | -------------------------------------------------------------------------------------- |
| `pending` | Queued and due (or waiting for `next_attempt_at`).                                     |
| `sending` | Claimed by a worker. The claim is atomic and increments `attempts`.                    |
| `sent`    | Delivered.                                                                             |
| `failed`  | Terminal. Delivery failed on attempt 5 (`OUTBOX_MAX_ATTEMPTS`); `last_error` says why. |

Retries back off `30s · 2^attempts`, capped at one hour, plus up to 10% jitter.
A `sending` row untouched for five minutes is assumed to belong to a crashed
worker and is released back to `pending` on the next worker `start()` — i.e. on
the next process boot.

### The quiet failure mode to watch for

**With SMTP unconfigured the worker claims nothing.** The transport factory
returns `null`, the tick is a no-op, and mail accumulates in `pending`
indefinitely rather than burning through five retries and going `failed`. That
is deliberate — it means filling in the SMTP settings later delivers the
backlog instead of losing it — but it means "no mail is arriving" and "no
errors in the log" can be simultaneously true.

### Monitoring

There is no outbox endpoint; query the table.

```sql
-- overall queue health
SELECT status, count(*) FROM email_outbox GROUP BY status;

-- stuck: pending and overdue by more than 10 minutes
SELECT count(*) FROM email_outbox
 WHERE status = 'pending'
   AND (next_attempt_at IS NULL OR next_attempt_at < '2026-08-31T09:00:00.000Z');

-- what is failing
SELECT to_email, attempts, last_error, updated_at
  FROM email_outbox WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 20;
```

Alert on: any growth in `failed`; `pending` older than ~15 minutes; `sending`
older than 5 minutes with no process restart in between.

The worker logs `Outbox message delivery failed, retrying later`,
`Outbox message failed permanently`, `Released stale outbox claims` and
`Outbox tick failed` at `warn`.

To re-drive a `failed` row, set it back to `pending` with `attempts = 0` and
`next_attempt_at = NULL`. Note that a row reinstated this way keeps its
`idempotency_key`, so it will not be duplicated by a re-send from the UI.

SMTP settings are re-read on **every** tick, so an admin fixing them in the UI
takes effect on the next poll with no restart.

---

## 7. Rotating `NEXUS_SECRET_KEY`

`NEXUS_SECRET_KEY` is the master secret. Two independent subkeys are
HKDF-derived from it:

| Subkey                            | HKDF `info`             | Protects                                                                        |
| --------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| Settings encryption (AES-256-GCM) | `nexus-settings-v1`     | `app_settings` rows with `encrypted = 1`: `smtp.password`, `captcha.secret_key` |
| Session token HMAC (HMAC-SHA-256) | `nexus-session-hmac-v1` | `sessions.token_hash`, `email_verification_tokens.token_hash`                   |

Password hashes are scrypt with a per-hash random salt and are **not** derived
from the master key — rotation does not affect sign-in with a password.

### There is no automated re-encryption flow

This is worth stating plainly, because it is the thing an operator most wants
to be untrue. Nexus has **no** re-encrypt command, no dual-key decrypt path,
and no migration that walks `app_settings` under an old key. `readEncryptedSetting`
catches a decryption failure and returns `null` — so after a rotation the
affected settings simply read as _absent_, silently:

- SMTP falls back to the `NEXUS_SMTP_*` environment values. If those do not
  supply a password, authenticated relays start rejecting mail and the outbox
  fills with `failed` rows.
- CAPTCHA **fails closed**: `captcha.verify` throws
  `CAPTCHA_FAILED — "CAPTCHA is enabled but not fully configured"`, so
  registration and login stop working until the secret is re-entered.

Every live session and every unused email-verification token is also
invalidated, because their stored hashes were computed under the old HMAC key.

### Procedure

1. **Announce a short window.** Everyone will be signed out.
2. Note which encrypted settings are in use — check
   `GET /api/admin/settings` and record whether `smtp.password_set` and
   `captcha.secret_set` are `true`. Have the actual SMTP password and CAPTCHA
   secret to hand; Nexus cannot show them to you.
3. Back up the database (see [§5](#5-backups)).
4. Set the new `NEXUS_SECRET_KEY` and restart. Keep the **old** value recorded
   somewhere safe until step 6 succeeds — it is your only rollback.
5. Sign in as an admin (password sign-in is unaffected) and go to
   **Admin → Settings**:
   - re-enter the **SMTP password** and save;
   - re-enter the **CAPTCHA secret key** and save.
     Saving writes fresh AES-256-GCM blobs under the new key. Both fields are
     write-only, so the form shows them as unset until you type a value.
6. Verify: **Send test email** on the settings page returns `ok: true`, and a
   sign-out/sign-in round trip works with CAPTCHA enabled.
7. Optionally clean up the invalidated rows — they are inert, not harmful:

   ```sql
   DELETE FROM sessions;                        -- all invalid anyway
   DELETE FROM email_verification_tokens WHERE used_at IS NULL;
   ```

   Users with an unused verification link will need a new one; the simplest
   remedy is to mark them verified from **Admin → Users**, or have them
   re-register.

8. Watch the outbox for a few minutes: `SELECT status, count(*) FROM email_outbox
GROUP BY status`. Any `failed` rows accumulated during the window can be
   re-driven as described in [§6](#6-the-email-outbox).

To **roll back**, restore the old `NEXUS_SECRET_KEY` — but only if you have not
yet re-saved the settings under the new key. Once re-saved, the blobs are new
and the old key no longer opens them.

### Rotating `FERRUM_ADMIN_JWT_SECRET`

Different problem, simpler shape: it is a shared secret between two processes,
not an encryption key. Change it on the gateway and on Nexus, then restart
both. Between the two restarts every Admin API call fails with
`502 EDGE_ERROR — "The gateway rejected the Nexus admin credentials"`; browsing
the catalog and reading the portal keep working, but publishing, approvals and
credential operations do not. Nothing at rest is affected.

---

## 8. Scaling

### The single-writer constraint

`PUT /consumers/{id}` on the Ferrum Edge Admin API is a whole-resource replace
with **no concurrency token**. Nexus compensates with an in-process
per-consumer promise queue (`edge.serializePerKey`), which every consumer
mutation goes through: ACL-group changes on approve/revoke, credential appends,
credential deletes.

**That queue is per Node process.** Two Nexus instances have two independent
queues, so two operations on the _same consumer_ landing on _different
instances_ at the same time can still lose one — for example, approving a user
for two APIs simultaneously, where one ACL group silently vanishes. The symptom
is nasty: the portal shows an active grant and the gateway returns 403.

Until an external lock exists, the supported topology is:

> **Run exactly one Nexus instance that performs consumer mutations.**

Practical options:

- **One instance.** Simplest, and adequate for a portal — the workload is
  human-paced.
- **Active/passive.** A hot standby that takes over on failure. Only one live
  at a time.
- **Sticky routing by consumer.** If you must run several, route every request
  that can touch a given user's consumer to the same instance. In practice that
  means routing by the _affected_ user, which for an approval is the requester,
  not the caller — awkward, and easy to get wrong.

Everything else scales normally: the catalog, messaging, notifications, the
audit log and the whole read surface are stateless over a shared database.

### Other multi-instance notes

- **The outbox is safe to run on several instances.** The claim is an atomic
  `pending → sending` flip, so no row is delivered twice.
- **Sessions live in the database**, not in memory, so any instance can serve
  any session. No sticky sessions needed for auth.
- **The auth rate limiter is per-process** (`@fastify/rate-limit` with the
  default in-memory store). With N instances the effective limit is N × 20/min.
  Enforce the real limit at the proxy if that matters.
- **The admin-JWT cache is per-process.** Harmless — it just means each
  instance mints its own tokens.
- **SQLite cannot be shared.** Multi-instance means PostgreSQL, MySQL or a
  MongoDB replica set.

### Sizing

Connection pools are 10 per instance for both SQL adapters. A transaction holds
one connection for the whole body and bodies are serialised, so a small pool is
plenty; size the database's `max_connections` at roughly
`10 × instances + headroom`.

---

## 9. Health checks

| Endpoint               | Use for                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `GET /api/health`      | Readiness / liveness. `status` is `ok`, `degraded` or `down`. |
| `GET /api/health/edge` | Gateway reachability only.                                    |

Both are public and unauthenticated.

**Treat `degraded` as healthy for load-balancing purposes.** The overall status
is `down` only when the database probe fails; an unreachable gateway yields
`degraded` with `edge.status: "down"`, and the right response is to keep the
portal in rotation — the catalog, messaging and audit log all still work while
the gateway recovers. Publishing, approvals and credential operations will
return `502 EDGE_UNAVAILABLE` until it comes back.

```bash
curl -sf http://127.0.0.1:8787/api/health | jq '.status, .database.status, .edge.status'
```

A container healthcheck that only fails on a hard `down`:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.json()).then(h=>process.exit(h.status==='down'?1:0)).catch(()=>process.exit(1))"
```

### Logging

Structured JSON (pino) at `NEXUS_LOG_LEVEL`. Unhandled 5xx errors log at
`error` with the URL and the full error; sub-500 responses log at `debug` with
`{ code, status, url }`. The Edge client logs upstream error text at `error`
(`Ferrum Edge Admin API returned an error`) — that text is deliberately **only**
in the log and never in the HTTP response, so this is where you look when a
provider reports an unexplained `EDGE_ERROR`.

### Shutdown

`SIGINT`/`SIGTERM` trigger a graceful shutdown: the outbox poller stops, the
Edge dispatcher closes, Fastify drains, then the store closes. Give the
container at least a few seconds of termination grace.
