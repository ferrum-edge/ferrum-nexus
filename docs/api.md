# Nexus REST API reference

Every endpoint the Ferrum Nexus backend exposes. All of them live under `/api`,
speak JSON and authenticate with cookies. The SPA's client is
`web/src/lib/api.ts`; the wire types are in
[`shared/src/api-contract.ts`](../shared/src/api-contract.ts) and
[`shared/src/entities.ts`](../shared/src/entities.ts). Route plugins are
registered in [`server/src/index.ts`](../server/src/index.ts) and live in
`server/src/routes/`.

- [Conventions](#conventions)
- [Error envelope and codes](#error-envelope-and-codes)
- [Health](#health) · [Auth](#auth) · [Branding](#branding) ·
  [Users](#users) · [Organizations](#organizations) · [Threads](#threads) ·
  [Notifications](#notifications) · [Admin](#admin) · [Catalog](#catalog) ·
  [APIs (publishing)](#apis-publishing) · [Plugin palette](#plugin-palette) ·
  [Access requests](#access-requests) · [Grants](#grants) ·
  [Credentials](#credentials) · [Applications](#applications)

---

## Conventions

### Authentication

Sign in with `POST /api/auth/login`. The response sets two cookies:

| Cookie          | Flags                                                                                                          | Contents             |
| --------------- | -------------------------------------------------------------------------------------------------------------- | -------------------- |
| `nexus_session` | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` unless `NEXUS_COOKIE_SECURE=false`, `Max-Age=NEXUS_SESSION_TTL` | opaque session token |
| `nexus_csrf`    | same, but **not** `HttpOnly`                                                                                   | the CSRF token       |

Send cookies on every request (`credentials: 'include'` in the browser).
Sessions last `NEXUS_SESSION_TTL` (default 12 hours) and slide: a request made
when less than half the TTL remains extends the session and re-stamps both
cookies with the same values.

### CSRF

Every mutating request (not `GET`/`HEAD`/`OPTIONS`) under `/api` that carries a
session must send:

```
X-Nexus-CSRF: <value of the nexus_csrf cookie>
```

The header must equal both the cookie **and** the token stored on the session
row, otherwise `403 CSRF_MISMATCH`.

Exempt, because they run before a session exists: `POST /api/auth/login`,
`/register`, `/verify-email`, `/resend-verification`, `/forgot-password`,
`/reset-password` and `GET /api/auth/captcha`. **`POST /api/auth/logout` is not
exempt.**
The single sign-on `start` and `callback` routes are `GET`s; the sealed `state`
is what binds a callback to the browser that started it.
`POST /api/auth/sso/:provider/link` carries a session and is checked.

### Auth requirement markers

| Marker        | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| _public_      | no session needed                                                |
| _session_     | any signed-in, active account                                    |
| _provider_    | role `provider` or higher (`provider` < `admin` < `super_admin`) |
| _admin_       | role `admin` or higher                                           |
| _super_admin_ | role `super_admin` only                                          |

A higher role satisfies a lower requirement. Route guards check the role;
row-level ownership ("is this your API?") is checked in the service and answers
`403 FORBIDDEN` — except where noted (the catalog, applications, revisions),
which answer `404 NOT_FOUND` so they never confirm that something you may not
see exists.

### Pagination

Every list endpoint accepts `limit` (integer, `1`–`200`, default `25`) and
`offset` (integer ≥ 0, default `0`) and answers:

```json
{ "items": [ … ], "total": 137 }
```

`total` counts every row matching the filters, ignoring `limit`/`offset`. Query
booleans accept `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`.

### Rate limits

Every limiter below is installed only when `NEXUS_RATE_LIMIT_ENABLED=true` (the
default; always off under `NEXUS_ENV=test`) and answers `429 RATE_LIMITED`.
Counters are per process, so N instances allow N × the limit; enforce
aggregate limits at the proxy. Client IPs come from Fastify's configured proxy
trust, not from an untrusted forwarded header.

| Scope                                                                          | Limit per minute | Keyed by |
| ------------------------------------------------------------------------------ | ---------------- | -------- |
| `/api/health*`                                                                 | 120              | IP       |
| `/api/branding`                                                                | 120              | IP       |
| Every `POST /api/auth/*` route, and the SSO `start` and `callback`             | 20, shared       | IP       |
| `GET /api/auth/me`, `GET /api/auth/captcha`, `GET /api/auth/sso`               | 120, shared      | IP       |
| `PATCH /api/users/me`                                                          | 10               | account  |
| `PATCH /api/users/me/notification-preferences`                                 | 10               | account  |
| `POST /api/threads`                                                            | 10               | account  |
| `POST /api/threads/:id/messages`                                               | 30               | account  |
| `GET /api/catalog/:slug/spec`, `…/changes`, `…/changes/:revisionId`, per route | 60               | account  |
| `/api/apis` mutations and the two spec diffs, per route                        | 30               | account  |
| `GET /api/apis/:id/usage`                                                      | 30               | IP       |
| `POST /api/access-requests`                                                    | 10               | account  |
| `POST /api/access-requests/:id/cancel`                                         | 30               | account  |
| `POST`, `PATCH`, `DELETE` on `/api/applications`, per route                    | 30               | account  |

"Account" falls back to the IP for a request without a session. Every other
route is unlimited.

### Other conventions

- Ids are opaque strings (UUIDs); timestamps are ISO-8601 strings.
- Optional values are `null` rather than omitted, except where a field is
  marked as present only in some cases.
- Request bodies are `application/json`, at most 4 MiB. An OpenAPI document is
  additionally capped at 2 MiB and by structural limits (see
  [`POST /api/apis`](#post-apiapis)).
- All `/api` responses carry `cache-control: no-store` unless stated otherwise.
  Any response that sets or clears a cookie carries
  `cache-control: private, no-store` and `vary: Cookie` on every Fastify reply.
  An unmatched `/api/*` path answers a JSON `404 NOT_FOUND`.

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

`code` is stable and safe to branch on
([`shared/src/error-codes.ts`](../shared/src/error-codes.ts)); `message` is for
humans and may change; `details` appears only when there is structured context.

| Code                                      | HTTP | When                                                                                                                                                        |
| ----------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`                       | 400  | Body, query or params failed validation (also an oversized or malformed body).                                                                              |
| `UNAUTHORIZED`                            | 401  | No valid session, or it expired.                                                                                                                            |
| `FORBIDDEN`                               | 403  | Authenticated, but the role or ownership check failed.                                                                                                      |
| `NOT_FOUND`                               | 404  | Target does not exist, or is not visible to the caller.                                                                                                     |
| `CONFLICT`                                | 409  | Uniqueness or state conflict (duplicate email/slug, active grant, already decided), or contention — see below.                                              |
| `CSRF_MISMATCH`                           | 403  | `X-Nexus-CSRF` missing or not matching the cookie/session.                                                                                                  |
| `CAPTCHA_FAILED`                          | 400  | CAPTCHA token missing, expired, or rejected by the vendor.                                                                                                  |
| `CAPTCHA_SELF_TEST_FAILED`                | 400  | A CAPTCHA settings change could not prove its own configuration; nothing is stored. `details.reason`: `token_required`, `rejected`, `provider_unreachable`. |
| `RATE_LIMITED`                            | 429  | Too many requests; clears on its own.                                                                                                                       |
| `QUOTA_EXCEEDED`                          | 429  | A configured allowance is used up. `details` names the limit and the `setting` (environment variable) an operator would raise.                              |
| `EMAIL_NOT_VERIFIED`                      | 403  | The account's email is unverified and verification is required.                                                                                             |
| `USER_DISABLED`                           | 403  | The account has been disabled.                                                                                                                              |
| `LAST_SUPER_ADMIN`                        | 409  | Would demote or disable the last active `super_admin`.                                                                                                      |
| `ACCESS_DISRUPTION_CONFIRMATION_REQUIRED` | 409  | The change would cut live callers off and was not confirmed. Only an `auth_plugin` change on `PATCH /api/apis/:id` — see there.                             |
| `SHOW_ONCE_ALREADY`                       | 410  | Reserved for show-once material already retrieved. No current endpoint returns it.                                                                          |
| `EDGE_UNAVAILABLE`                        | 502  | Ferrum Edge Admin API unreachable (network error, timeout).                                                                                                 |
| `EDGE_ERROR`                              | 502  | The Admin API returned an error response.                                                                                                                   |
| `EDGE_REJECTED_SPEC`                      | 400  | Edge refused an API spec as unparseable or invalid.                                                                                                         |
| `EDGE_PROTOCOL_ERROR`                     | 502  | The Admin API sent an invalid HTTP/JSON response.                                                                                                           |
| `EDGE_NAMESPACE_UNSERVED`                 | 409  | The gateway's data plane does not route `FERRUM_NAMESPACE`.                                                                                                 |
| `SPEC_INVALID`                            | 400  | The uploaded OpenAPI document could not be parsed or failed validation.                                                                                     |
| `OUTBOX_FAILURE`                          | 500  | Email could not be enqueued, or exhausted its outbox retries.                                                                                               |
| `INTERNAL`                                | 500  | Unexpected server-side failure.                                                                                                                             |

**Gateway errors.** These can come from any endpoint that calls Edge and are not
repeated per endpoint:

- Non-GET `/consumers` writes can carry show-once credential material. Their
  `EDGE_ERROR` messages are fixed, and details contain only safe status and
  classification fields. Edge error text and response objects are omitted from
  these logs and errors. A `503` with `applied: false` carries
  `kind: "write_durable_not_live"`; another write `503` carries
  `kind: "write_acknowledgement_uncertain"`.
- Other `EDGE_ERROR` validation refusals (`400`, `409`, `422`) carry
  `details: { status, gateway_message }`: Edge's own text, trimmed to 500
  characters, also repeated in `message`. A `401`, `403` or `5xx` from the
  gateway stays opaque; its text only reaches the server log.
- `EDGE_REJECTED_SPEC` covers an API-spec write (publish, spec revision,
  enforcement conversion) that Edge rejects with a 4xx `Spec parse failed` or
  `Spec validation failed` (401/403 remain `EDGE_ERROR`). `details` carries the
  upstream `status`, `gateway_message` and, when Edge supplies one,
  `gateway_code`, each capped at 500 characters. The full response is logged,
  not reflected.
- `EDGE_PROTOCOL_ERROR` carries `details` with `status`,
  `kind: "protocol_error"` and a fixed `reason` such as `invalid_utf8`.
  Response bytes and parser exceptions are never included. See
  [Edge response contracts](edge-response-contracts.md).
- `EDGE_NAMESPACE_UNSERVED` carries `details` with `configured_namespace`,
  `active_namespace`, `serving_scope` and `setting: "FERRUM_NAMESPACE"`. The
  Admin API would accept the write, but the resulting `invoke_url` would answer
  `404`.
  Only operations that create or move a proxy onto a public path are refused —
  `POST /api/apis`, `PUT /api/apis/:id/spec`, spec rollback and
  `POST /api/apis/:id/restore-gateway`; reads, runtime `PATCH`es and `DELETE`
  keep working so the mismatch can be cleaned up. A gateway that does not
  report its namespace is never refused. See
  [`edge.namespace_routing`](#is-the-published-api-actually-reachable) and
  [`operations.md`](operations.md#namespace-routability).

**Contention.** A write rolled back because another touched the same rows
(InnoDB deadlock, PostgreSQL serialization failure, MongoDB write conflict) is
retried by the server with backoff. If it still cannot commit, the answer is
`409 CONFLICT` with `details.reason: "transaction_contention"` (plus `driver`
and `attempts`); nothing was applied and the request can be resent. Operations
that
serialize on a per-resource lease (a proxy, a consumer, a sender) answer
`409 CONFLICT` after waiting 30 seconds for it; retry.

`UNAUTHORIZED`, `FORBIDDEN`, `CSRF_MISMATCH`, `USER_DISABLED` and
`VALIDATION_FAILED` can come from any endpoint and are not repeated below.

---

## Health

Registered under `/api/health`; _public_.

Database and gateway probes are **cached for `NEXUS_HEALTH_CACHE_MS`** (default
5 s, `0` disables) and concurrent callers share one in-flight probe, so a burst
costs one database query and one Admin API call. A failing probe is cached for
the same window. `checked_at` is when the (older) probe ran, not when the
request arrived. See [`operations.md`](operations.md#9-health-checks).

### `GET /api/health`

_public_ — aggregate liveness/readiness.

**Status codes:** `200` for `ok` and `degraded`, `503` for `down`. Only a broken
database makes the portal `down`. Any gateway problem — `edge.status` of
`"down"` (unreachable), `"not_ready"` (answering but unready) or `"degraded"`
(not routing the portal's namespace) — leaves the portal `degraded` on a `200`, so a load
balancer keeps it in rotation. Orphaned gateway references also degrade it (see
below).

Example for an admin session:

```json
{
  "status": "ok",
  "version": "0.3.0",
  "uptime_seconds": 1284,
  "checked_at": "2026-08-31T09:12:44.117Z",
  "database": { "status": "ok", "latency_ms": 1, "error": null, "driver": "postgres" },
  "edge": {
    "status": "ok",
    "reason": null,
    "latency_ms": 7,
    "error": null,
    "ready": true,
    "mode": "database",
    "admin_writes_enabled": true,
    "edge_version": null,
    "namespace": "nexus",
    "namespace_routing": {
      "configured": "nexus",
      "active": "nexus",
      "serving_scope": "single-namespace-data-plane",
      "data_plane_single_namespace": true,
      "unserved": false,
      "unserved_mutation_observed": false,
      "checked_at": "2026-08-31T09:12:44.117Z"
    },
    "reconciliation": {
      "status": "ok",
      "checked_at": "2026-08-31T09:05:00.004Z",
      "orphaned_consumers": 0,
      "orphaned_proxies": 0,
      "awaiting_restore": 0,
      "complete": true
    }
  }
}
```

**Admin-only fields.** For anyone who is not a signed-in admin these are `null`:
`edge.mode`, `edge.admin_writes_enabled`, `edge.namespace_routing.active`,
`.serving_scope`, `.data_plane_single_namespace`, and the
`edge.reconciliation` counts (`orphaned_consumers`, `orphaned_proxies`,
`awaiting_restore`, `complete`). `database.error` is always the constant
`"unreachable"` (the driver's message goes to the server log); `edge.error` is
the real probe failure for an admin and `"unreachable"` for everyone else.

| Field               | Values and meaning                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`            | `ok` \| `degraded` \| `down`                                                                                                                                                                         |
| `version`           | the server package version                                                                                                                                                                           |
| `edge.status`       | `ok` \| `degraded` \| `not_ready` \| `down`                                                                                                                                                          |
| `edge.reason`       | why a `degraded` gateway is degraded; only value `"namespace_unserved"`; `null` otherwise                                                                                                            |
| `edge.ready`        | Edge's own readiness from its health payload; `null` when nothing answered. Edge answers `503` with a full payload while `starting`, `draining` or `unavailable`, which Nexus reports as `not_ready` |
| `edge.edge_version` | always `null` against a stock gateway — Edge has no version endpoint                                                                                                                                 |
| `edge.namespace`    | `FERRUM_NAMESPACE` on the portal                                                                                                                                                                     |

#### Is the published API actually reachable?

The Edge Admin API is multi-namespace, but one gateway process's data plane
serves exactly one namespace. Publish into any other and the Admin API answers
`201`, the proxy is listed, and the listener answers `404` forever.
`edge.namespace_routing` reports this:

- `configured` — `FERRUM_NAMESPACE` on the portal; where Nexus publishes.
- `active` — the one namespace the gateway's data plane routes.
- `serving_scope` — `single-namespace-data-plane`, `control-plane` or
  `no-data-plane`, from the gateway.
- `data_plane_single_namespace` — `true` when everything outside `active` is
  unrouted by that process.
- `unserved` — the verdict: `true` means APIs published here answer `404`.
- `unserved_mutation_observed` — a gateway write came back with
  `X-Ferrum-Namespace-Unserved: true`.
- `checked_at` — when the gateway last reported its namespace, or `null`.

`unserved` and `edge.reason` stay public so an anonymous monitor can alert on
them. A gateway that reports no namespace leaves `active` `null`, `unserved`
`false` and `checked_at` `null`: an unknown topology never degrades anything.

`edge.reconciliation` reports whether Edge still holds the consumer and proxy
ids Nexus stored — the failure after `FERRUM_ADMIN_URL` is retargeted at a fresh
gateway, or the gateway is rebuilt, when every probe stays green. `status` is:

- `ok` — every checked reference exists.
- `orphaned` — at least one reference is gone, or at least one API is still
  flagged `repair_required` (`awaiting_restore`). Degrades the portal.
- `unknown` — no pass has finished (`checked_at: null`), or the last one could
  not read the gateway. Degrades nothing on its own.

`complete` is `false` when the pass stopped at
`NEXUS_GATEWAY_RECONCILE_SAMPLE` references. **These endpoints never run a
pass**: they show the cached result of the background one (at startup, then
every `NEXUS_GATEWAY_RECONCILE_INTERVAL_MS`, default 15 minutes). Run one with
[`POST /api/admin/gateway/reconcile`](#post-apiadmingatewayreconcile); repair
with [`POST /api/admin/gateway/repair`](#post-apiadmingatewayrepair).

### `GET /api/health/edge`

_public_ — the `edge` object above on its own. Always `200`; the gateway's state
is in the body.

---

## Auth

Registered under `/api/auth`. See [Rate limits](#rate-limits) for the two
per-IP budgets.

### `POST /api/auth/register`

_public_ → `201`

| Field             | Type                       | Notes                                                                     |
| ----------------- | -------------------------- | ------------------------------------------------------------------------- |
| `email`           | string                     | Valid address, ≤ 320 chars. Stored lowercased; unique case-insensitively. |
| `password`        | string                     | 12–1024 characters (`MIN_PASSWORD_LENGTH` = 12).                          |
| `display_name`    | string                     | 1–200 chars.                                                              |
| `role`            | `"client"` \| `"provider"` | Ignored for the founding account.                                         |
| `company`         | string \| null             | optional, ≤ 200                                                           |
| `phone`           | string \| null             | optional, ≤ 64                                                            |
| `captcha_token`   | string                     | required when CAPTCHA is enabled                                          |
| `bootstrap_token` | string                     | **Required while the portal has no active `super_admin`**; ignored after. |

```json
{ "user": { "id": "…", "email": "…", "role": "client", … }, "email_verification_required": false }
```

- **While the portal has no active `super_admin`, the registration becomes
  one**, auto-verified, whatever `role` it asked for, and the registration
  policy is bypassed. It must carry `bootstrap_token` — `NEXUS_BOOTSTRAP_TOKEN`,
  or the per-process token printed in the startup log — or it is refused with
  `403 FORBIDDEN` and nothing is created. `GET /api/branding` reports
  `bootstrap_required` so a client knows when to ask for it.
- When verification is not required, the response also sets the session
  cookies and the user is signed in.
- Errors: `409 CONFLICT` (email taken), `403 FORBIDDEN` (missing or wrong
  `bootstrap_token`, registration closed, `role` not in `allowed_roles`, or
  the `sso_only` login policy — which never refuses the founding
  registration), `400 CAPTCHA_FAILED`.
- Unlike the recovery routes, this one reveals that an address is taken. The
  `409` is returned only after the password has been hashed, so it costs as
  long as a real registration; see
  [`security.md`](security.md#2-session-security).

```bash
curl -sS -X POST http://127.0.0.1:8787/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery-staple",
       "display_name":"Ada Lovelace","role":"client"}'
```

### `POST /api/auth/login`

_public_ — body: `email`, `password`, optional `captcha_token`.

```json
{ "user": { … }, "csrf_token": "…", "expires_at": "2026-08-31T21:12:44.117Z" }
```

Sets `nexus_session` and `nexus_csrf`; `csrf_token` is echoed so a non-browser
client need not parse cookies.

Errors: `401 UNAUTHORIZED` (wrong email _or_ password — indistinguishable by
design), `403 USER_DISABLED`, `403 EMAIL_NOT_VERIFIED`, `400 CAPTCHA_FAILED`,
`429 RATE_LIMITED`, `403 FORBIDDEN` under the `sso_only` login policy. With
`NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN=true` a `super_admin` may still sign in
there, and any other account gets the `401` a wrong password gets.

```bash
curl -sS -c cookies.txt -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery-staple"}'
```

### `POST /api/auth/logout`

_session_, **CSRF required** — destroys the session and clears both cookies.
Returns `{ "ok": true }`.

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

`capabilities` is derived from the role: the first two need `provider`, the next
three `admin`, and `can_use_god_mode` needs `super_admin`.

### `POST /api/auth/verify-email`

_public_ — body `{ "token": string }` (8–512 chars) → `{ "verified": true, "user": { … } }`.

Tokens are single-use and expire after 24 hours. Errors: `400 VALIDATION_FAILED`
(unknown or expired link), `409 CONFLICT` (already used).

### The anti-enumeration contract

`resend-verification`, `forgot-password` and `reset-password` accept input from
anyone, so they never reveal whether an account exists. The first two answer
`200 { "ok": true }` **in every case** — account or not, disabled, already
verified, or throttled — and cost the same time whatever they decide. What
really happened is in the audit log (`auth.verification_resend`,
`auth.password_reset_request`), written only when a link was issued. Their only
errors are `400 VALIDATION_FAILED` (malformed body) and `429 RATE_LIMITED`.

### `POST /api/auth/resend-verification`

_public_ — body `{ "email": string }` (≤ 320 chars).

Queues a fresh 24-hour verification link when the address belongs to an active,
unverified account and none was issued in the last 10 minutes. The new link
replaces the previous one.

### `POST /api/auth/forgot-password`

_public_ — body `{ "email": string }` (≤ 320 chars).

Queues a password-reset link to `<public URL>/reset-password?token=…` when the
address belongs to an active account and none was issued in the last 10
minutes. The link expires after one hour (`PASSWORD_RESET_TTL_SECONDS`), and
issuing it supersedes every earlier live reset link for the account, so only the
newest is valid.

### `POST /api/auth/reset-password`

_public_ — body `token` (8–512 chars, from the link) and `new_password`
(12–1024 characters) → `{ "ok": true }`.

Burns the link, sets the password, marks the address verified, invalidates
other reset links, and **ends every session of the account** — including the
caller's, whose cookies are cleared. Sign in again afterwards.

Errors: `400 VALIDATION_FAILED` for a token that is unknown, expired or spent
(one message for all three) or a password below the minimum (checked before the
token is spent); `403 USER_DISABLED`.

### `GET /api/auth/captcha`

_public_ — widget configuration; never the vendor secret.

```json
{ "enabled": true, "provider": "turnstile", "site_key": "0x4AAA…" }
```

`enabled` is `false` (with `site_key: null`) whenever there is no widget to
render: CAPTCHA off, no provider, no site key, no stored secret, or the server
runs with `NEXUS_CAPTCHA_ENFORCEMENT=disabled`. This answers "what should I
render", not "what will login accept": a half-configured portal can report
`enabled: false` and still refuse sign-in with `400 CAPTCHA_FAILED`, because
verification fails closed (see
[`PUT /api/admin/settings`](#put-apiadminsettings)).

### `GET /api/auth/sso`

_public_ — what the sign-in and registration pages offer. Shares the 120/min
bootstrap budget with `/me` and `/captcha`.

```json
{
  "policy": "local_and_sso",
  "password_login": "enabled",
  "registration_enabled": true,
  "providers": [{ "id": "corp", "display_name": "Corporate SSO" }]
}
```

- `policy`: `local_only` \| `sso_only` \| `local_and_sso`.
- `password_login`: `enabled`, `disabled` (`sso_only`), or `break_glass`
  (`sso_only` with `NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN=true`: only a
  `super_admin` can use a password).
- `registration_enabled` is `false` under `sso_only`; the founding registration
  with the bootstrap token is accepted anyway.
- `providers` lists the enabled providers, empty under `local_only`. Nothing
  else about a provider is public.

### `GET /api/auth/sso/:provider/start`

_public_, a browser navigation — begins an OpenID Connect sign-in. Optional
query: `return_to`, a same-origin portal path to land on afterwards (anything
else, including an absolute URL, `//host`, an `/api` path or `/login`, becomes
`/`).

→ `302` to the provider's authorization endpoint (authorization code, PKCE
`S256`, `state`, `nonce`), setting the sealed, `HttpOnly` `nexus_sso` cookie
(`Path=/api/auth/sso`, 10 minutes). When sign-in cannot start → `302` to
`/login?sso_error=<reason>`.

### `GET /api/auth/sso/:provider/callback`

_public_, a browser navigation — where the provider returns the browser
(`code`, `state`, or `error`). Always clears `nexus_sso`.

→ `302` back into the SPA (the `return_to` path) with the session cookies set,
exactly as `POST /api/auth/login` sets them; or `302` to
`/login?sso_error=<reason>` with nothing set (`/profile?sso_error=<reason>`
for a link started with `POST /api/auth/sso/:provider/link`). `reason` is one
of `sso_disabled`, `provider_unavailable`, `invalid_state`, `idp_error`,
`token_invalid`, `email_required`, `email_domain_not_allowed`,
`email_not_verified`, `account_exists`, `address_unproven`,
`privileged_account`, `link_session_mismatch`, `already_linked`,
`access_denied`, `account_disabled`, `signup_disabled`, `server_error` — see
[`operations.md` §14](operations.md#when-a-sign-in-fails). Provider error text
is never echoed. Audited as `auth.sso_login`, plus `auth.sso_provision`,
`auth.sso_link` or `auth.sso_claims_sync` when the sign-in did that too.

### `POST /api/auth/sso/:provider/link`

_authenticated_, **CSRF required** — begins linking the signed-in account to a
provider. Sets the sealed `nexus_sso` cookie, which also records this account
and session, and returns where to send the browser:

```json
{ "location": "https://idp.example.com/realms/corp/protocol/openid-connect/auth?…" }
```

The SPA navigates to `location`. The callback links whatever identity signs in
there to this account, whatever its email address, provided it returns to the
same session (`link_session_mismatch` otherwise) and the portal already holds a
recorded proof of the account's current address: a redeemed verification link,
a completed password reset, or an earlier provider-verified provisioning or
automatic link. Without one the link is refused with `address_unproven`, even
when the provider asserts `email_verified: true` for the same address. The
founding `super_admin`, seated with the bootstrap token, needs no proof. The
provider's own `allowed_email_domains` still apply, and a subject already
linked to another account, or a second identity at the same provider, is
refused (`already_linked`). It then lands on `/profile`. This is the only way
an `admin` or `super_admin` account is linked. Accepting the link records no
address proof. Audited as `auth.sso_link` with `explicit: true`.

Errors: `400 VALIDATION_FAILED` with `details.reason` (`sso_disabled`,
`provider_unavailable`, …) when the link cannot start, `401 UNAUTHORIZED`,
`403 CSRF_MISMATCH`.

---

## Branding

### `GET /api/branding`

_public_ — drives the sign-in page before a session exists.

The payload is cached for `NEXUS_BRANDING_CACHE_MS` (default 5 s; `0` disables)
and, when the cache is on, served with `Cache-Control: public, max-age=…` and an
`ETag`; send `If-None-Match` to get `304 Not Modified`. It never sets cookies:
a request carrying a session does not slide it here. A settings write clears
the cache on the instance that handled it; other instances catch up within the
TTL. `bootstrap_required: true` is never cached, so a founder seated on any
instance is reflected at once.

```json
{
  "portal_name": "Acme Developer Portal",
  "logo_data_url": "data:image/png;base64,…",
  "primary_color": "#f97316",
  "accent_color": "#38bdf8",
  "default_theme": "dark",
  "tagline": "APIs for partners",
  "support_email": "api-support@acme.example",
  "radius": "md",
  "font_preset": "system",
  "sidebar_style": "surface",
  "login_layout": "split",
  "footer_text": "© Acme Corp",
  "footer_links": [{ "label": "Terms", "url": "https://acme.example/terms" }],
  "captcha": { "enabled": false, "provider": "none", "site_key": null },
  "registration": { "open_registration": true, "allowed_roles": ["client", "provider"] },
  "bootstrap_required": false
}
```

- The branding fields are described under
  [`PUT /api/admin/settings`](#put-apiadminsettings). The SPA derives its
  accent scale from `primary_color` and its secondary (`info`) tokens from
  `accent_color`.
- `captcha` is the same object as [`GET /api/auth/captcha`](#get-apiauthcaptcha).
- `registration` is the public slice of the registration policy;
  `allowed_roles` is narrowed to `client` and `provider`, the only roles
  `POST /api/auth/register` accepts.
- `bootstrap_required` is `true` only while the portal has no active
  `super_admin`: the next registration becomes one and must send
  `bootstrap_token`. The token itself is never public.

---

## Users

Registered under `/api/users`.

### `GET /api/users/me`

_session_ → `{ "user": User }`.

### `PATCH /api/users/me`

_session_ — profile self-service. Cannot change role, status, email or
organization.

| Field              | Type           | Notes                                   |
| ------------------ | -------------- | --------------------------------------- |
| `display_name`     | string         | 1–200                                   |
| `company`          | string \| null | ≤ 200                                   |
| `phone`            | string \| null | ≤ 64                                    |
| `current_password` | string         | required when `new_password` is present |
| `new_password`     | string         | 12–1024 characters                      |

→ `{ "user": User }`. A password change ends every session of the account and
invalidates outstanding reset links, then signs the caller back in: the
response sets **new** session cookies, so read the new `nexus_csrf` value
before the next mutation.

Errors: `400 VALIDATION_FAILED` (`new_password` without `current_password`),
`403 FORBIDDEN` (wrong `current_password`), `429 RATE_LIMITED` (10 a minute per
account).

### `GET /api/users/me/notification-preferences`

_session_ → `{ "preferences": NotificationPreferences }`. An account that never
changed one gets the defaults below: the in-app notice on, the email off.

| Field                     | Default | Controls                                                                                     |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `api_spec_updated_in_app` | `true`  | the in-app notice when an API the account holds a grant on publishes a changed spec revision |
| `api_spec_updated_email`  | `false` | the same notice by email: off until the account turns it on                                  |

### `PATCH /api/users/me/notification-preferences`

_session_ — change the fields sent, and only those. Body: any of the fields
above as booleans; an unknown field is `400 VALIDATION_FAILED`. →
`{ "preferences": NotificationPreferences }`. A change is audited as
`user.notification_preferences_update` with `details.changed`; a request that
changes nothing writes nothing.

### `GET /api/users`

_admin_ — `Paginated<User>` plus `pending_gateway_teardowns`: the portal-wide
count of disabled accounts whose gateway credentials are not revoked yet
(queued, retrying or in progress). Independent of the filters and pagination.

| Query             | Type                                                        |
| ----------------- | ----------------------------------------------------------- |
| `role`            | `client` \| `provider` \| `admin` \| `super_admin`          |
| `status`          | `active` \| `disabled`                                      |
| `org_id`          | organization id                                             |
| `q`               | substring match on email or display name (case-insensitive) |
| `limit`, `offset` | pagination                                                  |

### `GET /api/users/:id`

_admin_ → `{ "user": User, "gateway_teardown": GatewayTeardownState | null }`.

`gateway_teardown` is the account's gateway revocation job, or `null` if it
never had one:

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

_admin_ — body: any of `role` (any role), `status` (`active` \| `disabled`),
`org_id` (id \| null), `display_name` (1–200).

→ `{ "user": User, "gateway_teardown"?: "ok" | "no_consumer" | "pending" }`.
`gateway_teardown` is present only when this request disabled the account.
`pending` means the portal account is off but its Edge credentials are still
live and the teardown worker is retrying. There is no `failed` value.

Rules:

- Only a `super_admin` may promote to or demote from `admin`/`super_admin`, or
  disable/re-enable an administrator → otherwise `403 FORBIDDEN`. A plain
  `admin` can move accounts between `client` and `provider`.
- Demoting or disabling the last active `super_admin` → `409 LAST_SUPER_ADMIN`
  (this wins over the self-disable rule).
- Disabling your own account otherwise → `409 CONFLICT`.
- `org_id` naming an unknown organization → `404 NOT_FOUND`.
- Disabling deletes every session the account holds, revokes every outstanding
  `password_reset` link, and queues the gateway revocation in the same
  transaction, so a re-enable inside a link's one-hour lifetime cannot revive
  it.
- Re-enabling cancels any queued revocation and rebuilds each identity's
  `nexus:api:<id>:approved` ACL groups from its active grants (revoked
  credentials and test consumers are not restored; groups outside that
  namespace are kept). If the gateway fails, the status change has already
  committed and the response is `502 EDGE_ERROR`; repeat the same PATCH to
  retry.

### `POST /api/users/:id/gateway-teardown/retry`

_admin_ — re-run a disabled account's gateway revocation now instead of waiting
for the worker's backoff. Idempotent; audited as `user.gateway_teardown_retry`.

→ `{ "gateway_teardown": "ok" | "no_consumer" | "pending", "job": GatewayTeardownState | null }`

Errors: `409 CONFLICT` (account is not `disabled`), `404 NOT_FOUND`.

### `GET /api/users/:id/identities`

_admin_ — the account's single sign-on links. `GET /api/users/me/identities`
(_authenticated_) returns the caller's own, in the same shape.

```json
{
  "items": [
    {
      "id": "…",
      "user_id": "…",
      "provider_id": "corp",
      "issuer": "https://idp.example.com/realms/corp",
      "subject": "248289761001",
      "provisioned": false,
      "email": "ada@example.com",
      "last_login_at": "2026-09-30T08:12:44.117Z",
      "created_at": "2026-09-01T10:00:00.000Z",
      "updated_at": "2026-09-30T08:12:44.117Z"
    }
  ]
}
```

Errors: `404 NOT_FOUND`.

### `DELETE /api/users/:id/identities/:identityId`

_admin_ (a **_super_admin_** for an `admin` or `super_admin` account), **CSRF
required** — removes one link; audited as `auth.sso_unlink`. The account keeps
everything else. Its next sign-in through that provider is matched afresh:
linked again only under the proven-address rule or explicitly, or refused.
An account the identity provisioned keeps its password lock, so it gains no
password. Returns `{ "ok": true }`.

Errors: `403 FORBIDDEN`, `404 NOT_FOUND`.

---

## Organizations

Registered under `/api/organizations`; every route is _admin_.

### `GET /api/organizations`

_admin_ — `Paginated<Organization>`, ordered by name. Query: `q`
(case-insensitive substring of the name, ≤ 200), `limit`, `offset`.

### `GET /api/organizations/:id`

_admin_ → `{ "organization": Organization }`; `404 NOT_FOUND` if unknown.

### `POST /api/organizations`

_admin_ → `201 { "organization": Organization }`. Body: `name` (1–200),
optional `description` (≤ 2000, nullable).

### `PATCH /api/organizations/:id`

_admin_ → `{ "organization": Organization }`. Body: optional `name`,
`description`. An empty body returns the row unchanged.

---

## Threads

Portal messaging, registered under `/api/threads`; every route needs a
_session_.

A thread has two seats. A **1:1 thread** seats two accounts (the
lower-privileged one in `participant_a`), optionally about one API. A
**platform thread** has `participant_b: null`: it is addressed to the platform,
and **any admin may read and reply**. Threads are deduplicated on
`(participants, api_id)`, so asking the same person about the same API again
continues the existing conversation. Admins may read any thread.

**Limits on writing.** Besides the [per-minute limits](#rate-limits), one
account may post `NEXUS_MAX_MESSAGES_PER_USER_PER_DAY` messages (default 200,
`0` disables) in a rolling 24 hours across every thread; beyond that is
`429 QUOTA_EXCEEDED` with `details: { limit, window: "24h", setting }`. The
budget check and the insert are one transaction under a per-sender lease, so a
send still in flight elsewhere for more than 30 seconds answers
`409 CONFLICT` (retry). A refused send writes nothing. Messages written by a
god-mode broadcast carry `broadcast: true` and are not counted.

Recipients get at most one `message_received` email per thread per 10 minutes;
in-app notifications stay one per message.

### `GET /api/threads`

_session_ — `Paginated<MessageThread>`, newest activity first; each row carries
`participants`, optional `api`, and `last_message_preview` (≤ 160 chars).
Query: `api_id`, `q` (substring of the subject), `limit`, `offset`.

Non-admins see threads they sit in; admins also see every platform thread.

### `POST /api/threads`

_session_ → `201 { "thread": { … }, "message": { … } }`

| Field               | Type       | Notes                                  |
| ------------------- | ---------- | -------------------------------------- |
| `subject`           | string     | 1–200                                  |
| `body`              | string     | 1–10 000, the opening message          |
| `recipient_user_id` | id \| null | omit or `null` to address the platform |
| `api_id`            | id \| null | optional API the conversation is about |

Errors: `400 VALIDATION_FAILED` (empty subject/body, or messaging yourself),
`404 NOT_FOUND` (unknown or disabled recipient, unknown API, or a `private` API
the sender may not read — the catalog's rule), plus the write limits above.

### `GET /api/threads/:id`

_session_, participant or admin — the thread (`MessageThreadDetail`) plus the
**most recent** window of its messages, each with a `sender` summary.

| Query    | Type | Notes                                                  |
| -------- | ---- | ------------------------------------------------------ |
| `limit`  | int  | window size, 1–200, default 25                         |
| `before` | id   | a message id: return only messages older than that one |

```json
{
  "id": "…", "subject": "…", "participants": [ … ],
  "messages": { "items": [ … ], "total": 208, "has_more": true, "next_before": "5e933aed-…" }
}
```

`messages.items` is oldest-first, but the window is taken from the newest end,
so a fresh reply is always visible. `total` counts the whole thread; `has_more`
says whether anything precedes `items[0]`, and `next_before` is the cursor that
fetches it. There is no `offset`.

Errors: `403 FORBIDDEN` (not a participant or admin), `404 NOT_FOUND`,
`400 VALIDATION_FAILED` (a `before` id from another thread).

### `GET /api/threads/:id/messages`

_session_ — one window of the transcript without the thread: the "load older
messages" call. Same query, body (`MessagePage`), access rule and errors as
`messages` above.

### `POST /api/threads/:id/messages`

_session_ → `201 { "message": Message }`. Body `{ "body": string }` (1–10 000).
Participants may post; an admin may post into any platform thread.

Errors: `400 VALIDATION_FAILED`, `403 FORBIDDEN`, `404 NOT_FOUND`, plus the write
limits above.

---

## Notifications

Registered under `/api/notifications`; _session_. A user only ever sees their
own.

### `GET /api/notifications`

_session_

| Query             | Type                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unread`          | boolean — only unread                                                                                                                                                                          |
| `type`            | one of `access_request_created`, `access_request_approved`, `access_request_denied`, `access_revoked`, `message_received`, `credential_rotated`, `api_published`, `api_spec_updated`, `system` |
| `limit`, `offset` | pagination                                                                                                                                                                                     |

```json
{ "items": [ … ], "total": 42, "unread_count": 3 }
```

**`api_spec_updated`** is sent when an API the account holds an active grant on
publishes a revision that changes something (see
[`PUT /api/apis/:id/spec`](#put-apiapisidspec)). Its title is
`<API name> spec updated to <version>` (or `rolled back to`), its body counts
the changes and names up to five, removed operations first, and its `link` is
`/catalog/<slug>?tab=changes`. An account that still has an unread one for the
API gets no second one: its unread one is rewritten to describe the newest
revision, moved to the top of the list, and says earlier revisions are on the
Changes tab. A title ending `(breaking changes)` keeps that ending through a
rewrite by a revision that broke nothing.

### `POST /api/notifications/read`

_session_ — body **either** `ids` (≤ 500 ids) **or** `all: true`; neither is
`400 VALIDATION_FAILED`. Ids belonging to another user are ignored.

```json
{ "updated": 3, "unread_count": 0 }
```

---

## Admin

Registered under `/api/admin`; every route needs _admin_. These additionally
need **_super_admin_**: the `smtp`, `captcha` and `gateway` sections of
`PUT /settings`, `POST /gateway/reconcile`, `POST /gateway/repair` and the four
`god/*` routes.

### `POST /api/admin/credentials/reconcile`

_admin_ — empty one credential type on one Edge consumer and settle the portal's
rows to match. This repairs a consumer whose live rows cannot be positioned
(see [`operations.md`](operations.md#12-the-credential-mirror)). **Destructive**:
every live credential of that type on that consumer stops working, and the
holders are notified.

Body: `consumer_id` (the Edge consumer id from
`CredentialMetadata.ferrum_consumer_id`, ≤ 128), `credential_type` (`keyauth` \|
`basicauth` \| `jwt`), optional `reason` (≤ 500, recorded on the
`credential.reconcile` audit row).

```json
{
  "consumer_id": "7c1d…",
  "credential_type": "keyauth",
  "revoked_credentials": 2,
  "gateway_cleared": true
}
```

`gateway_cleared` is `false` when the consumer no longer existed on the
gateway. Idempotent. Only a consumer the portal owns can be reconciled — one
with a recorded mapping whose username still matches, a registered gateway
identity, or portal credential rows whose live username is the one Nexus
derives (`nexus-user-<user_id>`, `nexus-app-<application_id>`,
`nexus-test-<api_id>`). Anything else is refused before any gateway write.

Errors: `400 VALIDATION_FAILED` (including a `consumer_id` not matching
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), `403 FORBIDDEN` (not a portal-owned
consumer), `502 EDGE_ERROR` / `EDGE_UNAVAILABLE` (nothing is revoked).

### `POST /api/admin/gateway/reconcile`

_super_admin_ — check whether the gateway still holds every consumer and proxy
id the portal stored, and cache the result for the health endpoints. Reads only;
a `POST` because it costs one Admin API read per stored reference. No body.
Audited as `gateway.reconcile`.

```json
{
  "status": "orphaned",
  "checked_at": "2026-09-11T18:22:05.412Z",
  "namespace": "nexus",
  "consumers": { "checked": 42, "orphaned": 14, "complete": true },
  "proxies": { "checked": 9, "orphaned": 3, "complete": true },
  "orphaned_consumers": [
    {
      "user_id": "…",
      "application_id": null,
      "ferrum_consumer_id": "…",
      "ferrum_username": "nexus-user-…"
    }
  ],
  "orphaned_proxies": [{ "api_id": "…", "slug": "billing", "ferrum_proxy_id": "…" }],
  "awaiting_restore": 0,
  "error": null
}
```

`status` is `ok` \| `orphaned` \| `unknown`. A reference is orphaned only when
Edge answers `404` for it; any other failure abandons the pass as `unknown`,
with the message in `error` and empty orphan lists. `awaiting_restore` counts
APIs still flagged `repair_required` (from the portal's own rows, so it is
filled even when the gateway is unreachable). `complete` is `false` when the
pass stopped at `NEXUS_GATEWAY_RECONCILE_SAMPLE`.

### `POST /api/admin/gateway/repair`

_super_admin_ — recreate missing gateway consumers and clear dead proxy ids.
Always takes a fresh pass first. See
[`operations.md`](operations.md#13-retargeting-or-rebuilding-ferrum-edge).

Body: `user_ids` (≤ 1000), `api_ids` (≤ 1000), `all` (repair every orphan
found), optional `reason` (≤ 500, recorded on every audit row). **At least one
of `user_ids`, `api_ids` or `all: true` is required.**

```json
{
  "report": { "status": "orphaned", "namespace": "nexus", "…": "…" },
  "consumers": [
    {
      "user_id": "…",
      "application_id": null,
      "previous_ferrum_consumer_id": "…",
      "ferrum_consumer_id": "…",
      "credentials_requiring_reissue": 1,
      "restored_groups": 3,
      "error": null
    }
  ],
  "apis": [{ "api_id": "…", "previous_ferrum_proxy_id": "…", "flagged": true, "error": null }]
}
```

- `report` is the fresh pass, in the shape of `POST /gateway/reconcile`.
- **Consumers** are recreated under the same identity (the account's
  `nexus-user-<user_id>` consumer, or an application's own), and their
  `nexus:api:<api_id>:approved` ACL groups are replayed from the identity's
  `active` grants (`restored_groups`). One account can have several rows — one
  per identity.
- **No credential material is minted.** Show-once secrets cannot be recovered,
  so live `credential_metadata` rows move to `revoked`
  (`credentials_requiring_reissue`) and each holder issues new credentials. Each
  repaired account gets a `gateway.consumer_repair` audit row and a
  notification.
- **APIs** are not rebuilt here: the dead `ferrum_proxy_id` is cleared, the API
  is flagged `gateway_state: "repair_required"`, an
  `api.gateway_repair_required` audit row (`phase: "orphaned_proxy"`) is
  written, and the owner is notified to rebuild it with
  [`POST /api/apis/:id/restore-gateway`](#post-apiapisidrestore-gateway).
  Catalog entry, grants and requests are untouched.

Per-target failures (including a named target that is not orphaned) come back
in that target's `error` rather than failing the request. Errors:
`400 VALIDATION_FAILED` (no target), `403 FORBIDDEN`, `502 EDGE_UNAVAILABLE`
(the fresh pass could not read the gateway, so nothing is repaired).

### `GET /api/admin/settings`

_admin_ — the whole settings snapshot. Secrets are never returned; booleans say
whether one is stored.

```json
{
  "branding": {
    "portal_name": "…",
    "logo_data_url": null,
    "primary_color": "#f97316",
    "accent_color": "#38bdf8",
    "default_theme": "dark",
    "tagline": null,
    "support_email": null,
    "radius": "md",
    "font_preset": "system",
    "sidebar_style": "surface",
    "login_layout": "split",
    "footer_text": null,
    "footer_links": []
  },
  "captcha": {
    "enabled": false,
    "provider": "none",
    "site_key": null,
    "secret_set": false,
    "enforcement": "enforced"
  },
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

- `gateway.public_url` is the stored override, else `FERRUM_GATEWAY_PUBLIC_URL`,
  else `null`.
- `captcha.enforcement` (`enforced` \| `disabled`) mirrors the server's
  `NEXUS_CAPTCHA_ENFORCEMENT` and cannot be set through the API. `disabled` is
  the operator's break-glass switch: register and login skip verification and
  the widget is hidden, whatever `captcha.enabled` says. See
  [`operations.md`](operations.md#recovering-a-portal-locked-out-by-captcha).

### `PUT /api/admin/settings`

_admin_; the `smtp`, `captcha` and `gateway` sections need **_super_admin_**.
Partial update: omitted sections and omitted fields keep their values. Returns
the same shape as `GET`. The `admin.settings_update` audit row records the
**names** of changed keys, never their values.

A body with an `smtp`, `captcha` or `gateway` section from a plain `admin` is
refused with `403 FORBIDDEN` and nothing is written. Unknown sections and
unknown keys (including inside `footer_links` entries) are
`400 VALIDATION_FAILED`, with each `details` entry naming the full path (for
example `branding.footer_links.0.target`); response-only fields such as
`secret_set`, `enforcement` and `password_set` are rejected too. A rejected
patch applies nothing.

| Section        | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branding`     | `portal_name` (1–120); `logo_data_url` (base64 `data:image/…` URL, ≤ 512 KiB, nullable); `primary_color`, `accent_color` (`#rgb` or `#rrggbb`, stored lowercase `#rrggbb`; alpha and 5/7-digit forms are refused); `default_theme` (`dark`\|`light`\|`system`); `tagline` (≤ 280, nullable); `support_email` (email, nullable); `radius` (`none`\|`sm`\|`md`\|`lg`); `font_preset` (`system`\|`inter`\|`manrope`); `sidebar_style` (`surface`\|`contrast`); `login_layout` (`split`\|`centered`); `footer_text` (≤ 200, nullable); `footer_links` (≤ 5 × `{ label (1–60), url }`, `http(s)` only) |
| `captcha`      | `enabled`; `provider` (`none`\|`recaptcha`\|`hcaptcha`\|`turnstile`); `site_key` (nullable); `secret_key` — **write-only**, stored AES-256-GCM encrypted, `null`/`""` clears; `captcha_token` — the activation self-test's proof (below)                                                                                                                                                                                                                                                                                                                                                          |
| `smtp`         | `host`, `port` (1–65535), `secure`, `username`, `password` — **write-only**, encrypted, `null`/`""` clears — and `from_address`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `registration` | `open_registration`, `require_email_verification`, `allowed_roles` (array of roles)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `gateway`      | `public_url` — absolute `http(s)` **origin** of the gateway's proxy listener, with no path, query or credentials; a trailing slash is stripped; `null`/`""` falls back to `FERRUM_GATEWAY_PUBLIC_URL`                                                                                                                                                                                                                                                                                                                                                                                             |

**SMTP rules.** Changing `host`, `port`, `secure` or `username` while a password
is stored (or set by the environment) requires a fresh `password` in the same
request, so a stored credential is never replayed against a different server.
Connection fields are compared after merging overrides over the environment
defaults. Clearing the password override restores the environment password,
and is allowed only when the effective connection matches the environment's;
otherwise the whole patch is `400 VALIDATION_FAILED`. The audit row records
`smtp_password_source_change: { from, to }` when the source moves between
`override` and `environment`.

**CAPTCHA rules.** All of these reject the whole patch with
`400 VALIDATION_FAILED`:

- An enabled configuration needs a provider other than `none`, a non-empty site
  key and a usable secret (sent now or already stored). Disable CAPTCHA in the
  same patch before clearing a required key; an unreadable stored secret must
  be replaced first.
- Changing `provider` while CAPTCHA is (or becomes) enabled needs a
  `secret_key` in the same request, so a stored secret is never sent to another
  vendor.

**Activation self-test.** A patch that turns CAPTCHA on, or changes `provider`,
`site_key` or `secret_key` while it is on, must carry a `captcha_token` solved
against the configuration the patch describes. The server verifies it with the
vendor before writing anything (for hCaptcha, together with the site key). If
it cannot be proven, the answer is `400 CAPTCHA_SELF_TEST_FAILED`
(`details.reason`: `token_required`, `rejected`, `provider_unreachable`) and
nothing changes. Re-saving an unchanged configuration, and turning CAPTCHA
**off**, never need a token. A proven change is audited with
`captcha_self_test: "passed"`. The caller's address is forwarded to the vendor
as `remoteip`, so solve the token from the same address that sends the request.

The CAPTCHA write is a compare-and-swap on the rows the proof was made against:
if another super admin changed them meanwhile, the patch is `409 CONFLICT` and
nothing is written. Re-read, solve a fresh challenge and resend.

Verification fails closed: incomplete settings or an undecryptable secret
refuse sign-in and registration rather than exempting them. For a portal where
nobody can sign in any more, see
[`operations.md`](operations.md#recovering-a-portal-locked-out-by-captcha).

```bash
curl -sS -b cookies.txt -X PUT http://127.0.0.1:8787/api/admin/settings \
  -H 'content-type: application/json' \
  -H "X-Nexus-CSRF: $CSRF" \
  -d '{"captcha":{"enabled":true,"provider":"turnstile",
        "site_key":"0x4AAA…","secret_key":"0x4AAA…secret",
        "captcha_token":"<token solved with those values>"}}'
```

### `GET /api/admin/sso`

_admin_ — single sign-on settings. Client secrets are never returned.

```json
{
  "policy": "local_and_sso",
  "allowed_email_domains": ["example.com"],
  "deprovision_on_access_loss": false,
  "break_glass_local_login": false,
  "providers": [
    {
      "id": "corp",
      "display_name": "Corporate SSO",
      "issuer": "https://idp.example.com/realms/corp",
      "client_id": "nexus",
      "scopes": ["openid", "email", "profile", "groups"],
      "enabled": true,
      "jit_provisioning": true,
      "link_existing_accounts": true,
      "require_verified_email": true,
      "allowed_email_domains": [],
      "disable_local_password_for_linked": false,
      "sync_roles": true,
      "default_role": "client",
      "role_mappings": [{ "claim": "groups", "value": "nexus-admins", "role": "admin" }],
      "org_mappings": [],
      "source": "environment",
      "client_secret_set": true,
      "redirect_uri": "https://portal.example.com/api/auth/sso/corp/callback"
    }
  ],
  "shadowed_provider_ids": []
}
```

- `source`: `environment` (`NEXUS_OIDC_PROVIDERS`, read-only here) or
  `settings`.
- `break_glass_local_login` mirrors `NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN`; it
  cannot be set through the API.
- `shadowed_provider_ids`: settings providers whose id an environment provider
  now also declares. The environment one is in force and is the one listed;
  the next `providers` save removes the stored one.
- The fields are described in
  [`operations.md` §14](operations.md#configure-the-provider-in-nexus).

### `PUT /api/admin/sso`

**_super_admin_** — the role mappings decide who becomes an `admin`. Partial
update of `policy`, `allowed_email_domains`, `deprovision_on_access_loss` and
`providers`; omitted fields keep their values. Returns the same shape as `GET`.

- `providers`, when present, **replaces** the list of settings providers; a
  provider left out is removed together with its secret and its links
  (`user_identities` rows), except that a shadowed provider's removal leaves
  the environment provider's links alone. Accounts it provisioned stay active
  and keep their password lock. Each entry carries
  every field shown above except `source`, `client_secret_set` and
  `redirect_uri`, plus an optional write-only `client_secret`: omit it to keep
  the stored one, `null` to clear it. Environment providers are never part of
  the list.
- `role` in a mapping is `client`, `provider` or `admin`; `super_admin` is
  refused. `default_role` may be `null` (no match → no access).
- Allowed domains, deployment-wide and per provider, are normalized
  (`@Example.COM` → `example.com`).
- Audited as `admin.settings_update` with `target_id: "sso"`, recording key
  names, provider ids and `links_removed`, never a secret.

Errors: `400 VALIDATION_FAILED` for any of:

- an unknown field, or a provider missing a field;
- an id declared in `NEXUS_OIDC_PROVIDERS`, or a duplicate id;
- a non-HTTPS issuer, or an issuer change on a provider that holds links;
- more than 10 providers, or an invalid domain;
- `sso_only` without an enabled provider, or before the caller has a link of
  their own to an enabled provider.

Also `403 FORBIDDEN` (not a `super_admin`), `404 NOT_FOUND` (an `org_id`
that does not exist) and `409 CONFLICT` (another save changed the settings
after this one read them; reload and save again).

### `POST /api/admin/settings/smtp-test`

_admin_ — sends a probe message **straight through SMTP, bypassing the outbox**.
Body `{ "to_email"?: string }`, defaulting to the caller's address. Only a
`super_admin` may name another address; an `admin` naming one gets
`403 FORBIDDEN`.

The attempt is audited as `admin.smtp_test` **before** the relay is contacted:
if that row cannot be written, nothing is sent and the request fails. The result
is a separate `admin.smtp_test_complete` row (`ok`, and `intent_id` naming the
attempt's row), written best-effort, so a delivered probe never answers with an
error that would invite a second send.

```json
{ "ok": false, "error": "getaddrinfo ENOTFOUND smtp.example.com" }
```

A delivery failure is a `200` with `ok: false`, not an error response.

Each administrator may send 10 probes per rolling hour, counted from their own
`admin.smtp_test` rows; past that is `429 QUOTA_EXCEEDED` with
`details: { limit, used, window }`. With `NEXUS_RATE_LIMIT_ENABLED`, the route
also allows 3 requests per minute per account (`429 RATE_LIMITED`).

### `GET /api/admin/email-templates`

_admin_ → `{ "templates": EmailTemplate[], "keys": EmailTemplateKey[] }`.
`templates` lists only overridden keys; `keys` is the full set.

### `GET /api/admin/email-templates/:key`

_admin_ — `key` ∈ `verification`, `password_reset`, `access_approved`,
`access_denied`, `access_revoked`, `message_received`, `mass`,
`credential_rotated`, `spec_updated`.

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

Without an override, the built-in default is returned with a synthetic id.
Every template has `portal_name`, `portal_url`, `recipient_name`,
`recipient_email` and `year`; `password_reset` adds `reset_url` and
`verification` adds `verification_url`. See the
[admin guide](guides/admin-guide.md#placeholders) for the other keys.

### `PUT /api/admin/email-templates/:key`

_admin_ — body `subject` (1–300), `body_html` (1–100 000), `body_text`
(1–100 000), all required → `{ "template": EmailTemplate }`. The
`admin.template_update` audit row records `body_html_sha256` and
`body_text_sha256`.

Each rule below is a `400 VALIDATION_FAILED` and nothing is saved:

- `{{reset_token}}` or `{{verification_token}}` anywhere (retired;
  `details: { field, variable }`). Use `{{reset_url}}` / `{{verification_url}}`.
  Other unknown placeholders render empty.
- **Link policy.** Absolute and protocol-relative URLs, URL attributes (`href`,
  `src`, `action`, `srcset`, `data`, `poster`, `formaction`, `background`,
  `xlink:href`) and CSS `url(...)` must point at the `NEXUS_PUBLIC_URL` origin
  or an exact host in `NEXUS_EMAIL_TEMPLATE_ALLOWED_LINK_HOSTS` (empty by
  default). `javascript:` and `data:` are always refused, as is ambiguous or
  active HTML/CSS.
- `{{reset_url}}` and `{{verification_url}}` may only be the whole `href` of an
  anchor, or a whitespace-delimited URL in `body_text`. Any placeholder inside a
  URL or attribute must be the entire value and name a `*_url` variable.

A policy error's `details` carries `field`, `construct` and `setting`, never URL
paths, query strings or tokens. Stored templates are revalidated before each
send; a refused one logs a warning and queues nothing. See the
[template authoring rules](guides/admin-guide.md#placeholders).

### `POST /api/admin/mass-email`

_admin_ — enqueues **one outbox row per recipient**, never a BCC blast.

| Field               | Type                              | Notes                                                            |
| ------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `subject`           | string                            | 1–300                                                            |
| `body_html`         | string                            | optional, ≤ 100 000; at least one of html/text must be non-empty |
| `body_text`         | string                            | optional, ≤ 100 000                                              |
| `audience.scope`    | `all` \| `filtered` \| `explicit` | `all` ignores the filters below                                  |
| `audience.roles`    | Role[]                            | `filtered` only                                                  |
| `audience.status`   | `active` \| `disabled`            | `filtered` only; default `active`                                |
| `audience.org_id`   | id                                | `filtered` only                                                  |
| `audience.user_ids` | id[] (≤ 5000)                     | required and non-empty for `explicit`                            |
| `idempotency_key`   | string, 8–128                     | reuse makes the send at-most-once                                |

`all` and `explicit` only ever reach **active** accounts.

```json
{ "enqueued": 240, "recipients": 251, "batch_id": "c3f0…" }
```

Rows are keyed `mass:<batch>:<user_id>`, where `<batch>` is your
`idempotency_key` or a fresh UUID. `recipients` is who matched; `enqueued`
excludes rows the key already produced, so resending with the same key queues
nothing new.

The campaign's `admin.mass_email` audit row commits **before** any outbox row;
if it cannot be written, nothing is queued. The rows are then queued in
transactions of at most 200 recipients (fewer for large messages), so a
campaign never holds the database for its whole audience. A failed chunk rolls
back alone: the chunks before it stay queued and the failure reports how many
rows this attempt queued. `batch_id` is returned on success **and** in the
failure `details`; retry with it as `idempotency_key` and exactly the missing
recipients are queued — nobody is mailed twice, and the retry is not charged as
a new campaign. Each attempt's outcome is an `admin.mass_email_complete` row.

A key names one campaign. A retry must repeat the subject, both bodies and the
audience selector exactly (the order of `roles` and `user_ids` does not
matter); the same key with anything else is `409 CONFLICT` with
`details: { batch_id, reason: "idempotency_key_reused" }`, and nothing is
queued or charged. An audience that resolves to nobody is
`400 VALIDATION_FAILED` and costs no campaign.

Three bounds are checked before anything is written, each refused with
`429 QUOTA_EXCEEDED` and a `details.setting` naming the variable:

- the audience, by `NEXUS_MAX_MASS_EMAIL_RECIPIENTS` (default 5 000);
  `details: { limit, recipients, setting }`;
- the aggregate size — an upper bound on one rendered message (subject, HTML
  and text, for the longest recipient name and address after HTML escaping)
  times the recipients — by `NEXUS_MAX_MASS_EMAIL_BYTES` (default 64 MiB);
  `details: { limit, bytes, message_bytes, recipients, setting }`;
- campaigns per administrator per rolling 24 hours, by
  `NEXUS_MAX_MASS_EMAILS_PER_DAY` (default 5);
  `details: { limit, used, recipients, window, setting }`.

`0` disables any of them. With `NEXUS_RATE_LIMIT_ENABLED`, the route also allows
10 requests per minute per account (`429 RATE_LIMITED`).

Errors: `400 VALIDATION_FAILED` (empty subject/body, an audience that matches
nobody, one message too large for a 4 MiB chunk on its own),
`429 QUOTA_EXCEEDED` (above), `409 CONFLICT` (contention, another campaign from
the same administrator still in flight, or a reused key; `batch_id` always,
`enqueued` once queueing started, and `reason` for a reused key, in
`details`), `500 OUTBOX_FAILURE` (`details: { batch_id, recipients, enqueued }`).

### `GET /api/admin/audit-logs`

_admin_ — `Paginated<AuditLog>`, newest first.

| Query             | Type                                       |
| ----------------- | ------------------------------------------ |
| `actor_user_id`   | id                                         |
| `action`          | exact action string, e.g. `access.approve` |
| `target_type`     | e.g. `api`, `grant`, `user`, `credential`  |
| `target_id`       | string                                     |
| `from`            | ISO-8601 datetime, inclusive lower bound   |
| `to`              | ISO-8601 datetime, exclusive upper bound   |
| `limit`, `offset` | pagination                                 |

`from`/`to` are normalized to UTC milliseconds (`…:15Z` means `…:15.000Z`).
Each row carries `actor` — the current `id`, `email`, `display_name` and `role`
of the actor, or `null` when it cannot be resolved — alongside the stored
`actor_user_id` and the historical `actor_role`. A `null` `actor_user_id` is
system or anonymous activity. The action catalog is in
[`security.md`](security.md#10-audit-event-catalog).

```bash
curl -sS -b cookies.txt \
  'http://127.0.0.1:8787/api/admin/audit-logs?action=access.approve&limit=50'
```

### God mode

Four routes, all _super_admin_, all requiring a `reason` (1–2000 chars) that is
written to a `god.*` audit row **in addition to** the audit row of the
underlying operation.

#### `POST /api/admin/god/revoke-grant`

Body `{ "grant_id", "reason" }` → `{ "grant": Grant }`. Revokes any grant,
whoever owns the API, and removes the ACL group from the consumer.

#### `POST /api/admin/god/delete-api`

Body `{ "api_id", "reason", "revoke_grants"?: boolean }` →
`{ "deleted_api_id": "…", "revoked_grants": 7 }`.

Deletes the API with its Edge proxy and plugins, whoever owns it. Deletion
always strips ACL groups and removes grant rows; `revoke_grants: true` also
records each as an individual `access.revoke` first.

#### `POST /api/admin/god/disable-user`

Body `{ "user_id", "reason", "revoke_grants"?: boolean }`

```json
{ "user": { … }, "revoked_grants": 3, "terminated_sessions": 2, "gateway_teardown": "ok" }
```

Disables the account, ends its sessions and revokes its outstanding
`password_reset` links. `gateway_teardown` has the same values and meaning as on
[`PATCH /api/users/:id`](#patch-apiusersid). The disable, the session purge, the
recovery-link revocation, the queued revocation and the `user.disable` and
`god.disable_user` audit rows commit in one transaction;
`god.disable_user_complete` records what followed.

`revoke_grants: true` revokes the account's grants after the disable commits.
If any grant cannot be fully revoked, the request fails (`502 EDGE_ERROR` for a
gateway step) with `details.failed_grants` listing each `grant_id`, `api_id`,
`application_id` and the `stage` it stopped at (`claim`, `lookup` or
`gateway`), and `god.disable_user_complete` records
`failed_steps: ["revoke_grants"]`. Only a `claim` failure leaves the grant
active; repeat the request to retry it. A grant stopped at `lookup` or `gateway`
is already `revoked` in the portal, and its ACL group is removed by the account
teardown (or dropped when a re-enable rebuilds the groups). A failure to record
`user.gateway_teardown_complete` is reported the same way, as
`record_gateway_teardown`. Each swept grant's originating access request moves
to `revoked`.

Errors: `409 LAST_SUPER_ADMIN` (the target is the last active super admin,
including yourself), `409 CONFLICT` (disabling yourself otherwise).

#### `POST /api/admin/god/broadcast`

Body: `subject` (1–300), `body` (1–20 000), `audience` (the `MassEmailAudience`
of [mass email](#post-apiadminmass-email)), optional `send_email` (boolean),
optional `idempotency_key` (8–128).

```json
{ "notified": 251, "emails_enqueued": 251, "threads_created": 88, "delivered": 251, "failed": 0 }
```

Sends a bell notification to every recipient, posts the message into each
recipient's **platform thread** (so any admin can follow up there), and
optionally queues an email. The sender is excluded from their own broadcast.
`delivered` and `failed` count recipients whose inbox message was or was not
written; a per-recipient failure is logged and skipped, not fatal.

`idempotency_key` deduplicates **email only** (scoped to the sender, normalized
subject/body, audience and recipient); notifications and inbox messages are
created on every call. Reuse the key when retrying; replays count only new
outbox rows in `emails_enqueued`.

Two ceilings are checked before anything is written:
`NEXUS_MAX_BROADCAST_RECIPIENTS` (default 5 000, `0` disables) per broadcast,
and `NEXUS_MAX_BROADCASTS_PER_DAY` (default 20, `0` disables) per administrator
per rolling 24 hours, counted from their `god.broadcast` audit rows. That row
is written before the first recipient (`details.phase: "started"`), so a failed
attempt still counts; `god.broadcast_complete` follows with the counts.
Broadcast messages carry `broadcast: true` and do not count against the
sender's daily message budget.

Errors: `400 VALIDATION_FAILED` (empty subject/body, or an audience matching
nobody), `429 QUOTA_EXCEEDED` (either ceiling; `details` names the limit,
audience size and setting), `409 CONFLICT` (another broadcast from this
account has held its lease for more than 30 seconds — retry).

---

## Catalog

Registered under `/api/catalog`; _session_, reads only.

| API state                | unrelated account: listed | unrelated account: can open | viewer, grantee, owner, admin |
| ------------------------ | ------------------------- | --------------------------- | ----------------------------- |
| `published` + `public`   | yes                       | yes                         | listed and openable           |
| `published` + `internal` | no                        | **yes** (with the link)     | listed and openable           |
| `published` + `private`  | no                        | **no** (`404`)              | listed and openable           |
| `retired`                | no                        | no (`404`)                  | listed and openable           |

- A **grantee** holds an active grant through any of its identities (the
  account or one of its applications).
- A **viewer** has an `api_viewers` row: the provider authorized them to read
  the documentation. It is **not a grant** — no ACL group, no consumer, no
  gateway call. See [`POST /api/apis/:id/viewers`](#post-apiapisidviewers).
- **`internal` means unlisted, not secret.** Anyone with the link can read the
  docs and request access.
- **`private` is enforced.** A caller who is not on one of the lists gets
  `404`, never `403`, and search results and `total` exclude it too. Such a
  caller also cannot request access to it or attach a thread to it.

**None of this is data-plane authorization.** What stops an unapproved caller
reaching the API is the `access_control` plugin on the gateway. A `private` API
published with `requestable: false` is callable by anyone with a portal
credential who knows the URL.

### `GET /api/catalog`

_session_ — `Paginated<CatalogApi>`: each row is an `Api` plus `owner`
(`UserSummary` \| null) and `access_state`.

| Query             | Type                                         |
| ----------------- | -------------------------------------------- |
| `q`               | substring match on name, slug or description |
| `requestable`     | boolean                                      |
| `visibility`      | `public` \| `internal` \| `private`          |
| `owner_user_id`   | id                                           |
| `limit`, `offset` | pagination                                   |

`access_state` ∈ `none` \| `open` \| `pending` \| `granted` \| `denied` \|
`revoked` \| `owner`. `open` means the API takes no access requests
(`requestable: false`) and any portal account may call it; `none` means a
requestable API the caller has neither requested nor been granted.

### `GET /api/catalog/:slug`

_session_

```json
{
  "api": { …, "owner": { … }, "access_state": "pending" },
  "spec": { "id": "…", "api_id": "…", "version": "2.4.0", "parsed_title": "Billing API",
            "parsed_version": "2.4.0", "is_current": true, "created_at": "…", "updated_at": "…" },
  "my_request": { … },
  "my_grant": null
}
```

`spec` is metadata only, never the document. `my_request` is the newest request
by any of the caller's identities; `my_grant` is the account's own active grant,
or else one held by one of its applications. Both may be `null`. For one
identity's standing, use
[`GET /api/catalog/:slug/access`](#get-apicatalogslugaccess).

`404 NOT_FOUND` when the API does not exist or is not viewable.

### `GET /api/catalog/:slug/access`

_session_ — one identity's standing on one API. Query `application_id`: one of
the caller's own applications, or `account` (the default) for the account
itself.

```json
{
  "application": { "id": "…", "name": "Billing worker", "owner_user_id": "…", "status": "active" },
  "request": { …, "application_id": "…", "status": "pending" },
  "grant": null
}
```

`application` is `null` for the account. `request` is that identity's newest
request (any status) and `grant` its active grant — never another identity's.
Grants and pending requests are unique per `(api, account, application)`, so an
identity with neither may request access even while another identity of the
same account is pending or approved.

`404 NOT_FOUND` when the API is not viewable, or the application is not the
caller's own (not even an admin may read another account's here). A disabled
application is still answered.

### `GET /api/catalog/:slug/spec`

_session_ — the current document, normalized for consumers. `60/min` per
account (see [Rate limits](#rate-limits)).

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

`content_type` (`application/json` or `application/yaml`) matches the upload's
format; formatting and YAML comments are not preserved. Every structural
`servers` entry — root, path item, operation, webhooks, reusable path items,
callbacks, and Link Object `server` — is replaced with the API's `invoke_url`
(or just `listen_path` when no public gateway origin is set). Schemas, examples
and extensions are untouched. The Documentation tab renders this same
document; the provider's original is only at `GET /api/apis/:id/spec`.

The result is cached in process per revision and gateway address (at most 64
documents / 32 MiB), after the visibility check.

Errors: `404 NOT_FOUND` (not viewable, or no spec), `400 SPEC_INVALID` (the
stored document cannot be normalized; no contents or parser output are
returned).

### `GET /api/catalog/:slug/changes`

_session_ — what each published revision of the API's specification changed,
newest first → `Paginated<ApiSpecChangeEntry>`. `limit` is capped at 20. The
same visibility as `GET /api/catalog/:slug`: `404 NOT_FOUND`, with the same
body as for a slug that names nothing, when the caller may not open the API.

```json
{
  "items": [
    {
      "id": "…",
      "api_id": "…",
      "revision_id": "…",
      "previous_revision_id": "…",
      "kind": "update",
      "version": "2.0.0",
      "previous_version": "1.0.0",
      "report": {
        "changed": true,
        "complete": true,
        "changes": [
          {
            "kind": "operation_removed",
            "severity": "breaking",
            "operation": { "method": "DELETE", "path": "/orders/{id}" },
            "section": "operation",
            "location": null,
            "schema_path": null,
            "from": null,
            "to": null
          }
        ],
        "counts": { "breaking": 1, "non_breaking": 0, "operations_added": 0, … },
        "truncated": false,
        "info_changes": ["version"]
      },
      "created_at": "…"
    }
  ],
  "total": 1
}
```

A summary is recorded when a revision replaces another, by
[`PUT /api/apis/:id/spec`](#put-apiapisidspec) or a
[rollback](#post-apiapisidrevisionsrevisionidrollback) (`kind: "rollback"`).
A first publish has nothing to compare against and records none, so an API
that has not changed since it was published has an empty history. Summaries
are kept apart from the revision documents and outlive their pruning by
`NEXUS_SPEC_HISTORY_LIMIT`: `revision_id` may name a revision that is no
longer retained. The newest 100 per API are kept.

Only the summary crosses this endpoint: never the document, its `servers`,
descriptions, examples or extensions, and never the upstream or plugin
configuration. Nothing is parsed on a read.

### `GET /api/catalog/:slug/changes/:revisionId`

_session_ — one revision's `ApiSpecChangeEntry`. `404 NOT_FOUND` when the API is
not viewable, or the revision has no summary under this API.

#### The `SpecChangeReport` shape

| Field          | Meaning                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changed`      | whether anything differs, `info_changes` included                                                                                                              |
| `complete`     | `false` when the comparison stopped at its budget or could not read the previous revision; the lists and counts are then only what it found                    |
| `changes`      | at most 100 `SpecChange`s: breaking ones first, then the rest, each group in document order                                                                    |
| `counts`       | `breaking`, `non_breaking`, `operations_added`, `operations_removed`, `operations_deprecated` and `operations_changed`, over every change found, listed or not |
| `truncated`    | whether `changes` lists fewer changes than `counts` counts                                                                                                     |
| `info_changes` | the `info` fields (`title`, `version`, `description`) that differ; their values are not carried                                                                |

Each `SpecChange`:

| Field         | Meaning                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`        | what changed; see the next table                                                                                                                                       |
| `severity`    | `breaking` \| `non_breaking`                                                                                                                                           |
| `operation`   | `{ method, path }`, or `null` for a change inside a shared component schema                                                                                            |
| `section`     | `operation`, `parameter`, `request` or `response`; for a schema change, the direction the schema travels in                                                            |
| `location`    | `query limit` (a parameter), a media type (a request body), `200` or `200 application/json` (a response), or a component's `$ref`; `null` when the section says it all |
| `schema_path` | where inside that schema: `status`, `items[].id`, `oneOf[1].amount`, or `""` for the schema itself; `null` outside a schema                                            |
| `from`, `to`  | the value before and after, where one is worth naming: a type, enum values, `required` or `optional`                                                                   |

A schema is _sent_ when it is a parameter's or a request body's, and _read_
when it is a response's. A change is `breaking` when a caller written against
the previous revision may fail against the new one:

| Kind                                                                | Breaking when                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `operation_added`, `operation_deprecated`, `operation_undeprecated` | never                                                                                           |
| `operation_removed`                                                 | always: requests to it may now fail                                                             |
| `parameter_added`                                                   | the parameter is required (every `path` parameter is)                                           |
| `parameter_removed`, `parameter_required`                           | always                                                                                          |
| `parameter_optional`                                                | never                                                                                           |
| `request_body_added`                                                | the body is required                                                                            |
| `request_body_removed`, `request_body_required`                     | always                                                                                          |
| `request_body_optional`, `response_added`, `media_type_added`       | never                                                                                           |
| `response_removed`                                                  | the status is a `2xx` success                                                                   |
| `media_type_removed`                                                | always                                                                                          |
| `schema_type_changed`                                               | a sent schema accepts fewer types, or a read one more (`integer` to `number` widens)            |
| `schema_property_added`                                             | a sent schema gains a required property                                                         |
| `schema_property_removed`, `schema_property_optional`               | the schema is read                                                                              |
| `schema_property_required`, `schema_enum_values_removed`            | the schema is sent                                                                              |
| `schema_enum_values_added`                                          | the schema is read, or an enum now restricts a sent one                                         |
| `schema_composition_changed`                                        | a sent schema accepts less (fewer `oneOf` or `anyOf` entries, more `allOf`), or a read one more |

The comparison reads types (with `nullable`), properties, `required` (including
names a schema requires without declaring them, as in
`allOf: [{ $ref: … }, { required: [id] }]`), enums, `items` and
`oneOf`/`anyOf`/`allOf` entries. It does not compare formats, patterns, numeric
bounds, examples or security requirements, and it cannot see how the API
behaves, so an empty list means it found nothing, not that a change is safe.
Some of what it does report needs reading with care:

- A change inside a shared component schema is reported once, under the
  component's `$ref` with `operation: null`, not under each operation that
  uses it.
- A subtree the document repeats inline (a YAML alias) is compared once, and
  its changes are reported under the first operation that reaches it only.
- `oneOf`, `anyOf` and `allOf` entries are matched by position, so reordering
  them reads as changes to each.
- Only the seven JSON Schema type names count in a `type`, and only its first
  32 entries are read.
- On an API with no gateway proxy, two revisions published at the same moment
  can both be compared against the same predecessor, so the history may skip
  the difference between them.

It is bounded however large the documents are:

- **A `$ref` is never expanded where it occurs.** Where both revisions reference
  a component at the same place, the two targets are compared once per
  direction and what differs is reported once under the component's `$ref`,
  with `operation: null`, rather than again at every operation that uses it.
- Every other pair of schema objects is compared once, and every step spends
  from a fixed budget of 244 768 units: twice (100 000 render units, two per
  operation for the operation and its request body, and 16 384 for keyed
  text). Enum values, property and `required` names and parameter `in` and
  `name` are keyed once per enum, schema or parameter, a unit per 256
  characters of their total. Two documents of the same shape fit it, however
  large. Three accepted shapes can still run out, since the render count
  charges them less than the comparison reads them: a component reached from
  more than one of parameters, request bodies and responses; a request body or
  response written as a `$ref` and named by many operations; and enums longer
  than 12 values. A comparison that runs out stops and reports
  `complete: false`; it never blocks the publish.
- Provider-written strings in a change are cut to 200 characters.
- A previous revision whose stored document no longer passes the upload checks
  is not compared at all: its summary is empty with `complete: false`.

---

## APIs (publishing)

Registered under `/api/apis`; every route needs _provider_. Ownership ("your
API, or you are an admin") is checked in the service and answers
`403 FORBIDDEN`.

Spec documents are sent as a JSON string field, not a multipart upload.

**Limits.** Mutations and the two spec diffs are rate-limited per account (see
[Rate limits](#rate-limits)). `POST /api/apis` also enforces
`NEXUS_MAX_APIS_PER_OWNER` (default 50, `0` disables): `429 QUOTA_EXCEEDED` with
`details: { limit, current, setting }`, checked before any gateway write. A
retired API still counts; a deleted one does not.

**A new proxy is never briefly open.** Every proxy is created on an unguessable
staging path, gets its auth, ACL, rate-limit and CORS plugins there, and moves
to `listen_path` as the last gateway write. Until then `listen_path` answers
`404`, never an unauthenticated `200`.

### The `Api` object's gateway fields

`listen_path` and `invoke_url` are **derived on every read** from the
namespace, slug and gateway origin, so moving the gateway never leaves stale
rows. Both also appear on the `ApiSummary` embedded in access requests, grants
and threads.

| Field              | Type                                        | Notes                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen_path`      | string                                      | always `/<namespace>/<slug>`                                                                                                                                                                                                                             |
| `invoke_url`       | string \| null                              | gateway origin + `listen_path`, e.g. `https://api.example.com/nexus/billing`; `null` when neither `gateway.public_url` nor `FERRUM_GATEWAY_PUBLIC_URL` is set                                                                                            |
| `upstream_url`     | string \| null                              | the backend last written to the gateway, normalized to `scheme://host:port[/basePath]` (explicit port, IPv6 bracketed); `null` on older rows                                                                                                             |
| `cors`             | `CorsConfig` \| null                        | `null` means **no `cors` plugin** — no CORS headers at all, which differs from an empty allow-list                                                                                                                                                       |
| `allowed_methods`  | `HttpMethod[]` \| null                      | methods the gateway accepts; `null` accepts all. The proxy's copy also carries `OPTIONS` whenever `cors` is set, because a method outside the list is refused with `405` before any plugin runs                                                          |
| `timeouts`         | `{ connect_ms, read_ms, write_ms }` \| null | backend timeouts; `null` keeps the gateway defaults (5000 / 30000 / 30000 ms)                                                                                                                                                                            |
| `circuit_breaker`  | boolean                                     | `true` attaches Edge's default breaker (5 failures to open, 3 successes to close, 30 s open, trips on 500/502/503/504 and connection errors)                                                                                                             |
| `spec_enforcement` | `docs_only` \| `routes`                     | `docs_only` (default): the document is catalog metadata only. `routes`: the proxy is **spec-owned** — Edge imports the document and generates an `openapi_validator` that answers `400` for an undeclared path or method. **Bodies are never validated** |
| `gateway_state`    | `deployed` \| `repair_required`             | `repair_required` means the portal established that the gateway does not serve this API (a reconciliation repair, or a failed restore). It stays until `POST /api/apis/:id/restore-gateway` succeeds                                                     |

`HttpMethod` is `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`,
`TRACE` or `CONNECT`.

**`CorsConfig`** is `allowed_origins` (1–64 whitespace-free entries of ≤ 255
chars), `allow_credentials` (default `false`), optional `allowed_headers` (≤ 64
header-name tokens of 1–128 chars) and optional `enforce_websocket_origins`
(default `true`).

- On input, `origins` is accepted as an alias for `allowed_origins`; sending
  both with different values is `400 VALIDATION_FAILED` naming both paths.
  Responses always use `allowed_origins`.
- Nexus adds `Accept`, `Authorization`, `Content-Type`, `Origin` and
  `X-Requested-With` (plus `X-API-Key` for `key_auth`) to the gateway's allowed
  request headers. The CORS method list follows `allowed_methods` (with
  implicit `OPTIONS`), or Edge's seven standard methods when unrestricted.
- Unless `enforce_websocket_origins` is `false`, the exact origins are mirrored
  onto the proxy's `allowed_ws_origins`, so Edge rejects WebSocket upgrades
  from unlisted origins or without an `Origin` header. A `*` origin leaves the
  gate empty, and sending `enforce_websocket_origins: true` with a wildcard is
  `400 VALIDATION_FAILED`. `false` removes the gate (authentication and ACLs
  still apply); removing CORS clears it. Older APIs pick this up the next time
  their CORS policy is saved.

**`routes` mode and the document Edge receives.** Nexus sends Edge a copy with
root `servers` set to `/` and every nested `servers` removed (path items,
operations, and path items reached through `$ref` in `components.pathItems`,
`webhooks` and `components.callbacks`); `servers` inside an operation's
`callbacks` is kept. A `routes` document whose `paths` reference a Path Item
outside `#/paths/`, `#/components/pathItems/` or `#/webhooks/` is refused with
`400 SPEC_INVALID` (`details.reason: "unresolvable_path_item_ref"`). The stored
revision is never modified. See
[spec-owned proxies](architecture.md#spec-owned-proxies).

### `GET /api/apis`

_provider_ — `Paginated<Api>`.

| Query             | Type                     | Notes                                                                      |
| ----------------- | ------------------------ | -------------------------------------------------------------------------- |
| `mine`            | boolean                  | an admin's opt-in to "only my APIs"; a provider always sees only their own |
| `owner_user_id`   | id                       | effective for admins only                                                  |
| `status`          | `published` \| `retired` |                                                                            |
| `q`               | substring match          |                                                                            |
| `limit`, `offset` | pagination               |                                                                            |

### `POST /api/apis`

_provider_ → `201 { "api": { … }, "spec": { … } }` — validates the spec, builds
the Edge proxy and plugins, then stores the API.

| Field              | Type                                        | Notes                                                                                                                                                  |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`             | string                                      | 1–200, required                                                                                                                                        |
| `slug`             | string                                      | optional, ≤ 60; normalized to lowercase letters, digits and single hyphens; derived from `name` when omitted                                           |
| `description`      | string \| null                              | ≤ 4000; defaults to the spec's `info.description`                                                                                                      |
| `version`          | string                                      | ≤ 60; defaults to the spec's `info.version`                                                                                                            |
| `upstream_url`     | string                                      | ≤ 2000; optional when the document has a usable absolute `servers[].url`, and overrides it when given                                                  |
| `spec`             | string                                      | required — OpenAPI 3.x as JSON or YAML text, ≤ 2 MiB                                                                                                   |
| `auth_plugin`      | `key_auth` \| `basic_auth` \| `jwt_auth`    | required                                                                                                                                               |
| `requestable`      | boolean                                     | required — `true` attaches `access_control`                                                                                                            |
| `visibility`       | `public` \| `internal` \| `private`         | required                                                                                                                                               |
| `rate_limit`       | `{ limit, window_seconds }` \| null         | `limit` 1–1 000 000, `window_seconds` 1–86 400                                                                                                         |
| `cors`             | `CorsConfig` \| null                        | omit or `null` for no `cors` plugin                                                                                                                    |
| `allowed_methods`  | `HttpMethod[]` \| null                      | 1–9 entries, duplicates collapsed; omit or `null` for all methods. `[]` is rejected (it would accept nothing)                                          |
| `timeouts`         | `{ connect_ms, read_ms, write_ms }` \| null | each 100–300 000 ms; all three required together                                                                                                       |
| `circuit_breaker`  | boolean                                     | default `false`                                                                                                                                        |
| `spec_enforcement` | `docs_only` \| `routes`                     | default `docs_only`; `routes` creates the proxy through Edge's API-spec importer. See [the provider guide](guides/provider-guide.md#enforcement-level) |

**Document limits** (also applied to spec revisions), each `400 SPEC_INVALID`:

- 2 MiB; at most 2 000 paths and 3 000 operations.
- At most 200 levels of object/array nesting
  (`details.reason: "nesting_too_deep"`).
- YAML mapping keys must be scalar (`details.reason: "non_scalar_key"`); an alias
  key that names a scalar is accepted.
- YAML values must be plain objects, arrays or scalars
  (`details.reason: "unsupported_node"`).
- At most 100 000 render units (`details.reason: "too_much_to_render"`, with the
  counts reached), counted over what the viewer renders for each declared
  operation: parameter rows (a path-item parameter under every operation beneath
  it), response entries, media types, and the schemas they hold. A schema costs
  one unit per node, primitive or not, one per rendered property, `items` and
  `oneOf`/`anyOf`/`allOf` entry, and one per enum chip, up to 12. A local
  `$ref` to an object costs two units wherever it appears, and the rest of its
  target is counted once per document; so are the schemas and media types of a
  referenced parameter, request body or response. Components no operation
  reaches, descriptions, type/format strings, `required` names, `not`,
  additional or pattern properties, `prefixItems`, examples and `x-*`
  extensions are not counted.
- A `$ref` in a parameter, request body, response or schema longer than 2 048
  characters (`details.reason: "ref_too_long"`, `details.limit: 2048`).
- A parameter `name` longer than 1 024 characters, or an `in` longer than 64,
  in any path item's or operation's `parameters` list, inline or behind a
  `$ref` (`details.reason: "parameter_name_too_long"` or
  `"parameter_in_too_long"`, with `details.length` and `details.limit`).
  Lengths here count UTF-16 code units, which is what "characters" means in
  the error message; a character outside the Basic Multilingual Plane counts
  as two. A revision stored before these limits and past one is handled like
  any stored document that no longer passes these checks: the catalog does
  not serve it, the change summary of the revision replacing it is recorded as
  incomplete, and a review comparison with it on either side is
  `complete: false` and `changed: true`, listing the operations each document
  declares but no changed ones (or no operations at all when a stored document
  cannot be read even as data, for example one over the stored size limit).
- A derived upstream URL, after server-variable expansion, must fit 2 000
  characters (`details.limit: 2000`, naming the server).
- `routes` with no declared operation (`details.reason: "no_operations"`).

YAML documents are read with the YAML 1.2 core schema, even when they declare
`%YAML 1.1`: `<<` is an ordinary key, and `!!omap`, `!!set`, `!!binary` and
`!!timestamp` tags are ignored. `yes`, `no`, `on` and `off` stay strings, and
`0777` reads as decimal 777. Stored revisions are re-read with the same rules.

The document is bounded by its estimated size when expanded for serving: UTF-8
bytes for every mapping key and scalar at each occurrence, plus per-item
indentation. The catalog's rendered output is checked as a backstop. Either
limit is 4 MiB and returns `400 SPEC_INVALID` with
`details: { reason: "expanded_too_large", limit: 4194304 }`. The same rules apply
to spec revisions, rollbacks and upload diffs.

Errors:

- `400 SPEC_INVALID` — unparseable, Swagger 2.0, missing
  `openapi`/`info.title`/`info.version`/`paths`, over a limit above, no
  upstream determinable, or — unless `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true` — an
  upstream that is loopback, private, link-local or `.internal`/`.local`
  (`details.reason: "private_upstream"`). The host is also resolved: private
  A/AAAA answers are refused the same way (answers in `details.resolved`), and a
  name that does not resolve is `details.reason: "unresolvable_upstream"`.
- `409 CONFLICT` — slug taken. `409 EDGE_NAMESPACE_UNSERVED`.
- `429 QUOTA_EXCEEDED`, `429 RATE_LIMITED`.
- `502 EDGE_ERROR` / `EDGE_UNAVAILABLE` — a failed gateway step is rolled back
  (plugins and proxy deleted) and nothing is stored; since the proxy never left
  its staging path, `listen_path` was never served.

```bash
SPEC=$(jq -Rs . < billing-openapi.yaml)
curl -sS -b cookies.txt -X POST http://127.0.0.1:8787/api/apis \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $CSRF" \
  -d "{\"name\":\"Billing API\",\"slug\":\"billing\",\"version\":\"2.4.0\",
       \"spec\":$SPEC,\"auth_plugin\":\"key_auth\",\"requestable\":true,
       \"visibility\":\"public\",\"rate_limit\":{\"limit\":1000,\"window_seconds\":60}}"
```

### `GET /api/apis/:id`

_provider_, owner or admin

```json
{
  "api": { … },
  "spec": { … },
  "stats": { "pending_requests": 2, "active_grants": 17, "total_requests": 31 }
}
```

`stats` counts **access requests**, not traffic. For gateway traffic use
`GET /api/apis/:id/usage`.

### `GET /api/apis/:id/usage`

_provider_, owner or admin — a read-through of what Ferrum Edge reports for this
API's proxy. Nexus stores no metrics history. Backed by Edge's `GET /metrics`
(`ferrum_requests_total`, `ferrum_request_duration_ms`) and
`GET /admin/metrics` (circuit breakers, unhealthy targets), each cached per
proxy for 10 seconds. 30 requests per minute per IP.

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

| Field                    | Meaning                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `available`              | `false` when the request metrics could not be read, the API has no proxy, or no series belongs to it. Counters are then zeros that mean "unmeasured" — hide them; `latency_ms` is `null` |
| `unavailable_reason`     | optional, display-ready explanation                                                                                                                                                      |
| `requests.*`             | **cumulative since the gateway process started**; a restart resets them. There is no time window                                                                                         |
| `gateway_uptime_seconds` | how far back the counters reach; omitted when not reported                                                                                                                               |
| `latency_ms`             | percentiles interpolated from histogram buckets (like `histogram_quantile`); a quantile in the top bucket reports the highest finite bound; `null` when empty                            |
| `backend.status`         | `healthy` (closed breaker), `failing` (open breaker or ejected target), `recovering` (half-open), `unknown`                                                                              |
| `backend.since`          | present only for an ejected target                                                                                                                                                       |

`unknown` does not mean the backend is down: Edge lists a breaker only for a
proxy that has one and has been called; `detail` says which. Backend state is
read independently — it may be filled while `available` is `false`, and
`unknown` when only it failed. There is no per-consumer breakdown, because
`ferrum_requests_total` has no consumer label.

A gateway that is unreachable or unparseable is **not** an error here: the route
still answers `200`. Errors: `403 FORBIDDEN`, `404 NOT_FOUND`.

### `PATCH /api/apis/:id`

_provider_, owner or admin — runtime settings (the spec has its own route).
Every field is optional; an empty body returns the row unchanged. For the
proxy fields, omitting a field leaves it alone and `null` removes it (or
restores the gateway default).

| Field                            | Effect                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`, `description`, `version` | metadata only                                                                                                                                                                                    |
| `visibility`                     | documentation visibility only, never gateway access. Switching to `private` starts enforcing the existing viewer list; switching away keeps the list                                             |
| `status`                         | `published` ⇄ `retired` — **catalog state only**; the proxy and live grants keep working                                                                                                         |
| `upstream_url`                   | re-points the proxy's backend (same validation as `POST`)                                                                                                                                        |
| `auth_plugin`                    | swaps the auth plugin (new one attached before the old is removed). May need confirmation — see below                                                                                            |
| `requestable`                    | attaches or removes `access_control`. Turning it **off** opens the API to every authenticated consumer; existing grants become inert                                                             |
| `rate_limit`                     | attaches, replaces or removes `rate_limiting`                                                                                                                                                    |
| `cors`                           | attaches, replaces or removes `cors`; also re-derives `allowed_ws_origins` and the implicit `OPTIONS`. It does not change a `routes` API's operation table: the CORS preflight is answered first |
| `allowed_methods`                | replaces the method list, or `null` for all methods                                                                                                                                              |
| `timeouts`                       | replaces all three timeouts; `null` writes the gateway defaults explicitly                                                                                                                       |
| `circuit_breaker`                | attaches or removes Edge's default breaker                                                                                                                                                       |
| `spec_enforcement`               | **rebuilds the proxy** from the current revision (see below)                                                                                                                                     |
| `confirm_access_disruption`      | `true` confirms an `auth_plugin` change that would lock grantees out                                                                                                                             |

→ `{ "api": Api, "outgoing_auth_configs_remaining"?: string[] }` — the second
field only after an `auth_plugin` change that left an operator's enabled,
associated config of the outgoing plugin on the proxy (it still accepts the old
credentials; the ids say which configs to remove).

**Only the portal's own plugin configs are touched.** Nexus records the Edge
config ids of the auth, `access_control`, `rate_limiting` and `cors` configs it
creates, and changes only those. An operator's config of the same plugin name
is never rewritten or deleted: setting `rate_limit` beside an operator's
limiter adds the portal's own (both apply), and `null` removes only the
portal's.

**Changing `auth_plugin`.** Edge runs one authentication plugin per proxy, so
every credential of the outgoing flavour stops working on this API the moment
the swap lands.

- While any grantee holds a live credential of the outgoing flavour, the change
  is refused with `409 ACCESS_DISRUPTION_CONFIRMATION_REQUIRED`. `details`
  carries `field`, `current_auth_plugin`, `requested_auth_plugin`,
  `credential_type`, `affected_grantees` (accounts that would be locked out)
  and `confirm_field`, plus `outgoing_auth_configs_remaining` when an operator
  config would keep accepting the old credentials. Resend with
  `confirm_access_disruption: true` to proceed. An API with
  `requestable: false` has no grantees and is never refused.
- Grantee credentials are **not** revoked — they still work on their other APIs
  of that flavour; each grantee is notified to issue a credential of the new
  flavour. The API's own `nexus-test-<api_id>` credentials are revoked. One
  `api.auth_plugin_changed` audit row summarizes both.

**Changing `spec_enforcement`** briefly interrupts the API. Edge only attaches
or detaches an `api_spec` by creating or deleting the proxy, so Nexus deletes
and rebuilds it under the **same proxy id**, carrying the proxy document and
every plugin config across with their ids. For those few round trips
`listen_path` answers `404`; the audit row has `proxy_rebuilt: true`. Every
other setting, and every spec revision, is an in-place write.

**An API without a gateway deployment takes catalog edits only.** While
`ferrum_proxy_id` is `null` (after a reconciliation repair or a failed
restore), a PATCH that sets any gateway field is refused; name, description,
version, visibility and status still save. Restore it first with
[`POST /api/apis/:id/restore-gateway`](#post-apiapisidrestore-gateway).

Enforcement conversion, runtime PATCH, spec revision and deletion serialize on
one per-proxy lease, and a waiting request re-reads the API afterwards.

Errors:

- `400 SPEC_INVALID` — bad or private `upstream_url` (see `POST /api/apis`), or
  `routes` requested while the current revision declares no operations.
- `409 ACCESS_DISRUPTION_CONFIRMATION_REQUIRED` — see above.
- `409 CONFLICT` —
  - a gateway field on an API with no deployment (`details.fields`);
  - a change to `auth_plugin`, `requestable`, `rate_limit` or `cors` on an API
    published before plugin ownership was recorded, whose proxy has two configs
    the portal could have created, or (for `auth_plugin`, `requestable`,
    `cors`) one that no longer matches the API's settings (`details.plugin_names`,
    and `details.plugin_config_ids` in the second case);
  - the proxy changed while the request waited for the lease (reload and
    retry).
- `502 EDGE_ERROR`.

### `DELETE /api/apis/:id`

_provider_, owner or admin → `{ "ok": true }`.

In order:

1. The Edge proxy is deleted first, cascading its plugin associations and
   proxy-scoped configs; any config the cascade missed is removed after.
2. The API's test identity (`nexus-test-<api_id>` consumer, its credentials and
   ACL group) is torn down.
3. Grants, requests, spec revisions, spec change summaries and the API row are
   deleted in one transaction, with the `api.delete` audit row.
4. The ACL group is stripped from each grantee's consumer (outside the proxy
   lease; a failure is logged, not retried — the group has nothing left to
   authorize), and grantees are notified.

An `api.delete_start` audit row is committed before the first gateway call. A
failure after the gateway steps leaves the API in the catalog; the gateway
steps are safe to repeat, and a retry's `api.delete` row carries
`resumed: true` with the test identity recorded by the start row. A gateway
refusal is `502 EDGE_ERROR` with the API left in place.

Errors: `404 NOT_FOUND` (including an API already deleted by a concurrent
request), `409 CONFLICT` (the proxy changed while waiting for the lease),
`502 EDGE_ERROR`.

### `GET /api/apis/:id/spec`

_provider_, owner or admin — the **original** current upload, without the
catalog's server rewriting: the same fields as
[`GET /api/catalog/:slug/spec`](#get-apicatalogslugspec), with `raw_spec`
holding the uploaded JSON or YAML text (outer whitespace trimmed).
`404 NOT_FOUND` when the API or its current spec is absent.

### `PUT /api/apis/:id/spec`

_provider_, owner or admin — publish a new spec revision. Body: `spec`
(required), `version` (optional; defaults to the parsed `info.version`).

→ `{ "api": { … }, "spec": { … } }`

- The new revision becomes current. Revisions older than the
  `NEXUS_SPEC_HISTORY_LIMIT` newest (default 10, besides the current one) are
  pruned in the same transaction.
- In the same transaction, what the revision changed against the one it
  replaces is recorded for consumers: see
  [`GET /api/catalog/:slug/changes`](#get-apicatalogslugchanges). The
  `api.spec_update` (or `api.spec_rollback`) row carries
  `spec_changes: { breaking, non_breaking, complete }`.
- **Grantees are told.** Once the revision has committed, when the comparison
  found a change, every account holding an active grant on the API gets an
  `api_spec_updated` notification, and a `spec_updated` email if it turned
  email on, once per account however many of its identities hold a grant, and
  never the account that published. Each channel follows the account's
  [notification preferences](#get-apiusersmenotification-preferences). A
  second notice waits until the first is read (the unread one is rewritten
  instead), and at most one email per API per account goes out per clock hour
  (the outbox idempotency key `spec-updated:<api>:<user>:<hour>`). One fan-out
  queues at most `NEXUS_MAX_MASS_EMAIL_RECIPIENTS` emails; past that, accounts
  get the in-app notice only. The fan-out commits in batches of 200 accounts,
  each with an `api.spec_notify` audit row, and a batch that fails does not
  stop the next. Fan-outs of one API run one at a time: one published while
  another is running waits, and of several waiting only the newest runs, still
  marking its notices breaking if one it replaced was. It is
  **detached and best-effort**: the response does not wait for it, a failure
  is logged and never fails the publish, and on a graceful stop the server
  waits at most 10 seconds for it and skips the batches left; nothing retries
  them.
- **Backend following.** The proxy is re-pointed at the new document's
  `servers[0]` only when the API's `upstream_url` still equals the normalized
  `servers[0]` of the previous revision (scheme, host, port and base path).
  Otherwise `upstream_url` is treated as a pin and left alone.
- A `routes` API has its document re-submitted to Edge, which regenerates the
  operation table (and applies any backend move) in one call. Portal plugin
  configs are untouched, so the API is never unauthenticated.
- If the revision cannot be stored after the gateway moved, the gateway is put
  back. Audit rows: `api.spec_revision_start` (for a revision that rewrites a
  live proxy; if it cannot be written nothing reaches the gateway),
  `api.spec_update` with the revision, and `api.spec_revision_failed`
  (`restored` says whether the gateway was put back).

Errors: the document limits and `SPEC_INVALID` cases of `POST /api/apis`
(including `no_operations` in `routes` mode — switch to `docs_only` first),
`409 EDGE_NAMESPACE_UNSERVED`, `502 EDGE_ERROR`.

### `GET /api/apis/:id/viewers`

_provider_, owner or admin — `Paginated<ApiViewer>`, newest first. Each item has
`user_id`, `user` (`UserSummary` \| null), `granted_by`, `note` and timestamps.
The list is kept whatever the visibility and only enforced while the API is
`private`.

### `POST /api/apis/:id/viewers`

_provider_, owner or admin → `201 { "viewer": ApiViewer }` — authorize one
account to **read** this API's documentation.

Body: exactly one of `email` or `user_id`, plus optional `note` (≤ 500).

**This is not a grant**: no ACL group, no consumer, no gateway call. The viewer
can find the API and read its spec; to call it they still request access. Audit
rows record `details.grants_invocation: false`. The account is notified.

| Status                  | Meaning                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `201`                   | authorized; re-authorizing an existing viewer refreshes the note                                                                                                                                 |
| `400 VALIDATION_FAILED` | no account matches (addresses are not stored as pending invitations), the account is an administrator (same answer as unknown, so admin roles are not revealed), or both/neither identifier sent |
| `403 FORBIDDEN`         | not the owner or an admin                                                                                                                                                                        |
| `409 CONFLICT`          | the account is the API's owner                                                                                                                                                                   |

### `DELETE /api/apis/:id/viewers/:userId`

_provider_, owner or admin → `{ "ok": true }` — withdraw a read authorization.
`404 NOT_FOUND` when the account was not a viewer.

Any grant the account holds is untouched (`details.revoked_grant: false`), and a
grantee can still read the API. Revoke a grant with
[`POST /api/grants/:id/revoke`](#post-apigrantsidrevoke).

### `GET /api/apis/:id/revisions`

_provider_, owner or admin — the retained spec history, paginated: the current
revision first, then newest first.

Each item is an `ApiSpecSummary`: `id`, `api_id`, `version`, `parsed_title`,
`parsed_version`, `is_current`, `created_by` (`null` when unknown),
`rolled_back_from_id` (the revision a rollback restored, else `null`),
`created_at`, `updated_at`.

### `GET /api/apis/:id/revisions/:revisionId`

_provider_, owner or admin — one retained revision's document, shaped like
`GET /api/apis/:id/spec`. `404 NOT_FOUND` when the revision is not retained or
belongs to another API.

### `GET /api/apis/:id/revisions/:revisionId/diff`

_provider_, owner or admin — what rolling back to this revision would change →
`{ "diff": SpecDiff }`, with `from` = the current revision and `to` = the
target.

### `POST /api/apis/:id/spec/diff`

_provider_, owner or admin — what uploading a document would change, without
storing anything. Body `{ "spec": "…" }` → `{ "diff": SpecDiff }`, with `from`
= the current revision and `to: null`. `400 SPEC_INVALID` for a document the
portal would refuse to publish.

#### The `SpecDiff` shape

| Field                                     | Meaning                                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`                              | `ApiSpecSummary` \| null                                                                                                                                                                                                                    |
| `added_operations` / `removed_operations` | operations (`{ path, method }`) only in the target / only in the source                                                                                                                                                                     |
| `changed_operations`                      | operations in both whose definitions differ, with `changes`: the differing members (`parameters`, `requestBody`, `responses`, `security`, `summary`, `description`, `deprecated`, `tags`, `servers`, `operationId`, `callbacks`) or `other` |
| `added_paths` / `removed_paths`           | path templates added or dropped outright                                                                                                                                                                                                    |
| `info_changes`                            | `title`, `version` or `description` differences as `{ field, from, to }`                                                                                                                                                                    |
| `servers_changed`                         | whether the `servers` block differs                                                                                                                                                                                                         |
| `potentially_breaking`                    | every removed operation                                                                                                                                                                                                                     |
| `complete`                                | `false` when it ran out of its work budget, or a stored revision compared no longer passes the upload checks: added and removed operations still listed, changed ones not                                                                   |
| `changed`                                 | whether the documents differ at all; also `true` when `complete` is `false`                                                                                                                                                                 |

The comparison is **structural**: it does not resolve `$ref`s, walk schemas or
reason about semantics. A response schema can lose a required field with every
path and method unchanged, so an empty `potentially_breaking` means this
comparison found nothing, not that the change is compatible. Path-level
`parameters` are folded into each operation (an operation parameter with the
same `name` and `in` overrides) and compared in canonical order, so moving or
reordering parameters is not a change.

Folding parameters spends from a fixed work budget of 500 000 units, with each
parameter's identity read once per document: a unit per operation, per
parameter entry keyed and per entry merged, plus a unit per 256 characters of
`in` and `name` keyed, counted over the whole comparison. Under the document
limits above a pair of documents costs at most 438 768, so any pair the portal
accepted fits it; a comparison that runs out returns `complete: false` rather
than a partial list that would read as "nothing else changed".

### `POST /api/apis/:id/revisions/:revisionId/rollback`

_provider_, owner or admin — redeploy a retained revision. Empty body →
`{ "api": { … }, "spec": { … } }`.

A rollback is a **new revision carrying the old document**: the returned `spec`
is the new revision, with `rolled_back_from_id` naming the target. The API
keeps its id, slug, owner, grants, proxy and gateway URL. It runs through the
same path as `PUT /api/apis/:id/spec` — validation, gateway-first ordering,
compensation, retention.

| Status           | Meaning                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `200`            | the restored document is current and the gateway agrees                                                 |
| `403 FORBIDDEN`  | not the owner or an admin                                                                               |
| `404 NOT_FOUND`  | the revision is not retained (retention may have dropped it) or belongs to another API; nothing written |
| `409 CONFLICT`   | the target is already current; also `409 EDGE_NAMESPACE_UNSERVED`                                       |
| `502 EDGE_ERROR` | the gateway refused or was unreachable; the catalog is unchanged                                        |

Audited as `api.spec_rollback` (with `restored_from_spec_id`,
`restored_from_version`, `restored_from_created_at`); start and failure rows are
`api.spec_revision_start` / `api.spec_revision_failed` with
`operation: "rollback"`.

### `POST /api/apis/:id/restore-gateway`

_provider_, owner or admin — rebuild the gateway deployment of an API the
gateway no longer serves. Empty body →
`{ "api": { … }, "spec": { … }, "proxy_id": "…" }`.

**Non-destructive.** The API keeps its id, slug, owner, spec history, gateway
URL and grants; only the Edge objects are recreated, from what the portal
stores. Approved clients keep their credentials: the ACL group is derived from
the API id, so their existing consumer groups match again. Anything configured
directly on the gateway (an operator's plugin config, a hand edit such as
`hide_credentials: false`) was deleted with the proxy and is not restored.

What is rebuilt, in publish order: the proxy (through the API-spec importer in
`routes` mode), the auth plugin, `access_control` when `requestable`, the rate
limit, CORS, and the [plugin palette](#plugin-palette); then the move onto
`/<namespace>/<slug>` as the last write. The current revision is deployed; no
new revision is written (you can `PUT /api/apis/:id/spec` first to correct it).

| Status           | Meaning                                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`            | rebuilt — or the stored proxy was live after all and the flag was simply cleared (`rebuilt: false` in the audit row)                                                                           |
| `403 FORBIDDEN`  | not the owner or an admin                                                                                                                                                                      |
| `404 NOT_FOUND`  | no such API                                                                                                                                                                                    |
| `409 CONFLICT`   | a live proxy already exists; no stored spec revision; another restore is in flight; or the API's settings or current spec changed during the build (retry). Also `409 EDGE_NAMESPACE_UNSERVED` |
| `502 EDGE_ERROR` | the gateway refused or was unreachable. An unreachable gateway is never read as a deleted proxy; the row is unchanged                                                                          |

Audit rows: `api.gateway_restore_start` (before the first gateway call; if it
fails, nothing is built), `api.gateway_restore` with the new proxy id, and on
failure `api.gateway_restore_failed` (with `stranded_proxy_id` when the cleanup
delete could not be confirmed). A failed restore removes what it created and
leaves the API `repair_required`, ready to retry.

### `POST /api/apis/:id/test-consumer`

_provider_, owner or admin → `201` — **show-once.** Body
`{ "label"?: string | null }` (≤ 120).

```json
{
  "credential": { "id": "…", "credential_type": "keyauth", "last4": "9f2a", … },
  "consumer_username": "nexus-test-2b1c…",
  "secret": { "type": "keyauth", "key": "nxs_pQ7…" }
}
```

Creates — or **replaces** with a new, distinct consumer — the disposable
consumer `nexus-test-<api_id>`, carrying this API's ACL group and one
credential of the API's auth type. The replaced consumer's credential rows move
to `revoked`. The secret appears in this response only.

The consumer belongs to whoever created it last (an admin recreating a
provider's takes it over), and that account being disabled takes it down.
Deleting the API deletes it.

Errors: `403 USER_DISABLED` (caller disabled mid-request; nothing created),
`404 NOT_FOUND` (including an API deleted concurrently), `409 CONFLICT`
(`auth_plugin` changed while the credential was issued — retry),
`502 EDGE_ERROR` (nothing is left behind; the compensation finds and deletes
the consumer by its id).

---

## Plugin palette

Three routes under `/api/apis/:id/plugins`, _provider_, owner or admin. They
hold **state only**: which curated Edge plugins this API has switched on and
how each is configured.

The palette itself — which plugins exist and what each accepts — is the static
`PROVIDER_PLUGINS` catalog exported from `@ferrum-nexus/shared`
(`shared/src/plugins.ts`); there is no route for it. It offers
`security_headers`, `request_size_limiting`, `response_size_limiting`,
`ip_restriction`, `bot_detection`, `correlation_id`, `compression`,
`request_deduplication` and `request_termination`.

- `compression` and `request_deduplication` get default `priority_override`
  values of 3005 and 4060, so compression finishes before deduplication
  fingerprints the request. An operator's overrides survive saves; an
  incompatible pair is `400 VALIDATION_FAILED` naming both plugins.
- `response_caching` is **retired**: Edge only caches an authenticated
  response when the backend opts in with `Cache-Control: public`,
  `must-revalidate` or `s-maxage`, which consumer settings cannot provide.
  Existing rows are still listed and can be disabled or deleted; enabling it
  is `400 VALIDATION_FAILED`.

### The `ApiPlugin` object

| Field         | Type                       | Notes                                                                                                          |
| ------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `plugin_name` | string                     | the exact Edge plugin name                                                                                     |
| `enabled`     | boolean                    | `false` keeps the config and its proxy association, but Edge does not run it — a pause that keeps the settings |
| `config`      | object                     | exactly the keys the plugin's descriptor declares; any other key is `400 VALIDATION_FAILED`                    |
| `trigger`     | `ApiPluginTrigger` \| null | restrict the plugin to some methods and/or a path prefix; `null` runs it on every request                      |
| `created_at`  | ISO-8601                   | when the plugin was first switched on; survives a replace                                                      |
| `updated_at`  | ISO-8601                   | last save                                                                                                      |

`ApiPluginTrigger` is `{ methods?: HttpMethod[], path_prefix?: string }`; at
least one is required, and both together are ANDed. `path_prefix` matches the
canonical request path, which **includes the `listen_path`**. It must start
with `/` and contain no whitespace, percent escape, backslash, `.`/`..` segment
or empty segment other than a trailing slash, each segment judged on its text
before any `;` parameter (`/..;x`, `/a//b` and `/;x/b` are refused, as Edge
`v0.9.10` refuses them).

A `correlation_id` or `request_deduplication` `header_name` in the
gateway-owned `x-consumer-*` namespace (any case, `_` and `-` alike) is
`400 VALIDATION_FAILED`: Edge strips those headers from every client request.

Plugins whose descriptor has `supports_trigger: false` — `security_headers`,
`request_size_limiting`, `response_size_limiting`, `compression`,
`correlation_id` (and the retired `response_caching`) — refuse a trigger with
`400 VALIDATION_FAILED`.

### `GET /api/apis/:id/plugins`

_provider_, owner or admin → `{ "plugins": ApiPlugin[] }`, oldest first.

### `PUT /api/apis/:id/plugins/:name`

_provider_, owner or admin → `{ "plugin": ApiPlugin }`. Creates or replaces.

```json
{
  "enabled": true,
  "config": { "allow": ["203.0.113.0/24"], "mode": "allow_first" },
  "trigger": { "methods": ["POST"], "path_prefix": "/nexus/billing/invoices" }
}
```

`enabled` defaults to `true`; `trigger` may be omitted or `null`. `config` is
validated against the descriptor **before any gateway write**, with field-level
`details`.

The gateway side is a proxy-scoped plugin config plus its entry in the proxy's
`plugins[]`. A replace keeps the config id, so the plugin is never briefly
missing. The `api_plugins` row and `api.plugin_set` audit row are written last,
and a store failure rolls the gateway back. Only the config the portal created
(by recorded id) is touched; an operator's config of the same name, and fields
the portal does not model such as `priority_override`, are left alone.

| Status | Code                | When                                                                                                                                                                                                                                                                                |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_FAILED` | invalid config, a trigger on a plugin that cannot take one, or a plugin managed from an API field (`key_auth`/`basic_auth`/`jwt_auth` → `auth_plugin`, `access_control` → `requestable`, `rate_limiting` → `rate_limit`, `cors` → `cors`, `openapi_validator` → `spec_enforcement`) |
| `403`  | `FORBIDDEN`         | not the owner or an admin                                                                                                                                                                                                                                                           |
| `404`  | `NOT_FOUND`         | the API, or a plugin outside the palette                                                                                                                                                                                                                                            |
| `409`  | `CONFLICT`          | the API has no gateway proxy                                                                                                                                                                                                                                                        |

### `DELETE /api/apis/:id/plugins/:name`

_provider_, owner or admin → `{ "ok": true }`. Disassociates and deletes the
portal's config, then removes the row. `404 NOT_FOUND` when the API never had
that plugin. An operator's config of the same name stays; a portal config
already removed by hand is tolerated.

Audit rows: `api.plugin_remove_start` before the gateway write, then
`api.plugin_remove` with the row delete. If that final transaction fails, the
config is put back under its recorded id (`api.plugin_rollback`) and the
request can be repeated.

Deleting the API removes its palette rows; the proxy delete cascades the
gateway configs.

### What the palette does not cover

The other auth plugins (`hmac_auth`, `jwks_auth`, `oauth2_introspection`,
`mtls_auth`) change the credential model and are not offered; nor is
`spec_expose`. Operator plugins (log sinks, telemetry, mesh, chaos, load
testing) are out of scope by design. See
[the provider guide](guides/provider-guide.md#plugins).

---

## Access requests

Registered under `/api/access-requests`; _session_. A client raises and cancels
their own requests. An API's owner must still hold at least the `provider` role
to approve, deny or revoke (a demoted owner gets `403 FORBIDDEN`); an admin may
decide on any API.

### `GET /api/access-requests`

_session_ — `Paginated<AccessRequest>`, each row with `api` and `requester`
summaries.

| Query             | Type                                                            |
| ----------------- | --------------------------------------------------------------- |
| `mine`            | boolean — only the caller's own requests                        |
| `api_id`          | id                                                              |
| `status`          | `pending` \| `approved` \| `denied` \| `revoked` \| `cancelled` |
| `limit`, `offset` | pagination                                                      |

A `client` (or anyone with `mine=true`) sees their own; a `provider` sees
requests for APIs they own; an `admin` sees all. A provider filtering by an
`api_id` they do not own gets `403 FORBIDDEN`.

### `POST /api/access-requests`

_session_ → `201 { "access_request": AccessRequest }`

Body: `api_id`, `justification` (1–2000 chars), optional `application_id` (one
of the caller's own active applications; absent or `null` means the account
itself).

**Limits.** 10 a minute per account, and
`NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY` (default 20, `0` disables) in a
rolling 24 hours — `429 QUOTA_EXCEEDED` with `limit`, `window` and `setting`
in `details`. The daily budget counts `access.request` audit rows, so cancelled
requests and requests of since-deleted applications still count.

Errors:

- `404 NOT_FOUND` — unknown API, a `private` API the caller may not read
  (checked first, so a hidden API always looks absent), or unknown application.
- `403 FORBIDDEN` — the application belongs to someone else (not even an admin
  may act as another account's application).
- `409 CONFLICT` — you own the API; it is retired; it is not requestable; this
  identity already has access or a pending request; the application is
  disabled.

`internal` APIs are not gated: they are unlisted, not private.

```bash
curl -sS -b cookies.txt -X POST http://127.0.0.1:8787/api/access-requests \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $CSRF" \
  -d '{"api_id":"2b1c…","justification":"Reconciling invoices for the Acme integration."}'
```

### `POST /api/access-requests/:id/cancel`

_session_, **requester only** → `{ "access_request": AccessRequest }`. No body.
`403 FORBIDDEN` for anyone else; `409 CONFLICT` when no longer `pending`.

### `POST /api/access-requests/:id/approve`

_session_, **API owner with the provider role, or admin**. Body
`{ "decision_note"?: string | null }` (≤ 2000), or no body.

```json
{ "access_request": { …, "status": "approved" }, "grant": { …, "acl_group": "nexus:api:2b1c…:approved" } }
```

The request is claimed as approved (compare-and-set), the requesting identity's
Edge consumer is created if needed and gets the ACL group
`nexus:api:<api_id>:approved`, then the grant row commits. The requester gets a
notification and an `access_approved` email. Approval holds the API's proxy
lease, so it cannot interleave with retirement or a revocation.

Errors: `403 FORBIDDEN`; `409 CONFLICT` (already decided, the identity already
holds an active grant, the API is retired or no longer requestable, or the
request's application is disabled or deleted — the request stays `pending`);
`502 EDGE_ERROR` / `EDGE_UNAVAILABLE`. A failed approval removes the ACL
addition and returns the request to `pending` where possible; the
`access.approve_rollback` audit row records the outcome (with
`acl_group_possibly_applied: true` when the gateway write was not
acknowledged). Check the request and grant before retrying an ambiguous
failure.

### `POST /api/access-requests/:id/deny`

_session_, **API owner with the provider role, or admin** →
`{ "access_request": AccessRequest }`. Body `{ "decision_note"?: string | null }`,
optional. Nothing changes on the gateway. `409 CONFLICT` when already decided.

---

## Grants

Registered under `/api/grants`; _session_.

### `GET /api/grants`

_session_ — `Paginated<Grant>`, each row with `api` and `user` summaries. Query:
`mine` (boolean), `api_id`, `user_id` (admins only), `status` (`active` \|
`revoked`), `limit`, `offset`. Scoped like access requests: own, owned APIs,
or everything.

### `POST /api/grants/:id/revoke`

_session_, **API owner with the provider role, or admin** →
`{ "grant": Grant }`. Body `{ "reason"?: string | null }` (≤ 2000), optional.

Removes the ACL group from the grantee's consumer, marks the grant `revoked`,
and moves the originating access request to `revoked`. The grantee is notified
and emailed. `409 CONFLICT` when already revoked. Revocation holds the API's
proxy lease, like approval.

---

## Credentials

Registered under `/api/credentials`; _session_.

**Plaintext credential material appears in exactly three responses —
`POST /api/credentials`, `POST /api/credentials/:id/rotate` and
`POST /api/apis/:id/test-consumer` — and only once.** Nexus stores a SHA-256
fingerprint and the last four characters; Edge redacts material on every
read.

A credential belongs to an **identity**: the account itself, or one of its
[applications](#applications). Each identity has its own Edge consumer
(`nexus-user-<user_id>` or `nexus-app-<application_id>`).

### `GET /api/credentials`

_session_ — `Paginated<CredentialMetadata>`; never contains a secret.
`edge_ordinal` is the row's append position within its consumer and type
(`null` when unknown).

| Query             | Type                                | Notes                                                                     |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `status`          | `active` \| `retiring` \| `revoked` |                                                                           |
| `application_id`  | id \| `account`                     | one application's credentials, or `account` for the account's own         |
| `user_id`         | id                                  | **admin only** — another account's credentials; `403 FORBIDDEN` otherwise |
| `limit`, `offset` | pagination                          |                                                                           |

### `POST /api/credentials`

_session_ → `201` — **show-once.**

Body: `credential_type` (`keyauth` \| `basicauth` \| `jwt`), optional `label`
(≤ 120, nullable), optional `application_id` (one of the caller's own active
applications; absent or `null` issues for the account).

```json
{
  "credential": { "id": "…", "credential_type": "keyauth", "fingerprint": "…",
                  "last4": "9f2a", "status": "active", "rotated_from_id": null,
                  "edge_ordinal": 1, … },
  "consumer_username": "nexus-user-7c1d…",
  "secret": { "type": "keyauth", "key": "nxs_pQ7…" }
}
```

| `credential_type` | `secret` fields                                   | How the client authenticates                                                           |
| ----------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `keyauth`         | `key`                                             | `X-API-Key: <key>`                                                                     |
| `basicauth`       | `username` (= the consumer username), `password`  | HTTP Basic `<consumer username>:<password>`                                            |
| `jwt`             | `jwt_secret`, `jwt_key` (= the consumer username) | HS256 JWT signed with `jwt_secret`, `sub` = `jwt_key`, sent as `Authorization: Bearer` |

Errors: `409 CONFLICT` when this identity already holds
`FERRUM_MAX_CREDENTIALS_PER_TYPE` (default 2) live credentials of that type
(revoke or rotate one first), the application is disabled, or an earlier
`basicauth` change on this identity was never confirmed by the gateway
(`details.unconfirmed_credentials`; see
[`DELETE /api/credentials/:id`](#delete-apicredentialsid));
`403 FORBIDDEN` (someone else's application); `404 NOT_FOUND` (unknown
application); `502 EDGE_ERROR` / `EDGE_UNAVAILABLE`.

A `basicauth` row is written as `retiring` before the gateway append and
becomes `active` once Edge acknowledges it. If the append's outcome cannot be
confirmed, the request fails and the row stays `retiring`: it names the entry
that may exist on the gateway, and no secret is returned.

```bash
curl -sS -b cookies.txt -X POST http://127.0.0.1:8787/api/credentials \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $CSRF" \
  -d '{"credential_type":"keyauth","label":"laptop"}'
```

#### What the provider's upstream sees

The gateway strips a key or a Basic password before proxying, but **forwards a
bearer token**:

| `credential_type` | Reaches the provider's backend?                                                             |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `keyauth`         | **No** — Edge's `key_auth` defaults to `hide_credentials: true`, so `X-API-Key` is stripped |
| `basicauth`       | **No** — `basic_auth` likewise strips `Authorization: Basic`                                |
| `jwt`             | **Yes** — `Authorization: Bearer <token>` is forwarded unchanged                            |

This is Edge's behaviour, not a Nexus setting: `jwt_auth` has no
credential-hiding option. The signing secret is never forwarded, so a provider
cannot mint tokens as the client, but it can replay a token it received until
its `exp` — which Edge requires by default but does not cap. Keep `exp` short
and put nothing in a claim you would not show the provider. See the
[client guide](guides/client-guide.md).

### `POST /api/credentials/:id/rotate`

_session_, **owner only** → **show-once.** Body `{ "label"?: string | null }`,
optional; defaults to the previous label.

```json
{
  "credential": { "id": "new…", "rotated_from_id": "old…", "status": "active", … },
  "previous":   { "id": "old…", "status": "revoked", … },
  "consumer_username": "nexus-user-7c1d…",
  "secret": { "type": "keyauth", "key": "nxs_r3W…" }
}
```

- **Below the cap**, the replacement is appended on Edge first, then the old
  entry is deleted before the response returns. Both work only for the
  duration of the call — there is no caller-controlled overlap. For a
  zero-downtime cutover, issue a new credential, deploy it, then revoke the old
  one.
- **At the cap** there is no room to append, so the old entry is deleted first,
  leaving a brief window with no working credential of that type. If the append
  then fails, the response is `502 EDGE_ERROR` saying the previous credential
  was removed; issue a new one.
- The old credential passes through `retiring` (recorded before the gateway
  delete, with a `credential.revoke_start` audit row) and settles at
  `revoked`. After a successful rotation `previous.status` is always
  `revoked`.
- If the delete fails below the cap, the appended replacement is removed again
  and the original error returned. If that also fails, `details` carries
  `stranded_credential_id` and `retired_credential_id`, and the message says
  whether the gateway still holds both (revoke the named one yourself) or
  neither could be confirmed (an administrator must reconcile — see
  [`operations.md`](operations.md#12-the-credential-mirror)).
- **Only the credential's owner can rotate it, whatever their role.** The
  replacement stays on the same consumer with the same grants, so its secret
  acts as that account or application; returning it to anyone else would let
  them call the identity's APIs. An `admin` or `super_admin` gets
  `403 FORBIDDEN` before anything reaches the gateway, and nothing is minted.
  To take a credential away, an administrator
  [revokes](#delete-apicredentialsid) it; the owner then issues a new one.
- The owner is notified and emailed (`credential_rotated`).

Errors: `403 FORBIDDEN` (someone else's credential, including for an
administrator), `403 USER_DISABLED` (the owner is disabled), `409 CONFLICT` (already revoked, the credential's
application is disabled — revoking stays allowed — or, for `basicauth`, an
unconfirmed change on the same identity), `502 EDGE_ERROR` (including a gateway
credential list that no longer matches the portal's, which is refused rather
than guessed at).

### `DELETE /api/credentials/:id`

_session_, owner or admin → `{ "ok": true }`. Deletes the entry from Edge and
marks the row `revoked`. This is how an administrator takes away another
account's or application's credential; unlike rotation, it returns no secret. Idempotent: an already-revoked credential succeeds
without a gateway call.

The row moves to `retiring` (with `credential.revoke_start`) before the gateway
delete and to `revoked` (with `credential.revoke`) after. If the last step
fails, repeating the request completes it. If the gateway proves the delete
never happened, the row returns to `active` with a
`credential.revoke_rollback` row, and the request can be repeated.

**`basicauth` is located by the portal's rows alone**, because Edge never lists
it. So:

- Revoking a `basicauth` credential when no other `basicauth` credential of the
  identity is `active` deletes the whole type on the gateway, and every
  `retiring` row of that identity and type settles to `revoked` with it
  (listed in the `credential.revoke` row's `swept_credential_ids`).
- While any `basicauth` row of the identity is `retiring` — an append or delete
  whose outcome the gateway never confirmed — issuing, rotating and revoking a
  single credential by position are `409 CONFLICT` with
  `details.unconfirmed_credentials` and `details.active_credentials`. With no
  `active` row left, revoking the retiring one clears the type; otherwise the
  message points to `clear_type=true`.
- `DELETE /api/credentials/:id?clear_type=true` explicitly deletes every HTTP
  Basic credential of that consumer identity, settles every live row, and
  writes `scope: "whole-type"` in the target's `credential.revoke` audit row;
  each other row it settles gets its own `credential.revoke` row. It answers
  `400 VALIDATION_FAILED` on a credential that is not `basicauth`, and
  `403 FORBIDDEN` for a non-admin caller when the consumer holds a live row
  attributed to another account.
- On the first start after upgrading, Nexus writes a `retiring` placeholder for
  each earlier-release `basicauth` append recorded as not taken back that no
  live row accounts for, unless a later reconcile or whole-type revoke cleared
  that consumer ([`operations.md` §12](operations.md#12-the-credential-mirror)).
  This does not cover restores: after restoring only Nexus, reconcile
  `basicauth` for every consumer before relying on revoking a single HTTP Basic
  credential.

---

## Applications

Registered under `/api/applications`; _session_. An **application** is a
separate gateway identity owned by an account, with its own Edge consumer
(`nexus-app-<application_id>`), its own approved APIs and its own credentials.
ACL groups live on the consumer, so two applications of one owner approved for
different APIs cannot call each other's.

- Access requests, grants, credentials and consumer mappings carry a nullable
  `application_id`; `null` means the account itself, which is the default.
- To act as an application, pass `application_id` on
  [`POST /api/access-requests`](#post-apiaccess-requests) or
  [`POST /api/credentials`](#post-apicredentials). It must be the caller's own
  (`403 FORBIDDEN` otherwise — not even an admin may act as another account's)
  and `active` (`409 CONFLICT` otherwise).
- A credential's `label` is only a note; `application_id` decides what the
  credential can call.

Reads and writes of someone else's application answer `404 NOT_FOUND`, except
for admins.

### `GET /api/applications`

_session_ — `Paginated<Application>`, newest first; each item carries
`active_grants` and `active_credentials`. A client sees their own; an admin
sees everyone's unless narrowed.

| Query             | Type                                                                |
| ----------------- | ------------------------------------------------------------------- |
| `mine`            | boolean — only the caller's own, even for an admin                  |
| `owner_user_id`   | id, admin only                                                      |
| `status`          | `active` \| `disabled`                                              |
| `q`               | case-insensitive substring of name or description, ≤ 200 characters |
| `limit`, `offset` | pagination                                                          |

### `GET /api/applications/:id`

_session_, owner or admin → `{ "application": Application }`.

### `POST /api/applications`

_session_ → `201 { "application": Application }`. Body: `name` (1–120, unique
per owner case-insensitively), `description` (optional, ≤ 500).

No gateway consumer is created yet; the first approval or credential provisions
it. Errors: `409 CONFLICT` (name taken), `429 QUOTA_EXCEEDED` when the account
already owns `NEXUS_MAX_APPLICATIONS_PER_OWNER` (default 20, `0` disables;
`details: { limit, current, setting }`).

### `PATCH /api/applications/:id`

_session_, owner or admin → `{ "application": Application }`. Body: any of
`name`, `description`, `status` (`active` \| `disabled`).

**`status: "disabled"` revokes nothing.** It refuses new access requests,
approvals, credentials and rotations; everything already issued keeps working,
and revoking stays allowed. The audit row records
`details.revoked_existing_access: false`. To stop an integration, delete the
application or revoke its grants.

Re-enabling fails with `502 EDGE_ERROR` (`details.identities`) when the
application holds active grants but has no consumer mapping.

### `DELETE /api/applications/:id`

_session_, owner or admin — **destructive**.

```json
{ "revoked_grants": 2, "revoked_credentials": 1 }
```

The Edge consumer is deleted **first** (so no live identity is left that the
portal cannot find), then the row, whose cascade removes its grants, access
requests, credential rows and consumer mapping. Its credentials stop working
immediately. The reversible option is `PATCH` with `status: "disabled"`.

The local delete and its `application.delete` audit row are one transaction; an
`application.delete_start` row is written before the consumer is touched. A
retry after the consumer is gone finishes the rows without recreating anything,
and records `resumed: true`.

---

## See also

- [`getting-started.md`](getting-started.md) — end-to-end walkthrough from an
  empty database to a call through the gateway.
- [`guides/client-guide.md`](guides/client-guide.md) ·
  [`guides/provider-guide.md`](guides/provider-guide.md) ·
  [`guides/admin-guide.md`](guides/admin-guide.md)
- [`security.md`](security.md) — RBAC matrix and the audit event catalog.
