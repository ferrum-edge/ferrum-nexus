# Operations

Deployment reference for Ferrum Nexus (current release: `v0.5.1`; first
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

| Variable                                     | Default                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_ENV`                                  | from `NODE_ENV`, else `development`   | `development` \| `test` \| `production`. `test` turns rate limiting off and quietens the logger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `NODE_ENV`                                   | —                                     | Read only when `NEXUS_ENV` is unset; only `production` and `test` are honoured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `NEXUS_HOST`                                 | `127.0.0.1`                           | Bind address. Use `0.0.0.0` in a container.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `NEXUS_PORT`                                 | `8787`                                | 0–65535.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NEXUS_PUBLIC_URL`                           | `http://127.0.0.1:5173`               | Public origin of the portal, used for links in email. Absolute `http(s)` URL with no credentials, query or fragment; a trailing slash is stripped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `NEXUS_TRUSTED_PROXIES`                      | _(unset)_                             | Which proxies may set `X-Forwarded-For`. Unset trusts none, so `request.ip` is the socket address. Either a hop count `1`–`32` counted from the right of the header, or a comma-separated list of IPs/CIDRs (IPv4 prefix 1–32, IPv6 prefix 1–128) and the keywords `loopback`, `linklocal`, `uniquelocal`. Invalid entries fail startup. See [§4](#4-running-behind-tls-and-a-reverse-proxy).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `NEXUS_TRUST_PROXY`                          | `false`                               | Deprecated. `true` means `NEXUS_TRUSTED_PROXIES=1`. Does not affect cookies or HSTS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `NEXUS_COOKIE_SECURE`                        | `true` unless `NEXUS_ENV=development` | Marks `nexus_session` and `nexus_csrf` `Secure` and enables HSTS. Set `false` only when serving plain `http://`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `NEXUS_LOG_LEVEL`                            | `info`                                | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `NEXUS_SESSION_TTL`                          | `43200` (12 h)                        | Sliding session idle lifetime in seconds, 60 – 2 592 000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `NEXUS_CAPTCHA_ENFORCEMENT`                  | `enforced`                            | `enforced` \| `disabled`. The CAPTCHA break-glass switch; not settable through the API, and `0`/`false` are rejected. See [Recovering a portal locked out by CAPTCHA](#recovering-a-portal-locked-out-by-captcha).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `NEXUS_RATE_LIMIT_ENABLED`                   | `true`                                | Installs the per-route rate limiters listed under [Abuse controls](#abuse-controls). Forced off when `NEXUS_ENV=test`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `NEXUS_HEALTH_CACHE_MS`                      | `5000`                                | How long `/api/health` and `/api/health/edge` reuse a dependency probe, 0–60000. `0` disables the cache. See [§9](#9-health-checks).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `NEXUS_HEALTH_PROBE_TIMEOUT_MS`              | `1500`                                | Deadline for the health route's Edge calls, 100–5000, independent of `FERRUM_ADMIN_TIMEOUT_MS`. Capped so it fits inside the image's 10-second healthcheck; if you override the orchestrator's probe timeout, keep it well above this plus database time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `NEXUS_BRANDING_CACHE_MS`                    | `5000`                                | How long `GET /api/branding` reuses its payload, 0–60000. `0` disables the cache. See [Branding](#branding).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `NEXUS_MAX_APIS_PER_OWNER`                   | `50`                                  | APIs one account may own, 0–100 000; `0` disables. See [Abuse controls](#abuse-controls).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `NEXUS_MAX_APPLICATIONS_PER_OWNER`           | `20`                                  | Application identities (each one a gateway consumer) one account may own, 0–100 000; `0` disables. Exceeding it is `429 QUOTA_EXCEEDED`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NEXUS_SPEC_HISTORY_LIMIT`                   | `10`                                  | Historical spec revisions kept per API on top of the current one, 1–10 000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `NEXUS_MAX_MESSAGES_PER_USER_PER_DAY`        | `200`                                 | Messages per account per rolling 24 h, 0–1 000 000; `0` disables. See [Messaging](#messaging).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY` | `20`                                  | Access requests per account per rolling 24 h, 0–1 000 000; `0` disables. See [Access requests](#access-requests).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `NEXUS_MAX_BROADCAST_RECIPIENTS`             | `5000`                                | Recipients per god-mode broadcast, 0–1 000 000; `0` disables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `NEXUS_MAX_BROADCASTS_PER_DAY`               | `20`                                  | Broadcasts per administrator per rolling 24 h, 0–100 000; `0` disables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `NEXUS_MAX_MASS_EMAIL_RECIPIENTS`            | `5000`                                | Recipients per mass-email campaign, 0–1 000 000; `0` disables. See [A mass-email campaign is recorded, then queued in chunks](#a-mass-email-campaign-is-recorded-then-queued-in-chunks).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NEXUS_MAX_MASS_EMAIL_BYTES`                 | `67108864`                            | Rendered bytes per mass-email campaign (an upper bound on one message, HTML escaping included, × recipients), 0–17 179 869 184; `0` disables. Default 64 MiB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `NEXUS_MAX_MASS_EMAILS_PER_DAY`              | `5`                                   | Mass-email campaigns per administrator per rolling 24 h, 0–100 000; `0` disables. A retry with the same `idempotency_key`, content and audience is not counted again; the same key with anything else is `409 CONFLICT`. Security mail has claim priority; this cap still bounds campaign storage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `NEXUS_ALLOW_PRIVATE_UPSTREAMS`              | `false`                               | Whether an API upstream may be loopback, private (RFC 1918, CGNAT, link-local) or a `.local`/`.internal`/`.localhost`/`.home.arpa` name. At `false` Nexus also resolves every other upstream hostname and refuses it if any answer is private or the name does not resolve, so **the Nexus process needs public DNS**. Refusals are `400 SPEC_INVALID`. Set `true` for internal-only portals and local development. See [`security.md`](security.md#1-threat-model).                                                                                                                                                                                                                                                                                                                              |
| `NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS`         | `false`                               | Whether backend writes may proceed when the gateway cannot attest public-only egress on its own data plane, as in a control-plane/data-plane pairing. Relaxes only that attestation: Nexus keeps the upstream screening above, health keeps `public_egress_guaranteed: false`, startup logs a warning, and each admitted write records `egress_profile` in its audit row. Set `true` only when every data plane enforces `FERRUM_BACKEND_ALLOW_IPS=public` without allow CIDRs. See [the topology decision](#backend-egress-admission-and-the-public-only-guarantee).                                                                                                                                                                                                                             |
| `NEXUS_EXPECTED_DATA_PLANES`                 | _(unset)_                             | Control-plane/data-plane pairings only: the number of running data-plane processes (replicas or pods) for the namespace across every control plane, a positive integer up to 1 000 000 (anything else refuses startup). Each Edge data-plane process reports its own random `node_id` for its lifetime, even when replicas share one CP/DP secret. A control plane's data-plane attestation proves public-only egress only while at least this many distinct `node_id`s are connected to the control plane Nexus reads and every one attests it, counting a `node_id` only once it has been listed long enough that a restarted data plane cannot count twice. Unset, an attestation never proves it. See [CP/DP pairings and data-plane attestation](#cpdp-pairings-and-data-plane-attestation). |
| `NEXUS_ALLOW_ENV_OVERRIDE`                   | `false`                               | Allow the process environment to override `.env` for `FERRUM_NAMESPACE`/`FERRUM_ADMIN_URL` outside production (see above). No effect in production.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `NEXUS_WEB_DIST`                             | _(unset)_                             | Directory of the built SPA. Nexus uses the first of this, `../../web/dist` relative to the server, and `./web/dist` under the working directory that contains an `index.html`; with none, only the API is served.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `NEXUS_BOOTSTRAP_TOKEN`                      | _(unset)_                             | Token the founding registration must present. At least 16 characters. When unset, each process generates one. Set it for any multi-instance deployment. See [First run](#first-run-and-the-bootstrap-token).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `NEXUS_GATEWAY_RECONCILE_INTERVAL_MS`        | `900000` (15 min)                     | How often Nexus checks that the gateway still holds the consumer and proxy ids it stored, 0 – 86 400 000. A pass also runs at startup. `0` disables the timer. See [§13](#13-retargeting-or-rebuilding-ferrum-edge).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `NEXUS_GATEWAY_RECONCILE_SAMPLE`             | `200`                                 | Most stored references of each kind one pass checks, 1–100 000. A pass that hits the bound reports `complete: false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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

The released namespace-routing policy accepts a control plane with
`data_plane_single_namespace: false` and `active: null`; a missing namespace
block is unknown, not a mismatch. **Backend egress admission below narrows that
accepted CP pairing; see its topology decision.**

### Backend egress admission and the public-only guarantee

Unless an opt-out below is set, every backend-writing Admin boundary
requires fresh authenticated, namespace-matched, no-store process metadata from
`GET /backend-egress-policy`, schema 2 (Edge v0.9.13 and later). Only `local-data-plane` with
`public_only_guaranteed=true` passes, or a control plane whose data-plane attestation
proves every connected data plane public-only with at least
`NEXUS_EXPECTED_DATA_PLANES` distinct data planes (`node_id`) connected, counting
only those that did not just start (see
[CP/DP pairings and data-plane attestation](#cpdp-pairings-and-data-plane-attestation)).
Nexus validates the complete closed vocabulary,
exact allowed/blocked class arrays, evaluation order and cross-field consistency.
Unknown/missing/malformed metadata, auth/network/timeout failures, cached answers,
a control plane without a qualifying attestation, unserved/no data plane, mode `both`
and any allow-CIDR overlay refuse writes. Preflight precedes destructive conversions, staging and ACL building;
compensation repeats admission and records repair-required failures. Before
teardown, conversion atomically seals its original baseline, retains its proxy
reference, sets `gateway_state=repair_required` and records an intent audit. The
condition survives staging, cutover and catalog commit refusal. Completion clears
the journal with the catalog, ownership and audit in one lease-fenced transaction.
Successful rollback also clears repair state and the journal atomically.
The encrypted `gateway_recovery:<namespace>:<api_id>` setting records original
operator fields, plugin ids and partial rebuild paths/spec ownership. It uses the
existing settings repository on all four stores; no schema migration is needed.
Large journals use an encrypted manifest at that key and individually encrypted
`gateway_recovery_chunk:<generation>:<index>` rows. Each chunk stays below 1 MiB,
including encryption and encoding overhead, so growing namespace evidence cannot
cross [MongoDB's 16 MiB document limit](https://www.mongodb.com/docs/manual/reference/limits/#bson-document-size).
The complete generation, manifest and old
chunk retirement commit in one atomic transaction (MongoDB requires a replica set).
Existing inline legacy journals require the same atomic admission. Updating or deleting
an API with a journal, enforcement conversion and restore rebuilds refuse opted-in
standalone MongoDB before catalog, audit or gateway effects. Ordinary catalog revisions,
live reconciliation and deletion without a journal retain their standalone behavior.
Reads authenticate identity, order and complete content in a coherent transaction;
missing/substituted chunks refuse replay and completion. Failed publication retains
the previous generation, including every original credential, raw row, spec and
token. Treat these rows as one journal in paired backups and writer-drain procedures;
never manually trim or remove chunks. Existing single-row journals remain readable,
and normal encrypted-setting key rotation includes each manifest and chunk.
Journals this release writes carry `authorityFormat: 2`: every deployment snapshot
they hold is authority in the Edge v0.9.13 format, which Edge v0.9.14 keeps (snapshot
v2 and `deployment_snapshot.v2` tokens). Older journals carry no marker and stay
readable, but Edge v0.9.12 authority in them is refused before any request (see
[Upgrading to Edge v0.9.13](#upgrading-to-edge-v0913)); an unknown marker is refused.
The `gateway_restore_cleanup:<namespace>:<api_id>` cutover/cleanup journal uses the
same format and custody rules.
`POST /api/apis/:id/restore-gateway` repeats admission, takes the API and proxy
leases, and verifies resources against that record before rebuilding an absent
identity. Live selected removal and API-spec replacement use the conditional
deployment API released in Edge v0.9.13 and unchanged in v0.9.14: a complete encrypted original snapshot and its strong
`deployment-v1` token, never a backup/row token or namespace replacement. Stored spec
documents appear in the snapshot evidence only as `{sha256, len}`; Nexus reads their
bytes from `api_spec_contents` and verifies each against that digest. Each
pending operation is durable before HTTP. Only HTTP 200 with the expected profile
and target, committed/applied acknowledgement, explicit cleanup authorization and
applicable covering cursor allows dependent recovery or journal removal. CP/unserved
durable-only results, unknown fields, lost replies and cancellation retain the
journal and attempted identity with `withdrawn: false`; no fresh-token retry or
unconditional cleanup follows. The owner task may still settle after transport loss.
Unknown or changed target state refuses mutation. Frozen external-reference replay,
unrepresentable associations and unsupported write fields require operator
resolution. Generated validator resource/config fields are preserved; operation
schemas remain owner-generated. Corrected uploads preserve immutable original replay
resources and atomically bind the new catalog shape and current revision. Original
staging replay precedes corrected replacement and cutover under their own retained
authority. See the [released protocol and qualification limits](edge-conversion-recovery-blocker.md).
Only a deployment matching the catalog clears the condition; recovery checks it
on staging before cutover, then again before the fenced completion transaction.
Reconciliation takes the same proxy lease and retains conversion-owned references
through missing-resource gaps, so repair cannot release those identities.

Two opt-outs relax different checks, and each one relaxes only its own:

- `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true` keeps its existing meaning: Nexus skips its
  own upstream screening, so internal and unresolvable names are permitted, and Edge
  alone decides reachability. A portal that publishes private upstreams on purpose
  cannot also run a public-only gateway, so recognized consistent weaker metadata
  is accepted too, including CP, `both`, `private` and overlays.
- `NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS=true` waives only the gateway's public-only
  attestation. Nexus keeps its suffix, IP-literal and resolved-address screening of
  every upstream. It still requires the gateway to report
  `public_only_guaranteed=true`, and Edge v0.9.13 (schema 2) reports that only for
  `local-data-plane`, so against Edge v0.9.13 it admits nothing the public profile
  refuses. See the compatibility notes below.

Under either opt-out, missing, malformed or unsupported-schema metadata is still
refused, the pairing is never reported as public-only, startup logs a
`BACKEND EGRESS NOT GUARANTEED` warning naming the variable, and every publish,
update and restore records the admitting `egress_profile` (`public-guaranteed`,
`private-upstreams-opt-in` or `unattested-edge-opt-in`) and the policy's
`enforcement_scope` in its audit row. Private plugin dependencies may require allow
CIDRs; any such override removes public-only certification even when an operator
considers the override harmless. Edge's `rediss://` hostname rebinding limitation
remains unchanged (see the security guide).

A direct singleton requires operator-established identity of its Admin and traffic
process. Process metadata has no process identity or fleet inventory; on its own it
cannot attest a remote DP, other process, load-balanced Admin endpoint or future
replacement (a control plane's data-plane attestation covers only the data planes
connected to it, checked against `NEXUS_EXPECTED_DATA_PLANES`; see below). Check
both endpoints and configuration on replacement/reconfiguration, and enforce policy
for existing traffic outside Nexus. Startup and cached health successes authorize no
mutation. Health keeps HTTP 200 for degraded liveness and retains probe
caching/coalescing. A caller below `admin` reads only `edge.reason: "unspecified"`
and `public_egress_guaranteed: null`; an admin reads `backend_egress_unverified`,
the boolean verdict and a fixed bounded diagnostic, never policy bodies, CIDRs or
secrets.

**Topology decision.** Nexus grants the verified public-only egress guarantee in two
cases only:

- Edge reports `public_only_guaranteed=true` with `enforcement_scope=local-data-plane`,
  that is, a single gateway process that both answers the Admin API and serves the
  traffic.
- Edge is a control plane (`enforcement_scope=admission-only`) whose
  `data_plane_attestation` proves that every data plane connected for the namespace
  enforces public-only egress, and at least `NEXUS_EXPECTED_DATA_PLANES` distinct
  data-plane processes (`node_id`) that did not just start are connected (Edge
  `v0.9.14` and later; see
  [CP/DP pairings and data-plane attestation](#cpdp-pairings-and-data-plane-attestation)).

`GET /api/health/edge` reports that verdict as `public_egress_guaranteed`. Every other
pairing reads `public_egress_guaranteed: false`. That includes a control plane that
reports `public_only_guaranteed=true` for its own process: its own policy describes
admission, not the remote data planes that connect to backends.

| Pairing (schema 2)                                                                                                                                | Public profile (default)                          | `NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS=true`         | `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`              |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| Local data plane, public mode, no allow overrides                                                                                                 | Writes admitted; health `ok`; guaranteed          | Writes admitted; health `ok`; guaranteed          | Writes admitted; health `ok`; guaranteed          |
| Control plane; every connected data plane attests public-only and at least `NEXUS_EXPECTED_DATA_PLANES` have settled (v0.9.14+)                   | Writes admitted; health `ok`; guaranteed          | Writes admitted; health `ok`; guaranteed          | Writes admitted; health `ok`; guaranteed          |
| Any other control plane (v0.9.13; count unset or short; too few settled data planes; attestation unreadable; none, unknown or weaker data planes) | Writes refused; health `degraded`; not guaranteed | Writes refused; health `degraded`; not guaranteed | Writes admitted; health `ok`; not guaranteed      |
| Any other recognized policy                                                                                                                       | Writes refused; health `degraded`; not guaranteed | Writes refused; health `degraded`; not guaranteed | Writes admitted; health `ok`; not guaranteed      |
| Missing, malformed, unsupported-schema or unreachable policy                                                                                      | Writes refused; health `degraded`; not guaranteed | Writes refused; health `degraded`; not guaranteed | Writes refused; health `degraded`; not guaranteed |

Nexus upstream screening runs in the first two columns and is skipped only in the
last. Without the attestation Nexus never describes a CP/DP pairing as public-only,
and the operator enforces public-only egress on every data plane (see the
[security guide](security.md#1-threat-model)).

#### CP/DP pairings and data-plane attestation

From Edge `v0.9.14`, a control plane's `GET /backend-egress-policy` answer carries an
additive `data_plane_attestation` object within schema 2: the egress policy each data
plane connected for the namespace reported when it subscribed to the control plane,
one entry per live stream, plus Edge's aggregate over them. The control plane's own
fields keep their admission-only meaning, and its own `public_only_guaranteed` stays
`false`. Nexus grants the guarantee from the attestation only when all of these hold:

- `NEXUS_EXPECTED_DATA_PLANES` is set, and the number of distinct `node_id` values
  among the listed streams is at least that value. Edge lists one entry per Subscribe
  stream, so a reconnect overlap can list one data-plane process twice; Nexus counts
  distinct `node_id`s so that this duplicate never stands in for a missing data plane;
- a `node_id` counts only once it has existed long enough that a restarted data plane
  cannot count twice (see "Restarts and stale streams" below), and at least
  `NEXUS_EXPECTED_DATA_PLANES` of them have;
- at least one data plane is connected for the namespace;
- every connected data plane sent a recognised report (none is `unknown`), so the
  aggregate is complete;
- every report is `public` mode without allow CIDRs (deny CIDRs and the
  dangerous-range baseline do not matter, as for a local data plane);
- the aggregate (`weakest_policy`, `weakest_policy_complete`,
  `all_connected_public_only_guaranteed` and the three counts) is exactly what the
  listed streams produce. Nexus recomputes it from the entries and never trusts the
  summary flag alone.

Anything else fails closed. `NEXUS_EXPECTED_DATA_PLANES` unset, fewer distinct data
planes connected than it says, too few of them connected long enough to count, a
`connected_at` that contradicts the clocks, no connected data plane, an unknown or
weaker data plane, an allow overlay, or a control plane without the object (Edge
`v0.9.13`) reads "not
guaranteed": writes are refused unless an opt-out admits them, and health is
`degraded`. An admin's `edge.error` and the write refusal name which condition
failed.

The attestation can only add the guarantee, so a problem inside it degrades rather
than refuses. An attestation that is malformed, carries a missing or unknown key,
disagrees with its own entries, or appears on anything but a control plane is set
aside: that answer reads "not guaranteed" (even a local data plane's), Nexus logs a
warning with a bounded `reason` (`malformed`, `inconsistent` or `out_of_scope`), and
the opt-outs still admit writes by their own rules. The rest of
the answer stays as strict as before: a missing, unknown or malformed top-level
field, another schema, or an answer for another namespace is still unreadable
(`invalid_egress_policy`) and refused in every profile.

Answers are read up to 4 MiB. An entry takes about 400 bytes with realistic node
ids, so that is roughly 10,000 data-plane streams per namespace, above Edge's
default `FERRUM_XDS_MAX_TOTAL_STREAMS` (8192). A larger answer cannot be parsed, so
it is refused like any other unreadable policy, in every profile. Admission audit
rows record `egress_profile: public-guaranteed` with
`enforcement_scope: admission-only` for a write admitted on attestation.

**Setting `NEXUS_EXPECTED_DATA_PLANES`.** A control plane lists only the data planes
streaming from that control plane process; one using another control plane is never
seen. So the value is the namespace's whole data-plane inventory across every
control plane: the number of running data-plane processes (replicas or pods) serving
the namespace. Each Edge data-plane process subscribes under its own random `node_id`,
generated when the process starts, whatever CP/DP credential it uses: replicas that
share one CP/DP secret still report distinct `node_id`s and each counts. Nexus reads
only the control plane at `FERRUM_ADMIN_URL`, so the guarantee is available only when
that control plane sees every data plane:

- **One control plane.** Set the value to the fleet size. A data plane that has not
  connected yet keeps the count short and the guarantee withheld.
- **Several control plane replicas, a load balancer in front of them, or data planes
  that fail over between control planes** (`FERRUM_DP_CP_GRPC_URLS`). Any control
  plane that does not hold every stream reports a short count, so the guarantee is
  withheld; behind a load balancer, writes and health then follow whichever replica
  answered. Nexus cannot combine answers from several control planes. Such a fleet
  publishes only under an opt-out, or by pointing `FERRUM_ADMIN_URL` at a control
  plane every data plane uses.

Never set the value lower than the real inventory: the count is the only check
that the connected set is the whole fleet, and a value below it lets a data plane
on another control plane, or one not yet connected, go unchecked. Raise the value
when you add data planes, before they connect. More connected data planes than the
value never refuse a write: during a scale-up, or a rolling update that starts
replacements before stopping old data planes, the guarantee holds as long as the data
planes that have counted long enough still reach the value, and every connected one,
new or not, must still attest public-only.

**Restarts and stale streams.** When a data-plane process reconnects, it keeps its
`node_id`, so an overlap of its old and new streams still counts once. A data-plane
process that restarts gets a new `node_id`. If it stopped without closing its stream
(a crash, a killed pod, a network cut), the control plane keeps listing the old stream
until Edge detects that it is dead, and the restarted process adds a second, distinct
`node_id`. That data plane would count twice, and the count could cover one data plane
that is missing or connected to another control plane. Edge's stream liveness
detection bounds the window: in Edge v0.9.14, the ConfigSync HTTP/2 keepalive sends a
ping every 30 seconds with a 10-second timeout. So Nexus counts a `node_id` only once
it has existed for 60 seconds, by which time Edge has dropped the stream of any process
it replaced, so a stale stream and its replacement do not count together. Both numbers
are Edge v0.9.14 constants, and the bound assumes the control plane terminates each
data plane's HTTP/2 connection itself, directly or through an L4 (TCP) pass-through. A
proxy that terminates HTTP/2 between them, such as an L7 gRPC ingress, answers the
control plane's pings on the data plane's behalf, so a dead data plane's stream can stay
listed until the proxy notices, which can take minutes; in that topology a restarted
data plane can still count twice. A `node_id` qualifies in either of two ways:

- this Nexus process saw it listed at least 60 seconds before the read. Nexus measures
  this on its own monotonic clock, so no clock skew affects it, and it remembers a
  `node_id` for 15 minutes after it stops being listed. A data plane renews its stream
  about every hour under the same `node_id`, so this keeps a routine reconnect counted;
- the answer carries an HTTP `Date` header, and the earliest stream listed under the
  `node_id` has a `connected_at` at least 90 seconds old (60 seconds plus a 30-second
  clock-skew allowance) on both Nexus's clock and that `Date`. Without a `Date`, a
  control-plane clock behind Nexus's would go unseen, so only the first way applies.
  Edge always sends the header; it must reach Nexus as the control plane wrote it, not
  replaced by a reverse proxy's own clock.

While enough `node_id`s are listed but fewer than `NEXUS_EXPECTED_DATA_PLANES` qualify,
the verdict is `data_plane_recently_connected`: writes are refused and health is
`degraded`. After a restart this lasts up to about a minute and a half after the data
plane starts, unless enough other data planes already qualify; it also applies after
Nexus itself starts while data planes are that new, or, when the answers carry no
`Date` header, for the first minute after Nexus starts. Once Edge drops the stale
stream, the short count reads `fewer_data_planes_than_expected` until the fleet is
whole again. Alert on transitions of the health check's egress verdict, and treat a
data-plane crash as a reason to confirm the inventory with Edge's `GET /cluster`.

**Clock skew.** `connected_at` is the control plane's clock. A `connected_at` more than
30 seconds later than Nexus's clock or the gateway's `Date`, or older than any live
stream can be (Edge ends every stream within
`FERRUM_CP_GRPC_MAX_STREAM_LIFETIME_SECONDS`, at most a day), proves nothing. Only
the data planes that this Nexus process has itself seen listed for 60 seconds then
count, and when they fall short the verdict is `data_plane_clock_skew` and the
guarantee is withheld. Keep Nexus and the control plane on synchronized time. When
the gateway sends no `Date` header, Nexus cannot see a control-plane clock running
behind its own, so it never reads stream age from `connected_at` alone: only data
planes it has itself seen listed for 60 seconds count. Slew the control plane's clock
rather than stepping it forward: a clock that was behind when a stream connected and
is corrected before Nexus reads it overstates that stream's age.

**What the stream age does not cover.** Edge v0.9.14 reports no stream liveness, so a
stale stream that has not yet been dropped is indistinguishable from a live one. If a
data plane restarts and its new process subscribes to a different control plane, its
old stream on the control plane Nexus reads still counts for up to Edge's liveness
window, while the new process is not attested.

**Freshness and flapping.** The attestation describes the data planes connected at
the moment of the read, and Nexus does not cache or smooth it. The only state Nexus
keeps across reads is when it first saw each `node_id`, which can settle a data plane
but never adds one to the count. Every backend write
reads a fresh, no-store answer at its boundary, and every health probe evaluates its
own sample. There is no grace period or hysteresis: a single read that does not
prove the guarantee refuses that write and degrades health, and the next read that
proves it restores both. A data plane's report is not aged out, because Edge's
policy is fixed for the life of a process: a reconfigured data plane restarts and
subscribes again with a new report. During a rolling restart that briefly leaves no
data plane connected, writes are refused; retry once a data plane has reconnected.

**What the attestation does not cover.** Reports are self-described by
authenticated data planes running the control plane's build, not a cryptographic
attestation of the data-plane host. A data plane that has disconnected but keeps
serving cached configuration is not listed, and one that connects after a write was
admitted is not covered by that admission. A data plane on a control plane Nexus
does not read is covered only by `NEXUS_EXPECTED_DATA_PLANES`: keep it equal to the
real inventory (Edge's `GET /cluster` helps to check it), keep
`FERRUM_BACKEND_ALLOW_IPS=public` without allow CIDRs on every data plane, and
requalify when a data plane is added, replaced or reconfigured.

**CP/DP pairings on Edge v0.9.13.** Against Edge v0.9.12, a public-mode control plane
reported `public_only_guaranteed=true` for its own policy, and
`NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS=true` admitted its writes while keeping Nexus's
upstream screening. Edge v0.9.13 withdrew that reading: a control plane now reports
`false`. Nexus does not reinterpret the field from `mode` and the overlay flags, so
the unattested opt-in no longer admits a CP/DP pairing. Edge v0.9.13 sends no
data-plane attestation, so such a pairing publishes only with
`NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`, which also skips Nexus's upstream screening;
enforce `FERRUM_BACKEND_ALLOW_IPS=public` without allow CIDRs on every data plane.
With Edge v0.9.14 a fully attested pairing publishes under the default public
profile instead.

**Compatibility.** Nexus reads egress policy schema 2 only, which Edge publishes from
`v0.9.13`. Schema 1 (Edge `v0.9.11` and `v0.9.12`) reported the policy-only value of
`public_only_guaranteed`, so the same field meant something else; Nexus refuses it
under the protocol reason `unsupported_egress_policy_schema` rather than reinterpret
it, health reads `degraded`, and an admin's `edge.error` names the unsupported schema.
Every backend write is then refused in every profile. The same holds for any newer
schema. Nexus also requires the v0.9.13 deployment snapshot (`api_spec_contents`), so
Nexus `v0.4.0` pairs with Edge `v0.9.13` only: upgrade Edge and Nexus together, as
described in [Upgrading to Edge v0.9.13](#upgrading-to-edge-v0913). Nexus `v0.5.0`
and `v0.5.1` pair with Edge `v0.9.14`, the version their acceptance suite tests: they read the
control-plane attestation within schema 2 and Edge's narrower `durable` outcomes, and
the snapshot and token formats are unchanged (see
[Upgrading to Edge v0.9.14](#upgrading-to-edge-v0914)). The next release pairs with
Edge `v0.9.15`, a security release that keeps every one of these contracts (see
[Upgrading to Edge v0.9.15](#upgrading-to-edge-v0915)). The guarantee
still requires `enforcement_scope=local-data-plane` explicitly, not schema 2's
narrowed `public_only_guaranteed` alone.

[`release/compatibility.env`](../release/compatibility.env) pins the published Edge
`v0.9.15` default image, and Nexus vendors `contracts-edge-0.9.15` at
`6fb64c5dc2e014204c17609fc717d976f3b4589e`. See [the adoption facts](edge-0.9.11-adoption.md)
and the separate [packaged public-only fixture](../e2e/public-only/README.md).

**Fixing a mismatch.** Set the portal's `FERRUM_NAMESPACE` to the gateway's
`active` value, or restart the gateway with the portal's value, then restart
the portal. Changing the portal's namespace changes every listen path, so APIs
published under the old one must be republished.

### Resolving an unconfirmed gateway deployment mutation

A conditional deployment removal or replacement that Edge did not confirm (a lost
reply, a timeout, a `503` with `durable: "unknown"`, a CP/unserved durable-only
result) may still settle after Nexus gave up on it. A definite refusal is kept the
same way: a `412` (the original token no longer matches, including every token Edge
v0.9.12 issued), a `507` past the snapshot bound, or a store failure that Edge
v0.9.14 reports as `durable` `not_started` or `not_committed` changed nothing, but
Nexus never replaces the journal's original
authority with a fresh token, so the journal and its pending operation stay until an
operator resolves them. Nexus never guesses the outcome, so the API stays
`gateway_state: repair_required` with its encrypted journal, and every portal path
that would act on it refuses with `409 CONFLICT`:

- `POST /api/apis/:id/restore-gateway` and `DELETE /api/apis/:id` answer
  "A gateway deployment mutation is unconfirmed", "The conditional restore
  application remains unconfirmed" or "A failed restore has unconfirmed deployment
  cleanup".
- The audit trail has an `api.gateway_repair_required` row with
  `recovery_retained: true`, or an `api.gateway_restore_failed` row with
  `cleanup_refused: "deployment_cleanup_unconfirmed"`. Both name the `proxy_id`.

A request refused before anything was sent (for example by egress admission, or
because the journal holds Edge v0.9.12 authority) is never journaled as unconfirmed,
so this state always means a request reached the gateway. There is no portal
endpoint that marks it confirmed. Resolve it by observation:

1. **Do not retry around it.** Do not repeat the PATCH, recreate the proxy, or edit
   the API through the portal. A second operation could overlap the one that may
   still settle.
2. **Wait for the gateway to settle.** Confirm Edge is `ready`, then read
   `GET /deployment-snapshot` for the namespace twice, at least one config poll
   interval apart. The same `ETag` both times means no deployment is still in
   flight.
3. **Observe the outcome** for the audited `proxy_id` through the Edge Admin API,
   and record the proxy's plugin configs before changing anything (the audit row's
   `plugin_names` lists the hand-owned ones):
   - after a teardown or cleanup removal, the proxy is either still present,
     unchanged on its original listen path (not applied), or absent (applied);
   - after a `routes` cutover, the proxy is either still on its
     `/<namespace>/.staging/<id>` path (not applied) or on the API's real listen
     path with the submitted specification (applied).
4. **Release the journal**, break-glass, with every Nexus instance stopped as in
   the [paired-backup writer drain](#ordering-and-consistency) and a fresh paired
   backup taken. In `app_settings` (a table, or a collection on MongoDB), delete
   the journal's manifest row, whose key is
   `gateway_recovery:<namespace>:<api_id>` or
   `gateway_restore_cleanup:<namespace>:<api_id>`. Delete only that row: the
   `gateway_recovery_chunk:*` rows it referenced become unreferenced and inert,
   and a later journal uses a new generation.
5. **Bring the gateway back to the catalog.** Start Nexus and run
   `POST /api/apis/:id/restore-gateway`. A present proxy that still matches the
   catalog clears `repair_required` without a rebuild; an absent one is rebuilt
   from the catalog under a new id. A present proxy that matches neither is refused
   as needing operator reconciliation: remove it through the Edge Admin API, run
   the restore again, then re-add any hand-owned plugin configs recorded in step 3.

Never release a journal while the outcome is still unsettled, and never edit or
remove individual chunk rows of a journal that is kept.

**Refusals Edge reports.** The audit and error details name the cause:

- `details.kind: "deployment_precondition_failed"` (`412`): the held token no longer
  matches. Step 3 normally finds the operation not applied. A token issued by Edge
  v0.9.12 or earlier always lands here after the Edge upgrade.
- `details.kind: "namespace_snapshot_too_large"` (`507`): the namespace's canonical
  representation exceeds Edge's 64 MiB conditional bound (spec bytes excluded), or its
  stored spec documents exceed 256 MiB of base64. No authority was issued and nothing
  was applied; the refusal repeats until the namespace shrinks, so Nexus never
  retries it. Reduce the namespace (remove unused resources or split tenants across
  namespaces), then resolve any kept journal as above.
- `details.kind: "deployment_not_committed"` (`502 EDGE_ERROR`): Edge answered with
  an acknowledgement whose `durable` is `not_started` or `not_committed`, which Edge
  v0.9.14 also reports for a store failure (`503`) before or inside the rolled-back
  mutation transaction. Nothing was committed, so step 3 finds the operation not
  applied, but the outcome authorizes neither cleanup nor replay: the journal is kept
  and Nexus never sends the operation again. Restore the gateway's store, then
  resolve the journal as above. `durable: "unknown"` (a failed commit or commit
  acknowledgement) stays `deployment_acknowledgement_uncertain`.
- `details.kind: "legacy_deployment_authority"` (`409`, nothing sent): the journal was
  written before the Edge v0.9.13 upgrade and holds v0.9.12 authority that Edge now
  refuses. Resolve it by observation as above.

### Upgrading to Edge v0.9.13

Nexus `v0.4.0` pairs with Edge v0.9.13 only, and Edge v0.9.13 refuses every
deployment token an earlier Edge issued (see the
[Edge upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.13/docs/upgrade_guide.md#upgrading-to-0913)).
A conversion or restore that is still in flight across the upgrade cannot finish on
its own: its journal holds authority the new gateway would answer with `412`, so
Nexus refuses to send it and never refreshes it. Drain and settle them first, then
upgrade both sides in one maintenance window:

1. **Stop new conversions.** Ask providers not to change `spec_enforcement` or
   restore gateways until the upgrade is done.
2. **Settle every journal on the old pairing.** List the journals: `app_settings` rows
   whose key starts with `gateway_recovery:<namespace>:` or
   `gateway_restore_cleanup:<namespace>:` (not `gateway_recovery_chunk:`), and APIs
   with `gateway_state` `repair_required`. Run `POST /api/apis/:id/restore-gateway`
   for each until it completes. Resolve one that reports an unconfirmed mutation with
   [the runbook above](#resolving-an-unconfirmed-gateway-deployment-mutation) before
   going on. Repeat the listing until it is empty.
3. **Drain writers and take a paired backup**: stop every Nexus instance and follow
   [Ordering and consistency](#ordering-and-consistency).
4. **Upgrade Edge to v0.9.13.** Control plane and data planes must run the same build.
5. **Start Nexus `v0.4.0`** with the Edge image its
   [`release/compatibility.env`](../release/compatibility.env) pins. Check
   `GET /api/health/edge` as an admin: `status: "ok"`, and
   `public_egress_guaranteed: true` for a local public-only data plane. A CP/DP
   pairing reads `degraded`; see
   [CP/DP pairings on Edge v0.9.13](#backend-egress-admission-and-the-public-only-guarantee).

Between steps 4 and 5 neither side can talk to the other: an older Nexus refuses
egress policy schema 2, and this release refuses schema 1. Backend writes are refused
rather than guessed, so keep Nexus stopped for that window.

A journal that was missed in step 2 stays readable. If its recorded operations are
all acknowledged and the live deployment already matches the catalog, a restore
completes it by observation. Anything that would act on its v0.9.12 authority is
refused before a request is sent (`details.kind: "legacy_deployment_authority"`), and
an operation that was still pending is refused locally as unconfirmed ("A gateway
deployment mutation is unconfirmed") and never sent again; resolve either with
[the runbook](#resolving-an-unconfirmed-gateway-deployment-mutation).

A namespace near Edge's conditional bound (64 MiB of canonical representation with
spec bytes excluded, or 256 MiB of base64 spec content) answers `507` on the snapshot
read and on conditional mutations after the upgrade, so enforcement conversions and
restores that need deployment authority are refused there until it shrinks. Consumer
verification reads answer `507` the same way, so credential and access changes for
that namespace fail closed with `details.kind: "namespace_snapshot_too_large"`.

**Rolling back** means rolling back both sides together, after settling journals
again: tokens issued by Edge v0.9.13 do not verify on v0.9.12, and the earlier Nexus
cannot read egress policy schema 2 or the v0.9.13 snapshot.

### Upgrading to Edge v0.9.14

Nexus `v0.5.0` and `v0.5.1` pair with Edge v0.9.14 (see the
[Edge upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.14/docs/upgrade_guide.md#upgrading-to-0914)).
Unlike v0.9.13, this upgrade keeps every contract Nexus depends on: egress policy
schema 2, deployment snapshot v2 and its `deployment_snapshot.v2` tokens, and the
acknowledgement shape. What changes for Nexus:

- **Control-plane attestation.** A control plane's egress policy answer gains the
  optional `data_plane_attestation` object. With `NEXUS_EXPECTED_DATA_PLANES` set, a
  CP/DP pairing whose data planes all attest public-only can publish under the default
  public profile; see
  [CP/DP pairings and data-plane attestation](#cpdp-pairings-and-data-plane-attestation).
  Without the setting, or on Edge v0.9.13, nothing changes.
- **Narrower `durable` outcomes.** A conditional removal or replacement whose store
  fails before commit now answers `503` with `durable` `not_started` or
  `not_committed`, which Nexus reports as `details.kind: "deployment_not_committed"`
  instead of `deployment_acknowledgement_uncertain`. The journal is kept either way
  (see [the runbook](#resolving-an-unconfirmed-gateway-deployment-mutation)).
- **Error classification.** Backend HTTP/2 resets other than `NO_ERROR` are now
  `protocol_error` and charged to the target's circuit breaker and passive health, and
  a buffered response read timeout is `504` instead of `502`. Nexus's per-API metrics
  count requests by method and status code, never by `error_class`, so some backend
  failures move from the `502` bucket to `504`; adjust any alert that keys on it.

Procedure:

1. **Settle journals** as in step 2 of the v0.9.13 procedure. Tokens a v0.9.13
   gateway issued keep verifying on v0.9.14, but settling first keeps the upgrade
   window free of in-flight conversions.
2. **Upgrade Edge to v0.9.14.** The ConfigSync protocol revision is now `3`, so the
   control plane and every data plane must run the same build: upgrade them together.
   A data plane on an older build cannot connect, and the control plane cannot list
   it in its attestation.
3. **Upgrade Nexus** to `v0.5.1`, which pins Edge v0.9.14 in
   [`release/compatibility.env`](../release/compatibility.env), and check
   `GET /api/health/edge` as an admin. On a CP/DP pairing, set
   `NEXUS_EXPECTED_DATA_PLANES` first if you want the attested guarantee.

Nexus `v0.4.0` reads the egress policy answer as a closed key set, so it treats a
v0.9.14 control plane's answer, which carries `data_plane_attestation`, as unreadable
and refuses every backend write in every profile. A local data plane's answer carries
no attestation. On a CP/DP pairing, keep Nexus stopped from step 2 until it runs
`v0.5.1`; the
[`v0.5.0` release notes](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.5.0/docs/release-notes.md#upgrading-from-v040)
combine both upgrades in one window.

**Rolling back** Edge to v0.9.13 keeps Nexus `v0.5.1` working: the attestation disappears, so
a pairing that relied on it reads "not guaranteed" again and its writes are refused
unless an opt-out admits them.

### Upgrading to Edge v0.9.15

The next Nexus release pairs with Edge v0.9.15 and requires it: v0.9.15 is a
security release, and it is the only Edge version that release's acceptance suite
tests. Read the
[Edge upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.15/docs/upgrade_guide.md#upgrading-to-0915)
for the gateway-wide changes. Every contract Nexus depends on is unchanged: egress
policy schema 2 and its data-plane attestation, deployment snapshot v2 and its
`deployment_snapshot.v2` tokens, and the acknowledgement shape. The ConfigSync
protocol revision stays `3`, and Edge adds no core schema change. No Nexus migration
or journal change is needed. What changes for Nexus:

- **Identity headers.** `X-Consumer-Username` now carries only a mapped Consumer,
  and an external identity is sent as the new gateway-owned
  `X-Authenticated-Identity`. Every Nexus caller authenticates as a Consumer through
  `key_auth`, `basic_auth` or `jwt_auth`, so backends behind Nexus keep receiving
  `X-Consumer-Username` (`nexus-user-<id>` or `nexus-app-<id>`). Nexus writes no
  LDAP, JWKS or introspection config, so the removed LDAP `consumer_mapping` does
  not affect it. Edge refuses `X-Authenticated-Identity` as a configured header, and
  so does Nexus: a `correlation_id` or `request_deduplication` `header_name` of that
  name (any case, `_` or `-`) is `400 VALIDATION_FAILED`. Rename any existing one
  before upgrading.
- **gRPC and WebSocket admission.** Edge now refuses a native gRPC or WebSocket
  request with `403` (trailers-only `PERMISSION_DENIED` for gRPC, rejection phase
  `route_protocol_admission`) when the route runs an authentication or admission
  plugin on HTTP that cannot run on that flavor. On Nexus proxies that is the
  `routes` [enforcement level](guides/provider-guide.md#enforcement-level)
  (a blocking `openapi_validator`), every API available to AI agents (`mcp_gateway`,
  `openapi_validator`, `ai_tool_governor`, `ai_prompt_shield` and the tool-call
  `rate_limiting`), and the palette's idempotency keys with `enforce_required`.
  These requests used to skip that policy. The authentication plugins,
  `access_control` and the quota `rate_limiting` run on both flavors, and `cors`
  gates nothing, so an API without those configs serves gRPC and WebSocket as before. A client that
  nominates `Authorization` in `Connection` on HTTP/1.1 or HTTP/3 now has it removed
  before authentication and gets `401`.
- **IPv6 grouping.** Per-source caps and IP-keyed plugin state now group IPv6
  clients by `/64`, and `rate_limiting` gains `ipv6_prefix`. Nexus quotas count by
  Consumer (`limit_by: consumer`) and Nexus never sets `ipv6_prefix`, so portal
  quotas are unaffected. Aggregate MCP sessions keep Edge's new default cap of 128
  per authenticated principal; Nexus sets no `sessions` options.
- **Plugin-secret environment references.** Plugin configs may name only
  `FERRUM_PLUGIN_SECRET_<NAME>` variables. No config Nexus writes names an
  environment variable, so only an operator's own configs need renaming (see the
  Edge guide).
- **Namespace-scoped TLS references.** A namespace-scoped `operator` token may set
  `backend_tls_*` paths only within its namespace. Nexus signs every Admin JWT with
  `role: admin`, never writes those fields, and carries the stored values back on a
  proxy replace, which Edge keeps, so it is unaffected.
- **ConfigSync admission.** `GetFullConfig` now requires `node_id` to equal the JWT
  subject. Nexus never calls the control plane's gRPC API; it reads the data-plane
  attestation through the Admin API only.

Procedure:

1. **Check the gateway** with the Edge guide's list, and in the portal check the
   palette header names and any API at `routes`, available to AI agents, or
   requiring idempotency keys that also serves native gRPC or WebSocket clients:
   serve that traffic from a separate API, or relax the setting, before upgrading.
2. **Settle journals** as in step 2 of the v0.9.13 procedure. Tokens a v0.9.14
   gateway issued keep verifying on v0.9.15.
3. **Upgrade Edge to v0.9.15**, the control plane and every data plane together.
4. **Upgrade Nexus** to the release that pins Edge v0.9.15 in
   [`release/compatibility.env`](../release/compatibility.env), and check
   `GET /api/health/edge` as an admin.

Nexus `v0.5.1` reads Edge v0.9.15 unchanged, so the order of steps 3 and 4 does not
matter for compatibility. **Rolling back** Edge to v0.9.14 keeps Nexus working, but
reopens the vulnerabilities v0.9.15 fixes; do it only to restore service.

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

### Single sign-on

All optional. Providers can also be added in **Admin → Settings → Single
sign-on**. Setup, fields and the login policies are in
[§14](#14-single-sign-on-openid-connect).

| Variable                             | Default   | Notes                                                                                                                                                                 |
| ------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXUS_OIDC_PROVIDERS`               | _(empty)_ | JSON array of providers, validated at startup like a settings save. Read-only in the admin UI.                                                                        |
| `NEXUS_OIDC_CLIENT_SECRET_<ID>`      | _(unset)_ | A provider's client secret instead of `client_secret` in the JSON; the id upper-cased, `-` as `_`. Never logged.                                                      |
| `NEXUS_OIDC_ALLOW_HTTP_LOOPBACK`     | `false`   | Development only: accept a plain `http://` issuer on exactly `localhost`, `127.0.0.1` or `::1`. Every other issuer must be `https://`.                                |
| `NEXUS_OIDC_ALLOW_PRIVATE_ADDRESSES` | `false`   | Let provider requests reach private, loopback and reserved addresses, for a provider on a private network. Off, every provider host must resolve to public addresses. |
| `NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN`  | `false`   | Under the `sso_only` policy, still accept password sign-in for `super_admin` accounts. Environment-only; each such sign-in is audited `break_glass`.                  |

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
| `GET /api/catalog/:slug/spec`, `GET /api/catalog/:slug/changes`, `GET /api/catalog/:slug/changes/:revisionId`, per route                                                                                                                                                              | 60/min          | account  |
| `/api/applications` create, update, delete                                                                                                                                                                                                                                            | 30/min          | account  |
| `PATCH /api/users/me`                                                                                                                                                                                                                                                                 | 10/min          | account  |
| `PATCH /api/users/me/notification-preferences`                                                                                                                                                                                                                                        | 10/min          | account  |
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

**Spec change history** (`SPEC_CHANGE_HISTORY_LIMIT`, 100). Each revision that
replaces another also records a change summary for consumers
(`GET /api/catalog/:slug/changes`) in the same transaction. Summaries are kept
apart from the documents, so they survive the pruning above, and are bounded on
their own: the newest 100 per API are kept, and each lists at most 100 changes
with every name cut to 200 characters, so one summary is at most about 115 KiB
of ASCII (more when names are escaped or not ASCII). Real summaries are a few
KiB. Computing one re-reads the previous revision through the upload checks
and compares the two within a fixed work budget, so an upload costs at most one
more parse.

Together these bound per-account spec storage: each document is at most
`MAX_SPEC_BYTES` (2 MiB), so one account stores at most
`2 MiB × (NEXUS_SPEC_HISTORY_LIMIT + 1) × NEXUS_MAX_APIS_PER_OWNER` of
documents — about 1.1 GiB at the defaults — plus at most
`115 KiB × 100 × NEXUS_MAX_APIS_PER_OWNER` of change summaries, about 560 MiB
more in the worst case. Size the database for your provider count.

#### Messaging

Each message writes a message row and an audit row. A **platform thread** (no
`recipient_user_id`) also notifies and emails every active `admin` and
`super_admin`. Broadcasts and mass email fan out further. The bounds:

| Bound                             | Value                                               | Where                                 |
| --------------------------------- | --------------------------------------------------- | ------------------------------------- |
| New threads / replies             | 10 / 30 per minute per account                      | Rate limiter                          |
| Messages per account              | 200 per rolling 24 h (`0` = unlimited)              | `NEXUS_MAX_MESSAGES_PER_USER_PER_DAY` |
| Broadcast recipients              | 5 000 per broadcast (`0` = unlimited)               | `NEXUS_MAX_BROADCAST_RECIPIENTS`      |
| Broadcasts per admin              | 20 per rolling 24 h (`0` = unlimited)               | `NEXUS_MAX_BROADCASTS_PER_DAY`        |
| Mass-email recipients             | 5 000 per campaign (`0` = unlimited)                | `NEXUS_MAX_MASS_EMAIL_RECIPIENTS`     |
| Mass-email size                   | 64 MiB per campaign (`0` = unlimited)               | `NEXUS_MAX_MASS_EMAIL_BYTES`          |
| Mass-email campaigns per admin    | 5 per rolling 24 h (`0` = unlimited)                | `NEXUS_MAX_MASS_EMAILS_PER_DAY`       |
| SMTP tests per admin              | 10 per rolling hour; 3 per minute                   | Fixed; rate limiter                   |
| `message_received` email          | 1 per recipient per thread per 10 minutes           | Outbox idempotency key; fixed         |
| `spec_updated` email              | 1 per recipient per API per clock hour              | Outbox idempotency key; fixed         |
| `api_spec_updated` notice         | 1 while unread; rewritten, not repeated             | Checked per recipient; fixed          |
| `spec_updated` emails per fan-out | `NEXUS_MAX_MASS_EMAIL_RECIPIENTS` (`0` = unlimited) | Past it, in-app only                  |

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
- **A spec change reaches each grantee account once.** When a revision that
  changes something is published, every account holding an active grant on the
  API (once, whatever its identities hold) except the publisher gets an
  `api_spec_updated` notice and, if the account turned email on (it is off by
  default), a `spec_updated` email. A provider publishing many revisions sends
  each account at most one email per API per clock hour and one notice, which
  is rewritten until it is read; both link to the API's Changes tab, which
  lists every revision.
- **The fan-out is detached, batched and capped.** It runs after the revision
  commits and the publish response does not wait for it. It works in
  transactions of 200 accounts, re-reading each account's grant and status,
  each with an `api.spec_notify` audit row counting who was notified, emailed,
  coalesced, capped or had the channel off; a failed batch is logged at `warn`,
  counted as `failed_batches`, and does not stop the next. One fan-out queues
  at most `NEXUS_MAX_MASS_EMAIL_RECIPIENTS` emails (`0` = unlimited), so a
  large API cannot crowd verification and password-reset mail out of the
  outbox, which delivers in the order rows were queued; accounts past the cap,
  the ones latest in the API's grant list, get the in-app notice only.
  Fan-outs of one API run one at a time, and of several waiting only the
  newest runs: its audit rows name the others (`superseded_spec_ids`), and if
  any of them broke something, its notices and email say so. **It is
  best-effort:** on a graceful stop the server stops starting batches and
  waits at most 10 seconds for the running ones; the batches left are skipped
  and recorded as `skipped_batches`, and a crash loses the whole fan-out.
  Nothing retries either.
- **Outbox and notification rows accumulate.** Sent `email_outbox` rows and
  `notifications` are kept, and each spec-change fan-out adds up to one
  notification per grantee account (fewer while notices are unread) and up to
  `NEXUS_MAX_MASS_EMAIL_RECIPIENTS` outbox rows. Neither table is purged by the
  portal; prune old sent outbox rows and read notifications on a schedule if
  they grow large.

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
checksums and `release: 'v0.1.0'`, the forward migrations
`002_api_gateway_plugins` and `003_messages_thread_latest` with
`release: 'v0.2.0'`, `004_api_spec_changes`,
`005_notification_preferences` and `006_user_identities` with
`release: 'v0.3.0'`, and `007_outbox_recipient`, `008_email_lifecycle_fence`,
`009_outbox_priority`, `010_api_agents` and `011_mcp_tool_subsets` with
`release: 'v0.4.0'`, `012_access_request_grant` with `release: 'v0.5.0'`, and
`013_account_recovery_jobs` with `release: 'v0.5.1'`.

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

`005_notification_preferences` (shipped in `v0.3.0`) adds the
`user_notification_preferences` table: one row per account that changed a
notification preference, keyed by the account. It copies no data, so every
existing account gets the defaults (the spec-change notice in-app, no email)
until it changes one. On MongoDB
the collection is keyed by `_id` and the step declares no index.

`004_api_spec_changes` (shipped in `v0.3.0`) adds the
`api_spec_changes` table: one consumer-facing change summary per published
revision, keyed by revision and by publication order, with no foreign key to
`api_specs` so that it outlives retention. It copies no data. Revisions
published before the upgrade have no summary, so each API's change history
starts with its first revision after it.

`006_user_identities` (shipped in `v0.3.0`) adds the single sign-on tables:
`user_identities` (one row per linked provider subject, unique on provider,
issuer and subject, and on account and provider), `user_email_proofs` (the
recorded proof of an account's address) and `user_password_locks` (accounts
that may not use a password). It only adds tables and copies no data, so an
upgraded account has no linked identity, no recorded address proof and no
password lock. See [§14](#14-single-sign-on-openid-connect) for what a missing
proof means for linking.

`007_outbox_recipient` (shipped in `v0.4.0`) adds a nullable `recipient_user_id`
column to the outbox on SQL backends and backfills that field to `null` on
retained MongoDB documents. Existing messages and delivery state are kept.
New account mail names its original recipient; the sender refuses delivery
when that account no longer holds the address. Address recovery cancels all
pending messages to the old address, including unbound legacy rows, and refuses
while any is sending. Upgrade every mail-producing instance before using it.

`008_email_lifecycle_fence` (shipped in `v0.4.0`) adds an internal string fence to
each account, initialized to the empty string on SQL and retained MongoDB
documents. It preserves account IDs, addresses, history and delivery state.
Every account-bound enqueue, claim and SMTP authorization writes a fresh fence
in its transaction while the account still holds the intended address. This
orders them with address release even when its cancellation scan found no mail,
or the producer's transaction had already read the old address. A stale enqueue
is retained as `failed` with `recipient-address-changed`, rather than made
deliverable to a replacement account. The field is internal and absent from user
responses. Upgrade all producers and senders before enabling address recovery;
an older instance does not participate in this fence or SMTP cancellation.

`009_outbox_priority` (shipped in `v0.4.0`) adds an integer priority on all four
backends: low `0`, normal `1`, high `2`. Retained rows default to normal,
including campaigns. The migration promotes only exact, case-sensitive
`verify:` and `reset:` idempotency-key prefixes to high: these durable
namespaces identify registration/resend verification and password recovery,
even when the bodies are sealed. There is no stored template key, so messages
without those keys remain normal rather than being classified from editable
subjects or bodies. All statuses are retained, with no change to attempts,
schedules, errors, timestamps, account bindings or claim generations.
The existing `ix_email_outbox_due` remains; `ix_email_outbox_priority` adds
`(status, priority DESC, next_attempt_at ASC, created_at ASC, id ASC)` claim
ordering (`NULLS FIRST` on PostgreSQL and `_id` on MongoDB). Building the new
index and backfilling a large outbox can delay startup and writes during the
upgrade. Upgrade all producers and workers to get priority ordering throughout
the deployment: older SQL writers use the normal default, older MongoDB writers
omit the field, and older workers still claim by due time. The address recovery
rollout and atomic-transaction requirements from 007/008 still apply.

`010_api_agents` (shipped in `v0.4.0`) adds a nullable `agents_json` column to
`apis` on SQL backends and backfills `agents: null` on retained MongoDB documents.
`null` means agent exposure is off, so every retained API stays unexposed to agents
until its provider turns exposure on. It changes no other API data.

`011_mcp_tool_subsets` (shipped in `v0.4.0`) adds nullable `requested_tools_json`
and `approved_tools_json` columns to `access_requests` and `approved_tools_json` to
`grants` on SQL backends, and backfills the same fields to `null` on retained MongoDB
documents. `null` keeps the meaning every retained request and grant had: all
published tools. Before deploying it, stop and drain every older Nexus request
handler and background writer: an older publisher can overwrite tool policy, and an
older consumer-group rebuild does not understand subset membership. Do not roll back
while explicit subset grants exist. See the
[MCP subset rollout](mcp-subsets-migration-draft.md).

`012_access_request_grant` (shipped in `v0.5.0`) adds a nullable `grant_id` column to
`access_requests` on SQL backends and backfills `grant_id: null` on retained
MongoDB documents. A set `grant_id` marks a request for more MCP tools on that
existing grant; `null` keeps every retained request a request for access. The
column has no foreign key: a grant row is only deleted with its API or
application, which removes the request too. It changes no other data. Before
deploying it, stop and drain every older Nexus request handler and background
writer: an older instance does not read `grant_id`, so it would list and decide a
request for more tools as a request for access.

`013_account_recovery_jobs` (shipped in `v0.5.1`) adds the `account_recovery_jobs`
table (a collection on MongoDB, with the same two indexes): at most one row per
account, holding the credential revocation a trusted password reset owes until a
worker lands it (see [session security](security.md#2-session-security)). On SQL
backends its foreign key to `users` cascades on delete. It only adds an empty table and copies no data, so no
retained account owes a revocation after the upgrade. Before deploying it, stop and
drain every older Nexus request handler and background writer: an older instance
neither writes the row when it completes a password reset nor checks it before
issuing a credential, so it would skip the revocation or issue a credential while
one is owed, and it runs no worker to drain the table.

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
database as each release in the manifest left it (`v0.1.0`, `v0.2.0`, `v0.3.0`,
`v0.4.0`, `v0.5.0`, then `v0.5.1`; every release is a supported upgrade source), seeds it with
baseline-shaped rows, migrates with the current code, reads every value back,
and migrates again to prove the re-run is a no-op. SQLite runs in every CI job;
PostgreSQL, MySQL and MongoDB run in the `store-contracts` job. Per backend:

- **SQLite, PostgreSQL:** each migration and its ledger row commit in one
  transaction. A failed migration leaves no trace; earlier ones stay applied.
- **MySQL:** DDL commits statement by statement. The runner accepts replayable
  `CREATE TABLE IF NOT EXISTS` statements, additive `VARCHAR` columns that
  are nullable or have an empty-string default, and `INT` columns with a
  nonnegative default. It checks live column type, nullability, default,
  collation and generated-column metadata before replaying an ALTER. Added
  indexes are checked for columns/order, direction, uniqueness, prefixes,
  visibility and type. A mismatched existing definition stops the upgrade
  without recording that step. The exact 009 security-priority assignment is
  idempotent and may replay; arbitrary data changes are still refused.
  An advisory lock serializes metadata checks, DDL and ledger writes across
  instances ([details](#retrying-interrupted-mysql-initialization)). Other ALTERs
  or data changes need a replay-safe strategy before the runner accepts them.
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

MySQL DDL commits outside the migration ledger. Released migrations use
`CREATE TABLE IF NOT EXISTS` with indexes and constraints inline. Pending
`007` and `008` add string columns: the runner checks `information_schema.COLUMNS`
and skips only an exact matching definition after an interrupted ALTER.
Re-running finishes an interrupted initialization or upgrade without replacing
tables or changing retained rows. A database-scoped advisory lock
(`GET_LOCK`) serializes migrators across instances, and a migration is recorded
only after all its steps succeed. The runner refuses unsupported statements
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
a digest-pinned `node:22-bookworm-slim`. The supported Node range since `v0.4.0` is
`^22.22.2 || ^24.15.0 || >=26.0.0`; releases before it supported Node 22.14 or later.
The pinned digest contains Node 22.23.3 on amd64 and arm64; the
[migration notes](dependency-majors-449-higher-floor-draft.md) record the published OCI
evidence and the rollback boundary. The image sets:

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
pins the Edge image by digest: Ferrum Edge `v0.9.14` for Nexus `v0.5.1`, and Edge
`v0.9.15` for the next release on `main`. That is the
release the acceptance suite ([`e2e/`](../e2e/README.md)) tests against;
other Edge versions are unverified.

The quickstart pins its PostgreSQL and Alpine images by multi-architecture
digest and sets `FERRUM_BACKEND_ALLOW_IPS=public` on Edge, so the gateway
rechecks public-address policy when it opens each upstream connection. A
deployment that sets `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true` must configure
`FERRUM_BACKEND_ALLOW_CIDRS=<intended private ranges>` while keeping
`FERRUM_BACKEND_ALLOW_IPS=public`. Public mode also screens plugin endpoints,
including private Redis URLs. Under the public profile, any allow-CIDR override
removes the public-only guarantee and refuses backend writes (see
[backend egress admission](#backend-egress-admission-and-the-public-only-guarantee)).

Dependabot proposes digest updates for Compose and Dockerfile images, which are
reviewed with the source change. GitHub Actions workflow service images and
images in workflow `docker run` commands are not tracked by Dependabot; refresh
those digests manually when updating their readable tags. The required `checks`
job runs `ci/check-image-pins.sh` on every PR. The checker scans tracked
Dockerfiles (`FROM` and external `COPY --from`), Compose and workflow YAML image
fields, workflow `docker://` actions and Docker `run`, `create` and `pull`
commands, including shell continuations, plus `FERRUM_EDGE_IMAGE` and `NEXUS_IMAGE` assignments in
`.env`, `.env.*` and `*.env` files. It handles `docker container` commands,
`docker image pull`, Docker global options before the command, and known
image-option values such as `--label`, `-e` and `--name`, inside `$(...)` or
backtick substitutions, quoted `bash -c` strings and `;`/`&&`/`|` chains. A
workflow `env:` value for either variable, at workflow, job or step level, must
be a pinned literal or a local build image; a `${{ … }}` expression fails closed.
An unquoted `$(...)` or backtick substitution inside an option value, as in
`-v $(pwd):/src`, stays with that value so the image after it is found. Unsupported
Docker options, and any `docker ... run|create|pull` segment the scanner cannot
resolve to an image, fail closed. Quoted and flow-style image keys that the simple field
scanner recognizes are checked; malformed or empty image fields fail closed.
Dockerfile comment-only lines inside a continued instruction are ignored as
Docker ignores them. Dockerfile syntax frontends and external images in
`RUN --mount` are checked too. A tracked YAML file with a top-level `services:`
key is scanned as Compose even when its name does not contain `compose`.

Literal image references require their own full `@sha256:` digest of 64
lowercase hexadecimal characters. Version tags can remain before the digest.
Runtime `${FERRUM_EDGE_IMAGE:?...}` and `${NEXUS_IMAGE:?...}` required-variable
references are allowed in Compose files and workflow `image:`/`container:` fields;
workflow `env:` values and env files must assign a pinned image. The acceptance fallback `${NEXUS_IMAGE:-ferrum-nexus:e2e}`
is allowed as a local image; `e2e/.env.example` uses the same local Nexus image
exception. Exact-tag exceptions and their reasons are listed in
`ci/check_image_pins.py`.

This is a bounded static scan of tracked operational files, not a full YAML or
shell interpreter. It does not execute files, scan shell scripts, expand
variables, or resolve computed command names, shell aliases, sourced files or
values assembled indirectly. Workflow Docker commands are checked on individual
lines, including quoted `run:` scalars and backslash continuations. The checker
can only cover image references represented in the tracked file forms it
recognizes.
The local `ferrum-nexus:ci` image in `.github/workflows/ci.yml` and
`ferrum-nexus:e2e` images in `e2e/docker-compose.yml` and
`e2e/.env.example` remain allowed because those are locally built acceptance
images rather than registry references.

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
   [backup and restore reference](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.13/docs/admin_backup_restore.md)).
4. **Edge secrets**, especially `FERRUM_BASIC_AUTH_HMAC_SECRET`. Basic-auth
   credentials are stored as HMACs under it, so a different value rejects every
   basic-auth client.
5. **The versions:** the Nexus and Edge image digests.

**Treat the Edge backup as live credentials.** `GET /backup` exports `keyauth`
keys and `jwt` secrets unredacted. The Nexus database holds only credential
fingerprints and last-four characters, but it does hold password hashes,
session-token hashes and encrypted settings. Encrypt both backups and restrict
access.

### Conditional Edge snapshots and namespace restore

The retained Edge `v0.9.11` operator contract introduced `GET /backup?conditional=true` for a
coherent, complete, unfiltered namespace snapshot and matching strong **namespace**
ETag. Preserve that response header and send it in `If-Match` to
`POST /restore?confirm=true`. Body metadata, consumer row ETags and wildcard tags
are not an authorization substitute for that coherent namespace snapshot. Snapshot
credentials remain live secrets, never Nexus DTOs, logs or audit details.

A malformed/unsupported conditional request is `400`; a stale namespace
precondition is `412` and must not overwrite concurrent updates. `501` means the
backend/topology cannot supply the required atomic/coherent capability (for example
standalone MongoDB); `503` means authoritative snapshot/audit/admission is unavailable.
Fail closed, resolve the condition and obtain a new coherent snapshot; never retry
an old restore body under a newly fetched tag. Verify durable/live state after an
uncertain acknowledgement before retrying. These are distinct from strong **row**
`If-Match` used by Nexus's three whole-consumer callers with
`GET /consumers/{id}/verification`. Tokens are opaque quoted visible ASCII,
validated as one strong entity tag and preserved verbatim; syntax checking does not
validate their MAC. Weak, wildcard, list, empty, control/non-ASCII and ambiguous
duplicate tags refuse the write. Consumer metadata uses Edge's masked projection:
hidden Basic/custom state is restored by the owner under that original row fence,
while historical JWT/HMAC entries are canonicalized to their supported secret field.
The complete verification shape can contain historical empty arrays, objects or
other JSON values. Only exact `[REDACTED]` at keyauth/JWT/HMAC secret sites is a
reserved marker; substrings and custom metadata remain valid. Basic plaintext is
never accepted by verification; an invalid hidden Basic shape reports
`consumer_metadata_unrepresentable` before a PUT, without credential details.

Nexus has no namespace Admin restore caller. Its API gateway restore rebuilds
individual resources and repeats egress admission. Conditional Edge backup does not
make Nexus and Edge backups jointly atomic; keep the writer-drain and paired-backup
procedure below. Nexus `v0.5.0` and `v0.5.1` pair with Edge `v0.9.14` and vendor
`contracts-edge-0.9.14`; Nexus `v0.4.0` paired with Edge `v0.9.13` and vendored
`contracts-edge-0.9.13`. `main` pairs with Edge `v0.9.15` and vendors
`contracts-edge-0.9.15`. See [the adoption facts](edge-0.9.11-adoption.md).

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

Transactional mail goes through `email_outbox`: `EmailService.enqueue` renders
a template, and a worker polls every 5 seconds to deliver it. The admin SMTP
configuration probe uses `EmailService.sendTest` inline.

### Priority at each claim

Due pending rows are claimed by highest priority first: verification and
password-reset/recovery messages are high (`2`), routine notifications normal
(`1`), and new campaigns low (`0`). Within a lane the order is earliest
`next_attempt_at` (null first), oldest `created_at`, then ascending id. A retry
keeps its lane and becomes eligible only when its backoff is due; sent and
failed rows are never claimed.

The worker claims one message at a time. Security mail queued during a campaign
send passes the remaining queued campaign rows at the next claim, after the
active send settles. It cannot preempt active SMTP or avoid polling delay,
recipient-lock contention, other security messages or an unavailable relay.
The priority decision uses the pending rows visible to that claim transaction;
a later enqueue is considered by a subsequent claim. Persistent higher-lane
traffic can delay campaigns. Admin SMTP probes bypass this queue.

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
deadline is recorded as delivered-unacknowledged if the SMTP DATA stream,
including its terminating marker, had been written, and retried otherwise.
Draining the MIME source after an envelope rejection is not delivery evidence.
The sender owns the actual SMTP connection and destroys its socket and MIME
source before reporting timeout; compilation or
DNS finishing later cannot restart the cancelled operation. There is no live
SMTP attempt hidden behind a `failed` row. Authorization refreshes the claim
inside the recipient transaction, and a handoff that resumes after its absolute
deadline opens no connection. The lifecycle lease is renewed only while this
bounded delivery and its bookkeeping run. Address release waits for the sender's
lease or returns `409 CONFLICT`; crashed claims still recover through the normal
five-minute sweep. SMTP may have accepted an already-transmitted message before
cancellation, so delivered-unacknowledged rows remain excluded from retries.

### Two workers, one row

The stale sweep decides by age alone, so it can hand a row to a second worker
while the first is still sending. Each claim carries an internal `generation`
token, and the settling writes (`markSent`, `reschedule`, `markFailed`) require
the claimed id, that token and `status = 'sending'`. A worker whose claim was
taken over logs `Outbox claim was reclaimed by another worker; this attempt did
not settle the row` and changes nothing.

### A mass-email campaign is recorded, then queued in chunks

`POST /api/admin/mass-email` first commits the campaign's `admin.mass_email`
audit row (counted against `NEXUS_MAX_MASS_EMAILS_PER_DAY`), then inserts the
outbox rows in transactions of at most 200 recipients, and fewer when messages
are large (about 4 MiB of rendered content per transaction). Between chunks,
other writes — verification and password-reset enqueues included — get their
turn, so a large campaign no longer stalls the instance while it is written,
and no transaction approaches MongoDB's 16 MB cap.

- **Retry with the same `idempotency_key`.** Rows are keyed
  `mass:<batch>:<user_id>`, so a retry after a lost response is a no-op. If the
  campaign row cannot be written, nothing is queued. If a chunk fails, it rolls
  back alone, the chunks before it stay queued, and the answer is
  `500 OUTBOX_FAILURE` with `details: { batch_id, recipients, enqueued }`;
  retrying with that `batch_id` queues exactly the missing recipients and is
  not charged as a new campaign. Each attempt's result is an
  `admin.mass_email_complete` row (`enqueued`, `chunks`, `failed`).
- **A key names one campaign.** The `admin.mass_email` row stores
  `content_sha256`, a digest of the subject, both bodies and the audience
  selector. The same key with a different subject, body or audience is
  `409 CONFLICT` with `details: { batch_id, reason: "idempotency_key_reused" }`,
  and nothing is queued or charged. Start a new campaign without the key
  instead. An audience that resolves to nobody is `400 VALIDATION_FAILED` and
  costs no campaign.
- **The campaign is bounded** before anything is written, each refusal a
  `429 QUOTA_EXCEEDED` whose `details.setting` names the variable:
  - `NEXUS_MAX_MASS_EMAIL_RECIPIENTS` (default 5 000): the audience.
  - `NEXUS_MAX_MASS_EMAIL_BYTES` (default 64 MiB): an upper bound on one
    rendered message (subject, HTML and text, for the longest recipient name
    and address after HTML escaping, however often the template repeats them)
    times the recipients. The body limits alone allow about 200 KB per message,
    so 5 000 recipients could otherwise queue about a gigabyte. A single
    message too large for a 4 MiB chunk is refused with `400 VALIDATION_FAILED`
    whatever this is set to.
  - `NEXUS_MAX_MASS_EMAILS_PER_DAY` (default 5): campaigns per administrator
    per rolling 24 hours, counted under a per-administrator lease. The default
    keeps a day's campaign backlog to about 320 MiB per administrator. Claim
    priority does not reduce campaign storage, so the cap remains unchanged.

  **Campaign mail uses the low lane in the shared outbox.** Due security mail
  gets the next claim after an active send settles. Keep the bounds close to
  what the portal needs, and prefer several smaller campaigns.

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
SELECT status, priority, count(*) FROM email_outbox GROUP BY status, priority;

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

These subkeys are HKDF-derived from `NEXUS_SECRET_KEY`:

| Subkey                               | HKDF `info`                | Protects                                                                                                  |
| ------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| Settings encryption (AES-256-GCM)    | `nexus-settings-v1`        | `app_settings` rows with `encrypted = 1`: `smtp.password`, `captcha.secret_key`, `sso.client_secret.<id>` |
| Session token HMAC (HMAC-SHA-256)    | `nexus-session-hmac-v1`    | `sessions.token_hash`, `email_verification_tokens.token_hash`                                             |
| Single sign-on attempt (AES-256-GCM) | `nexus-sso-transaction-v1` | The `nexus_sso` cookie of a sign-in in progress (10 minutes at most)                                      |

Encrypted gateway recovery journals use the same settings subkey. Include every
`gateway_recovery:<namespace>:<api_id>` row in settings re-encryption during rotation;
losing that key makes recovery refuse instead of guessing at resource ownership.

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
- **A single sign-on provider saved in settings fails closed**
  (`provider_unavailable`) until its client secret is re-entered. Environment
  providers are unaffected. A sign-in in progress during the swap fails with
  `invalid_state` and can simply be retried.

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

| Row                           | Meaning                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.gateway_repair_required` | A change could not be undone. `conversion` or `rollback` leaves a missing or partial deployment tracked as `repair_required`; `compensation` means fields listed in `details.steps` may not match the catalog.      |
| `api.publish_rollback`        | A publish reached the gateway, then failed. `withdrawn: true` needs nothing. `withdrawn: false` means `details.stranded_proxy_id` may still be live on a staging path with no `apis` row.                           |
| `api.plugin_rollback`         | A palette plugin change failed. `restored: true` needs nothing. `restored: false` means the config in `details.plugin_config_id` may still hold the attempted change; `details.step_errors` says which step failed. |

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
- **`api.gateway_repair_required`, `phase: "conversion"` or `"rollback"`:** restore
  the API through `POST /api/apis/:id/restore-gateway` after fresh policy permits.
  Keep its encrypted recovery setting and original proxy reference until completion.
  If resource validation refuses, reconcile the named partial resources on Edge;
  do not clear the flag merely because that proxy id exists.
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

A second key, `users:lifecycle:<user_id>`, orders an account's role and status
changes against registering a new gateway identity for it
([§11](#11-gateway-revocation-for-disabled-accounts)) and password-reset issuance.
Issuance takes the key before checking eligibility or generating a token and
holds it through preparation and the fenced mint/outbox transaction. A disable
that follows deletes the token; a stale issuer whose lease changed hands cannot
commit after disable/re-enable. A request that takes the key after re-enable
may issue a fresh link. It is always taken inside `users:super-admins` when both
are needed.

This reset-issuance ordering requires every issuing instance to run the
lease-aware version. An older instance can still mint without that key during
a mixed-version rollout.

Single sign-on uses three of these keys. A callback that writes one of a
provider's links (a first-time link or a provisioned account) and every save of
the single sign-on settings take `sso:provider:<id>`; returning sign-ins do not.
Every settings save first takes the deployment-wide `sso:settings` key, then
the affected provider keys in sorted order. A sign-in into an existing account
takes its `users:lifecycle:<user_id>` key; a callback that also writes a new
link takes the provider key first, so a claims promotion and an automatic link
at another provider never miss each other's write.

Returning callbacks authorize at their transaction's settings re-read. In the
supported topology below, production services share one store object and all
four adapters serialize its transaction bodies. A settings-save transaction
cannot commit between that re-read and the callback's commit. Independent store
objects have independent queues: a PostgreSQL, MySQL or replica-set MongoDB
peer can disable a provider in that interval, and the already-authorized
returning callback can still commit. SQLite's `BEGIN IMMEDIATE` blocks that
ordering; provider removal also conflicts with the returning callback's write
to its existing identity. A future multi-active-instance feature needs an
explicitly qualified and tested retirement boundary across independent stores,
or provider-level returning-callback fencing. See
[the security contract](security.md#single-sign-on-openid-connect).

Manual role changes take the account lifecycle key as well. A promotion from
below `admin` to an elevated role is refused while the account has an identity
at a provider not trusted to grant `admin`; remove that identity or restore the
provider's admin trust before promoting. Every manual privilege increase
ends all sessions in the promotion transaction (`user.role_change` records
`terminated_sessions`), including sessions from identities already unlinked.
Address release also takes the account lifecycle key and requires a disabled,
unlinked account with completed gateway teardown.

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
`EDGE_ERROR.details.gateway_message`, except on non-GET `/consumers` writes,
whose request can contain show-once credentials. Those writes log only the
method, path and status and return fixed classifications with safe status
details. For other endpoints, `401`, `403` and `5xx` response text is only in
the log.

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

---

## 14. Single sign-on (OpenID Connect)

Nexus signs users in with any standards-compliant OpenID Connect provider —
Keycloak, Dex, Entra ID, Okta, Auth0, Google Workspace — using the
authorization-code flow with PKCE. Accounts are created on first sign-in, roles
and organizations follow the provider's groups or claims, and each deployment
chooses whether passwords still work. The security model is in
[`security.md`, "Single sign-on"](security.md#single-sign-on-openid-connect).

### Register Nexus with the provider

Create a confidential OpenID Connect client (a public client works too; PKCE is
always used) with:

- **Redirect URI:** `NEXUS_PUBLIC_URL` + `/api/auth/sso/<id>/callback`, where
  `<id>` is the provider id you give Nexus, e.g.
  `https://portal.example.com/api/auth/sso/corp/callback`. **Admin → Settings →
  Single sign-on** shows the exact value for each provider.
- **Grant type:** authorization code. **PKCE:** `S256` (Nexus refuses a
  provider whose discovery document lists PKCE methods without it).
- **Scopes:** `openid email profile`, plus whatever carries your groups (Dex:
  `groups`; Keycloak: a "groups" client-scope mapper, or `realm_access.roles`).
- **ID token signing:** `RS256` or `ES256`. Nothing else is accepted.
- **Claims:** `sub`, `email` and `email_verified`. An address the provider does
  not mark `email_verified: true` (the JSON boolean) is never linked to an
  existing account automatically, never admitted by a domain list, and by
  default never provisioned. Providers that omit the claim (Entra ID, for one)
  need `require_verified_email: false` and no domain list. Their users are then
  provisioned, but an existing account is linked only explicitly, from its
  profile, once the portal holds proof of its address (see "Explicit linking"
  below).

The issuer must be `https://` and must match the provider's discovery document
exactly — including any trailing slash (`https://tenant.auth0.com/`). Nexus
fetches `<issuer>/.well-known/openid-configuration` and the key set over HTTPS,
without following redirects, and caches both for an hour; a failed fetch is
retried after 30 seconds at the earliest. Every provider host, the endpoints
its discovery document names included, must resolve to public addresses. For
a provider on a private network set `NEXUS_OIDC_ALLOW_PRIVATE_ADDRESSES=true`.
Provider requests always connect directly and ignore the environment proxy
settings (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and Node's
`NODE_USE_ENV_PROXY` / `--use-env-proxy`), because a proxy resolves the
provider name itself and cannot be vetted; a deployment whose only egress is a
proxy must allow direct egress to the identity provider.

### Configure the provider in Nexus

Either in the environment (read-only in the admin UI):

```bash
NEXUS_OIDC_PROVIDERS='[{
  "id": "corp",
  "display_name": "Corporate SSO",
  "issuer": "https://idp.example.com/realms/corp",
  "client_id": "nexus",
  "scopes": ["openid", "email", "profile", "groups"],
  "role_mappings": [
    { "claim": "groups", "value": "api-publishers", "role": "provider" },
    { "claim": "groups", "value": "nexus-admins", "role": "admin" }
  ]
}]'
NEXUS_OIDC_CLIENT_SECRET_CORP='…'   # or "client_secret" in the JSON
```

or as a `super_admin` in **Admin → Settings → Single sign-on**, where the
client secret is write-only and stored AES-256-GCM encrypted under
`NEXUS_SECRET_KEY` (`rotate-secret-key` re-encrypts it). An id declared in the
environment cannot also be saved in settings. At most 10 providers in all.

A saved provider's `issuer` cannot change while accounts are linked through it:
the links belong to the old issuer's subjects. Remove the provider, which
deletes its links, and add it again. Accounts it provisioned keep their
password lock (see "How accounts are matched"). If an environment provider is later
declared with the id of a saved one, the environment provider is in force. The
settings page then lists the saved one as shadowed
(`shadowed_provider_ids`), and saving the providers removes it. The
environment provider's links are kept.

| Field                               | Default                        | Meaning                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                | _(required)_                   | 1–32 lower-case letters, digits or hyphens; part of the redirect URI.                                                                                                                    |
| `display_name`                      | the id                         | Label of the sign-in button.                                                                                                                                                             |
| `issuer`, `client_id`               | _(required)_                   | As registered at the provider.                                                                                                                                                           |
| `client_secret`                     | _(none — public client)_       | Sent with `client_secret_basic` (or `client_secret_post` when that is all the provider supports). In the environment it may come from `NEXUS_OIDC_CLIENT_SECRET_<ID>` (`-` becomes `_`). |
| `scopes`                            | `["openid","email","profile"]` | Must include `openid`.                                                                                                                                                                   |
| `enabled`                           | `true`                         | A disabled provider has no button and refuses callbacks.                                                                                                                                 |
| `jit_provisioning`                  | `true`                         | Create an account on first sign-in when none is linked or matched.                                                                                                                       |
| `link_existing_accounts`            | `true`                         | Link automatically to an existing non-admin account with the same address, under the proven-address rule below.                                                                          |
| `require_verified_email`            | `true`                         | Provision only when the provider asserts `email_verified: true`.                                                                                                                         |
| `allowed_email_domains`             | `[]`                           | This provider only: linking and provisioning need a verified address in one of these domains, on top of the deployment-wide list. Empty admits any.                                      |
| `disable_local_password_for_linked` | `false`                        | Refuse password sign-in and reset for accounts linked at this provider, so its offboarding and MFA bind them.                                                                            |
| `sync_roles`                        | `true`                         | Re-apply the mapped role on every sign-in.                                                                                                                                               |
| `default_role`                      | `client`                       | Role when no mapping matches; `null` refuses the sign-in instead.                                                                                                                        |
| `role_mappings`                     | `[]`                           | `{ claim, value, role }`, `role` one of `client`, `provider`, `admin`. The highest matching role wins.                                                                                   |
| `org_mappings`                      | `[]`                           | `{ claim, value, org_id }`; the first match wins, no match means no organization. Empty: organizations are not managed from claims.                                                      |

A `claim` is a claim name (`groups`, or a namespaced `https://example.com/groups`)
or a dot path into the ID token (`realm_access.roles`). It matches when the
claim equals the value or is an array containing it; values compare exactly.
Claims are read from the ID token only — map groups into the ID token at the
provider.

**`super_admin` cannot be mapped.** A mapping names `client`, `provider` or
`admin` only. An account that is a `super_admin` is never changed by claims,
and is not refused when its claims map to no role.
Mapping `admin` makes the provider's group the source of truth for who
administers the portal, which is why only a `super_admin` may edit these
settings.

**Claims do not promote an account another provider can open.** A role
belongs to the account, and a session does not record which provider opened
it. So when a sign-in's claims would raise an account to `admin`, and the
account also holds an identity at another provider that is not itself trusted
with `admin`, the promotion is **withheld**: the sign-in goes ahead with the
account's current role, and an `auth.sso_claims_sync` row records
`role_withheld`, `withheld_reason: "lower_trust_identities"` and
`lower_trust_provider_ids`. Otherwise the identity at that other provider, and
every session opened through it, would become an administrator's too. A
provider is trusted with `admin` when `sync_roles` is on and its default role
or one of its mappings is `admin`: its own identities could already raise the
account. Explicitly linked identities count like automatic ones, since the
portal cannot tell who held the session that linked them. To finish a
withheld promotion, a `super_admin` reviews the account's links
(`GET /api/users/:id/identities`) and either removes the ones its holder does
not recognise, after which the next sign-in promotes it, or restores admin
trust to those providers before promoting the account by hand. A manual
promotion is refused while a lower-trust identity remains linked.

A promotion that goes through ends every other session the account holds
(`terminated_sessions` in the same row), so no session opened before it, by
password, through another provider or through an identity since removed,
carries the new role. The holder's other browsers sign in again. A demotion
needs no such step: every request reloads the role.

### Deployment-wide settings

Also in **Admin → Settings → Single sign-on** (`PUT /api/admin/sso`):

- **Login policy.** `local_and_sso` (the default — with no provider it is
  password-only in effect), `local_only` (single sign-on off), or `sso_only`:
  password sign-in and self-service registration are refused. `sso_only` cannot
  be saved without an enabled provider, nor before the `super_admin` saving it
  has linked their own account to an enabled provider.
- **Allowed email domains.** When set, every single sign-on must present an
  address the provider verified in one of these domains. That includes
  returning users, so once a list is set, a provider that never sends
  `email_verified` (Entra ID, for one) is refused for everyone
  (`email_not_verified`). Domains match exactly: `example.com` does not admit
  `sub.example.com`. A provider's own `allowed_email_domains` applies as well
  when it links or provisions.
- **Deprovision on access loss.** Off by default. When on, a sign-in whose
  claims map to no role disables the account, ends its sessions, revokes its
  outstanding password-reset links and queues the same gateway revocation an
  administrator's disable does
  ([§11](#11-gateway-revocation-for-disabled-accounts)): every ACL group and
  credential of `nexus-user-<id>` and each `nexus-app-<id>` goes. Grants are
  kept, so re-enabling the account restores their ACL groups, as for any
  disable. This runs **when the user next signs in**; Nexus gets no events
  from the provider.

Every save takes the deployment-wide SSO settings lock as well as locks for
the affected providers. Two saves at the same moment do not overwrite each
other: a save whose settings another save changed after it read them is refused
with `409 CONFLICT`. Reload the page and save again. When disabling `sync_roles`
on a provider trusted to grant `admin`, its linked identities keep opening any
existing admin accounts with their current role. The save records the provider
id in `providers_trust_lowered`. To find affected accounts, inspect each admin's
linked identities with `GET /api/users/:id/identities` and look for that
provider id. See
[Single sign-on in the security guide](security.md#single-sign-on-openid-connect).

### How accounts are matched

1. A returning sign-in is matched on the provider id, its issuer and `sub`,
   never on the address. The account's own address is not rewritten when the
   provider's changes.
2. With no link, an existing account with the same address is linked
   automatically only when all of these hold:
   - `link_existing_accounts` is on;
   - the account is not an `admin` or `super_admin`, and the provider's claims
     would not make it one (`privileged_account`);
   - the provider asserts `email_verified: true`;
   - the portal holds a **recorded proof** of the account's address. The
     holder redeemed a verification link or completed a password reset for
     it, or an identity provider asserted it verified when it provisioned or
     linked the account.

   The registration policy plays no part. Accounts registered while
   `require_email_verification` was off have no proof, and turning the
   requirement on later does not give them one. They are linked, automatically
   or explicitly (below), only once their holder verifies or resets. Otherwise
   the sign-in is refused with `account_exists`.

3. Otherwise a new account is created (`jit_provisioning`) with the mapped role
   and organization. It has no usable password: password sign-in fails,
   **Forgot password** sends nothing, and a reset link is refused. The account
   signs in through its provider only. This lock is kept apart from the link
   and cannot be cleared. Unlinking the identity or removing the provider
   leaves the account active but with no way to sign in until a provider
   links it again by its proven address. To end such an account's access,
   disable it.

**An address another provider got to first.** If a provider the holder does
not use provisioned or linked an account at their address first, and the
holder's own provider maps them to `admin`, their sign-in is refused with
`privileged_account`. That is deliberate: linking would promote the account
and hand administrator access to the other provider's identity. When that
account was provisioned through single sign-on it has no password either, so
its holder cannot sign in and link explicitly. The way out depends on whose
account it is, and a `super_admin` decides:

- If the account is the holder's after all (they used the other provider
  once), the holder signs in through that provider and links their
  admin-mapped provider from **Profile → Linked sign-in**. The promotion is
  withheld until a `super_admin` has reviewed the other identity (above).
- If it is not, a `super_admin` disables it (`PATCH /api/users/:id` with
  `status: "disabled"`), which ends its sessions and revokes its gateway
  credentials. In **Admin → Users → Release address**, review and remove
  every identity link and wait for gateway revocation to complete (or use
  **Retry**). Then release the address: `POST /api/users/:id/release-address`
  with `{ "email": "the-current-address" }`. This retains the disabled
  account’s ID and history at a unique reserved `released.nexus.invalid`
  address, deletes its remaining sessions and verification/reset links, and
  cancels queued mail in one audited transaction. A send already in progress
  refuses the release; wait for it to settle and retry. The old account can
  never be re-enabled. The rightful holder’s next sign-in creates a separate
  account with its mapped role; no old grants or credentials transfer.
  `super_admin` accounts cannot be released. A MongoDB replica set is required.
  Upgrade **all** sender instances before using recovery: new account mail is
  bound to the original recipient ID and refused after an address change,
  while an older sender can still enqueue unbound work after release.

**Explicit linking.** A signed-in user links their own account from **Profile →
Linked sign-in**, whatever address the provider holds. The provider's domain
list still applies. This is how administrators link: no provider can link an
`admin` or `super_admin` account by address.

An explicit link needs the same **recorded proof** of the account's address
as an automatic one: a redeemed verification link, a completed password reset,
or an earlier provider-verified provisioning or automatic link. Without it the
link is refused with `address_unproven`, even when the provider asserts
`email_verified: true` for that very address. Otherwise whoever registered an
address first could link an identity they control and keep signing in through
it after the rightful holder resets the password. Accepting an explicit link
records no proof of its own. The one exception is the **founding
`super_admin`**, the account seated with the bootstrap token: the token already
proves the operator owns it, so it links without a proof.

With `require_email_verification` off and no SMTP configured, nothing can
record a proof (verification and reset mail stays queued), so no account but
the founder can link explicitly. To offer single sign-on to such accounts,
configure SMTP: existing holders then prove their address with **Forgot
password**, and with `require_email_verification` on, new registrations prove
it by redeeming their verification link. Otherwise let the provider create the
accounts (`jit_provisioning`), or link them automatically once their address
is proven. The founder's exemption keeps the `sso_only` setup below open on a
portal without mail.

**Passwords of linked accounts.** A pre-existing account keeps its password
when it is linked, so the provider's offboarding and MFA do not bind it: it
can still sign in with the password. Set `disable_local_password_for_linked`
on the provider, or use `sso_only`, where that matters. With the flag on,
password sign-in and reset are refused for every account linked at that
provider while the link exists. A `super_admin` is exempt from all of this, so
break-glass sign-in and password reset always work for one.

Administrators see and remove an account's links with
`GET /api/users/:id/identities` and
`DELETE /api/users/:id/identities/:identityId`. A user sees their own with
`GET /api/users/me/identities`.

### Moving to SSO only, and getting back in

1. Configure the provider under `local_and_sso`. Every `super_admin` signs in
   with their password and links their account from **Profile → Linked
   sign-in**. The portal refuses `sso_only` until the `super_admin` saving it
   has a link to an enabled provider. The founder links without an address
   proof; any other `super_admin` must first verify their address or reset
   their password (`address_unproven` otherwise).
2. Switch the policy to `sso_only`. The founding registration (with the
   bootstrap token) still works on an empty portal.
3. Keep `NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN` in your runbook. Set it to `true`
   and restart, and a `super_admin` can sign in with a password under
   `sso_only`, audited with `break_glass: true`, while everyone else is still
   refused. Use it when the provider is down or misconfigured, fix the
   settings, then remove it.

### When a sign-in fails

The browser lands on `/login?sso_error=<reason>`, or on
`/profile?sso_error=<reason>` for a link started from the profile, and the
server logs
`A single sign-on attempt was refused` at `warn` with the provider id, the
reason and a short detail (never a token or secret):

| Reason                     | Usual cause                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sso_disabled`             | Policy `local_only`, or an unknown or disabled provider — including one removed, disabled or edited while the sign-in was in flight.              |
| `provider_unavailable`     | Discovery, JWKS or the token endpoint failed; an issuer mismatch; a secret that no longer decrypts.                                               |
| `invalid_state`            | The sign-in took over 10 minutes, cookies were blocked, or the response was not for this browser.                                                 |
| `idp_error`                | The provider refused the request (consent denied, client misconfigured).                                                                          |
| `token_invalid`            | The ID token failed validation: wrong issuer or audience, expired or `iat` in the future (beyond 60 s of skew), older than 10 minutes, bad nonce. |
| `email_required`           | No usable `email` claim — request the `email` scope.                                                                                              |
| `email_domain_not_allowed` | The address is outside the allowed domains (deployment-wide or the provider's).                                                                   |
| `email_not_verified`       | The provider did not assert `email_verified: true` where linking, a domain list or provisioning needs it.                                         |
| `account_exists`           | An account holds the address but the portal has no proof of it, or it is linked there already (see "How accounts are matched").                   |
| `address_unproven`         | A profile link to an account the portal holds no address proof for: use **Forgot password**, which confirms the address, then link again.         |
| `privileged_account`       | The account is an `admin` or `super_admin`, or this provider's claims would make it one: it links from its profile only (see below the table).    |
| `link_session_mismatch`    | A profile link came back to a different session, or none: start it again while signed in.                                                         |
| `already_linked`           | A profile link found the identity linked to another account, or this account linked at that provider.                                             |
| `access_denied`            | The claims map to no role.                                                                                                                        |
| `account_disabled`         | The linked account is disabled.                                                                                                                   |
| `signup_disabled`          | No account matched and `jit_provisioning` is off.                                                                                                 |
| `server_error`             | Anything else; see the log.                                                                                                                       |

A holder refused with `privileged_account` who has no other way into the
account holding their address needs a `super_admin`: see "An address another
provider got to first" under "How accounts are matched".

### Local development against a provider

`NEXUS_OIDC_ALLOW_HTTP_LOOPBACK=true` accepts a plain `http://` issuer on
exactly `localhost`, `127.0.0.1` or `::1`, such as a Dex or Keycloak on the
same machine, and exempts those hosts from the public-address check. Every
other issuer must be HTTPS whatever it says. Never set it in production.

The acceptance suite signs in through a real Dex this way
([`e2e/src/sso.test.ts`](../e2e/src/sso.test.ts), `./e2e/run.sh sso`): issuer
`http://127.0.0.1:5556/dex`, `NEXUS_OIDC_ALLOW_HTTP_LOOPBACK=true`, and
`NEXUS_OIDC_ALLOW_PRIVATE_ADDRESSES` left off. Because the issuer must be the
same URL for the browser and for the portal's own calls to the provider, the
portal container shares Dex's network namespace there. A containerized portal
in development needs the same arrangement, or an HTTPS issuer both can reach.

## Gateway resource attribution

Initial provisioning sends `X-Ferrum-Provisioned-By: ferrum-nexus`. A gateway
with resource-label support records `labels: {provisioned-by: ferrum-nexus}` on
consumers, proxies and plugin configs Nexus creates, including resources
generated from API specs. Labels survive later updates. Gateways without label
support ignore the header. Labels are informational: Nexus's stored ids remain
authoritative, and JWT subjects still identify the acting user. Recovery recreation
omits the informational header and carries the retained resource labels exactly,
including an absent origin that an operator removed. Native import replacement
preserves the labels of those same resource ids. Original deployment evidence,
conditional authority, actor subjects and namespace admission remain required.
