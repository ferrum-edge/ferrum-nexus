# Ferrum Nexus v0.2.0 — release notes

**Released 2026-09-27.** Paired with Ferrum Edge `v0.9.8`. The pair is recorded
in [`release/compatibility.env`](../release/compatibility.env), which the
README quickstart, the Compose example, the getting-started walkthrough and the
real-stack `acceptance` CI job all read, so every one of them runs the same
gateway build. `v0.2.0` is the first release that upgrades a retained database:
it applies two forward migrations to a `v0.1.0` database in place (see
[upgrading from `v0.1.0`](#upgrading-from-v010)). The full list of changes is in
the [changelog](../CHANGELOG.md#020---2026-09-27).

## Supported combination

| Component      | Version                        | Pinned as                                                                                               |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Ferrum Nexus   | `v0.2.0`                       | Git tag `v0.2.0`; build `docker/Dockerfile` from that checkout                                          |
| Ferrum Edge    | `v0.9.8`                       | `ferrumedge/ferrum-edge:v0.9.8@sha256:e5b204f9448d4ec210a57dbd2badece5f4359d5d544522fa48dcdfeef033b385` |
| Nexus database | PostgreSQL 17 (Compose sample) | Also supported: SQLite, MySQL, MongoDB replica set — see [schema and upgrades](#schema-and-upgrades)    |

- **Ferrum Edge `v0.9.8`** is the
  [published release](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.8)
  (tag commit `e27f2109216352c3fe9e67a7014611f3f66daa91`). The digest above is
  the multi-architecture image index; it resolves to
  `sha256:0e629633ad55368002c415bbf76d4c91f3741519a33dd310045531d791d9a592` on
  `linux/amd64` and
  `sha256:1e900bd537814fdc864ee1830bbd7a1e1f2785074a5da088a3d9cdd738b532f9` on
  `linux/arm64`. Both were checked against the Docker Hub registry on
  2026-09-27. Edge's `latest` tag is not refreshed for releases.
- **What changed on the Edge side.** Edge `v0.9.8` changes its data plane
  (HTTP/3, gRPC-Web, the AI stream inspectors), its mesh and its Workload API,
  but none of the Admin API resources Nexus writes. Its database baseline is the
  one `v0.9.7` created, so it opens a `v0.9.7` gateway database as it is. Read
  Edge's
  [Upgrading to 0.9.8](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.8/docs/upgrade_guide.md#upgrading-to-098)
  for the data-plane behaviour changes your clients may notice, such as the new
  `X-Gateway-Error: request_timeout` token.
- **Other Edge versions are unverified.** Nexus `v0.2.0` has not been tested
  against Edge `v0.9.7` or older; upgrade the gateway together with the portal.
- **No prebuilt Nexus image.** The release is a tagged source build: the
  Dockerfile uses a digest-pinned Node 22 base in both stages and `npm ci`
  against the committed lockfile. The tag, the base digest and the lockfile are
  the reproducible inputs; byte-for-byte image equality across Docker platforms
  is not promised. Record the local image ID you build with each deployment.

## Highlights

- **API settings touch only the gateway plugin configs the portal created.**
  Nexus records the Edge config id of each auth, `access_control`,
  `rate_limiting` and `cors` config it creates (migration
  `002_api_gateway_plugins`) and never rewrites or deletes an operator's config
  of the same name. A plugin-config write whose acknowledgement is lost is now
  compensated.
- **Audit rows commit with the change they describe.** Approvals, revocations,
  credential operations, publishes, API edits, deletions, account changes and
  specification updates write their audit row in the same transaction; gateway
  work that cannot be undone first commits an intent row. Every audit action is
  classified in `AUDIT_COMMIT_CLASSES`, and a source scan enforces it.
- **Cross-instance leases are fenced.** A holder that stalled past the lease TTL
  gets `409 CONFLICT` and rolls back instead of committing over the new holder's
  work.
- **Faster conversation lists.** Each thread's newest message is one index seek
  (migration `003_messages_thread_latest`).
- **OpenAPI hardening.** Documents are bounded by their alias-resolved size
  (`MAX_SPEC_EXPANDED_BYTES`), YAML is read with the YAML 1.2 core schema, and
  the viewer follows parameter inheritance and local `$ref`s.
- **The verbatim quickstart gate** runs the README's full-stack block in a clean
  runner for every release tag (see [release step](#release-step)).

## Install

From a clean shell, with Docker Compose v2 and `openssl`:

```bash
git clone https://github.com/ferrum-edge/ferrum-nexus.git
cd ferrum-nexus
git checkout --detach v0.2.0
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

## Upgrading from v0.1.0

`v0.1.0` is the only supported upgrade source. Upgrade Nexus and Edge together,
following the [production upgrade procedure](operations.md#production-upgrade-procedure):

1. **Back up Nexus and Edge together**, as one point in time, following the
   [backup and restore runbook](operations.md#5-backup-and-restore). This backup
   is your rollback.
2. **Stop every Nexus instance.**
3. **Move the gateway to Edge `v0.9.8`** on the same data. It starts on the
   `v0.9.7` database unchanged.
4. **Run the migrations once from the new Nexus image**
   (`node server/dist/db/migrate-cli.js`). It applies
   `002_api_gateway_plugins` and `003_messages_thread_latest`; re-running it is
   safe. Nexus also migrates at startup, so a single-instance deployment may
   skip this step.
5. **Start `v0.2.0`** on every instance and verify it as the procedure says:
   `schema_migrations` lists `001_initial`, `002_api_gateway_plugins` and
   `003_messages_thread_latest`.

On the Compose stack, from the checkout you installed from, with the four
secrets you saved at install time exported again (never newly generated values)
and `docker-compose.yml` unchanged:

```bash
docker compose stop nexus
git fetch --tags origin
git checkout --detach v0.2.0
set -a
. ./release/compatibility.env
set +a
docker compose up -d --build
```

`--build` rebuilds the Nexus image from the new checkout; the new
`FERRUM_EDGE_IMAGE` replaces the gateway container on the retained `ferrumdata`
volume, and Nexus migrates the retained `pgdata` database when it starts.

What the migrations do:

- **`002_api_gateway_plugins`** adds the `api_gateway_plugins` table on every
  backend (an index on MongoDB) and copies no data. An API published under
  `v0.1.0` has its configs recognised role by role, by the values the portal
  wrote, on its first gateway-touching change. A `PATCH` to a setting whose
  proxy carries two matching configs for a role, or an auth, `access_control` or
  `cors` config that no longer matches the API's settings, answers
  `409 CONFLICT` naming the plugin until the operator removes or fixes that
  config; other settings keep working. See
  [released forward migrations](operations.md#schema-versioning-and-upgrades).
- **`003_messages_thread_latest`** replaces the messages index
  `ix_messages_thread` with `ix_messages_thread_latest`, which adds the message
  id. It changes no data. **On PostgreSQL and SQLite, building the index blocks
  writes to `messages` until it finishes**, which on a large table can take a
  while; a rolling deploy that migrates while an old instance still serves
  stalls message sends until it completes. On MongoDB the step builds the new
  index and then drops the old one. On MySQL it is a no-op: InnoDB already
  appends the primary key to the existing index.
- **MySQL needs no runner change.** `002` is a single
  `CREATE TABLE IF NOT EXISTS` and `003` has no statements, so both are
  replay-safe under the existing runner.

Behaviour changes to plan for, all listed in the
[changelog](../CHANGELOG.md#020---2026-09-27):

- The daily access-request budget
  (`NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY`) counts `access.request` audit
  rows, so a deleted application's requests stay charged for 24 hours.
- New audit actions record intent before irreversible gateway work (for example
  `application.delete_start`, `api.delete_start`, `credential.revoke_start`,
  `api.plugin_remove_start`, `api.spec_revision_start`) and outcomes after it
  (`god.disable_user_complete`, `api.plugin_rollback`,
  `credential.revoke_rollback`). Update any tooling that reads the audit log.
- OpenAPI uploads larger than `MAX_SPEC_EXPANDED_BYTES` (4 MiB) once aliases are
  resolved answer `400 SPEC_INVALID` with `details.reason = "expanded_too_large"`,
  and YAML is read with the YAML 1.2 core schema: `yes`, `no`, `on` and `off`
  stay strings. Stored revisions are re-read with the same rules.

**Rollback** is a restore of the backup taken in step 1, Nexus and Edge
together. Never run `v0.1.0` over a database `v0.2.0` migrated.

## Schema and upgrades

- **`v0.2.0` freezes `002_api_gateway_plugins` and
  `003_messages_thread_latest`** on every backend.
  `server/src/db/released-migrations.ts` lists them with `release: 'v0.2.0'`
  beside `001_initial` (`release: 'v0.1.0'`), each with a SHA-256 checksum per
  backend, and CI fails on any edit to them. Later releases change the schema
  only with forward migrations that upgrade a `v0.2.0` database in place; see
  [schema versioning and upgrades](operations.md#schema-versioning-and-upgrades).
- **No upgrade from pre-release checkouts.** Databases created by buildout
  checkouts before `v0.1.0` are not supported; recreate them
  ([development reset](operations.md#buildout-schema-policy)).
- **Per backend.** SQLite and PostgreSQL apply each migration and its ledger
  row in one transaction. MongoDB requires a replica set; a standalone server
  (`NEXUS_DB_ALLOW_STANDALONE=true`) carries no upgrade guarantee. MySQL
  accepts only `CREATE TABLE IF NOT EXISTS` statements, so a later release that
  needs `ALTER TABLE` on MySQL must extend the runner first and will say so in
  its notes.
- **Downgrades are not supported.** Roll back by restoring the pre-upgrade
  backup, never by running an older image over an upgraded database.

## Operations

- **Persistence and secrets.** Retain the PostgreSQL `pgdata` and Edge
  `ferrumdata` volumes together. Keep `NEXUS_SECRET_KEY`,
  `FERRUM_ADMIN_JWT_SECRET`, `FERRUM_BASIC_AUTH_HMAC_SECRET` and the database
  password stable across restarts, upgrades and restores, and store them
  outside the source tree.
- **Backup and restore.** Back up Nexus and Edge together, as one point in
  time, following the [backup and restore runbook](operations.md#5-backup-and-restore).
  The `acceptance` job backs up, destroys and restores both databases and then
  proves an approved client's pre-backup credential still works and a revoked
  client is still refused. The Nexus database alone cannot rebuild Edge
  consumers, credentials, proxies or plugins: without an Edge backup, show-once
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
  [supported topologies](operations.md#supported-topologies). Leases are now
  fenced at commit, but Edge still cannot reject a stale holder's gateway
  write, so the single gateway-writing instance guidance is unchanged.

## Known limitations

- Edge serves one data-plane namespace per process: keep `FERRUM_NAMESPACE`
  equal on both sides.
- SMTP must be configured for real email delivery.
- Rate limits are enforced per gateway process unless
  `FERRUM_RATE_LIMIT_SYNC_MODE=redis` is set.
- Compensation for a gateway write is held in memory: a process that dies
  between Edge applying a change and its undo running leaves no record, and
  recovery is operational (`docs/security.md`).
- A `ferrumdata` volume kept from a pre-release stack on an Edge older than
  `v0.9.7` must go through Edge's
  [Upgrading to 0.9.7](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.8/docs/upgrade_guide.md#upgrading-to-097)
  guide before `v0.9.8` starts on it. Its Nexus database has to be recreated in
  any case, so starting both volumes fresh is simpler.

## Release step

This file is published as the GitHub release notes for tag `v0.2.0`. The
`v0.1.0` notes are kept at that tag:
[`docs/release-notes.md` at `v0.1.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.1.0/docs/release-notes.md).

1. Merge the release change and require every check, `acceptance` included,
   to pass on the merge commit.
2. Create tag `v0.2.0` at that commit and publish a GitHub release for it with
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
