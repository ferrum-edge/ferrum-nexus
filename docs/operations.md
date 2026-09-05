# Operations

Running Ferrum Nexus in production: configuration, databases, containers, TLS,
backups, key rotation, the email outbox, scaling limits, health checks, metrics,
and the credential mirror.

- Architecture background: [`architecture.md`](architecture.md)
- Security posture: [`security.md`](security.md)
- First-run walkthrough: [`getting-started.md`](getting-started.md)

---

## 1. Environment variables

`server/src/config/index.ts` is the **only** reader of the environment. It
validates everything with zod at startup and refuses to boot half-configured:
the process prints every offending variable and exits non-zero. The repo-root
[`.env.example`](../.env.example) mirrors this table.

**Where the environment comes from.** The server (`npm run dev`, `npm start`)
and the migration CLI (`npm run migrate`) read a `.env` file if one exists in
the working directory or its parent — the workspace scripts run from
`server/`, so the documented repo-root `.env` is found either way — and layer
the real environment **over** it: a variable exported in the shell, set by a
container runtime or injected by an orchestrator always wins, and a deployed
image with no `.env` behaves exactly as if the feature did not exist. The
path of the file that was read is logged once at startup; its contents never
are. A relative `NEXUS_SQLITE_PATH` resolves from `server/`.

### Required

