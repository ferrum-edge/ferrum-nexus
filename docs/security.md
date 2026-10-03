# Security

The threat model Ferrum Nexus is built against, the controls that implement it,
and the complete audit event catalog.

To report a vulnerability, see [`SECURITY.md`](../SECURITY.md) at the repo root.
Related: [`architecture.md`](architecture.md) · [`operations.md`](operations.md).

---

## 1. Threat model

### Assets

| Asset                                                        | Where it lives                                                                               | Why it matters                                                                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ferrum Edge admin authority                                  | `FERRUM_ADMIN_JWT_SECRET` in the Nexus process                                               | Full control of the gateway: any proxy, any consumer, any credential.                                                                                     |
| Gateway credentials (API keys, basic passwords, JWT secrets) | Generated in Nexus, stored **only** on Edge; Nexus keeps a fingerprint + last4               | Impersonation of a portal user against every API they are approved for.                                                                                   |
| Portal sessions                                              | `sessions` table (HMAC of the token) + browser cookie                                        | Impersonation of a portal user, including admins.                                                                                                         |
| Identity-provider links                                      | `user_identities` (provider id + issuer + `sub`), `user_email_proofs`, `user_password_locks` | Which account a single sign-on opens: a wrong link, or a forged proof of an address, is an account takeover; a lost lock hands an SSO account a password. |
| Password hashes                                              | `users.password_hash` (scrypt)                                                               | Credential stuffing elsewhere if cracked.                                                                                                                 |
| Encrypted settings                                           | `app_settings` (`smtp.password`, `captcha.secret_key`, `sso.client_secret.<id>`)             | Relay abuse; disabling bot protection; posing as the portal to an IdP.                                                                                    |
| Single-use links in queued mail                              | `email_outbox` (sealed: AES-256-GCM)                                                         | Account takeover through a password-reset link.                                                                                                           |
| Master secret                                                | `NEXUS_SECRET_KEY`                                                                           | Derives the settings-encryption, outbox-sealing and session-HMAC keys.                                                                                    |
| Audit log                                                    | `audit_logs`                                                                                 | The record of who did what.                                                                                                                               |
| Access decisions                                             | `access_requests`, `grants`                                                                  | Who may call which API.                                                                                                                                   |
| Unpublished API documentation                                | `api_specs`                                                                                  | Business-sensitive interface detail.                                                                                                                      |

### Adversaries

| Adversary                  | Assumed capability                         | Primary controls                                                                                                                                                        |
| -------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous internet         | Reach the portal; register if open         | Rate limiting, CAPTCHA, registration policy, bootstrap token, nothing readable beyond branding/health                                                                   |
| Registered `client`        | A valid session                            | RBAC, row-level ownership checks, catalog visibility, credentials scoped to their own consumer, per-account budgets                                                     |
| Registered `provider`      | A valid session; owns some APIs            | Ownership checks on every API mutation, public-upstream check, publishing quotas                                                                                        |
| Malicious/careless `admin` | Broad portal authority                     | Audit log; only a `super_admin` may confer or remove admin power or change SMTP/CAPTCHA/gateway/single sign-on settings                                                 |
| Cross-site attacker        | Can make a victim's browser issue requests | Session-bound CSRF double-submit; `SameSite=Lax`; `frame-ancestors 'none'`                                                                                              |
| Network attacker           | Sees or modifies traffic                   | TLS at the proxy; `Secure` cookies; HSTS; Admin API over TLS or a private network                                                                                       |
| Compromised database       | Reads every row                            | Passwords scrypt-hashed; session and email-link tokens stored as HMAC; settings secrets and queued single-use links AES-256-GCM under keys held only in the environment |
| Identity provider          | Signs any claim it likes for its own users | Explicit trust per provider; subject-keyed links; linking only on a verified address on both sides; `super_admin` never from claims; allowed email domains              |

### Boundaries

```
untrusted browser ──┬── session cookie + CSRF ──> Nexus BFF ── admin JWT ──> Ferrum Edge
                    │                                 │
                    └── never reaches Edge directly   └── DB, SMTP
```

The browser never holds anything the gateway would accept. Its session cookie
is only useful against Nexus.

### Upstream destinations

A published API is an egress path: the gateway forwards traffic to whatever
upstream the provider supplied. Registration may be open, so by default Nexus
only lets a proxy point at a public destination
(`server/src/publishing/oas.ts`). Three checks run in order:

1. **Name suffixes.** `localhost` and names ending `.localhost`, `.local`,
   `.internal` or `.home.arpa` are refused.
2. **IP literals.** Refused: `0.0.0.0/8`, loopback, RFC 1918, carrier-grade
   NAT, link-local, `192.0.0.0/16`, `198.18.0.0/15`, multicast and reserved
   IPv4; IPv6 unique-local, link-local, site-local (`fec0::/10`) and multicast.
   IPv4-mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`)
   addresses are judged as the IPv4 address they carry, so `64:ff9b::a00:1` is
   refused as `10.0.0.1`. The rest of `::/16` and of `64:ff9b::/32` (including
   `64:ff9b:1::/48`) is refused outright. A literal is the destination, so no
   lookup follows.
3. **Resolved addresses.** Any other name is resolved (A and AAAA, 5 s timeout,
   2 tries), and **every** answer must be public by the same rules. The lookup
   fails closed: an empty answer set, `SERVFAIL` or a timeout also refuses.
   This is what stops `127.0.0.1.nip.io` or an attacker's record pointing into
   RFC 1918 space. The resolver talks to nameservers directly, so `/etc/hosts`
   entries are not consulted.

The check runs at publish, on a `PATCH` of `upstream_url`, when a spec revision
moves a proxy that follows its document, and on a gateway restore. A refusal is
`400 SPEC_INVALID` with `details.reason` `private_upstream` (plus the
`resolved` addresses when DNS decided) or `unresolvable_upstream`.

`NEXUS_ALLOW_PRIVATE_UPSTREAMS=true` skips all three checks, including the
lookup. Use it only for a portal that fronts internal services, and restrict
gateway egress at the network layer instead.

**Residual risk: time-of-check, not time-of-use.** Nexus resolves the name once,
when the backend is written; Edge resolves it on every request. DNS rebinding or
a re-pointed record is invisible to the portal, and Nexus does not pin the
address because the proxy stores a hostname. Run Ferrum Edge with
`FERRUM_BACKEND_ALLOW_IPS=public` so the gateway screens the address it actually
connects to. Nexus's check gives the provider an immediate `400`; Edge's egress
mode holds when the record changes later.

### Out of scope

- The security of Ferrum Edge itself and of the upstream services behind it.
- **Request and response body validation.** `spec_enforcement: routes` (see the
  [provider guide](guides/provider-guide.md#enforcement-level)) rejects paths
  and methods the OpenAPI document does not declare, but nothing validates a
  body against a schema. That is the backend's job.
- Anyone with shell access to the Nexus process or its environment. They hold
  `NEXUS_SECRET_KEY` and `FERRUM_ADMIN_JWT_SECRET`.
- TLS termination, WAF and DDoS handling, which belong to the proxy in front.

---

## 2. Session security

- **Opaque tokens.** 32 random bytes, base64url. Not a JWT: nothing about the
  user is encoded in it.
- **HMAC at rest.** `sessions.token_hash` is HMAC-SHA-256 of the token under a
  key HKDF-derived from `NEXUS_SECRET_KEY` (info `nexus-session-hmac-v1`). A
  database dump yields no usable tokens. The key is separate from the
  settings-encryption key (info `nexus-settings-v1`).
- **Cookie flags.** `nexus_session` is `HttpOnly`, `SameSite=Lax`, `Path=/`,
  `Max-Age=NEXUS_SESSION_TTL`. Both cookies are `Secure` unless
  `NEXUS_COOKIE_SECURE=false`; the default is on unless the environment
  resolves to development (`NEXUS_ENV`, else `NODE_ENV` of `production`/`test`,
  else development). The Docker image sets `NODE_ENV=production`. All cookie
  writes go through `server/src/middleware/session-cookies.ts`.
- **Cookie responses are never cacheable.** The pair is a bearer credential,
  so a shared cache that kept one response and replayed it would hand its
  cookies to another client. Every response that sets or clears a cookie
  carries `Cache-Control: private, no-store` and `Vary: Cookie`, whatever its
  route set: a root `onSend` hook enforces it on `200`, `304` and error
  responses alike, after the cookies are serialized. This covers cookies set
  through Fastify's reply API; raw `reply.raw.setHeader` or `writeHead` calls
  and hijacked replies bypass the hook, so those paths must not set cookies.
  No such path exists today.
- **Sliding expiry.** Default idle lifetime 12 hours (`NEXUS_SESSION_TTL`,
  seconds). Every API request extends the session, but the row is only written
  when less than half the TTL remains. That write also re-issues both cookies
  with their existing values and a fresh full `Max-Age`, so the browser's
  expiry tracks `sessions.expires_at`. The one exception is
  `GET /api/branding`: its response is publicly cacheable, so it never slides
  the session or sets a cookie, and the next request to any other API route
  does the renewal.
- **Revocation is immediate.** An `onRequest` hook re-reads the user on every
  request Fastify routes under `/api` (static SPA assets are skipped; they embed
  no auth state). An expired session is deleted. If the account is deleted or
  not `active`, **every** session of that user is deleted, so an open tab gets
  `401` on its next request. Disabling an account also strips its gateway
  identity — see [Disabling an account](#disabling-an-account).
- **A password change ends every other session.** `PATCH /api/users/me` with
  `new_password` deletes all of the account's sessions and issues one
  replacement for the calling tab.
- **A password reset ends every session.** `POST /api/auth/reset-password`
  deletes them all and clears the calling browser's cookies.
- **Sign-in does not reveal which addresses exist.** A missing account still
  costs a scrypt derivation against a decoy hash, and both failures return the
  same `401 UNAUTHORIZED`.
- **Registration does reveal a taken address (accepted risk).**
  `POST /api/auth/register` answers `409 CONFLICT` for an existing address. With
  email verification off (the default), a successful registration signs the new
  account in, and a refusal cannot imitate that. The exposure is bounded: the
  password is hashed before the lookup, so a refusal takes as long as a sign-up;
  the route shares the 20/min `/api/auth` limiter and the registration CAPTCHA;
  and a portal with registration closed answers `403` before any lookup.

### Password recovery

`POST /api/auth/forgot-password` mails a single-use link and
`POST /api/auth/reset-password` redeems it. Both are anonymous, so they are
built to reveal nothing:

- **One response.** `200 { "ok": true }` whether the address has an account,
  has none, is disabled, or was asked for again inside the 10-minute throttle.
  `POST /api/auth/resend-verification` behaves the same way.
- **One latency.** The service starts a scrypt derivation before branching and
  awaits it afterwards (`withTimingFloor`), so every branch takes as long as
  the slowest.
- **One answer on failure.** A store or mail fault is logged at `warn` and still
  answered with the uniform `200`, so a partial outage cannot become an
  existence oracle.
- **One rejection for every bad link.** Unknown, expired and spent tokens all
  return `400 VALIDATION_FAILED` with the same message.
- **Tokens cannot cross flows.** Each token carries a `purpose`
  (`email_verification` or `password_reset`) and every lookup names the one it
  expects. A 24-hour verification link cannot be spent as a password reset.
- **Reset links are short-lived and single-use.** One hour
  (`PASSWORD_RESET_TTL_SECONDS`), burned by a compare-and-set in the same
  transaction that writes the new password.
- **Issuing a new reset link supersedes the old one.** After the 10-minute
  throttle, a fresh request deletes every existing `password_reset` token for
  the account in the same transaction that mints and queues its replacement, so
  only the newest link is ever live. A leaked or suspected link cannot outlive
  the request meant to replace it. `email_verification` tokens are left alone.
- **Every password change invalidates outstanding reset links.** A self-service
  change or a redeemed reset commits the new password, the deletion of all
  `password_reset` tokens, session invalidation and the audit row in one
  transaction, under a per-user lease so concurrent changes across instances
  are ordered. `email_verification` tokens are left alone.
- **The link is unreadable in the outbox.** The token is stored only as an
  HMAC, and the queued message that carries it is sealed (AES-256-GCM under a
  key derived from `NEXUS_SECRET_KEY`, bound to the row id and recipient), so
  read access to the database does not yield a live reset or verification
  link. Only the outbox worker opens it, just before delivery. See
  [Queued single-use links are sealed](#queued-single-use-links-are-sealed).
- **A failed mint does not spend the throttle window.** The throttle claim
  (`email_token_issue_claims`), the token, the audit row and the outbox message
  (idempotency key `reset:<token id>` or `verify:<token id>`) commit in one
  transaction. The message is rendered before the claim, so a broken template
  also leaves nothing claimed.
- **The audit log records the truth.** `auth.password_reset_request` and
  `auth.verification_resend` are written only when a link was really issued.
- **Rate limiting applies.** Both routes share the 20/min `/api/auth` limiter,
  which also bounds the cost of the scrypt floor.

### Browser session cache

The SPA clears its session-scoped TanStack Query cache and mutation cache on
logout, on any global `401`, and on a session refresh that returns `401`. A
sign-in after sign-out or an identity change clears it again before accepting
the new principal, so cached data cannot cross accounts in one tab. Only the
public branding and CAPTCHA queries survive, and they are invalidated in place.
A transient refresh failure keeps the session.

### Password storage

scrypt with `N=16384, r=8, p=1`, a 32-byte output and a 16-byte random salt,
stored as `scrypt:N:r:p:<salt b64>:<hash b64>` so parameters can be raised later
without invalidating old hashes. Verification is constant-time and returns
`false` (never throws) for malformed input. Minimum length is 12 characters. A
self-service change requires the current password and is rate-limited per
account (see [Rate limiting](#rate-limiting)).

### Single sign-on (OpenID Connect)

Nexus is an OpenID Connect relying party (`server/src/sso/`). A provider comes
from `NEXUS_OIDC_PROVIDERS` or from **Admin → Settings → Single sign-on**; setup
is in [`operations.md` §14](operations.md#14-single-sign-on-openid-connect).
**Configuring a provider is a trust decision**: whoever runs it can sign any
claim for its own users, so the controls below bound what a provider can do
with that rather than assume it is honest.

**The flow.** Authorization code with PKCE (`S256`), `state` and `nonce`:

- `GET /api/auth/sso/:provider/start` mints a 32-byte `state`, `nonce` and
  PKCE verifier and seals them, with the provider id, the page to return to
  and a 10-minute expiry, into the `nexus_sso` cookie: AES-256-GCM under a key
  HKDF-derived from `NEXUS_SECRET_KEY` (info `nexus-sso-transaction-v1`),
  `HttpOnly`, `SameSite=Lax`, `Path=/api/auth/sso`, `Secure` like the
  session cookies. Nothing about the attempt is stored server-side or readable
  in the browser.
- `GET /api/auth/sso/:provider/callback` clears that cookie whatever happens,
  and refuses (`invalid_state`) unless the cookie opens, names this provider,
  has not expired, and its `state` equals the returned one (constant-time).
  This is the login-CSRF defence: a response the browser did not ask for has
  no matching cookie. Only then is the code redeemed, with the verifier, so a
  stolen code is useless without the cookie that holds it.
- **`SameSite=Lax`, not `Strict`.** The provider returns the browser with a
  top-level cross-site `GET`, which a `Strict` cookie would not accompany.
  Both routes are `GET`s, outside the CSRF check by method; neither changes
  anything until the sealed `state` has matched.
- Both answer with redirects, never JSON: to the provider, back into the SPA
  (a same-origin path only — never an absolute URL, `//host`, an API route or
  the sign-in page), or to `/login?sso_error=<reason>` with a reason from a
  closed set. Provider error text, tokens and claims are never put in a URL.
