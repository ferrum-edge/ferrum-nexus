# Operations

Deployment reference for Ferrum Nexus (current release: `v0.2.0`; first
supported release: `v0.1.0`): configuration, databases and upgrades, containers,
TLS, backup and restore, key rotation, the email outbox, scaling limits, health
checks, metrics and gateway recovery.

- Architecture background: [`architecture.md`](architecture.md)
- Security posture: [`security.md`](security.md)
- First-run walkthrough: [`getting-started.md`](getting-started.md)

---

## 1. Environment variables

[`server/src/config/index.ts`](../server/src/config/index.ts) is the only reader
of the server's environment. It validates everything with zod at startup; on any
invalid value the process prints every problem and exits non-zero. The repo-root
[`.env.example`](../.env.example) lists the same variables with the same
defaults.

General rules:

- Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`.
- An empty value means "unset", so `FOO=` in an env file gives you the default.
- Integers must be plain decimal digits within the stated range.

**Where the environment comes from.** The server and the CLIs (`npm run dev`,
`npm run migrate`, `npm run rotate-secret-key`) read a `.env` file from the
working directory or its parent. Workspace scripts run from `server/`, so the
repo-root `.env` is found either way. The real process environment is layered
**over** the file: an exported variable, or one set by a container runtime,
always wins. The path of the file is logged at startup; its contents never are.
A relative `NEXUS_SQLITE_PATH` resolves from `server/`.

**Environment overriding `.env`.** If `FERRUM_NAMESPACE` or `FERRUM_ADMIN_URL`
is set in the process environment to a different value than `.env`, startup
prints a banner naming the variable, both values and which one won:

```
============================================================================
ENVIRONMENT OVERRIDES .env: the exported value wins, not the file.

    FERRUM_NAMESPACE
        /srv/nexus/.env: nexus
        environment:  ferrum-foundry-demo   <-- wins
…
```

Outside production (`NEXUS_ENV` other than `production`) the server then
**refuses to start**, because a leftover `export` silently redirects every
publish. Fix it by `unset`ting the variable, by editing `.env` to agree, or, if
the override is deliberate, by setting `NEXUS_ALLOW_ENV_OVERRIDE=true`. In
production it only warns: the orchestrator's environment is the configuration
there.

**Vite dev server only.** The SPA half of `npm run dev` also reads the repo-root
`.env`. These variables are not part of the server schema and do nothing in a
production image:

| Variable                 | Default                   | Notes                                                                                                                                                                                       |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_WEB_PORT`         | `5173`                    | Vite listen port, 1–65535. Alias `VITE_DEV_PORT` (ignored when `NEXUS_WEB_PORT` is set). A taken port fails startup (`strictPort`).                                                         |
| `NEXUS_API_PROXY_TARGET` | derived from `NEXUS_PORT` | Absolute `http(s)` origin for the `/api` proxy (no path, query, credentials or fragment). Default `http://<NEXUS_HOST>:<NEXUS_PORT>`, with wildcard binds (`0.0.0.0`, `::`) as `127.0.0.1`. |

See the README for a two-stack example.

### Required

