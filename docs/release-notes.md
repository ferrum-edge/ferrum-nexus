# Ferrum Nexus v0.6.0 — release notes

**Released 2026-11-21.** Paired with Ferrum Edge `v0.9.20`. The pair is recorded in
[`release/compatibility.env`](../release/compatibility.env), which the README
quickstart, the Compose example, the getting-started walkthrough and the real-stack
`acceptance` CI job all read, so every one of them runs the same gateway build.

> **Breaking: one base schema, and no upgrade path before 1.0.** Ferrum Nexus is in
> buildout, and no upgrade paths will be designed until 1.0. `v0.6.0` folds every
> earlier migration (`001_initial` through `015_access_gateway_jobs`) into a single
> base schema per backend, and **a database created by `v0.5.2` or earlier is not
> migrated**: Nexus refuses to start against it, changes nothing, and tells you to
> start against a new, empty database. Read
> [moving from v0.5.2](#moving-from-v052) before you start `v0.6.0` anywhere that
> keeps data.

The full list of changes is in the [changelog](../CHANGELOG.md#060---2026-11-21).

## Supported combination

| Component      | Version                                | Pinned as                                                                                                |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Ferrum Nexus   | `v0.6.0`                               | Git tag `v0.6.0`; build `docker/Dockerfile` from that checkout                                           |
| Ferrum Edge    | `v0.9.20`                              | `ferrumedge/ferrum-edge:v0.9.20@sha256:32a0b0574bb2ed105d315888fab12e33242e1cec3ae9f1ae34c1fb4d0c9a2689` |
| Node.js        | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | Source installs; the image uses a digest-pinned Node 22 base (22.23.5)                                   |
| Nexus database | PostgreSQL 17 (Compose sample)         | Also supported: SQLite, MySQL, MongoDB replica set — see [schema](#schema-no-upgrade-path-before-10)     |

- **Ferrum Edge `v0.9.20`** is the
  [published release](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.20)
  (tag commit `e4a606a00352674daaef08636e3e359e6c48ba18`, published 2026-11-03). The
  digest above is the multi-architecture image index; it resolves to
  `sha256:d3e3e7e8409d0583b23e0fa4eee4b85c7b20885a314d4ada2ca8aad66bd33e1c` on
  `linux/amd64` and
  `sha256:406d8335e60f15ee024141762a7b280bea4abe76fef37ac26b65c45085ae7426` on
  `linux/arm64`. All three were checked against the Docker Hub registry on
  2026-11-21. Nexus vendors the matching contracts, `contracts-edge-0.9.20`
  (`39da322083044c2e92617209e62983c92387f0ad`).
- **What changed on the Edge side.** Since `v0.9.15`, Edge has published `v0.9.17`
  (no `v0.9.16`), `v0.9.19` (no `v0.9.18`) and `v0.9.20`. Every contract Nexus depends
  on is unchanged: egress policy schema 2 and its data-plane attestation, deployment
  snapshot v2 and its `deployment_snapshot.v2` tokens, and the acknowledgement shape.
  The ConfigSync protocol revision stays `3`. But `v0.9.17`, `v0.9.19` and `v0.9.20`
  each refuse configuration and traffic the previous release accepted; see
  [behaviour changes](#behaviour-changes-to-plan-for), and
  [Upgrading to Edge v0.9.17](operations.md#upgrading-to-edge-v0917) and
  [Upgrading to Edge v0.9.20](operations.md#upgrading-to-edge-v0920), which review
  every change Nexus consumes.
- **Other Edge versions are unverified.** Nexus `v0.6.0` is tested only against Edge
  `v0.9.20`. Edge `v0.9.12` or earlier is refused.
- **No prebuilt Nexus image.** The release is a tagged source build: the
  Dockerfile uses a digest-pinned Node 22 base in both stages and `npm ci`
  against the committed lockfile. The tag, the base digest and the lockfile are
  the reproducible inputs; byte-for-byte image equality across Docker platforms
  is not promised. Record the local image ID you build with each deployment.

## Highlights

- **One base schema; no upgrade path before 1.0.** A new database is created directly
  at the final schema. A database created by an earlier version is refused at
  startup, before anything reads it; see [schema](#schema-no-upgrade-path-before-10).
- **Pairs with Edge `v0.9.20`.** Includes Edge `v0.9.17`'s fixes for the published
  QUIC advisories that affect `v0.9.15`, and the stricter admission of `v0.9.19` and
  `v0.9.20`. The palette refuses, before any gateway write, what those releases
  refuse.
- **Grant revocations and access approvals are finished, not stranded** (#651). Each
  decision's gateway half is recorded durably (`access_gateway_jobs`) and a
  background worker completes it after a crash or a failed compensation.
- **Safer credential changes.** Credential deletes are conditioned on the exact
  Edge read they were decided from (`If-Match`, ferrum-edge#7393), `keyauth` and
  `jwt` credentials are deleted by identity rather than by position, and Nexus
  honours Edge's 500-ACL-group cap per consumer.
- **Security fixes in Nexus itself**; see [security](#security).

## Install

From a clean shell, with Docker Compose v2 and `openssl`:

```bash
git clone https://github.com/ferrum-edge/ferrum-nexus.git
cd ferrum-nexus
git checkout --detach v0.6.0
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

## Moving from v0.5.2

There is no upgrade path: `v0.6.0` needs a new, empty Nexus database. Started
against a `v0.5.2` (or older) database, it exits non-zero, changes nothing, and
prints that the database was created by a different Ferrum Nexus schema and that
there is no upgrade path before 1.0. Accounts, organizations, APIs, approvals,
grants, credentials metadata, messages, settings and the audit history in the old
database do not carry over. Follow
[moving to a new release](operations.md#moving-to-a-new-release):

1. **Check the prerequisites.**
   - **Node.** Unchanged since `v0.4.0`: a source install needs Node
     `^22.22.2 || ^24.15.0 || >=26.0.0`. The container image carries Node 22.23.5.
   - **The gateway.** Work through the Edge upgrade guide's sections for
     [0.9.17](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.17/docs/upgrade_guide.md#upgrading-to-0917),
     [0.9.19](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.20/docs/upgrade_guide.md#upgrading-to-0919)
     and
     [0.9.20](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.20/docs/upgrade_guide.md#upgrading-to-0920)
     for anything Nexus does not manage.
   - **Saved palette settings, while the `v0.5.2` portal still runs.** Edge
     refuses to start on a saved config it rejects. Rename any `correlation_id`
     `header_name` set to `X-Ferrum-Hops`, `X-Real-IP` or `X-Geo-Country`, and fix
     or remove the `compression` and `ip_restriction` values Edge `v0.9.19`
     refuses (step 1 of [Upgrading to Edge v0.9.17](operations.md#upgrading-to-edge-v0917)
     and of [Upgrading to Edge v0.9.20](operations.md#upgrading-to-edge-v0920)).
     Settle recovery journals too.
2. **Stop every Nexus instance**, request handlers and background workers alike.
3. **Back up Nexus and Edge together**, as one point in time, following the
   [backup and restore runbook](operations.md#5-backup-and-restore). This backup is
   your only way back to `v0.5.2`; `v0.6.0` cannot read it.
4. **Upgrade Edge to `v0.9.20`**, the control plane and every data plane together.
5. **Create a new, empty Nexus database.** For SQLite, delete (or move aside) the
   database file and its `-wal` and `-shm` files. For PostgreSQL, MySQL or MongoDB,
   drop and recreate the dedicated Nexus database, or point `NEXUS_DB_URL` at a new
   one.
6. **Deal with what the old portal created in Edge.** Its proxies, consumers,
   credentials and plugin configs in `FERRUM_NAMESPACE` stay in Edge, and the new
   database does not know them. Remove them from that namespace, or give the new
   portal its own namespace (and the gateway access that needs), so that nothing
   left over keeps serving traffic or collides with what the new portal creates.
7. **Start `v0.6.0`** on every instance. It creates the schema; register the
   founding `super_admin` with the bootstrap token, then re-create organizations,
   APIs and access. Verify that `GET /api/health/edge`, read as an administrator,
   reports `status: "ok"`, and that a client calls an API through the gateway with
   a credential the new portal issued.

On the Compose stack the gateway serves only this portal, so the simplest path is
to start both from empty volumes. From the checkout you installed from, with the
four secrets you saved at install time exported again (never newly generated
values), after taking the paired backup (step 3):

```bash
docker compose down -v
git fetch --tags origin
git checkout --detach v0.6.0
set -a
. ./release/compatibility.env
set +a
docker compose up -d --build
```

`docker compose down -v` deletes both the Nexus database (`pgdata`) and the
gateway's database (`ferrumdata`), which covers steps 5 and 6; run it only after
the backup. Then register the founding administrator again with the bootstrap
token from `docker compose logs nexus`.

### Behaviour changes to plan for

All are listed in the [changelog](../CHANGELOG.md#060---2026-11-21) and reviewed in
[Upgrading to Edge v0.9.17](operations.md#upgrading-to-edge-v0917) and
[Upgrading to Edge v0.9.20](operations.md#upgrading-to-edge-v0920).

- **The schema.** A database created by an earlier version is refused; see
  [schema](#schema-no-upgrade-path-before-10).
- **Namespace-bounded admin tokens** (Edge `v0.9.17`). Every admin token Nexus
  mints carries an `ns` claim, so Edge refuses it on the fleet-wide metrics reads.
  The Usage card needs `FERRUM_METRICS_BEARER_TOKEN` (and optionally
  `FERRUM_ADMIN_FLEET_READ_JWT_SECRET`) to show request counts.
- **Reserved header names.** `X-Ferrum-Hops`, `X-Real-IP` and `X-Geo-Country` (any
  case, `_` or `-`) are refused as a `correlation_id` `header_name`, as
  `X-Authenticated-Identity` already was.
- **Stricter palette admission** (Edge `v0.9.19`). Duplicate or wildcard-misplaced
  `compression` algorithms and content types, an empty `content_types` list, and a
  non-canonical `ip_restriction` prefix length are `400 VALIDATION_FAILED`.
  `ip_restriction` no longer has an evaluation order (`mode`), which the next Edge
  release removes.
- **JWT clients must leave out `aud`** (Edge `v0.9.19`): `jwt_auth` refuses a token
  whose `aud` is not configured, and Nexus configures none. A request carrying two
  credentials is refused with `400`.
- **Request parameters on `routes` APIs** (Edge `v0.9.19`). A document whose
  required parameter uses a serialization the gateway's validator cannot read is
  refused at import. Nexus keeps request validation off, so a `routes` API still
  enforces only its paths and methods.
- **Agent APIs** (Edge `v0.9.19`). An MCP tool call no longer forwards the caller's
  credentials or query string to the backend. An API cannot use request
  deduplication and be available to AI agents at once; the portal refuses the pair.
- **Idempotency keys** (Edge `v0.9.19`). A retry that crosses the gateway upgrade
  runs again instead of replaying.

### Rollback

Rollback is a restore of the backup taken in step 3, Nexus and Edge together:
restore the Edge database and run the Edge release it came from, and restore the
Nexus database into an empty database and run `v0.5.2` on it. Everything done on
`v0.6.0` is lost with the restore. Never point `v0.5.2` at a database `v0.6.0`
created: it does not know the new schema ledger and would try to replay its
migrations over it.

## Security

Fixed in Nexus since `v0.5.2` (details in the
[changelog](../CHANGELOG.md#060---2026-11-21)):

- An SMTP relay configured for STARTTLS no longer falls back to plaintext
  ([GHSA-v7p7-85wx-8wrp](https://github.com/ferrum-edge/ferrum-nexus/security/advisories/GHSA-v7p7-85wx-8wrp)).
- Encrypted settings are bound to their row, so a ciphertext cannot be transplanted
  to another secret
  ([GHSA-qm46-qg94-mpg7](https://github.com/ferrum-edge/ferrum-nexus/security/advisories/GHSA-qm46-qg94-mpg7)).
- Registration re-checks its policy when it commits
  ([GHSA-9cr4-49fg-gfcx](https://github.com/ferrum-edge/ferrum-nexus/security/advisories/GHSA-9cr4-49fg-gfcx)).
- Turning the login policy to `local_only` ends the sessions of every account
  linked at a provider it shuts out
  ([GHSA-627m-vcp5-v2p7](https://github.com/ferrum-edge/ferrum-nexus/security/advisories/GHSA-627m-vcp5-v2p7));
  a returning single sign-on commits under the provider's lease, so a concurrent
  settings change that cuts the provider off also cuts that session off
  ([GHSA-2343-7j5f-mjcv](https://github.com/ferrum-edge/ferrum-nexus/security/advisories/GHSA-2343-7j5f-mjcv));
  and unlinking an identity re-checks the account's role inside its transaction
  ([GHSA-3qj2-5wrm-hgr4](https://github.com/ferrum-edge/ferrum-nexus/security/advisories/GHSA-3qj2-5wrm-hgr4)).
- A grant revocation or access approval interrupted between its decision and its
  Edge write is finished by a worker instead of leaving gateway access live (#651).
- Sessions have an absolute lifetime; anonymous health checks no longer fingerprint
  the deployment; stored scrypt parameters are bounded before verification; the
  Content-Security-Policy admits only the CAPTCHA provider in use; the SMTP password
  is presented only to the relay it was stored for; a recipient's display name can
  no longer stop a mass-email campaign; API deletion never removes an operator's own
  plugin config; and private APIs' summaries are no longer shown to an account that
  can no longer read the API.

Edge `v0.9.17` fixes the published QUIC advisories that affect Edge `v0.9.15`; see
the [Edge security advisories](https://github.com/ferrum-edge/ferrum-edge/security/advisories)
and the Edge [changelog](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.20/CHANGELOG.md).

## Schema: no upgrade path before 1.0

- **One base schema per backend.** `server/src/db/schema/base.sql` (SQLite),
  `base.pg.sql` (PostgreSQL), `base.mysql.sql` (MySQL) and `BASE_INDEXES` in the
  MongoDB adapter. The earlier migration chain, including the never-released
  `014_mysql_text_capacity` and `015_access_gateway_jobs`, is folded into it, and the
  released-migration freeze and upgrade suite are gone. Until 1.0, schema changes
  edit the base schema directly.
- **What startup does.** Nexus records the base schema's generation,
  `000_base_v0_6`, as the only entry of `schema_migrations`. An empty database
  gets the schema, and a database at the same generation is left alone. Anything
  else is refused with an error, and its schema and data are left unchanged. That
  includes a `v0.5.2` database, whose ledger lists `001_initial` to
  `013_account_recovery_jobs`. `npm run migrate` (and
  `node server/dist/db/migrate-cli.js` in the image) does the same and prints
  `Schema ready (driver: …).`
- **Later releases.** The generation is bumped whenever the base schema changes,
  so a release that changes it refuses databases created by earlier ones; a
  release that keeps it opens the previous release's database. Each release's notes say which. See
  [schema and upgrades before 1.0](operations.md#schema-and-upgrades-before-10).
- **Downgrades are not supported.** Roll back by restoring the backup into the
  release that wrote it.

## Operations

- **Persistence and secrets.** Retain the PostgreSQL `pgdata` and Edge
  `ferrumdata` volumes together. Keep `NEXUS_SECRET_KEY`,
  `FERRUM_ADMIN_JWT_SECRET`, `FERRUM_BASIC_AUTH_HMAC_SECRET` and the database
  password stable across restarts and restores, and store them outside the source
  tree. Recovery journals are encrypted under `NEXUS_SECRET_KEY` and take part in
  its key rotation.
- **Backup and restore.** Back up Nexus and Edge together, as one point in
  time, following the [backup and restore runbook](operations.md#5-backup-and-restore).
  Restore into the same Nexus release that wrote the backup. The Nexus database
  alone cannot rebuild Edge consumers, credentials, proxies or plugins: without an
  Edge backup, show-once credentials must be re-issued.
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

- There is no upgrade path between releases before 1.0; plan to recreate the Nexus
  database when a release changes the schema.
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
  plane can count twice. A disconnected data plane that keeps serving cached
  configuration is not listed.
- An API at the `routes` enforcement level, available to AI agents, or requiring
  idempotency keys cannot serve native gRPC or WebSocket clients; publish that
  traffic as a separate API. A `routes` API does not check request parameters.
- Gateway-origin detection runs at write time only; re-pointing DNS after a publish,
  or moving the gateway, is left to Edge's request-time egress screening
  (`FERRUM_BACKEND_ALLOW_IPS`).
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
- Gateway compensation other than grant revocations, access approvals and account
  recovery is held in memory: a process that dies between Edge applying such a
  change and its undo running leaves no record (`docs/security.md`).
- SMTP must be configured for real email delivery, and, unless the provider
  creates the accounts, for any account but the founder to link a single
  sign-on identity.
- Rate limits, MCP tool-call budgets included, are enforced per gateway process
  unless `FERRUM_RATE_LIMIT_SYNC_MODE=redis` is set.
- The MCP bridge does not expose `HEAD`, `OPTIONS` or `TRACE` operations.

## Release step

This file is published as the GitHub release notes for tag `v0.6.0`. Earlier
notes are kept at their tags:
[`v0.5.2`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.5.2/docs/release-notes.md),
[`v0.5.1`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.5.1/docs/release-notes.md),
[`v0.5.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.5.0/docs/release-notes.md),
[`v0.4.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.4.0/docs/release-notes.md),
[`v0.3.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.3.0/docs/release-notes.md),
[`v0.2.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.2.0/docs/release-notes.md)
and
[`v0.1.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.1.0/docs/release-notes.md).

1. Merge the release change and require every check, `acceptance` included,
   to pass on the merge commit.
2. Create tag `v0.6.0` at that commit and publish a GitHub release for it with
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