- The session is the ordinary one: the same issuance, cookies and CSRF
  binding as a password sign-in, and every response that sets a cookie is
  `private, no-store`.

**Talking to the provider.** HTTPS only: the issuer and every endpoint its
discovery document names (`authorization_endpoint`, `token_endpoint`,
`jwks_uri`) must be `https://`. A plain `http://` issuer is accepted only for
a literal loopback host (`localhost`, `127.0.0.1` or `::1`) and only with
`NEXUS_OIDC_ALLOW_HTTP_LOOPBACK=true`, which is for a development provider on
the same machine. Every request must also go to a **public address**: a host
such as `localhost`, `*.internal` or `*.local`, a private, loopback,
link-local or otherwise reserved IP literal, or a name that resolves to one is
refused before anything is sent, with the rules the OpenAPI importer uses. This
covers the endpoints a discovery document names too, so a provider cannot
point the portal at its own network. The literal loopback hosts are exempt
under `NEXUS_OIDC_ALLOW_HTTP_LOOPBACK=true`, and
`NEXUS_OIDC_ALLOW_PRIVATE_ADDRESSES=true` lifts the check entirely, for a
provider on a private network. Redirects are not followed, and every request
has a 5-second deadline and a 512 KiB response cap. The discovery document must
name exactly the configured issuer, and is cached for an hour. So is the key
set, which an unknown `kid` refetches at most once per 30 seconds, so forged
tokens cannot turn the portal into a request amplifier. Concurrent sign-ins
share one discovery or key-set request, and a failed one is remembered for 30
seconds, so an unreachable provider is not hammered either. A provider that
advertises PKCE methods without `S256`, or ID token algorithms without `RS256`
or `ES256`, is refused.

**ID token validation** (`sso/oidc.ts`, with `jose`):

- The signature must verify against the provider's JWKS under an explicit
  allow-list of `RS256` and `ES256`. `none` and the HMAC algorithms never
  verify, which closes the classic confusion attack of an HMAC keyed with the
  provider's public key.
- `iss` must equal the discovered issuer. `aud` must contain the client id,
  and with several audiences, or any `azp`, `azp` must be the client id.
- `exp` and `nbf` are checked with 60 seconds of leeway. `iat` may be at most
  60 seconds in the future, and no older than the 10-minute sign-in window
  (`maxTokenAge`) plus that leeway. `sub`, `exp` and `iat` are required, and
  `sub` must be 1–255 characters.
- `nonce` must equal the sealed one (constant-time), and `at_hash`, when the
  token carries one, must match the access token.

**Which account a sign-in opens.** In this order:

1. **A linked subject.** `user_identities` keys a link on
   `(provider, issuer, sub)` (unique, case-sensitive), never on the email
   address. A provider that
   changes a user's address, or lets a user change it, cannot move the sign-in
   into another account. An account holds at most one identity per provider.
   The issuer is part of the key: a subject asserted by a different issuer
   under the same provider id matches nothing. A settings provider's issuer
   cannot be changed while it holds links (`400`). Removing a provider deletes
   its links in the same transaction, so a provider added later under the same
   id starts with none. The exception is a stored provider shadowed by an
   environment one: its removal leaves the links alone, because they are the
   environment provider's.
2. **An existing account with the same address.** This happens only when
   `link_existing_accounts` is on, and it needs proof from **both sides**:
   - The ID token carries `email_verified: true`. That means the JSON boolean:
     the string `"true"` or an absent claim counts as "not verified".
   - The portal holds a **recorded proof** of the account's current address,
     in `user_email_proofs`. A proof is written only by an event that proves
     control of the mailbox:
     - redeeming a verification link;
     - completing a password reset;
     - an identity provider asserting the verified address when it provisioned
       the account or linked it automatically. An explicit link records none.

   Nothing else counts. The policy in force does not, and `users.email_verified`
   does not. With `require_email_verification` off, a registration is marked
   verified without any proof. If such a flag counted, an attacker could
   register a victim's address in advance and capture the victim's first
   single sign-on (account pre-hijacking). That stays true after an
   administrator later turns verification on. Accounts created before the proof
   table existed have no proof. A proof is for one address: it stops counting
   when the account's address changes.

   **An `admin` or `super_admin` account is never linked this way**
   (`privileged_account`). Whoever controls a provider that asserts the
   address would otherwise gain administrator access. Its holder links
   explicitly (below). Anything else that falls short is refused
   (`email_not_verified` or `account_exists`) and nothing is linked. A second
   provider is held to exactly the same rule.

3. **Just-in-time provisioning**: a new account with the mapped role and
   organization and an unusable password hash. That is a well-formed scrypt
   string of random bytes, so a password attempt costs a full derivation and
   fails like a wrong password. By default provisioning needs a verified
   address (`require_verified_email`), so an unverified provider email cannot
   squat an address. It never seats the founding `super_admin`: that stays with
   the bootstrap token.

**Explicit linking.** A signed-in account links itself from **Profile → Linked
sign-in** (`POST /api/auth/sso/:provider/link`, session and CSRF). The sealed
attempt records the account and the session that started it, and the callback
attaches the identity only when it returns to that same session
(`link_session_mismatch` otherwise). This is the only way an administrator's
account is ever linked. The identity's email address plays no part, because
the holder is present and chose it.

A session is not proof that its holder owns the account's address, though.
With `require_email_verification` off, anyone can register a victim's address,
sign in, and link an identity of their own. That link is keyed on `sub`, so it
would keep opening the account after the victim resets the password and takes
the account back. An explicit link therefore needs the portal's **recorded
proof** of the account's current address, the same proof the automatic rule
needs, and is refused with `address_unproven` without it. The provider's
`email_verified` is not trusted here, even for the account's own address: the
attacker chooses the provider account, and a provider whose users can set or
claim an address, or that verifies addresses loosely, would let them assert
the victim's. Accepting an explicit link records no proof, so a link never
turns the provider's word into the portal's proof. The one exception is the
**founding `super_admin`**, the account recorded under
`bootstrap.super_admin_claimed` when it was seated with the bootstrap token.
That token is the operator's proof of ownership, so the founder links without
an address proof, which keeps a portal with no SMTP able to move to `sso_only`. The exemption
also requires the account to still hold `super_admin`. A claim written before
the founder's seat became atomic can name an account that was never promoted;
if a `super_admin` later promotes that account, it gains the exemption too.

The provider's own domain list still applies, and a subject already linked to
another account is refused (`already_linked`). A refused link returns to
`/profile?sso_error=<reason>`.

**Allowed domains.** There are two lists:

- a deployment-wide list, which applies to every single sign-on, returning ones
  included;
- a per-provider `allowed_email_domains`, which applies when that provider
  links (automatically or explicitly) or provisions.

When both are set, both apply. Whenever a domain list applies, the address must
also be verified by the provider (`email_not_verified` otherwise), since an
unverified address proves no domain.

**Claims map to roles, never to `super_admin`.** A mapping names a claim (a
name or a dot path, e.g. `groups`, `realm_access.roles`) and a value. The
highest matching role wins, else the provider's default, and a `null` default
means no access. The role set a mapping can name is `client`, `provider`,
`admin`: `super_admin` is not representable. An account that already is a
`super_admin` is never changed by claims: not demoted, not moved between
organizations, never deprovisioned, and never refused for claims that map to no
role. With `sync_roles` the role is re-applied on every sign-in, so for linked
accounts **the provider's groups are the source of truth**, including for
`admin`. That is why only a `super_admin` may edit the single sign-on
settings. Every change is written as `auth.sso_claims_sync` by the system actor
in the sign-in's transaction.

**Passwords after single sign-on.** An account that an identity provider
provisioned has no password to use. Password sign-in fails like a wrong
password, a forgotten-password request sends nothing, and a reset link is
refused. Otherwise a reset would give the holder a password that outlives the
provider's offboarding. Provisioning records this in `user_password_locks`,
apart from the links, so it survives an administrator unlinking the identity
and the provider's removal. Nothing clears it: there is no API or setting for
that. Such an account stays active after its provider is removed, but can come
back only through another provider that links it (its address was proven when
it was provisioned).

A pre-existing account that was **linked** keeps its password unless that
provider sets `disable_local_password_for_linked` (off by default). With the
flag on, password sign-in and reset are refused the same way, while the link
exists and the provider is configured.

**A `super_admin` is never refused a password**, whatever its links. That keeps
break-glass sign-in (`NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN`) and a reset available
to one, including when the provider it is linked to is down.

**Losing access.** Claims that map to no role refuse the sign-in
(`access_denied`). With `deprovision_on_access_loss`, the account is also
disabled exactly as an administrator's disable does it:

- its sessions are ended;
- a durable `gateway_teardown_jobs` row is queued in the same transaction. It
  strips every gateway identity the account holds (`nexus-user-<id>`, each
  `nexus-app-<id>`) of its ACL groups and credentials.