| Variable                  | Notes                                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_SECRET_KEY`        | At least 32 characters. Master secret: the settings-encryption key and the session-token HMAC key are HKDF-derived from it. Generate with `openssl rand -hex 32`. Change it only with the rotation procedure in [§7](#7-rotating-nexus_secret_key). |
| `FERRUM_ADMIN_JWT_SECRET` | At least 32 characters. Must equal the gateway's `FERRUM_ADMIN_JWT_SECRET`.                                                                                                                                                                         |

### Server

| Variable                                     | Default                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_ENV`                                  | from `NODE_ENV`, else `development`   | `development` \| `test` \| `production`. `test` turns rate limiting off and quietens the logger.                                                                                                                                                                                                                                                                                                                                                                     |
| `NODE_ENV`                                   | —                                     | Read only when `NEXUS_ENV` is unset; only `production` and `test` are honoured.                                                                                                                                                                                                                                                                                                                                                                                      |
| `NEXUS_HOST`                                 | `127.0.0.1`                           | Bind address. Use `0.0.0.0` in a container.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NEXUS_PORT`                                 | `8787`                                | 0–65535.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `NEXUS_PUBLIC_URL`                           | `http://127.0.0.1:5173`               | Public origin of the portal, used for links in email. Absolute `http(s)` URL with no credentials, query or fragment; a trailing slash is stripped.                                                                                                                                                                                                                                                                                                                   |
| `NEXUS_TRUSTED_PROXIES`                      | _(unset)_                             | Which proxies may set `X-Forwarded-For`. Unset trusts none, so `request.ip` is the socket address. Either a hop count `1`–`32` counted from the right of the header, or a comma-separated list of IPs/CIDRs (IPv4 prefix 1–32, IPv6 prefix 1–128) and the keywords `loopback`, `linklocal`, `uniquelocal`. Invalid entries fail startup. See [§4](#4-running-behind-tls-and-a-reverse-proxy).                                                                        |
| `NEXUS_TRUST_PROXY`                          | `false`                               | Deprecated. `true` means `NEXUS_TRUSTED_PROXIES=1`. Does not affect cookies or HSTS.                                                                                                                                                                                                                                                                                                                                                                                 |
| `NEXUS_COOKIE_SECURE`                        | `true` unless `NEXUS_ENV=development` | Marks `nexus_session` and `nexus_csrf` `Secure` and enables HSTS. Set `false` only when serving plain `http://`.                                                                                                                                                                                                                                                                                                                                                     |
| `NEXUS_LOG_LEVEL`                            | `info`                                | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `NEXUS_SESSION_TTL`                          | `43200` (12 h)                        | Sliding session idle lifetime in seconds, 60 – 2 592 000.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `NEXUS_CAPTCHA_ENFORCEMENT`                  | `enforced`                            | `enforced` \| `disabled`. The CAPTCHA break-glass switch; not settable through the API, and `0`/`false` are rejected. See [Recovering a portal locked out by CAPTCHA](#recovering-a-portal-locked-out-by-captcha).                                                                                                                                                                                                                                                   |
| `NEXUS_RATE_LIMIT_ENABLED`                   | `true`                                | Installs the per-route rate limiters listed under [Abuse controls](#abuse-controls). Forced off when `NEXUS_ENV=test`.                                                                                                                                                                                                                                                                                                                                               |
| `NEXUS_HEALTH_CACHE_MS`                      | `5000`                                | How long `/api/health` and `/api/health/edge` reuse a dependency probe, 0–60000. `0` disables the cache. See [§9](#9-health-checks).                                                                                                                                                                                                                                                                                                                                 |
| `NEXUS_HEALTH_PROBE_TIMEOUT_MS`              | `1500`                                | Deadline for the health route's Edge calls, 100–5000, independent of `FERRUM_ADMIN_TIMEOUT_MS`. Capped so it fits inside the image's 10-second healthcheck; if you override the orchestrator's probe timeout, keep it well above this plus database time.                                                                                                                                                                                                            |
| `NEXUS_BRANDING_CACHE_MS`                    | `5000`                                | How long `GET /api/branding` reuses its payload, 0–60000. `0` disables the cache. See [Branding](#branding).                                                                                                                                                                                                                                                                                                                                                         |
| `NEXUS_MAX_APIS_PER_OWNER`                   | `50`                                  | APIs one account may own, 0–100 000; `0` disables. See [Abuse controls](#abuse-controls).                                                                                                                                                                                                                                                                                                                                                                            |
| `NEXUS_MAX_APPLICATIONS_PER_OWNER`           | `20`                                  | Application identities (each one a gateway consumer) one account may own, 0–100 000; `0` disables. Exceeding it is `429 QUOTA_EXCEEDED`.                                                                                                                                                                                                                                                                                                                             |
| `NEXUS_SPEC_HISTORY_LIMIT`                   | `10`                                  | Historical spec revisions kept per API on top of the current one, 1–10 000.                                                                                                                                                                                                                                                                                                                                                                                          |
| `NEXUS_MAX_MESSAGES_PER_USER_PER_DAY`        | `200`                                 | Messages per account per rolling 24 h, 0–1 000 000; `0` disables. See [Messaging](#messaging).                                                                                                                                                                                                                                                                                                                                                                       |
| `NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY` | `20`                                  | Access requests per account per rolling 24 h, 0–1 000 000; `0` disables. See [Access requests](#access-requests).                                                                                                                                                                                                                                                                                                                                                    |
| `NEXUS_MAX_BROADCAST_RECIPIENTS`             | `5000`                                | Recipients per god-mode broadcast, 0–1 000 000; `0` disables.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `NEXUS_MAX_BROADCASTS_PER_DAY`               | `20`                                  | Broadcasts per administrator per rolling 24 h, 0–100 000; `0` disables.                                                                                                                                                                                                                                                                                                                                                                                              |
| `NEXUS_MAX_MASS_EMAIL_RECIPIENTS`            | `5000`                                | Recipients per mass-email campaign, 0–1 000 000; `0` disables. See [A mass-email campaign is one transaction](#a-mass-email-campaign-is-one-transaction).                                                                                                                                                                                                                                                                                                            |
| `NEXUS_ALLOW_PRIVATE_UPSTREAMS`              | `false`                               | Whether an API upstream may be loopback, private (RFC 1918, CGNAT, link-local) or a `.local`/`.internal`/`.localhost`/`.home.arpa` name. At `false` Nexus also resolves every other upstream hostname and refuses it if any answer is private or the name does not resolve, so **the Nexus process needs public DNS**. Refusals are `400 SPEC_INVALID`. Set `true` for internal-only portals and local development. See [`security.md`](security.md#1-threat-model). |
| `NEXUS_ALLOW_ENV_OVERRIDE`                   | `false`                               | Allow the process environment to override `.env` for `FERRUM_NAMESPACE`/`FERRUM_ADMIN_URL` outside production (see above). No effect in production.                                                                                                                                                                                                                                                                                                                  |
| `NEXUS_WEB_DIST`                             | _(unset)_                             | Directory of the built SPA. Nexus uses the first of this, `../../web/dist` relative to the server, and `./web/dist` under the working directory that contains an `index.html`; with none, only the API is served.                                                                                                                                                                                                                                                    |
| `NEXUS_BOOTSTRAP_TOKEN`                      | _(unset)_                             | Token the founding registration must present. At least 16 characters. When unset, each process generates one. Set it for any multi-instance deployment. See [First run](#first-run-and-the-bootstrap-token).                                                                                                                                                                                                                                                         |
| `NEXUS_GATEWAY_RECONCILE_INTERVAL_MS`        | `900000` (15 min)                     | How often Nexus checks that the gateway still holds the consumer and proxy ids it stored, 0 – 86 400 000. A pass also runs at startup. `0` disables the timer. See [§13](#13-retargeting-or-rebuilding-ferrum-edge).                                                                                                                                                                                                                                                 |
| `NEXUS_GATEWAY_RECONCILE_SAMPLE`             | `200`                                 | Most stored references of each kind one pass checks, 1–100 000. A pass that hits the bound reports `complete: false`.                                                                                                                                                                                                                                                                                                                                                |

### Database

| Variable                    | Default               | Notes                                                                         |
| --------------------------- | --------------------- | ----------------------------------------------------------------------------- |
| `NEXUS_DB_DRIVER`           | `sqlite`              | `sqlite` \| `postgres` \| `mysql` \| `mongodb`.                               |
| `NEXUS_DB_URL`              | _(empty)_             | Required for every driver except `sqlite`.                                    |
| `NEXUS_SQLITE_PATH`         | `./data/nexus.sqlite` | SQLite only. `:memory:` is honoured (tests). The parent directory is created. |
| `NEXUS_DB_ALLOW_STANDALONE` | `false`               | MongoDB only. Not for production; see [MongoDB](#mongodb).                    |

### Ferrum Edge integration

| Variable                           | Default                 | Notes                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FERRUM_ADMIN_URL`                 | `http://127.0.0.1:9000` | Base URL of the gateway's **Admin** API. `http://` to a non-loopback host is refused unless `FERRUM_ADMIN_ALLOW_INSECURE_HTTP=true`.                                                                                                                                      |
| `FERRUM_ADMIN_JWT_TTL`             | `60`                    | Admin JWT lifetime in seconds, 5–3600.                                                                                                                                                                                                                                    |
| `FERRUM_ADMIN_JWT_ISSUER`          | `ferrum-edge`           | The `iss` claim. Must equal the gateway's configured issuer.                                                                                                                                                                                                              |
| `FERRUM_ADMIN_JWT_AUDIENCE`        | _(unset)_               | Set only if the gateway configures an audience; otherwise `aud` is omitted.                                                                                                                                                                                               |
| `FERRUM_NAMESPACE`                 | `nexus`                 | Namespace Nexus manages, sent as `X-Ferrum-Namespace` and as the `ns` claim. Must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, at most 128 characters. Also the first segment of every listen path (`/<namespace>/<slug>`). See [Namespace routability](#namespace-routability). |
| `FERRUM_GATEWAY_PUBLIC_URL`        | _(unset)_               | Public origin of the gateway's **proxy listener**, used for each API's `invoke_url`. The `gateway.public_url` admin setting overrides it; with neither, `invoke_url` is `null`.                                                                                           |
| `FERRUM_ADMIN_CA_FILE`             | _(unset)_               | PEM CA bundle for a TLS Admin API. An unreadable file fails startup.                                                                                                                                                                                                      |
| `FERRUM_ADMIN_ALLOW_INSECURE_HTTP` | `false`                 | Allows plaintext `http://` to a non-loopback Admin API. For container-network-only traffic.                                                                                                                                                                               |
| `FERRUM_ADMIN_TIMEOUT_MS`          | `5000`                  | Per-request deadline for Admin API calls, 250–60000.                                                                                                                                                                                                                      |
| `FERRUM_MAX_CREDENTIALS_PER_TYPE`  | `2`                     | 1–10. Set it to the gateway's own value. Above 1, rotation appends the new credential before deleting the old one, so there is no gap.                                                                                                                                    |
| `FERRUM_RATE_LIMIT_SYNC_MODE`      | `local`                 | `local` \| `redis`. Where Edge keeps consumer-quota counters (see below).                                                                                                                                                                                                 |
| `FERRUM_RATE_LIMIT_REDIS_URL`      | _(unset)_               | Required when the mode is `redis`; must be `redis://` or `rediss://`. Ignored in `local` mode.                                                                                                                                                                            |
| `FERRUM_RATE_LIMIT_REDIS_TLS`      | `false`                 | Use TLS for a `redis://` endpoint (`rediss://` already implies it). Edge verifies it with its own `FERRUM_TLS_CA_BUNDLE_PATH`.                                                                                                                                            |

> **Consumer quotas are enforced per gateway process by default.** Edge's
> `rate_limiting` plugin keeps counters in process memory unless its config
> names a Redis endpoint, so **N** data-plane replicas allow **N ×** the quota a
> provider set. With `FERRUM_RATE_LIMIT_SYNC_MODE=redis`, Nexus writes
> `sync_mode`, `redis_url` and `redis_tls` into every `rate_limiting` config so
> all replicas share one counter.
>
> Changing the mode only affects rate limits saved afterwards. After switching
> on a live portal, re-save the rate limit of each existing API (any
> `PATCH /api/apis/:id` with a `rate_limit`, or re-saving the Settings tab).

#### Connection pooling and the gateway's idle bound

Nexus reuses keep-alive connections to the Admin API. Edge closes idle admin
connections after `FERRUM_HTTP_HEADER_READ_TIMEOUT_SECONDS` (10 s by default),
so the client gives up on idle sockets first. These constants live in
[`server/src/ferrum-admin/client.ts`](../server/src/ferrum-admin/client.ts) and
are not configurable:

| Setting                     | Value | Meaning                                                              |
| --------------------------- | ----- | -------------------------------------------------------------------- |
| `keepAliveTimeout`          | 4 s   | Idle lifetime of a pooled socket.                                    |
| `keepAliveMaxTimeout`       | 8 s   | Ceiling on a longer lifetime the gateway advertises in `Keep-Alive`. |
| `keepAliveTimeoutThreshold` | 2 s   | Subtracted from such a hint before it is used.                       |

If a proxy in front of Edge, or a lower gateway timeout, still closes a socket
as it is reused, a **read** is retried once on a fresh connection:

- only `GET`/`HEAD`, and only if no response byte had arrived. Writes are never
  replayed.
- only for a socket-level close (`UND_ERR_SOCKET`, `ECONNRESET`, `EPIPE`).
  Refused connections, DNS or TLS failures and timeouts fail at once as
  `EDGE_UNAVAILABLE`.
- within the original deadline (`FERRUM_ADMIN_TIMEOUT_MS`, or
  `NEXUS_HEALTH_PROBE_TIMEOUT_MS` for the health probe).

Each recovered reset still logs `Ferrum Edge Admin API closed a pooled
connection; retrying the read on a fresh one` at `warn`.

#### Set on the gateway, not on Nexus

| Variable (on Ferrum Edge)       | Notes                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FERRUM_ADMIN_JWT_SECRET`       | Must equal Nexus's value. A mismatch makes every Admin API call fail (`502 EDGE_ERROR`, "The gateway rejected the Nexus admin credentials").                                     |
| `FERRUM_BASIC_AUTH_HMAC_SECRET` | At least 32 bytes. **Required before any `basic_auth` API is published**; without it the publish fails with `EDGE_ERROR` and the gateway's message in `details.gateway_message`. |

#### Multi-tenant gateways (`FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM`)

Every admin JWT Nexus mints carries `ns` set to `FERRUM_NAMESPACE`. A gateway
started with `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true` (the right setting for a
control plane shared by several tenants) only accepts tokens whose `ns` covers
the requested namespace. Nexus works with or without the flag; make sure the
gateway grants this portal its `FERRUM_NAMESPACE`.

### Namespace routability

**`FERRUM_NAMESPACE` on the portal must equal the active namespace of the
gateway process that serves your traffic.** The Admin API accepts writes in any
namespace, but one gateway data plane serves only its own `FERRUM_NAMESPACE`
(default `ferrum`). A mismatch publishes successfully and shows an `invoke_url`
that answers `404`.

Nexus detects this from the `namespace` block of the gateway's authenticated
`GET /health` (read at startup and on every health probe) and from the
`X-Ferrum-Namespace-Unserved: true` header Edge sets on a write it will not
route. While the namespace is unrouted:

- `GET /api/health` reports `edge.status: "degraded"`,
  `edge.reason: "namespace_unserved"` and `edge.namespace_routing`. The overall
  status is `degraded` on HTTP `200`.
- Publishing (`POST /api/apis`), spec uploads (`PUT /api/apis/:id/spec`),
  revision rollbacks and `POST /api/apis/:id/restore-gateway` are refused with
  `409 EDGE_NAMESPACE_UNSERVED` before any gateway write. Reads, runtime
  `PATCH`es and deletes still work, so you can clean up.
- The startup check logs `MISCONFIGURED NAMESPACE: …` at `error`.

To see the gateway's side:

```bash
curl -s "$FERRUM_ADMIN_URL/health" -H "Authorization: Bearer $ADMIN_JWT" | jq .namespace
```

```json
{
  "active": "ferrum",
  "serving_scope": "single-namespace-data-plane",
  "data_plane_single_namespace": true
}
```

A control plane reports `data_plane_single_namespace: false` and
`active: null`, and never degrades the portal. A gateway without a `namespace`
block is treated as unknown, not as a mismatch.

**Fixing a mismatch.** Set the portal's `FERRUM_NAMESPACE` to the gateway's
`active` value, or restart the gateway with the portal's value, then restart
the portal. Changing the portal's namespace changes every listen path, so APIs
published under the old one must be republished.

### Email

All optional. SMTP can also be configured in **Admin → Settings**, and stored
settings override these at runtime.

| Variable                                  | Default                               |
| ----------------------------------------- | ------------------------------------- |
| `NEXUS_SMTP_HOST`                         | _(unset — mail stays queued)_         |
| `NEXUS_SMTP_PORT`                         | `587`                                 |
| `NEXUS_SMTP_SECURE`                       | `false`                               |
| `NEXUS_SMTP_USER`                         | _(unset)_                             |
| `NEXUS_SMTP_PASSWORD`                     | _(unset)_                             |
| `NEXUS_EMAIL_FROM`                        | `Ferrum Nexus <no-reply@example.com>` |
| `NEXUS_EMAIL_TEMPLATE_ALLOWED_LINK_HOSTS` | _(empty)_                             |

`NEXUS_SMTP_PASSWORD` is only sent with the environment's own host, port, TLS
mode and username. If stored settings change any of those, they need their own
stored password; with none (or one the current `NEXUS_SECRET_KEY` cannot
decrypt) no password is sent and the server logs why
([security.md §6](security.md#6-settings-encryption)).

`NEXUS_EMAIL_TEMPLATE_ALLOWED_LINK_HOSTS` is environment-only: a comma-separated
list of exact lowercase hosts, optionally with a non-default port
(`assets.example.com,docs.example.com:8443`). Schemes, paths, credentials and
wildcards fail startup. Subdomains and other ports need their own entries.
Changing it requires a restart.

Email templates may link to the `NEXUS_PUBLIC_URL` origin and to these hosts
only. The check covers every template field, URL attribute and CSS URL, and
re-runs after substitution. `javascript:` and `data:` are never allowed.

- A stored template that breaks the policy is not used: the server logs
  `Stored email template refused by the link policy; sending the built-in
template` and sends the built-in one, so account recovery keeps working.
  Repair or reset the template to clear it.
- A rendered message that breaks it (for example mass-email HTML linking to an
  unapproved host) is refused with `Refused unsafe email template` and nothing
  is queued.

See the [template authoring rules](guides/admin-guide.md#placeholders).

### Abuse controls

Registration may be open, so a signed-up account is semi-trusted. These bounds
limit what one account can consume.

**Rate limiters** (installed when `NEXUS_RATE_LIMIT_ENABLED=true`, answer
`429 RATE_LIMITED`):

| Routes                                                                                                                                                                                                                                                                                | Limit           | Keyed on |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------- |
| `/api/auth` register, login, logout, verify-email, resend-verification, forgot-password, reset-password                                                                                                                                                                               | 20/min          | IP       |
| `GET /api/auth/me`, `GET /api/auth/captcha` (shared)                                                                                                                                                                                                                                  | 120/min         | IP       |
| `/api/health*`                                                                                                                                                                                                                                                                        | 120/min         | IP       |
| `GET /api/branding`                                                                                                                                                                                                                                                                   | 120/min         | IP       |
| `/api/apis` writes: `POST /`, `PATCH /:id`, `DELETE /:id`, `PUT /:id/spec`, `PUT`/`DELETE /:id/plugins/:name`, `POST`/`DELETE /:id/viewers…`, `POST /:id/spec/diff`, `GET /:id/revisions/:revisionId/diff`, `POST …/rollback`, `POST /:id/restore-gateway`, `POST /:id/test-consumer` | 30/min          | account  |
| `GET /api/apis/:id/usage`                                                                                                                                                                                                                                                             | 30/min          | IP       |
| `GET /api/catalog/:slug/spec`                                                                                                                                                                                                                                                         | 60/min          | account  |
| `/api/applications` create, update, delete                                                                                                                                                                                                                                            | 30/min          | account  |
| `PATCH /api/users/me`                                                                                                                                                                                                                                                                 | 10/min          | account  |
| `POST /api/threads` / `POST /api/threads/:id/messages`                                                                                                                                                                                                                                | 10 / 30 per min | account  |
| `POST /api/access-requests` / `POST /api/access-requests/:id/cancel`                                                                                                                                                                                                                  | 10 / 30 per min | account  |

"Account" limiters fall back to the client IP for anonymous requests. All
counters are in memory, **per process**: with N instances the effective limit is
N × these numbers. Enforce hard limits at your proxy if that matters. IP-keyed
limits depend on `NEXUS_TRUSTED_PROXIES` being right, or every request through
your load balancer shares one bucket.

**Per-account API quota** (`NEXUS_MAX_APIS_PER_OWNER`, default 50). A publish
over the limit is refused with `429 QUOTA_EXCEEDED` and
`details: { limit, current, setting }`, before any gateway write.

- It counts APIs the account currently owns. Deleting one frees a slot;
  retiring one does not (a retired API keeps its gateway resources).
- It applies to administrators too.
- The check is serialized per owner within one process. Across N instances a
  simultaneous burst can overshoot by at most N − 1.

**Spec history** (`NEXUS_SPEC_HISTORY_LIMIT`, default 10). When a new revision
becomes current, non-current revisions beyond the newest N (by publication
order) are deleted in the same transaction. The current revision and its
predecessor are always kept. Up to 1000 old rows are pruned per API per upload,
so a long legacy history shrinks over a few uploads. `api.spec_update` audit
rows record `pruned_revisions`.

Together the two bound per-account spec storage: each document is at most
`MAX_SPEC_BYTES` (2 MiB), so one account stores at most
`2 MiB × (NEXUS_SPEC_HISTORY_LIMIT + 1) × NEXUS_MAX_APIS_PER_OWNER` — about
1.1 GiB at the defaults. Size the database for your provider count.

#### Messaging

Each message writes a message row and an audit row. A **platform thread** (no
`recipient_user_id`) also notifies and emails every active `admin` and
`super_admin`. Broadcasts and mass email fan out further. The bounds:

| Bound                    | Value                                     | Where                                 |
| ------------------------ | ----------------------------------------- | ------------------------------------- |
| New threads / replies    | 10 / 30 per minute per account            | Rate limiter                          |
| Messages per account     | 200 per rolling 24 h (`0` = unlimited)    | `NEXUS_MAX_MESSAGES_PER_USER_PER_DAY` |
| Broadcast recipients     | 5 000 per broadcast (`0` = unlimited)     | `NEXUS_MAX_BROADCAST_RECIPIENTS`      |
| Broadcasts per admin     | 20 per rolling 24 h (`0` = unlimited)     | `NEXUS_MAX_BROADCASTS_PER_DAY`        |
| Mass-email recipients    | 5 000 per campaign (`0` = unlimited)      | `NEXUS_MAX_MASS_EMAIL_RECIPIENTS`     |
| `message_received` email | 1 per recipient per thread per 10 minutes | Outbox idempotency key; fixed         |

- **The daily budgets are exact across instances.** The count and the insert run
  under a per-sender lease in `edge_leases`. A sender whose lease is held
  elsewhere for over 30 s gets `409 CONFLICT` ("please retry").
- **Refusals write nothing.** Budgets and ceilings answer `429 QUOTA_EXCEEDED`
  with `details` naming the limit and the variable to raise.
- **Admins are subject to the message budget.** Direct and platform threads
  share one budget per sender.
- **Broadcasts do not spend the sender's message budget.** The two broadcast
  ceilings apply instead, checked before any row is written. Set
  `NEXUS_MAX_BROADCAST_RECIPIENTS` above your account count for an announcement
  to reach everyone.
- **A broadcast is counted when attempted.** Its `god.broadcast` audit row is
  written before fan-out; the outcome is a separate `god.broadcast_complete`
  row with `delivered` and `failed`. A `god.broadcast` with no completion row
  means the fan-out ran but the outcome was not recorded. An audience that
  matches nobody is a `400` and is not counted.
- **The `message_received` email does not quote the message** by default,
  because only the first message in each 10-minute window sends one. In-app
  notifications are still one per message.

#### Branding

`GET /api/branding` is unauthenticated. Its payload is cached for
`NEXUS_BRANDING_CACHE_MS` (5 s) with `Cache-Control: public, max-age=…` and an
`ETag`, and concurrent callers share one assembly. It is also rate limited
(120/min per IP). It never sets cookies, so a CDN or reverse proxy may cache it;
every response that does set one is `Cache-Control: private, no-store`.

- Any committed settings write invalidates the cache on the instance that made
  it. Other instances catch up within the TTL; browser and CDN copies within
  their `max-age`.
- `bootstrap_required: true` (open founder seat) is never cached, so a founder
  seated on any instance shows everywhere at once. `false` is held for 1 s.

#### Access requests

| Bound                       | Value                                 | Where                                        |
| --------------------------- | ------------------------------------- | -------------------------------------------- |
| Create / cancel             | 10 / 30 per minute per account        | Rate limiter                                 |
| Access requests per account | 20 per rolling 24 h (`0` = unlimited) | `NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY` |

The daily budget counts every request created in the window, cancelled ones
included. It is enforced under a per-requester lease before any row is written;
refusals write nothing.

### Test-only

`NEXUS_TEST_POSTGRES_URL`, `NEXUS_TEST_MYSQL_URL` and `NEXUS_TEST_MONGO_URL` are
read by the cross-adapter tests, not by the server. See
[`contributing.md`](contributing.md).

### First run and the bootstrap token

While the portal has no active `super_admin`, the next registration becomes one,
and it must present the bootstrap token. The account, its role and the
`bootstrap.super_admin_claimed` audit record are written in one transaction
under the cross-instance super-admin lock, so a failed attempt leaves nothing
behind.

- **`NEXUS_BOOTSTRAP_TOKEN` set:** that value is the token. It is never logged.
- **Unset:** each process generates a 32-byte random token and logs it at `warn`
  if the portal has no active super admin after migrations:

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

Consequences:

- **Multi-instance deployments must set the variable**; otherwise each instance
  accepts only its own token.
- **A restart replaces a generated token.**
- The token stays valid until an active super admin exists, then is ignored.
- `GET /api/branding` reports `bootstrap_required: true` while the seat is open.
  It never reveals the token.

### Recovering a portal with no super admin

If a portal has accounts but no active `super_admin`, the bootstrap flow above
recovers it: the condition is "no active super admin", not "no accounts".
Ordinary registration is refused with `403 FORBIDDEN` until an administrator is
seated.

1. **Confirm.** `GET /api/branding` returns `bootstrap_required: true` although
   accounts exist.
2. **Get a token.** Use `NEXUS_BOOTSTRAP_TOKEN`, or restart one instance and read
   the banner it prints.
3. **Register** through the sign-up form (or `POST /api/auth/register`) with a
   **new** email address and the token. That account becomes a verified
   `super_admin`; existing accounts are unchanged.
4. **Verify.** `bootstrap_required` is now `false`. The new administrator can
   promote or remove other accounts as needed.

With a seated administrator the token does nothing, so this cannot mint a
second super admin.

### Recovering a portal locked out by CAPTCHA

With CAPTCHA enabled, `POST /api/auth/login` and `POST /api/auth/register`
require a `captcha_token`, and verification **fails closed**: a wrong site key,
an undecryptable secret, an unreachable vendor or a script the browser cannot
load all answer `400 CAPTCHA_FAILED`, for every account.

**Prevention: the activation self-test.** `PUT /api/admin/settings` refuses to
turn CAPTCHA on, or to change its `provider`, `site_key` or `secret_key` while
on, unless the request includes a `captcha_token` the **new** configuration
verifies. Failure is `400 CAPTCHA_SELF_TEST_FAILED` (`details.reason`:
`token_required`, `rejected` or `provider_unreachable`) and stores nothing.
**Admin → Settings → CAPTCHA** renders the widget from the form's values to
produce that token. Turning CAPTCHA off needs no token.

**Recovery: the break-glass variable.**

1. Set `NEXUS_CAPTCHA_ENFORCEMENT=disabled` and restart every instance. Each
   logs a banner while it is set. Nothing in the database changes.
2. Sign in. Register and login skip verification and the widget is hidden
   (`GET /api/auth/captcha` reports `enabled: false`). Those `auth.login` and
   `auth.register` audit rows carry `captcha_bypassed: true`.
3. Fix or disable CAPTCHA in **Admin → Settings → CAPTCHA**. The page and
   `GET /api/admin/settings` (`captcha.enforcement: "disabled"`) show that
   enforcement is off. The self-test still applies. When switching vendors,
   enter the new vendor's secret in the same save (`400 VALIDATION_FAILED`
   otherwise).
4. Remove the variable and restart. Confirm `captcha.enforcement` is `enforced`,
   then sign out and back in.

Do not leave the variable set: registration is unprotected while it is. To run
without CAPTCHA, turn it off in settings, where the change is audited.

---

## 2. Databases and migrations

### Migration behaviour

Migrations run automatically at startup (`store.init()` then `store.migrate()`)
before the server listens. Applied ids are recorded in `schema_migrations` and
skipped on later boots. A failed migration stops startup; see
[Upgrade failures and rollback](#upgrade-failures-and-rollback).

[Schema versioning and upgrades](#schema-versioning-and-upgrades) is the
production contract. The [buildout schema policy](#buildout-schema-policy) is a
development-only reset that destroys data.

### Schema versioning and upgrades

**The released baseline.** `001_initial` (three SQL files in
`server/src/db/migrations/` plus the MongoDB step of the same id in
`server/src/db/adapters/mongodb/index.ts`) is frozen in `v0.1.0`.
`server/src/db/released-migrations.ts` records it with per-backend SHA-256
checksums and `release: 'v0.1.0'`, and the forward migrations
`002_api_gateway_plugins` and `003_messages_thread_latest` with
`release: 'v0.2.0'`.

**A released migration never changes.** A database only applies migrations its
ledger lacks, so editing an applied one would make fresh and upgraded installs
diverge. Every schema change is a **new forward migration**:

1. Give it the next id (`002_description`, …). It must sort after every
   released id; migrations run in id order.
2. Implement it for every backend: `NNN_description.sql`, `.pg.sql`,
   `.mysql.sql`, and a `MONGO_MIGRATIONS` step that declares its indexes.
3. Make it safe to re-run where the backend cannot roll it back (MySQL DDL,
   MongoDB steps), and do not depend on data a portal may not have.
4. In the same change, add it to `RELEASED_MIGRATIONS` with `release: null` and
   its checksums, and commit `server/src/db/released/NNN_description.mongodb.json`
   (its MongoDB index snapshot). The release that ships it sets `release` to its
   tag, which freezes it.

**Released forward migrations.** `002_api_gateway_plugins` (shipped in
`v0.2.0`) adds the `api_gateway_plugins` table, which records the Edge plugin
config id of each config the portal creates for an API (auth, `access_control`,
`rate_limiting`, `cors`). Settings changes then only touch configs the portal
owns. It copies no data:

- An API published before the upgrade has no records. On its first
  gateway-touching change, Nexus recognizes its configs by the values it wrote
  and records them role by role. A role the API does not use is recorded as
  owning nothing (`NULL` config id).
- Configs of the same plugin name that the portal does not own are listed in the
  audit row under `unowned_same_name_configs`.
- If a proxy has two matching configs for one role, or an auth,
  `access_control` or `cors` config that no longer matches the API's settings
  and none that does, a `PATCH` touching that role answers `409 CONFLICT` naming
  the plugin until the operator removes or fixes the config. Other fields keep
  working.
- A `rate_limiting` config an operator edited by hand is left alone; the portal
  creates its own next to it.
- A leftover auth config beside the portal's stays attached after an
  `auth_plugin` change and is listed under `outgoing_auth_configs_remaining`.

`003_messages_thread_latest` (shipped in `v0.2.0`) replaces the messages index
`ix_messages_thread (thread_id, created_at)` with `ix_messages_thread_latest`,
which adds the message id (`_id` descending on MongoDB), so finding each
thread's newest message is one index seek per thread. It changes no data. On
MySQL it is a no-op, because InnoDB already appends the primary key to the
existing index. On MongoDB the step also drops `ix_messages_thread`. On a
large `messages` table, building the index can take a while at startup, and on
PostgreSQL and SQLite the build blocks writes to `messages` until it finishes,
so during a rolling deploy message sends stall briefly while the new instance
migrates.

**CI enforces this.** `server/src/db/released-migrations.test.ts` fails when a
released migration's file or MongoDB snapshot no longer matches its checksum,
when a released migration is deleted or renamed, when a new migration sorts
before a released one, when backends disagree on ids, or when a released MongoDB
step's indexes drift. Never update a released checksum to make it pass.

**Upgrade coverage.** `server/src/test/baseline-upgrade.test.ts` builds a
database as each release in the manifest left it (`v0.1.0`, then `v0.2.0`; every
release is a supported upgrade source), seeds it with baseline-shaped rows,
migrates with the current code, reads every value back, and migrates again to
prove the re-run is a no-op. SQLite runs in every CI job; PostgreSQL, MySQL
and MongoDB run in the `store-contracts` job. Per backend:

- **SQLite, PostgreSQL:** each migration and its ledger row commit in one
  transaction. A failed migration leaves no trace; earlier ones stay applied.
- **MySQL:** DDL commits statement by statement. The runner accepts only
  `CREATE TABLE IF NOT EXISTS` statements (replay-safe) and serializes
  migrators with an advisory lock
  ([details](#retrying-interrupted-mysql-initialization)). A future migration
  that needs `ALTER TABLE` or a data change must first add a replay-safe
  strategy to the MySQL runner.
- **MongoDB:** a replica set is required. A step is recorded only after it
  completes, so every step must be idempotent. The CI guard freezes a step's
  declared indexes, not document-transforming code; review such steps by hand.
  Standalone mode (`NEXUS_DB_ALLOW_STANDALONE=true`) has no upgrade guarantee.

**Downgrades are not supported.** An older binary does not refuse a newer
database; it ignores unknown ledger ids and runs against a schema it was not
written for. Roll back by restoring the pre-upgrade backup.

#### Production upgrade procedure

1. Read the release notes: supported upgrade sources and the validated Ferrum
   Edge release.
2. Back up the Nexus database and record its secrets ([§5](#5-backup-and-restore)).
   This backup is your rollback.
3. Stop every Nexus instance.
4. Run the migration once from the **new** image with the production environment
   (and, for SQLite, the same data volume):

   ```bash
   docker run --rm --env-file nexus.env <new-image> node server/dist/db/migrate-cli.js
   ```

   It prints `Migrations applied (driver: …).` and exits `0`, or exits non-zero.
   Re-running it is safe.

5. Start the new release on every instance.
6. Verify: `GET /api/health` is `ok`, `schema_migrations` lists the release's
   ids, an administrator can sign in, and a known client can call an API through
   the gateway (see [Verifying a restore](#verifying-a-restore)).

#### Upgrade failures and rollback

A failed migration exits non-zero, names the migration, and leaves earlier
migrations applied.

- **SQLite, PostgreSQL:** the failed migration was rolled back. Fix the cause
  and re-run step 4.
- **MySQL:** some statements may have committed. Re-run only if the migration
  is replay-safe; otherwise restore the backup.
- **MongoDB:** re-run; steps are idempotent.
- **A failure that repeats** is a release defect. Restore the backup, redeploy
  the previous release, and report it.

Never edit `schema_migrations` to get past a failure. Rolling back is a
restore, with the [limits in §5](#recovery-and-rollback-limits).

### Buildout schema policy

**Development only.** This destroys data and never applies to a database a
supported release created; for those, see
[Schema versioning and upgrades](#schema-versioning-and-upgrades).

Before `v0.1.0`, the `001_initial` baselines were edited in place (they replaced
an earlier 001–017 history). A development database created before `v0.1.0`
must be recreated, even if its ledger already lists `001_initial`:

1. Stop all Nexus instances.
2. For SQLite, delete the database file and its `-wal` and `-shm` files. For
   PostgreSQL, MySQL or MongoDB, drop and recreate only the dedicated
   development database.
3. Run the migration (or start Nexus) and register the first administrator
   again.

Never delete only `schema_migrations`: replaying `CREATE TABLE IF NOT EXISTS`
does not update an existing table. Nexus never resets a database by itself.

### Initializing the schema

To run migrations as a separate step:

```bash
npm run migrate                      # from a checkout, at the repo root
node server/dist/db/migrate-cli.js   # from a built image
```

Use the root script, not `npm run migrate --workspace server`: only the root
script builds `@ferrum-nexus/shared` first. The runtime image contains only the
compiled output (`shared/dist`, `server/dist`, `web/dist`), so inside a
container use the compiled entry point:

```bash
docker exec <container> node server/dist/db/migrate-cli.js
docker run --rm --env-file .env <image> node server/dist/db/migrate-cli.js
```

The CLI loads the same environment, applies pending migrations, prints
`Migrations applied (driver: postgres).` and exits non-zero on failure.

`npm run build --workspace server` copies `server/src/db/migrations/` to
`server/dist/db/migrations/`, replacing stale files. The loader finds them
relative to its own module, not the working directory.

### SQLite

The default, and fine for a single-instance portal.

```bash
NEXUS_DB_DRIVER=sqlite
NEXUS_SQLITE_PATH=/var/lib/ferrum-nexus/nexus.sqlite
```

- Pragmas: `foreign_keys = ON`, `busy_timeout = 5000`; file databases also use
  `journal_mode = WAL` and `synchronous = NORMAL`.
- **WAL means three files** (`nexus.sqlite`, `-wal`, `-shm`). Copying only the
  main file of a running database gives a broken backup.
- Transactions are serialized through an in-process queue; other store calls
  wait until the open transaction ends.
- Only one process may write. Do not point two instances at one file, and do
  not use NFS.

### PostgreSQL

```bash
NEXUS_DB_DRIVER=postgres
NEXUS_DB_URL=postgres://nexus:secret@db.internal:5432/nexus
```

- Pool: `max: 10`, `idleTimeoutMillis: 30000`. A transaction holds one client
  throughout.
- TLS and other options go in the URL (`?sslmode=require`).

### MySQL

```bash
NEXUS_DB_DRIVER=mysql
NEXUS_DB_URL=mysql://nexus:secret@db.internal:3306/nexus
```

- Pool: `connectionLimit: 10`, `waitForConnections: true`.
- `charset: utf8mb4_general_ci`, `multipleStatements: false`,
  `dateStrings: true`. Use a `utf8mb4` database.
- Timestamps are ISO-8601 strings in `VARCHAR` columns, so server time-zone
  settings cannot change them.

### Retrying interrupted MySQL initialization

MySQL DDL commits outside the migration ledger. Every migration uses only
`CREATE TABLE IF NOT EXISTS` with indexes and constraints inline, so re-running
finishes an interrupted initialization. A database-scoped advisory lock
(`GET_LOCK`) serializes migrators across instances, and a migration is recorded
only after all its tables succeed. The runner refuses any other statement
([Schema versioning and upgrades](#schema-versioning-and-upgrades)).

### MongoDB

```bash
NEXUS_DB_DRIVER=mongodb
NEXUS_DB_URL=mongodb://mongo-a:27017,mongo-b:27017/nexus?replicaSet=rs0
```

**A replica set or sharded cluster is required.** `init()` checks with `hello`
and refuses to start against a standalone `mongod`:

```
MongoDB is running as a standalone server, which cannot execute the
multi-document transactions credential rotation and grant approval depend on.
Deploy a replica set …
```

`NEXUS_DB_ALLOW_STANDALONE=true` skips the check for development only. With it,
transactions run their steps in order but without atomic commit, so a failure
part-way (for example during an approval) leaves partial writes. Do not use it
in production.

Indexes are created by `migrate()` and tracked in `schema_migrations` like the
SQL backends. Each `MONGO_MIGRATIONS` step declares its indexes, and released
steps are frozen by snapshots in `server/src/db/released/`.

### Transactions and contention retries

Atomic writes run in `store.transaction`. Within one instance transactions run
one at a time; across instances the database may roll one back because of a
collision:

| Engine     | Reported as                                                       |
| ---------- | ----------------------------------------------------------------- |
| MySQL      | `ER_LOCK_DEADLOCK` (1213), `ER_LOCK_WAIT_TIMEOUT` (1205), `40001` |
| PostgreSQL | `40001` serialization failure, `40P01` deadlock                   |
| MongoDB    | `WriteConflict` (112), labelled `TransientTransactionError`       |
| SQLite     | cannot happen (one connection)                                    |

Nexus re-runs the transaction in these cases:

- **MySQL, PostgreSQL:** up to 5 attempts, with jittered exponential backoff of
  5–200 ms.
- **MongoDB:** retries for up to 5 s of contention on the same backoff; the
  whole transaction is capped at 15 s.
- **If it still fails:** `409 CONFLICT` with
  `details.reason: "transaction_contention"`. On MongoDB, a commit whose outcome
  the driver could not confirm is `409 CONFLICT` with
  `details.reason: "transaction_commit_unknown"`; check state before retrying.
- Uniqueness violations, validation errors and lost connections are not retried.
- Emails, gateway calls and notifications happen after commit, so a retry never
  repeats them.

Occasional retries are normal. A steady stream of `transaction_contention`
conflicts means a hot row (often one busy thread or account) worth
investigating.

---

## 3. Docker

### Single container

```bash
docker build -t ferrum-nexus -f docker/Dockerfile .

# Publish on loopback only and put a TLS terminator in front (see §4).
# A bare -p 8787:8787 exposes an unbootstrapped portal on every interface.
docker run --rm -p 127.0.0.1:8787:8787 \
  -e NEXUS_SECRET_KEY="$(openssl rand -hex 32)" \
  -e NEXUS_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)" \
  -e FERRUM_ADMIN_URL=http://host.docker.internal:9000 \
  -e FERRUM_ADMIN_ALLOW_INSECURE_HTTP=true \
  -e FERRUM_ADMIN_JWT_SECRET=change-me-at-least-32-characters-long \
  -e NEXUS_PUBLIC_URL=https://portal.example.com \
  -v nexus-data:/app/data \
  ferrum-nexus
```

`FERRUM_ADMIN_ALLOW_INSECURE_HTTP=true` is needed because
`host.docker.internal` is not loopback. Without `NEXUS_BOOTSTRAP_TOKEN`, read
the generated token from `docker logs` ([First run](#first-run-and-the-bootstrap-token)).

The image ([`docker/Dockerfile`](../docker/Dockerfile)) is a two-stage build on
a digest-pinned `node:22-bookworm-slim` (Node 22.14 or later is required). It
sets:

- `NODE_ENV=production`, and runs as the unprivileged `node` user.
- `NEXUS_HOST=0.0.0.0`, `NEXUS_PORT=8787`.
- `NEXUS_SQLITE_PATH=/app/data/nexus.sqlite` with `/app/data` as a `VOLUME`.
  **Mount it, or the SQLite database is lost with the container.**
- `NEXUS_WEB_DIST=/app/web/dist`, so the SPA and API share one origin.
- A `HEALTHCHECK` on `GET /api/health`: every 30 s, 10 s timeout, 20 s start
  period, 3 retries. It fails only on a non-2xx answer, which means the database
  is down; a gateway outage (`degraded`) keeps the container healthy. See
  [§9](#9-health-checks).

### Compose

[`docker/docker-compose.example.yml`](../docker/docker-compose.example.yml)
runs Nexus, PostgreSQL and a Ferrum Edge gateway:

```bash
cp docker/docker-compose.example.yml docker-compose.yml
set -a
. ./release/compatibility.env
set +a
export NEXUS_SECRET_KEY=$(openssl rand -hex 32)
export NEXUS_DB_PASSWORD=$(openssl rand -hex 16)
export FERRUM_ADMIN_JWT_SECRET=$(openssl rand -hex 32)
export FERRUM_BASIC_AUTH_HMAC_SECRET=$(openssl rand -hex 32)
docker compose up -d
```

The four secrets and `FERRUM_EDGE_IMAGE` are required (`${VAR:?…}`); keep the
secrets stable across restarts. [`release/compatibility.env`](../release/compatibility.env)
pins the Edge image by digest: Ferrum Edge `v0.9.8` for Nexus `v0.2.0`. That is
the release the acceptance suite ([`e2e/`](../e2e/README.md)) tests against;
other Edge versions are unverified.

The portal is on `http://127.0.0.1:8787` and the gateway proxy listener on
`http://127.0.0.1:8000`, both bound to loopback. Before adapting it:

- It sets `NEXUS_COOKIE_SECURE=false` so sessions work over plain HTTP on
  loopback. Behind TLS, set `NEXUS_PUBLIC_URL=https://…` and
  `NEXUS_COOKIE_SECURE=true`.
- `FERRUM_GATEWAY_PUBLIC_URL` defaults to `http://127.0.0.1:8000`; override it
  with the real gateway origin elsewhere.
- Both services read `FERRUM_ADMIN_JWT_SECRET` from the same variable, and both
  use `FERRUM_NAMESPACE: nexus`.
- `FERRUM_ADMIN_ALLOW_INSECURE_HTTP` (Nexus) and
  `FERRUM_ALLOW_INSECURE_ADMIN_HTTP` (Edge) are safe only because the Admin API
  is reachable only on the compose network. Do not publish its port.
- Nexus waits for PostgreSQL's `pg_isready` healthcheck before starting. The
  database password comes from `NEXUS_DB_PASSWORD` and is used for both
  `POSTGRES_PASSWORD` and `NEXUS_DB_URL`.
- A one-shot `ferrum-edge-init` container `chown`s the `ferrumdata` volume to
  `65532:65532` (Edge's user) before the gateway starts.
- Optionally export `NEXUS_BOOTSTRAP_TOKEN`; otherwise read the generated one
  with `docker compose logs nexus`.

---

## 4. Running behind TLS and a reverse proxy

Nexus does not terminate TLS. Put it behind nginx, Caddy or a load balancer and
set:

```bash
NEXUS_TRUSTED_PROXIES=10.0.0.0/8   # or: 1, meaning "one hop"
NEXUS_COOKIE_SECURE=true           # the default outside development
NEXUS_PUBLIC_URL=https://portal.example.com
```

These are two separate decisions:

1. `NEXUS_COOKIE_SECURE` marks `nexus_session` and `nexus_csrf` `Secure` and
   sends HSTS (`max-age=31536000; includeSubDomains`).
2. `NEXUS_TRUSTED_PROXIES` decides whether `X-Forwarded-For` sets
   `request.ip`, which is recorded in sessions and audit rows and keys the
   IP rate limiters.

**Name the proxy or count the hops; never trust everything.** Clients control
the left-most `X-Forwarded-For` entry, so trusting every proxy lets anyone forge
their audit IP and dodge rate limits. Nexus cannot be configured that way: use
an allowlist (`10.0.0.0/8`) or a hop count (`1` if exactly one proxy is in
front).

Serve the SPA and API on **one origin**: cookies are `SameSite=Lax` and there
is no CORS support. The simplest setup lets Nexus serve the built SPA
(`NEXUS_WEB_DIST`, or the Docker image) and proxies the whole origin to it.
Non-`/api` 404s fall back to `index.html`, so client-side routes survive a
reload.

```nginx
location / {
    proxy_pass         http://127.0.0.1:8787;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

Nexus sets its own security headers (CSP with `frame-ancestors 'none'`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`). Do not let the proxy
overwrite them; see [`security.md`](security.md#8-csp-and-response-headers).

---

## 5. Backup and restore

A deployment is recoverable only as a **pair**: the Nexus database and the
Ferrum Edge state, taken at the same moment, plus the secrets both used. Neither
can be rebuilt from the other. Nexus stores the gateway's consumer and proxy
ids but never credential secrets; Edge stores credentials and ACL groups but
nothing about accounts, approvals or audit history.

### What to back up

1. **The Nexus database**, every table, including `schema_migrations`,
   `consumers`, `gateway_identities` and `credential_metadata` (the mapping into
   Edge). Commands are below.
2. **Nexus secrets and settings:** `NEXUS_SECRET_KEY` (without it, encrypted
   settings are unreadable and sessions and email links stop working;
   [§7](#7-rotating-nexus_secret_key)), `FERRUM_ADMIN_JWT_SECRET`,
   `FERRUM_ADMIN_JWT_ISSUER`, `FERRUM_NAMESPACE` and `FERRUM_ADMIN_URL`. Keep
   them in a secret manager, not beside the dumps.
3. **The Ferrum Edge state** for that namespace: proxies, consumers with
   credentials and ACL groups, plugin configs, upstreams and API specs. Back up
   Edge's database with its own tooling, or use Edge's Admin API `GET /backup`
   (restore with `POST /restore?confirm=true`; see Edge's
   [backup and restore reference](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.8/docs/admin_backup_restore.md)).
4. **Edge secrets**, especially `FERRUM_BASIC_AUTH_HMAC_SECRET`. Basic-auth
   credentials are stored as HMACs under it, so a different value rejects every
   basic-auth client.
5. **The versions:** the Nexus and Edge image digests.

**Treat the Edge backup as live credentials.** `GET /backup` exports `keyauth`
keys and `jwt` secrets unredacted. The Nexus database holds only credential
fingerprints and last-four characters, but it does hold password hashes,
session-token hashes and encrypted settings. Encrypt both backups and restrict
access.

### Ordering and consistency

Nexus writes Edge resources during approvals, revocations, credential changes,
publishes and account changes, so the two backups must describe **one point in
time**. The consistent procedure needs a short portal outage (Edge keeps serving
traffic unless you stop it to copy files):

1. **Stop every Nexus instance.** Pause any other Admin API writers too.
2. **Back up the Nexus database.**
3. **Back up Edge** (`GET /backup`, or its database; stop Edge or snapshot
   consistently if you copy files).
4. **Start Nexus.**

If Nexus cannot be stopped, back up Nexus first and Edge immediately after.
Expect drift for anything in between: after a restore, run
`POST /api/admin/gateway/reconcile` and re-issue any credential created or
rotated in that window ([§12](#12-the-credential-mirror)).

| Driver     | Backup                                                               | Notes                                                                                           |
| ---------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| SQLite     | `sqlite3 nexus.sqlite ".backup '/backups/nexus-$(date +%F).sqlite'"` | Or `VACUUM INTO`, or stop the service and copy all three files. Never `cp` a live WAL database. |
| PostgreSQL | `pg_dump --format=custom nexus > nexus.dump`                         | Restore with `pg_restore`.                                                                      |
| MySQL      | `mysqldump --single-transaction --routines nexus > nexus.sql`        | `--single-transaction` gives a consistent InnoDB snapshot.                                      |
| MongoDB    | `mongodump --uri="$NEXUS_DB_URL" --out /backups/$(date +%F)`         | Restore with `mongorestore`. On a replica set, dump from a secondary.                           |

### Compatible versions

- **Nexus:** restore into the **same** Nexus release that wrote the backup,
  confirm it works, then upgrade with the
  [production upgrade procedure](#production-upgrade-procedure). Never restore
  into an older release. Pre-`v0.1.0` development databases cannot be restored
  into a release.
- **Ferrum Edge:** restore into the Edge release that wrote it, or one Edge
  documents as compatible. Nexus is validated against the release pinned in
  `release/compatibility.env`.
- **Same driver:** moving between database engines is a migration, not a
  restore.

### Restoring

**Restore both halves from the same backup** whenever you have an Edge backup.
It is the only way to keep issued credentials working.

1. Stop every Nexus instance.
2. Restore Edge with its secrets unchanged (its database with Edge stopped, or
   `POST /restore?confirm=true`) and start it.
3. Restore the Nexus database into an **empty** database of the same driver.
4. Start the **same** Nexus release with the same `NEXUS_SECRET_KEY`,
   `FERRUM_ADMIN_JWT_SECRET`, `FERRUM_ADMIN_JWT_ISSUER` and `FERRUM_NAMESPACE`,
   and `FERRUM_ADMIN_URL` pointing at the restored gateway. The startup
   migration should do nothing.
5. [Verify](#verifying-a-restore) before reopening the portal.

**Without an Edge backup**, credentials cannot be recovered: Nexus stores only a
SHA-256 fingerprint and the last four characters. Follow
[§13](#13-retargeting-or-rebuilding-ferrum-edge): restore the Nexus database,
point it at the new gateway, reconcile, and run `POST /api/admin/gateway/repair`.
That recreates consumers and replays ACL groups for **active** grants only,
revokes every credential row, and flags each API for
`POST /api/apis/:id/restore-gateway`. Every client must issue new credentials.

**Restoring only Nexus** against an Edge that has moved on makes the portal
describe the past: later approvals work at Edge but are invisible, later
revocations show as active while Edge refuses them, and later credential changes
can make credential positions unsafe. After restoring only Nexus, reconcile
`basicauth` for every consumer before relying on its positional mirror
([§12](#12-the-credential-mirror)).

### Recovery and rollback limits

A restore returns both stores to the backup. Everything after it is lost:

- **Later revocations are undone.** Grants revoked, accounts disabled and
  credentials revoked after the backup are active again, and their audit rows
  are gone. Keep revocation records elsewhere (email, exported audit logs,
  tickets) and re-apply them before reopening.
- **Later rotations are undone.** The old credential works again and the new
  one does not. If a rotation answered a leak, revoke the restored credential.
- **Later work is lost:** registrations, APIs, approvals, issued credentials
  (their holders now get `401`), messages and settings.
- **Sessions and email links come back** until they expire. After a compromise,
  rotate `NEXUS_SECRET_KEY` ([§7](#7-rotating-nexus_secret_key)) to invalidate
  them.
- **The outbox comes back as it was:** mail pending at backup time is sent
  again; mail queued later never is.

### Verifying a restore

Keep a canary, because show-once credentials cannot be recovered for testing
later: one provider API, one client with an approved grant, and one client whose
grant was **revoked**, each with a stored `keyauth` credential. Rehearse on a
copy first.

1. `GET /api/health` returns `200` with `status: "ok"`, `edge.status: "ok"` and
   `edge.reconciliation.status: "ok"`. As a `super_admin`, run
   `POST /api/admin/gateway/reconcile`: zero `orphaned_consumers`,
   `orphaned_proxies` and `awaiting_restore`.
2. As an administrator, check that `smtp.password_set` and `captcha.secret_set`
   are `true` where they were before, and send a test email. This proves
   `NEXUS_SECRET_KEY` is correct.
3. The approved canary's key works:

   ```bash
   curl -i -H "X-API-Key: $CANARY_KEY" "$GATEWAY_URL/<listen-path>/<operation>"
   ```

   The upstream answers. `401` means Edge lost the credential; `404` means the
   proxy is missing.

4. The revoked canary's key gets `403`. `200` means a revocation came back;
   `401` means the credential itself is gone, so the check proved nothing.
5. The portal shows the approved grant and credential `active` and the revoked
   grant `revoked`.
6. Re-apply revocations recorded outside the backup, then reopen.

CI runs steps 3–5 on every change (`e2e/src/dataplane.test.ts`, _restores Nexus
and Edge from one backup_) with PostgreSQL and a copy of Edge's database files.
It does not cover `GET /backup`/`POST /restore`, other drivers, or a different
Edge release.

---

## 6. The email outbox

Mail is never sent inline. `EmailService.enqueue` renders a template into an
`email_outbox` row, and a worker polls every 5 seconds to deliver it.

### Statuses

| Status    | Meaning                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `pending` | Queued, due now or at `next_attempt_at`.                                  |
| `sending` | Claimed by a worker. Claiming increments `attempts`.                      |
| `sent`    | Delivered.                                                                |
| `failed`  | Terminal after 5 attempts (`OUTBOX_MAX_ATTEMPTS`); `last_error` says why. |

Retries back off `30 s × 2^attempts`, capped at one hour, plus up to 10% jitter.

### `failed` has three meanings — read `last_error`

- **Not delivered:** attempts were exhausted or the relay refused permanently.
  `last_error` is the relay's message.
- **Delivered but unacknowledged:** `last_error` starts with
  `delivered-unacknowledged:`. The message reached the relay in full, but Nexus
  could not record success (the status write failed, the connection dropped
  after end-of-data, or the send deadline hit at that point). These rows are
  parked instead of retried to avoid a duplicate. **Re-driving one sends a
  second copy.**
- **Sealed and unreadable:** `last_error` starts with `sealed-unreadable:`. The
  row is a sealed message (see below) that did not open: it was altered, copied
  from another row, or sealed under a previous `NEXUS_SECRET_KEY`. Nothing was
  sent, and re-driving it fails the same way. The recipient requests a new
  link instead.

### Messages carrying a link are sealed

Verification, re-sent verification and password-reset messages carry a
single-use link, so they are never stored in plaintext. Their row has `subject`
`nexus:sealed:v1`, an empty `body_html`, and a `body_text` of
`nexus-sealed-v1:` followed by an AES-256-GCM envelope of the real subject and
bodies. The key is derived from `NEXUS_SECRET_KEY` (HKDF info
`nexus-outbox-v1`), and the envelope is bound to the row's `id` and `to_email`.
The worker opens it immediately before handing the message to SMTP. Other mail
(access decisions, messaging notifications, mass email) is stored as rendered.

After an upgrade, the worker seals rows queued by an earlier version in place,
in every status, up to 200 per tick, and stops looking once none are left. It
logs `Sealed legacy outbox messages` with a `sealed` count while it does. An
earlier version cannot open a sealed row. If a pre-fix instance claims one, it
emails ciphertext and burns the link. Before downgrading, fail every queued
sealed row so an older worker cannot claim it:

```sql
UPDATE email_outbox
SET status = 'failed', last_error = 'sealed-unreadable: downgrade'
WHERE subject = 'nexus:sealed:v1' AND status IN ('pending', 'sending');
```

For MongoDB, run the equivalent update on the `email_outbox` collection:

```javascript
db.email_outbox.updateMany(
  { subject: 'nexus:sealed:v1', status: { $in: ['pending', 'sending'] } },
  { $set: { status: 'failed', last_error: 'sealed-unreadable: downgrade' } },
);
```

An older instance still writing during a mixed-version deployment can leave
plaintext bearer rows; the next restart's legacy sweep seals them. Stop every
instance before starting the replacement release to avoid both cases.

A `sending` row untouched for five minutes is assumed abandoned and returned to
`pending`. This sweep runs at the start of every worker tick, on any instance.

The five-minute threshold is safe because rows are claimed one at a time and
each send has a hard 60-second deadline (`OUTBOX_SEND_BUDGET_MS`). Nodemailer's
own timeouts are set to 10 s (connect), 10 s (greeting) and 30 s (socket
inactivity), but those are per phase, not a total. A send cut off by the
deadline is recorded as delivered-unacknowledged if the whole message had been
written, and retried otherwise.

### Two workers, one row

The stale sweep decides by age alone, so it can hand a row to a second worker
while the first is still sending. Each claim carries an internal `generation`
token, and the settling writes (`markSent`, `reschedule`, `markFailed`) require
the claimed id, that token and `status = 'sending'`. A worker whose claim was
taken over logs `Outbox claim was reclaimed by another worker; this attempt did
not settle the row` and changes nothing.

### A mass-email campaign is one transaction

`POST /api/admin/mass-email` renders every message first, then inserts all
outbox rows and the `admin.mass_email` audit row in one transaction.

- **Retry with the same `idempotency_key`.** Rows are keyed
  `mass:<batch>:<user_id>`, so a retry after a lost response is a no-op. A
  failed campaign queues nothing and answers `500 OUTBOX_FAILURE` with
  `details: { batch_id, recipients, enqueued: 0 }`.
- **The audience is bounded** by `NEXUS_MAX_MASS_EMAIL_RECIPIENTS` (default
  5 000), checked before anything is rendered; over it is `429 QUOTA_EXCEEDED`
  with `details: { limit, recipients, setting }`. Two costs set the bound:
  - **MongoDB:** a transaction is capped at 16 MB, counting each row's rendered
    HTML and text. That is roughly 1 600 recipients at a 5 KB body, 800 at
    10 KB, and 80 at the 100 000-character maximum. Past it the campaign fails
    atomically.
  - **SQL backends:** no size cap, but the instance runs transactions one at a
    time, so a large fan-out stalls every other write on that instance while it
    runs.

  Raise the ceiling deliberately; prefer several smaller campaigns.

### The quiet failure mode to watch for

**With SMTP unconfigured, the worker claims nothing.** Mail accumulates in
`pending` instead of failing, so configuring SMTP later delivers the backlog. It
also means "no mail arriving" and "no errors in the log" can both be true.

SMTP settings are re-read on every tick, so fixes in the admin UI apply without
a restart.

### Monitoring

There is no outbox API; query the table.

```sql
-- queue health
SELECT status, count(*) FROM email_outbox GROUP BY status;

-- overdue pending rows (substitute now minus 10 minutes)
SELECT count(*) FROM email_outbox
 WHERE status = 'pending'
   AND (next_attempt_at IS NULL OR next_attempt_at < '2026-08-31T09:00:00.000Z');

-- recent failures
SELECT to_email, attempts, last_error, updated_at
  FROM email_outbox WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 20;
```

Alert on growth in `failed`, `pending` rows older than about 15 minutes, and
`sending` rows older than about 10 minutes (the worker is not ticking).

The worker logs these at `warn`:

- `Outbox message delivery failed, retrying later`
- `Outbox message failed permanently`
- `Released stale outbox claims` (with a `released` count; a steady trickle
  means crashes, and possibly duplicate mail)
- `Outbox message was delivered but could not be marked sent; parked to avoid a duplicate`
- `Outbox message was delivered but its row could not be updated at all; a retry may duplicate it`
- `Outbox claim was reclaimed by another worker; this attempt did not settle the row`
  (a steady trickle means deliveries take close to the stale threshold)
- `Outbox message was abandoned mid-flight; it is recovered by the stale sweep`
- `Could not release stale outbox claims`
- `Sealed outbox message could not be opened` (the row is failed as
  `sealed-unreadable:`)
- `Could not seal legacy outbox messages` (retried on the next tick)
- `Outbox tick failed`

**Re-driving `failed` rows.** First exclude delivered-unacknowledged ones:

```sql
SELECT to_email, attempts, last_error, updated_at
  FROM email_outbox
 WHERE status = 'failed' AND last_error LIKE 'delivered-unacknowledged:%';
```

Also leave out `sealed-unreadable:` rows; they cannot be delivered. Re-drive
the others by setting `status = 'pending'`, `attempts = 0` and
`next_attempt_at = NULL`. The row keeps its `idempotency_key`. Confirm a
delivered-unacknowledged row with the recipient or relay logs before re-sending
it.

### Atomic admin settings saves

One `PUT /api/admin/settings` commits its settings rows, encrypted SMTP/CAPTCHA
values and the `admin.settings_update` audit row in one transaction; any failure
rolls back the whole change. The audit row records changed key names and SMTP
password-source changes (`override` or `environment`), never values. MongoDB
standalone mode has no rollback guarantee.

---

## 7. Rotating `NEXUS_SECRET_KEY`

Two subkeys are HKDF-derived from `NEXUS_SECRET_KEY`:

| Subkey                            | HKDF `info`             | Protects                                                                        |
| --------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| Settings encryption (AES-256-GCM) | `nexus-settings-v1`     | `app_settings` rows with `encrypted = 1`: `smtp.password`, `captcha.secret_key` |
| Session token HMAC (HMAC-SHA-256) | `nexus-session-hmac-v1` | `sessions.token_hash`, `email_verification_tokens.token_hash`                   |

Passwords are hashed with scrypt and a random salt, independent of the key, so
password sign-in survives a rotation.

### What rotation does and does not affect

Swapping the key without re-encrypting breaks the encrypted settings:

- **SMTP sends no password.** Nexus does not fall back to `NEXUS_SMTP_PASSWORD`
  (that would send the environment relay's secret to the stored relay). Mail
  fails, a `warn` says the stored password cannot be decrypted, and
  `smtp.password_set` reads `false` until a super admin re-enters it.
- **CAPTCHA fails closed** (`CAPTCHA_FAILED`, "CAPTCHA is enabled but not fully
  configured"), so registration **and login** stop working.

`npm run rotate-secret-key` (in an image: `node server/dist/db/rotate-key-cli.js`)
avoids this. It re-encrypts every encrypted `app_settings` row from
`NEXUS_SECRET_KEY_PREVIOUS` to `NEXUS_SECRET_KEY` in one transaction, and writes
nothing if any row fails to decrypt with the previous key. Both keys come from
the environment, never from arguments. It prints only counts and setting names.

A rotation still invalidates every session and every unused email-verification
and password-reset token, because their hashes used the old HMAC key. For the
same reason the rotation does not re-seal queued mail: a verification or reset
message still in the outbox was sealed under the old key, so the worker fails
it as `sealed-unreadable:` instead of sending a link that no longer works.

### Procedure

1. **Announce a short window.** Everyone will be signed out.
2. **Back up** the database ([§5](#5-backup-and-restore)) and record the current
   key.
3. **Stop every Nexus instance**, so nothing writes under the old key.
4. **Persist the new key first, then rotate.** The environment wins over `.env`,
   so a new key that exists only in your shell while `.env` still has the old
   one causes a lockout at the next restart.

   ```bash
   # 1. Generate the new key and store it where the server reads its config
   #    (NEXUS_SECRET_KEY in .env, or the container environment).
   openssl rand -hex 32

   # 2. Rotate, exporting only the previous key:
   export NEXUS_SECRET_KEY_PREVIOUS="<the key the database was last written with>"
   npm run rotate-secret-key                  # from a checkout
   node server/dist/db/rotate-key-cli.js      # from a built image
   # Re-encrypted 2 setting(s) under the new NEXUS_SECRET_KEY (captcha.secret_key, smtp.password); …
   ```

   The CLI exits non-zero and changes nothing if:
   - the `.env` it loaded has a different `NEXUS_SECRET_KEY` than the one it
     would rotate to (pass `--allow-env-mismatch` only if that file is not this
     deployment's configuration);
   - the previous key is missing, shorter than 32 characters, or wrong;
   - the two keys are equal, or the rotation already ran.

5. **Start the server** with the new key and without `NEXUS_SECRET_KEY_PREVIOUS`.
6. **Verify as a super admin:** sign in (with CAPTCHA on, this proves the secret
   survived), then **Send test email** on the settings page returns `ok: true`.
7. **Optional cleanup** of rows that are now inert:

   ```sql
   DELETE FROM sessions;
   DELETE FROM email_verification_tokens WHERE used_at IS NULL;
   -- lets users request a new verification email immediately:
   DELETE FROM email_token_issue_claims WHERE purpose = 'email_verification';
   ```

   Users with an unused verification link click **Resend verification** on the
   sign-in page (normally limited to once per ten minutes). There is no admin
   control to mark a user verified.

8. **Watch the outbox** (`SELECT status, count(*) FROM email_outbox GROUP BY status`)
   and re-drive failures from the window ([§6](#6-the-email-outbox)).

**Rollback:** run the same command with the keys swapped
(`NEXUS_SECRET_KEY_PREVIOUS` = new key, `NEXUS_SECRET_KEY` = old key) before the
server saves anything under the new key, then restart with the old key. Both
keys must be stored somewhere durable; a key that only lived in a closed shell
is gone.

**If you cannot run the command** (for example, a hosted database reachable only
through the portal): as a super admin, turn CAPTCHA off first, then swap the key
and restart, sign in, re-enter the SMTP password and CAPTCHA secret, turn CAPTCHA
back on, and test a sign-out/sign-in.

### Rotating `FERRUM_ADMIN_JWT_SECRET`

This is a shared secret between Nexus and the gateway, not an encryption key.
Change it on both and restart both. In between, every Admin API call fails with
`502 EDGE_ERROR` ("The gateway rejected the Nexus admin credentials"): browsing
works, but publishing, approvals and credential operations do not. Nothing
stored is affected.

---

## 8. Scaling

### How gateway writes are coordinated

The Edge Admin API's `PUT /consumers/{id}` and `PUT /proxies/{id}` replace the
whole resource with no concurrency token. Nexus changes them by
read-modify-write, so two interleaved changes can lose one:

- On a **consumer**, a revocation and an approval can both read `[A]`; one
  writes `[]`, the other `[A, B]`, and A stays authorized.
- On a **proxy**, two plugin changes can each drop the other's entry, for
  example leaving an API with no auth plugin.

Nexus serializes these writes in two layers:

1. **An in-process queue per resource**, ordering requests on one instance.
2. **A lease row in `edge_leases`**, ordering instances. One row per resource
   (a consumer id, or `proxy:<id>`) holds an owner token and an expiry.

Every path that rewrites a gateway resource takes the same key: approvals and
revocations, credential issue/rotate/revoke, account-disable teardown, backend
and runtime-setting changes, plugin changes, API deletion, the enforcement-mode
rebuild, and their rollback steps. The only exception is publishing a new API,
whose proxy id does not exist until it is created. An API delete strips each
grantee's ACL group afterwards, under that grantee's own consumer key.

| Setting             | Value             | Meaning                                  |
| ------------------- | ----------------- | ---------------------------------------- |
| Lease TTL           | 60 s              | Validity of a lease without renewal.     |
| Renewal             | every 30 s        | A long operation renews at half the TTL. |
| Wait before failing | 30 s              | How long a blocked operation waits.      |
| Poll interval       | 100 ms (jittered) | How often a waiter retries.              |

- **A crash is not a deadlock.** The lease stops being renewed and another
  instance takes it after expiry, at most 60 s later. `edge_leases` needs no
  maintenance.
- **Under contention** a request that cannot get the lease in 30 s fails with
  `409 CONFLICT`: "Another portal instance is updating this gateway resource
  right now — please retry". Nothing was written. If this is routine, look for a
  slow Admin API.
- **Edge does not understand the lease.** A holder paused past the TTL, or on a
  badly skewed clock, can resume after another instance took over, and Edge will
  accept its stale `PUT`.
- **The Nexus database is fenced.** Every transaction under a lease re-checks
  the lease owner before committing, so a stale holder's database writes fail
  with `409 CONFLICT` and roll back. Such a `409` is safe to retry. See
  [`security.md`](security.md#cross-instance-locks-are-fenced-at-commit).

### When a gateway change cannot be taken back

Edge has no multi-resource transaction. Operations that touch several gateway
objects (publish, API `PATCH`, spec revision) register an undo step **before**
each write and replay them in reverse if a later step fails. A write that timed
out may still have applied, so undo steps are idempotent and scoped to the fields
their step wrote.

An undo step that fails does not raise (it would hide the original error). It
writes an audit row and logs at `error`. Nothing repairs these automatically,
so alert on each:

| Row                           | Meaning                                                                                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.gateway_repair_required` | A change could not be undone. `details.phase`: `conversion` or `rollback` means a `spec_enforcement` rebuild left the API with **no proxy**; `compensation` means the proxy exists but fields listed in `details.steps` may not match the catalog. |
| `api.publish_rollback`        | A publish reached the gateway, then failed. `withdrawn: true` needs nothing. `withdrawn: false` means `details.stranded_proxy_id` may still be live on a staging path with no `apis` row.                                                          |
| `api.plugin_rollback`         | A palette plugin change failed. `restored: true` needs nothing. `restored: false` means the config in `details.plugin_config_id` may still hold the attempted change; `details.step_errors` says which step failed.                                |

```sql
SELECT created_at, action, target_id AS api_id, details
  FROM audit_logs
  WHERE action IN ('api.gateway_repair_required', 'api.publish_rollback', 'api.plugin_rollback')
  ORDER BY created_at DESC;
```

Repairs:

- **`api.plugin_rollback`, `restored: false`:** read the config with
  `GET /plugins/config/{id}`, compare with the API's palette entry, and fix the
  gateway, or ask the provider to re-save the plugin.
- **`api.publish_rollback`, `withdrawn: false`:** check `GET /proxies/{id}`. If
  it exists, nothing in the portal owns it; delete it. Nexus never reuses a
  stranded id, so this cannot affect the provider's retry.
- **`api.gateway_repair_required`, `phase: "compensation"`:** compare the fields
  in `details.steps` with the catalog and fix the gateway, or ask the provider
  to re-submit the `PATCH`.

There is deliberately no automatic sweep: deleting every proxy without an `apis`
row would also delete proxies operators created outside the portal.

### The same table guards the last super admin

"Do not remove the last active `super_admin`" is a count followed by a write.
One process's transaction makes that atomic, but two instances could each count
the other's admin and both demote. So every change that can shrink the set (role
change away from `super_admin`, `status: "disabled"`, god mode's
`disable-user`) runs under one lease key, `users:super-admins`. The loser waits,
re-counts, and gets `409 LAST_SUPER_ADMIN` with nothing written. Promotions and
re-enables take no lock.

A second key, `users:lifecycle:<user_id>`, orders an account's status changes
against registering a new gateway identity for it
([§11](#11-gateway-revocation-for-disabled-accounts)). It is always taken inside
`users:super-admins` when both are needed.

Both behave like gateway leases. A `409 CONFLICT` saying "Another administrator
change is in flight right now — please retry" means two admins changed
administrator accounts at the same moment; retry.

### Supported topologies

> **Run exactly one active Nexus instance that can perform gateway mutations.**

A single instance, or active/passive with only one instance serving at a time,
is supported. Sticky routing is not a substitute: different users can still
target the same consumer or proxy, and an expired lease cannot fence a stale
writer at Edge.

Standby instances must not serve requests or run background workers until
promoted. Active/passive needs one shared PostgreSQL, MySQL or MongoDB
replica-set database. SQLite cannot be shared, so SQLite means one instance.

### Other multi-instance notes

- **The outbox and teardown workers are safe on several instances.** Claims are
  atomic, and any instance's stale sweep recovers another's abandoned claims.
- **Sessions live in the database**, so any instance serves any session.
- **Rate limiters are per process** (N instances allow N × the limit).
- **The admin-JWT cache is per process.** Harmless.
- **A generated bootstrap token is per process.** Set `NEXUS_BOOTSTRAP_TOKEN`.
- **The health-probe cache (5 s) and the metrics cache (10 s) are per process**,
  so two instances may briefly disagree.

### Sizing

Each instance opens up to 10 connections per SQL pool. Transactions are
serialized per instance, so that is plenty. Set the database's
`max_connections` to roughly `10 × instances + headroom`.

---

## 9. Health checks

| Endpoint               | Use for                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `GET /api/health`      | Liveness and readiness. `status` is `ok`, `degraded` or `down`.  |
| `GET /api/health/edge` | Gateway state only. Skips the database and always answers `200`. |

Both are public.

**Probe on the status code.** `/api/health` answers `503` only when the
database probe fails (`status: "down"`); replace the process then. `200` covers
`ok` and `degraded`. **Keep a `degraded` portal in rotation**: the catalog,
messaging and audit log still work, while publishing, approvals and credential
operations fail with `502 EDGE_UNAVAILABLE` until the gateway returns. Monitors
and dashboards should read the body.

The overall status is `degraded` when any of these holds:

- **`edge.status: "down"`**: the gateway is unreachable.
- **`edge.status: "not_ready"`**: the gateway answers but reports
  `ready: false` (starting, draining or unavailable).
- **`edge.status: "degraded"`** with `edge.reason: "namespace_unserved"`: the
  gateway does not route this portal's namespace. Published APIs answer `404`.
  See [Namespace routability](#namespace-routability); it will not recover by
  itself.
- **`edge.reconciliation.status: "orphaned"`**: the gateway is reachable but no
  longer holds the consumer or proxy ids Nexus stored (it was retargeted or
  rebuilt).

The `edge.reconciliation` block reports the last reconciliation pass:

```json
{
  "status": "orphaned",
  "checked_at": "2026-09-11T18:22:05.412Z",
  "orphaned_consumers": 14,
  "orphaned_proxies": 3,
  "awaiting_restore": 2,
  "complete": true
}
```

- `status` is `ok`, `orphaned` or `unknown` (no pass has finished, or the last
  one could not read the gateway). **Alert on `orphaned`**; the repair is in
  [§13](#13-retargeting-or-rebuilding-ferrum-edge).
- `awaiting_restore` counts APIs flagged for a gateway restore. It keeps
  `status` at `orphaned` until they are restored, even if the gateway is
  unreachable.
- The count fields are `null` for callers below `admin`. Error details and the
  gateway's `mode` are also admin-only.
- Health requests never run a pass. Passes run at startup and every
  `NEXUS_GATEWAY_RECONCILE_INTERVAL_MS`.

**Caching and rate limits.** Each dependency is probed at most once per
`NEXUS_HEALTH_CACHE_MS` (default 5 s) and concurrent callers share the probe. A
failure is cached too, so recovery can take up to the TTL to show; keep it
below your probe interval. The top-level `checked_at` says when the probes ran.
With rate limiting on, `/api/health*` allows 120 requests per minute per client
IP (`429 RATE_LIMITED` above), so set `NEXUS_TRUSTED_PROXIES` correctly.

```bash
curl -sf http://127.0.0.1:8787/api/health | jq '.status, .database.status, .edge.status'
```

### Logging

Structured JSON (pino) at `NEXUS_LOG_LEVEL`. Unhandled 5xx errors log at
`error` with the URL and error; other error responses log at `debug` with
`{ code, status, url }`.

Gateway errors log at `error` as `Ferrum Edge Admin API returned an error`. For
a gateway `400`, `409` or `422`, the message is also returned to the caller in
`EDGE_ERROR.details.gateway_message`. For `401`, `403` and `5xx` it is **only**
in the log, so check here when a provider reports an unexplained `EDGE_ERROR`.

Spec parse or validation rejections from Edge are `400 EDGE_REJECTED_SPEC` with
`details.gateway_message` and `details.gateway_code`; the full gateway response
is logged as `gateway_response`. A request-serialization bug logs `Ferrum Edge
Admin API request serialization failed` and returns `500 INTERNAL`; it does not
mean the gateway is down.

### Shutdown

`SIGINT`/`SIGTERM` shut down gracefully: the outbox, gateway-teardown,
expiry-sweep and reconciliation workers stop, the Admin API client closes,
Fastify drains, and the store closes. Allow a few seconds of termination grace.
Anything a worker had claimed but not finished is recovered by a stale sweep five
minutes after the claim.

---

## 10. Metrics

Nexus is not a metrics system. It has no `/metrics` endpoint and stores no time
series. It reads the gateway's telemetry on demand to show providers usage for
their APIs.

### Nexus emits nothing; point Prometheus at Edge

Scrape Ferrum Edge directly:

- **`GET /metrics`**: Prometheus exposition. Per-API traffic is in
  `ferrum_requests_total{proxy_id, method, status_code, grpc_status, error_class, namespace}`
  and the `ferrum_request_duration_ms{proxy_id, le, namespace}` histogram.
- **`GET /admin/metrics`**: a JSON snapshot of circuit breakers, health checks,
  connection pools, caches and rate limiters.

Both require an admin JWT, the `FERRUM_METRICS_BEARER_TOKEN`, or a source
address in `FERRUM_METRICS_ALLOWED_CIDRS`. Prefer the token or CIDR list for
Prometheus:

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

At startup Nexus makes sure a namespace-global `prometheus_metrics` plugin
config exists (created `enabled: true` with `config: {}` if missing; an existing
one, even disabled, is left alone). Creating it logs `Created the Ferrum Edge
namespace-global metrics config` and writes a `gateway.metrics_enable` audit
row. Failure is logged and does not block startup; restart Nexus to retry. Only
traffic after the plugin is enabled is counted.

An API with no `ferrum_requests_total` series for its own `proxy_id` shows
`available: false` with an `unavailable_reason` instead of zero counters.

To match a dashboard to a portal API, use the `proxy_id` label: it is the
`ferrum_proxy_id` on the `apis` row, shown as **Edge proxy id** on the API page.

### What Nexus shows, and its cache

`GET /api/apis/:id/usage` (the provider's **Usage** card) reads both gateway
endpoints and shows request counts by status class and method, `429`/`401`/`403`
totals, estimated p50/p95/p99 latency, and a backend verdict from the proxy's
circuit breaker and ejected targets.

| Layer   | Cache                                          |
| ------- | ---------------------------------------------- |
| Edge    | 5 s, for both endpoints                        |
| Nexus   | 10 s, shared across proxies, per process       |
| The SPA | refetches every 30 s while an API page is open |

So the card can lag by about 15 seconds, and instances may briefly disagree.
Do not bill from it.

- **Load:** at most one scrape per Nexus process per 10 s.
- **Gateway problems never return 5xx.** The route answers `200` with
  `available: false` and logs at `warn` (`Ferrum Edge metrics scrape could not
reach the gateway`, `… returned a non-2xx status`, `… produced no parseable
samples`). Watch the log, not the status.
- **Counters reset when the gateway restarts.** `gateway_uptime_seconds` shows
  how far back they go.
- **There is no per-consumer breakdown**: `ferrum_requests_total` has no consumer
  label. Use Edge's access logs for that.

---

## 11. Gateway revocation for disabled accounts

Disabling an account also has to remove its access at Edge: every ACL group off
its consumers and every credential deleted. Until that happens, its API keys
keep working. The Edge calls cannot join the database transaction, so the
disable writes a `gateway_teardown_jobs` row **in the same transaction** as
`users.status = 'disabled'`, tries the teardown immediately, and leaves the job
for a worker if Edge refuses. See [`security.md`](security.md#disabling-an-account).

### Statuses

| Status    | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| `pending` | Owed, due now or at `next_attempt_at`. **Credentials are still live.** |
| `sending` | Claimed by a request or the worker; claiming increments `attempts`.    |
| `done`    | Edge confirmed the teardown; `completed_at` says when.                 |

There is **no terminal failure state**. Retries back off `10 s × 2^attempts`,
capped at five minutes, plus up to 10% jitter, for as long as the account stays
disabled. Re-enabling the account deletes the job. There is one job per account;
disabling again resets it.

A `sending` job untouched for five minutes returns to `pending` at the start of
every worker tick. One job is five Edge calls (each bounded by
`FERRUM_ADMIN_TIMEOUT_MS`) plus up to 30 s waiting for the consumer's lease:
about 55 s at the defaults. The five-minute threshold is a fixed constant, so if
you raise `FERRUM_ADMIN_TIMEOUT_MS` toward its 60 s maximum, a slow gateway can
look like a crashed worker. Each claim carries an internal `generation` token,
so a superseded attempt cannot settle a newer job.

### Which identities a teardown finds

The account's canonical consumer comes from `consumers`. Other identities (a
provider's `nexus-test-<api_id>` test consumer) are found through:

- **`gateway_identities`**, where a test consumer is registered **before** it is
  created on the gateway, under the account's `users:lifecycle:<user_id>` lease.
  A disable that lands mid-creation therefore still finds it. The registration
  is deleted once its consumer is gone.
- **Live `credential_metadata` rows**, for consumers created before that table
  existed.

If an identity is registered after the account's job closed (a failed cleanup),
the job is reopened and the worker removes the consumer.

`DELETE /api/apis/:id` tears down the API's own `nexus-test-<api_id>` consumer
after deleting the proxy and before dropping the portal rows. If that fails, the
delete answers `502 EDGE_ERROR` and the API stays in the catalog to be deleted
again. The `api.delete` audit row names `test_consumer_id` and
`test_consumer_revoked_credentials` when there was one.

### Monitoring

```sql
-- revocation owed now
SELECT status, count(*) FROM gateway_teardown_jobs GROUP BY status;

-- stuck jobs
SELECT user_id, attempts, last_error, next_attempt_at, updated_at
  FROM gateway_teardown_jobs WHERE status <> 'done'
  ORDER BY updated_at DESC LIMIT 20;

-- identities still registered to disabled accounts
SELECT gi.user_id, gi.ferrum_username, gi.ferrum_consumer_id, gi.updated_at
  FROM gateway_identities AS gi
  JOIN users AS u ON u.id = gi.user_id
 WHERE u.status = 'disabled';
```

`GET /api/users` (admin) reports the backlog (`pending` plus `sending`) as
`pending_gateway_teardowns`, and `GET /api/users/:id` includes the account's
`gateway_teardown` state. The admin **Users** page shows a _Gateway revocation
pending_ or _Gateway revocation in progress_ badge with a **Retry** button.

**Alert on this `warn` line** (fields `user_id`, `attempts`, `error`):

```
Gateway revocation for a disabled account failed; it stays queued for retry
```

One occurrence during an Edge restart is expected. Repeats for the same
`user_id` mean a disabled account still has working credentials. The worker
also logs `Gateway revocation retry failed; the credentials are still live`,
`Gateway revocation for a disabled account completed`,
`Released stale gateway teardown claims`,
`Gateway teardown job was abandoned mid-flight; it is recovered by the stale sweep`,
`Could not release stale gateway teardown claims` and
`Gateway teardown tick failed`.

**Also alert on these `warn` lines** from the credentials service, logged when
cleanup after a failed request could not finish (fields `user_id`,
`consumer_username`, `error`, and `consumer_id` for the second):

```
an abandoned gateway identity could not be resolved; its registration was kept for teardown
an abandoned gateway identity could not be deleted; its registration was kept for teardown
```

They are the only sign that a `nexus-test-<api_id>` consumer may still exist.
Its registration is kept, so the account teardown or the API delete will collect
it; retrying the original request usually clears it.

**And on this one**, from the password-reset and verification endpoints (fields
`purpose`, `error`):

```
an email token could not be issued; the caller was answered uniformly
```

The caller got the normal `200 { "ok": true }` but no email. Retrying works, but
repeats mean self-service recovery is silently broken.

### Re-driving one by hand

`POST /api/users/:id/gateway-teardown/retry` (admin, CSRF) re-queues the job and
runs it at once, returning `gateway_teardown: "ok"` if Edge accepted or
`"pending"` if not. It is audited as `user.gateway_teardown_retry` and is the
**Retry** button on the Users page. Do not edit the table by hand.

---

## 12. The credential mirror

Edge credential entries have **no id**, and reads redact the secret. Nexus
identifies an entry by position: `POST` appends, and
`DELETE /consumers/{id}/credentials/{type}/{i}` removes by 0-based index. Nexus
writes one `credential_metadata` row per append, with an **`edge_ordinal`**
that increases per consumer and type, assigned under the same per-consumer lock
as the Edge append. The non-revoked rows for a `(consumer, type)` pair, ordered
by ordinal, **mirror** the Edge array; a row's position is its index.

Every destructive call checks the mirror against the live array length, read in
the same critical section.

### The `retiring` status: a retirement recorded before it is attempted

Before deleting an entry, Nexus moves its row to **`retiring`**, and after Edge
confirms, to `revoked`. `retiring` still counts as a live slot. It means "the
gateway entry behind this row may already be gone".

Without it, a delete that Edge applied but never acknowledged would leave the
mirror one row longer than the array forever, and every later rotate and revoke
of that type would be refused as drift.

When the next rotate, revoke or issue on the same pair finds **the mirror
exactly one row longer than the array and exactly one live row `retiring`**, it
settles that row to `revoked`, writes a `credential.settle` audit row, and
continues.

### Two kinds of `retiring` row, and how to tell them apart

1. **The entry is gone; only the acknowledgement was lost.** The mirror is one
   row longer than the array. The next operation on the pair settles it; do
   nothing.
2. **The delete failed and the entry is still live.** Lengths **agree**, so it
   never settles by itself. Positions still resolve and the credential can still
   be revoked. **Retry the revoke (or rotate).**

When a delete reports failure, Nexus re-reads the array; if the length is
unchanged it knows the delete did not apply and puts the row back to `active`.
Shape 2 only remains when that could not be proved (the array could not be read,
its length changed for another reason, or the restore itself failed).

`basicauth` is never settled automatically: Edge omits it from reads, so its
array length is unknown and neither shape can be told apart. See the next
section.

### `basicauth`: an unconfirmed outcome blocks positions

For `basicauth` the portal's rows are the only record of where each entry
sits. A `basicauth` row is therefore written as `retiring` **before** its
append and becomes `active` only once Edge acknowledges it. An append whose
outcome cannot be confirmed (a lost acknowledgement, a `408` or `5xx`, or a row
that could not be activated) fails the request and leaves the row `retiring`,
with a `credential.append_rollback` row (`withdrawn: false`,
`stranded_credential_id`). A delete whose outcome cannot be proved also stays
`retiring`.

While any `basicauth` row of a consumer is `retiring`, positions are unknown,
so issuing, rotating and revoking a single credential by position return
`409 CONFLICT` with
`details: { consumer_id, credential_type, unconfirmed_credentials, active_credentials }`.
Nothing is deleted. The message names the repair that applies:

- **No `active` row left:** revoke the retiring credential. With no other
  `active` row of the type, a revoke deletes the whole type on the gateway and
  settles every `retiring` row with it (named in the `credential.revoke` row's
  `swept_credential_ids`).
- **`active` rows remain:** revoke with
  `DELETE /api/credentials/:id?clear_type=true`, which deletes every HTTP Basic
  credential of that consumer, active ones included. The credentials page
  offers this as a second confirmation, "Revoke all HTTP Basic credentials",
  only after a plain revoke was refused this way. `clear_type` is refused for
  other types (`400`), and for a non-admin when the consumer holds a row
  attributed to another account (`403`).
- Either way, **an administrator can [reconcile](#reconciling-one) the
  consumer** for `basicauth`.

Then issue new credentials. To find affected consumers:

```sql
SELECT ferrum_consumer_id, COUNT(*) AS unconfirmed
  FROM credential_metadata
  WHERE credential_type = 'basicauth' AND status = 'retiring'
  GROUP BY ferrum_consumer_id;
```

**Upgrading from `v0.2.0` or earlier.** On the first start after the upgrade,
Nexus scans the audit log for `credential.append_rollback` rows with
`credential_type: "basicauth"` and `withdrawn: false` that no live row
accounts for: those without `stranded_credential_id` (what earlier releases
wrote for a lost acknowledgement or a failed row write) and those whose
stranded row is no longer live. For each one that no later `basicauth`
reconcile or whole-type revoke of the consumer has cleared, it writes a
`retiring` placeholder row, audited as `credential.legacy_placeholder` with
`source_event_id`. The placeholder holds that consumer's positions closed, as
above, until the type is cleared. Completion is recorded in `app_settings`
(`credentials.legacy_basicauth_scan_v1`), and later starts skip the scan.
Affected identities may need to re-issue their Basic Auth credentials after
the type is cleared, especially when a replacement from an earlier v0.2.0
rotate was later revoked normally and the scan conservatively restores its
placeholder.

If the scan fails, startup continues and logs `Could not scan for HTTP Basic
credentials left unconfirmed by an earlier release`; nothing is recorded, so
the next start runs it again. Until it completes, reconcile `basicauth` for any
consumer with such a rollback row.

**The scan does not cover restores.** It runs once, and a backup taken after
the upgrade carries its completion marker. A Nexus database restored on its own
can be older than the gateway's HTTP Basic entries, which no read can reveal.
After restoring only Nexus, reconcile `basicauth` for every consumer before
relying on revoking a single HTTP Basic credential
([§5](#5-backup-and-restore)).

If an append is in flight while a whole-type revoke runs and the lease fence
prevents the append holder from activating its row, the issue response fails
and Nexus restores that undelivered credential's row to `retiring`. Clear the
type before issuing again.

### Consumer identity recovery

Canonical consumers use a stable derived id, recorded in `consumers`; provider
test consumers are recorded in `gateway_identities`. Normal provisioning does
not list the namespace. Keep these tables in every backup, and never change a
consumer's id or username on Edge.

Older identities without a portal mapping are adopted after a create conflict by
scanning at most 20 pages of 500 consumers. An incomplete scan returns
`EDGE_ERROR` with a recovery instruction, never "no consumer", and teardown keeps
its job and registration.

If that limit is reached:

1. Back up the portal database and pause Nexus during maintenance.
2. Restore the affected mapping from a consistent Nexus backup: the `consumers`
   row, or the identity's `ferrum_consumer_id` in `gateway_identities`, with the
   correct owner and namespace.
3. Verify it with `GET /consumers/{id}` under the right `X-Ferrum-Namespace`:
   the username must be exactly `nexus-user-<user_id>` or the registered
   `nexus-test-<api_id>`.
4. With no backup, inventory the gateway with paginated Admin API reads and
   rebuild the mapping after the same checks. Do not delete gateway identities
   or credentials to shorten the scan.
5. Resume Nexus and retry the operation or pending teardown.

### What a drifted consumer looks like

Drift that a single pending retirement does not explain (a consumer edited
outside Nexus, or two rows retiring at once) makes rotate and revoke return
`502 EDGE_ERROR`:

> The gateway credential list does not match the portal. An administrator must
> reconcile this consumer …

with `details: { expected, actual }` (live portal rows, Edge array length).
Exception: with a single live row, a revoke deletes the whole credential type,
which is what the revoke wanted anyway.

This refusal is deliberate: acting on a stale index deletes someone else's key.
Look for pending retirements:

```sql
SELECT ferrum_consumer_id, credential_type, COUNT(*) AS retiring
  FROM credential_metadata
  WHERE status = 'retiring'
  GROUP BY ferrum_consumer_id, credential_type;
```

For one such row, compare the pair's live-row count with the array in
`GET /consumers/{id}`: one longer settles by itself (shape 1); equal means retry
the operation (shape 2). More than one row, or none while lengths still differ,
needs [reconciliation](#reconciling-one). A `retiring` `basicauth` row has no
array to compare against; see
[the `basicauth` section](#basicauth-an-unconfirmed-outcome-blocks-positions).

### What an unresolved credential position looks like

A row with `edge_ordinal = NULL` has an unknown position. A single such row is
treated as index 0; two or more make rotate and revoke of those rows return
`409 CONFLICT`:

> The gateway position of this credential cannot be determined …

with `details: { consumer_id, credential_type, unresolved_credentials }`. New
credentials on the same consumer are unaffected. To find them:

```sql
SELECT ferrum_consumer_id, credential_type, COUNT(*) AS unresolved
  FROM credential_metadata
  WHERE edge_ordinal IS NULL AND status <> 'revoked'
  GROUP BY ferrum_consumer_id, credential_type
  HAVING COUNT(*) > 1;
```

### Reconciling one

The only repair that needs no guessing is to **empty the type and re-issue**:

```http
POST /api/admin/credentials/reconcile
{ "consumer_id": "<edge consumer id>", "credential_type": "keyauth", "reason": "…" }
```

Under the consumer's lock it deletes the whole credential type on the gateway,
moves every live portal row for the pair to `revoked`, writes a
`credential.reconcile` audit row, and notifies each affected account. The
response reports `revoked_credentials` and `gateway_cleared` (whether the
consumer still existed). It is admin-only, idempotent and **destructive**: every
credential of that type on that consumer stops working. It answers
`403 FORBIDDEN` for a consumer the portal does not own (no mapping, registered
identity or credential rows).

Check what the portal thinks is live first:

```sql
SELECT id, credential_type, last4, status, edge_ordinal, created_at
  FROM credential_metadata
  WHERE ferrum_consumer_id = '<edge consumer id>' AND status <> 'revoked'
  ORDER BY edge_ordinal;
```

Then have the account holder issue new credentials; the old secrets cannot be
recovered.

**Failed rotations usually need none of this:**

- **At the cap**, the old entry is deleted before the new one is appended. If
  the append fails, the error says the previous credential was removed and a
  new one must be issued; everything else stays revocable.
- **Below the cap**, the new entry is appended first. If deleting the old one
  fails, Nexus removes the new entry and returns the original error. Both
  outcomes write `credential.append_rollback`. If the new entry cannot be
  removed, the error message says which case applies:

  > The gateway did not acknowledge removing the previous credential and no longer
  > holds it; the replacement created in its place is live but its secret was
  > never delivered — revoke the credential named here and issue a new one

  The delete applied; the `retiring` row is shape 1 and settles itself. Do
  **not** reconcile.

  > The previous credential could not be removed from the gateway and the
  > replacement created for it could not be taken back; the portal holds a live
  > row for each — revoke the credential named here and try again

  Both sides agree; the account holder revokes the named credential.

  > The previous credential could not be removed from the gateway and the
  > replacement created for it could not be taken back; an administrator must
  > reconcile this consumer

  Genuine drift; reconcile.

All three carry `details.stranded_credential_id` and
`details.retired_credential_id`. Audit rows with `withdrawn: false` find gateway
entries nobody holds, including suspected ones (`suspected: true`) where an
append's `POST` failed and Nexus could not prove whether it applied:

```sql
SELECT created_at, target_id AS consumer_id, details
  FROM audit_logs
  WHERE action = 'credential.append_rollback'
  ORDER BY created_at DESC;
```

---

## 13. Retargeting or rebuilding Ferrum Edge

Nexus stores two kinds of gateway ids: `consumers.ferrum_consumer_id` (one
consumer per account per namespace) and `apis.ferrum_proxy_id` (one proxy per
API). They cannot be re-derived.

If `FERRUM_ADMIN_URL` points at a different Edge, or the gateway is rebuilt,
those ids point at nothing. New accounts and new publishes work, but:

- approving access or issuing a credential for an existing account answers
  `502 EDGE_ERROR` ("The gateway consumer for this account no longer exists");
- existing APIs have proxy ids that `404`, and serve nothing.

### The signal

A reconciliation pass asks Edge about each stored reference. It runs at startup,
every `NEXUS_GATEWAY_RECONCILE_INTERVAL_MS` (15 min default), and on demand. The
result appears as `edge.reconciliation` on both health endpoints
([§9](#9-health-checks)); `status: "orphaned"` degrades the portal, and the
server logs `The gateway no longer holds references the portal stored; run the
gateway repair …` at `warn`.

Only a `404` counts as an orphan. Any other error (connection refused, `500`,
rejected JWT) ends the pass with `status: "unknown"`, so a flaky gateway is
never mistaken for a rebuilt one. Each pass checks at most
`NEXUS_GATEWAY_RECONCILE_SAMPLE` references of each kind (200 default) and
reports `complete: false` if it stopped there.

To run a pass now and see the details:

```http
POST /api/admin/gateway/reconcile
```

`super_admin` only. It returns per-kind `checked`/`orphaned`/`complete` counts
plus `orphaned_consumers` (`user_id`, `ferrum_consumer_id`, `ferrum_username`)
and `orphaned_proxies` (`api_id`, `slug`, `ferrum_proxy_id`), and writes a
`gateway.reconcile` audit row.

### The repair

**Nothing is repaired automatically.** A deliberate cutover and a staging portal
briefly pointed at production look the same from inside. The repair is an
explicit, audited request:

```http
POST /api/admin/gateway/repair
{ "all": true, "reason": "Edge rebuild" }
```

`super_admin` only. Instead of `all`, name targets with `user_ids` and/or
`api_ids`. It always runs a fresh pass first and refuses with
`502 EDGE_UNAVAILABLE` if that pass cannot read the gateway.

**For each orphaned account** it:

1. takes the account's provisioning lock and re-checks the consumer;
2. recreates the consumer with the **same identity** (username
   `nexus-user-<user_id>`, `custom_id` set to the user id, and the same derived
   consumer id);
3. replays the `nexus:api:<api_id>:approved` ACL groups of the account's
   **active** grants;
4. in one transaction, re-links the `consumers` row, revokes every live
   `credential_metadata` row for the old consumer, and writes a
   `gateway.consumer_repair` audit row. If this fails, the recreated consumer is
   deleted again so a later repair starts clean;
5. notifies the account holder.

**Credentials are not replaced.** They are show-once, so the repair revokes the
portal rows and reports `credentials_requiring_reissue`. Each account holder
issues new credentials.

**If the repair loses its lease** after step 2 (the instance stalled past the
TTL), step 4's transaction is refused. The recreated consumer is then kept,
since another instance may already be using it. The repair logs _"A consumer
repair lost its lease after recreating the consumer"_, retakes the locks, and
finishes: it revokes exactly the rows that were live before the recreation and
writes `gateway.consumer_repair` with `resumed: true`. If another instance
already completed it, the entry reports `The gateway consumer already exists;
nothing to repair`. If the second attempt also fails, it logs _"A consumer
repair that lost its lease could not be completed"_ with the consumer and its
`stale_credential_ids`. A crash at that point leaves the same state. Later
passes see the consumer as healthy, but its old credential rows stay `active`;
clear them by [reconciling](#reconciling-one) each affected credential type on
that consumer, then have the holder issue new credentials.

**For each orphaned API** the repair clears the dead `ferrum_proxy_id`, sets
`gateway_state` to `repair_required`, notifies the owner, and writes an
`api.gateway_repair_required` audit row with `phase: "orphaned_proxy"`. It does
not rebuild the proxy. The catalog entry, spec history, grants and access
requests are untouched. Just before flagging, it re-checks the gateway under the
same per-API lock that `restore-gateway` uses; an API whose proxy is back is
reported with `flagged: false` and left alone.

Flagged APIs count toward `awaiting_restore` in every pass and keep the portal
`degraded` until restored.

**Restoring a deployment.** The API's owner or an admin rebuilds it from the API
page, or with
[`POST /api/apis/:id/restore-gateway`](api.md#post-apiapisidrestore-gateway):

```bash
curl -sS -X POST -b cookies.txt -H "X-Nexus-CSRF: $CSRF" \
  http://127.0.0.1:8787/api/apis/$API_ID/restore-gateway | jq .
```

It recreates the proxy, auth plugin, access control, rate limit, CORS policy and
plugin palette from the portal's stored settings, and moves the proxy onto its
public listen path last, as a publish does. The API keeps its id, slug, owner,
spec history, gateway URL and grants, and approved clients keep their
credentials (the ACL group derives from the API id). Audit rows:
`api.gateway_restore_start` before the first gateway call, `api.gateway_restore`
on success, and `api.gateway_restore_failed` on failure, in which case what was
built is withdrawn and the API stays flagged for a retry. An unreachable gateway
answers `502 EDGE_ERROR` and changes nothing.

The repair response lists every target with a per-target `error`:

```json
{
  "report": { "status": "orphaned", "...": "..." },
  "consumers": [
    {
      "user_id": "…",
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

### Cutover checklist

1. Stop Nexus, or accept that operations on existing rows fail until step 5.
2. Point `FERRUM_ADMIN_URL` at the new Edge, with matching
   `FERRUM_ADMIN_JWT_SECRET` and `FERRUM_ADMIN_JWT_ISSUER`.
3. Start Nexus. `GET /api/health` reports `degraded` with
   `edge.reconciliation.status: "orphaned"`.
4. `POST /api/admin/gateway/reconcile` and check the orphan counts match what
   you expect. If not, you may have the wrong gateway or `FERRUM_NAMESPACE`.
5. `POST /api/admin/gateway/repair` with `{ "all": true, "reason": "…" }`.
6. Tell account holders listed in `consumers[]` to issue new credentials, and
   restore each API in `apis[]` with `restore-gateway`. Both are also notified
   in the portal.
7. Re-run step 4 after the restores: `status` should be `ok`, and health `ok`.

If the old Edge database still exists, restoring it is usually better: it keeps
credentials working, which no repair can. Reconciliation passes never change
the gateway, so you can run one at any time to decide.

### Keeping this from being a surprise

- Back up the Nexus and Edge databases together ([§5](#5-backup-and-restore)).
- Never change a consumer's id or username on Edge by hand.
- Use a separate `FERRUM_NAMESPACE` per environment, so a misdirected
  `FERRUM_ADMIN_URL` finds an empty namespace instead of another environment's
  consumers.
- Alert on `edge.reconciliation.status == "orphaned"` and on the
  `The gateway no longer holds references the portal stored` log line.

## Gateway resource attribution

Every Admin API call sends `X-Ferrum-Provisioned-By: ferrum-nexus`. A gateway
with resource-label support records `labels: {provisioned-by: ferrum-nexus}` on
consumers, proxies and plugin configs Nexus creates, including resources
generated from API specs. Labels survive later updates. Gateways without label
support ignore the header. Labels are informational: Nexus's stored ids remain
authoritative, and JWT subjects still identify the acting user.
