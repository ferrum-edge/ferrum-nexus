# Nexus REST API reference

Every endpoint the Ferrum Nexus backend exposes. All of them live under `/api`,
speak JSON, and authenticate with cookies. This is the contract the SPA in
`web/src/lib/api.ts` is written against; the wire types are in
[`shared/src/api-contract.ts`](../shared/src/api-contract.ts) and
[`shared/src/entities.ts`](../shared/src/entities.ts).

Endpoints are grouped in the order their plugins are registered in
[`server/src/index.ts`](../server/src/index.ts).

- [Conventions](#conventions)
- [Error envelope and codes](#error-envelope-and-codes)
- [Health](#health) · [Auth](#auth) · [Branding](#branding) ·
  [Users](#users) · [Organizations](#organizations) · [Threads](#threads) ·
  [Notifications](#notifications) · [Admin](#admin) · [Catalog](#catalog) ·
  [APIs (publishing)](#apis-publishing) ·
  [Access requests](#access-requests) · [Grants](#grants) ·
  [Credentials](#credentials)

---

## Conventions

### Authentication

Sign in with `POST /api/auth/login`. The response sets two cookies:

| Cookie          | Flags                                                                                                     | Contents             |
| --------------- | --------------------------------------------------------------------------------------------------------- | -------------------- |
| `nexus_session` | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NEXUS_TRUST_PROXY=true`, `Max-Age=NEXUS_SESSION_TTL` | opaque session token |
| `nexus_csrf`    | same, but **not** `HttpOnly`                                                                              | the CSRF token       |

Send cookies on every request (`credentials: 'include'` in the browser).
Sessions slide: any request extends the expiry.

### CSRF

Every mutating request (anything that is not `GET`/`HEAD`/`OPTIONS`) under
`/api` that carries a session must send:

```
X-Nexus-CSRF: <value of the nexus_csrf cookie>
```

The header must equal both the cookie **and** the token stored on the session
row. A mismatch is `403 CSRF_MISMATCH`.

Exempt (they are reached before a session exists): `POST /api/auth/login`,
`POST /api/auth/register`, `POST /api/auth/verify-email`,
`GET /api/auth/captcha`. **`POST /api/auth/logout` is not exempt.**

### Auth requirement column

| Marker        | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| _public_      | no session needed                                                |
| _session_     | any signed-in, active account                                    |
| _provider_    | role `provider` or higher (`provider` < `admin` < `super_admin`) |
| _admin_       | role `admin` or higher                                           |
| _super_admin_ | role `super_admin` only                                          |

Roles are strictly ordered, so a higher role satisfies a lower requirement.
Route guards check the role; **row-level ownership** (`is this your API?`) is
checked one level down, in the service, and answers `403 FORBIDDEN` — except in
the catalog, which answers `404 NOT_FOUND` so it never confirms that an API you
may not see exists.

### Pagination

Every list endpoint accepts:

| Query    | Type                           | Default |
| -------- | ------------------------------ | ------- |
| `limit`  | integer, clamped to `[1, 200]` | `25`    |
| `offset` | integer ≥ 0                    | `0`     |

and answers with the same envelope:

```json
{ "items": [ … ], "total": 137 }
```

`total` is the count matching the filters, ignoring `limit`/`offset`. Query
booleans accept `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`.

### Other conventions

- Every id is a string UUID; every timestamp is an ISO-8601 string.
- Absent optional values are `null`, not omitted.
- Request bodies are `application/json`. The body limit is 4 MiB; an uploaded
  OpenAPI document is additionally capped at 2 MiB.
- All `/api` responses carry `cache-control: no-store`.

---

## Error envelope and codes

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "details": [{ "path": "email", "code": "invalid_string", "message": "Invalid email" }]
  }
}
```

`code` is stable and safe to branch on; `message` is human-facing and may
change; `details` is present only when there is structured context (per-field
validation issues, a conflicting slug, an Edge status).

| Code                 | HTTP | When                                                                                |
| -------------------- | ---- | ----------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`  | 400  | Body, query or params failed schema validation.                                     |
| `UNAUTHORIZED`       | 401  | No valid session, or it expired.                                                    |
| `FORBIDDEN`          | 403  | Authenticated, but the role or ownership check failed.                              |
| `NOT_FOUND`          | 404  | Target does not exist, or is not visible to the caller.                             |
| `CONFLICT`           | 409  | Uniqueness or state conflict (duplicate email/slug, active grant, already decided). |
| `CSRF_MISMATCH`      | 403  | `X-Nexus-CSRF` missing or not matching the cookie/session.                          |
| `CAPTCHA_FAILED`     | 400  | CAPTCHA token missing, expired, or rejected by the vendor.                          |
| `RATE_LIMITED`       | 429  | Too many requests from this identity/IP.                                            |
| `EMAIL_NOT_VERIFIED` | 403  | Account exists but its email is unverified and verification is required.            |
| `USER_DISABLED`      | 403  | Account has been disabled by an admin.                                              |
| `LAST_SUPER_ADMIN`   | 409  | Refused: would remove, demote or disable the last active `super_admin`.             |
| `SHOW_ONCE_ALREADY`  | 410  | Show-once material was already retrieved and cannot be shown again.                 |
| `EDGE_UNAVAILABLE`   | 502  | Ferrum Edge Admin API unreachable (network error / timeout).                        |
| `EDGE_ERROR`         | 502  | Ferrum Edge Admin API returned an error response.                                   |
| `SPEC_INVALID`       | 400  | Uploaded OpenAPI document could not be parsed or failed validation.                 |
| `OUTBOX_FAILURE`     | 500  | Email could not be enqueued, or exhausted its outbox retries.                       |
| `INTERNAL`           | 500  | Unexpected server-side failure.                                                     |

`UNAUTHORIZED`, `FORBIDDEN`, `CSRF_MISMATCH`, `USER_DISABLED` and
`VALIDATION_FAILED` can come back from any endpoint and are not repeated in the
per-endpoint notes below.

---

## Health

Public. Registered under `/api/health`.

### `GET /api/health`

_public_ — aggregate liveness/readiness.

The Edge probe never fails the endpoint: an unreachable gateway is reported as
`edge.status = "down"` with an overall `degraded`, so a load balancer keeps the
portal in rotation while the gateway recovers. Only a broken database makes the
overall status `down`.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime_seconds": 1284,
  "checked_at": "2026-08-31T09:12:44.117Z",
  "database": { "status": "ok", "latency_ms": 1, "error": null, "driver": "postgres" },
  "edge": {
    "status": "ok",
    "latency_ms": 7,
    "error": null,
    "edge_version": "1.4.2",
    "namespace": "nexus"
  }
}
```

`status` is `ok` | `degraded` | `down`. `edge_version` is `null` when the
gateway has no `/version` endpoint — take the real version from your deployment
metadata.

### `GET /api/health/edge`

_public_ — the Edge half on its own, same `edge` object as above.

---

## Auth

Registered under `/api/auth`. **Rate-limited** to 20 requests per minute per IP
across the whole prefix when `NEXUS_RATE_LIMIT_ENABLED=true` (the default;
always off under `NEXUS_ENV=test`). Exceeding it is `429 RATE_LIMITED`.

### `POST /api/auth/register`

_public_ → `201`

| Field           | Type                       | Notes                                                                     |
| --------------- | -------------------------- | ------------------------------------------------------------------------- |
| `email`         | string                     | Valid address, ≤ 320 chars. Stored lowercased; unique case-insensitively. |
| `password`      | string                     | ≥ 12 characters (`MIN_PASSWORD_LENGTH`), ≤ 1024.                          |
| `display_name`  | string                     | 1–200 chars.                                                              |
| `role`          | `"client"` \| `"provider"` | Ignored for the very first account.                                       |
| `company`       | string \| null             | optional, ≤ 200                                                           |
| `phone`         | string \| null             | optional, ≤ 64                                                            |
| `captcha_token` | string                     | optional, required when CAPTCHA is enabled                                |

```json
{ "user": { "id": "…", "email": "…", "role": "client", … }, "email_verification_required": false }
```

- **The first account ever created becomes `super_admin`** and is
  auto-verified, whatever `role` it asked for; the registration policy
  (`open_registration`, `allowed_roles`) is bypassed for it.
- When verification is not required, the response also sets the session
  cookies and the user is signed in.
- Errors: `409 CONFLICT` (email taken), `403 FORBIDDEN` (registration closed,
  or that role is not in `allowed_roles`), `400 CAPTCHA_FAILED`.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery-staple",
       "display_name":"Ada Lovelace","role":"client"}'
```

### `POST /api/auth/login`

_public_

Body: `email`, `password`, optional `captcha_token`.

```json
{ "user": { … }, "csrf_token": "…", "expires_at": "2026-08-31T21:12:44.117Z" }
```

Sets `nexus_session` and `nexus_csrf`. `csrf_token` is echoed in the body so a
non-browser client does not have to parse cookies.

Errors: `401 UNAUTHORIZED` (wrong email _or_ password — the two are
indistinguishable by design and cost the same time), `403 USER_DISABLED`,
`403 EMAIL_NOT_VERIFIED`, `400 CAPTCHA_FAILED`, `429 RATE_LIMITED`.

```bash
curl -sS -c cookies.txt -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery-staple"}'
```

### `POST /api/auth/logout`

_session_ — **CSRF required.** Destroys the session row and clears both
cookies. Returns `{ "ok": true }`.

### `GET /api/auth/me`

_session_ — the SPA's bootstrap payload.

```json
{
  "user": { … },
  "csrf_token": "…",
  "expires_at": "2026-08-31T21:12:44.117Z",
  "capabilities": {
    "can_publish_apis": false,
    "can_review_access_requests": false,
    "can_manage_users": false,
    "can_manage_settings": false,
    "can_view_audit_log": false,
    "can_use_god_mode": false
  }
}
```

`capabilities` is derived from the role (`provider+`, `provider+`, `admin+`,
`admin+`, `admin+`, `super_admin`) so the SPA does not re-derive it.

### `POST /api/auth/verify-email`

_public_, CSRF-exempt. Body `{ "token": string }` (8–512 chars).

```json
{ "verified": true, "user": { … } }
```

Tokens are single-use and expire after 24 hours. Errors:
`400 VALIDATION_FAILED` (unknown or expired link), `409 CONFLICT` (already
used).

### `GET /api/auth/captcha`

_public_ — widget configuration. Never carries the vendor secret.

```json
{ "enabled": true, "provider": "turnstile", "site_key": "0x4AAA…" }
```

---

## Branding

### `GET /api/branding`

_public_ — the one unauthenticated read besides health. Drives the login page
before a session exists.

```json
{
  "portal_name": "Acme Developer Portal",
  "logo_data_url": "data:image/png;base64,…",
  "primary_color": "#4f46e5",
  "accent_color": "#22d3ee",
  "default_theme": "dark",
  "tagline": "APIs for partners",
  "support_email": "api-support@acme.example",
  "captcha": { "enabled": false, "provider": "none", "site_key": null }
}
```

---

## Users

Registered under `/api/users`.

### `GET /api/users/me`

_session_ → `{ "user": User }`.

### `PATCH /api/users/me`

_session_ — profile self-service. **Cannot** change role, status, email or
organization.

| Field              | Type           | Notes                                   |
| ------------------ | -------------- | --------------------------------------- |
| `display_name`     | string         | 1–200                                   |
| `company`          | string \| null | ≤ 200                                   |
| `phone`            | string \| null | ≤ 64                                    |
| `current_password` | string         | required when `new_password` is present |
| `new_password`     | string         | ≥ 12 chars                              |

→ `{ "user": User }`. `403 FORBIDDEN` when `current_password` is wrong.

### `GET /api/users`

_admin_ — `Paginated<User>`.

| Query             | Type                                                        |
| ----------------- | ----------------------------------------------------------- |
| `role`            | `client` \| `provider` \| `admin` \| `super_admin`          |
| `status`          | `active` \| `disabled`                                      |
| `org_id`          | uuid                                                        |
| `q`               | substring match on email or display name (case-insensitive) |
| `limit`, `offset` | pagination                                                  |

### `PATCH /api/users/:id`

_admin_ — role, status, organization and display name.

| Field          | Type                   |
| -------------- | ---------------------- |
| `role`         | any of the four roles  |
| `status`       | `active` \| `disabled` |
| `org_id`       | uuid \| null           |
| `display_name` | string, 1–200          |

→ `{ "user": User }`.

Guards enforced in the service:

- **Only a `super_admin` may confer or remove admin power.** A plain `admin`
  can move accounts between `client` and `provider` and nothing else — neither
  promoting to `admin` nor demoting an existing one → `403 FORBIDDEN`.
- Only a `super_admin` may disable an `admin` or `super_admin` →
  `403 FORBIDDEN`.
- Demoting or disabling the **last active `super_admin`** →
  `409 LAST_SUPER_ADMIN`.
- Disabling **your own** account → `409 CONFLICT`.
- Disabling an account deletes every session it holds.
- `404 NOT_FOUND` when `org_id` names an organization that does not exist.

---

## Organizations

Registered under `/api/organizations`. The **entire** plugin requires _admin_.

### `GET /api/organizations`

_admin_ — `Paginated<Organization>`, ordered by name. Accepts `limit`/`offset`.

### `POST /api/organizations`

_admin_ → `201 { "organization": Organization }`.
Body: `name` (1–200), `description` (≤ 2000, optional/nullable).

### `PATCH /api/organizations/:id`

_admin_ → `{ "organization": Organization }`. Body: optional `name`,
`description`. Returns the row unchanged when nothing was supplied.

---

## Threads

Portal messaging. Registered under `/api/threads`; every endpoint needs a
_session_. Who may read or post in a given thread is decided by the messaging
service.

A thread has two seats. A **1:1 thread** pairs a client (`participant_a`) with a
provider (`participant_b`), optionally about one API. A **platform thread** has
`participant_b: null` — the empty seat is "the platform", and **any admin may
read and reply**. Threads are deduplicated on `(participants, api_id)`, so
asking the same provider about the same API twice continues the existing
conversation.

### `GET /api/threads`

_session_ — `Paginated<MessageThread>`, newest activity first, each row
carrying `participants`, optional `api`, and `last_message_preview`
(≤ 160 chars).

| Query             | Type                       |
| ----------------- | -------------------------- |
| `api_id`          | uuid                       |
| `q`               | substring match on subject |
| `limit`, `offset` | pagination                 |

Non-admins see threads they participate in. Admins additionally see every
platform thread.

### `POST /api/threads`

_session_ → `201`

| Field               | Type         | Notes                                         |
| ------------------- | ------------ | --------------------------------------------- |
| `subject`           | string       | 1–200                                         |
| `body`              | string       | 1–10 000, the opening message                 |
| `recipient_user_id` | uuid \| null | omit or `null` to address the platform admins |
| `api_id`            | uuid \| null | optional API the conversation is about        |

```json
{ "thread": { … }, "message": { … } }
```

Errors: `400 VALIDATION_FAILED` (empty subject/body, or messaging yourself),
`404 NOT_FOUND` (unknown or disabled recipient, unknown API).

### `GET /api/threads/:id`

_session_ — the thread plus its full message list (`MessageThreadDetail`), each
message carrying a `sender` summary. Participants always; admins for oversight.
`403 FORBIDDEN` otherwise.

### `POST /api/threads/:id/messages`

_session_ → `201 { "message": Message }`. Body `{ "body": string }` (1–10 000).
Participants may post; an admin may post into any _platform_ thread.

---

## Notifications

Registered under `/api/notifications`; _session_ throughout. A user only ever
sees their own — the id comes from the session, never the request.

### `GET /api/notifications`

_session_

| Query             | Type                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unread`          | boolean — only unread                                                                                                                                                      |
| `type`            | one of `access_request_created`, `access_request_approved`, `access_request_denied`, `access_revoked`, `message_received`, `credential_rotated`, `api_published`, `system` |
| `limit`, `offset` | pagination                                                                                                                                                                 |

```json
{ "items": [ … ], "total": 42, "unread_count": 3 }
```

### `POST /api/notifications/read`

_session_ — body must supply **either** `ids` (≤ 500 uuids) **or**
`all: true`; supplying neither is `400 VALIDATION_FAILED`. Ids belonging to
another user are ignored.

```json
{ "updated": 3, "unread_count": 0 }
```

---

## Admin

Registered under `/api/admin`. The **entire** plugin requires _admin_; the four
`god/*` endpoints additionally require _super_admin_.

### `GET /api/admin/settings`

_admin_ — the whole settings snapshot. Secrets are never returned; booleans
report whether one is stored.

```json
{
  "branding": {
    "portal_name": "…",
    "logo_data_url": null,
    "primary_color": "#4f46e5",
    "accent_color": "#22d3ee",
    "default_theme": "dark",
    "tagline": null,
    "support_email": null
  },
  "captcha": { "enabled": false, "provider": "none", "site_key": null, "secret_set": false },
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "username": "portal",
    "password_set": true,
    "from_address": "Ferrum Nexus <no-reply@example.com>"
  },
  "registration": {
    "open_registration": true,
    "require_email_verification": false,
    "allowed_roles": ["client", "provider"]
  }
}
```

### `PUT /api/admin/settings`

_admin_ — partial update; **omitted sections are untouched**, and omitted
fields inside a supplied section keep their current value.

| Section        | Fields                                                                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branding`     | `portal_name` (1–120), `logo_data_url` (base64 image data URL, ≤ 512 KiB, nullable), `primary_color` / `accent_color` (CSS hex `#rgb`–`#rrggbbaa`), `default_theme` (`dark`\|`light`\|`system`), `tagline` (≤ 280, nullable), `support_email` (nullable) |
| `captcha`      | `enabled`, `provider` (`none`\|`recaptcha`\|`hcaptcha`\|`turnstile`), `site_key` (nullable), `secret_key` — **write-only**, stored AES-256-GCM encrypted; pass `null` or `""` to clear                                                                   |
| `smtp`         | `host`, `port` (1–65535), `secure`, `username`, `password` — **write-only**, encrypted; `null`/`""` clears — `from_address`                                                                                                                              |
| `registration` | `open_registration`, `require_email_verification`, `allowed_roles` (array of roles)                                                                                                                                                                      |

→ the same shape as `GET /api/admin/settings`. The audit row records the
**names** of the changed keys and never their values.

```bash
curl -sS -b cookies.txt -X PUT http://127.0.0.1:8787/api/admin/settings \
  -H 'content-type: application/json' \
  -H "X-Nexus-CSRF: $CSRF" \
  -d '{"captcha":{"enabled":true,"provider":"turnstile",
        "site_key":"0x4AAA…","secret_key":"0x4AAA…secret"}}'
```

### `POST /api/admin/settings/smtp-test`

_admin_ — sends a probe message **straight through SMTP, bypassing the
outbox**, so a misconfiguration is reported immediately.

Body: `{ "to_email"?: string }` — defaults to the calling admin's address.

```json
{ "ok": false, "error": "getaddrinfo ENOTFOUND smtp.example.com" }
```

Note this is a `200` with `ok: false`, not an error response.

### `GET /api/admin/email-templates`

_admin_ → `{ "templates": EmailTemplate[], "keys": EmailTemplateKey[] }`.
`templates` lists only the keys an admin has **overridden**; `keys` is the full
set.

### `GET /api/admin/email-templates/:key`

_admin_ — `key` ∈ `verification`, `access_approved`, `access_denied`,
`access_revoked`, `message_received`, `mass`, `credential_rotated`.

```json
{
  "template": {
    "id": "…",
    "key": "access_approved",
    "subject": "Access approved: {{api_name}}",
    "body_html": "…",
    "body_text": "…",
    "created_at": "…",
    "updated_at": "…"
  },
  "available_variables": [
    "portal_name",
    "portal_url",
    "recipient_name",
    "recipient_email",
    "year",
    "api_name",
    "api_slug",
    "api_url",
    "decided_by_name",
    "decision_note"
  ]
}
```

When no override exists, the built-in default is returned with a synthetic id.

### `PUT /api/admin/email-templates/:key`

_admin_ — body `subject` (1–300), `body_html` (1–100 000), `body_text`
(1–100 000). All three are required. → `{ "template": EmailTemplate }`.

### `POST /api/admin/mass-email`

_admin_ — enqueues **one outbox row per recipient**, never a BCC blast.

| Field               | Type                              | Notes                                                             |
| ------------------- | --------------------------------- | ----------------------------------------------------------------- |
| `subject`           | string                            | 1–300                                                             |
| `body_html`         | string                            | ≤ 100 000; at least one of html/text must be non-empty            |
| `body_text`         | string                            | ≤ 100 000                                                         |
| `audience.scope`    | `all` \| `filtered` \| `explicit` | `all` ignores the other filters and never mails disabled accounts |
| `audience.roles`    | Role[]                            | `filtered` only                                                   |
| `audience.status`   | `active` \| `disabled`            | `filtered` only, defaults to `active`                             |
| `audience.org_id`   | uuid                              | `filtered` only                                                   |
| `audience.user_ids` | uuid[] (≤ 5000)                   | required when scope is `explicit`                                 |
| `idempotency_key`   | string, 8–128                     | reuse makes the send at-most-once                                 |

```json
{ "enqueued": 240, "recipients": 251 }
```

Rows are keyed `mass:<batch>:<user_id>`, where `<batch>` is your
`idempotency_key` or a fresh UUID. `recipients` is who matched; `enqueued`
excludes duplicates suppressed by the key — reposting the same request with the
same key enqueues nothing new.

### `GET /api/admin/audit-logs`

_admin_ — `Paginated<AuditLog>`, newest first.

| Query             | Type                                       |
| ----------------- | ------------------------------------------ |
| `actor_user_id`   | uuid                                       |
| `action`          | exact action string, e.g. `access.approve` |
| `target_type`     | e.g. `api`, `grant`, `user`, `credential`  |
| `target_id`       | string                                     |
| `from`            | ISO-8601 datetime, inclusive lower bound   |
| `to`              | ISO-8601 datetime, exclusive upper bound   |
| `limit`, `offset` | pagination                                 |

The full action catalog is in [`security.md`](security.md#10-audit-event-catalog).

```bash
curl -sS -b cookies.txt \
  'http://127.0.0.1:8787/api/admin/audit-logs?action=access.approve&limit=50'
```

### God mode

Four endpoints, all _super_admin_, all requiring a non-empty `reason` (1–2000
chars) that lands in a `god.*` audit row **in addition to** the ordinary audit
row the underlying operation writes.

#### `POST /api/admin/god/revoke-grant`

Body `{ "grant_id": uuid, "reason": string }` → `{ "grant": Grant }`.
Revokes any grant regardless of who owns the API; removes the ACL group from
the consumer.

#### `POST /api/admin/god/delete-api`

Body `{ "api_id": uuid, "reason": string, "revoke_grants"?: boolean }`

```json
{ "deleted_api_id": "…", "revoked_grants": 7 }
```

Deletes the API and its Edge proxy + plugins whoever owns it. Deletion always
strips ACL groups and removes grant rows; `revoke_grants: true` additionally
records each one as an individual `access.revoke` first, which is what an audit
reviewer wants.

#### `POST /api/admin/god/disable-user`

Body `{ "user_id": uuid, "reason": string, "revoke_grants"?: boolean }`

```json
{ "user": { … }, "revoked_grants": 3, "terminated_sessions": 2 }
```

Disables the account and destroys every session it holds. Errors:
`409 CONFLICT` (disabling yourself), `409 LAST_SUPER_ADMIN`.

#### `POST /api/admin/god/broadcast`

Body `{ "subject": string (1–300), "body": string (1–20 000), "audience": MassEmailAudience, "send_email"?: boolean }`

```json
{ "notified": 251, "emails_enqueued": 251, "threads_created": 88 }
```

Sends a bell notification to every recipient, drops the message into each
recipient's **platform inbox thread** (so it survives being dismissed from the
bell and any admin can follow up in the same thread), and optionally enqueues
an email. The acting super admin is excluded from their own broadcast.

---

## Catalog

Registered under `/api/catalog`; every endpoint needs a _session_. All reads —
there is no mutation here and therefore no CSRF concern.

Visibility is decided by the catalog service, which answers `404` rather than
`403` for an API you may not see, so the catalog never confirms that an
internal API exists.

| API state                           | client  | grantee | owner | admin |
| ----------------------------------- | ------- | ------- | ----- | ----- |
| `published` + `public` — **list**   | yes     | yes     | yes   | yes   |
| `published` + `internal` — **list** | no      | yes     | yes   | yes   |
| `retired` — **list**                | no      | yes     | yes   | yes   |
| `published` + `public` — **open**   | yes     | yes     | yes   | yes   |
| `published` + `internal` — **open** | **yes** | yes     | yes   | yes   |
| `retired` — **open**                | no      | yes     | yes   | yes   |

`internal` means _unlisted_, not secret: a provider hands out the link and the
recipient can read the docs and raise an access request. What protects the data
is the ACL group on the gateway.

### `GET /api/catalog`

_session_ — `Paginated<CatalogApi>`. Each row is an `Api` plus `owner`
(`UserSummary` \| null) and `access_state`.

| Query             | Type                                         |
| ----------------- | -------------------------------------------- |
| `q`               | substring match on name, slug or description |
| `requestable`     | boolean                                      |
| `visibility`      | `public` \| `internal`                       |
| `owner_user_id`   | uuid                                         |
| `limit`, `offset` | pagination                                   |

`access_state` ∈ `none` \| `pending` \| `granted` \| `denied` \| `revoked` \|
`owner`.

### `GET /api/catalog/:slug`

_session_

```json
{
  "api": { …, "owner": { … }, "access_state": "pending" },
  "spec": { "id": "…", "api_id": "…", "version": "2.4.0", "parsed_title": "Billing API",
            "parsed_version": "2.4.0", "is_current": true, "created_at": "…", "updated_at": "…" },
  "my_request": { … } ,
  "my_grant": null
}
```

`spec` carries metadata only, never the document. `my_request` is the caller's
latest request for this API; `my_grant` their active grant. Both may be `null`.
`404 NOT_FOUND` when the API does not exist or is not viewable.

### `GET /api/catalog/:slug/spec`

_session_ — the raw current document.

```json
{
  "api_id": "…",
  "version": "2.4.0",
  "raw_spec": "openapi: 3.1.0\ninfo:\n  title: Billing API\n…",
  "content_type": "application/yaml",
  "parsed_title": "Billing API",
  "parsed_version": "2.4.0"
}
```

`content_type` is `application/json` or `application/yaml`, matching
`raw_spec`. `404 NOT_FOUND` when the API is not viewable or has no spec.

---

## APIs (publishing)

Registered under `/api/apis`. The **whole plugin** requires _provider_ or
higher. Ownership ("your API, or you are an admin") is checked in the service
and answers `403 FORBIDDEN`.

Spec documents arrive as a JSON string field, not a multipart upload — the SPA
reads the file client-side, which keeps the CSRF story and the error shape
identical to every other route.

### `GET /api/apis`

_provider_ — `Paginated<Api>`.

| Query             | Type                     | Notes                                                                                    |
| ----------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `mine`            | boolean                  | an admin's opt-in to "only my APIs"; a provider is always scoped to their own regardless |
| `owner_user_id`   | uuid                     | admin only in effect                                                                     |
| `status`          | `published` \| `retired` |                                                                                          |
| `q`               | substring match          |                                                                                          |
| `limit`, `offset` | pagination               |                                                                                          |

### `POST /api/apis`

_provider_ → `201` — validates the spec, builds the Edge proxy and its plugins,
then persists.

| Field          | Type                                     | Notes                                                                                                |
| -------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `name`         | string                                   | 1–200, required                                                                                      |
| `slug`         | string                                   | ≤ 60, **optional** — derived from `name` when omitted; the listen path becomes `/<namespace>/<slug>` |
| `description`  | string \| null                           | ≤ 4000; falls back to `info.description` from the spec                                               |
| `version`      | string                                   | ≤ 60, optional — defaults to the spec's `info.version`                                               |
| `upstream_url` | string                                   | ≤ 2000, **optional** when the document has an absolute `servers[0].url`                              |
| `spec`         | string                                   | the OpenAPI 3.x document as JSON or YAML text, ≤ 2 MiB — required                                    |
| `auth_plugin`  | `key_auth` \| `basic_auth` \| `jwt_auth` | required                                                                                             |
| `requestable`  | boolean                                  | required — attaches `access_control` when true                                                       |
| `visibility`   | `public` \| `internal`                   | required                                                                                             |
| `rate_limit`   | `{ limit, window_seconds }` \| null      | optional; `limit` 1–10 000 000, `window_seconds` 1–86 400                                            |

```json
{ "api": { … }, "spec": { … } }
```

Errors: `400 SPEC_INVALID` (unparseable, Swagger 2.0, missing
`openapi`/`info.title`/`info.version`/`paths`, oversized, or no upstream
determinable), `409 CONFLICT` (slug taken), `502 EDGE_ERROR` /
`502 EDGE_UNAVAILABLE`. A failed Edge step is rolled back — the plugin configs
and proxy are deleted — and nothing is written to the Nexus store.

```bash
SPEC=$(jq -Rs . < billing-openapi.yaml)
curl -sS -b cookies.txt -X POST http://127.0.0.1:8787/api/apis \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $CSRF" \
  -d "{\"name\":\"Billing API\",\"slug\":\"billing\",\"version\":\"2.4.0\",
       \"spec\":$SPEC,\"auth_plugin\":\"key_auth\",\"requestable\":true,
       \"visibility\":\"public\",\"rate_limit\":{\"limit\":1000,\"window_seconds\":60}}"
```

### `GET /api/apis/:id`

_provider_, owner-or-admin

```json
{
  "api": { … },
  "spec": { … } ,
  "stats": { "pending_requests": 2, "active_grants": 17, "total_requests": 31 }
}
```

### `PATCH /api/apis/:id`

_provider_, owner-or-admin — safe runtime settings only; the spec has its own
route. Every field optional; nothing supplied returns the row unchanged.

| Field                            | Effect                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `description`, `version` | metadata only                                                                                                                                                  |
| `visibility`                     | `public` ⇄ `internal`; catalog listing only                                                                                                                    |
| `status`                         | `published` ⇄ `retired` — **catalog state only**, the proxy and every live grant keep working                                                                  |
| `upstream_url`                   | rewrites the Edge proxy's backend                                                                                                                              |
| `auth_plugin`                    | deletes the old auth plugin config and attaches the new one; existing credentials of the old flavour no longer satisfy this API, and every grantee is notified |
| `requestable`                    | attaches or deletes `access_control`. Turning it **off** opens the API to every authenticated consumer; existing grants stay on the consumers and become inert |
| `rate_limit`                     | attaches, replaces, or (with `null`) deletes `rate_limiting`                                                                                                   |

→ `{ "api": Api }`. Errors: `400 SPEC_INVALID` (bad `upstream_url`),
`502 EDGE_ERROR`.

### `DELETE /api/apis/:id`

_provider_, owner-or-admin → `{ "ok": true }`.

Destructive and ordered deliberately: plugin configs and proxy are deleted from
Edge **first** (so nothing stays reachable-but-untracked), then the ACL group is
stripped from every grantee's consumer, then the grants, requests, spec
revisions and the API row are deleted in one store transaction. Grantees get a
notification.

### `PUT /api/apis/:id/spec`

_provider_, owner-or-admin — publish a new spec revision.

Body: `spec` (required, the document text), `version` (optional; defaults to
the parsed `info.version`).

```json
{ "api": { … }, "spec": { … } }
```

The new revision becomes current. The proxy backend is re-pointed at the
document's `servers[0]` **only** if the proxy is still pointing where the
_previous_ revision said it should — once a provider supplies an explicit
upstream, the document stops being authoritative for it.

### `POST /api/apis/:id/test-consumer`

_provider_, owner-or-admin → `201` — **show-once.**

Body: `{ "label"?: string | null }` (≤ 120).

```json
{
  "credential": { "id": "…", "credential_type": "keyauth", "last4": "9f2a", … },
  "consumer_username": "nexus-test-2b1c…",
  "secret": { "type": "keyauth", "key": "nxs_pQ7…" }
}
```

Creates (or **replaces**, deleting the old one) the disposable consumer
`nexus-test-<api_id>`, carrying this API's ACL group and one credential of the
API's auth type. The secret appears in this response and nowhere else, ever.

---

## Access requests

Registered under `/api/access-requests`; _session_ throughout. Who may act on a
row depends on who owns the API it points at, so there is no route-level role
guard: a client raises and cancels, a provider decides requests on their own
APIs, an admin may act on any.

### `GET /api/access-requests`

_session_ — `Paginated<AccessRequest>`, each row carrying `api` and `requester`
summaries.

| Query             | Type                                                            |
| ----------------- | --------------------------------------------------------------- |
| `mine`            | boolean — only the caller's own requests                        |
| `api_id`          | uuid                                                            |
| `status`          | `pending` \| `approved` \| `denied` \| `revoked` \| `cancelled` |
| `limit`, `offset` | pagination                                                      |

Scoping: a `client` (or anyone passing `mine=true`) sees only their own; a
`provider` sees the inbox for the APIs they own; an `admin` sees everything.
A provider filtering by an `api_id` they do not own gets `403 FORBIDDEN`.

### `POST /api/access-requests`

_session_ → `201 { "access_request": AccessRequest }`

Body: `api_id` (uuid), `justification` (1–2000 chars).

Errors, all `409 CONFLICT`: you own this API; the API is retired; the API does
not accept access requests (`requestable: false`); you already have access; you
already have a pending request. `404 NOT_FOUND` for an unknown API.

Visibility is deliberately **not** checked — an `internal` API is unlisted, not
private, and gating requests on visibility would make `internal` +
`requestable` a combination nobody could act on.

```bash
curl -sS -b cookies.txt -X POST http://127.0.0.1:8787/api/access-requests \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $CSRF" \
  -d '{"api_id":"2b1c…","justification":"Reconciling invoices for the Acme integration."}'
```

### `POST /api/access-requests/:id/cancel`

_session_, **requester only** → `{ "access_request": AccessRequest }`.
No body. `403 FORBIDDEN` for anyone else; `409 CONFLICT` when the request is no
longer `pending`.

### `POST /api/access-requests/:id/approve`

_session_, **API owner or admin** →

```json
{ "access_request": { …, "status": "approved" }, "grant": { …, "acl_group": "nexus:api:2b1c…:approved" } }
```

Body: `{ "decision_note"?: string | null }` (≤ 2000). The body may be omitted
entirely.

What happens: the requester's Edge consumer is created if needed, the ACL group
`nexus:api:<api_id>:approved` is added to it (serialised per consumer), and
only then are the grant row and the request status committed in one store
transaction. The requester gets a notification and an `access_approved` email.

Errors: `403 FORBIDDEN` (not the owner and not an admin), `409 CONFLICT`
(already decided, or the user already holds an active grant),
`502 EDGE_ERROR` / `502 EDGE_UNAVAILABLE` — in which case nothing is committed
and the request stays `pending`, safe to retry.

### `POST /api/access-requests/:id/deny`

_session_, **API owner or admin** → `{ "access_request": AccessRequest }`.
Body `{ "decision_note"?: string | null }`, optional. Nothing changes on the
gateway. `409 CONFLICT` when already decided.

---

## Grants

Registered under `/api/grants`; _session_ throughout.

### `GET /api/grants`

_session_ — `Paginated<Grant>`, each row carrying `api` and `user` summaries.

| Query             | Type                       |
| ----------------- | -------------------------- |
| `mine`            | boolean                    |
| `api_id`          | uuid                       |
| `user_id`         | uuid — honoured for admins |
| `status`          | `active` \| `revoked`      |
| `limit`, `offset` | pagination                 |

Same scoping as access requests: own / owned-APIs / everything.

### `POST /api/grants/:id/revoke`

_session_, **API owner or admin** → `{ "grant": Grant }`.

Body: `{ "reason"?: string | null }` (≤ 2000), optional.

Removes the ACL group from the grantee's consumer, flips the grant to
`revoked`, and drags the originating access request to `revoked` too so the
requester's history reads "approved, then revoked". The grantee is notified and
emailed. `409 CONFLICT` when the grant is already revoked.

---

## Credentials

Registered under `/api/credentials`; _session_ throughout.

**`POST /api/credentials` and `POST /api/credentials/:id/rotate` are the only
two responses in the entire API that carry plaintext credential material, and
each carries it exactly once.** Nexus stores a SHA-256 fingerprint and the last
four characters; Ferrum Edge redacts credential material on every read. There
is no path back to the plaintext on either side.

### `GET /api/credentials`

_session_ — `Paginated<CredentialMetadata>`. Never contains a secret.

| Query             | Type                                | Notes                                                                                     |
| ----------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `status`          | `active` \| `retiring` \| `revoked` |                                                                                           |
| `user_id`         | uuid                                | **admin only** — inspect another account's credential metadata; `403 FORBIDDEN` otherwise |
| `limit`, `offset` | pagination                          |                                                                                           |

### `POST /api/credentials`

_session_ → `201` — **show-once.**

Body: `credential_type` ∈ `keyauth` \| `basicauth` \| `jwt`,
optional `label` (≤ 120, nullable).

```json
{
  "credential": { "id": "…", "credential_type": "keyauth", "fingerprint": "…",
                  "last4": "9f2a", "status": "active", "rotated_from_id": null, … },
  "consumer_username": "nexus-user-7c1d…",
  "secret": { "type": "keyauth", "key": "nxs_pQ7…" }
}
```

The `secret` shape depends on the type:

| `credential_type` | `secret` fields                                   | How the client authenticates                                                           |
| ----------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `keyauth`         | `key`                                             | `X-API-Key: <key>`                                                                     |
| `basicauth`       | `username` (= the consumer username), `password`  | HTTP Basic `<consumer username>:<password>`                                            |
| `jwt`             | `jwt_secret`, `jwt_key` (= the consumer username) | HS256 JWT signed with `jwt_secret`, `sub` = `jwt_key`, sent as `Authorization: Bearer` |

Errors: `409 CONFLICT` when you already hold
`FERRUM_MAX_CREDENTIALS_PER_TYPE` (default 2) live credentials of that type —
revoke or rotate one first; `502 EDGE_ERROR` / `502 EDGE_UNAVAILABLE`.

```bash
curl -sS -b cookies.txt -X POST http://127.0.0.1:8787/api/credentials \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $CSRF" \
  -d '{"credential_type":"keyauth","label":"laptop"}'
```

### `POST /api/credentials/:id/rotate`

_session_, owner (or an admin) → **show-once.**

Body: `{ "label"?: string | null }`, optional — defaults to the previous
credential's label.

```json
{
  "credential": { "id": "new…", "rotated_from_id": "old…", "status": "active", … },
  "previous":   { "id": "old…", "status": "revoked", … },
  "consumer_username": "nexus-user-7c1d…",
  "secret": { "type": "keyauth", "key": "nxs_r3W…" }
}
```

Append-then-delete: the replacement is created on Edge first so both secrets
are live across the hand-off, then the old entry is deleted. **When the account
is already at the per-type cap there is no room to append**, so the old entry is
deleted first and there is a brief window with no working credential of that
type.

Errors: `403 FORBIDDEN` (someone else's credential), `409 CONFLICT` (already
revoked), `502 EDGE_ERROR` — including the case where the gateway's credential
list no longer matches the portal's view, which is refused rather than guessed
at.

### `DELETE /api/credentials/:id`

_session_, owner (or an admin) → `{ "ok": true }`. Deletes the entry from Edge
and marks the row `revoked`. Idempotent: a credential already `revoked` returns
success without touching the gateway.

---

## See also

- [`getting-started.md`](getting-started.md) — end-to-end walkthrough from an
  empty database to a call through the gateway.
- [`guides/client-guide.md`](guides/client-guide.md) ·
  [`guides/provider-guide.md`](guides/provider-guide.md) ·
  [`guides/admin-guide.md`](guides/admin-guide.md)
- [`security.md`](security.md) — RBAC matrix and the audit event catalog.
