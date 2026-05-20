# Architecture

Ferrum Nexus is a [BFF (Backend-for-Frontend)](https://samnewman.io/patterns/architectural/bff/)
sitting in front of Ferrum Edge. The BFF owns portal accounts, request and
approval state, audit history, branding, and messaging. The browser never
talks to the Ferrum Edge Admin API directly.

```
Browser
  |
  | HTTPS (same-origin)
  v
Ferrum Nexus SPA (web/)
  |
  | Session cookie + CSRF
  v
Ferrum Nexus BFF (server/)  -->  SMTP / Email provider
  |                          \-> Nexus DB (PG / MySQL / SQLite / Mongo)
  |
  +--> Ferrum Edge Admin API (server-side only, JWT-protected)
```

## Trust boundaries

| Trust zone | What lives here | Notes |
| --- | --- | --- |
| Browser | SPA, public branding, CSRF token cookie | No Admin API tokens; no Ferrum URL. |
| BFF | Sessions, Argon2id password hashes, audit log, Admin API tokens (in memory) | Encrypts SMTP/CAPTCHA secrets at rest. |
| Database | Portal data only — never plaintext credentials, only fingerprints | UUID identifiers across all backends. |
| Ferrum Edge | Proxies, consumers, credentials, plugins | Source of truth for gateway runtime. |

## Module layout

```
server/src/
  config/            Env config loader + zod schema
  lib/               crypto, errors, logger, email helpers
  db/                store abstraction, migrations, adapters
    adapters/sqlite/      Default; bundled with the binary
    adapters/postgres/    sql-repos shared with mysql
    adapters/mysql/       sql-repos shared with postgres
    adapters/mongodb/     One collection per logical table
  ferrum-admin/      Typed wrapper around Ferrum Edge Admin API
  auth/              Sessions + CSRF + CAPTCHA verification
  users/             Registration, login, password reset, roles
  organizations/     Optional multi-user customer accounts
  api-catalog/       Read-side catalog listing
  api-publishing/    OpenAPI validate -> Ferrum spec submit -> portal store
  credentials/       keyauth/basicauth/jwt/hmac/mtls + zero-downtime rotation
  access-requests/   Pending -> approve/deny/revoke flow
  grants/            Active access records
  messaging/         Conversations + messages + announcements
  notifications/     In-app inbox
  email/             Outbox + worker + SMTP transport
  audit/             Append-only audit log
  admin/             Settings, mass email, drift
  drift/             Compare Nexus catalog to Ferrum Edge
  routes/            Fastify route registrations
  middleware/        Cross-cutting: auth resolution + error mapping
  workers/           (DB-backed jobs run alongside the API)
  test/              Smoke tests against in-memory SQLite
```

## Key design decisions

1. **Nexus owns workflow, Edge owns gateway state.** Ferrum Edge cannot
   embed approval workflow because consumers and credentials are explicitly
   rejected from spec submissions. So the Nexus database holds the portal
   model and treats Edge as an authorized downstream system.

2. **One Ferrum consumer per Nexus user per namespace.** This is the unit of
   credentialing and ACL group membership. When a provider approves access,
   Nexus appends `nexus:api:<api_id>:approved` to that consumer's ACL groups.
   When access is revoked, Nexus removes the group. Each requestable API gets
   an `access_control` plugin on its proxy that allows only that group.

3. **Show-once credentials.** Nexus never persists plaintext credentials.
   When a credential is created or rotated, the secret material is returned
   from the API exactly once and only a fingerprint + last4 is stored in the
   `credential_metadata` table.

4. **Append + delete rotation.** Rotation appends a new credential to the
   Edge consumer, leaving the previous one active. After the new credential
   is confirmed working, the user (or scheduler) finalizes the rotation by
   deleting the old credential at its `ferrum_credential_index`.

5. **Outbox-based email.** All transactional email goes through the
   `email_outbox` table with retries and exponential backoff. This avoids
   needing Redis or another job runner in v1.

6. **String UUID identifiers everywhere.** Lets all four database backends
   share the same logical schema with no ID-type conversions in service code.
