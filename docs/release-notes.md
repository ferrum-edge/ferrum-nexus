# Ferrum Nexus v0.5.0 — release notes

**Released 2026-10-08.** Paired with Ferrum Edge `v0.9.14`. The pair is recorded
in [`release/compatibility.env`](../release/compatibility.env), which the
README quickstart, the Compose example, the getting-started walkthrough and the
real-stack `acceptance` CI job all read, so every one of them runs the same
gateway build. `v0.5.0` lets the holder of an explicit MCP tool subset request
more tools on its existing grant without losing access, announces renamed agent
tools, completes the hardening of the public-only egress guarantee for
control-plane/data-plane topologies, and reports a deployment mutation Edge proves
it did not commit under its own error kind. It upgrades a `v0.4.0` database in
place with one forward migration, and the gateway's database carries over
unchanged. **Read the [upgrade](#upgrading-from-v040) before starting:** it
requires every older Nexus writer to be stopped and drained, needs Nexus and Edge
upgraded in one window, and changes an error kind that clients and alerts may key
on. The full list of changes is in the
[changelog](../CHANGELOG.md#050---2026-10-08).

## Supported combination

| Component      | Version                                | Pinned as                                                                                                |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Ferrum Nexus   | `v0.5.0`                               | Git tag `v0.5.0`; build `docker/Dockerfile` from that checkout                                           |
| Ferrum Edge    | `v0.9.14`                              | `ferrumedge/ferrum-edge:v0.9.14@sha256:15442f1b1d1758023fe871fe57be50f19caf34bbe6c499a6812f4ffd0da5e3f8` |
| Node.js        | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | Source installs; the image uses a digest-pinned Node 22 base (22.23.3)                                   |
| Nexus database | PostgreSQL 17 (Compose sample)         | Also supported: SQLite, MySQL, MongoDB replica set — see [schema and upgrades](#schema-and-upgrades)     |

- **Ferrum Edge `v0.9.14`** is the
  [published release](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.14)
  (tag commit `9bd4d5f9caa4ebe8f0ea13e76d8a6e2172eaca7d`). The digest above is
  the multi-architecture image index; it resolves to
  `sha256:12a8cd56090c0d4511bb3015b240e606b1b87989c644157566b8f6b6f635b3c2` on
  `linux/amd64` and
  `sha256:19d2886ed8c192cb0daba48ef0a27a0cd0526449dac74bf9438502322aabd9f2` on
  `linux/arm64`. Both were checked against the Docker Hub registry on
  2026-10-08. Nexus vendors the matching contracts, `contracts-edge-0.9.14`
  (`ddbdd845733b7046c4393ac951011dafb774db33`).
- **What changed on the Edge side.** Edge `v0.9.14` keeps every contract Nexus
  depends on: egress policy schema 2, deployment snapshot v2 and its
  `deployment_snapshot.v2` tokens, and the acknowledgement shape. A control
  plane's egress policy answer gains the optional `data_plane_attestation`
  object, a conditional mutation whose store fails before commit answers `503`
  with `durable` `not_started` or `not_committed` instead of `unknown`, and the
  ConfigSync protocol revision is now `3`, so a control plane and its data
  planes must run the same build. Edge `v0.9.14` adds no core schema change, so
  the gateway database opens in place. Read Edge's
  [upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.14/docs/upgrade_guide.md#upgrading-to-0914)
  and its
  [changelog](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.14/CHANGELOG.md)
  for the data-plane changes your clients may notice, such as backend HTTP/2
  resets now classified as `protocol_error` and charged to the target's circuit
  breaker, and a buffered response read timeout answering `504` instead of `502`.
- **Other Edge versions are unverified.** Nexus `v0.5.0` is tested only against
  Edge `v0.9.14`. It still reads Edge `v0.9.13`'s answers, which keeps an
  Edge-only rollback possible (see [rollback](#rollback)), but run the pinned pair.
  Edge `v0.9.12` or earlier is refused, as in `v0.4.0`.
- **No prebuilt Nexus image.** The release is a tagged source build: the
  Dockerfile uses a digest-pinned Node 22 base in both stages and `npm ci`
  against the committed lockfile. The tag, the base digest and the lockfile are
  the reproducible inputs; byte-for-byte image equality across Docker platforms
  is not promised. Record the local image ID you build with each deployment.

## Highlights

- **Request more MCP tools on an existing grant.** A holder of an explicit tool
  subset loses a tool when its provider redefines or renames it. It can now ask
  for that tool, or any other uncovered one, on the grant it already holds
  (`POST /api/grants/:id/tool-requests`), and the provider decides it like any
  access request. REST access and the tools already approved stay in place
  throughout. See the [API reference](api.md) and the
  [subset rollout](mcp-subsets-migration-draft.md).
- **Renamed tools are announced.** An agents edit that renames a tool drops it
  from explicit subsets, as before, and its holders now get an in-app notice
  naming the old and new name, as for a redefined tool.
- **Attested public-only egress for control-plane/data-plane pairings.** With
  Edge `v0.9.14` and `NEXUS_EXPECTED_DATA_PLANES` set, a control plane whose
  connected data planes all attest public-only egress publishes under the
  default public profile, with no opt-out. See
  [CP/DP pairings and data-plane attestation](operations.md#cpdp-pairings-and-data-plane-attestation).
- **A deployment mutation Edge did not commit is named.** It reports
  `details.kind` `deployment_not_committed` instead of
  `deployment_acknowledgement_uncertain`; see
  [behaviour changes](#behaviour-changes-to-plan-for).
- **Fewer gateway reads per spec build.** A revision, rollback, agents edit,
  restore or conversion of an agent API no longer reads every all-tools
  grantee's consumer from the gateway; enrollment runs only when agents are
  turned on or a retained selection is given its exposure IDs.

## Install

From a clean shell, with Docker Compose v2 and `openssl`:

```bash
git clone https://github.com/ferrum-edge/ferrum-nexus.git
cd ferrum-nexus
git checkout --detach v0.5.0
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

## Upgrading from v0.4.0

`v0.4.0` is the supported upgrade source. A `v0.3.0`, `v0.2.0` or `v0.1.0`
database also upgrades in one run (CI covers every release), but read the
[`v0.4.0` notes](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.4.0/docs/release-notes.md#upgrading-from-v030)
first: those releases ran an older Edge, and their upgrade has its own
prerequisites (Node floor, public-only egress, settling recovery journals). Upgrade
Nexus and Edge together, in one maintenance window, following the
[production upgrade procedure](operations.md#production-upgrade-procedure):

1. **Check the prerequisites.**
   - **Node.** Unchanged since `v0.4.0`: a source install needs Node
     `^22.22.2 || ^24.15.0 || >=26.0.0`. The container image carries Node
     22.23.3.
   - **Gateway egress.** Unchanged for a single Edge process that answers the
     Admin API and serves the traffic: it still needs
     `FERRUM_BACKEND_ALLOW_IPS=public` without allow CIDRs. A control plane with
     remote data planes can now be admitted on its data planes' attestation, but
     only with `NEXUS_EXPECTED_DATA_PLANES` set; see
     [data-plane attestation](#data-plane-attestation-and-nexus_expected_data_planes).
     A pairing that publishes today under `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`
     keeps doing so.
   - **Clients and alerts.** Update anything keyed on
     `deployment_acknowledgement_uncertain` or on the gateway's `502` rate; see
     [behaviour changes](#behaviour-changes-to-plan-for).
2. **Settle gateway recovery work on the old pairing.** Tokens Edge `v0.9.13`
   issued keep verifying on Edge `v0.9.14`, so this is not required, but it keeps
   the upgrade window free of conversions in flight. Run
   `POST /api/apis/:id/restore-gateway` for every API whose `gateway_state` is
   `repair_required` until it completes, and ask providers not to change
   `spec_enforcement` or restore gateways until the upgrade is done. See
   [Upgrading to Edge v0.9.14](operations.md#upgrading-to-edge-v0914).
3. **Stop and drain every Nexus instance**, request handlers and background
   workers alike. Older and newer writers must never run together:
   `012_access_request_grant` adds the field that marks a request for more tools
   on a grant, and a `v0.4.0` instance, which does not read it, would list and
   decide such a request as a request for access. `v0.4.0` also reads the
   egress policy answer as a closed key set, so it refuses every backend write
   once a control plane answers with Edge `v0.9.14`'s attestation.
4. **Back up Nexus and Edge together**, as one point in time, following the
   [backup and restore runbook](operations.md#5-backup-and-restore). This backup
   is your rollback.
5. **Upgrade Edge to `v0.9.14`** on its existing database. The control plane
   and every data plane must run the same build: upgrade them together. A data
   plane on an older build cannot connect, and the control plane cannot list it
   in its attestation. Keep Nexus stopped until step 7.
6. **Run the migration once from the new Nexus image**
   (`node server/dist/db/migrate-cli.js`). It applies
   `012_access_request_grant`; re-running it is safe. Nexus also migrates at
   startup, so a single-instance deployment may skip this step.
7. **Start `v0.5.0`** on every instance, with `NEXUS_EXPECTED_DATA_PLANES` set
   first on a control-plane/data-plane pairing that should have the attested
   guarantee. Verify it as the procedure says: `schema_migrations` lists
   `001_initial` through `012_access_request_grant`; `GET /api/health/edge`,
   read as an administrator, reports `status: "ok"` and
   `public_egress_guaranteed: true` for a local public-only data plane or a
   fully attested control plane; and a known client still calls an API through
   the gateway with its existing credential.

On the Compose stack, from the checkout you installed from, with the four
secrets you saved at install time exported again (never newly generated
values):

```bash
docker compose stop nexus
git fetch --tags origin
git checkout --detach v0.5.0
set -a
. ./release/compatibility.env
set +a
docker compose up -d ferrum-edge
docker compose up -d --build
```

Take the paired backup (step 4) after `docker compose stop nexus` and before
`docker compose up -d ferrum-edge`. The Compose stack runs a single local Edge
process, so `NEXUS_EXPECTED_DATA_PLANES` does not apply to it. The gateway keeps
the `ferrumdata` volume as it is, and Nexus migrates the retained `pgdata`
database when it starts.

What the migration does, on every backend:

- **`012_access_request_grant`** adds a nullable `grant_id` to each access
  request on SQL backends, and sets `grant_id: null` on retained MongoDB
  documents. A set value marks a request for more tools on that grant; every
  retained request keeps `null` and stays a request for access. It changes no
  other data. On MySQL it is an additive nullable column, which the runner checks
  before replaying an interrupted upgrade.

### Data-plane attestation and `NEXUS_EXPECTED_DATA_PLANES`

Nexus grants a control plane the public-only guarantee only from the
`data_plane_attestation` object Edge `v0.9.14` adds to its egress policy
answer, and only when all of these hold: `NEXUS_EXPECTED_DATA_PLANES` is set,
at least that many distinct data planes (`node_id`) are connected, every
connected data plane sent a report, every report is `public` mode without allow
CIDRs, and Edge's aggregate matches the listed reports, which Nexus recomputes.
Anything else reads "not guaranteed": backend writes are refused unless an
opt-out admits them, and health reads `degraded`.

- **Unset (the default) or blank, an attestation never grants the guarantee.**
  A control plane then behaves as it did with `v0.4.0`.
- **Set it to the namespace's whole data-plane inventory**: the number of
  running data-plane processes (replicas or pods) across every control plane,
  not only those connected to the control plane at `FERRUM_ADMIN_URL`. Each
  process reports its own random `node_id`, even when replicas share one CP/DP
  secret. Never set it lower than the real inventory, and raise it before new
  data planes connect.
- **It must be a positive integer** (up to 1,000,000); anything else refuses
  startup.
- **Several control plane replicas, a load balancer in front of them, or data
  planes that fail over between control planes** leave the control plane Nexus
  reads with a short count, so the guarantee is withheld. Nexus cannot combine
  answers from several control planes.

Writes admitted on an attestation record `egress_profile: public-guaranteed`
with `enforcement_scope: admission-only`. The verdict is re-read for every
backend write and health probe, with no caching or grace period. The
[operations guide](operations.md#cpdp-pairings-and-data-plane-attestation)
covers restarts, stale streams and what the attestation does not prove.

### Behaviour changes to plan for

All are listed in the [changelog](../CHANGELOG.md#050---2026-10-08).

- **A deployment mutation Edge did not commit has a new error kind.** An
  acknowledgement whose `durable` is `not_started` or `not_committed` now answers
  `502 EDGE_ERROR` with `details.kind` `deployment_not_committed` instead of
  `deployment_acknowledgement_uncertain` at every status other than a
  `409`/`412` precondition refusal or a `507` size refusal, which keep their
  kinds: Edge `v0.9.14`'s `503` store failure, and equally an Edge `400` or
  `501` that carries such an acknowledgement. Its message becomes "The gateway did not
  commit the deployment mutation; nothing was applied. Retain recovery state",
  and so does the `error` text of the failure audit rows. Only
  `durable: "unknown"` and any other unconfirmed answer stay
  `deployment_acknowledgement_uncertain`. The recovery journal is kept and never
  resent under either kind. Update any client, alert or audit query keyed on the
  old kind or message; the
  [operator runbook](operations.md#resolving-an-unconfirmed-gateway-deployment-mutation)
  covers both.
- **Some backend failures move from `502` to `504`.** Edge `v0.9.14` answers a
  buffered response read timeout with `504`. Nexus's per-API metrics count by
  status code only, so adjust any alert keyed on the `502` bucket.
- **Agent selections are bounded after Path Item references resolve.**
  Publishing, revising, rolling back or restoring an agent API, a `PATCH` of
  `agents` or `spec_enforcement`, and the provider's operation picker refuse a
  document with more than 3,000 operations once Path Item references resolve
  (`400 SPEC_INVALID`). The upload limit counts only the method keys each path
  declares, so a document can pass the upload and still be refused for agents.
  Routes APIs without agents are unaffected.
- **A renamed tool is pruned as `tool_renamed`.** `access.tools_prune` records
  `reason: "tool_renamed"` instead of `tool_removed` when an agents edit renames
  a tool.
- **Attestation entries need an RFC 3339 `connected_at`.** An attestation with
  any other `connected_at` is set aside as malformed and grants nothing.
- **Access requests carry `grant_id`.** Request DTOs gain a nullable `grant_id`,
  set on a request for more tools on that grant.
- **New audit actions**: `access.tools_request`, `access.tools_approve` and
  `access.tools_approve_rollback`; update any tooling that reads the audit log.

### Rollback

Rollback is a restore of the backup taken in step 4, Nexus and Edge together:
restore the Edge database and run Edge `v0.9.13` on it, and restore the Nexus
database and run `v0.4.0` on it. Never run `v0.4.0` over a database `v0.5.0`
migrated. Tool requests filed or approved after the upgrade are lost with every
other post-upgrade change. Rolling back Edge alone to `v0.9.13`
keeps Nexus `v0.5.0` working: the attestation disappears, so a pairing that
relied on it reads "not guaranteed" again and its writes are refused unless an
opt-out admits them. Settle recovery journals before either rollback.

## Security

`v0.5.0` completes the hardening of the public-only egress guarantee for
control-plane/data-plane topologies. A control plane is reported public-only,
and its backend writes admitted under the default public profile, only from a
complete and self-consistent data-plane attestation that covers at least
`NEXUS_EXPECTED_DATA_PLANES` distinct data planes, every one of them public-only
without allow CIDRs. An attestation that is malformed, inconsistent, out of scope
or carries an entry whose `connected_at` is not an RFC 3339 date-time is set
aside and grants nothing.

Upgrade any deployment running `v0.4.0`.

## Schema and upgrades

- **`v0.5.0` freezes `012_access_request_grant`** on every backend.
  `server/src/db/released-migrations.ts` lists it with `release: 'v0.5.0'`
  beside `001_initial` (`v0.1.0`), `002`/`003` (`v0.2.0`), `004` to `006`
  (`v0.3.0`) and `007` to `011` (`v0.4.0`), each with a SHA-256 checksum per
  backend, and CI fails on any edit to them. Later releases change the schema
  only with forward migrations that upgrade a `v0.5.0` database in place; see
  [schema versioning and upgrades](operations.md#schema-versioning-and-upgrades).
- **Every release is an upgrade source.** The released-baseline upgrade test
  builds a database as `v0.1.0`, `v0.2.0`, `v0.3.0`, `v0.4.0` and `v0.5.0` each
  left it, migrates it with the current code and reads every value back.
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
  Edge `v0.9.14`'s data-plane attestation with `NEXUS_EXPECTED_DATA_PLANES`
  set. Nexus reads one control plane, so several control plane replicas, a load
  balancer in front of them or data-plane failover withhold the guarantee; such
  a fleet publishes only with `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`, which also
  skips Nexus's own upstream screening.
- The attestation is self-reported by authenticated data planes, not a
  cryptographic attestation of the data-plane host. A data plane that restarts
  without closing its stream counts twice until Edge drops the stale stream, so
  the count can briefly cover one missing data plane. A disconnected data plane
  that keeps serving cached configuration is not listed.
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

This file is published as the GitHub release notes for tag `v0.5.0`. Earlier
notes are kept at their tags:
[`v0.4.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.4.0/docs/release-notes.md),
[`v0.3.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.3.0/docs/release-notes.md),
[`v0.2.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.2.0/docs/release-notes.md)
and
[`v0.1.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.1.0/docs/release-notes.md).

1. Merge the release change and require every check, `acceptance` included,
   to pass on the merge commit.
2. Create tag `v0.5.0` at that commit and publish a GitHub release for it with
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
