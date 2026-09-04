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

| Cookie          | Flags                                                                                                          | Contents             |
| --------------- | -------------------------------------------------------------------------------------------------------------- | -------------------- |
| `nexus_session` | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` unless `NEXUS_COOKIE_SECURE=false`, `Max-Age=NEXUS_SESSION_TTL` | opaque session token |
| `nexus_csrf`    | same, but **not** `HttpOnly`                                                                                   | the CSRF token       |

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
`POST /api/auth/resend-verification`, `POST /api/auth/forgot-password`,
`POST /api/auth/reset-password`, `GET /api/auth/captcha`.
**`POST /api/auth/logout` is not exempt.**

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

| Code                 | HTTP | When                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`  | 400  | Body, query or params failed schema validation.                                                                                                                                                                                                                                                                                                                                                                               |
| `UNAUTHORIZED`       | 401  | No valid session, or it expired.                                                                                                                                                                                                                                                                                                                                                                                              |
| `FORBIDDEN`          | 403  | Authenticated, but the role or ownership check failed.                                                                                                                                                                                                                                                                                                                                                                        |
| `NOT_FOUND`          | 404  | Target does not exist, or is not visible to the caller.                                                                                                                                                                                                                                                                                                                                                                       |
| `CONFLICT`           | 409  | Uniqueness or state conflict (duplicate email/slug, active grant, already decided).                                                                                                                                                                                                                                                                                                                                           |
| `CSRF_MISMATCH`      | 403  | `X-Nexus-CSRF` missing or not matching the cookie/session.                                                                                                                                                                                                                                                                                                                                                                    |
| `CAPTCHA_FAILED`     | 400  | CAPTCHA token missing, expired, or rejected by the vendor.                                                                                                                                                                                                                                                                                                                                                                    |
| `RATE_LIMITED`       | 429  | Too many requests from this identity/IP.                                                                                                                                                                                                                                                                                                                                                                                      |
| `QUOTA_EXCEEDED`     | 429  | A configured per-account allowance is already fully used. `details` is `{ limit, setting, … }` naming the environment variable an operator would raise — `{ limit, current, setting }` for a standing ceiling such as the API quota, `{ limit, window, setting }` for a period budget such as the daily message budget. Distinct from `RATE_LIMITED`, which is about request frequency and clears on its own.                 |
| `EMAIL_NOT_VERIFIED` | 403  | Account exists but its email is unverified and verification is required.                                                                                                                                                                                                                                                                                                                                                      |
| `USER_DISABLED`      | 403  | Account has been disabled by an admin.                                                                                                                                                                                                                                                                                                                                                                                        |
| `LAST_SUPER_ADMIN`   | 409  | Refused: would remove, demote or disable the last active `super_admin`.                                                                                                                                                                                                                                                                                                                                                       |
| `SHOW_ONCE_ALREADY`  | 410  | Show-once material was already retrieved and cannot be shown again.                                                                                                                                                                                                                                                                                                                                                           |
| `EDGE_UNAVAILABLE`   | 502  | Ferrum Edge Admin API unreachable (network error / timeout).                                                                                                                                                                                                                                                                                                                                                                  |
| `EDGE_ERROR`         | 502  | Ferrum Edge Admin API returned an error response. On a gateway **validation** refusal (`400`, `409`, `422`) `details` is `{ status, gateway_message }`, where `gateway_message` is Edge's own text about the request, trimmed to 500 characters, and the top-level `message` repeats it. A `401`, `403` or `5xx` from the gateway stays opaque — that text is about the gateway's own configuration and only reaches the log. |
| `SPEC_INVALID`       | 400  | Uploaded OpenAPI document could not be parsed or failed validation.                                                                                                                                                                                                                                                                                                                                                           |
| `OUTBOX_FAILURE`     | 500  | Email could not be enqueued, or exhausted its outbox retries.                                                                                                                                                                                                                                                                                                                                                                 |
| `INTERNAL`           | 500  | Unexpected server-side failure.                                                                                                                                                                                                                                                                                                                                                                                               |

`UNAUTHORIZED`, `FORBIDDEN`, `CSRF_MISMATCH`, `USER_DISABLED` and
`VALIDATION_FAILED` can come back from any endpoint and are not repeated in the
per-endpoint notes below.

---

## Health

Public. Registered under `/api/health`. **Rate-limited** to 120 requests per
minute per IP across the prefix when `NEXUS_RATE_LIMIT_ENABLED=true` (the
default; always off under `NEXUS_ENV=test`) — `429 RATE_LIMITED` beyond that.

