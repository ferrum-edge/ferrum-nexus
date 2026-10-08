# Ferrum Nexus v0.5.1 — release notes

**Released 2026-10-08.** Paired with Ferrum Edge `v0.9.14`, unchanged from
`v0.5.0`. The pair is recorded in
[`release/compatibility.env`](../release/compatibility.env), which the README
quickstart, the Compose example, the getting-started walkthrough and the real-stack
`acceptance` CI job all read, so every one of them runs the same gateway build.
`v0.5.1` is a security and bug-fix release: a trusted password reset revokes the
credentials an account already held, email verification alone no longer authorizes
single sign-on linking, publishing refuses an upstream that loops back into the
gateway, gateway access cleanup trusts only Edge's own "not found", and the
data-plane attestation counts a restarted data plane once. It upgrades a `v0.5.0`
database in place with one forward migration; the gateway and its database are
unchanged. **Read the [upgrade](#upgrading-from-v050) before starting:** it requires
every older Nexus writer to be stopped and drained, and several changes alter what
operators and clients see. The full list of changes is in the
[changelog](../CHANGELOG.md#051---2026-10-08).

## Supported combination

| Component      | Version                                | Pinned as                                                                                                |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Ferrum Nexus   | `v0.5.1`                               | Git tag `v0.5.1`; build `docker/Dockerfile` from that checkout                                           |
| Ferrum Edge    | `v0.9.14`                              | `ferrumedge/ferrum-edge:v0.9.14@sha256:15442f1b1d1758023fe871fe57be50f19caf34bbe6c499a6812f4ffd0da5e3f8` |
| Node.js        | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | Source installs; the image uses a digest-pinned Node 22 base (22.23.3)                                   |
| Nexus database | PostgreSQL 17 (Compose sample)         | Also supported: SQLite, MySQL, MongoDB replica set — see [schema and upgrades](#schema-and-upgrades)     |

- **Ferrum Edge `v0.9.14`** is the
  [published release](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.14)
  (tag commit `9bd4d5f9caa4ebe8f0ea13e76d8a6e2172eaca7d`), the same build `v0.5.0`
  paired with. The digest above is the multi-architecture image index; it resolves
  to `sha256:12a8cd56090c0d4511bb3015b240e606b1b87989c644157566b8f6b6f635b3c2` on
  `linux/amd64` and
  `sha256:19d2886ed8c192cb0daba48ef0a27a0cd0526449dac74bf9438502322aabd9f2` on
  `linux/arm64`. Both were checked against the Docker Hub registry on
  2026-10-08. Nexus vendors the matching contracts, `contracts-edge-0.9.14`
  (`ddbdd845733b7046c4393ac951011dafb774db33`).
- **No Edge upgrade.** `v0.5.1` makes no change on the Edge side: keep running
  Edge `v0.9.14` on its existing database. The
  [`v0.5.0` notes](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.5.0/docs/release-notes.md#supported-combination)
  describe what Edge `v0.9.14` changed.
- **Other Edge versions are unverified.** Nexus `v0.5.1` is tested only against
  Edge `v0.9.14`. It still reads Edge `v0.9.13`'s answers, as `v0.5.0` does, but
  run the pinned pair. Edge `v0.9.12` or earlier is refused.
- **No prebuilt Nexus image.** The release is a tagged source build: the
  Dockerfile uses a digest-pinned Node 22 base in both stages and `npm ci`
  against the committed lockfile. The tag, the base digest and the lockfile are
  the reproducible inputs; byte-for-byte image equality across Docker platforms
  is not promised. Record the local image ID you build with each deployment.

## Highlights

- **A trusted password reset revokes the credentials an account already held.**
  The first reset that gives an account a trusted proof of its address revokes
  every credential of the account and its applications, durably and with retry,
  and cancels the account's pending access requests. See
  [behaviour changes](#behaviour-changes-to-plan-for).
- **Single sign-on links an existing account only on a trusted proof.** Redeeming
  an email-verification link no longer authorizes linking.
- **Publishing refuses an upstream that loops back into the gateway**, even with
  `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`.
- **The data-plane attestation counts a restarted data plane once.** A data plane
  counts toward `NEXUS_EXPECTED_DATA_PLANES` only once it has settled.
- **Gateway access cleanup trusts only Edge's own "not found"**, and a failed grant
  revocation keeps the grantee's pending tool request.
- **Credential and notification writes are rate-limited per account.**

## Install

From a clean shell, with Docker Compose v2 and `openssl`:

```bash
git clone https://github.com/ferrum-edge/ferrum-nexus.git
cd ferrum-nexus
git checkout --detach v0.5.1
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

## Upgrading from v0.5.0

`v0.5.0` is the supported upgrade source. A `v0.4.0` or older database also
upgrades in one run (CI covers every release), but read the
[`v0.5.0` notes](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.5.0/docs/release-notes.md#upgrading-from-v040)
first: an upgrade from `v0.4.0` also upgrades Edge to `v0.9.14`, in the same window,
and has its own prerequisites. From `v0.5.0`, only Nexus changes. Follow the
[production upgrade procedure](operations.md#production-upgrade-procedure):

1. **Check the prerequisites.**
   - **Node.** Unchanged since `v0.4.0`: a source install needs Node
     `^22.22.2 || ^24.15.0 || >=26.0.0`. The container image carries Node
     22.23.3.
   - **Edge.** Unchanged: Edge `v0.9.14`, as pinned for `v0.5.0`.
   - **Upstreams on the gateway's host.** Find any API whose upstream names or
     resolves to the gateway's public URL, `FERRUM_GATEWAY_PUBLIC_URL` or the
     Admin API host, or, when any of those is a loopback address, to any loopback
     address. Its next publish, revision, upstream change or gateway restore is
     refused; see [behaviour changes](#behaviour-changes-to-plan-for).
   - **Proxies in front of Edge.** A proxy between Nexus and the Admin API must
     pass Edge's `404` bodies and the `Date` header through unchanged.
2. **Stop and drain every Nexus instance**, request handlers and background
   workers alike. Older and newer writers must never run together:
   `013_account_recovery_jobs` adds the table that records the revocation a trusted
   password reset owes. A `v0.5.0` instance neither writes that row when it
   completes a reset nor checks it before issuing a credential, so it would skip
   the revocation or issue a credential while one is owed, and it runs no worker to
   drain the table.
3. **Back up Nexus and Edge together**, as one point in time, following the
   [backup and restore runbook](operations.md#5-backup-and-restore). This backup
   is your rollback.
4. **Run the migration once from the new Nexus image**
   (`node server/dist/db/migrate-cli.js`). It applies
   `013_account_recovery_jobs`; re-running it is safe. Nexus also migrates at
   startup, so a single-instance deployment may skip this step.
5. **Start `v0.5.1`** on every instance. Verify it as the procedure says:
   `schema_migrations` lists `001_initial` through `013_account_recovery_jobs`;
   `GET /api/health/edge`, read as an administrator, reports `status: "ok"` and
   `public_egress_guaranteed: true` for a local public-only data plane or a fully
   attested control plane; and a known client still calls an API through the
   gateway with its existing credential. On a control-plane/data-plane pairing,
   health can read `degraded` (an administrator reads
   `backend_egress_unverified`) for up to a minute after Nexus starts, and a
   backend write refused meanwhile carries `details.data_plane_attestation`
   `data_plane_recently_connected`; see
   [behaviour changes](#behaviour-changes-to-plan-for).

On the Compose stack, from the checkout you installed from, with the four
secrets you saved at install time exported again (never newly generated
values):

```bash
docker compose stop nexus
git fetch --tags origin
git checkout --detach v0.5.1
set -a
. ./release/compatibility.env
set +a
docker compose up -d --build
```

Take the paired backup (step 3) after `docker compose stop nexus` and before
`docker compose up -d --build`. The Edge image is unchanged, so Compose keeps the
running gateway and its `ferrumdata` volume as they are, and Nexus migrates the
retained `pgdata` database when it starts.

What the migration does, on every backend:

- **`013_account_recovery_jobs`** adds the `account_recovery_jobs` table (a
  collection with the same two indexes on MongoDB): at most one row per account,
  holding the credential revocation a trusted password reset owes until a worker
  lands it, with a foreign key to `users` on SQL backends that cascades on delete.
  It only adds an empty table and copies no data, so no retained account owes a
  revocation after the upgrade. On MySQL it is a replayable
  `CREATE TABLE IF NOT EXISTS`.

### Behaviour changes to plan for

All are listed in the [changelog](../CHANGELOG.md#051---2026-10-08).

- **The first trusted password reset revokes existing credentials.** A completed
  `POST /api/auth/reset-password` on an account with no recorded proof of its
  current address, or only an email-verification proof, records a trusted proof
  and, in the same transaction, cancels the account's pending access requests and
  queues the revocation of every credential held by the account and its
  applications, a provider's API test-consumer credentials included. After the
  upgrade this applies to most retained accounts: every account that has not yet
  completed a reset or been provisioned or linked by an identity provider for its
  current address. Its `auth.password_reset` audit row records
  `credentials_revocation_pending: true` and `cancelled_access_requests`. Tell
  users that a password reset can end their API keys, and that they re-issue them
  and re-request access afterwards.
- **Password resets completed before the upgrade are not revisited.** `v0.5.1`
  does not retroactively revoke credentials or cancel requests for accounts whose
  password was reset on `v0.5.0` or earlier; the migration copies no data. Review
  the accounts whose `auth.password_reset` audit rows predate the upgrade, and
  revoke or deny anything among their credentials, applications and pending
  requests that the account holder does not recognise.
- **Issuance answers `409 CONFLICT` while a recovery is pending.** Issuing or
  rotating a credential for the account or its applications, and issuing a
  provider's test-consumer credential, is refused with `409 CONFLICT` until the
  revocation lands. A worker retries an unreachable gateway with a backoff capped
  at 5 minutes. After 8 failed attempts the account may issue again, and
  `credential.recovery_stalled` is audited for an administrator; when the
  revocation finally lands it spares credentials issued after that point. A
  revocation it cannot place without emptying a credential type that holds another
  account's keys stalls for an administrator to reconcile. Watch for
  `credential.recovery_stalled` and for `credential.revoke` rows with
  `reason: "account_recovery"`.
- **Email verification alone no longer authorizes single sign-on linking.** With
  `link_existing_accounts` on, an existing account is linked only on a proof that
  a completed password reset or an identity provider recorded. An account verified
  only by link, including every account verified that way under `v0.5.0`, is
  refused (`account_exists`) until its holder completes a password reset, which
  also triggers the revocation above. Manual role changes now check linked identity
  trust at every privilege increase, including `admin` to `super_admin`.
- **Publishing refuses an upstream on the gateway's own origins.** Publish, a
  `PATCH` of `upstream_url`, a revision that moves a proxy following its document,
  and a gateway restore answer `400 SPEC_INVALID` with `details.reason`
  `gateway_origin` when the upstream names or resolves to any of the gateway's
  origins: the stored `gateway.public_url`, `FERRUM_GATEWAY_PUBLIC_URL` and the
  Admin API host from `FERRUM_ADMIN_URL`, all of them together. The comparison is
  by host, not port. Addresses are canonicalized first, so an IPv4-mapped, NAT64
  or 6to4 form of the gateway's address matches, and every loopback or unspecified
  address (`127.0.0.0/8`, `0.0.0.0`, `::1`, `::`) counts as one host. The gateway
  origins resolve through the system resolver, which honours `/etc/hosts`, so
  `localhost` and other names defined there work; each lookup is bounded at
  5 seconds and an answer is cached for 30. A gateway origin that cannot be
  resolved fails the write closed with `gateway_unresolvable`. The check runs even
  with `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`, so a development or single-host
  deployment whose gateway is on loopback can no longer publish a loopback
  upstream. Proxies already deployed are not touched until their next such write.
- **`NEXUS_EXPECTED_DATA_PLANES` counts only settled data planes.** A data plane
  counts once it has existed for 60 seconds, by which time Edge `v0.9.14` has
  dropped the stale stream of a process it replaced: either this Nexus process saw
  its `node_id` listed that long ago, or the answer carries the gateway's `Date`
  header and the `node_id`'s earliest `connected_at` is 90 seconds old on both
  Nexus's clock and that header. Until enough data planes count, health is
  `degraded` (an administrator reads `backend_egress_unverified`) and backend
  writes are refused with `details.data_plane_attestation`
  `data_plane_recently_connected`, or `data_plane_clock_skew` when a
  `connected_at` contradicts the clocks. Expect that for about a minute and a half
  after a data plane restarts, unless enough others already count, and after Nexus
  itself starts while data planes are that new. The `Date` header must reach Nexus
  as the control plane wrote it: a reverse proxy that replaces it with its own
  clock defeats the check, and without the header Nexus counts only data planes it
  has itself seen for 60 seconds, so writes are refused for the first minute after
  every Nexus start. Keep Nexus and the control plane on synchronized time. The
  value itself is unchanged: the namespace's whole data-plane inventory. See
  [CP/DP pairings and data-plane attestation](operations.md#cpdp-pairings-and-data-plane-attestation).
- **A consumer counts as gone only on Edge's own `404`.** Gateway access cleanup,
  and the rollback of a failed revocation, read a `404` as absence only when its
  body is Edge's `Consumer not found` answer. Any other `404`, such as an unknown
  route or a proxy's error page, now fails with `502 EDGE_PROTOCOL_ERROR`
  (`details.reason` `unconfirmed_absence`) so the cleanup is reported and retried
  instead of counted as removed access. Point `FERRUM_ADMIN_URL` at the Admin API
  itself, or through a proxy that passes its `404` bodies through.
- **A restored grant restores its pending tool request.** When a revocation the
  gateway refused is rolled back, a pending tool request it cancelled returns to
  `pending`; `access.revoke_rollback` names it in `tool_request_restored`, or
  records `tool_request_skipped: "account_recovery"` while a recovery of the
  grantee is outstanding.
- **New rate limits.** Issue, rotate and revoke under `/api/credentials` allow 20
  requests a minute per route and account, and `POST /api/notifications/read` 60 a
  minute per account; past them, `429`. Like every Nexus rate limit, they apply
  only with `NEXUS_RATE_LIMIT_ENABLED` (the default) and count per process. A
  notification read that changes nothing no longer writes an audit row.
- **New audit action and details**: `credential.recovery_stalled`;
  `credential.revoke` with `reason: "account_recovery"` and, where a delete could
  not be placed, `placement: "whole-type-fallback"`; the `auth.password_reset`
  fields above; and the `access.revoke_rollback` fields above. Update any tooling
  that reads the audit log.

### Rollback

Rolling back to `v0.5.0` re-opens the weaknesses this release closes (see
[security](#security)), so prefer fixing forward. Settle recovery journals before
rolling back.

Rollback is a restore of the backup taken in step 3, Nexus and Edge together:
restore the Edge database and keep running Edge `v0.9.14` on it, and restore the
Nexus database and run `v0.5.0` on it. Never run `v0.5.0` over a database `v0.5.1`
migrated: it would ignore owed revocations and issue credentials while one is owed.
Every post-upgrade change is lost with the restore. For an account that completed
a password reset after the upgrade, that brings back its password from before the
reset, the sessions the reset ended, the credentials it revoked and the access
requests it cancelled, and `v0.5.0` does not hold back new issuance for it.

Before restoring, list the accounts with an `auth.password_reset` audit row since
the upgrade, and note which of those rows recorded
`credentials_revocation_pending: true`; the restore removes those rows. After the
rollback, have an
administrator disable each of those accounts, which ends its sessions and removes
its gateway identity (disabling an administrator needs a `super_admin`), and keep
them disabled until `v0.5.1` is running again. Re-enable an account only after its
disable teardown has completed, and only when its holder is ready to complete a
password reset under `v0.5.1` straight away. Where the noted post-upgrade reset
recorded `credentials_revocation_pending: true`, the new reset revokes the account's earlier
credentials and cancels its pending requests again; for the other accounts, have
an administrator revoke the credentials and deny the requests their holders do not
recognise. Treat the restored keys as possibly exposed.

A password reset completed on `v0.5.0` during the rollback is not revisited after
the re-upgrade; review those accounts as for
[resets completed before the upgrade](#behaviour-changes-to-plan-for).

## Security

`v0.5.1` closes privately reported weaknesses in account recovery, single sign-on
linking, privilege changes, upstream admission and per-account write limits:

- a trusted password reset revokes the credentials and cancels the access requests
  that a previous holder of the account left behind, durably, and blocks new
  issuance until it lands
  ([GHSA-rp99-hqw5-q7f9](https://github.com/ferrum-edge/ferrum-nexus/security/advisories/GHSA-rp99-hqw5-q7f9));
- an email-verification link no longer authorizes single sign-on linking, and every
  manual privilege increase checks the trust of linked identities
  ([GHSA-v58f-cr96-fv8j](https://github.com/ferrum-edge/ferrum-nexus/security/advisories/GHSA-v58f-cr96-fv8j))
  ([GHSA-924j-fm9c-wp9p](https://github.com/ferrum-edge/ferrum-nexus/security/advisories/GHSA-924j-fm9c-wp9p));
- publishing refuses an upstream that would route a proxy back into the gateway,
  whatever `NEXUS_ALLOW_PRIVATE_UPSTREAMS` says
  ([GHSA-37vj-qg3p-4fcc](https://github.com/ferrum-edge/ferrum-nexus/security/advisories/GHSA-37vj-qg3p-4fcc));
- credential mutations and notification reads are rate-limited per account
  ([GHSA-8jcf-wr8c-m28v](https://github.com/ferrum-edge/ferrum-nexus/security/advisories/GHSA-8jcf-wr8c-m28v)).

Gateway-origin detection runs when Nexus writes a proxy: re-pointing DNS after a
publish, or moving the gateway, is invisible to it, and is left to Edge's own
request-time egress screening (`FERRUM_BACKEND_ALLOW_IPS`).

Upgrade any deployment running `v0.5.0` or earlier.

## Schema and upgrades

- **`v0.5.1` freezes `013_account_recovery_jobs`** on every backend.
  `server/src/db/released-migrations.ts` lists it with `release: 'v0.5.1'`
  beside `001_initial` (`v0.1.0`), `002`/`003` (`v0.2.0`), `004` to `006`
  (`v0.3.0`), `007` to `011` (`v0.4.0`) and `012` (`v0.5.0`), each with a SHA-256
  checksum per backend, and CI fails on any edit to them. Later releases change the
  schema only with forward migrations that upgrade a `v0.5.1` database in place;
  see [schema versioning and upgrades](operations.md#schema-versioning-and-upgrades).
- **Every release is an upgrade source.** The released-baseline upgrade test
  builds a database as `v0.1.0`, `v0.2.0`, `v0.3.0`, `v0.4.0`, `v0.5.0` and
  `v0.5.1` each left it, migrates it with the current code and reads every value
  back.
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
  skips Nexus's own upstream screening, except the gateway-origin check.
- The attestation is self-reported by authenticated data planes, not a
  cryptographic attestation of the data-plane host. The 60-second settle assumes
  the control plane terminates each data plane's HTTP/2 connection itself,
  directly or through an L4 pass-through: behind a proxy that terminates HTTP/2,
  a dead data plane's stream can stay listed for minutes and a restarted data
  plane can count twice. Edge reports no stream liveness, so a data plane whose
  restarted process subscribes to another control plane can still be covered by
  its stale stream for that window. A disconnected data plane that keeps serving
  cached configuration is not listed.
- Gateway-origin detection runs at write time only; see [security](#security).
- A password reset revokes credentials only on the account's first trusted proof
  of its current address, and a reset completed before the upgrade is not
  revisited; see [behaviour changes](#behaviour-changes-to-plan-for). A revocation
  that cannot be placed without emptying a credential type shared with another
  account stalls for an administrator.
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

This file is published as the GitHub release notes for tag `v0.5.1`. Earlier
notes are kept at their tags:
[`v0.5.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.5.0/docs/release-notes.md),
[`v0.4.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.4.0/docs/release-notes.md),
[`v0.3.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.3.0/docs/release-notes.md),
[`v0.2.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.2.0/docs/release-notes.md)
and
[`v0.1.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.1.0/docs/release-notes.md).

1. Merge the release change and require every check, `acceptance` included,
   to pass on the merge commit.
2. Create tag `v0.5.1` at that commit and publish a GitHub release for it with
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
