# Security

The threat model Ferrum Nexus is built against, the controls that implement it,
and the complete audit event catalog.

To report a vulnerability, see [`SECURITY.md`](../SECURITY.md) at the repo root.
Related: [`architecture.md`](architecture.md) · [`operations.md`](operations.md).

---

## 1. Threat model

### Assets

| Asset                                                        | Where it lives                                                                 | Why it matters                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Ferrum Edge admin authority                                  | `FERRUM_ADMIN_JWT_SECRET` in the Nexus process                                 | Full control of the gateway: any proxy, any consumer, any credential.                  |
| Gateway credentials (API keys, basic passwords, JWT secrets) | Generated in Nexus, stored **only** on Edge; Nexus keeps a fingerprint + last4 | Impersonation of a portal user against every API they are approved for.                |
| Portal sessions                                              | `sessions` table (HMAC of the token) + browser cookie                          | Impersonation of a portal user, including admins.                                      |
| Password hashes                                              | `users.password_hash` (scrypt)                                                 | Credential stuffing against other services if cracked.                                 |
| Encrypted settings                                           | `app_settings` (`smtp.password`, `captcha.secret_key`)                         | Relay abuse; disabling bot protection.                                                 |
| Master secret                                                | `NEXUS_SECRET_KEY`                                                             | Derives the settings-encryption key and the session-HMAC key.                          |
| Audit log                                                    | `audit_logs`                                                                   | The record of who did what. Its integrity is the basis of every after-the-fact answer. |
| Access decisions                                             | `access_requests`, `grants`                                                    | Who may call which API.                                                                |
| Unpublished API documentation                                | `api_specs`                                                                    | Business-sensitive interface detail.                                                   |

### Adversaries

| Adversary                  | Assumed capability                         | Primary controls                                                                                                                |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous internet         | Reach the portal; register if open         | Rate limiting, CAPTCHA, registration policy, no unauthenticated read beyond branding/health                                     |
| Registered `client`        | A valid session                            | RBAC, per-row ownership checks, catalog visibility, credentials scoped to their own consumer                                    |
| Registered `provider`      | A valid session; owns some APIs            | Ownership checks on every API mutation; cannot see or decide another provider's requests                                        |
| Malicious/careless `admin` | Broad portal authority                     | Audit log; only a `super_admin` may confer or remove admin power; last-super-admin guard                                        |
| Cross-site attacker        | Can make a victim's browser issue requests | Session-bound CSRF double-submit; `SameSite=Lax`; `frame-ancestors: none`                                                       |
| Network attacker           | Sees or modifies traffic                   | TLS terminated at the proxy; `Secure` cookies; HSTS; Admin API over TLS or a private network                                    |
| Compromised database       | Reads every row                            | Passwords scrypt-hashed; session tokens stored as HMAC; encrypted settings AES-256-GCM under a key held only in the environment |

### Boundaries

```
untrusted browser ──┬── session cookie + CSRF ──> Nexus BFF ── admin JWT ──> Ferrum Edge
                    │                                 │
                    └── never reaches Edge directly   └── DB, SMTP
```

The browser is never trusted with anything the gateway would accept. It holds a
session cookie, and that cookie is only useful against Nexus.

