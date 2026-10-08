# Ferrum Nexus v0.5.2 — release notes

**Released 2026-10-08.** Paired with Ferrum Edge `v0.9.15`, a security release. The
pair is recorded in [`release/compatibility.env`](../release/compatibility.env), which
the README quickstart, the Compose example, the getting-started walkthrough and the
real-stack `acceptance` CI job all read, so every one of them runs the same gateway
build. `v0.5.2` ships that pairing: Edge `v0.9.15` fixes 26 published Ferrum Edge
security advisories, listed in its
[release notes](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.15), and
**operators should upgrade Edge to `v0.9.15` for those fixes.** Nexus itself adds no
migration, so a `v0.5.1` database opens unchanged, and the gateway's database opens in
place. **Read the [upgrade](#upgrading-from-v051) before starting:** it upgrades Edge,
and Edge `v0.9.15` reserves a header name and refuses some gRPC, WebSocket and MCP
traffic that `v0.9.14` served. The full list of changes is in the
[changelog](../CHANGELOG.md#052---2026-10-08).

## Supported combination

| Component      | Version                                | Pinned as                                                                                                |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Ferrum Nexus   | `v0.5.2`                               | Git tag `v0.5.2`; build `docker/Dockerfile` from that checkout                                           |
| Ferrum Edge    | `v0.9.15`                              | `ferrumedge/ferrum-edge:v0.9.15@sha256:29b468dfeea13b1ecaac8dfbc7e019f310e71e647611d43800a1dc64436eaca3` |
| Node.js        | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | Source installs; the image uses a digest-pinned Node 22 base (22.23.3)                                   |
| Nexus database | PostgreSQL 17 (Compose sample)         | Also supported: SQLite, MySQL, MongoDB replica set — see [schema and upgrades](#schema-and-upgrades)     |

- **Ferrum Edge `v0.9.15`** is the
  [published release](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.15)
  (tag commit `25b37395ff61bfea0f3ffd189d9011c4984fa755`). The digest above is the
  multi-architecture image index; it resolves to
  `sha256:0404dc6d70d67abb70feea4e5aa295fdb1c19a0968900f467fc4b908528d19d1` on
  `linux/amd64` and
  `sha256:51b8134770441b3ad340ba87ca9acd8a03fd864315c54d79911b27d95437c91a` on
  `linux/arm64`. Both were checked against the Docker Hub registry on
  2026-10-08. Nexus vendors the matching contracts, `contracts-edge-0.9.15`
  (`6fb64c5dc2e014204c17609fc717d976f3b4589e`).
- **What changed on the Edge side.** Edge `v0.9.15` keeps every contract Nexus
  depends on: egress policy schema 2 and its data-plane attestation, deployment
  snapshot v2 and its `deployment_snapshot.v2` tokens, and the acknowledgement shape.
  The ConfigSync protocol revision stays `3`, so a control plane and its data planes
  still run the same build, and Edge adds no core schema change, so the gateway
  database opens in place. Read Edge's
  [upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.15/docs/upgrade_guide.md#upgrading-to-0915)
  and its
  [changelog](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.15/CHANGELOG.md)
  for the gateway-wide changes; [Upgrading to Edge v0.9.15](operations.md#upgrading-to-edge-v0915)
  reviews every one Nexus consumes.
- **Other Edge versions are unverified.** Nexus `v0.5.2` is tested only against
  Edge `v0.9.15`. It still reads Edge `v0.9.14`'s answers, which keeps an Edge-only
  rollback possible (see [rollback](#rollback)), but that reopens the vulnerabilities
  `v0.9.15` fixes: run the pinned pair. Edge `v0.9.12` or earlier is refused.
- **No prebuilt Nexus image.** The release is a tagged source build: the
  Dockerfile uses a digest-pinned Node 22 base in both stages and `npm ci`
  against the committed lockfile. The tag, the base digest and the lockfile are
  the reproducible inputs; byte-for-byte image equality across Docker platforms
  is not promised. Record the local image ID you build with each deployment.

## Highlights

- **Pairs with Edge `v0.9.15`, a security release.** It fixes 26 published Ferrum
  Edge advisories; see [security](#security).
- **`X-Authenticated-Identity` is reserved.** The portal and the plugin form refuse it
  as a palette header name, as Edge `v0.9.15` does, before any gateway write.
- **The gRPC and WebSocket refusal is documented.** The palette help, the provider
  guide and the API reference say which Nexus settings make Edge `v0.9.15` refuse
  native gRPC and WebSocket requests to an API.

## Install

From a clean shell, with Docker Compose v2 and `openssl`:

```bash
git clone https://github.com/ferrum-edge/ferrum-nexus.git
cd ferrum-nexus
git checkout --detach v0.5.2
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

Save the four secrets in a secret manager before going further: a restart or
restore needs the same values. The portal is at <http://127.0.0.1:8787> and
`docker compose logs nexus` prints the first-run bootstrap token. The
[getting-started walkthrough](getting-started.md) continues from there to a
published API and an authenticated request through the gateway.

## Upgrading from v0.5.1

`v0.5.1` is the supported upgrade source. A `v0.5.0` or older database also
upgrades in one run (CI covers every release), but read the
[`v0.5.1` notes](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.5.1/docs/release-notes.md#upgrading-from-v050)
first: an upgrade from `v0.5.0` also applies `013_account_recovery_jobs`, which needs
every older Nexus writer drained, and its first trusted password reset revokes
credentials. From `v0.5.1`, Nexus adds no migration; what changes is Edge. Follow the
[production upgrade procedure](operations.md#production-upgrade-procedure) and
[Upgrading to Edge v0.9.15](operations.md#upgrading-to-edge-v0915):

1. **Check the prerequisites.**
   - **Node.** Unchanged since `v0.4.0`: a source install needs Node
     `^22.22.2 || ^24.15.0 || >=26.0.0`. The container image carries Node
     22.23.3.
   - **The gateway.** Work through the Edge
     [upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.15/docs/upgrade_guide.md#upgrading-to-0915)'s
     checklist for anything Nexus does not manage, such as Gateway API routes,
     DestinationRules, plugin configs that name environment variables (now only
     `FERRUM_PLUGIN_SECRET_<NAME>`) and namespace-scoped `operator` tokens.
   - **Palette header names.** Rename any `correlation_id` or
     `request_deduplication` `header_name` that is `X-Authenticated-Identity` (any
     case, `_` or `-`); see [behaviour changes](#behaviour-changes-to-plan-for).
   - **gRPC and WebSocket clients.** Find every API at the `routes` enforcement
     level, available to AI agents, or requiring idempotency keys
     (`enforce_required`) that also serves native gRPC or WebSocket clients. Serve
     that traffic from a separate API, or relax the setting, before upgrading.
   - **MCP concurrency.** Compare each agent API's expected concurrent MCP sessions
     per caller with Edge's new default cap of 128.
2. **Settle gateway recovery work.** Tokens Edge `v0.9.14` issued keep verifying on
   Edge `v0.9.15`, so this is not required, but it keeps the upgrade window free of
   conversions in flight. Run `POST /api/apis/:id/restore-gateway` for every API
   whose `gateway_state` is `repair_required` until it completes, and ask providers
   not to change `spec_enforcement` or restore gateways until the upgrade is done.
3. **Stop and drain every Nexus instance**, request handlers and background
   workers alike, so the backup in the next step is one point in time. `v0.5.2`
   changes no stored data, so a `v0.5.1` writer left running would not corrupt
   anything, but it would keep accepting the header name Edge `v0.9.15` refuses.
4. **Back up Nexus and Edge together**, as one point in time, following the
   [backup and restore runbook](operations.md#5-backup-and-restore). This backup
   is your rollback.
5. **Upgrade Edge to `v0.9.15`** on its existing database. The control plane and
   every data plane must run the same build: upgrade them together. Keep Nexus
   stopped until step 6.
6. **Start `v0.5.2`** on every instance. There is no migration to run. Verify it as
   the procedure says: `schema_migrations` still lists `001_initial` through
   `013_account_recovery_jobs`; `GET /api/health/edge`, read as an administrator,
   reports `status: "ok"` and `public_egress_guaranteed: true` for a local
   public-only data plane or a fully attested control plane; and a known client
   still calls an API through the gateway with its existing credential, its backend
   still receiving `X-Consumer-Username`.

Nexus `v0.5.1` reads Edge `v0.9.15`, and `v0.5.2` reads Edge `v0.9.14`, so a
deployment that cannot keep Nexus stopped across step 5 may upgrade Edge with
`v0.5.1` still running and then upgrade Nexus. Do not stay on a mixed pair: the
palette would accept a header name the gateway refuses.

On the Compose stack, from the checkout you installed from, with the four
secrets you saved at install time exported again (never newly generated
values):

```bash
docker compose stop nexus
git fetch --tags origin
git checkout --detach v0.5.2
set -a
. ./release/compatibility.env
set +a
docker compose up -d ferrum-edge
docker compose up -d --build
```

Take the paired backup (step 4) after `docker compose stop nexus` and before
`docker compose up -d ferrum-edge`. The Compose stack runs a single local Edge
process, so `NEXUS_EXPECTED_DATA_PLANES` does not apply to it. The gateway keeps
the `ferrumdata` volume as it is, and Nexus opens the retained `pgdata` database
with nothing to migrate.

### Behaviour changes to plan for

All are listed in the [changelog](../CHANGELOG.md#052---2026-10-08) and reviewed in
[Upgrading to Edge v0.9.15](operations.md#upgrading-to-edge-v0915).

- **`X-Authenticated-Identity` is reserved.** Edge `v0.9.15` sends an external
  identity as the new gateway-owned `X-Authenticated-Identity` header, and
  `X-Consumer-Username` now carries only a mapped Consumer. Every Nexus caller is a
  mapped Consumer (`nexus-user-<id>` or `nexus-app-<id>`), so backends behind Nexus
  keep receiving `X-Consumer-Username` and never the new header. Edge strips
  `X-Authenticated-Identity` from client requests and refuses it as a configured
  header, and Nexus now does the same: a `correlation_id` or `request_deduplication`
  `header_name` of that name, in any case and with `_` or `-`, is
  `400 VALIDATION_FAILED` in the portal and the plugin form, before any gateway
  write.
- **gRPC and WebSocket requests are refused for some APIs.** Edge `v0.9.15` answers
  a native gRPC or WebSocket request with `403` (trailers-only `PERMISSION_DENIED`
  for gRPC; rejection phase `route_protocol_admission`) when the proxy runs, on
  HTTP, an authentication or admission plugin that cannot run on that flavor. These
  requests used to skip that policy. On Nexus proxies that means an API at the
  `routes` enforcement level (a blocking `openapi_validator`), every API available
  to AI agents (`mcp_gateway`, `openapi_validator`, `ai_tool_governor`,
  `ai_prompt_shield` and the tool-call `rate_limiting`), and an API whose
  idempotency keys use `enforce_required`. The authentication plugins,
  `access_control` and the quota `rate_limiting` run on both flavors, so an API
  without those settings serves gRPC and WebSocket as before. Separately, a client
  that nominates `Authorization` in `Connection` on HTTP/1.1 or HTTP/3 now has it
  removed before authentication and gets `401`.
- **The MCP session store refuses instead of evicting.** Aggregate MCP sessions now
  default to at most 128 live sessions per authenticated principal, which Nexus
  keeps (it sets no `sessions` options). A caller at its own cap has its oldest
  session replaced. When the gateway-wide session store is full and the caller has
  no session to replace, Edge refuses the new session instead of evicting another
  caller's live session, so an MCP client can see initialization refused under
  load. See the [agent marketplace](agent-marketplace.md).
- **IPv6 clients are grouped by `/64`.** Edge's per-source caps and IP-keyed plugin
  state now group IPv6 clients by `/64`. Nexus quotas count by Consumer, and Nexus
  never sets `rate_limiting`'s new `ipv6_prefix`, so portal quotas are unaffected.

### Rollback

Rolling back Edge to `v0.9.14` reopens the vulnerabilities Edge `v0.9.15` fixes
(see [security](#security)), so prefer fixing forward and roll back only to restore
service. Settle recovery journals before rolling back.

Rollback is a restore of the backup taken in step 4, Nexus and Edge together:
restore the Edge database and run Edge `v0.9.14` on it, and restore the Nexus
database and run `v0.5.1` on it. Every post-upgrade change is lost with the restore.
Never run an older image over a database a newer one has used.

Rolling back Edge alone to `v0.9.14` keeps Nexus `v0.5.2` working, since `v0.5.2`
reads Edge `v0.9.14`'s answers and Edge `v0.9.15` adds no core schema change. Nexus
then still refuses `X-Authenticated-Identity` as a header name, which `v0.9.14`
would accept; nothing else Nexus does changes.

## Security

`v0.5.2` pairs Nexus with Edge `v0.9.15`, which fixes 26 published Ferrum Edge
security advisories. They are listed in the
[Edge `v0.9.15` release notes](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.15)
and the Security section of its
[changelog](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.15/CHANGELOG.md). Two
of them change what Nexus users see:

- a native gRPC or WebSocket request no longer skips the `routes` enforcement level,
  MCP governance or a required idempotency key; it is refused instead;
- `X-Consumer-Username` carries only a mapped Consumer, and an external identity
  travels in the gateway-owned `X-Authenticated-Identity`.

Nexus itself carries no new security fix in `v0.5.2`. Upgrade any deployment running
Edge `v0.9.14` or earlier; a deployment still on Nexus `v0.5.0` or earlier also needs
the fixes of [`v0.5.1`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.5.1/docs/release-notes.md#security).

## Schema and upgrades

- **`v0.5.2` adds no migration and freezes nothing.**
  `server/src/db/released-migrations.ts` is unchanged: it lists `001_initial`
  (`v0.1.0`), `002`/`003` (`v0.2.0`), `004` to `006` (`v0.3.0`), `007` to `011`
  (`v0.4.0`), `012` (`v0.5.0`) and `013` (`v0.5.1`), each with a SHA-256 checksum
  per backend, and CI fails on any edit to them. Later releases change the schema
  only with forward migrations that upgrade a `v0.5.2` database in place; see
  [schema versioning and upgrades](operations.md#schema-versioning-and-upgrades).
- **Every release is an upgrade source.** The released-baseline upgrade test
  builds a database as `v0.1.0`, `v0.2.0`, `v0.3.0`, `v0.4.0`, `v0.5.0` and
  `v0.5.1` each left it, migrates it with the current code and reads every value
  back. A `v0.5.2` database is a `v0.5.1` one.
- **No upgrade from pre-release checkouts.** Databases created by buildout
  checkouts before `v0.1.0` are not supported; recreate them
  ([development reset](operations.md#buildout-schema-policy)).
- **Per backend.** SQLite and PostgreSQL apply each migration and its ledger
  row in one transaction. MySQL commits DDL statement by statement; its runner
  accepts only replay-safe forms and checks live definitions before replaying
  one. MongoDB requires a replica set; a standalone server
  (`NEXUS_DB_ALLOW_STANDALONE=true`) carries no upgrade guarantee.
- **Downgrades are not supported.** Roll back by restoring the pre-upgrade
  backup, never by running an older image over an upgraded database.

## Operations

- **Persistence and secrets.** Retain the PostgreSQL `pgdata` and Edge
  `ferrumdata` volumes together. Keep `NEXUS_SECRET_KEY`,
  `FERRUM_ADMIN_JWT_SECRET`, `FERRUM_BASIC_AUTH_HMAC_SECRET` and the database
  password stable across restarts, upgrades and restores, and store them
  outside the source tree. Recovery journals are encrypted under
  `NEXUS_SECRET_KEY` and take part in its key rotation.
- **Backup and restore.** Back up Nexus and Edge together, as one point in
  time, following the [backup and restore runbook](operations.md#5-backup-and-restore).
  Treat a recovery journal's manifest and chunk rows as one record and never
  trim them by hand. The Nexus database alone cannot rebuild Edge consumers,
  credentials, proxies or plugins: without an Edge backup, show-once
  credentials must be re-issued.
- **TLS.** The sample binds the portal and the gateway listener to loopback for
  local HTTP. For a network deployment, terminate TLS at a trusted reverse
  proxy, set `NEXUS_PUBLIC_URL` to the HTTPS origin and
  `NEXUS_COOKIE_SECURE=true`, configure trusted proxies, and keep the Edge
  Admin API private. See
  [TLS operations](operations.md#4-running-behind-tls-and-a-reverse-proxy).
- **Topology.** Run one active Nexus writer. An active/passive standby must
  serve no requests and run no gateway-mutating background work until it is
  promoted. Active-active Nexus is unsupported; see
  [supported topologies](operations.md#supported-topologies).

## Known limitations

- Edge serves one data-plane namespace per process: keep `FERRUM_NAMESPACE`
  equal on both sides.
- A control plane with remote data planes is reported public-only only from
  Edge's data-plane attestation (`v0.9.14` and later) with
  `NEXUS_EXPECTED_DATA_PLANES` set. Nexus reads one control plane, so several
  control plane replicas, a load balancer in front of them or data-plane failover
  withhold the guarantee; such a fleet publishes only with
  `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`, which also skips Nexus's own upstream
  screening, except the gateway-origin check.
- The attestation is self-reported by authenticated data planes, not a
  cryptographic attestation of the data-plane host. The 60-second settle assumes
  the control plane terminates each data plane's HTTP/2 connection itself,
  directly or through an L4 pass-through: behind a proxy that terminates HTTP/2,
  a dead data plane's stream can stay listed for minutes and a restarted data
  plane can count twice. Edge reports no stream liveness, so a data plane whose
  restarted process subscribes to another control plane can still be covered by
  its stale stream for that window. A disconnected data plane that keeps serving
  cached configuration is not listed.
- An API at the `routes` enforcement level, available to AI agents, or requiring
  idempotency keys cannot serve native gRPC or WebSocket clients on Edge
  `v0.9.15`; publish that traffic as a separate API.
- Gateway-origin detection runs at write time only; re-pointing DNS after a publish,
  or moving the gateway, is left to Edge's request-time egress screening
  (`FERRUM_BACKEND_ALLOW_IPS`).
- A password reset revokes credentials only on the account's first trusted proof
  of its current address, and a reset completed before the `v0.5.1` upgrade is not
  revisited. A revocation that cannot be placed without emptying a credential type
  shared with another account stalls for an administrator.
- The public-only DNS-rebinding fixture
  ([`e2e/public-only/`](../e2e/public-only/README.md)) runs on demand with a
  packaged image and covers the local data-plane profile only; it is not part
  of the required CI checks.
- A namespace past Edge's conditional bound (64 MiB of canonical
  representation, or 256 MiB of base64 spec content) answers `507`, so
  enforcement conversions, restores, and credential and access changes are
  refused there until it shrinks.
- An unconfirmed gateway deployment mutation is never resolved automatically;
  the [operator runbook](operations.md#resolving-an-unconfirmed-gateway-deployment-mutation)
  resolves it by observation.
- Other gateway compensation is held in memory: a process that dies between
  Edge applying such a change and its undo running leaves no record
  (`docs/security.md`).
- SMTP must be configured for real email delivery, and, unless the provider
  creates the accounts, for any account but the founder to link a single
  sign-on identity.
- Rate limits, MCP tool-call budgets included, are enforced per gateway process
  unless `FERRUM_RATE_LIMIT_SYNC_MODE=redis` is set.
- The MCP bridge does not expose `HEAD`, `OPTIONS` or `TRACE` operations.

## Release step

This file is published as the GitHub release notes for tag `v0.5.2`. Earlier
notes are kept at their tags:
[`v0.5.1`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.5.1/docs/release-notes.md),
[`v0.5.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.5.0/docs/release-notes.md),
[`v0.4.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.4.0/docs/release-notes.md),
[`v0.3.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.3.0/docs/release-notes.md),
[`v0.2.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.2.0/docs/release-notes.md)
and
[`v0.1.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.1.0/docs/release-notes.md).

1. Merge the release change and require every check, `acceptance` included,
   to pass on the merge commit.
2. Create tag `v0.5.2` at that commit and publish a GitHub release for it with
   these notes.
3. Require a green run of the **verbatim quickstart gate** for the tag
   (`.github/workflows/quickstart-gate.yml`, run by the tag push). In a clean
   hosted runner it checks out the tag, runs the README's full-stack block —
   the lines between the `compose-quickstart` markers, exactly as written —
   waits a bounded time for PostgreSQL, Nexus and the gateway to be healthy,
   then follows the [getting-started walkthrough](getting-started.md) on that
   stack: the founding registration with the logged bootstrap token, a
   published `key_auth` API, an approved access request, an issued key, a
   `200` through the gateway on `:8000` carrying the expected body, a `401`
   without the key and a `403` after revocation. Any other outcome fails the
   run, and the stack is torn down either way. Run it again for any release
   from **Actions → Verbatim quickstart gate → Run workflow**; `ref` defaults
   to the latest published release.