| Variable                  | Notes                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_SECRET_KEY`        | **Required.** Minimum 32 characters. The master secret; the settings-encryption key and the session-token HMAC key are both HKDF-derived from it. Generate with `openssl rand -hex 32`. To change it, run `npm run rotate-secret-key` with the old value in `NEXUS_SECRET_KEY_PREVIOUS` first — see [§7](#7-rotating-nexus_secret_key). |
| `FERRUM_ADMIN_JWT_SECRET` | **Required.** Minimum 32 characters. Must match the gateway's `FERRUM_ADMIN_JWT_SECRET` exactly.                                                                                                                                                                                                                                        |

### Server

| Variable                              | Default                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_ENV`                           | inferred from `NODE_ENV`, else `development` | `development` \| `test` \| `production`. `test` forces rate limiting off and quietens the logger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `NODE_ENV`                            | —                                            | Only consulted when `NEXUS_ENV` is unset, and only `production`/`test` are honoured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `NEXUS_HOST`                          | `127.0.0.1`                                  | Bind address. Use `0.0.0.0` in a container.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `NEXUS_PORT`                          | `8787`                                       | 0–65535.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `NEXUS_PUBLIC_URL`                    | `http://127.0.0.1:5173`                      | Public origin of the portal. Used to build verification links, catalog/credential/thread URLs in email. Must be an absolute URL; a trailing slash is stripped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NEXUS_TRUSTED_PROXIES`               | _(unset)_                                    | Which proxies may set `X-Forwarded-For`. Unset trusts none: `request.ip` is the socket address, which is what the auth rate limiter and every audit row key on. Accepts an integer hop count counted from the right of the header (`1`), or a comma-separated allowlist of IPs/CIDR blocks (`10.0.0.0/8,192.168.1.7`; `loopback`, `linklocal` and `uniquelocal` are also accepted). An allowlist reaches Fastify's `trustProxy` unchanged; a hop count is compiled into the equivalent predicate, because Fastify maps a bare number to "trust nothing".                                                                                                                                                                                                                                                                                                                |
| `NEXUS_TRUST_PROXY`                   | `false`                                      | **Deprecated.** `true` is an alias for `NEXUS_TRUSTED_PROXIES=1`. It no longer affects cookies or HSTS — see `NEXUS_COOKIE_SECURE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `NEXUS_COOKIE_SECURE`                 | `true` unless `NEXUS_ENV=development`        | Marks `nexus_session` and `nexus_csrf` `Secure` and turns on HSTS. Set `false` only to serve the portal over plaintext `http://`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `NEXUS_LOG_LEVEL`                     | `info`                                       | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `NEXUS_SESSION_TTL`                   | `43200` (12 h)                               | Session idle lifetime in seconds; 60 – 2 592 000. Sliding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `NEXUS_RATE_LIMIT_ENABLED`            | `true`                                       | Installs the 20 req/min limiter on `/api/auth/*` and the 120 req/min limiter on `/api/health*` (both per client IP), the 30 req/min limiter on the mutating `/api/apis/*` routes, and the 10 req/min (new threads) and 30 req/min (replies) limiters on `/api/threads/*` (all three per account). Forced off when `NEXUS_ENV=test`. See [Abuse controls](#abuse-controls).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `NEXUS_HEALTH_CACHE_MS`               | `5000`                                       | How long `GET /api/health` and `GET /api/health/edge` reuse a dependency probe. Within the window the database and gateway are each probed once and the result — including a failing one — is shared by every caller; concurrent callers also share the one in-flight probe. `0` disables the cache and probes on every request. Range 0–60000. See [§9](#9-health-checks).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `NEXUS_MAX_APIS_PER_OWNER`            | `50`                                         | How many APIs one account may own at a time; `0` disables the ceiling. A publish past it is refused with `429 QUOTA_EXCEEDED` before any gateway write. See [Abuse controls](#abuse-controls).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NEXUS_SPEC_HISTORY_LIMIT`            | `10`                                         | Historical spec revisions kept per API, on top of the current one. Older non-current revisions are pruned in the transaction that makes a new revision current. Range 1 – 10 000. With `NEXUS_MAX_APIS_PER_OWNER` this is what bounds per-account spec storage: `MAX_SPEC_BYTES × (limit + 1) × NEXUS_MAX_APIS_PER_OWNER`. See [Abuse controls](#abuse-controls).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `NEXUS_MAX_MESSAGES_PER_USER_PER_DAY` | `200`                                        | Messages one account may post in a rolling 24 hours; `0` disables the budget. Range 0 – 1 000 000. Exceeding it is `429 QUOTA_EXCEEDED`. See [Abuse controls](#abuse-controls).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `NEXUS_ALLOW_PRIVATE_UPSTREAMS`       | `false`                                      | Whether providers may publish an API whose upstream is a loopback, RFC 1918 / CGNAT / link-local address or a `.local` / `.internal` / `.localhost` / `.home.arpa` name. A proxy is an egress path from the gateway's network, so the default refuses them with `400 SPEC_INVALID` (`details.reason = private_upstream`). At `false` the portal also **resolves** every other upstream hostname (A + AAAA, ~5 s) and refuses it if any answer is private, or if the name cannot be resolved at all (`details.reason = unresolvable_upstream`) — so **the Nexus process must be able to resolve public DNS**, or nothing publishes. `true` skips all of it, including the lookup. Set `true` only for a portal that fronts internal services — and for local development, where the upstream is `host.docker.internal`. See [`security.md`](security.md#1-threat-model). |
| `NEXUS_WEB_DIST`                      | _(unset)_                                    | Directory of the built SPA to serve. When unset, the server looks for `../../web/dist` relative to itself and then `./web/dist` under the CWD; if neither has an `index.html`, static serving is disabled and only the API is exposed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `NEXUS_BOOTSTRAP_TOKEN`               | _(unset)_                                    | Secret the founding registration must present to become the portal's `super_admin` (see [First run](#first-run-and-the-bootstrap-token)). Minimum 16 characters when set; generate with `openssl rand -hex 32`. When unset the server generates one **per process** and prints it at `warn` while the portal has no active super admin — so set it for any deployment running more than one instance. Ignored once an active `super_admin` exists.                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Database

| Variable                    | Default               | Notes                                                                                    |
| --------------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `NEXUS_DB_DRIVER`           | `sqlite`              | `sqlite` \| `postgres` \| `mysql` \| `mongodb`.                                          |
| `NEXUS_DB_URL`              | _(empty)_             | **Required for every driver except sqlite** — startup fails without it.                  |
| `NEXUS_SQLITE_PATH`         | `./data/nexus.sqlite` | sqlite only. `:memory:` is honoured (tests). The parent directory is created if missing. |
| `NEXUS_DB_ALLOW_STANDALONE` | `false`               | MongoDB only. See [MongoDB](#mongodb) — do not set this in production.                   |

### Ferrum Edge integration

| Variable                           | Default                 | Notes                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FERRUM_ADMIN_URL`                 | `http://127.0.0.1:9000` | Base URL of the **Admin** API (not the proxy listener). Must be absolute `http://` or `https://`; a trailing slash is stripped. Plaintext `http://` to a **non-loopback** host is refused unless `FERRUM_ADMIN_ALLOW_INSECURE_HTTP=true`.                                                                                                                                                        |
| `FERRUM_ADMIN_JWT_TTL`             | `60`                    | Admin JWT lifetime in seconds, 5 – 3600. Edge caps it at 3600. Short is correct — tokens are minted per call and cached.                                                                                                                                                                                                                                                                         |
| `FERRUM_ADMIN_JWT_ISSUER`          | `ferrum-edge`           | The `iss` claim. **Must equal the gateway's configured issuer** or every call is rejected.                                                                                                                                                                                                                                                                                                       |
| `FERRUM_ADMIN_JWT_AUDIENCE`        | _(unset)_               | Only set when the gateway configures an audience. An unexpected `aud` claim is rejected by the gateway, so Nexus omits it entirely by default.                                                                                                                                                                                                                                                   |
| `FERRUM_NAMESPACE`                 | `nexus`                 | Namespace Nexus manages, sent as `X-Ferrum-Namespace` on every call. Must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, ≤ 254 chars. Also becomes the first segment of every listen path (`/<namespace>/<slug>`).                                                                                                                                                                                        |
| `FERRUM_GATEWAY_PUBLIC_URL`        | _(unset)_               | Public origin of the gateway's **proxy listener** — where clients send API traffic. Absolute `http(s)` origin, no path/query/credentials; a trailing slash is stripped. Feeds each API's `invoke_url` in the catalog. Distinct from `FERRUM_ADMIN_URL` (control plane) and `NEXUS_PUBLIC_URL` (the portal). The `gateway.public_url` setting overrides it; with neither, `invoke_url` is `null`. |
| `FERRUM_ADMIN_CA_FILE`             | _(unset)_               | Path to a PEM CA bundle for a TLS-protected Admin API. An unreadable file fails startup.                                                                                                                                                                                                                                                                                                         |
| `FERRUM_ADMIN_ALLOW_INSECURE_HTTP` | `false`                 | Permits plaintext `http://` Admin URLs on non-loopback hosts. Container-network-only deployments are the intended use.                                                                                                                                                                                                                                                                           |
| `FERRUM_ADMIN_TIMEOUT_MS`          | `5000`                  | Per-request deadline for Admin API calls, 250 – 60 000.                                                                                                                                                                                                                                                                                                                                          |
| `FERRUM_MAX_CREDENTIALS_PER_TYPE`  | `2`                     | 1 – 10. **Mirror of the gateway's own setting** — set them to the same value. Values above 1 are what make append-then-delete rotation gapless.                                                                                                                                                                                                                                                  |
| `FERRUM_RATE_LIMIT_SYNC_MODE`      | `local`                 | `local` \| `redis`. Where Edge keeps the counters of every consumer quota Nexus publishes. See the warning below — `local` counters are **per gateway process**.                                                                                                                                                                                                                                 |
| `FERRUM_RATE_LIMIT_REDIS_URL`      | _(unset)_               | **Required when `FERRUM_RATE_LIMIT_SYNC_MODE=redis`.** Must be `redis://` or `rediss://`; startup fails otherwise. Ignored (and not written to any plugin config) in `local` mode.                                                                                                                                                                                                               |
| `FERRUM_RATE_LIMIT_REDIS_TLS`      | `false`                 | Upgrade a `redis://` endpoint to TLS. `rediss://` already implies it. CA verification uses the gateway's own `FERRUM_TLS_CA_BUNDLE_PATH`.                                                                                                                                                                                                                                                        |

> **⚠️ Consumer quotas are enforced per gateway process.**
>
> Edge's `rate_limiting` plugin keeps its counters in the memory of the process
> that served the request unless the plugin config names a Redis endpoint. A
> portal in front of **N** data-plane replicas therefore enforces **N × the
> quota** a provider chose: an API limited to 1000 requests a minute answers up
> to 1000 a minute _on each replica_. Nothing in the portal, the provider's
> form, or the gateway reports this — the numbers simply do not add up in
> production.
>
> Setting `FERRUM_RATE_LIMIT_SYNC_MODE=redis` with an endpoint makes Nexus
> stamp `sync_mode`, `redis_url` and `redis_tls` onto every `rate_limiting`
> config it writes, so all replicas share one counter. There is no
> gateway-level environment variable for this: the endpoint is part of each
> plugin config, which is why the switch lives here.
>
> **Changing the mode applies to rate limits saved afterwards.** It rewrites
> nothing that already exists — an already-published API picks the new mode up
> the next time its rate limit is saved (any `PATCH /api/apis/:id` carrying a
> `rate_limit`, including re-saving the same numbers from the Settings tab).
> After flipping the switch on a live portal, re-save the rate limit of every
> API you care about, or accept that older APIs stay on per-process counters.

#### Set on the gateway, not on Nexus

Two gateway-side variables change what Nexus can successfully publish, so they
belong in the same checklist even though Nexus never reads them:

| Variable (on Ferrum Edge)       | Notes                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FERRUM_ADMIN_JWT_SECRET`       | Must equal Nexus's own value exactly. This shared secret is the whole trust relationship; a mismatch makes every Admin API call `401`.                                                                                                                                                                    |
| `FERRUM_BASIC_AUTH_HMAC_SECRET` | At least 32 bytes. The key the gateway HMACs Basic-auth passwords with. **Required before any `basic_auth` API is published** — without it the gateway refuses to construct the plugin and the publish fails with `EDGE_ERROR`; the gateway's own message is passed through in `details.gateway_message`. |

#### Multi-tenant gateways (`FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM`)

Every admin JWT Nexus mints carries `ns` set to `FERRUM_NAMESPACE`, in the
single-string form. There is nothing to configure.

By default Edge treats admin tokens as **global**: `X-Ferrum-Namespace` is a
routing selector, not an authorization boundary, and any valid token can address
any namespace. A gateway started with
`FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true` — the right setting for a control
plane fronting several tenants — instead requires the token's `ns` claim to
authorize the requested namespace on `/proxies`, `/consumers`,
`/plugins/config` and friends, and answers `403` to a token that carries no
`ns` at all. Because Nexus always stamps it, both configurations work with no
change on the portal side; just make sure `FERRUM_NAMESPACE` names a namespace
the gateway has granted this portal.

A malformed claim (an empty or non-string entry) is rejected by Edge at
authentication time whether or not the flag is on, so an empty
`FERRUM_NAMESPACE` fails at signing time rather than producing a token the
gateway will reject.

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

### Abuse controls

Two settings bound what one semi-trusted account can consume. Registration may
be open, and a `provider` who signs themselves up can allocate gateway proxies,
plugin configs, consumers, credentials, listen paths and stored documents — so
neither is optional on an internet-facing portal.

**A per-account API quota** — `NEXUS_MAX_APIS_PER_OWNER`, default `50`, `0` for
unlimited. A publish is refused with `429 QUOTA_EXCEEDED` when the account
already owns that many, **before the first Ferrum Edge write**, so a refusal
costs nothing and leaves nothing to roll back. The body carries
`details: { limit, current, setting }` so a provider can see what to remove and
support can see what to raise.

- It counts what the account **currently owns**. Deleting an API frees its slot
  at once. _Retiring_ one does not: a retired API keeps its proxy, its plugins
  and its grants on the gateway, which is the point of the retired state.
- It applies to administrators too. Anyone who can hit the limit can also raise
  it or delete something; an exemption would only help a compromised admin
  account.
- Together with `NEXUS_SPEC_HISTORY_LIMIT` it bounds **aggregate spec
  storage**. Each document is capped at `MAX_SPEC_BYTES` (2 MiB) and each API
  keeps its current revision plus that many historical ones, so one account's
  stored specs cannot exceed
  `MAX_SPEC_BYTES × (NEXUS_SPEC_HISTORY_LIMIT + 1) × NEXUS_MAX_APIS_PER_OWNER` —
  1.1 GiB at the defaults of 10 and 50. Multiply by your expected provider count
  when sizing the database, and lower the history limit if that is too much:
  the count quota alone bounds nothing, because one API can be revised in a
  loop.
- The check and the row creation run under an **in-process** per-owner lock, so
  a burst of concurrent publishes from one account cannot each read the count
  before any of them writes. Across N Nexus instances the lock does not span
  processes, so a simultaneous burst can overshoot by at most **N − 1** APIs.
  That is bounded and self-correcting — the next publish on each instance sees
  the true count — and is the reason the quota is a ceiling rather than a
  billing boundary.

**Bounded spec revision history** — `NEXUS_SPEC_HISTORY_LIMIT`, default `10`,
minimum `1`. After a spec revision is made current, every non-current revision
of that API beyond the newest N is deleted.

- The pruning runs **in the same transaction** that makes the new revision
  current, so a revision that is rolled back prunes nothing, and the previous
  current revision — the one a failed gateway write restores to — is always the
  newest historical row and is therefore always kept.
- The current revision is never a candidate, whatever the limit says.
- A deployment upgrading with a long accumulated history trims up to 1000 rows
  per API per revision, so a very old API converges over its next few uploads
  rather than blocking one request on a huge delete.
- `api.spec_update` audit rows carry `pruned_revisions`.

**A per-account rate limit** on the mutating publishing routes — `POST /`,
`PUT /:id/spec`, `PATCH /:id`, `DELETE /:id`, `PUT|DELETE /:id/plugins/:name`
and `POST /:id/test-consumer` under `/api/apis` — at **30 requests per minute**,
answering `429 RATE_LIMITED`. Installed only when
`NEXUS_RATE_LIMIT_ENABLED=true`.

- Keyed on the **authenticated account**, falling back to `request.ip` for an
  anonymous request. An IP bucket would put a whole office behind one NAT into
  one allowance while letting a single account multiply its own by rotating
  source addresses.
- Reads are not limited, except `GET /:id/usage`, which keeps its own 30/min
  limit because it scrapes the gateway.
- The store is in-memory and therefore **per process**, exactly like the
  `/api/auth/*` limiter: with N instances the effective allowance is N × 30/min.
  Enforce the real limit at the proxy if that matters.

#### Messaging

Registration is open by default, so an authenticated account is not a trusted
one. Portal messaging is the surface where one cheap request costs the most:
every message durably writes a message row and an audit row, and a **platform
thread** (no `recipient_user_id`) fans an in-app notification and a queued email
out to _every_ active `admin` and `super_admin`. Three bounds cap that.

| Bound                            | Value                                         | Where                                       |
| -------------------------------- | --------------------------------------------- | ------------------------------------------- |
| `POST /api/threads`              | **10 per minute per account**                 | Fastify limiter, `NEXUS_RATE_LIMIT_ENABLED` |
| `POST /api/threads/:id/messages` | **30 per minute per account**                 | Fastify limiter, `NEXUS_RATE_LIMIT_ENABLED` |
| Messages per account             | **200 per rolling 24 h** (`0` = unlimited)    | `NEXUS_MAX_MESSAGES_PER_USER_PER_DAY`       |
| `message_received` email         | **1 per recipient per thread per 10 minutes** | Outbox idempotency key; not configurable    |

Notes an operator needs:

- **The limiters key on the account**, falling back to `request.ip` only for an
  anonymous request. Two colleagues behind one NAT do not share a bucket, and
  one account cannot buy itself more by rotating addresses. Counters are
  in-process, so N instances enforce N × the per-minute numbers — put the real
  burst limit at the proxy if you run more than one. The **daily budget** counts
  durable rows, so it is correct on every instance regardless.
- **Refusals write nothing.** A `429` from either bound leaves no message, audit,
  notification or outbox row. The limiter answers `RATE_LIMITED`; the budget
  answers `QUOTA_EXCEEDED` with `details: { limit, window, setting }`.
- **Admins are subject to the daily budget too.** An account that legitimately
  needs more than a few hundred messages a day is an integration, not a person;
  raise `NEXUS_MAX_MESSAGES_PER_USER_PER_DAY` deliberately rather than carving
  out a role.
- **Direct and platform threads share one budget** — it counts the sender, not
  the thread, so opening a new conversation is not a fresh allowance.
- **The coalescing window is why the `message_received` mail no longer quotes a
  message.** Only the first message in each 10-minute window sends anything, so
  the default template announces activity and links to the thread. In-app
  notifications stay one per message. If an admin edits that template back to
  quoting `{{message_preview}}`, the quote will be of whichever message opened
  the window — the rest are silent.

### Test-only

Not read by `config/index.ts`; consumed directly by the cross-adapter smoke
test: `NEXUS_TEST_POSTGRES_URL`, `NEXUS_TEST_MYSQL_URL`,
`NEXUS_TEST_MONGO_URL`. See [`contributing.md`](contributing.md).

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`. An empty
string is treated as "unset" everywhere, so `FOO=` in an env file means the
default applies.

### First run and the bootstrap token

While the portal has no active `super_admin`, the next registration becomes
one, so that registration is authenticated out of band: it must present the
bootstrap token. The account, its role and the `bootstrap.super_admin_claimed`
record are written in **one transaction, under the cross-instance super-admin
lock**, so a founding registration either produces a seated super admin or
leaves nothing behind — there is no half-created state to clean up.

- **`NEXUS_BOOTSTRAP_TOKEN` set** — that value is the token. Minimum 16
  characters; startup fails on a shorter one. It is never written to the log.
- **Unset** — the server generates a 32-byte random token for the process, and
  prints it at `warn` **only if the user table is empty** once migrations have
  run:

  ```text
  ============================================================================
  FIRST-RUN BOOTSTRAP: this portal has no super_admin yet.

  The next registration becomes the portal super_admin, so it must send
  this bootstrap token as `bootstrap_token` (the sign-up form asks for it):

      9f1c…64 hex characters…

  It was generated for this process only: it changes on every restart and
  differs between instances. Set NEXUS_BOOTSTRAP_TOKEN to pin one value
  across restarts and across a multi-instance deployment.
  ============================================================================
  ```

Operational consequences:

- **Multi-instance deployments must set the variable.** A generated token is
  per process, so N instances print N different tokens and only the instance
  that happens to answer the registration accepts its own.
- **A restart invalidates a generated token.** Bootstrap in the window between
  starting the server and restarting it, or pin the variable.
- **Nothing consumes the token.** It stays valid until an active super admin
  exists, at which point the field is ignored entirely — the seat is decided
  under the super-admin lock, and `bootstrap.super_admin_claimed` records who
  took it.
- `GET /api/branding` reports `bootstrap_required: true` while the portal has
  no active super admin; that is how the sign-up form knows to ask. It reveals
  only that the seat is open, never the token.

### Recovering a portal with no super admin

Before the founding registration became atomic, a failure between creating the
first account and promoting it — a database blip, a crash — left a portal with
accounts but no `super_admin`, and because "bootstrap" then meant "no
accounts", the flow above could not reach it. The condition is now "no active
`super_admin`", so the same flow recovers such a portal, and only the token can
drive it: ordinary registration is refused with `403 FORBIDDEN` until an
administrator has been seated. To recover:

1. **Confirm the state.** `GET /api/branding` answers with
   `bootstrap_required: true` even though accounts exist. (Directly against the
   database: no row in `users` has `role = 'super_admin'` and
   `status = 'active'`.)
2. **Have a token.** If `NEXUS_BOOTSTRAP_TOKEN` is set, use it. If not, restart
   one instance: the startup banner is printed whenever the portal has no
   active super admin, not only when it is empty, and that process accepts the
   token it printed.
3. **Register through the sign-up form** (or `POST /api/auth/register`) with a
   **new** email address and the token. That account is seated as a verified
   `super_admin`; existing accounts are left exactly as they were, including
   the one the failed attempt created — recovery adds an administrator, it does
   not promote whoever happened to be first. A stale
   `bootstrap.super_admin_claimed` record from the failed attempt is replaced.
4. **Verify.** `bootstrap_required` is now `false`, and the new account can
   sign in and manage users, so it can promote or remove the stranded account
   as appropriate.

No database surgery is involved, and nothing here lets a portal that already
has a super admin mint another one: with a seated administrator the token is
inert and registration follows the ordinary policy.

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
  queue, and while one is open every store call from outside it — another
  request, a worker tick — waits on that queue until it commits or rolls back.
  Bodies are short (pure database work), so the wait is microseconds, but it
  means a request is never told its write succeeded while an unrelated
  transaction could still roll it back. Only one process may write. Do not
  point two Nexus instances at the same file, and do not put it on NFS.

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

# Note `127.0.0.1:` on the published port. The image binds 0.0.0.0 inside the
# container, so a bare `-p 8787:8787` offers the portal on every host
# interface — including before anyone has registered, which is exactly when an
# unbootstrapped portal is at its most interesting to a stranger. Publish on
# loopback and put your TLS terminator in front of it (see §4).
docker run --rm -p 127.0.0.1:8787:8787 \
  -e NEXUS_SECRET_KEY="$(openssl rand -hex 32)" \
  -e NEXUS_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)" \
  -e FERRUM_ADMIN_URL=http://host.docker.internal:9000 \
  -e FERRUM_ADMIN_JWT_SECRET=change-me-at-least-32-characters-long \
  -e NEXUS_PUBLIC_URL=https://portal.example.com \
  -v nexus-data:/app/data \
  ferrum-nexus
```

Drop `NEXUS_BOOTSTRAP_TOKEN` and the container prints a generated one on its
first start (`docker logs`); see
[First run](#first-run-and-the-bootstrap-token).

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
worker and is released back to `pending`. **That sweep runs at the top of every
tick**, before anything is claimed — so recovery belongs to whichever worker is
running, not to the next process boot. Doing it only at `start()`, as it used to
be, recovered nothing from the ordinary case: a process that crashes and comes
back inside the five-minute window finds its own rows too young for the one
sweep, and nothing ever looked at them again. The same sweep is what recovers a
row whose bookkeeping write failed after the claim, with no restart involved at
all.

Five minutes is safe because a claim's lifetime is bounded. Rows are claimed
**one at a time** rather than as a batch — a batch's last row would otherwise
sit `sending` for as long as every row ahead of it — and one delivery cannot run
past about 50 seconds, because Nexus pins nodemailer's timeouts (10 s to
connect, 10 s for the greeting, 30 s of socket inactivity) rather than taking
its 2 min / 30 s / 10 min defaults. If you raise those, raise the threshold with
them.

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
older than ~10 minutes, which is two stale-sweep intervals and therefore means
the worker is not ticking at all.

The worker logs `Outbox message delivery failed, retrying later`,
`Outbox message failed permanently`, `Released stale outbox claims`,
`Outbox message was abandoned mid-flight; it is recovered by the stale sweep`,
`Could not release stale outbox claims` and `Outbox tick failed` at `warn`.
`Released stale outbox claims` carries a `released` count; a steady trickle of
it means messages are being re-queued after somebody's crash, and a duplicate
may have gone out.

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

### What rotation does and does not affect

`readEncryptedSetting` catches a decryption failure and returns `null`, so a
row written under the old key reads as _absent_ after a plain key swap — and
that is not harmless:

- SMTP falls back to the `NEXUS_SMTP_*` environment values; without a password
  there, authenticated relays reject mail and the outbox fills with `failed`
  rows.
- CAPTCHA **fails closed**: `captcha.verify` throws
  `CAPTCHA_FAILED — "CAPTCHA is enabled but not fully configured"`, so
  registration **and login** stop working. On a CAPTCHA-enabled portal a bare
  key swap therefore locks every administrator out before anyone can re-enter
  the secret.

That is why the rotation is a two-key, offline step: `npm run rotate-secret-key`
re-encrypts every `app_settings` row with `encrypted = 1` from the previous key
to the new one, in one transaction, and refuses to write anything if a single
row does not open under the previous key. Both keys come from the environment
(never from arguments, so neither lands in a shell history or a process list),
and the command prints only counts and setting _names_.

Every live session and every unused email-verification token is still
invalidated by a rotation, because their stored hashes were computed under the
old HMAC key; password sign-in is unaffected.

### Procedure

1. **Announce a short window.** Everyone will be signed out.
2. Back up the database (see [§5](#5-backups)) and record the current
   `NEXUS_SECRET_KEY` — it is your rollback.
3. **Stop every Nexus instance** (or run the step against a database no
   instance is using). A running server would keep writing blobs under the old
   key while you rotate.
4. Re-encrypt the settings with both keys in the environment. With a `.env`
   file, `NEXUS_SECRET_KEY` is read from it; put the previous key in the shell:

   ```bash
   export NEXUS_SECRET_KEY_PREVIOUS="<the key the database was last written with>"
   export NEXUS_SECRET_KEY="$(openssl rand -hex 32)"     # or the value now in .env
   npm run rotate-secret-key
   # Re-encrypted 2 setting(s) under the new NEXUS_SECRET_KEY (captcha.secret_key, smtp.password); …
   ```

   The command exits non-zero and changes nothing if the previous key is wrong,
   if the two keys are equal, or if it has already been run.

5. Start the server with the new `NEXUS_SECRET_KEY` (and without
   `NEXUS_SECRET_KEY_PREVIOUS`).
6. Verify as a **super admin** (SMTP and CAPTCHA settings are super-admin-only):
   sign in — with CAPTCHA on, this is the proof the secret survived — then
   **Send test email** on the settings page returns `ok: true`.
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

**Rollback** is the same command with the keys swapped (`NEXUS_SECRET_KEY_PREVIOUS`
= the new key, `NEXUS_SECRET_KEY` = the old one), run before the server has
re-saved anything under the new key; then restart with the old key.

**If you cannot run the command** (for example a hosted database you can only
reach through the running portal), a super admin can avoid the lockout by
hand: disable CAPTCHA in **Admin → Settings** _before_ the swap, swap the key
and restart, sign in with a password, re-enter the SMTP password and the
CAPTCHA secret, then re-enable CAPTCHA and verify a sign-out/sign-in round
trip. Do not "fix" the lockout by making CAPTCHA fail open.

### Rotating `FERRUM_ADMIN_JWT_SECRET`

Different problem, simpler shape: it is a shared secret between two processes,
not an encryption key. Change it on the gateway and on Nexus, then restart
both. Between the two restarts every Admin API call fails with
`502 EDGE_ERROR — "The gateway rejected the Nexus admin credentials"`; browsing
the catalog and reading the portal keep working, but publishing, approvals and
credential operations do not. Nothing at rest is affected.

---

## 8. Scaling

### How gateway writes are coordinated

`PUT /consumers/{id}` and `PUT /proxies/{id}` on the Ferrum Edge Admin API are
whole-resource replaces with **no concurrency token**. Every Nexus mutation of
either is therefore a read-modify-write — `GET`, change a field, `PUT` the whole
document back — and two of those interleaving lose one of the changes outright.
What that costs is not an inconvenience:

- Two operations on the same **consumer** (a revocation and an approval, say)
  both read `[A]`; the revocation writes `[]` and the stale approval writes
  `[A, B]`. Nexus records A as revoked and the gateway keeps authorising it.
- Two operations on the same **proxy** (an auth-method change and a plugin
  change) both read the old plugin list; whichever writes last drops the
  other's entry. A published API can end up with no authentication plugin
  attached while the portal reports one.

Nexus reduces this risk with two layers:

1. **An in-process queue** per resource (`edge.serializePerKey`). Fast, and it
   is what orders two requests that land on the same instance.
2. **A lease row in the `edge_leases` table**, taken inside that queue. This
   normally orders _instances_ against each other. One row per resource — a
   Ferrum consumer id, or `proxy:<id>` — holding the id of the instance that
   owns it and an expiry.

Every code path that **rewrites** a gateway resource takes the same key for it,
which is what makes the lock mean anything: approvals and revocations,
credential issue/rotate/revoke, the disable-account teardown, backend and
runtime-setting changes, first-class and palette plugin changes, and the
rollback steps that undo them all funnel through one key per consumer and one
per proxy.

The exceptions are the whole-lifecycle operations that **create or destroy** a
proxy rather than editing one — publishing a new API, unpublishing it, and the
delete-and-recreate that switches OpenAPI enforcement mode. Those are not
lease-guarded, so an unpublish racing a plugin edit on the same API can still
leave an orphaned plugin config behind. They cannot lose an _authentication_
plugin the way an edit-versus-edit race could, because the proxy they race with
is being removed outright; treat them as operations to do when nobody else is
editing the same API.

The numbers:

| Setting               | Value             | Meaning                                            |
| --------------------- | ----------------- | -------------------------------------------------- |
| Lease TTL             | 60 s              | How long a held lease stays valid without renewal. |
| Renewal interval      | 30 s              | A long operation extends its own lease at TTL/2.   |
| Wait before giving up | 30 s              | How long a blocked operation waits for the lease.  |
| Poll interval         | 100 ms (jittered) | How often a waiter retries.                        |

**A crashed instance is not a deadlock.** Nothing has to notice the crash and
nothing has to be unlocked by hand: the lease simply stops being renewed, and
the next instance that wants the resource takes it over once the expiry passes
— at most 60 seconds later. `edge_leases` needs no maintenance; rows are
deleted on release, and an orphan is overwritten rather than accumulating.

**What a user sees under contention.** A request that could not get the lease
inside 30 seconds fails with `409 CONFLICT` and the message _"Another portal
instance is updating this gateway resource right now — please retry"_. Nothing
was written, so retrying is safe and is the correct advice. Seeing this
routinely means something is holding a gateway resource for tens of seconds —
look for a slow or hanging Edge Admin API rather than for a Nexus bug.

The lease is **not a fencing token** understood by Ferrum Edge. If a holder is
paused beyond the TTL, loses ownership during a failed renewal, or calculates
an expiry from a sufficiently skewed host clock, it can resume after another
instance has acquired the lease. Edge cannot reject that stale holder's later
`PUT`. Renewal makes this overlap unlikely during normal operation, but it does
not make concurrent gateway writers safe.

### The same table guards the last super admin

`edge_leases` is not only for gateway resources. One database invariant needs
the same treatment, for the same reason: **the last active `super_admin`**.

The rule is a count of the _other_ active super admins followed by a write to
one account. A database transaction makes those two steps atomic against other
work on the same connection pool, and that is enough for one process — but a
multi-instance deployment has one pool per instance, and two of them counted
one another's administrator and both demoted. The portal was then left with no
account able to restore the role, recoverable only by editing the database.

So every transition that can _shrink_ the set — a role change away from
`super_admin`, a `status: "disabled"`, and god mode's `disable-user` — runs
under one shared key, `users:super-admins`, taken before the transaction opens.
The loser waits, re-counts after the winner committed, and gets the ordinary
`409 LAST_SUPER_ADMIN` with nothing written. Promotions and re-enables take no
lock; they only ever grow the set.

Operationally this behaves like any other lease: same TTL, same 30-second wait,
same crash recovery. Contention is a single key portal-wide, so a `CONFLICT`
carrying _"Another administrator change is in flight right now"_ means two
admins edited administrator accounts within the same instant — rare, and safe
to retry.

### Supported topologies

> **Run exactly one active Nexus instance that can perform gateway mutations.**

One instance is the simplest supported topology. An active/passive deployment
is also supported provided only one instance serves requests at a time. Do not
use sticky routing as a substitute: operations initiated by different actors
can still target the same consumer or proxy, and a lease that expires cannot
fence the former holder from Edge.

Standby instances must not serve requests or run gateway-mutating background
work until promoted. Active/passive instances need one shared **PostgreSQL,
MySQL or MongoDB replica-set** database. SQLite cannot be shared, so a SQLite
deployment is a single instance by definition.

### Other multi-instance notes

- **The outbox and the teardown poller are safe to run on several instances.**
  The claim is an atomic `pending → sending` flip, so no row is worked twice,
  and the stale sweep every tick runs means one instance recovers another's
  abandoned claims without waiting for that instance to come back.
- **Sessions live in the database**, not in memory, so any instance can serve
  any session. No sticky sessions needed for auth.
- **The auth rate limiter is per-process** (`@fastify/rate-limit` with the
  default in-memory store). With N instances the effective limit is N × 20/min.
  Enforce the real limit at the proxy if that matters.
- **The admin-JWT cache is per-process.** Harmless — it just means each
  instance mints its own tokens.
- **The bootstrap token is per-process when generated**, which is not harmless:
  set `NEXUS_BOOTSTRAP_TOKEN` so every instance accepts the same one. See
  [First run](#first-run-and-the-bootstrap-token).
- **The gateway metrics/health cache is per-process** (10 seconds per proxy).
  Also harmless: two instances may answer a usage query from snapshots up to
  ten seconds apart.
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

**Which one to point at what.** A container **liveness** probe should use
`GET /api/health` and key on the HTTP status code alone — `503` means the
database is gone and the process should be replaced; `200` covers both `ok` and
`degraded`. A **readiness monitor** or dashboard should use `GET /api/health`
too and read the body, so a `degraded` shows up as a gateway alert rather than
a portal outage. `GET /api/health/edge` is for a monitor that watches the
gateway specifically: it skips the database query and always answers `200`, so
it is a signal, never a probe you can fail a container on.

**Treat `degraded` as healthy for load-balancing purposes.** The overall status
is `down` only when the database probe fails; an unreachable gateway yields
`degraded` with `edge.status: "down"`, and the right response is to keep the
portal in rotation — the catalog, messaging and audit log all still work while
the gateway recovers. Publishing, approvals and credential operations will
return `502 EDGE_UNAVAILABLE` until it comes back.

**The probes behind these endpoints are cached and rate limited.** Both routes
are unauthenticated, and each request used to cost a database query plus a
signed Ferrum Edge Admin API call — an amplifier that let anonymous traffic set
the load on the two dependencies the portal cannot lose. Two things bound it:

- **A shared probe.** Each dependency is probed at most once per
  `NEXUS_HEALTH_CACHE_MS` (default `5000`) and concurrent callers share the one
  in-flight probe, so a burst of a thousand requests produces one database query
  and one Admin API call. A failing probe is cached for the same window, so a
  recovery can take up to the TTL to show — set the TTL below your probe
  interval (the default 5 s sits comfortably under a 10–30 s interval).
  `checked_at` in the body reports when the probes actually ran, which is how
  you tell a cached answer from a fresh one. `NEXUS_HEALTH_CACHE_MS=0` disables
  the cache entirely.
- **A route-scoped limiter.** When `NEXUS_RATE_LIMIT_ENABLED=true`, `/api/health*`
  allows **120 requests per minute per client IP** and answers `429`
  `RATE_LIMITED` beyond that. That is one probe every half second — well clear
  of a load balancer, a container healthcheck and a monitoring scraper running
  together, and it applies to the _client IP_, so set `NEXUS_TRUSTED_PROXIES`
  correctly or every probe arriving through your load balancer shares one
  bucket. The `/api/auth` limiter (20/min) is separate and neither budget spends
  the other's.

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
(`Ferrum Edge Admin API returned an error`). For a `400`, `409` or `422` — the
gateway validating the caller's own request — the same text is echoed to the
caller in `EDGE_ERROR.details.gateway_message`; for `401`/`403` and every `5xx`
it is deliberately **only** in the log, so this is where you look when a
provider reports an unexplained `EDGE_ERROR`.

### Shutdown

`SIGINT`/`SIGTERM` trigger a graceful shutdown: the outbox and gateway-teardown
pollers stop, the Edge dispatcher closes, Fastify drains, then the store closes.
Give the container at least a few seconds of termination grace. Anything a
poller had claimed and did not finish is picked up by the stale sweep at the top
of some worker's next tick — this instance's after a restart, or another
instance's straight away — five minutes after the claim.

---

## 10. Metrics

**Nexus is not a metrics system.** It stores no time series, runs no scraper and
retains no history. What it does is read the gateway's own telemetry on demand
so a provider can see it next to their API.

### Nexus emits nothing; point Prometheus at Edge

There is no `/metrics` endpoint on the Nexus server. Traffic metrics belong to
the data plane, and the data plane is Ferrum Edge:

- **`GET /metrics`** on the gateway — Prometheus exposition. The two families
  that matter for per-API traffic are `ferrum_requests_total{proxy_id, method,
status_code, grpc_status, error_class, namespace}` and the
  `ferrum_request_duration_ms{proxy_id, le, namespace}` histogram. It also
  carries everything else the gateway measures.
- **`GET /admin/metrics`** on the gateway — a JSON snapshot: circuit breakers,
  health-check state, connection pools, cache and rate-limiter counters.

Both are **gated by default**. A scrape needs an admin JWT, a matching
`FERRUM_METRICS_BEARER_TOKEN`, or a source address inside
`FERRUM_METRICS_ALLOWED_CIDRS`. For Prometheus, prefer the bearer token or the
CIDR allow-list over handing the scraper an admin credential:

```yaml
scrape_configs:
  - job_name: ferrum-edge
    scrape_interval: 15s
    metrics_path: /metrics
    static_configs:
      - targets: ['ferrum-edge:9000']
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/ferrum-metrics-token
```

Correlating a dashboard back to a portal API is the `proxy_id` label: it is the
`ferrum_proxy_id` on the Nexus `apis` row, shown as **Edge proxy id** on the API
detail page.

Grafana, alerting rules and retention all live on that side. Nothing about this
is configured in Nexus.

### What Nexus shows, and its cache

`GET /api/apis/:id/usage` (the provider's **Usage** card) reads both gateway
endpoints for one proxy and reshapes them: request counts by status class and
method, the `429`/`401`/`403` totals, interpolated p50/p95/p99 latency, and a
backend verdict derived from the proxy's circuit breaker and any ejected target.

| Layer   | Cache                                               |
| ------- | --------------------------------------------------- |
| Edge    | 5 s, on its own rendering of both endpoints         |
| Nexus   | 10 s, in-process, **per proxy**, per server process |
| The SPA | refetches every 30 s while an API page is open      |

So a figure on the card can be up to about 15 seconds behind reality, and a
horizontally scaled Nexus keeps one cache per process — two browser tabs served
by different instances may briefly disagree. Neither matters for a diagnostic
read; both would matter if you tried to bill from it, which is why you should
not.

Operational consequences worth knowing:

- **A scrape is one HTTP GET per proxy per 10 s**, at worst. Edge's own 5-second
  cache absorbs the rendering cost, so the load is a request, not a computation.
- **The route never returns 5xx for a gateway problem.** An unreachable,
  erroring or unparseable gateway produces `200` with `available: false`. The
  failure is logged at `warn` by the Edge client (`Ferrum Edge metrics scrape
could not reach the gateway`, `… returned a non-2xx status`, `… produced no
parseable samples`), so **the log is where a metrics outage shows up**, not
  the HTTP status.
- **Counters are cumulative since the gateway process started.** A gateway
  restart zeroes every provider's card. This is Edge's model, not a Nexus bug;
  the card says so, and `gateway_uptime_seconds` says how far back the numbers
  reach.
- **There is no per-consumer attribution anywhere in this path**, because
  `ferrum_requests_total` carries no consumer label. If someone needs "which
  client burned the quota", that is an Edge access-log question, not a portal
  one.

---

## 11. Gateway revocation for disabled accounts

Disabling a portal account has a second half that lives on Ferrum Edge: every
ACL group off the account's consumer, every credential of every type deleted.
That half is an HTTP call to another system, so it cannot commit with the
database write — and a disabled account's API key keeps authenticating against
the data plane for as long as it is not made, with no portal session involved.

So the disable writes a `gateway_teardown_jobs` row **in the same transaction**
as `users.status = 'disabled'`, attempts the revocation immediately, and — when
Edge refuses — leaves the job for the teardown worker rather than reporting the
disable as finished. See
[`security.md`](security.md#disabling-an-account) for the security argument.

### Statuses

| Status    | Meaning                                                                    |
| --------- | -------------------------------------------------------------------------- |
| `pending` | Owed and due (or waiting for `next_attempt_at`). **Credentials are live.** |
| `sending` | Claimed by a worker. The claim is atomic and increments `attempts`.        |
| `done`    | Edge confirmed the revocation; `completed_at` says when.                   |

There is **no terminal failure state**. Retries back off `10s · 2^attempts`,
capped at five minutes, plus up to 10% jitter, and continue for as long as the
account is disabled — an outbox message nobody can deliver is a lost email, but
a credential nobody revoked is a live security hole. The only other exit is the
account being re-enabled, which deletes the job.

A `sending` row untouched for five minutes is released back to `pending` at the
top of **every** tick, exactly as in the outbox
([§6](#6-the-email-outbox)) — not once per process boot, which left a crashed
worker's claim stranded and the account's credentials live indefinitely. Jobs
are claimed one at a time, and one job is five Edge round trips bounded by
`FERRUM_ADMIN_TIMEOUT_MS` (5 s by default) plus at most a 30-second wait for the
consumer's lease — about 55 seconds — so five minutes leaves ample headroom.
Raising `FERRUM_ADMIN_TIMEOUT_MS` towards its 60-second ceiling pushes that
worst case towards 5.5 minutes; raise the threshold with it. Recovery is safe to
repeat in any case: the revocation is a clear-and-delete, and the consumer's own
Edge lease keeps two instances from running it at the same instant.

There is one row per account (`user_id` is unique), so re-disabling an account
resets the outstanding job rather than queueing a second revocation.

### Monitoring

```sql
-- how much revocation is owed right now
SELECT status, count(*) FROM gateway_teardown_jobs GROUP BY status;

-- what is stuck, and why
SELECT user_id, attempts, last_error, next_attempt_at, updated_at
  FROM gateway_teardown_jobs WHERE status <> 'done'
  ORDER BY updated_at DESC LIMIT 20;
```

`GET /api/users` (admin) also reports the portal-wide backlog as
`pending_gateway_teardowns`, and `GET /api/users/:id` carries the per-account
`gateway_teardown` state.

**Alert on this `warn` line:**

```
Gateway revocation for a disabled account failed; it stays queued for retry
```

It carries `user_id`, `attempts` and `error`. A single occurrence during an Edge
restart is expected; a line that keeps repeating for the same `user_id` means a
disabled account still holds working gateway credentials. The worker also logs
`Gateway revocation retry failed; the credentials are still live`,
`Gateway revocation for a disabled account completed`,
`Released stale gateway teardown claims`,
`Gateway teardown job was abandoned mid-flight; it is recovered by the stale sweep`,
`Could not release stale gateway teardown claims` and
`Gateway teardown tick failed`.

### Re-driving one by hand

`POST /api/users/:id/gateway-teardown/retry` (admin, CSRF) re-queues the job and
runs it immediately, returning `gateway_teardown: "ok"` when Edge accepted and
`"pending"` when it refused again. It is audited as
`user.gateway_teardown_retry`. In the SPA the same action is the **Retry**
button next to the _Gateway revocation pending_ badge on the admin **Users**
page. Do not edit the table by hand — the endpoint is idempotent and writes the
audit trail.

---

## 12. The credential mirror

Edge gives credential entries **no id**, and every read redacts the material, so
there is nothing on the wire that identifies one entry. What identifies it is
its position: `POST` appends, `DELETE /consumers/{id}/credentials/{type}/{i}`
removes by 0-based index, and Nexus writes one `credential_metadata` row per
append. Each row carries **`edge_ordinal`**, a strictly increasing counter per
consumer and credential type that the store assigns in the same statement as
the insert, under the same per-consumer lock as the Edge append. The non-revoked
rows for a `(consumer, type)` pair, ordered by ordinal, are a **mirror** of the
Edge array, and a row's position in that list is its index. Timestamps play no
part: two appends inside one millisecond, or a clock stepped backwards between
two appends, used to reorder the mirror and send a revoke to the wrong entry.

Every destructive call cross-checks that mirror against the live array length
read in the same critical section. Nexus itself can no longer break the
agreement — a rotation revokes the row it retired the moment Edge confirms the
delete, and an append whose row cannot be written is deleted again — so a
mismatch means the consumer was edited **outside Nexus**.

### What a drifted consumer looks like

Rotate or revoke returns `502 EDGE_ERROR`:

> The gateway credential list does not match the portal. An administrator must
> reconcile this consumer …

with `details: { expected, actual }` — `expected` is the number of live portal
rows, `actual` the length of the Edge array. The one case that is not an error
is a single live row: a revoke then degrades to deleting the whole credential
type, which is what a revoke asked for anyway.

### What an ambiguous legacy consumer looks like

Rows written before `011_credential_ordinal` have no ordinal of their own. The
migration numbers them from the old `(created_at, id)` sort where that sort was
unambiguous — no two live rows of the consumer and type share a timestamp — and
leaves the whole group `NULL` where it was not, because nothing on either side
can say which gateway entry is which. A lone unresolved row is still index 0
and works normally. Two or more make every rotate or revoke of them return
`409 CONFLICT`:

> The gateway position of this credential cannot be determined …

with `details: { consumer_id, credential_type, unresolved_credentials }`. New
credentials issued on the same consumer carry ordinals and are unaffected. To
find such rows ahead of time:

```sql
SELECT ferrum_consumer_id, credential_type, COUNT(*) AS unresolved
  FROM credential_metadata
  WHERE edge_ordinal IS NULL AND status <> 'revoked'
  GROUP BY ferrum_consumer_id, credential_type
  HAVING COUNT(*) > 1;
```

### Reconciling one

Edge is the side that authenticates, and it exposes neither an id nor the
material of an entry on read, so the only repair that needs no guessing is to
**empty the type and re-issue**. That is what the reconciliation endpoint does:

```http
POST /api/admin/credentials/reconcile
{ "consumer_id": "<edge consumer id>", "credential_type": "keyauth", "reason": "…" }
```

Inside the consumer's critical section it issues
`DELETE /consumers/{id}/credentials/{type}` on the gateway, moves every live
portal row for the pair to `revoked`, writes a `credential.reconcile` audit row
(with the optional `reason`) and notifies each affected account. The response
reports `revoked_credentials` and whether the gateway consumer still existed
(`gateway_cleared`). It is admin-only, idempotent, and destructive by design:
every live credential of that type on that consumer stops working.

Before running it, see what the portal thinks is live:

```sql
SELECT id, credential_type, last4, status, edge_ordinal, created_at
  FROM credential_metadata
  WHERE ferrum_consumer_id = '<edge consumer id>' AND status <> 'revoked'
  ORDER BY edge_ordinal;
```

Then tell the account holder to issue new credentials. The old secrets were
show-once and cannot be recovered from either side. Never leave a row `active`
for an entry that is gone: it will drift again on the next operation.

A failed rotation **at the cap** is not drift and needs none of this. The old
entry is deleted before the replacement is appended (there is no room for both),
so if the append fails the response says so plainly — _the previous credential
was removed … issue a new credential_ — the retired row is already `revoked`,
and everything still live remains revocable.