The database and gateway probes behind these routes are **cached for
`NEXUS_HEALTH_CACHE_MS`** (default 5 s) and concurrent callers share one
in-flight probe, so a burst produces a single database query and a single Admin
API call. A failing probe is cached for the same window. `checked_at` reports
when the probes ran, not when the request arrived. See
[`operations.md`](operations.md#9-health-checks).

### `GET /api/health`

_public_ — aggregate liveness/readiness.

**Status code contract:** `200` for `ok` and `degraded`, `503` for `down`.
Container and load-balancer probes key on the code, so a gateway outage alone
must never take the portal out of rotation — only a broken database does.

The Edge probe therefore never fails the endpoint. An unreachable gateway is
`edge.status = "down"` and a gateway that answered but reports itself unready is
`edge.status = "not_ready"`; both leave the overall status `degraded` on a
`200`.

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
    "ready": true,
    "mode": "database",
    "admin_writes_enabled": true,
    "edge_version": null,
    "namespace": "nexus"
  }
}
```

Overall `status` is `ok` | `degraded` | `down`; `edge.status` is `ok` |
`not_ready` | `down`.

`not_ready` exists because Edge answers `GET /health` with **`503` and a
complete health payload** while it is `starting`, `draining` or `unavailable`.
That is a reachable gateway reporting its own state, so Nexus parses the body
and reports `ready: false` rather than calling the gateway unreachable.
`ready` comes straight from that payload and is `null` when nothing answered.
`mode` and `admin_writes_enabled` are gateway detail: they are filled in only
for an authenticated admin, and are `null` for everyone else — the same rule
`error` follows.

`edge_version` is **always `null` against a stock gateway**: Ferrum Edge
exposes no version endpoint at all. Take the real version from your deployment
metadata.

Because this endpoint is unauthenticated, `database.error` is never the
driver's own message — a failing database reports the constant `"unreachable"`
and the real text (`connect ECONNREFUSED 10.0.3.14:5432`, authentication
failures, and so on) is written to the server log at `error` level instead.
`edge.error` is treated the same way: an admin sees the probe's real failure,
everyone else sees `"unreachable"`.

### `GET /api/health/edge`

_public_ — the Edge half on its own, same `edge` object as above. Always `200`;
the gateway's state is in the body, because the portal itself is fine either
way.

---

## Auth

Registered under `/api/auth`. **Rate-limited** to 20 requests per minute per IP
across the whole prefix when `NEXUS_RATE_LIMIT_ENABLED=true` (the default;
always off under `NEXUS_ENV=test`). Exceeding it is `429 RATE_LIMITED`.

### `POST /api/auth/register`

_public_ → `201`

| Field             | Type                       | Notes                                                                     |
| ----------------- | -------------------------- | ------------------------------------------------------------------------- |
| `email`           | string                     | Valid address, ≤ 320 chars. Stored lowercased; unique case-insensitively. |
| `password`        | string                     | ≥ 12 characters (`MIN_PASSWORD_LENGTH`), ≤ 1024.                          |
| `display_name`    | string                     | 1–200 chars.                                                              |
| `role`            | `"client"` \| `"provider"` | Ignored for the very first account.                                       |
| `company`         | string \| null             | optional, ≤ 200                                                           |
| `phone`           | string \| null             | optional, ≤ 64                                                            |
| `captcha_token`   | string                     | optional, required when CAPTCHA is enabled                                |
| `bootstrap_token` | string                     | **Required while the portal has no accounts**; ignored afterwards.        |

```json
{ "user": { "id": "…", "email": "…", "role": "client", … }, "email_verification_required": false }
```

- **The first account ever created becomes `super_admin`** and is
  auto-verified, whatever `role` it asked for; the registration policy
  (`open_registration`, `allowed_roles`) is bypassed for it.
- **That first registration must carry `bootstrap_token`** — the server's
  `NEXUS_BOOTSTRAP_TOKEN`, or the per-process token printed in its startup log.
  Without a matching value the request is refused with `403 FORBIDDEN` and
  nothing is created. `GET /api/branding` reports `bootstrap_required` so a
  client knows when to ask for it. Once any account exists the field is ignored.
- When verification is not required, the response also sets the session
  cookies and the user is signed in.
- Errors: `409 CONFLICT` (email taken), `403 FORBIDDEN` (missing or wrong
  `bootstrap_token` on an empty portal, registration closed, or that role is
  not in `allowed_roles`), `400 CAPTCHA_FAILED`.

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

### The anti-enumeration contract

The next three routes exist so a visitor can recover an account without help,
which means they take an email address from anyone who asks. All three answer

```json
{ "ok": true }
```

with status `200` **in every case** — the address has an account, it has none,
the account is disabled, it is already verified, or a link was already sent
inside the throttle window. They also pay the same scrypt-sized cost whatever
they decide, so latency does not separate the cases either. Treat the response
as an acknowledgement that the request was accepted, never as confirmation that
an account exists; the portal's own pages word their confirmations as
conditionals for the same reason.

What actually happened is recorded in the audit log
(`auth.verification_resend`, `auth.password_reset_request`), which is only
written when a link was really issued.

The only errors these routes return are `400 VALIDATION_FAILED` for a malformed
body and `429 RATE_LIMITED` from the shared `/api/auth/*` limiter.

### `POST /api/auth/resend-verification`

_public_, CSRF-exempt. Body `{ "email": string }` (valid address, ≤ 320 chars).

Queues a fresh 24-hour verification link when the address belongs to an active,
unverified account and no verification link was issued for it in the last 10
minutes. A new link supersedes the previous one, which stops working
immediately.

### `POST /api/auth/forgot-password`

_public_, CSRF-exempt. Body `{ "email": string }` (valid address, ≤ 320 chars).

Queues a password-reset link when the address belongs to an active account and
no reset link was issued for it in the last 10 minutes. The link points at
`<public URL>/reset-password?token=…` and expires after one hour
(`PASSWORD_RESET_TTL_SECONDS`).

### `POST /api/auth/reset-password`

_public_, CSRF-exempt.

| Field          | Type   | Notes                                            |
| -------------- | ------ | ------------------------------------------------ |
| `token`        | string | 8–512 chars, from the emailed link.              |
| `new_password` | string | ≥ 12 characters (`MIN_PASSWORD_LENGTH`), ≤ 1024. |

```json
{ "ok": true }
```

Redeeming a link burns it, sets the new password, marks the address verified
(reading the mailbox is what verification ever proved), invalidates any other
outstanding reset link for the account, and **terminates every session the
account has** — including the caller's, whose cookies are cleared on the
response. Sign in again afterwards.

Errors: `400 VALIDATION_FAILED` for a token that is unknown, expired or already
spent — deliberately one code and one message for all three, so a caller
holding a guessed token learns nothing — and for a password below the minimum
length (checked before the token is spent, so a rejected password does not
waste the link). `403 USER_DISABLED` when the account has been disabled.

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
  "captcha": { "enabled": false, "provider": "none", "site_key": null },
  "bootstrap_required": false
}
```

`bootstrap_required` is `true` only while the portal has no accounts at all: the
next registration elects the founding `super_admin` and must therefore send
`bootstrap_token`. The flag says that the portal is empty and nothing else — the
token is never public.

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

_admin_ — `Paginated<User>` plus `pending_gateway_teardowns`: the portal-wide
count of disabled accounts whose gateway credentials have **not** been revoked
yet. Anything above zero means the teardown worker is still retrying against
Edge.

| Query             | Type                                                        |
| ----------------- | ----------------------------------------------------------- |
| `role`            | `client` \| `provider` \| `admin` \| `super_admin`          |
| `status`          | `active` \| `disabled`                                      |
| `org_id`          | uuid                                                        |
| `q`               | substring match on email or display name (case-insensitive) |
| `limit`, `offset` | pagination                                                  |

### `GET /api/users/:id`

_admin_ → `{ "user": User, "gateway_teardown": GatewayTeardownState | null }`.

`gateway_teardown` is the account's outstanding (or completed) gateway
revocation, and is `null` for an account that never had one:

```json
{
  "status": "pending",
  "attempts": 3,
  "last_error": "Ferrum Edge returned 500",
  "next_attempt_at": "2026-09-04T09:12:00.000Z",
  "updated_at": "2026-09-04T09:11:20.000Z",
  "completed_at": null
}
```

### `PATCH /api/users/:id`

_admin_ — role, status, organization and display name.

| Field          | Type                   |
| -------------- | ---------------------- |
| `role`         | any of the four roles  |
| `status`       | `active` \| `disabled` |
| `org_id`       | uuid \| null           |
| `display_name` | string, 1–200          |

→ `{ "user": User, "gateway_teardown"?: "ok" | "no_consumer" | "pending" }`.

`gateway_teardown` is present **only when this request disabled the account**.
`pending` means the portal account is off but its Ferrum Edge credentials are
still live and the teardown worker is retrying — the security operation is not
complete. There is no `failed` value: a failure is a retry, not an outcome.

Guards enforced in the service:

- **Only a `super_admin` may confer or remove admin power.** A plain `admin`
  can move accounts between `client` and `provider` and nothing else — neither
  promoting to `admin` nor demoting an existing one → `403 FORBIDDEN`.
- Only a `super_admin` may disable an `admin` or `super_admin` →
  `403 FORBIDDEN`.
- Demoting or disabling the **last active `super_admin`** →
  `409 LAST_SUPER_ADMIN`. This is checked before the self-disable rule, so it is
  also what you get for disabling yourself while you are the last one.
- Disabling **your own** account in any other case → `409 CONFLICT`.
- Disabling an account deletes every session it holds, and queues the gateway
  revocation as durable work inside the same transaction.
- Re-enabling an account (`status: "active"`) cancels any queued revocation, so
  a retry can never strip a live account's credentials.
- `404 NOT_FOUND` when `org_id` names an organization that does not exist.

### `POST /api/users/:id/gateway-teardown/retry`

_admin_ — re-run a disabled account's gateway revocation immediately, instead of
waiting for the worker's backoff. Idempotent; audited as
`user.gateway_teardown_retry`.

→ `{ "gateway_teardown": "ok" | "no_consumer" | "pending", "job": GatewayTeardownState | null }`

- `409 CONFLICT` when the account is not `disabled` — an active account's
  consumer is supposed to work.
- `404 NOT_FOUND` when the account does not exist.

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

**The two write routes are bounded.** Reads are not limited; `POST /api/threads`
takes 10 requests per minute and `POST /api/threads/:id/messages` takes 30, both
counted **per account** (not per IP) and both active only when
`NEXUS_RATE_LIMIT_ENABLED=true` (the default; always off under
`NEXUS_ENV=test`). Exceeding either is `429 RATE_LIMITED`. Independently, one
account may post `NEXUS_MAX_MESSAGES_PER_USER_PER_DAY` messages (default 200,
`0` disables) in a rolling 24 hours across _every_ thread, direct and platform
alike; exceeding that is `429 QUOTA_EXCEEDED`. A refusal from either bound
writes no message, audit, notification or email row.

Recipients get at most one `message_received` email per thread per 10 minutes
however many messages arrive, so the mail announces new activity and links to
the thread rather than quoting one message. In-app notifications stay one per
message.

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
`404 NOT_FOUND` (unknown or disabled recipient, unknown API),
`429 RATE_LIMITED` (more than 10 a minute from this account),
`429 QUOTA_EXCEEDED` (the account's rolling 24-hour message budget is spent —
`details` carries `{ limit, window: "24h", setting: "NEXUS_MAX_MESSAGES_PER_USER_PER_DAY" }`).

### `GET /api/threads/:id`

_session_ — the thread plus its full message list (`MessageThreadDetail`), each
message carrying a `sender` summary. Participants always; admins for oversight.
`403 FORBIDDEN` otherwise.

### `POST /api/threads/:id/messages`

_session_ → `201 { "message": Message }`. Body `{ "body": string }` (1–10 000).
Participants may post; an admin may post into any _platform_ thread.

Errors: `400 VALIDATION_FAILED` (empty body), `403 FORBIDDEN` (not a
participant), `404 NOT_FOUND` (unknown thread), `429 RATE_LIMITED` (more than 30
a minute from this account), `429 QUOTA_EXCEEDED` (the account's rolling
24-hour message budget is spent — it is the same budget `POST /api/threads`
draws on).

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
`god/*` endpoints additionally require _super_admin_, and so do the `smtp` and
`captcha` sections of `PUT /settings`.

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
  },
  "gateway": { "public_url": "https://api.example.com" }
}
```

`gateway.public_url` is the stored override when one is set, otherwise the
`FERRUM_GATEWAY_PUBLIC_URL` environment default, otherwise `null`.

### `PUT /api/admin/settings`

_admin_, except `smtp` and `captcha` which are **_super_admin_** — partial
update; **omitted sections are untouched**, and omitted fields inside a supplied
section keep their current value.

A body carrying an `smtp` or `captcha` section from an ordinary `admin` is
refused with `403 FORBIDDEN` and nothing is written — not even the sections that
would have been allowed. Mail and CAPTCHA are escalation surfaces, not
preferences: repointing SMTP delivers every verification and password-reset link
to the operator, and CAPTCHA is the registration brake.

| Section        | Fields                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `branding`     | `portal_name` (1–120), `logo_data_url` (base64 image data URL, ≤ 512 KiB, nullable), `primary_color` / `accent_color` (CSS hex `#rgb`–`#rrggbbaa`), `default_theme` (`dark`\|`light`\|`system`), `tagline` (≤ 280, nullable), `support_email` (nullable)                                                                                                                                                     |
| `captcha`      | _super_admin_ — `enabled`, `provider` (`none`\|`recaptcha`\|`hcaptcha`\|`turnstile`), `site_key` (nullable), `secret_key` — **write-only**, stored AES-256-GCM encrypted; pass `null` or `""` to clear                                                                                                                                                                                                       |
| `smtp`         | _super_admin_ — `host`, `port` (1–65535), `secure`, `username`, `password` — **write-only**, encrypted; `null`/`""` clears — `from_address`. Changing `host`, `port`, `secure` or `username` while a password is stored (or set by env) requires sending a fresh `password` in the same request (`400 VALIDATION_FAILED` otherwise), so a stored credential can never be replayed against a different server |
| `registration` | `open_registration`, `require_email_verification`, `allowed_roles` (array of roles)                                                                                                                                                                                                                                                                                                                          |
| `gateway`      | `public_url` — absolute `http(s)` **origin** of the gateway's proxy listener, no path, query or credentials; a trailing slash is stripped. `null` or `""` clears the override and falls back to `FERRUM_GATEWAY_PUBLIC_URL`. Editable by any `admin`.                                                                                                                                                        |

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
{
  "user": { … },
  "revoked_grants": 3,
  "terminated_sessions": 2,
  "gateway_teardown": "ok"
}
```

Disables the account and destroys every session it holds. `gateway_teardown`
carries the same `"ok" | "no_consumer" | "pending"` values as
`PATCH /api/users/:id`, and `pending` means the same thing here: the gateway
credentials are still live and the revocation is queued for retry. Errors:
`409 LAST_SUPER_ADMIN` when the target is the last active super admin —
**including when that is you**, because "promote someone else first" is the
useful message; `409 CONFLICT` for any other attempt to disable your own
account.

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

**Two `429`s apply to the mutating routes here** — `POST /`, `PUT /:id/spec`,
`PATCH /:id`, `DELETE /:id`, `PUT|DELETE /:id/plugins/:name` and
`POST /:id/test-consumer`:

- `429 RATE_LIMITED` — more than **30 of them per minute** from one account
  (falling back to the IP for an anonymous caller). Installed when
  `NEXUS_RATE_LIMIT_ENABLED=true`, which is the default outside
  `NEXUS_ENV=test`. Reads are not limited, apart from `GET /:id/usage`, which
  keeps its own 30/min limit because it scrapes the gateway.
- `429 QUOTA_EXCEEDED` — on `POST /` only, when the account already owns
  `NEXUS_MAX_APIS_PER_OWNER` APIs (default 50; `0` disables the ceiling). The
  body carries `details: { limit, current, setting }`. The check runs before the
  first gateway write, so a refused publish creates nothing. Deleting an API
  frees a slot immediately; retiring one does not, because a retired API keeps
  its proxy and plugins on the gateway.

**A new proxy is never briefly open.** Every proxy is created on an unguessable
staging listen path, gets its auth, ACL, rate-limit and CORS plugins attached
and associated there, and is moved to `listen_path` as the last gateway write of
the request. Until then `listen_path` answers `404` — never an unauthenticated
`200`. The same is true while `spec_enforcement` is being switched, which
rebuilds the proxy.

Several fields of the returned `Api` object describe the gateway side of a
publication. `listen_path` and `invoke_url` are **derived, not stored**: they
are recomputed on every read from the namespace, the slug and the operator's
gateway origin, so moving the gateway never leaves a stale row behind. Both are
also present on the compact `ApiSummary` embedded in access requests, grants and
message threads.

| Field              | Type                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen_path`      | string                                           | always `/<namespace>/<slug>`, the path the gateway listens on                                                                                                                                                                                                                                                                                                                                                                                                 |
| `invoke_url`       | string \| null                                   | absolute URL a client calls: the configured gateway origin followed by `listen_path`, e.g. `https://api.example.com/nexus/billing`. `null` when neither `gateway.public_url` nor `FERRUM_GATEWAY_PUBLIC_URL` is set — Nexus never guesses an origin                                                                                                                                                                                                           |
| `upstream_url`     | string \| null                                   | the upstream Nexus last wrote to the gateway, normalized to `scheme://host:port[/basePath]` (the port always explicit, IPv6 hosts bracketed). `null` on older rows                                                                                                                                                                                                                                                                                            |
| `cors`             | `{ allowed_origins, allow_credentials }` \| null | the browser CORS policy. `null` means **no `cors` plugin at all** — the gateway adds no CORS headers, which is not the same as an empty allow-list                                                                                                                                                                                                                                                                                                            |
| `allowed_methods`  | `HttpMethod[]` \| null                           | methods the gateway accepts; `null` accepts every one. This is the **provider's** list: the copy on the proxy additionally carries `OPTIONS` whenever `cors` is set, because a method outside the list is `405`ed **before any plugin runs** and the browser preflight would never reach the `cors` plugin                                                                                                                                                    |
| `timeouts`         | `{ connect_ms, read_ms, write_ms }` \| null      | backend timeouts in milliseconds; `null` keeps the gateway defaults (5000 / 30000 / 30000). All three move together                                                                                                                                                                                                                                                                                                                                           |
| `circuit_breaker`  | boolean                                          | when true the proxy carries Edge's default `CircuitBreakerConfig` (5 failures to open, 3 successes to close, 30 s open, tripping on 500/502/503/504 and on connection errors); when false it carries none                                                                                                                                                                                                                                                     |
| `spec_enforcement` | `docs_only` \| `routes`                          | how much of the current OpenAPI revision the gateway enforces. `docs_only` (the default, and what every API published before this field existed reads back as) means the document is catalog metadata only; `routes` makes the proxy **spec-owned** — Edge imports the document and generates an `openapi_validator` that answers `400` for a path or method the document does not declare. **Request and response bodies are not validated at either level** |

`HttpMethod` is `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`,
`TRACE` or `CONNECT` — Edge's own enum.

An API's CORS origins are additionally mirrored onto the proxy's
`allowed_ws_origins`, which is the Cross-Site WebSocket Hijacking check: an
HTTP proxy on Edge also accepts WebSocket upgrades on the same listen path, and
the `cors` plugin does not run on an upgrade. Only plain `scheme://host[:port]`
origins are mirrored; `*` (and no policy at all) leaves the list empty, which
performs no check. There is no separate field for it — see
[security.md](security.md).

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

| Field              | Type                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | string                                           | 1–200, required                                                                                                                                                                                                                                                                                                                                                                                                |
| `slug`             | string                                           | ≤ 60, **optional** — derived from `name` when omitted; the listen path becomes `/<namespace>/<slug>`                                                                                                                                                                                                                                                                                                           |
| `description`      | string \| null                                   | ≤ 4000; falls back to `info.description` from the spec                                                                                                                                                                                                                                                                                                                                                         |
| `version`          | string                                           | ≤ 60, optional — defaults to the spec's `info.version`                                                                                                                                                                                                                                                                                                                                                         |
| `upstream_url`     | string                                           | ≤ 2000, **optional** when the document has an absolute `servers[0].url`                                                                                                                                                                                                                                                                                                                                        |
| `spec`             | string                                           | the OpenAPI 3.x document as JSON or YAML text, ≤ 2 MiB — required                                                                                                                                                                                                                                                                                                                                              |
| `auth_plugin`      | `key_auth` \| `basic_auth` \| `jwt_auth`         | required                                                                                                                                                                                                                                                                                                                                                                                                       |
| `requestable`      | boolean                                          | required — attaches `access_control` when true                                                                                                                                                                                                                                                                                                                                                                 |
| `visibility`       | `public` \| `internal`                           | required                                                                                                                                                                                                                                                                                                                                                                                                       |
| `rate_limit`       | `{ limit, window_seconds }` \| null              | optional; `limit` 1–1 000 000, `window_seconds` 1–86 400 — both are Edge's own ceilings                                                                                                                                                                                                                                                                                                                        |
| `cors`             | `{ allowed_origins, allow_credentials }` \| null | optional; `allowed_origins` is 1–64 whitespace-free strings of ≤ 255 characters, `allow_credentials` defaults to `false`. Omit it (or send `null`) and the API gets no `cors` plugin, so the gateway adds no CORS headers                                                                                                                                                                                      |
| `allowed_methods`  | `HttpMethod[]` \| null                           | optional; 1–9 entries from Edge's enum, duplicates collapsed. Omit it (or send `null`) to accept every method — an **empty array is rejected**, because a proxy whose `allowed_methods` is `[]` accepts nothing at all                                                                                                                                                                                         |
| `timeouts`         | `{ connect_ms, read_ms, write_ms }` \| null      | optional; each an integer 100–300 000 ms. All three are required together — the proxy `PUT` is a whole-resource replace, so a partial set would silently reset the rest. Omit it (or send `null`) for the gateway defaults                                                                                                                                                                                     |
| `circuit_breaker`  | boolean                                          | optional, defaults to `false`                                                                                                                                                                                                                                                                                                                                                                                  |
| `spec_enforcement` | `docs_only` \| `routes`                          | optional, defaults to `docs_only`. `routes` creates the proxy through Edge's API-spec importer instead of `POST /proxies`, so the gateway generates and attaches the `openapi_validator` itself — see [the provider guide](guides/provider-guide.md#enforcement-level). `400 SPEC_INVALID` with `details.reason = "no_operations"` when `routes` is asked for and the document declares no operations to allow |

```json
{ "api": { … }, "spec": { … } }
```

Errors: `400 SPEC_INVALID` (unparseable, Swagger 2.0, missing
`openapi`/`info.title`/`info.version`/`paths`, oversized, no upstream
determinable, or — unless `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true` — an upstream
that is a loopback, private, link-local or `.internal`/`.local` destination,
reported with `details.reason = "private_upstream"`. The host is **resolved**
as well as pattern-matched, so a name whose A/AAAA records point at a private
address is refused the same way, with the answers in `details.resolved`; a name
that cannot be resolved at all is refused with
`details.reason = "unresolvable_upstream"`), `409 CONFLICT` (slug taken),
`429 QUOTA_EXCEEDED` (the account already owns `NEXUS_MAX_APIS_PER_OWNER` APIs;
`details` is `{ limit, current, setting }`), `429 RATE_LIMITED`, `502 EDGE_ERROR` /
`502 EDGE_UNAVAILABLE`. The quota is checked before the first gateway call. A
failed Edge step is rolled back — the plugin configs and proxy are deleted — and
nothing is written to the Nexus store; because the proxy is still on its staging
path when anything before the final cutover fails, `listen_path` was never
served at all.

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

Every `stats` counter is about **access requests**, not traffic:
`total_requests` is how many access requests this API has ever received. For
calls through the gateway, see `GET /api/apis/:id/usage` below.

### `GET /api/apis/:id/usage`

_provider_, owner-or-admin — a cached read-through of what Ferrum Edge already
reports for this API's proxy. Nexus runs no metrics pipeline and stores no
history.

Two gateway endpoints back this route, both authenticated with the Nexus admin
JWT: `GET /metrics` (Prometheus exposition — `ferrum_requests_total` and the
`ferrum_request_duration_ms` histogram, filtered to this proxy and namespace)
and `GET /admin/metrics` (`circuit_breakers[]` and
`health_check.unhealthy_targets[]`). Nexus memoises both **per proxy for 10
seconds**; Edge caches its own rendering for 5.

```json
{
  "available": true,
  "sampled_at": "2026-09-03T10:15:00.000Z",
  "gateway_uptime_seconds": 86472,
  "requests": {
    "total": 1273,
    "by_status_class": { "2xx": 1240, "3xx": 1, "4xx": 25, "5xx": 7 },
    "by_status": { "200": 1200, "201": 40, "302": 1, "401": 5, "403": 2, "429": 18, "500": 7 },
    "by_method": { "GET": 1233, "POST": 40 },
    "rate_limited": 18,
    "unauthorized": 5,
    "forbidden": 2
  },
  "latency_ms": { "p50": 7.5, "p95": 375, "p99": 475 },
  "backend": {
    "status": "healthy",
    "detail": "The gateway's circuit breaker is closed; traffic is flowing to the backend."
  }
}
```

`backend.since` is present only when Edge reports one (an ejected target); it is
omitted, not `null`, otherwise. So is `gateway_uptime_seconds`.

What the numbers do and do not mean:

| Field                    | Meaning                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `available`              | `false` when the gateway could not be read, or the API has no proxy. The route still answers `200` — see below                                                                                                                                                                     |
| `requests.*`             | **cumulative since the gateway process started**. Edge exposes no per-proxy time window, so there is no "last 24h" here; a gateway restart resets every count to zero                                                                                                              |
| `latency_ms`             | percentiles interpolated from the gateway's histogram buckets, the same way `histogram_quantile` does — accurate only to the width of the bucket a quantile lands in. A quantile in the open-ended top bucket reports the highest finite bound. `null` when the histogram is empty |
| `gateway_uptime_seconds` | how far back the cumulative counters reach. Omitted when the gateway did not report it                                                                                                                                                                                             |
| `backend.status`         | `healthy` (closed breaker), `failing` (open breaker, or an ejected target), `recovering` (half-open breaker), `unknown`                                                                                                                                                            |
| `backend.since`          | when the backend started failing, present only for an ejected target — Edge attaches no timestamp to a breaker                                                                                                                                                                     |

`unknown` is **not** a claim that the backend is down. Edge lists a circuit
breaker only for a proxy that has one configured _and_ has been called, so
`unknown` is the ordinary state for an API with no `circuit_breaker` and for one
nothing has called yet; `detail` says which.

There is deliberately **no per-consumer breakdown and no unique-consumer
count**: `ferrum_requests_total` carries no consumer label, so neither can be
answered honestly from the gateway.

Errors: `403 FORBIDDEN` (not the owner and not an admin), `404 NOT_FOUND`. A
gateway that is unreachable, erroring or serving an unparseable body is **not**
an error — it answers `200` with `available: false`, zeroed counters,
`latency_ms: null` and `backend.status: "unknown"`. A provider's overview page
must not break because Edge is restarting.

```bash
curl -sS -b cookies.txt http://127.0.0.1:8787/api/apis/$API_ID/usage | jq .
```

### `PATCH /api/apis/:id`

_provider_, owner-or-admin — safe runtime settings only; the spec has its own
route. Every field optional; nothing supplied returns the row unchanged.

| Field                            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `description`, `version` | metadata only                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `visibility`                     | `public` ⇄ `internal`; catalog listing only                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `status`                         | `published` ⇄ `retired` — **catalog state only**, the proxy and every live grant keep working                                                                                                                                                                                                                                                                                                                                                                              |
| `upstream_url`                   | re-points the Edge proxy's backend and records the normalized form on the row; everything else on the proxy is left as it was found                                                                                                                                                                                                                                                                                                                                        |
| `auth_plugin`                    | attaches and associates the new auth plugin config before detaching and deleting the old one; existing credentials of the old flavour no longer satisfy this API, and every grantee is notified                                                                                                                                                                                                                                                                            |
| `requestable`                    | attaches or deletes `access_control`. Turning it **off** opens the API to every authenticated consumer; existing grants stay on the consumers and become inert                                                                                                                                                                                                                                                                                                             |
| `rate_limit`                     | attaches, replaces, or (with `null`) deletes `rate_limiting`; `limit` 1–1 000 000                                                                                                                                                                                                                                                                                                                                                                                          |
| `cors`                           | attaches, replaces, or (with `null`) deletes `cors`. Omitting the field leaves the existing policy alone — only an explicit `null` removes it. Also re-derives the proxy's `allowed_ws_origins` and the `OPTIONS` entry of its `allowed_methods`. It does **not** touch a `routes` API's operation table: `cors` runs at priority 100 and `openapi_validator` at 2960, so a browser preflight is answered and short-circuited before the unknown-operation check ever runs |
| `allowed_methods`                | replaces the method allow-list, or (with `null`) accepts every method again. Omitting it leaves the list alone                                                                                                                                                                                                                                                                                                                                                             |
| `timeouts`                       | replaces all three backend timeouts, or (with `null`) writes the gateway defaults back explicitly. Omitting it leaves whatever is on the proxy alone, including values an operator set by hand                                                                                                                                                                                                                                                                             |
| `circuit_breaker`                | attaches Edge's default breaker config to the proxy, or removes it                                                                                                                                                                                                                                                                                                                                                                                                         |
| `spec_enforcement`               | **rebuilds the proxy.** `routes` recreates it through the API-spec importer from the API's **current** spec revision; `docs_only` recreates it as a plain proxy. Omitting the field leaves the level alone. See the note below — the API is briefly unreachable                                                                                                                                                                                                            |

→ `{ "api": Api }`. Errors: `400 SPEC_INVALID` (bad or, by default, private
`upstream_url` — see `POST /api/apis`; or `details.reason = "no_operations"`
when `routes` is asked for and the current revision declares nothing to allow),
`502 EDGE_ERROR`.

> **Changing `spec_enforcement` interrupts the API for a moment.** Edge attaches
> an `api_spec` to a proxy only at import, detaches one only by deleting the
> proxy, and refuses a spec naming a proxy id that already exists — so the only
> way to move between the two modes is to delete the proxy and build it back.
> Nexus does that under the **same proxy id**, and carries the whole proxy
> document and every plugin config across with their original ids, so nothing
> that holds one of those ids breaks. For the handful of round trips in between,
> the listen path answers `404`. The audit row carries `proxy_rebuilt: true`.
>
> Nothing else does this: a spec revision, a CORS change and every runtime
> setting are all in-place writes.

### `DELETE /api/apis/:id`

_provider_, owner-or-admin → `{ "ok": true }`.

Destructive and ordered deliberately: the Edge proxy is deleted **first** (so
nothing stays reachable-but-untracked, and so the API never spends the teardown
live with its auth plugin already gone), which cascades its plugin associations
and proxy-scoped plugin configs; any config the cascade missed is swept up
after. Then the ACL group is stripped from every grantee's consumer, then the
grants, requests, spec revisions and the API row are deleted in one store
transaction. Grantees get a notification.

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
upstream, the document stops being authoritative for it. When the backend does
move, `upstream_url` on the row moves with it, in the same store transaction as
the revision; when it does not, `upstream_url` is left alone.

An API in `routes` mode has its document re-submitted to the gateway, which
regenerates the operation table from it. That single call also carries the
backend move, because Edge re-inserts the proxy from the submitted document — a
separate proxy write would only be overwritten by it. The same compensation
applies: the gateway moves first, and if the revision cannot be persisted the
previous document is put back. Plugin configs Nexus owns are untouched by the
re-submission, so the API is never unauthenticated across it.

`400 SPEC_INVALID` with `details.reason = "no_operations"` when the new document
declares nothing to allow — switch the enforcement level back to `docs_only`
first if that is really the intent.

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

## Plugin palette

Three routes under `/api/apis/:id/plugins`, _provider_ and owner-or-admin like
the rest of the publishing plugin. They carry **state only**: which curated
Edge plugins this API has switched on, and how each is configured.

The palette itself — which plugins exist, what fields each takes, and within
what bounds — is the static `PROVIDER_PLUGINS` catalog exported from
`@ferrum-nexus/shared`, which both the server and the SPA import. There is no
route to fetch it, because there is nothing per-deployment about it.

### The `ApiPlugin` object

| Field         | Type                       | Notes                                                                                                                                                                                                                       |
| ------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin_name` | string                     | the exact Ferrum Edge plugin name, always one of `PROVIDER_PLUGINS`                                                                                                                                                         |
| `enabled`     | boolean                    | `false` keeps the gateway config **and its association with the proxy**, but Edge does not run it — a pause, not a removal, so the settings survive                                                                         |
| `config`      | object                     | exactly the keys that plugin's descriptor declares. Edge's config key sets are closed, so an extra key is a `400` from the gateway rather than a silently ignored field; Nexus rejects it first, as `400 VALIDATION_FAILED` |
| `trigger`     | `ApiPluginTrigger` \| null | restrict the plugin to some methods and/or a path prefix; `null` means it runs on every request                                                                                                                             |
| `created_at`  | ISO-8601                   | when the plugin was first switched on; survives a replace                                                                                                                                                                   |
| `updated_at`  | ISO-8601                   | last save                                                                                                                                                                                                                   |

`ApiPluginTrigger` is `{ methods?: HttpMethod[], path_prefix?: string }` — the
portal's slice of Edge's predicate tree. At least one of the two must be
present; both together are an AND. `path_prefix` is matched against the
**canonical request path**, which includes the API's `listen_path`, and must
start with `/` and contain no whitespace, percent escape, backslash or `.`/`..`
segment — the canonical path never contains any of those, so such a prefix
could only ever fail to match.

**Not every plugin accepts a trigger.** Edge refuses one on a plugin that
publishes contextless initial-response-header policy (`security_headers`), a
fixed per-proxy body ceiling (`request_size_limiting`,
`response_size_limiting`) or contextless response-trailer ownership
(`compression`, `correlation_id`, and `response_caching` at its default
`add_cache_status_header`). Each descriptor records this as `supports_trigger`;
sending a trigger for one of them is `400 VALIDATION_FAILED`.

### `GET /api/apis/:id/plugins`

_provider_, owner-or-admin → `{ "plugins": ApiPlugin[] }`, oldest first.

### `PUT /api/apis/:id/plugins/:name`

_provider_, owner-or-admin → `{ "plugin": ApiPlugin }`. Creates or replaces.

```json
{
  "enabled": true,
  "config": { "allow": ["203.0.113.0/24"], "mode": "allow_first" },
  "trigger": { "methods": ["POST"], "path_prefix": "/nexus/billing/invoices" }
}
```

`enabled` defaults to `true`; `trigger` may be omitted or `null`. `config` is
validated against the named plugin's descriptor **before any gateway write**,
so an unknown key, an out-of-range value or a broken per-plugin invariant is a
`400 VALIDATION_FAILED` with field-level `details` rather than a partly
attached plugin.

The gateway side is a proxy-scoped plugin config plus its entry in the proxy's
`plugins[]` — the same mechanism as `rate_limiting` and `cors`. A replace keeps
the config id, so the association is never touched and there is no window in
which the plugin is missing. The `api_plugins` row is written last but inside
the same compensated block, so a store failure rolls the gateway back rather
than leaving a plugin running that the portal has no row for.

| Status | Code                | When                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_FAILED` | a config key, value or invariant the plugin does not accept; a trigger on a plugin Edge cannot gate; or a plugin Nexus manages from a first-class API field (`key_auth`/`basic_auth`/`jwt_auth` → `auth_plugin`, `access_control` → `requestable`, `rate_limiting` → `rate_limit`, `cors` → `cors`, `openapi_validator` → `spec_enforcement`), whose message names that field |
| `403`  | `FORBIDDEN`         | not the owner and not an admin                                                                                                                                                                                                                                                                                                                                                |
| `404`  | `NOT_FOUND`         | the API, or an Edge plugin outside the palette                                                                                                                                                                                                                                                                                                                                |
| `409`  | `CONFLICT`          | the API has no gateway proxy to attach anything to                                                                                                                                                                                                                                                                                                                            |

### `DELETE /api/apis/:id/plugins/:name`

_provider_, owner-or-admin → `{ "ok": true }`.

Disassociates the config from the proxy, deletes it, then removes the row —
`404 NOT_FOUND` when the API never had that plugin. A gateway config an
operator already removed by hand is tolerated: the row still goes.

Deleting the API removes every palette row with it; the gateway objects need no
separate step, because they are proxy-scoped and the proxy delete cascades them.

### What the palette does not cover

The auth family (`hmac_auth`, `jwks_auth`, `oauth2_introspection`, `mtls_auth`)
and `spec_expose` are **not** in the palette. The first four change the
credential model — Nexus would need credential types, issue/rotate flows and
show-once material for each — and `spec_expose` needs a canonical public spec
endpoint. Operator plugins (logging sinks, telemetry, mesh, chaos, load
testing) are deliberately out of scope: they are how you run the gateway, not
how you sell an API. See [the provider guide](guides/provider-guide.md#plugins).

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
deleted first — and marked `revoked` the moment Edge confirms it — leaving a
brief window with no working credential of that type. If the append then fails,
the response says so plainly (`502 EDGE_ERROR`, _the previous credential was
removed … issue a new credential_); everything still live stays revocable.

An **admin may rotate another account's credential**, and doing so does not
transfer it: the replacement keeps the original `user_id` and consumer, the
owner keeps seeing and revoking it, and the admin appears only as the actor on
the audit row and as the subject of the Edge write. The notification and email
go to the owner.

Errors: `403 FORBIDDEN` (someone else's credential), `403 USER_DISABLED` (the
owner's account was disabled), `409 CONFLICT` (already revoked), `502
EDGE_ERROR` — including the case where the gateway's credential list no longer
matches the portal's view, which is refused rather than guessed at.

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
