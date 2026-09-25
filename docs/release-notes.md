# Ferrum Nexus v0.1.0 — release notes

**Released 2026-09-25.** The first supported Ferrum Nexus release, paired with
Ferrum Edge `v0.9.7`. The pair is recorded in
[`release/compatibility.env`](../release/compatibility.env), which the README
quickstart, the Compose example, the getting-started walkthrough and the
real-stack `acceptance` CI job all read, so every one of them runs the same
gateway build. The full list of changes is in the
[changelog](../CHANGELOG.md#010---2026-09-25).

## Supported combination

| Component      | Version                        | Pinned as                                                                                               |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Ferrum Nexus   | `v0.1.0`                       | Git tag `v0.1.0`; build `docker/Dockerfile` from that checkout                                          |
| Ferrum Edge    | `v0.9.7`                       | `ferrumedge/ferrum-edge:v0.9.7@sha256:4c9530e09443649526dc4fbbec0720ba7b47ceb91b0dd5cb06db85430908874a` |
| Nexus database | PostgreSQL 17 (Compose sample) | Also supported: SQLite, MySQL, MongoDB replica set — see [schema and upgrades](#schema-and-upgrades)    |

- **Ferrum Edge `v0.9.7`** is the
  [published release](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.7)
  (tag commit `8fed1346ce2e267eb69c03683cb89ea44d785e0b`). The digest above is
  the multi-architecture image index; it resolves to
  `sha256:e4d4367e815e86f510c28d8f831ca3502b7c9d5f21fd0eeabeb609a8c8e6f47f` on
  `linux/amd64` and
  `sha256:7d3d28d2529dfb6a303b734fad0bf35ebec07caa95f5632e81d92170baf15fab` on
  `linux/arm64`. Both were checked against Docker Hub's tag API on 2026-09-25.
  Edge `v0.9.6` was tagged but never published — do not use it — and Edge's
  `latest` tag is not refreshed for releases.
- **Other Edge versions are unverified.** Nexus reads one proxy's plugin
  configs with `GET /plugins/config?proxy_id=…`, which Edge added in `v0.9.7`.
  An older gateway ignores the filter; Nexus still answers correctly by paging
  the whole namespace, but that combination is not tested.
- **No prebuilt Nexus image.** The release is a tagged source build: the
  Dockerfile uses a digest-pinned Node 22 base in both stages and `npm ci`
  against the committed lockfile. The tag, the base digest and the lockfile are
  the reproducible inputs; byte-for-byte image equality across Docker platforms
  is not promised. Record the local image ID you build with each deployment.

## Install

From a clean shell, with Docker Compose v2 and `openssl`:

```bash
git clone https://github.com/ferrum-edge/ferrum-nexus.git
cd ferrum-nexus
git checkout --detach v0.1.0
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

## Schema and upgrades

- **`v0.1.0` freezes the `001_initial` schema baseline** on every backend.
  `server/src/db/released-migrations.ts` lists it with `release: 'v0.1.0'` and a
  SHA-256 checksum per backend, and CI fails on any edit to it. Later releases
  change the schema only with forward migrations that upgrade a `v0.1.0`
  database in place; see
  [schema versioning and upgrades](operations.md#schema-versioning-and-upgrades)
  and the [production upgrade procedure](operations.md#production-upgrade-procedure).
- **No upgrade into `v0.1.0`.** Databases created by pre-release buildout
  checkouts are not supported; recreate them
  ([development reset](operations.md#buildout-schema-policy)).
- **Per backend.** SQLite and PostgreSQL apply each migration and its ledger
  row in one transaction. MongoDB requires a replica set; a standalone server
  (`NEXUS_DB_ALLOW_STANDALONE=true`) carries no upgrade guarantee. MySQL runs
  the baseline replay-safely, but its runner accepts only
  `CREATE TABLE IF NOT EXISTS`, so a later release that needs `ALTER TABLE` on
  MySQL must extend the runner first and will say so in its notes.
- **Downgrades are not supported.** Roll back by restoring the pre-upgrade
  backup, never by running an older image over an upgraded database.

## Operations

- **Persistence and secrets.** Retain the PostgreSQL `pgdata` and Edge
  `ferrumdata` volumes together. Keep `NEXUS_SECRET_KEY`,
  `FERRUM_ADMIN_JWT_SECRET`, `FERRUM_BASIC_AUTH_HMAC_SECRET` and the database
  password stable across restarts and restores, and store them outside the
  source tree.
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
  [supported topologies](operations.md#supported-topologies).

## Known limitations

- Edge serves one data-plane namespace per process: keep `FERRUM_NAMESPACE`
  equal on both sides.
- SMTP must be configured for real email delivery.
- Rate limits are enforced per gateway process unless
  `FERRUM_RATE_LIMIT_SYNC_MODE=redis` is set.
- A `ferrumdata` volume kept from a pre-release stack on an older Edge must go
  through Edge's
  [Upgrading to 0.9.7](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.7/docs/upgrade_guide.md#upgrading-to-097)
  guide before `v0.9.7` starts on it. Its Nexus database has to be recreated in
  any case, so starting both volumes fresh is simpler.

## Release step

This file is published as the GitHub release notes for tag `v0.1.0`.

1. Merge the release change and require every check, `acceptance` included,
   to pass on the merge commit.
2. Create tag `v0.1.0` at that commit and publish a GitHub release for it with
   these notes.
3. From a clean shell, follow [Install](#install) verbatim against the
   published tag, then complete the getting-started walkthrough through an
   authenticated request via the gateway.