**Upstream destinations.** A published API is an egress path: the gateway will
forward traffic to whatever `upstream_url` (or `servers[0].url`) the provider
supplied. A provider account is only semi-trusted — registration may be open —
so by default Nexus refuses to point a proxy at a loopback, RFC 1918, carrier-
grade NAT, link-local, multicast or IPv4-mapped address, or at a `.local`,
`.internal`, `.localhost` or `.home.arpa` name. That closes the obvious SSRF
targets (cloud metadata at `169.254.169.254`, the Admin API, databases on the
gateway's subnet) without resolving DNS. The check runs at publish, on a
`PATCH` of `upstream_url`, and when a spec revision would move a proxy that
follows its document; it returns `400 SPEC_INVALID` with
`details.reason = "private_upstream"`. A portal that legitimately fronts
internal services sets `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true` and relies on
network egress policy instead — a public name that is later re-pointed at a
private address is outside what a hostname check can see either way.

### Out of scope

- The security of Ferrum Edge itself, and of the upstream services behind it.
- **Request and response body validation.** An API may ask the gateway to reject
  paths and methods its OpenAPI document does not declare (`spec_enforcement:
routes`, see the [provider guide](guides/provider-guide.md#enforcement-level)),
  but no level validates a body against a declared schema — that is the
  backend's own responsibility. Enforcing routes narrows the reachable surface;
  it is not input validation.
- Anyone with shell access to the Nexus process or read access to its
  environment — they hold `NEXUS_SECRET_KEY` and `FERRUM_ADMIN_JWT_SECRET`, and
  that is game over by construction.
- TLS termination, WAF and DDoS handling, which belong to the proxy in front.

---

## 2. Session security

- **Opaque tokens.** 32 bytes from `crypto.randomBytes`, base64url. Not a JWT;
  nothing about the user is encoded in it, so there is nothing to forge, tamper
  with or replay across deployments.
- **HMAC at rest.** `sessions.token_hash` stores an HMAC-SHA-256 of the token
  under a key HKDF-derived from `NEXUS_SECRET_KEY` with info
  `nexus-session-hmac-v1`. A database dump does not yield usable session
  tokens, and — because the key is _separate_ from the settings-encryption key
  (info `nexus-settings-v1`) — a leak of one subkey cannot forge the other.
- **Cookie flags.** `nexus_session` is `HttpOnly`, `SameSite=Lax`, `Path=/`,
  `Max-Age=NEXUS_SESSION_TTL`, and `Secure` unless `NEXUS_COOKIE_SECURE=false`
  (the default outside `NEXUS_ENV=development`). Clear it only for a plaintext
  `http://` deployment. The pair is written in exactly one place —
  `server/src/middleware/session-cookies.ts` — shared by the auth routes, the
  password-change re-issue and the sliding-expiry hook, so the flags cannot
  drift between them.
- **Sliding expiry.** Default idle lifetime 12 hours (`NEXUS_SESSION_TTL`).
  Any request extends it, but the row is only written when less than half the
  TTL remains, so an active SPA does not issue one `UPDATE` per request. A
  request that does trigger the write also gets both cookies re-issued with a
  fresh full-TTL `Max-Age` and their **existing** values — nothing is rotated,
  only the lifetime moves, so the browser's expiry tracks `sessions.expires_at`
  instead of the wall-clock stamped at sign-in.
- **Revocation is immediate.** The `onRequest` hook re-reads the user on every
  request. A session whose account is expired, deleted or no longer `active` is
  destroyed on the spot — along with **every** session for that user — so the
  next request from an open tab is a `401`, not a working page. Disabling an
  account (ordinary or god mode) deletes its sessions explicitly and reports
  how many — **and strips its gateway identity**, because an issued API key
  authenticates without any portal session at all. See
  [Disabling an account](#disabling-an-account).
- **Changing your password ends every other session.** `PATCH /api/users/me`
  with a `new_password` deletes every session of the account and issues one
  replacement for the request that made the change, so the tab you typed it in
  stays signed in and nothing else does.
- **Sign-in does not leak which addresses exist.** A missing account still
  costs one real scrypt derivation against a decoy hash, and "no such account"
  and "wrong password" return the identical `401 UNAUTHORIZED`.
- **Resetting a password ends every session.** Unlike a self-service change,
  a reset assumes the account may already be in someone else's hands, so it
  keeps nothing: `POST /api/auth/reset-password` deletes every session of the
  account and clears the calling browser's cookies. The user signs in again.

### Password recovery

`POST /api/auth/forgot-password` mails a single-use link and
`POST /api/auth/reset-password` redeems it. Both are anonymous by necessity,
which makes them the portal's most attractive account-enumeration oracle, so
they are built to answer nothing:

- **One response for every input.** `200 { "ok": true }`, whether the address
  has an account, has none, belongs to a disabled account, or was asked for
  again inside the 10-minute throttle. The same holds for
  `POST /api/auth/resend-verification`.
- **One latency for every input.** Those branches do wildly different amounts
  of work — one indexed `SELECT` versus a token insert, an audit row and a
  rendered message — so the service starts a scrypt derivation before the
  branch and awaits it after. The floor costs more than the widest branch, and
  starting it first rather than adding it afterwards keeps the endpoint at one
  hash rather than two.
- **One rejection for every bad link.** Unknown, expired and already-spent all
  return `400 VALIDATION_FAILED` with the same message, so a caller working
  through guessed tokens learns nothing from how close it got.
- **Tokens cannot cross flows.** `email_verification_tokens.purpose`
  (migration `002`) marks each token `email_verification` or `password_reset`,
  and every lookup names the purpose it expects. A 24-hour verification link is
  therefore not spendable as a password reset, which would otherwise turn
  one-time read access to a mailbox into account takeover a day later.
- **A reset link is single-use and short-lived.** One hour
  (`PASSWORD_RESET_TTL_SECONDS`), burned by a compare-and-set inside the same
  transaction that writes the new password, so a burn cannot outlive the change
  it was spent on. Redeeming one also deletes any other outstanding reset link
  for that account.
- **The audit log is where the truth is.** `auth.password_reset_request` and
  `auth.verification_resend` are written only when a link was really issued, so
  operators can see what the response would not say.
- **Rate limiting still applies.** Both routes sit under the `/api/auth/*`
  limiter (20 requests per minute per IP), which is what bounds the cost of the
  scrypt floor.

### Password storage

scrypt, `N=16384, r=8, p=1`, 32-byte output, 16-byte random salt per hash, in a
self-describing format (`scrypt:N:r:p:<salt b64>:<hash b64>`) so parameters can
be raised later without invalidating existing hashes. Verification is
constant-time and returns `false` — never throws — for malformed input.
Minimum length at registration is 12 characters; a self-service password change
requires the current password.

---

## 3. CSRF

Double-submit **bound to the session**, which is meaningfully stronger than
plain double-submit (where an attacker who can set a cookie on the victim's
domain can also choose the header value):

```
X-Nexus-CSRF header  ==  nexus_csrf cookie  ==  sessions.csrf_token
```

All three must match, compared with `timingSafeEqual`. The token is minted
alongside the session and lives on the session row, so a cookie an attacker
plants does not match a value Nexus issued.

The `nexus_csrf` cookie is deliberately **not** `HttpOnly` — the SPA has to
read it to echo it back.

Enforcement covers every non-`GET`/`HEAD`/`OPTIONS` request under `/api` that
carries a session. Exempt paths are only the pre-session ones:
`/api/auth/login`, `/api/auth/register`, `/api/auth/verify-email`,
`/api/auth/captcha`. **`POST /api/auth/logout` is not exempt** — forcing a
sign-out is a state change like any other. An anonymous mutation is rejected by
the route's own guard with `401`, not by the CSRF hook, because there is no
session-bound token to compare against yet.

Defence in depth: `SameSite=Lax` on both cookies, `frame-ancestors: 'none'` and
`X-Frame-Options: DENY` (no clickjacking), `formAction: 'self'`.

---

## 4. RBAC

Roles are strictly ordered — `client` < `provider` < `admin` < `super_admin` —
and a higher role inherits every capability beneath it. Only `client` and
`provider` are self-selectable at registration; `admin` and `super_admin`
require promotion by an existing `super_admin`.

Route-level guards check the **role**; services check **row-level ownership**.
That split is deliberate: "may this role reach this endpoint" is a property of
the route, while "is this your API" is a property of the row.

### Capability matrix

| Capability                                        | client | provider | admin | super_admin |
| ------------------------------------------------- | :----: | :------: | :---: | :---------: |
| Register, sign in, manage own profile             |   ✓    |    ✓     |   ✓   |      ✓      |
| Browse catalog, read specs                        |   ✓    |    ✓     |   ✓   |      ✓      |
| Request access, cancel own request                |   ✓    |    ✓     |   ✓   |      ✓      |
| Issue / rotate / revoke **own** credentials       |   ✓    |    ✓     |   ✓   |      ✓      |
| Messaging, notifications                          |   ✓    |    ✓     |   ✓   |      ✓      |
| Publish an API, update own API/spec               |   —    |    ✓     |   ✓   |      ✓      |
| Configure palette plugins on **own** API          |   —    |    ✓     |   ✓   |      ✓      |
| Create a test consumer for own API                |   —    |    ✓     |   ✓   |      ✓      |
| Approve / deny requests on **own** APIs           |   —    |    ✓     |   ✓   |      ✓      |
| Revoke grants on **own** APIs                     |   —    |    ✓     |   ✓   |      ✓      |
| Edit / delete **another** provider's API          |   —    |    —     |   ✓   |      ✓      |
| Decide requests / revoke grants on **any** API    |   —    |    —     |   ✓   |      ✓      |
| List all users; change `client` ⇄ `provider`      |   —    |    —     |   ✓   |      ✓      |
| Manage organizations                              |   —    |    —     |   ✓   |      ✓      |
| List another account's credential metadata        |   —    |    —     |   ✓   |      ✓      |
| Read/reply in the platform inbox; read any thread |   —    |    —     |   ✓   |      ✓      |
| Portal settings: branding, registration policy    |   —    |    —     |   ✓   |      ✓      |
| Email templates, mass email                       |   —    |    —     |   ✓   |      ✓      |
| Read the audit log                                |   —    |    —     |   ✓   |      ✓      |
| Portal settings: **SMTP and CAPTCHA**             |   —    |    —     | **—** |      ✓      |
| Grant or revoke `admin` / `super_admin`           |   —    |    —     | **—** |      ✓      |
| Disable an `admin` or `super_admin`               |   —    |    —     | **—** |      ✓      |
| God mode (4 endpoints)                            |   —    |    —     |   —   |      ✓      |

The three bolded gaps are the point of the `super_admin` tier: an `admin` has
broad authority over content and users but **cannot escalate itself or another
account**, cannot switch off an administrator, and cannot take over the
platform's mail.

`smtp` and `captcha` are `super_admin`-only because they are escalation paths
dressed as preferences. Whoever controls the SMTP host receives every
verification and password-reset link the portal sends, which is an account
takeover of every user; whoever controls the CAPTCHA settings can switch off
the registration brake. `PUT /api/admin/settings` answers `403 FORBIDDEN` for
an `admin` sending either section, and the check lives in the service, so it
holds however `updateSettings` is reached. Branding and registration policy
stay at `admin`.

### Scoping rules worth knowing

- **Access requests and grants** are scoped by ownership, not by role alone: a
  `provider` sees the inbox for the APIs they own, and filtering by an
  `api_id` they do not own is `403 FORBIDDEN`.
- **Publishing list** always scopes a `provider` to their own APIs, whatever
  they pass in the query. `mine` is the _admin's_ opt-in.
- **Credentials** are always the caller's own unless an `admin` passes an
  explicit `user_id` — and even then, only the metadata, never a secret.
- **Catalog** answers `404`, not `403`, for an API you may not see, so it never
  confirms that an internal API exists.

### The provider / operator split on gateway plugins

Ferrum Edge ships around seventy-five plugins. A provider gets **ten of them**,
plus the six Nexus already manages from fields on the API row. The line is not
arbitrary, and it is a security boundary rather than a UX preference:

- **Provider-facing** = changes how _consumers of this API_ authenticate, are
  authorized, are shaped, are protected, or experience the contract. Blast
  radius is one proxy the provider already owns, and the worst outcome of a
  mistake is their own API answering `503`. These are the palette
  (`docs/api.md` § Plugin palette).
- **Operator-only** = how the _platform_ observes, meshes, load-tests or ships
  logs. Log sinks name an external destination and can carry request data off
  the box; tracing and metrics are cluster-wide; fault injection, load testing
  and request mirroring generate or redirect traffic; mesh and SPIFFE plugins
  are data-plane identity. None of these belong to one API, and several would
  let a provider exfiltrate or disrupt beyond their own proxy. They are reached
  through Foundry or `FERRUM_*` environment, never through Nexus.

Two more are held back for reasons of their own rather than blast radius: the
auth family (`hmac_auth`, `jwks_auth`, `oauth2_introspection`, `mtls_auth`)
because it changes the credential model, and `spec_expose` because it needs a
public spec endpoint.

Every palette write is owner-or-admin (`assertCanAdminister`, the same check
publishing uses), CSRF-protected like every other mutation, validated against a
closed key set before any gateway call, and audited. A provider naming a plugin
outside the palette gets `404 NOT_FOUND`; naming one Nexus manages from a
first-class field gets `400` pointing at that field. Neither answer lets a
provider reach a plugin they are not entitled to.

### First user and the last-super-admin guard

**The first account ever registered becomes `super_admin`** regardless of the
role it requested, is auto-verified, and bypasses the registration policy — the
platform has to be bootstrappable. Every later registration gets only the
registrable role it asked for, subject to `open_registration` and
`allowed_roles`.

"First" is decided by an **atomic claim**, not by counting rows. Registration
creates the account with the role that was requested and then inserts the
`bootstrap.super_admin_claimed` key with `settings.insertIfAbsent`; only the
insert that wins the unique constraint is promoted. Counting users and then
awaiting a ~100 ms scrypt hash before the insert is a race every concurrent
registration against an empty database wins — and a transaction does not close
it, because under PostgreSQL's READ COMMITTED and under MongoDB two concurrent
transactions can both observe zero users. Registrations that saw an
already-populated portal never stand for the election, so an upgraded
deployment cannot mint a second founder.

The mirror-image protection: **the last active `super_admin` cannot be demoted,
disabled or removed** → `409 LAST_SUPER_ADMIN`. The check counts active super
admins _excluding the target_, so it is genuinely asking "is anyone else left?".
It is implemented twice on purpose — in `users/service.ts` for
`PATCH /api/users/:id`, and again in `admin/god-service.ts`, because god mode
does not route through the ordinary path. Disabling your own account is refused
separately with `409 CONFLICT`, but the last-super-admin count is checked
**first** on both paths: when the two rules collide, `LAST_SUPER_ADMIN` is the
answer that says how to fix it — promote a second super admin.

### Disabling an account

Both paths — `PATCH /api/users/:id` with `status: "disabled"` and
`POST /api/admin/god/disable-user` — do three things, not one:

1. delete every session, so an open tab gets a `401`;
2. strip every ACL group from the account's Ferrum consumer;
3. delete **every credential of every type** on that consumer and mark the
   matching `credential_metadata` rows `revoked`.

(2) alone is not enough. An API published with `requestable: false` carries no
`access_control` plugin, so an empty group list stops nothing; the credential
is what the gateway authenticates, and it has no idea a portal session ever
existed. `basicauth` is deleted explicitly because it never appears in a read
projection, so a group rewrite cannot see it.

The teardown is best-effort by design: if Edge is unreachable the account is
still disabled and the failure is logged and recorded in the audit row
(`gateway_teardown: "failed"`) for an operator to finish by hand. An account
left enabled because the gateway was down would be strictly worse.

---

## 5. Show-once credentials

The guarantee: **plaintext credential material is returned in exactly one HTTP
response and is never stored.** Nexus keeps a SHA-256 fingerprint and the last
four characters in `credential_metadata`, which is enough to identify a
credential in the UI and nothing more.

Only two endpoints ever carry a secret: `POST /api/credentials` and
`POST /api/credentials/:id/rotate` (plus
`POST /api/apis/:id/test-consumer` for a provider's disposable consumer). All
`/api` responses are `cache-control: no-store`, which is what keeps a show-once
payload out of a shared cache.

**Ferrum Edge enforces the same thing independently.** Every ordinary Admin API
read redacts `keyauth.key` and `jwt.secret` to the literal `[REDACTED]` and
omits `basicauth` entirely. Even a Nexus bug that tried to read a secret back
would get a redaction. There is no read path to the plaintext on either side —
if a user loses it, the answer is rotation, not recovery.

Rotation is append-then-delete, so both secrets are live across the hand-off.
The one exception is an account already at `FERRUM_MAX_CREDENTIALS_PER_TYPE`
live credentials of that type: there is no room to append, so the old entry is
deleted first and there is a brief gap. Keeping the cap at 2 or more avoids it.

Because Edge gives credential entries no id, Nexus locates one by _position_
(its row order mirrors the Edge array). If the two views disagree — someone
hand-edited the consumer — the operation is **refused** with `EDGE_ERROR`
rather than guessing, unless exactly one credential is live, in which case
removing the whole type is unambiguous.

That last fallback applies to **`revoke` only**. In a rotation, "delete the
whole type" would take the entry appended moments earlier with it, leaving the
user holding a show-once secret that authenticates nothing and a row that says
`active`; a drifted `rotate` is therefore refused outright and the consumer has
to be reconciled first.

---

## 6. Settings encryption

Two `app_settings` values are secret and are stored encrypted:
`smtp.password` and `captcha.secret_key`.

| Property    | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Cipher      | AES-256-GCM                                                                      |
| Blob format | `v1:<iv b64>:<ciphertext b64>:<tag b64>`, 12-byte IV, 16-byte tag                |
| Key         | HKDF-SHA-256 from `NEXUS_SECRET_KEY`, info `nexus-settings-v1`, 32 bytes         |
| Integrity   | The GCM tag — a tampered blob fails to decrypt rather than decrypting to garbage |

Both are **write-only over HTTP**: they go in through `PUT /api/admin/settings`
and are never returned. The DTOs expose only `password_set` / `secret_set`
booleans. The `admin.settings_update` audit row records the **names** of the
changed keys and never their values, so the audit log stays readable by anyone
allowed to read audit logs.

Rotating `NEXUS_SECRET_KEY` makes both blobs undecryptable. There is no
automated re-encryption flow; the manual procedure — and the failure modes to
expect, including CAPTCHA failing closed — is in
[`operations.md`](operations.md#7-rotating-nexus_secret_key).

---

## 7. Rate limiting and CAPTCHA

### Rate limiting

`@fastify/rate-limit` is registered on the `/api/auth/*` child instance only:
**20 requests per minute per IP**, covering register, login, logout, me,
verify-email and captcha config. Exceeding it is `429 RATE_LIMITED`. It is
scoped to that prefix so the credential-guessing surface is protected without
throttling normal portal use.

Controlled by `NEXUS_RATE_LIMIT_ENABLED` (default `true`); forced off under
`NEXUS_ENV=test`. The store is in-memory and therefore **per process** — with
N instances the effective limit is N × 20/min, so enforce the real limit at the
proxy if you run more than one. The limiter keys on `request.ip`, which honours
`X-Forwarded-For` only for the proxies named by `NEXUS_TRUSTED_PROXIES`
(unset — trust nothing — by default). Trusting an unfiltered header would let a
client rotate the limiter's key once per request _and_ forge the IP recorded in
the audit log, so the allowlist/hop-count form is the only one accepted.

### Consumer quotas are per gateway process

A per-API rate limit is enforced by Edge's `rate_limiting` plugin, and its
counters live **in the memory of one gateway process** unless the plugin config
names a Redis endpoint. A portal in front of N data-plane replicas therefore
enforces **N × the quota** the provider chose: a "1000 per minute" API answers
up to 1000 requests per minute _per replica_.

Set `FERRUM_RATE_LIMIT_SYNC_MODE=redis` and `FERRUM_RATE_LIMIT_REDIS_URL` and
Nexus stamps `sync_mode`/`redis_url`/`redis_tls` onto every `rate_limiting`
config it writes, so the replicas share one counter. The setting applies to
rate limits **saved after the change** — an already-published API picks it up
the next time its rate limit is saved. There is no gateway-level environment
variable for this; the endpoint is part of each plugin config, which is why it
is configured on the portal.

### Cross-Site WebSocket Hijacking

Ferrum Edge treats WebSocket as transparent on an `http(s)` proxy, so
**publishing an HTTP API also publishes WebSocket on the same listen path**.
The `cors` plugin does not run on an upgrade — a browser's same-origin policy
does not apply to `WebSocket` either — so the only origin check on that path is
the proxy's own `allowed_ws_origins`, whose default (`[]`) is _no check at all_.
A page on any origin could otherwise open a socket to a published API and ride
a logged-in browser's ambient credentials.

Nexus mirrors the API's CORS origins into `allowed_ws_origins` at publish time
and whenever the CORS policy changes: a provider who named the browser origins
allowed to call the API has already answered the question. Only plain
`scheme://host[:port]` origins are mirrored, because the upgrade check is an
exact, case-insensitive string comparison and a wildcard pattern would silently
never match. An API with **no CORS policy, or a `*` one, gets `[]`** — a
half-populated allow-list would be worse than none, and an API deliberately open
to every browser origin gains nothing from one.

The consequence is worth stating plainly: **an API with no CORS policy accepts
WebSocket upgrades from any origin.** Authentication still applies — the auth
plugin and the ACL group run on the upgrade request — so this is a CSRF-shaped
risk against browser-borne credentials, not an open door. Providers fronting a
WebSocket backend from a browser should list their origins.

### CAPTCHA

Optional, configured from the admin UI rather than the environment. Supported
providers: Cloudflare Turnstile, hCaptcha, reCAPTCHA. When enabled, a
`captcha_token` is required on register and login.

- The site key is public (`GET /api/auth/captcha`, `GET /api/branding`); the
  secret is encrypted at rest and never returned.
- Verification is a server-side POST to the vendor with a 5-second budget, and
  the client IP is forwarded as `remoteip`.
- **It fails closed.** Enabled-but-no-secret, an unreachable vendor, or a
  rejected token all produce `400 CAPTCHA_FAILED`; nothing slips through
  unverified.
- Vendor error codes are logged, never returned to the browser.

---

## 8. CSP and response headers

helmet is configured in the composition root:

| Header                      | Value                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | `default-src 'self'`; `base-uri 'self'`; `object-src 'none'`; `frame-ancestors 'none'`; `form-action 'self'`; `img-src 'self' data:`; `font-src 'self' data:`; `style-src 'self' 'unsafe-inline'` |
| `script-src`                | `'self'` plus the fixed CAPTCHA vendor hosts: `challenges.cloudflare.com`, `hcaptcha.com`, `*.hcaptcha.com`, `www.google.com`, `www.gstatic.com`                                                  |
| `frame-src`                 | `'self'` plus `challenges.cloudflare.com`, `hcaptcha.com`, `*.hcaptcha.com`, `www.google.com`                                                                                                     |
| `connect-src`               | `'self'`, `hcaptcha.com`, `*.hcaptcha.com`                                                                                                                                                        |
| `X-Frame-Options`           | `DENY`                                                                                                                                                                                            |
| `Referrer-Policy`           | `no-referrer`                                                                                                                                                                                     |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` — **only when `NEXUS_COOKIE_SECURE` is on (the default outside development)**                                                                               |
| `Cache-Control`             | `no-store` on every `/api` response                                                                                                                                                               |

Notes on the deliberate loosenings:

- The CAPTCHA vendor hosts are allow-listed unconditionally but are inert
  unless an admin enables that provider. Narrow the list if you have settled on
  one vendor.
- `style-src 'unsafe-inline'` is required by the SPA's runtime theming (CSS
  custom properties written from branding settings). `script-src` has no
  `unsafe-inline` and no `unsafe-eval`.
- `img-src ... data:` is required because the portal logo is stored and served
  as a `data:` URL.
- `crossOriginEmbedderPolicy` is off so the CAPTCHA iframes work.

**`GET /api/health` says nothing an anonymous caller can use.** The database
probe reports `error: "unreachable"` and never the driver's own message, which
would otherwise hand out internal hostnames, ports and database account names
(`connect ECONNREFUSED 10.0.3.14:5432`, `password authentication failed for
user "nexus_app"`). The real text goes to the log at `error` level.

**Admin-authored HTML is a trusted-but-real input.** Email template bodies and
the mass-email composer accept HTML, and only variables explicitly listed in
`rawHtmlVars` skip escaping. Everything interpolated into an HTML body is
HTML-escaped by default, so a display name of `<script>` never becomes markup.
That HTML is rendered in recipients' mail clients, not in the portal, and the
capability is `admin`-gated.

---

## 9. Ferrum Edge admin JWT hygiene

The admin JWT is the most powerful secret in the system: it is full gateway
authority. `ferrum-admin/jwt.ts` mints it and nothing else does.

- **HS256**, secret `FERRUM_ADMIN_JWT_SECRET`, minimum 32 characters (enforced
  by config validation _and_ again at signing time).
- **Short TTL.** `FERRUM_ADMIN_JWT_TTL` defaults to **60 seconds**, capped at
  3600 by Edge. Tokens are minted per call and cached in a 256-entry LRU keyed
  by every signing input — the secret is hashed into the cache key, never
  stored in it — and re-minted once less than `min(60, ttl/4)` seconds remain.
- **`role: 'admin'`.** Edge also defines `viewer` and `operator`; Nexus needs
  `admin` for consumer and plugin writes.
- **`sub` names a human where possible.** The default subject is
  `ferrum-nexus`, but write calls pass the acting Nexus user id, so the
  gateway's own audit trail is not a wall of anonymous service calls.
- **`aud` is omitted by default.** Edge rejects a token carrying an `aud` claim
  when it has no audience configured, so Nexus stamps one only when
  `FERRUM_ADMIN_JWT_AUDIENCE` is explicitly set.
- **`ns` is always stamped** with `FERRUM_NAMESPACE`, in the single-string form.
  A gateway started with `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true` treats the
  claim as the authorization boundary for every namespace-scoped route and
  answers `403` to a token that has no `ns`; a gateway without the flag ignores
  it. Stamping it unconditionally costs nothing on a permissive control plane
  and is what lets Nexus work against a locked-down one. Edge also rejects a
  _malformed_ claim (empty or non-string entries) at authentication time
  regardless of the flag, so an empty namespace is refused at signing time
  rather than minted.
- **`jti` is a fresh UUID** on every mint; `nbf` equals `iat`.

Handling the secret:

- Provide it through a secret manager or orchestrator secret, never a
  committed file. The repo's `.env.example` ships it blank on purpose.
- It must be **identical** on Nexus and on the gateway; a mismatch is a blanket
  `502 EDGE_ERROR — "The gateway rejected the Nexus admin credentials"`.
- Prefer `https://` for `FERRUM_ADMIN_URL`. Plaintext `http://` to a
  non-loopback host is refused at startup unless
  `FERRUM_ADMIN_ALLOW_INSECURE_HTTP=true`, which is only defensible when the
  Admin API is on a private network the browser cannot reach.
- Keep the Admin API off the public internet. It should be reachable from the
  Nexus process and nowhere else.
- Rotation is a coordinated restart of both processes — see
  [`operations.md`](operations.md#rotating-ferrum_admin_jwt_secret).

Upstream error text from Edge is always logged. Whether it is _also_ echoed to
the browser depends on whose problem the message describes:

- **`400`, `409` and `422` are echoed.** These are Edge validating the body
  Nexus built out of the caller's own request —
  `FERRUM_BASIC_AUTH_HMAC_SECRET must be set…`, `listen_path already exists in
this namespace`. A provider cannot fix a publish they cannot read the reason
  for, so the text rides along in `details.gateway_message` (trimmed to 500
  characters) and is repeated in the message.
- **`401`, `403` and every `5xx` stay opaque.** Those describe the gateway's own
  configuration or the Nexus↔Edge trust relationship and can name internal
  hosts and settings; callers see only `EDGE_ERROR` / `EDGE_UNAVAILABLE` with a
  generic message and the real text goes to the log alone.

The split is enforced in one place — `classify()` in `ferrum-admin/client.ts`.
Nothing else in the codebase reads an Edge error body.

---

## 10. Audit event catalog

**Every state-changing endpoint writes exactly one `audit_logs` row** via the
audit service, which is the only writer of that table. Rows are append-only:
there is no update or delete path in the store interface.

Each row carries `actor_user_id`, `actor_role` (both `null` for anonymous
events), `action`, `target_type`, `target_id`, a JSON `details` object, the
client `ip`, and `created_at`. Read them at `GET /api/admin/audit-logs`
(_admin_), filterable by actor, action, target and time range.

**Secrets never appear in `details`.** A settings update records the _names_ of
the changed keys; a credential event records the type and last4, never the
material.

Naming is `<domain>.<verb>`, lowercase, snake_case verbs. God-mode actions are
namespaced `god.*` so they can be filtered out of — or singled out for —
ordinary reporting.

> **Adding an event?** Append it to `AuditAction` in
> [`server/src/audit/service.ts`](../server/src/audit/service.ts) **and** to
> this table. `CONTRIBUTING.md` makes that a review requirement; a new action
> that is not documented here is an incomplete change.

### Authentication

| Action                        | Target type | Description                                                                                                                                                                                 |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.register`               | `user`      | An account was created. `details`: email, role, `first_user`, `verification_required`. The actor is the new account itself.                                                                 |
| `auth.login`                  | `user`      | A successful sign-in. Failed sign-ins are **not** audited (they are rate-limited instead).                                                                                                  |
| `auth.logout`                 | `session`   | A session was destroyed by its owner.                                                                                                                                                       |
| `auth.verify_email`           | `user`      | An email-verification token was redeemed.                                                                                                                                                   |
| `auth.verification_resend`    | `user`      | A fresh verification link was issued and queued. Written **only** when a link was really sent, so it is what distinguishes the four outcomes the endpoint's response deliberately does not. |
| `auth.password_reset_request` | `user`      | A password-reset link was issued and queued. Absent for an unknown address, a disabled account, or a request inside the 10-minute throttle.                                                 |
| `auth.password_reset`         | `user`      | A reset link was redeemed: new password set, address marked verified, every session of the account terminated.                                                                              |

### Users and organizations

| Action             | Target type    | Description                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user.update`      | `user`         | A profile or account field changed without a role/status change. `details.self` distinguishes self-service from an admin edit; `changed_fields` lists what moved (`password` appears as a field name, never a value). A self-service password change also ends every other session, counted in `terminated_sessions`. |
| `user.role_change` | `user`         | An admin changed an account's role. `details`: `from_role`, `to_role`.                                                                                                                                                                                                                                                |
| `user.disable`     | `user`         | An admin disabled (or re-enabled) an account via the ordinary route. `details`: `from_status`, `to_status`, `terminated_sessions`, plus the gateway teardown: `gateway_teardown` (`ok` / `no_consumer` / `failed`), `gateway_consumer_id`, `revoked_credentials`, `removed_acl_groups`, `gateway_error`.              |
| `org.create`       | `organization` | An organization was created. `details`: name.                                                                                                                                                                                                                                                                         |
| `org.update`       | `organization` | An organization was edited. `details`: `changed_fields`.                                                                                                                                                                                                                                                              |

### Publishing

| Action                 | Target type | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.publish`          | `api`       | An API was published: its Edge proxy and plugin configs created, then associated on the proxy so the gateway runs them. `details`: slug, listen path, proxy id, auth plugin, requestable, visibility, rate limit, CORS policy, method allow-list, backend timeouts, circuit breaker, OpenAPI enforcement level, upstream, spec path count. The proxy's `allowed_ws_origins` is not logged separately — it is a pure function of the CORS policy already recorded here. |
| `api.update`           | `api`       | Safe runtime settings changed. `details`: `changed_fields`, plus context such as `previous_auth_plugin` and `existing_credentials_invalidated`.                                                                                                                                                                                                                                                                                                                        |
| `api.spec_update`      | `api`       | A new spec revision was published and made current. `details`: spec id, version, path count, OpenAPI enforcement level, `backend_updated`. At the `routes` level the revision also changes what the gateway accepts, so the level is recorded on every upload.                                                                                                                                                                                                         |
| `api.retire`           | `api`       | An API moved to `retired`. Emitted instead of `api.update` for that transition. `details.gateway_untouched` records that the proxy and live grants were left alone.                                                                                                                                                                                                                                                                                                    |
| `api.delete`           | `api`       | An API and its Edge objects were destroyed. `details`: slug, proxy id, `revoked_grants`.                                                                                                                                                                                                                                                                                                                                                                               |
| `api.plugin_set`       | `api`       | A palette plugin was created or replaced on the API's proxy. `details`: `plugin_name`, `enabled`, `config_keys`, `trigger`, `replaced`. **The config keys are logged, never their values** — a plugin config can carry a Content-Security-Policy or a partner IP allow-list, and an audit row is not the place for either. The trigger is a method list and a path prefix, which are policy rather than data, so it is recorded in full.                               |
| `api.plugin_remove`    | `api`       | A palette plugin was detached from the proxy and deleted. `details`: `plugin_name`, `label`, `was_attached` (false when an operator had already removed the gateway config by hand).                                                                                                                                                                                                                                                                                   |
| `test_consumer.create` | `api`       | A provider created (or replaced) the disposable `nexus-test-<api_id>` consumer. `details`: consumer username/id, credential type, `replaced`.                                                                                                                                                                                                                                                                                                                          |

### Access workflow

| Action                    | Target type      | Description                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access.request`          | `access_request` | A client requested access. `details`: api id and slug.                                                                                                                                                                                                                                                                        |
| `access.cancel`           | `access_request` | The requester withdrew their own pending request.                                                                                                                                                                                                                                                                             |
| `access.approve`          | `access_request` | Approved: the ACL group is now on the consumer. `details`: api id/slug, user id, grant id, `acl_group`.                                                                                                                                                                                                                       |
| `access.approve_rollback` | `access_request` | An approval failed after the gateway write; records what was undone. `details`: api id/slug, user id, `cause`, plus `acl_group_removed` + `request_released`, or `acl_group_kept` + `kept_for_grant_id` when a live grant still needs the group. `acl_group_orphaned` means the group is still on the consumer — investigate. |
| `access.deny`             | `access_request` | Declined. `details`: api id/slug, user id, `has_note`. Nothing changed on the gateway.                                                                                                                                                                                                                                        |
| `access.revoke`           | `grant`          | A grant was withdrawn and the ACL group removed. `details`: api id/slug, user id, `acl_group`, `reason`. A bulk revocation adds `bulk: true` and writes one row per grant. Exactly one row per grant per revocation — the transition is a compare-and-set, so a concurrent second revocation loses and records nothing.       |
| `access.revoke_rollback`  | `grant`          | A revocation claimed the grant but the gateway would not drop the ACL group; records what was undone. `details`: api id, user id, `acl_group`, `cause`, `grant_restored`. `grant_restored: false` means the portal says revoked while the group may still be live — investigate.                                              |

### Credentials

| Action              | Target type  | Description                                                                                                                    |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `credential.issue`  | `credential` | A gateway credential was minted. `details`: credential type, consumer id, `last4`.                                             |
| `credential.rotate` | `credential` | Append-then-delete rotation. Target is the **new** credential; `details`: type, consumer id, `rotated_from`, `previous_last4`. |
| `credential.revoke` | `credential` | A credential was deleted from Edge and marked revoked. `details`: type, consumer id, `last4`.                                  |

### Messaging and notifications

| Action                  | Target type      | Description                                                                                                              |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `message.thread_create` | `message_thread` | A new conversation was opened. Not emitted when an existing thread is continued. `details`: subject, api id, `platform`. |
| `message.send`          | `message`        | A message was posted. `details`: thread id. Also emitted for the opening message of a new thread.                        |
| `notification.read`     | `notification`   | A user marked notifications read. `details`: `updated` count, `all`. `target_id` is `null` — it is a bulk operation.     |

### Administration

| Action                  | Target type      | Description                                                                                                                                    |
| ----------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin.settings_update` | `settings`       | Portal settings changed. `details.changed_keys` lists the touched keys (e.g. `smtp.password`) — **never their values**. `target_id` is `null`. |
| `admin.template_update` | `email_template` | An email template was overridden. `target_id` is the template key.                                                                             |
| `admin.mass_email`      | `mass_email`     | A mass email was dispatched. `target_id` is the batch id. `details`: subject, audience scope, `recipients`, `enqueued`.                        |
| `admin.smtp_test`       | `settings`       | A test message was sent straight through SMTP. `target_id` is `smtp`. `details`: `to_email`, `ok`.                                             |

### God mode (`super_admin` only)

Each of these is written **in addition to** the ordinary audit row the
underlying operation produces, so an emergency action leaves a two-row trail:
what was done, and the fact that it was done under god mode and why. `reason`
is required and non-empty on all four.

| Action             | Target type | Description                                                                                                                                                                                                          |
| ------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `god.revoke_grant` | `grant`     | A grant was revoked without ownership. Pairs with `access.revoke`. `details`: `reason`, api id, user id.                                                                                                             |
| `god.delete_api`   | `api`       | An API was destroyed without ownership. Pairs with `api.delete` (and one `access.revoke` per grant when `revoke_grants` was set). `details`: `reason`, slug, `owner_user_id`, `revoked_grants`.                      |
| `god.disable_user` | `user`      | An account was disabled, its sessions destroyed and its gateway identity stripped. `details`: `reason`, `revoked_grants`, `terminated_sessions`, `previous_status`, and the same `gateway_*` keys as `user.disable`. |
| `god.broadcast`    | `broadcast` | A platform message was sent to many users. `target_id` is `null`. `details`: `reason` (the subject), audience scope, `recipients`, `notified`, `threads_created`, `emails_enqueued`, `send_email`.                   |

### What is deliberately not audited

Reads. Browsing the catalog, opening a spec, listing grants and reading the
audit log itself write no rows — the log records **changes**, and auditing every
GET would bury them. Failed sign-ins are not audited either; they are
rate-limited, and recording them would let an attacker fill the table.
Notifications are a courtesy channel, never a record: nothing in
`notifications/service.ts` writes an audit row, and a notification failure never
fails the operation that triggered it.

---

## 11. Hardening checklist

Before going live:

- [ ] `NEXUS_SECRET_KEY` is 32+ random characters from a secret manager, backed
      up separately from the database.
- [ ] `FERRUM_ADMIN_JWT_SECRET` is 32+ random characters, matches the gateway,
      and is not in version control.
- [ ] `FERRUM_ADMIN_URL` is `https://`, or the Admin API is on a private
      network unreachable from the internet.
- [ ] `NEXUS_COOKIE_SECURE` is on (the default), and TLS is terminated in
      front of Nexus.
- [ ] `NEXUS_TRUSTED_PROXIES` names the proxies you control (or the hop count),
      and is left unset on a directly-exposed instance.
- [ ] `NEXUS_PUBLIC_URL` is the real public origin, and the SPA and API are on
      the same origin.
- [ ] `NEXUS_RATE_LIMIT_ENABLED=true`; a proxy-level limit exists if you run
      more than one instance.
- [ ] `FERRUM_RATE_LIMIT_SYNC_MODE=redis` (with an endpoint) if you run more
      than one Ferrum Edge data-plane replica — otherwise every provider's
      quota is multiplied by the replica count.
- [ ] Providers fronting a browser-facing WebSocket backend have listed their
      CORS origins, which is what populates the proxy's `allowed_ws_origins`.
- [ ] `NEXUS_ALLOW_PRIVATE_UPSTREAMS` is left at `false` unless the portal is
      meant to front internal services, in which case gateway egress is
      restricted at the network layer.
- [ ] CAPTCHA configured if registration is open to the internet.
- [ ] Registration policy reviewed: `open_registration`, `allowed_roles`,
      `require_email_verification`.
- [ ] SMTP configured, and a test message delivered — otherwise verification
      and decision mail queues silently.
- [ ] At least **two** active `super_admin` accounts, so the last-super-admin
      guard never locks you out of your own portal.
- [ ] Backups running and a restore rehearsed, for both the Nexus database and
      the Ferrum Edge state.
- [ ] `GET /api/health` wired to your monitor, treating `degraded` as healthy.
- [ ] Exactly one instance performing consumer mutations
      ([`operations.md`](operations.md#8-scaling)).