See [Disabling an account](#disabling-an-account). This happens **at the next
sign-in**, not when the provider removes the user. Nexus receives no
back-channel events. An account whose provider access was revoked keeps its
existing session until it expires, and its gateway credentials until an
administrator disables it or it signs in again.

The provider's offboarding and MFA **bind an account only when it cannot use a
password**:

- under `sso_only` (without break-glass);
- for a provisioned account;
- for an account linked to a provider with `disable_local_password_for_linked`.

None of these binds a `super_admin` (above). Any other linked account can still
sign in with its password, which the provider knows nothing about.

**Login policy.** `local_only`, `sso_only` or `local_and_sso`. The default is
`local_and_sso`, which with no provider is `local_only` in effect. `sso_only`
refuses password sign-in (`403`) and self-service registration. It does **not**
refuse the founding registration that presents the bootstrap token: that is how
a portal gets its first administrator whatever the policy.

`NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN=true` lets a `super_admin` sign in with a
password under `sso_only`, audited with `break_glass: true`. Anyone else gets
the answer a wrong password gets. It is environment-only for the reason
`NEXUS_CAPTCHA_ENFORCEMENT` is.

`sso_only` cannot be saved without an enabled provider. It also cannot be saved
before the super admin saving it has a link of their own to an enabled
provider, under the provider's current issuer. The admin API refuses both with
`400`, so a policy change cannot lock out the person making it.

**Secrets and logs.** A settings provider's client secret:

- is stored AES-256-GCM encrypted (`sso.client_secret.<id>`,
  [§6](#6-settings-encryption));
- is write-only over HTTP (`client_secret_set`);
- is re-encrypted by `rotate-secret-key`. One that no longer decrypts fails the
  provider closed.

Environment secrets stay in the environment. No token, code, verifier, `state`,
`nonce` or secret is written to the audit log or the server log:

- a refused sign-in logs its provider and reason;
- request logs redact `code` and `state`;
- `details` carry the provider id, the subject and the address.

**Residual risks.**

- A provider operator, or anyone who can make the provider assert a verified
  address, can:
  - sign in as any account linked at that provider;
  - link any non-admin account whose address the portal holds a proof for.

  Configure only providers you trust with that. For a provider you trust less,
  use the domain lists and `link_existing_accounts: false`.

- A proof records that someone controlled the mailbox once. An address that
  later changes hands (a recycled mailbox) still carries its old proof.
- The public-address check resolves a name and then connects, so a name whose
  DNS answer changes between the two (DNS rebinding) could still reach a
  private address. The 5-second deadline, the size cap and the refusal to
  follow redirects bound what such a request can do.
- Deprovisioning happens at sign-in time, not in real time (above). There is no
  SCIM or back-channel logout.

---

## 3. CSRF

Double-submit **bound to the session**:

```
X-Nexus-CSRF header  ==  nexus_csrf cookie  ==  sessions.csrf_token
```

All three must match (`timingSafeEqual`). The token is minted with the session
and stored on its row, so a cookie an attacker plants cannot match. The
`nexus_csrf` cookie is deliberately not `HttpOnly`: the SPA reads it to echo it
back.

The check covers every non-`GET`/`HEAD`/`OPTIONS` request under `/api` that
carries a session. The only exempt routes are the pre-session ones:
`/api/auth/login`, `/api/auth/register`, `/api/auth/verify-email`,
`/api/auth/resend-verification`, `/api/auth/forgot-password`,
`/api/auth/reset-password` and `/api/auth/captcha`. **`POST /api/auth/logout`
is not exempt.** An anonymous mutation is rejected by the route's own guard with
`401`.
The single sign-on start and callback routes are `GET`s, so the method exempts
them. Their defence is the sealed `state` (see
[Single sign-on](#single-sign-on-openid-connect)).
`POST /api/auth/sso/:provider/link` carries a session and is checked like any
other mutation.

Scope and exemptions use the route Fastify matched, not the raw path, so an
encoded spelling such as `/%61pi/...` is still covered. Unknown `/api` paths
(including `/api` itself) hit JSON catch-all routes rather than the SPA; an
authenticated unsafe request there still needs a valid CSRF token and then gets
`404`. Router-rejected malformed paths get a non-cacheable JSON `400`.

Defence in depth: `SameSite=Lax` on both cookies, `frame-ancestors 'none'`,
`X-Frame-Options: DENY` and `form-action 'self'`.

---

## 4. RBAC

Roles are ordered `client` < `provider` < `admin` < `super_admin`, and each role
inherits everything below it. Only `client` and `provider` can be chosen at
registration; `admin` and `super_admin` require promotion by a `super_admin`.

Route guards check the **role**; services check **row-level ownership**.

### Capability matrix

| Capability                                                | client | provider | admin | super_admin |
| --------------------------------------------------------- | ------ | -------- | ----- | ----------- |
| Register, sign in, manage own profile                     | ✓      | ✓        | ✓     | ✓           |
| Browse catalog, read specs                                | ✓      | ✓        | ✓     | ✓           |
| Create and manage own applications                        | ✓      | ✓        | ✓     | ✓           |
| Request access, cancel own request                        | ✓      | ✓        | ✓     | ✓           |
| Read **own** identities' request/grant on an API          | ✓      | ✓        | ✓     | ✓           |
| Issue / rotate / revoke **own** credentials               | ✓      | ✓        | ✓     | ✓           |
| Messaging, notifications                                  | ✓      | ✓        | ✓     | ✓           |
| Publish an API, update own API/spec                       | —      | ✓        | ✓     | ✓           |
| Configure palette plugins on **own** API                  | —      | ✓        | ✓     | ✓           |
| Create a test consumer for own API                        | —      | ✓        | ✓     | ✓           |
| Approve / deny requests and revoke grants on **own** APIs | —      | ✓        | ✓     | ✓           |
| Edit / delete **another** provider's API                  | —      | —        | ✓     | ✓           |
| Decide requests / revoke grants on **any** API            | —      | —        | ✓     | ✓           |
| List all users; change `client` ⇄ `provider`              | —      | —        | ✓     | ✓           |
| Manage organizations                                      | —      | —        | ✓     | ✓           |
| List another account's credential metadata                | —      | —        | ✓     | ✓           |
| Reconcile a consumer's credentials                        | —      | —        | ✓     | ✓           |
| Revoke another account's credential                       | —      | —        | ✓     | ✓           |
| Rotate another account's credential (receives its secret) | —      | —        | —     | —           |
| Read/reply in the platform inbox; read any thread         | —      | —        | ✓     | ✓           |
| Portal settings: branding, registration policy            | —      | —        | ✓     | ✓           |
| Email templates, mass email, SMTP test to own address     | —      | —        | ✓     | ✓           |
| Read the audit log                                        | —      | —        | ✓     | ✓           |
| Portal settings: **SMTP, CAPTCHA and gateway URL**        | —      | —        | **—** | ✓           |
| SMTP test message to **another** address                  | —      | —        | **—** | ✓           |
| Grant or revoke `admin` / `super_admin`                   | —      | —        | **—** | ✓           |
| Disable or re-enable an `admin` or `super_admin`          | —      | —        | **—** | ✓           |
| Gateway reference reconcile and repair                    | —      | —        | —     | ✓           |
| God mode (4 endpoints)                                    | —      | —        | —     | ✓           |

The bolded gaps are the point of the `super_admin` tier: an `admin` cannot
escalate itself or anyone else, cannot disable an administrator, and cannot
take over the platform's mail or gateway origin.

No role can rotate another account's or application's credential. A rotation
returns the replacement's plaintext, and the replacement keeps the identity's
consumer and grants, so receiving it is acting as that identity. An
administrator revokes instead, which hands them nothing
([§5](#5-show-once-credentials)).

`smtp`, `captcha` and `gateway` are `super_admin`-only because each is an
escalation path. The SMTP host receives every verification and reset link (an
account takeover of every user); CAPTCHA settings can switch off the
registration brake; the gateway origin tells every client where to send its
gateway credentials. `PUT /api/admin/settings` answers `403 FORBIDDEN` when an
`admin` sends any of these sections. The check lives in the settings service, so
it holds however `updateSettings` is reached.

The SMTP test sends straight through the relay, outside the outbox, so an
`admin` may aim it only at their own address; another `to_email` is
`403 FORBIDDEN`. Every administrator is limited to 10 tests per rolling hour,
counted from their `admin.smtp_test` rows under a per-actor lease, and the route
to 3 per minute when the rate limiter is on. The `admin.smtp_test` row commits
before the relay is contacted, so a delivered test is never unrecorded.

The settings body rejects unknown sections and keys at every level with
`400 VALIDATION_FAILED` naming each field path. Validation runs before anything
changes. Omitted fields keep their values; an accepted write and its audit row
share one transaction.

### Email template link policy

Email templates are `admin`-editable, so their links are constrained:

- Render contexts expose server-built `reset_url` and `verification_url`, never
  raw tokens. The retired `reset_token` and `verification_token` placeholders
  render empty, and saving either fails with `400 VALIDATION_FAILED`.
- An action URL placeholder may only be the entire `href` of an HTML anchor or
  a whitespace-delimited URL in the text body — not in image URLs, CSS, other
  attributes, subjects or another URL.
- Only `*_url` placeholders may fill a URL or attribute. Every other value is
  HTML-escaped text; at send time it is refused only if it carries an explicit
  off-policy `http(s)://` URL a mail client would autolink.
- HTTP(S) links, protocol-relative URLs, URL attributes and CSS `url(...)` must
  resolve to the `NEXUS_PUBLIC_URL` origin or a host listed in
  `NEXUS_EMAIL_TEMPLATE_ALLOWED_LINK_HOSTS` (exact hosts, empty by default).
  `javascript:` and `data:` are always refused; ambiguous HTML/CSS is refused
  rather than interpreted. Raw HTML from the mass-email composer must be
  complete markup on its own.
- Templates are checked on save, again before rendering, and substituted
  destinations before enqueueing. A stored override that violates the policy is
  replaced by the built-in template with a warning, so recovery mail still
  flows. A rendered message that violates it is logged and not enqueued.

Action links are still bearer credentials: operators must trust any allowlisted
host. Messages already in the outbox before an upgrade are not revalidated.

### Scoping rules worth knowing

- **Access requests and grants** are scoped by ownership. A `provider` sees the
  inbox for their own APIs; filtering by an `api_id` they do not own is
  `403 FORBIDDEN`. Approve, deny and revoke need ownership plus at least the
  `provider` role, or `admin`. Demotion to `client` removes these powers even if
  the account still owns APIs.
- **Publishing list** always scopes a `provider` to their own APIs. `mine` is an
  admin's opt-in.
- **Credentials** are always the caller's own unless an `admin` passes
  `user_id` — and then only metadata, never a secret.
- **Catalog** answers `404`, not `403`, for an API you may not see. Published
  `internal` APIs are unlisted but readable by any signed-in user with the link.
  Catalog objects omit `upstream_url`. Catalog specs replace every OpenAPI
  `servers` entry (root, path item, operation, webhooks, callbacks, and Link
  Object `server`) with the gateway invoke URL, or just the listen path when no
  public gateway origin is configured. The document is re-serialized in its
  original format (comments and formatting are lost); an invalid stored document
  fails closed. URLs a provider writes in prose or examples are not redacted.
  The original spec is only at `GET /api/apis/:id/spec` (owner or admin). The
  change history (`GET /api/catalog/:slug/changes`) is opened under the same
  rule and serves only stored summaries: operation, parameter, property, media
  type and component names, status codes, types and enum values, each cut to
  200 characters. Never the document, its `servers`, descriptions, examples or
  extensions. Its comparison reads document keys as own properties into maps,
  never follows a `$ref` at every occurrence, keys the text of each enum,
  schema and parameter once (a long value as a digest), and stops at a fixed
  work budget.
  Summaries are recorded whatever the API's visibility, and served under the
  visibility it has when they are read: history recorded while an API was
  `private` or `retired` becomes readable to every signed-in account once the
  API is `public` or `internal`. It names what a revision removed — operations,
  parameters and properties — so it can reveal names the current document no
  longer carries. A provider that must not disclose those should delete and
  republish the API rather than change its visibility.
- **Authorizing a private API's viewer** (`POST /api/apis/:id/viewers`) does not
  reveal who administers the portal: an administrator's address or id gets the
  same `400 VALIDATION_FAILED` as an unknown one, and nothing is written.
  Authorizing an ordinary account does confirm it exists; that is the feature.

### The provider / operator split on gateway plugins

A provider can enable **nine palette plugins** (`security_headers`,
`request_size_limiting`, `response_size_limiting`, `ip_restriction`,
`bot_detection`, `correlation_id`, `compression`, `request_deduplication`,
`request_termination`; see [`api.md`](api.md#plugin-palette)). Seven more are
managed from fields on the API row: `key_auth`, `basic_auth`, `jwt_auth`
(`auth_plugin`), `access_control` (`requestable`), `rate_limiting`
(`rate_limit`), `cors` and `openapi_validator` (`spec_enforcement`).
`response_caching` is retired: existing installations can be removed but not
added.

The line is a security boundary:

- **Provider-facing** plugins change how consumers of this one API are
  authenticated, shaped or protected. The worst a mistake does is break the
  provider's own API.
- **Operator-only** plugins (log sinks, tracing, metrics, fault injection, load
  testing, mirroring, mesh and SPIFFE) are cluster-wide or can carry request
  data off the box. They are configured through Foundry or `FERRUM_*`
  environment, never through Nexus.
- The auth family (`hmac_auth`, `jwks_auth`, `oauth2_introspection`,
  `mtls_auth`) is held back because it changes the credential model, and
  `spec_expose` because it needs a public spec endpoint.

Every palette write is owner-or-admin (`assertCanAdminister`), CSRF-protected,
validated against a closed key set before any gateway call, and audited. A
plugin outside the palette is `404 NOT_FOUND`; a first-class one is `400`
pointing at its field.

**A provider only touches configs the portal created.** An operator may attach
their own `rate_limiting`, `cors`, `access_control` or auth config to a portal
proxy, and a provider must not be able to rewrite or remove it. Nexus records
every config it creates by id (`api_plugins.ferrum_plugin_config_id` for
palette plugins, `api_gateway_plugins` for the first-class ones) and only
replaces or deletes recorded configs. For APIs published before that record
existed, a config is adopted only if it exactly matches what the portal wrote.
Ambiguous cases are refused with `409 CONFLICT` before any gateway write (see
[`architecture.md`](architecture.md#53-the-plugin-naming-trap)), including an
`auth_plugin` swap whose only outgoing-flavour config carries operator
settings. When a swap goes through beside an outgoing-flavour config the portal
does not own, that config keeps accepting the old credentials, so the
`api.update` row and the `PATCH` response record
`existing_credentials_invalidated: false` and list the config ids under
`outgoing_auth_configs_remaining`.

**Compensation is in memory.** A gateway write that fails, including one Edge
applied but never acknowledged, is undone before the error is returned
(`api.plugin_rollback`, `api.gateway_repair_required` record the outcome). If
the Nexus process dies between Edge applying a change and the undo, nothing
records it. `POST /api/admin/gateway/reconcile` finds references that no longer
resolve; a config whose values drifted is only found by comparing the proxy's
configs on Edge with the API's settings in the portal. After an unclean
shutdown during provider activity, check the APIs that were being changed.

### First user and the last-super-admin guard

**While the portal has no active `super_admin`, the next registration becomes
one**, auto-verified, whatever role it asked for and regardless of the
registration policy. Every other registration gets the role it asked for,
subject to `open_registration` and `allowed_roles`.

#### The bootstrap token

Because that registration hands out `super_admin`, it needs a token: while no
active super admin exists, `POST /api/auth/register` without a matching
`bootstrap_token` is `403 FORBIDDEN`.

- **Source.** `NEXUS_BOOTSTRAP_TOKEN` (at least 16 characters, checked at
  startup). When unset, each process generates a 32-byte hex token and prints it
  at `warn` while the portal has no super admin. A configured token is never
  logged. See
  [`operations.md`](operations.md#first-run-and-the-bootstrap-token).
- **Check.** SHA-256 digests compared with `timingSafeEqual`, before the
  password is hashed or anything is written. A failed attempt leaves no trace.
- **After bootstrap the field is inert.** Later registrations are ordinary
  `client`/`provider` accounts whether or not they send the token. New super
  admins come only from promotion.
- `GET /api/branding` publishes `bootstrap_required` (no active super admin) so
  the sign-up form knows to ask. The token itself is never exposed over the API.

#### The founder's seat is atomic

The seat is decided by counting active super admins inside the founder's
transaction, under the cross-instance `users:super-admins` lease — the same
lease every transition that can shrink the super-admin set takes. The password
is hashed before the lease is taken. Inside the transaction the account is
created as a verified `super_admin`, the `bootstrap.super_admin_claimed` record
is written and the `auth.register` audit row lands, all or nothing. A failed
bootstrap leaves the seat open for the next attempt; see
[Recovering a portal with no super admin](operations.md#recovering-a-portal-with-no-super-admin).
Candidates that reach the lease after the seat is taken get the role they
asked for.

**The last active `super_admin` cannot be demoted, disabled or removed** →
`409 LAST_SUPER_ADMIN`. The count excludes the target. It is enforced in both
`users/service.ts` (`PATCH /api/users/:id`) and `admin/god-service.ts`, because
god mode does not use the ordinary path. Disabling your own account is a
separate `409 CONFLICT`; when both apply, `LAST_SUPER_ADMIN` wins, because it
says how to fix it: promote a second super admin.

### Cross-instance locks are fenced at commit

Every cross-instance lock (the super-admin, account-lifecycle, password-change,
message-budget, access-request-budget and broadcast keys, and the gateway
consumer, identity and proxy keys) is an `edge_leases` row with a 60-second TTL,
renewed at half-life. A waiter gives up after 30 seconds with `409 CONFLICT`.
Expiry keeps a crashed instance from blocking a key forever, but it also means a
**stalled** instance can resume after another has taken its key.

The fence (`server/src/lib/lease-fence.ts`) stops that stale holder's database
writes:

- Each acquisition writes a fresh random token as the row's owner.
- Every `store.transaction` opened inside a leased section checks, as its last
  statement, that each held token still owns its key (`LeaseRepo.verify`). If
  not, the transaction fails with `409 CONFLICT` and rolls back.
- On PostgreSQL, MySQL and MongoDB the check is a write to the lease row, so a
  takeover waits for the holder's commit. SQLite serializes all transactions,
  so a read suffices. MongoDB standalone (`NEXUS_DB_ALLOW_STANDALONE=true`) has
  no atomic commit, so the check runs before the body instead.

Writes that must be fenced are written as fenced transactions: sign-in session
inserts, password-change replacement sessions, gateway identity registration and
removal, consumer mappings, credential revocations on teardown, gateway restore
and spec-revision intent and completion rows, the API row delete after a
test-consumer teardown, the budget count-then-insert checks, and broadcast
counts. A refused sign-in is told to sign in again; a password change whose new
password committed is told the password **was** changed.

Some lease-guarded writes are deliberately not fenced, because each records a
gateway write that already happened and refusing it would only hide it: the
credential mirror under a consumer key, an API's plugin and ownership rows under
its `proxy:<id>` key, an approval's compare-and-set claim on the request, and
compensation records (`repair_required`, `api.gateway_repair_required`,
`api.gateway_restore_failed`). New lease-guarded writes belong in a transaction
taken after the key.

**The fence cannot fence Ferrum Edge.** Edge's whole-resource `PUT`s carry no
concurrency token, so a stale holder's gateway write still lands. Run a single
gateway-writing Nexus instance ([`operations.md` §8](operations.md#8-scaling)).

### Disabling an account

Both `PATCH /api/users/:id` with `status: "disabled"` and
`POST /api/admin/god/disable-user`:

1. delete every session, so an open tab gets `401`;
2. strip every ACL group from the account's Ferrum consumer;
3. delete **every credential of every type** on that consumer (including
   `basicauth`, which never appears in Edge reads) and mark the
   `credential_metadata` rows `revoked`;
4. delete every **other** Edge consumer registered to the account, or on which
   it holds live credentials, and revoke those rows too.

Step 2 alone is not enough: an API published with `requestable: false` has no
`access_control` plugin, so only deleting the credential stops it. Step 4
exists because `nexus-user-<id>` is not the only identity: a provider's
**test consumer** (`nexus-test-<api_id>`) holds its own credential and the
API's `nexus:api:<id>:approved` group. Test consumers are deleted outright.
`DELETE /api/apis/:id` collects the API's test consumer the same way, after the
proxy is deleted and before the portal rows go.

What makes this hold under concurrency:

- **The lock orders writes; it does not authorize them.** Every gateway step for
  one identity runs under that consumer's key. Every path that _adds_ gateway
  access (credential issue, rotation, test-consumer issuance, approval) reloads
  the owner inside the key and refuses a non-`active` owner with
  `403 USER_DISABLED`. Either the append wins and the teardown behind it deletes
  it, or the teardown wins and the append is refused.
- **An identity is registered before it exists.** A non-canonical consumer gets
  a `gateway_identities` row before Edge is touched, written under the account's
  lifecycle key (`users:lifecycle:<user_id>`), which both disable paths also
  take. Either the registration commits first and the teardown finds it, or the
  disable commits first and the registration is refused with
  `403 USER_DISABLED`.
- **Nexus names every consumer it creates**, so a create that failed or lost its
  acknowledgement can be found by id and compensated. A registration is dropped
  only when a lookup proves the consumer does not exist.
- **Re-enabling cancels the teardown.** `status: "active"` deletes the pending
  job, and the teardown re-reads the account inside the lock and refuses with
  `409 CONFLICT` if it is no longer disabled. Re-enabling rebuilds each
  identity's `nexus:api:<id>:approved` groups from active grants only; revoked
  credentials and test identities are never restored. Repeating the
  active-status `PATCH` retries a partially failed restore.

Mechanics are in
[`operations.md` §11](operations.md#11-gateway-revocation-for-disabled-accounts).

#### The gateway half is durable work, not a side effect

The disable commits whether or not Edge answers. What must not happen is the
gateway half being dropped, because a disabled account's API key authenticates
directly to Edge. So steps 2–4 are owed by a `gateway_teardown_jobs` row (one
per account) written in the same transaction as `users.status = 'disabled'` and
the `user.disable` audit row.

- The revocation runs immediately. On success the response says
  `gateway_teardown: "ok"` (or `"no_consumer"`); on failure it says `"pending"`
  and the job stays queued. **`pending` means the credentials are still live.**
- `credentials/teardown-worker.ts` polls every 5 seconds and retries with
  exponential backoff capped at 5 minutes, **indefinitely** while the account is
  disabled.
- Admins see the job on `GET /api/users/:id` (`gateway_teardown`), the backlog as
  `pending_gateway_teardowns` on `GET /api/users`, and can retry with
  `POST /api/users/:id/gateway-teardown/retry`.

**Alert on** the `warn` line `Gateway revocation for a disabled account failed;
it stays queued for retry` and on a `pending_gateway_teardowns` that does not
return to zero.

---

## 5. Show-once credentials

**Plaintext credential material is returned in exactly one HTTP response and is
never stored.** Nexus keeps a SHA-256 fingerprint and the last four characters
in `credential_metadata`.

Only `POST /api/credentials`, `POST /api/credentials/:id/rotate` and
`POST /api/apis/:id/test-consumer` ever return a secret. `/api` responses are
`Cache-Control: no-store`, which keeps them out of shared caches.

**A secret is only ever returned to the credential's owner.** Issuing acts on
the caller's own account and applications, and a test consumer's credential
belongs to whoever created it. Rotation is owner-only for every role, `admin` and `super_admin` included
(GHSA-mr69-2744-f78w): the replacement stays on the owner's consumer with the
owner's grants, so its plaintext in an administrator's hands would let them
call the identity's APIs. The check runs before any gateway write and again on
the row re-read inside the consumer's queue. An administrator who needs a
credential gone revokes it (`DELETE /api/credentials/:id`), which returns no
secret, and the owner issues a new one.

**Ferrum Edge enforces the same independently.** Admin API reads return
`keyauth.key` and `jwt.secret` as `[REDACTED]` and omit `basicauth` entirely.
There is no read path to plaintext; a lost credential is rotated, not
recovered.

**What the provider's upstream sees differs by type.** Edge strips `X-API-Key`
(`key_auth`) and `Authorization: Basic` (`basic_auth`) before proxying, because
both run with `hide_credentials` at its default `true`. `jwt_auth` has no such
option, so `Authorization: Bearer <token>` reaches the backend. The provider
cannot mint tokens (the HS256 secret stays with the client) but can replay a
token until its `exp`. `e2e/src/dataplane.test.ts` pins this behaviour.

**Rotation is append-then-delete.** Below the cap, the replacement is created
first and the old entry deleted before the response returns, so both are live
only during the server operation; the response marks the old credential
`revoked`. At `FERRUM_MAX_CREDENTIALS_PER_TYPE` (default 2) there is no room to
append, so the old entry is deleted first and there is a brief gap. For a
caller-visible cutover, issue a new credential, deploy it, then revoke the old.

**Entries are located by position, safely.** Edge gives credential entries no
id. Each row carries `edge_ordinal`, a per-consumer, per-type append counter
assigned under the consumer lock; a live entry's index is its rank by that
counter, never by `created_at`. If the portal and gateway disagree on length,
the operation is refused with `EDGE_ERROR` rather than guessing (a `revoke` of
the only live credential removes the whole type instead). When more than one
live row of a consumer and type has an unknown position (`edge_ordinal = NULL`),
rotating or revoking them is `409 CONFLICT` until an admin runs
`POST /api/admin/credentials/reconcile`, which clears the type on the gateway
and revokes the rows.

**Retirements and appends cannot drift silently.**

- A row is moved to `retiring` before the gateway delete and to `revoked` after.
  A retirement Edge applied but the portal never recorded is settled by the next
  call on that consumer and type, but only in the one unambiguous shape (mirror
  exactly one row longer, exactly one `retiring` row), audited as
  `credential.settle`. A delete proven not to have applied puts the row back to
  `active`.
- An append whose row could not be written, or a rotation replacement whose
  delete failed, is withdrawn — but only against an array still exactly one
  entry longer than before, with the index read from the gateway. Anything not
  withdrawn is recorded as `credential.append_rollback` with
  `withdrawn: false`.
- **`basicauth` fails closed.** Edge never shows it, so its positions are the
  portal's rows alone, and an entry those rows do not account for would make a
  revoke delete a different password while the revoked one kept working. So a
  `basicauth` row is written (as `retiring`) before its append and activated
  only once Edge acknowledges it, and is never deleted by index to undo one.
  While any `basicauth` row of an identity is `retiring` — an append or delete
  whose outcome was never confirmed — issuing, rotating and revoking any other
  one are refused with `409 CONFLICT`. Revoking the identity's last `active`
  `basicauth` credential deletes the whole type, which needs no position, and
  settles those rows with it. With active rows remaining, the owner can clear
  the whole type explicitly (`clear_type=true`, refused for a non-admin when
  the consumer holds another account's row), or an admin reconciles the
  consumer. On upgrade, appends earlier releases recorded as not taken back get
  a `retiring` placeholder (`credential.legacy_placeholder`). That scan runs
  once and does not cover a Nexus database restored on its own; after such a
  restore, reconcile `basicauth` for every consumer.

The procedures are in
[`operations.md` §12](operations.md#12-the-credential-mirror) and
[`architecture.md` §6](architecture.md#6-show-once-credentials).

---

## 6. Settings encryption

`smtp.password`, `captcha.secret_key` and each single sign-on provider's
`sso.client_secret.<id>` are stored encrypted:

| Property    | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Cipher      | AES-256-GCM                                                              |
| Blob format | `v1:<iv b64>:<ciphertext b64>:<tag b64>`, 12-byte IV, 16-byte tag        |
| Key         | HKDF-SHA-256 from `NEXUS_SECRET_KEY`, info `nexus-settings-v1`, 32 bytes |
| Integrity   | A tampered blob fails to decrypt                                         |

All are **write-only over HTTP**: set through `PUT /api/admin/settings` (or
`PUT /api/admin/sso`), never returned. Responses expose only `password_set` /
`secret_set` / `client_secret_set` booleans. The
`admin.settings_update` row records changed key **names** and SMTP
password-source changes, never values.

To change `NEXUS_SECRET_KEY`, stop every instance and run
`npm run rotate-secret-key` (in a built image,
`node server/dist/db/rotate-key-cli.js`) with `NEXUS_SECRET_KEY_PREVIOUS` set to
the old key. It re-encrypts every encrypted setting in one transaction and
writes nothing if any blob fails to decrypt. A key swap without it leaves the
settings unreadable, and both fail closed: CAPTCHA refuses and SMTP sends no
password. See
[`operations.md`](operations.md#7-rotating-nexus_secret_key).

### Queued single-use links are sealed

Verification, re-sent verification and password-reset messages are sealed
before they are written to `email_outbox`, because the rendered message is a
second copy of a token `verification_tokens` stores only as an HMAC:

| Property  | Value                                                                          |
| --------- | ------------------------------------------------------------------------------ |
| Cipher    | AES-256-GCM over `{ subject, html, text }`                                     |
| Key       | HKDF-SHA-256 from `NEXUS_SECRET_KEY`, info `nexus-outbox-v1`, 32 bytes         |
| Binding   | Additional authenticated data is the row `id` and `to_email`                   |
| At rest   | `subject` is `nexus:sealed:v1`, `body_html` is empty, `body_text` the envelope |
| Opened by | The outbox worker only, immediately before `transport.send`                    |

- **It fails closed.** An envelope that does not open (altered, copied onto
  another row or recipient, or sealed under a previous key) is failed with
  `last_error` `sealed-unreadable: …`. It is never sent, and never retried.
- **Rows from earlier versions are sealed in place.** The worker seals legacy
  verification and reset rows in every status, since a `sent` row's link can
  still be live, a bounded batch per tick until none remain.
- **Other mail is stored as rendered.** Access decisions, messaging
  notifications and mass email carry no bearer link.
- **Rotating `NEXUS_SECRET_KEY` does not re-seal.** The rotation already
  invalidates every unused link, so queued sealed mail fails instead of
  delivering a dead link.

### The environment SMTP password stays with the environment relay

`NEXUS_SMTP_PASSWORD` belongs to the relay described by `NEXUS_SMTP_HOST`,
`_PORT`, `_SECURE` and `_USER`. The email service decides which password to
send:

- a stored `smtp.password` that decrypts is used;
- a stored password that **does not** decrypt sends no password and logs a
  `warn` asking for it to be re-entered — it never falls back to the
  environment's password;
- with no stored password, the environment's is used only while the effective
  host, port, TLS mode and username all equal the environment's.

`smtp.password_set` is `true` only when a password would actually be sent.

---

## 7. Exposure and abuse controls

### A published proxy is never briefly open

Edge serves a proxy as soon as it is created, and its plugin configs do nothing
until the proxy names them. So every proxy Nexus creates starts on
`/<namespace>/.staging/<32 hex>` (128 random bits, a segment no slug can
produce). All plugins are attached there, and moving to the real listen path is
the last gateway write. The real path is either `404` or fully gated. The
`spec_enforcement` conversion, which must delete and recreate the proxy, takes
the same route and holds the per-proxy lease, as does API deletion.

Two crash windows remain:

- a crash **between the cutover and the store write** can leave a fully gated
  proxy at the real path with no `apis` row. It fails closed. Find it by
  listing proxies named `nexus-<slug>` whose slug has no `apis` row;
- a crash **before the cutover** leaves a proxy on a staging path. Nothing
  routes to it, but it uses a proxy slot. Every proxy whose `listen_path`
  starts `/<namespace>/.staging/` is abandoned and can be deleted.

### Rate limiting

`@fastify/rate-limit` is registered per route group so unrelated surfaces do not
share counters. Every group answers `429 RATE_LIMITED`.

| Routes                                                                                                         | Limit           | Keyed on |
| -------------------------------------------------------------------------------------------------------------- | --------------- | -------- |
| `/api/auth` POSTs: register, login, logout, verify-email, resend-verification, forgot-password, reset-password | 20/min, shared  | IP       |
| `GET /api/auth/me`, `GET /api/auth/captcha`                                                                    | 120/min, shared | IP       |
| `/api/health*`                                                                                                 | 120/min         | IP       |
| `GET /api/branding`                                                                                            | 120/min         | IP       |
| `PATCH /api/users/me`                                                                                          | 10/min          | account  |
| `PATCH /api/users/me/notification-preferences`                                                                 | 10/min          | account  |
| `POST /api/threads` / `POST /api/threads/:id/messages`                                                         | 10/min / 30/min | account  |
| `GET /api/catalog/:slug/spec`, `…/changes`, `…/changes/:revisionId`, per route                                 | 60/min          | account  |
| `/api/apis` mutations and the two spec-diff routes                                                             | 30/min          | account  |
| `GET /api/apis/:id/usage`                                                                                      | 30/min          | IP       |
| `POST /api/access-requests` / `POST /api/access-requests/:id/cancel`                                           | 10/min / 30/min | account  |
| `/api/applications` create, update, delete                                                                     | 30/min          | account  |

"Account" means `userOrIpKey`: the signed-in user, falling back to the IP
without a session. Per-account keys are the thing an attacker cannot cheaply
rotate, and they do not lump a whole office behind one NAT together.

Notes:

- The sensitive `/api/auth` budget is shared across its routes, so switching
  endpoints gives no fresh allowance, and page loads (`/me`, `/captcha`) never
  spend it.
- `PATCH /api/users/me` has its own limit because it checks
  `current_password`.
- The catalog spec route is the one read that parses a whole document. Results
  are cached per revision and server address (after the visibility check), and
  the limit bounds cache misses.

`NEXUS_RATE_LIMIT_ENABLED` (default `true`) turns all of this on; it is forced
off under `NEXUS_ENV=test`. Counters are in memory, **per process**: N instances
allow N times each limit, so enforce the real limit at the proxy when you run
more than one.

The IP key is `request.ip`, which honours `X-Forwarded-For` only from proxies
named by `NEXUS_TRUSTED_PROXIES` (unset: trust nothing). It takes a hop count
(1–32) or a list of IPs and CIDR blocks (IPv4 prefix 1–32, IPv6 1–128), parsed
at startup; `/0` is refused. Trusting an unfiltered header would let a client
rotate its limiter key and forge the IP in the audit log.

### Parsed documents are bounded by what they decode to

`MAX_SPEC_BYTES` bounds the upload, not what it decodes to, and so not the
server memory a parse — or the catalog's re-serialization of the result — takes.
A YAML alias repeats its anchor at every use and the parsed document does not
remember that it was an alias, so the re-serialization writes out every copy.
Nexus adds the UTF-8 bytes of every mapping key and scalar, at every place it
occurs, plus a per-item indentation charge in the same iterative walk that
bounds nesting, and refuses a document past
`MAX_SPEC_EXPANDED_BYTES` (4 MiB, twice `MAX_SPEC_BYTES`) with
`400 SPEC_INVALID` and `details.reason = "expanded_too_large"`. Without aliases
a document's compact keys and scalars fit within its source, but the bound
also accounts for bytes repeated at each alias occurrence and estimated
serialization indentation. This iterative estimate is checked before
rendering; the rendered byte length is then checked as a backstop for quoting,
line breaks, and other serialization costs. One large anchored scalar aliased
a hundred times — about a hundredfold expansion under the YAML parser's own
per-anchor alias count — is refused. JSON cannot alias but is counted with its
own indentation estimate. Two YAML features would bypass that count, and
neither is honoured:
the YAML 1.1 schema a `%YAML 1.1` directive selects decodes `!!omap` and
`!!set` into a `Map` or `Set` whose contents a walk over plain objects cannot
see, and applies merge keys (`<<: *a`) without charging them against the
parser's alias count. Every document is read with the YAML 1.2 core schema,
merge keys off and those tags unresolved, whatever directive it carries; the
walk refuses any value that is not a plain object, array or scalar
(`reason = "unsupported_node"`); and a mapping key must be a scalar
(`reason = "non_scalar_key"`), since a collection key is stringified once per
occurrence at a cost that grows with the document's anchors.
Quoting and line breaks are not included in the estimate, so an upload (a
publish, a spec revision, a rollback or a diff) is also rendered exactly as the
catalog will serve it and refused with the same reason when that is larger than
`MAX_SPEC_EXPANDED_BYTES`. The catalog parses every
stored revision with the same checks before rendering it and refuses — and
caches only the refusal of — a rendering larger than `MAX_SPEC_EXPANDED_BYTES`,
so a revision accepted before these limits existed fails closed rather than
being written out in full.

### Publishing is bounded per account

Provider registration is open by default, and one publish stores a spec, creates
a gateway proxy and several plugin configs, and writes audit rows.

- **`NEXUS_MAX_APIS_PER_OWNER`** (default `50`, `0` = unlimited) caps APIs owned
  at a time. A publish past it is `429 QUOTA_EXCEEDED` with
  `details: { limit, current, setting }`, before any gateway write. Deleting an
  API frees a slot; retiring one does not. Admins are not exempt.
- **`NEXUS_SPEC_HISTORY_LIMIT`** (default `10`, minimum `1`) caps retained
  historical revisions per API. Aggregate spec storage per account is bounded
  by `MAX_SPEC_BYTES × (NEXUS_SPEC_HISTORY_LIMIT + 1) × NEXUS_MAX_APIS_PER_OWNER`.
  Pruning happens in the transaction that makes a new revision current; the
  current revision and the one a rollback needs always survive.
- **`NEXUS_MAX_APPLICATIONS_PER_OWNER`** (default `20`) caps applications per
  account the same way.
- The per-account 30/min limit above covers every mutating `/api/apis` route
  (publish, patch, delete, spec upload, rollback, plugin set/remove, viewer
  add/remove, gateway restore, test consumer) and the spec-diff routes.

The quota check runs under an in-process per-owner lock, so across N instances
it can overshoot by at most N − 1. See
[`operations.md`](operations.md#abuse-controls). A portal that does not want
strangers allocating gateway resources should remove `provider` from
`allowed_roles` or close registration.

### A published document is untrusted content in every reader's browser

A provider's OpenAPI document is rendered in the browser of every account that
opens the catalog entry. Its rendering cost is bounded in three places:

- **At publish.** Nexus counts what the viewer renders for each operation
  (parameter rows, responses, media types, and every schema value they hold,
  including primitive and boolean schemas, property, item and composition
  entries and enum chips) and refuses more than `MAX_SPEC_RENDER_UNITS`
  (100,000) with `400 SPEC_INVALID`, `details.reason = "too_much_to_render"`.
  The count is what rendering each part of the document once costs: a schema
  `$ref` costs its row and its target's wherever it appears, and each
  referenced schema, parameter, request body or response is charged in full
  once. Each schema object is walked once, memoised by identity, so the count
  is linear in the document however densely its components reference each
  other. It does not bound what the viewer would spend expanding every
  reference everywhere; the per-page budget below does.
- **While following references.** One memoizing resolver per document follows
  parameter, request-body and response `$ref`s, and the render count resolves
  each distinct schema `$ref` string once; chains stop after 32 hops and a
  pointer deeper than `MAX_SPEC_DEPTH` resolves to nothing. A `$ref` longer
  than `MAX_OPENAPI_REF_LENGTH` (2,048 characters) is refused at publish
  (`details.reason = "ref_too_long"`) and resolves to nothing in the viewer, so
  no lookup scans an attacker-sized key.
- **At render.** The viewer spends one node budget across the whole page,
  charging primitive schema placeholders and the wrappers around schema
  properties, items and composition entries before constructing them. A branch
  that exhausts it shows a "truncated" marker and stops walking remaining
  siblings. Repeated schema references draw on this same per-page budget.
  Because the budget counts nodes rather than characters, displayed text
  is also capped per occurrence: descriptions at 1,000 characters, and
  summaries, paths, operation IDs, parameter names, media-type keys, property
  names, types and enum values at 200. A cut ends in `…` with a hint to
  download the specification. Documents starting with `{` or `[` are parsed
  with `JSON.parse`, not the YAML parser, whose flow-mapping parse is
  quadratic. The viewer parses what the catalog serves: documents up to
  `MAX_SPEC_EXPANDED_BYTES`, read as YAML with the server's options (core
  schema, no merge keys, no tag resolution) and the server's alias limit of 100. Served YAML carries no anchors or aliases unless written out in full it
  would exceed `MAX_SPEC_EXPANDED_BYTES` (then it is served aliased, as
  before), so a `servers` array the server-URL rewrite shares across every
  path item and operation is normally written out in full rather than aliased
  past that limit. The publish forms apply the upload limits: 2 MiB, checked
  before parsing, and the alias limit of 100.

The render budget also protects readers from documents published before the
publish-time ceiling existed.

### Messaging abuse resistance

An authenticated account is not a trusted one. One message writes a message row
and an audit row, and a _platform_ thread (`recipient_user_id: null`) notifies
and emails every active `admin` and `super_admin`. Independent bounds:

1. **Burst limits** — 10 thread creations and 30 replies per minute per
   account.
2. **A rolling 24-hour budget** — `NEXUS_MAX_MESSAGES_PER_USER_PER_DAY`
   (default 200, `0` disables), counted per sender across all threads and
   checked before any row is written. Over it is `429 QUOTA_EXCEEDED` with
   `details: { limit, window, setting }`. Admins are subject to it too. The
   count and insert run in one transaction under the `messages:budget:<user>`
   lease, so the budget holds across instances; a sender who waits more than
   30 s for the lease gets `409 CONFLICT`.
3. **Broadcast recipients** — `NEXUS_MAX_BROADCAST_RECIPIENTS` (default 5,000,
   `0` disables) per god-mode broadcast, checked before the first row.
   Broadcast rows do not draw on the sender's message budget.
4. **Broadcasts per day** — `NEXUS_MAX_BROADCASTS_PER_DAY` (default 20, `0`
   disables) per administrator, counted from `god.broadcast` rows under a
   per-actor lease.
5. **Mass-email campaigns** — admin-only, checked before anything is written:
   `NEXUS_MAX_MASS_EMAIL_RECIPIENTS` (default 5,000) bounds the audience,
   `NEXUS_MAX_MASS_EMAIL_BYTES` (default 64 MiB) bounds one rendered message,
   sized as an upper bound that includes HTML escaping of the recipient's name
   and address, times the audience, and `NEXUS_MAX_MASS_EMAILS_PER_DAY`
   (default 5, low until security mail has its own outbox lane, issue #500) bounds
   campaigns per administrator per rolling 24 hours, counted from
   `admin.mass_email` rows under a per-actor lease. `0` disables each. An
   audience that matches nobody is refused and costs nothing. The campaign row
   commits before the first outbox row, and the fan-out is queued in
   transactions of at most 200 recipients and about 4 MiB, so it never holds
   other writers — password-reset and verification enqueues among them — for
   its whole audience. A retry under the same `idempotency_key` is free only
   when its subject, bodies and audience match the digest on the campaign row;
   anything else under that key is `409 CONFLICT`, so a reused key cannot be
   an uncharged second campaign.
6. **Email coalescing** — `message_received` mail uses the idempotency key
   `message_received:<thread>:<recipient>:<bucket>` with a 10-minute bucket, so
   a reply storm sends one mail per recipient per thread per window.

The per-minute limits are per process; the daily budgets are not.

### Branding abuse resistance

`GET /api/branding` is anonymous and loaded on every SPA start. It has a
120/min per-IP limit and a response cache, `NEXUS_BRANDING_CACHE_MS` (default
5 s, `0` disables): within the window settings are read once, concurrent
callers share one assembly, and the response carries
`Cache-Control: public, max-age=…` and an `ETag`. Because a shared cache may
keep it, the route never slides a session, so neither the `200` nor the `304`
carries `Set-Cookie`; see
[Cookie responses are never cacheable](#2-session-security).

Settings writes invalidate the cache before responding. An open founder seat
(`bootstrap_required: true`) is read live (concurrent requests share one count
query per instance), so no instance keeps advertising a seat another has filled.
A taken seat cannot reopen, so that answer is cached for 1 s.

### Access-request abuse resistance

A self-registered `client` can raise access requests, each writing a request
row, an audit row and a provider notification.

1. **Burst limits** — 10 creations and 30 cancellations per minute per account.
2. **A rolling 24-hour budget** —
   `NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY` (default 20, `0` disables),
   checked before any row is written, under a per-requester lease. It counts
   the requester's `access.request` audit rows, which are append-only, so
   cancelling a request or deleting an application does not refund it.
3. A `429` writes nothing.

### Consumer quotas are per gateway process

Edge's `rate_limiting` plugin keeps counters in one gateway process's memory
unless its config names Redis. With N data-plane replicas, a provider's quota is
enforced N times over. Set `FERRUM_RATE_LIMIT_SYNC_MODE=redis` and
`FERRUM_RATE_LIMIT_REDIS_URL` (plus `FERRUM_RATE_LIMIT_REDIS_TLS` if needed) and
Nexus writes `sync_mode`, `redis_url` and `redis_tls` into every `rate_limiting`
config it saves. Existing APIs pick it up the next time their rate limit is
saved.

### Cross-Site WebSocket Hijacking

Edge passes WebSocket upgrades through `http(s)` proxies, so **publishing an HTTP
API also publishes WebSocket on the same path**. The `cors` plugin does not run
on an upgrade; the only origin check is the proxy's `allowed_ws_origins`, and an
empty list means no check.

Nexus copies the API's exact `http(s)://` CORS origins into `allowed_ws_origins`
unless `cors.enforce_websocket_origins` is explicitly `false`, so older CORS
policies keep the check. Edge cannot allow a missing `Origin` while enforcing
the list, so origin-less upgrades are rejected too. Setting the flag to `true`
explicitly refuses wildcard origins at validation. A policy that omits the flag
and lists `*` mirrors nothing, so its WebSocket path has no origin check.
Removing CORS clears the check. No migration rewrites existing proxies; they
change the next time the provider saves CORS.

Providers of browser-facing WebSocket APIs should list exact origins and leave
the flag on. Mixed browser and origin-less clients need an upstream origin
policy.

### CAPTCHA

Optional, configured in the admin UI. Providers: Cloudflare Turnstile,
hCaptcha, reCAPTCHA. When enabled, register and login require `captcha_token`.

- The site key is public (`GET /api/auth/captcha`, `GET /api/branding`); the
  secret is encrypted and never returned.
- Verification is a server-side POST to the vendor with a 5-second timeout,
  forwarding the client IP as `remoteip`.
- For hCaptcha, whose secret can cover every site of an account, each
  verification also sends the configured `site_key` as `sitekey`, so a token
  solved on another site of the same account is refused. Turnstile and
  reCAPTCHA secrets already belong to one site and are sent no `sitekey`.
- **It fails closed.** No secret, an unreachable vendor or a rejected token is
  `400 CAPTCHA_FAILED`. Vendor error codes are logged, never returned.

Failing closed means a bad configuration locks out **login** too, including the
super admin who saved it. Two safeguards:

**An activation self-test.** A `captcha` patch that enables the challenge, or
changes `provider`, `site_key` or `secret_key` while enabled, must carry a
`captcha_token` solved against the new configuration. The server verifies it
before storing anything, or refuses the whole patch with
`400 CAPTCHA_SELF_TEST_FAILED` (`details.reason`: `token_required`, `rejected`
or `provider_unreachable`). A passed test is recorded as
`captcha_self_test: "passed"` in `admin.settings_update`. Turning CAPTCHA off
needs no token. Also:

- For hCaptcha, whose secrets can cover many sites, the pending `site_key` is
  sent as `sitekey` so a token from another site is refused.
- Changing `provider` while enabled requires a new `secret_key` in the same
  patch (`400 VALIDATION_FAILED`), so a stored secret is never sent to a
  different vendor. SMTP applies the same rule to a connection change.
- The write is a compare-and-swap: if the stored CAPTCHA settings changed since
  the self-test, the patch is `409 CONFLICT`.

**A break-glass switch.** `NEXUS_CAPTCHA_ENFORCEMENT=disabled` (values:
`enforced`, `disabled`) skips verification on register and login and hides the
widget, leaving stored settings untouched. It is environment-only, it is not a
boolean (`0`, `false` and `off` fail startup), the server logs a banner at every
startup while it is set, `GET /api/admin/settings` reports
`captcha.enforcement`, the admin CAPTCHA card shows a warning, and every
registration or sign-in it lets through is audited with
`captcha_bypassed: true`. While set, registration has **no bot protection**, so
fix the settings and remove it. Runbook:
[`operations.md`](operations.md#recovering-a-portal-locked-out-by-captcha).

---

## 8. CSP and response headers

helmet is configured in `server/src/index.ts`:

| Header                      | Value                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | `default-src 'self'`; `base-uri 'self'`; `object-src 'none'`; `frame-ancestors 'none'`; `form-action 'self'`; `img-src 'self' data:`; `font-src 'self' data:`; `style-src 'self' 'unsafe-inline'` |
| `script-src`                | `'self'` plus `https://challenges.cloudflare.com`, `https://hcaptcha.com`, `https://*.hcaptcha.com`, `https://www.google.com`, `https://www.gstatic.com`                                          |
| `frame-src`                 | `'self'` plus `https://challenges.cloudflare.com`, `https://hcaptcha.com`, `https://*.hcaptcha.com`, `https://www.google.com`                                                                     |
| `connect-src`               | `'self'`, `https://hcaptcha.com`, `https://*.hcaptcha.com`                                                                                                                                        |
| `X-Frame-Options`           | `DENY`                                                                                                                                                                                            |
| `Referrer-Policy`           | `no-referrer`                                                                                                                                                                                     |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`, only when `NEXUS_COOKIE_SECURE` is on                                                                                                                      |
| `Cache-Control`             | `private, no-store` plus `Vary: Cookie` on every response that sets a cookie; else `no-store` on every `/api` response that does not set its own (only `/api/branding` does)                      |

Deliberate loosenings:

- The CAPTCHA vendor hosts are always allowed but inert unless an admin enables
  that provider.
- `style-src 'unsafe-inline'` is needed for runtime theming from branding
  settings. `script-src` has no `unsafe-inline` or `unsafe-eval`.
- `img-src data:` is needed because the logo is stored as a `data:` URL.
- `crossOriginEmbedderPolicy` is off so the CAPTCHA iframes work.

**`GET /api/health` tells anonymous callers only what a monitor needs.** The
database probe reports `error: "unreachable"`, never the driver's message
(which could name hosts, ports and database users); the real text is logged.
For anyone but an admin, `edge.error` is `"unreachable"` and `edge.mode`,
`edge.admin_writes_enabled` and `edge.namespace_routing.active`,
`.serving_scope` and `.data_plane_single_namespace` are `null`. The verdict
(`edge.status`, `edge.reason: "namespace_unserved"`,
`edge.namespace_routing.unserved`) stays public.

**Request URL redaction.** Request and error logs replace the values of these
query parameters with `[Redacted]`: `token`, `code`, `state`, `key`, `secret`,
`signature`, `access_token`, `refresh_token`, `api_key` and `password`,
including repeated and percent-encoded forms. Cookie, `Authorization`, CSRF and
`Set-Cookie` headers are redacted too.

**Admin-authored HTML.** Email templates and the mass-email composer accept
HTML. Every interpolated value is HTML-escaped unless its variable is listed in
`rawHtmlVars`. The HTML renders in recipients' mail clients, not the portal,
and the capability is `admin`-only.

---

## 9. Ferrum Edge admin JWT hygiene

The admin JWT is full gateway authority. `server/src/ferrum-admin/jwt.ts` is the
only code that mints it.

- **HS256** with `FERRUM_ADMIN_JWT_SECRET`, at least 32 characters (checked by
  config validation and again at signing).
- **Short TTL.** `FERRUM_ADMIN_JWT_TTL` defaults to **60 seconds** (allowed
  5–3600). Tokens are cached in a 256-entry LRU keyed by every signing input
  (the secret is hashed into the key, not stored) and re-minted when less than
  `min(60, ttl/4)` seconds remain.
- **Claims.** `iss` is `FERRUM_ADMIN_JWT_ISSUER` (default `ferrum-edge`);
  `role` is `admin`; `sub` defaults to `ferrum-nexus` but write calls pass the
  acting user's id, so Edge's own audit names a person; `jti` is a fresh UUID;
  `nbf` equals `iat`.
- **`aud`** is stamped only when `FERRUM_ADMIN_JWT_AUDIENCE` is set, because
  Edge rejects an `aud` claim it was not configured for.
- **`ns`** is always `FERRUM_NAMESPACE` (a single string). A gateway with
  `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true` requires it; others ignore it. An
  empty namespace is refused at signing.

Handling the secret:

- Deliver it through a secret manager or orchestrator secret. `.env.example`
  ships it blank.
- It must be **identical** on Nexus and the gateway; a mismatch makes every call
  fail with `502 EDGE_ERROR` ("The gateway rejected the Nexus admin
  credentials").
- Plaintext `http://` for `FERRUM_ADMIN_URL` to a non-loopback host fails
  startup unless `FERRUM_ADMIN_ALLOW_INSECURE_HTTP=true`, which is only
  defensible on a private network.
- Keep the Admin API reachable from Nexus and nowhere else.
- Rotation is a coordinated restart of both processes; see
  [`operations.md`](operations.md#rotating-ferrum_admin_jwt_secret).

Edge error text is always logged. Whether the browser sees it is decided in one
place, `classify()` in `server/src/ferrum-admin/client.ts`:

- **`400`, `409` and `422` are echoed** in `details.gateway_message` (trimmed to
  500 characters), because they describe the body built from the caller's own
  request. A rejected spec import is `EDGE_REJECTED_SPEC` with the same field.
- **`401`, `403` and `5xx` stay opaque** (`EDGE_ERROR` / `EDGE_UNAVAILABLE`),
  because they describe gateway configuration and can name internal hosts.

Invalid HTTP or JSON responses are `EDGE_PROTOCOL_ERROR`, carrying only the
status and a fixed reason; response bytes are never logged or returned.
Successful JSON is decoded as strict UTF-8. See
[Edge response contracts](edge-response-contracts.md).

---

## 10. Audit event catalog

State-changing endpoints write one `audit_logs` row per event through the audit
service, the table's only writer. Rows are append-only: the store has no update
or delete path.

Each row has `actor_user_id` and `actor_role` (both `null` for anonymous and
system events), `action`, `target_type`, `target_id`, a JSON `details` object,
the client `ip` and `created_at`. Admins read them at
`GET /api/admin/audit-logs`, filterable by `actor_user_id`, `action`,
`target_type`, `target_id`, `from` and `to`. The response adds
`actor: { id, email, display_name, role }` from the current user record (or
`null`); `actor_role` keeps the role at the time of the event. A null actor id
is shown as `system`. Time bounds are normalized to UTC millisecond timestamps;
`from` is inclusive and `to` exclusive.

A combined role and status patch writes both events. Fields that did not change
are left out of `changed_fields`, and a patch that changes nothing writes no
row — except an API patch that only repaired gateway drift, which writes
`api.update` with empty `changed_fields` and `gateway_reconciled: true`.

**Changes commit with their audit rows.** Account, access, credential,
publishing, plugin, organization and deletion changes write their row in the
same store transaction as the change, so a failed audit insert rolls the change
back (and any gateway write is compensated). Gateway work that cannot be rolled
back first commits an **intent** row (`*_start`) and then its completion row
with the local change; a repeat that finds the gateway side already done copies
the intent row's details and adds `resumed: true`. Work that runs after a
committed change writes an **outcome** row once it has run.

Every action is classified in `AUDIT_COMMIT_CLASSES` in
[`server/src/audit/service.ts`](../server/src/audit/service.ts) as
`transactional`, `intent` or `post_commit` (with a reason). The map is
exhaustive, so an unclassified action does not compile, and
`server/src/test/transactional-audit.test.ts` fails when a `transactional` or
`intent` action is recorded outside a transaction or with its failure
swallowed.

**Secrets never appear in `details`.** Settings updates record key names;
credential events record type and last4; plugin events record config keys, not
values; single sign-on events record the provider id and subject, never a
token, code or client secret.

Naming is `<domain>.<verb>`, lowercase snake_case. God-mode actions are `god.*`.

> **Adding an event?** Add it to `AuditAction` in
> [`server/src/audit/service.ts`](../server/src/audit/service.ts), classify it in
> `AUDIT_COMMIT_CLASSES`, **and** add it to this catalog. `CONTRIBUTING.md`
> makes that a review requirement.

### Gateway

| Action                    | Target type     | Description                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway.metrics_enable`  | `plugin_config` | Startup created the namespace-global metrics config. `details`: `namespace`.                                                                                                                                                                                                                                                                                                                                                             |
| `gateway.reconcile`       | `gateway`       | A super admin ran `POST /api/admin/gateway/reconcile`. Read-only; recorded because it dates a gateway retarget. `target_id` is the namespace. `details`: `status` (`ok` \| `orphaned` \| `unknown`), `checked_consumers`, `orphaned_consumers`, `checked_proxies`, `orphaned_proxies`, `complete`, `error`.                                                                                                                              |
| `gateway.consumer_repair` | `user`          | A super admin recreated an account's missing gateway consumer (`POST /api/admin/gateway/repair`). `details`: `namespace`, `previous_consumer_id`, `consumer_id`, `ferrum_username`, `restored_groups`, `revoked_credentials`, `revoked_credential_ids`, optional `reason`, `resumed`. No credential is minted; revoked credentials must be re-issued. See [`operations.md` §13](operations.md#13-retargeting-or-rebuilding-ferrum-edge). |

### Authentication

| Action                        | Target type | Description                                                                                                                                                                                                           |
| ----------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.register`               | `user`      | An account was created; the actor is the new account. `details`: `email`, `role`, `first_user`, `verification_required`, `captcha_bypassed` when set.                                                                 |
| `auth.login`                  | `user`      | A successful password sign-in; `details.captcha_bypassed` when CAPTCHA enforcement was off, `details.break_glass` when the `sso_only` policy admitted a `super_admin`. Failed sign-ins are rate-limited, not audited. |
| `auth.logout`                 | `session`   | A session was ended by its owner.                                                                                                                                                                                     |
| `auth.verify_email`           | `user`      | A verification token was redeemed.                                                                                                                                                                                    |
| `auth.verification_resend`    | `user`      | A new verification link was issued and queued. Written only when a link was really sent.                                                                                                                              |
| `auth.password_reset_request` | `user`      | A reset link was issued and queued. Absent for an unknown address, a disabled account or a throttled request.                                                                                                         |
| `auth.password_reset`         | `user`      | A reset link was redeemed: new password set, address marked verified, every session ended.                                                                                                                            |

### Single sign-on

| Action                 | Target type | Description                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.sso_login`       | `user`      | A single sign-on opened a session; committed with the session. `details`: `provider_id`, `subject`, `identity_id`, `email`, `provisioned` or `linked` when this sign-in did that too. Refused sign-ins are logged (provider and reason), not audited.                                                                                                                               |
| `auth.sso_provision`   | `user`      | Just-in-time provisioning created the account. `details`: `provider_id`, `subject`, `email`, `email_verified`, `role`, `org_id`, `role_mapping`, `org_mapping` (the rules that matched). Never `super_admin`.                                                                                                                                                                       |
| `auth.sso_link`        | `user`      | An identity-provider subject was linked to an existing account: automatically under the proven-address rule, or explicitly from the account's own session. `details`: `provider_id`, `subject`, `identity_id`, `email`, `explicit`, `email_verified_by_provider`.                                                                                                                   |
| `auth.sso_unlink`      | `user`      | An administrator removed a link (`DELETE /api/users/:id/identities/:identityId`). `details`: `identity_id`, `provider_id`, `subject`.                                                                                                                                                                                                                                               |
| `auth.sso_claims_sync` | `user`      | A sign-in's claims changed the account's role or organization; the actor is the system. `details`: `provider_id`, `subject`, `from_role`/`to_role` and/or `from_org_id`/`to_org_id`, `role_mapping`, `org_mapping`. Never written for a `super_admin`.                                                                                                                              |
| `auth.sso_deprovision` | `user`      | A sign-in's claims mapped to no role and `deprovision_on_access_loss` is on: the account was disabled, its sessions ended and its gateway revocation queued, in one transaction; the actor is the system. `details`: `provider_id`, `subject`, `reason`, `role`, `terminated_sessions`, `gateway_teardown: "queued"`. The revocation's outcome is `user.gateway_teardown_complete`. |

### Users and organizations

| Action                                 | Target type    | Description                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user.update`                          | `user`         | Profile or account fields changed, without a role or status change. `details`: `self`, `changed_fields` (`password` as a name only), `terminated_sessions` on a self-service password change.                                                                                                                                                                          |
| `user.notification_preferences_update` | `user`         | An account changed its own notification preferences. `details`: `changed` (the preference names), and every preference's new value.                                                                                                                                                                                                                                    |
| `user.role_change`                     | `user`         | `details`: `from_role`, `to_role`.                                                                                                                                                                                                                                                                                                                                     |
| `user.enable`                          | `user`         | An account was re-enabled. `details`: `from_status`, `to_status`. Repeating `status: "active"` on an active account re-runs the gateway restore and records `changed_fields: []` and `gateway_restore_retry: true`.                                                                                                                                                    |
| `user.disable`                         | `user`         | An account was disabled (ordinary or god mode), committed with the disable, session deletion and teardown job. `details`: `from_status`, `to_status`, `terminated_sessions`, `gateway_teardown: "queued"`.                                                                                                                                                             |
| `user.gateway_teardown_complete`       | `user`         | The queued gateway revocation landed. Actor is the system (worker) or the admin whose immediate attempt succeeded (`inline: true`). `details`: `attempts`, `gateway_teardown` (`ok` \| `no_consumer`), `gateway_consumer_id`, `revoked_credentials`, `removed_acl_groups`, `deleted_consumers`. A failed immediate attempt writes nothing; see the job's `last_error`. |
| `user.gateway_teardown_retry`          | `user`         | An admin re-ran a pending revocation (`POST /api/users/:id/gateway-teardown/retry`). `details`: `attempts`, `gateway_teardown: "queued"`.                                                                                                                                                                                                                              |
| `org.create`                           | `organization` | `details`: `name`.                                                                                                                                                                                                                                                                                                                                                     |
| `org.update`                           | `organization` | `details`: `changed_fields`.                                                                                                                                                                                                                                                                                                                                           |

### Publishing

| Action                        | Target type   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.publish`                 | `api`         | An API was published. `details`: slug, listen path, proxy id, auth plugin, requestable, visibility, rate limit, CORS policy, method allow-list, backend timeouts, circuit breaker, enforcement level, upstream, spec path count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `api.update`                  | `api`         | Runtime settings changed. `details`: `changed_fields`, plus context such as `previous_auth_plugin`, `existing_credentials_invalidated`, `outgoing_auth_configs_remaining` (see [§4](#the-provider--operator-split-on-gateway-plugins)), `proxy_rebuilt: true` when a `spec_enforcement` change recreated the proxy (a brief outage), and `gateway_reconciled: true` for a drift-only repair.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `api.spec_update`             | `api`         | A new spec revision became current. `details`: spec id, version, path count, enforcement level, `backend_updated`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `api.spec_rollback`           | `api`         | A retained revision was redeployed as a **new** revision. `details`: as `api.spec_update`, plus `restored_from_spec_id`, `restored_from_version`, `restored_from_created_at`; `spec_id` is the new revision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `api.spec_revision_start`     | `api`         | Intent: a revision is about to rewrite a live proxy (a `routes` API, or a `docs_only` one whose document moves the backend). `details`: `operation` (`update` \| `rollback`), `version`, `restored_from_spec_id`, `proxy_id`, `spec_enforcement`, `backend`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `api.spec_revision_failed`    | `api`         | A started revision failed. `details`: `operation`, `version`, `restored_from_spec_id`, `proxy_id`, `restored`, `error`, and `steps` / `step_errors` when `restored: false`. **Alert on `restored: false`**: the gateway may serve the attempted document or backend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `api.spec_notify`             | `api`         | Grantees were told a revision changed the API, committed with the notices and emails of one batch of up to 200 accounts. `details`: `spec_id`, `kind`, `version`, `batch` / `batches`, `recipients`, `notified`, `already_notified` (an unread notice was already there), `in_app_off`, `emailed`, `email_coalesced` (one was already queued this clock hour), `email_off` (email is opt-in), `email_capped` (past `NEXUS_MAX_MASS_EMAIL_RECIPIENTS`), `email_failed` (the message was refused by the link policy), `failed_batches` (earlier batches that failed), `superseded`, `superseded_spec_ids` and `superseded_breaking` (the waiting fan-outs of the same API this one replaced, which revisions they were, and whether any broke something; if one did, this run's notices say so). A waiting fan-out a graceful stop discards gets a row with `discarded: true`. When a batch fails or is skipped at shutdown, a final row with no counts, only `batches`, `failed_batches` and `skipped_batches`, records it. Not written for a revision that changed nothing. |
| `api.retire`                  | `api`         | An API moved to `retired` (instead of `api.update`). `details`: `changed_fields`, `gateway_untouched: true` — the proxy and grants stay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `api.delete_start`            | `api`         | Intent, before the gateway teardown. `details`: slug, proxy id, and `test_consumer_id` / `test_consumer_credentials` when a test identity exists. A start without a completion is a delete to retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `api.delete`                  | `api`         | An API and its Edge objects were destroyed. `details`: slug, proxy id, `revoked_grants`, and `test_consumer_id` / `test_consumer_revoked_credentials` only when there was a test consumer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `api.plugin_set`              | `api`         | A palette plugin was created or replaced. `details`: `plugin_name`, `enabled`, `config_keys` (never values), `trigger`, `replaced`, `plugin_config_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `api.plugin_remove_start`     | `api`         | Intent, before a palette plugin's config is deleted. `details`: `plugin_name`, `label`, `plugin_config_id` (or `null`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `api.plugin_remove`           | `api`         | A palette plugin was detached and deleted. Only the portal's own config is removed. `details`: `plugin_name`, `label`, `was_attached`, `plugin_config_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `api.plugin_rollback`         | `api`         | A palette `set` or `remove` reached the gateway and then failed. `details`: `operation`, `plugin_name`, `plugin_config_id`, `proxy_id`, `restored`, `error`, `step_errors` when `restored: false`. **Alert on `restored: false`**: the config may still carry the attempted change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `api.gateway_repair_required` | `api`         | The API's gateway state needs an operator. Also logged at `error`. **Alert on it.** Phases below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `api.publish_rollback`        | `api`         | A publish reached the gateway and then failed. `details`: `slug`, `proxy_id`, `spec_enforcement`, `auth_plugin`, `withdrawn`, `error`, `stranded_proxy_id` when `withdrawn: false`. **Alert on `withdrawn: false`**: a proxy may be live on its staging path with no `apis` row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `api.gateway_restore`         | `api`         | An API's gateway deployment was rebuilt in place (same id, slug, history and grants; new proxy). `details`: `slug`, `listen_path`, `proxy_id`, `spec_id`, `spec_enforcement`, `auth_plugin`, `requestable`, `rebuilt` (`false`: the stored proxy was live after all, so only the flag was cleared).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `api.gateway_restore_start`   | `api`         | Intent, before a restore builds a new proxy. `details`: `slug`, `listen_path`, `proxy_id` (minted by Nexus), `spec_id`, `spec_enforcement`, `auth_plugin`. Not written when a restore only clears a stale flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `api.gateway_restore_failed`  | `api`         | A restore reached the gateway and then failed; the API stays `repair_required`. `details`: as `api.publish_rollback`. **Alert on `withdrawn: false`.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `api.auth_plugin_changed`     | `api`         | Companion to `api.update` for an `auth_plugin` change on a live API. `details`: `previous_auth_plugin`, `auth_plugin`, `previous_credential_type`, `affected_grantees` / `affected_grantee_ids` (they must issue a new credential; theirs are **not** revoked), `api_owned_credentials` / `revoked_api_credentials` (the API's test-consumer keys), `failed` / `failure_errors`, `outgoing_auth_configs_remaining`. **Alert on a non-empty `failed`.** No row when nothing was disrupted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `api.viewer_authorize`        | `api`         | A provider let one account **read** a private API's docs. `details`: `slug`, `visibility`, `viewer_user_id`, optional `note`, `grants_invocation: false` (no ACL group, no gateway change).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `api.viewer_revoke`           | `api`         | A read authorization was withdrawn. `details`: `slug`, `visibility`, `viewer_user_id`, `revoked_grant: false` (grants are revoked separately).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `application.create`          | `application` | `details`: `name`. The gateway identity is created on first approval or credential.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `application.update`          | `application` | Renamed, re-described, disabled or re-enabled. `details`: `name`, `status` when it changed, and `revoked_existing_access: false` on a disable — disabling blocks new requests, approvals and credentials but revokes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `application.delete_start`    | `application` | Intent, before the gateway identity is deleted. `details`: `name`, `consumer_id`, `unmapped_consumer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `application.delete`          | `application` | The application and its consumer were deleted; its credentials stop working. `details`: `name`, `consumer_id` (or `null`), `revoked_grants`, `revoked_credentials`, `unmapped_consumer: true` when the consumer was found by its derived id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `test_consumer.create`        | `api`         | A provider created or replaced the `nexus-test-<api_id>` consumer. `details`: `consumer_username`, `consumer_id`, `credential_type`, `replaced`, `revoked_credentials`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

`api.gateway_repair_required` phases (`details.phase`):

| Phase            | Meaning                                                                                                                                                                                        | Other `details`                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `conversion`     | A `spec_enforcement` conversion failed and the original proxy could not be restored. The API has **no gateway proxy**; grants and credentials stay valid.                                      | `proxy_id`, `plugin_names`, `spec_enforcement` (the level the row still holds), `attempted_spec_enforcement`, `error`, `restore_error` |
| `rollback`       | The conversion succeeded, a later step of the same `PATCH` failed, and the unwind could not rebuild the proxy. Same outcome as `conversion`.                                                   | as `conversion`, plus `restore_target`, without `error`                                                                                |
| `compensation`   | A `PATCH` or spec revision could not undo every gateway change. The proxy exists but may not match the catalog.                                                                                | `proxy_id`, `attempted_changes`, `steps`, `step_errors`, `error`                                                                       |
| `orphaned_proxy` | The stored proxy id no longer exists on the gateway (found by gateway reconciliation or a restore). The reference is cleared and the API marked `repair_required` until `api.gateway_restore`. | `namespace`, `proxy_id`, `slug`, `spec_enforcement`, optional `reason`                                                                 |

Raw proxy and plugin configurations are never recorded.

### Access workflow

- **Approval rollback** treats an unacknowledged gateway write as possibly
  applied and removes the group unless a live grant needs it.
  `acl_group_possibly_applied` records that uncertainty. An `acl_group_orphaned`
  field means the group may still be on the consumer.
- **A targeted revocation** holds the API's `proxy:<id>` lease (the one approvals
  take) through the ACL removal and the grantee notice, so a re-approval is
  ordered behind it. An approval writes its grant under the consumer's key, so
  an application delete cannot leave a grant behind.
- **The god-mode grant sweep** (`bulk: true`) never puts a grant back to
  `active` when its ACL removal fails. The failure is named in
  `god.disable_user_complete`'s `failed_grants`, and the account teardown that
  follows strips the group.
- Every revocation moves the originating request to `revoked`.

- **A targeted revocation rollback** re-reads the grantee under the account
  lifecycle key and the consumer under its key before restoring the grant. It
  restores only the claim it made, and only while the account is active, the
  application still exists when applicable, and the ACL group remains on the
  consumer. A skip records `grantee_disabled`, `grantee_missing`,
  `application_missing` or `group_absent`; a lock wait timeout is retried until
  an attempt has also timed out beyond the lease TTL.

| Action                    | Target type      | Description                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access.request`          | `access_request` | A client requested access. `details`: api id and slug. Also the row the daily request budget counts.                                                                                                                                                                                                                    |
| `access.cancel`           | `access_request` | The requester withdrew their pending request.                                                                                                                                                                                                                                                                           |
| `access.approve`          | `access_request` | Approved; the ACL group is on the consumer. Committed with the grant. `details`: api id/slug, user id, grant id, `acl_group`.                                                                                                                                                                                           |
| `access.approve_rollback` | `access_request` | An approval failed after the gateway write. `details`: api id/slug, user id, `cause`, `acl_group_possibly_applied`, then `acl_group_removed` + `request_released`, or `acl_group_kept` + `kept_for_grant_id`, or `acl_group_orphaned` (investigate).                                                                    |
| `access.deny`             | `access_request` | Declined; nothing changed on the gateway. `details`: api id/slug, user id, `has_note`.                                                                                                                                                                                                                                  |
| `access.revoke`           | `grant`          | A grant was withdrawn. Committed with the claim, before the gateway call. `details`: api id/slug, user id, `acl_group`, `reason`, `bulk: true` for the god-mode sweep. Exactly one row per grant.                                                                                                                       |
| `access.revoke_rollback`  | `grant`          | A targeted revocation's ACL removal failed. `details`: api id, user id, `acl_group`, `cause`, `grant_restored`, optional `restore_skipped_reason` (`grantee_disabled`, `grantee_missing`, `application_missing`, `group_absent`). **Investigate `grant_restored: false` without a skip reason**: the group may be live. |

### Credentials

`credential.reconcile` works only on consumers the portal owns: a recorded
mapping whose username still matches, a registered gateway identity, or portal
credential rows whose owner's derived username (`nexus-user-<user_id>`,
`nexus-app-<application_id>`, or `nexus-test-<api_id>` for an existing API)
matches the live consumer. Any other `consumer_id` is `403 FORBIDDEN` before any
gateway write; a malformed id is `400 VALIDATION_FAILED`.

| Action                          | Target type  | Description                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credential.issue`              | `credential` | A gateway credential was minted. `details`: credential type, consumer id, `last4`.                                                                                                                                                                                                                                                                                                           |
| `credential.rotate`             | `credential` | Rotation by the credential's owner (an administrator is refused); target is the **new** credential. `details`: type, consumer id, `rotated_from`, `previous_last4`. Rows written before GHSA-mr69-2744-f78w may carry `owner_user_id`, naming the owner an administrator rotated for.                                                                                                        |
| `credential.revoke_start`       | `credential` | Intent, committed with the row's move to `retiring`, before the gateway delete. `details` as `credential.revoke`; a rotation at the per-type cap writes one with `operation: "rotate"`. Completed by `credential.revoke`, `credential.rotate` or `credential.revoke_rollback`.                                                                                                               |
| `credential.revoke`             | `credential` | Deleted from Edge and marked `revoked`. `details`: type, consumer id, `last4`, optional `scope: "whole-type"`, and — when caused by an `auth_plugin` change on the API's own test consumer — `reason`, `api_id` and the `auth_plugin` pair. The target row lists settled rows in `swept_credential_ids`; each swept row also gets its own event with `swept_by` and `owner_user_id`.         |
| `credential.revoke_rollback`    | `credential` | A retirement whose gateway delete provably never applied; the row went back to `active`. `details`: `credential_type`, `consumer_id`, `last4`, `operation` (`revoke` \| `rotate`), `cause`, `owner_user_id`.                                                                                                                                                                                 |
| `credential.settle`             | `credential` | A retirement Edge applied but the portal never recorded, settled by a later call. `details`: `credential_type`, `consumer_id`, `last4`, `owner_user_id`, `mirror_rows`, `gateway_entries`.                                                                                                                                                                                                   |
| `credential.append_rollback`    | `consumer`   | An appended entry had to be taken back after an issue or rotation failed. `details`: `credential_type`, `consumer_id`, `operation` (`issue` \| `rotate`), `withdrawn`, `last4`, `append_index`, `owner_user_id`, `cause`, and `stranded_credential_id`, `retired_credential_id`, `suspected` where they apply.                                                                               |
| `credential.reconcile`          | `consumer`   | An admin emptied one credential type on a consumer and revoked its rows. `details`: `credential_type`, `consumer_id`, `gateway_cleared`, `revoked_credentials`, `revoked_credential_ids`, `owner_user_ids`, optional `reason`.                                                                                                                                                               |
| `credential.legacy_placeholder` | `credential` | The upgrade scan found a `basicauth` append an earlier release recorded as not taken back (`credential.append_rollback`, `withdrawn: false`) that no live row accounts for, and wrote a `retiring` placeholder row that holds the consumer's positions closed until the type is cleared. `details`: `credential_type`, `consumer_id`, `last4`, `owner_user_id`, `source_event_id`. No actor. |

A `credential.revoke_start` with no completion row means one of:

- the delete's outcome could not be proved, or it landed but could not be
  recorded — the row stays `retiring`;
- the delete was proved not to have applied, but the lease fence refused the
  withdrawal, or both the combined retry and the move-alone fallback failed —
  the row stays `retiring`;
- a cap rotation deleted the old key but could not create the replacement;
- the move-alone fallback put the row back to `active` but the best-effort
  `credential.revoke_rollback` row was lost;
- on MongoDB without transactions (`NEXUS_DB_ALLOW_STANDALONE=true`), the
  withdrawal's move applied but its audit write failed — the row is `active`.

Revoking a `retiring` credential again completes it.

### Messaging and notifications

| Action                  | Target type      | Description                                                                           |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `message.thread_create` | `message_thread` | A new conversation was opened. `details`: `subject`, `api_id`, `platform`.            |
| `message.send`          | `message`        | A message was posted, including a thread's first message. `details`: `thread_id`.     |
| `notification.read`     | `notification`   | A user marked notifications read. `target_id` is `null`. `details`: `updated`, `all`. |

### Administration

| Action                      | Target type      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin.settings_update`     | `settings`       | Portal settings changed. `target_id` is `null`, or `sso` for `PUT /api/admin/sso`. `details`: `changed_keys` (never values), `smtp_password_source_change` when relevant, `captcha_self_test: "passed"` when one ran; for `sso`, `section`, `providers_added`, `providers_removed`, `links_removed` (provider id → links deleted with it) and `client_secrets_changed` (provider ids only).                                                                                                                    |
| `admin.template_update`     | `email_template` | An email template was overridden. `target_id` is the template key. `details`: `key`, `body_html_sha256`, `body_text_sha256` (hex SHA-256 of the saved bodies).                                                                                                                                                                                                                                                                                                                                                 |
| `admin.mass_email`          | `mass_email`     | A mass-email campaign was started: written, and counted against `NEXUS_MAX_MASS_EMAILS_PER_DAY`, **before** any outbox row is queued; if it cannot be written nothing is queued. One row per campaign — a retry of the same batch by the same administrator writes none, and is a retry only if its `content_sha256` matches (otherwise `409`). `target_id` is the batch id. `details`: `subject`, `audience_scope`, `recipients`, `bytes` (rendered size × recipients), `content_sha256`, `phase: "started"`. |
| `admin.mass_email_complete` | `mass_email`     | What one attempt at a campaign queued, written best-effort after its chunked fan-out. `target_id` is the batch id. `details`: `subject`, `audience_scope`, `recipients`, `enqueued`, `chunks` (fan-out transactions committed), `failed` (a chunk failed; the retry with the same batch id queues the rest).                                                                                                                                                                                                   |
| `admin.smtp_test`           | `settings`       | An SMTP test was about to be sent: written, and counted against the hourly budget of 10 per administrator, **before** the relay is contacted; if it cannot be written nothing is sent. `target_id` is `smtp`. `details`: `to_email`, `phase: "started"`.                                                                                                                                                                                                                                                       |
| `admin.smtp_test_complete`  | `settings`       | The result of that SMTP test, written best-effort after the send. `target_id` is `smtp`. `details`: `to_email`, `ok`, `intent_id` (the `admin.smtp_test` row).                                                                                                                                                                                                                                                                                                                                                 |

### God mode (`super_admin` only)

Each god-mode row is written **in addition to** the ordinary row of the
underlying operation. `revoke-grant`, `delete-api` and `disable-user` require a
non-empty `reason`; a broadcast records its subject as `reason`.

- `god.broadcast` is the _attempt_, written before the first recipient, so
  `NEXUS_MAX_BROADCASTS_PER_DAY` charges every attempt. `god.broadcast_complete`
  records the outcome.
- `disable-user` commits `god.disable_user` and `user.disable` with the disable
  and records what followed as `god.disable_user_complete`. If any grant in a
  `revoke_grants` sweep could not be fully revoked, or the inline teardown's
  record could not be written, that row lists `failed_steps` and the request
  fails (`502 EDGE_ERROR` for a gateway step, `500 INTERNAL` otherwise).
  Repeating the request re-runs every step.

| Action                      | Target type | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `god.revoke_grant`          | `grant`     | A grant revoked without ownership; commits with `access.revoke`. `details`: `reason`, api id, user id.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `god.delete_api`            | `api`       | An API destroyed without ownership; commits with `api.delete` (and one `access.revoke` per grant with `revoke_grants`). `details`: `reason`, slug, `owner_user_id`, `revoked_grants`.                                                                                                                                                                                                                                                                                                                             |
| `god.disable_user`          | `user`      | Committed with the disable and its `user.disable` row. `details`: `reason`, `previous_status`, `terminated_sessions`, `revoke_grants`, `gateway_teardown: "queued"`.                                                                                                                                                                                                                                                                                                                                              |
| `god.disable_user_complete` | `user`      | What followed the disable. `details`: `reason`, `revoked_grants` (fully revoked only), `terminated_sessions`, `gateway_teardown` (`ok` \| `no_consumer` \| `pending`), `gateway_consumer_id`, `revoked_credentials`, `removed_acl_groups`, `gateway_error`; on failure `failed_steps` (`revoke_grants`, `record_gateway_teardown`), `failed_grant_revocations`, `failed_grants` (`grant_id`, `api_id`, `application_id`, `stage`: `claim` \| `lookup` \| `gateway`). Absent if the outcome could not be recorded. |
| `god.broadcast`             | `broadcast` | Written before the fan-out. `target_id` is the batch id. `details`: `reason` (the subject), `audience_scope`, `recipients`, `send_email`, `phase: "started"`.                                                                                                                                                                                                                                                                                                                                                     |
| `god.broadcast_complete`    | `broadcast` | Written after the fan-out; absent if it could not be recorded. `details`: the same audience keys plus `delivered`, `failed`, `notified`, `threads_created`, `emails_enqueued`.                                                                                                                                                                                                                                                                                                                                    |

### What is deliberately not audited

Reads: browsing the catalog, opening a spec, listing grants and reading the
audit log write no rows. Failed sign-ins are rate-limited instead of audited, so
an attacker cannot fill the table. Notifications are never a record:
`notifications/service.ts` writes no audit rows, and a notification failure
never fails the operation that triggered it.

---

## 11. Hardening checklist

Before going live:

- [ ] `NEXUS_SECRET_KEY` is 32+ random characters from a secret manager, backed
      up separately from the database.
- [ ] `FERRUM_ADMIN_JWT_SECRET` is 32+ random characters, matches the gateway,
      and is not in version control.
- [ ] `FERRUM_ADMIN_URL` is `https://`, or the Admin API is on a private network
      unreachable from the internet.
- [ ] The environment is not development (`NEXUS_ENV=production`, or
      `NODE_ENV=production` as the Docker image sets), so `NEXUS_COOKIE_SECURE`
      and HSTS are on; TLS terminates in front of Nexus.
- [ ] `NEXUS_TRUSTED_PROXIES` names the proxies you control (or the hop count),
      and is unset on a directly exposed instance.
- [ ] `NEXUS_PUBLIC_URL` is the real public origin, and the SPA and API share it.
- [ ] `NEXUS_RATE_LIMIT_ENABLED=true`, with a proxy-level limit if you run more
      than one instance.
- [ ] `FERRUM_RATE_LIMIT_SYNC_MODE=redis` (with `FERRUM_RATE_LIMIT_REDIS_URL`)
      if Ferrum Edge runs more than one data-plane replica.
- [ ] Providers of browser-facing WebSocket backends list exact CORS origins and
      keep `cors.enforce_websocket_origins` on.
- [ ] `NEXUS_ALLOW_PRIVATE_UPSTREAMS` is `false` unless the portal fronts
      internal services, in which case gateway egress is restricted at the
      network layer.
- [ ] The Nexus process can resolve public DNS; with private upstreams refused,
      an unresolvable name cannot be published.
- [ ] Ferrum Edge runs with `FERRUM_BACKEND_ALLOW_IPS=public` (or an equivalent
      egress policy).
- [ ] `NEXUS_BOOTSTRAP_TOKEN` is set from a secret manager before the portal is
      reachable — required with more than one instance, since a generated token
      is per process — and the portal is not public until the founding
      `super_admin` exists.
- [ ] CAPTCHA is configured if registration is open to the internet.
- [ ] `NEXUS_CAPTCHA_ENFORCEMENT` is **unset**.
- [ ] Registration policy reviewed: `open_registration`, `allowed_roles`,
      `require_email_verification`.
- [ ] SMTP is configured and a test message delivered; otherwise verification
      and decision mail queues silently.
- [ ] At least **two** active `super_admin` accounts.
- [ ] Single sign-on, if used: every provider's issuer is `https://`,
      `NEXUS_OIDC_ALLOW_HTTP_LOOPBACK` is unset,
      `NEXUS_OIDC_ALLOW_PRIVATE_ADDRESSES` is unset unless the provider is on
      a private network, the role mappings grant `admin` only to the groups
      you mean, and a provider you trust less has `link_existing_accounts` off
      or an allowed-domain list. Where the provider's offboarding or MFA must
      bind every account, use `sso_only` or
      `disable_local_password_for_linked`.
- [ ] Before switching to `sso_only`: at least two `super_admin` accounts are
      linked from **Profile → Linked sign-in** (the portal refuses the switch
      until the one saving it is), and you know how to set
      `NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN` if the provider becomes unreachable.
- [ ] Backups run and a restore has been rehearsed, for both the Nexus database
      and Ferrum Edge.
- [ ] `GET /api/health` is wired to your monitor, treating `degraded` as
      healthy.
- [ ] Exactly one active Nexus instance serves gateway-mutating requests. Passive
      standbys share one PostgreSQL, MySQL or MongoDB database and do no
      gateway-mutating work until promoted
      ([`operations.md`](operations.md#8-scaling)). SQLite is single-instance.
