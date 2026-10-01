# Ferrum Nexus v0.3.0 — release notes

**Released 2026-10-01.** Paired with Ferrum Edge `v0.9.9`. The pair is recorded
in [`release/compatibility.env`](../release/compatibility.env), which the
README quickstart, the Compose example, the getting-started walkthrough and the
real-stack `acceptance` CI job all read, so every one of them runs the same
gateway build. `v0.3.0` adds OpenID Connect single sign-on, a consumer-facing
history of specification changes and spec-change notifications, and fixes six
security advisories that affect `v0.2.0`. It upgrades a `v0.2.0` database in
place with three forward migrations, but **the gateway's database has to be
exported and re-imported**: Edge `v0.9.9` does not open a SQL database an
earlier Edge created (see [upgrading from `v0.2.0`](#upgrading-from-v020)). The
full list of changes is in the [changelog](../CHANGELOG.md#030---2026-10-01).

## Supported combination

| Component      | Version                        | Pinned as                                                                                               |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Ferrum Nexus   | `v0.3.0`                       | Git tag `v0.3.0`; build `docker/Dockerfile` from that checkout                                          |
| Ferrum Edge    | `v0.9.9`                       | `ferrumedge/ferrum-edge:v0.9.9@sha256:83bb4de2ea264d5bed18d8f01f94e0e17a29b43aa1458b8984a0e9e1e784ede6` |
| Nexus database | PostgreSQL 17 (Compose sample) | Also supported: SQLite, MySQL, MongoDB replica set — see [schema and upgrades](#schema-and-upgrades)    |

- **Ferrum Edge `v0.9.9`** is the
  [published release](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.9)
  (tag commit `234717ce41965cd1e2b5c6c761a25475c5d7628c`). The digest above is
  the multi-architecture image index; it resolves to
  `sha256:558fba9a1a9d7826e5ff9d84a1c80f24903c202a3a755072f45af0372ce1b477` on
  `linux/amd64` and
  `sha256:33a8acceab1bee27e999b235cb24311619e44209b865cd68971cd9f3928a8379` on
  `linux/arm64`. Both were checked against the Docker Hub registry on
  2026-10-01. Edge's `latest` tag is not refreshed for releases.
- **What changed on the Edge side.** None of the Admin API resources Nexus
  writes change shape. Nexus signs `admin` tokens, which read secrets
  unmasked, so Edge's new refusal to write a masked placeholder back into a
  plugin config or upstream never applies to it; the viewer-key namespace
  ceiling and the MCP tool catalog are features Nexus does not use; and the
  listen paths Nexus publishes (`/<namespace>/<slug>`) contain no `;`, so
  `allow_path_parameters` is not needed. Edge now refuses some plugin settings
  it used to accept, which Nexus checks first (see
  [behaviour changes](#behaviour-changes-to-plan-for)), and its canonical
  request path refuses `;` path parameters and empty segments (`//`) on every
  proxy that does not opt in, so a client calling a published API with such a
  path now gets `400`. Read Edge's
  [Upgrading to 0.9.9](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.9/docs/upgrade_guide.md#upgrading-to-099)
  and its [changelog](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.9/CHANGELOG.md)
  for the data-plane changes your clients may notice, such as the whole
  `x-consumer-*` request-header namespace becoming gateway-owned.
- **Other Edge versions are unverified.** Nexus `v0.3.0` has not been tested
  against Edge `v0.9.8` or older; upgrade the gateway together with the portal.
- **No prebuilt Nexus image.** The release is a tagged source build: the
  Dockerfile uses a digest-pinned Node 22 base in both stages and `npm ci`
  against the committed lockfile. The tag, the base digest and the lockfile are
  the reproducible inputs; byte-for-byte image equality across Docker platforms
  is not promised. Record the local image ID you build with each deployment.

## Highlights

- **OpenID Connect single sign-on.** Users sign in with Keycloak, Dex, Entra
  ID, Okta, Auth0 or any standards-compliant provider (authorization code with
  PKCE). Providers come from `NEXUS_OIDC_PROVIDERS` or **Admin → Settings →
  Single sign-on**; groups and claims map to roles and organizations; each
  deployment chooses `local_and_sso`, `local_only` or `sso_only`. Existing
  accounts are linked only on a recorded proof of their address (see
  [single sign-on and existing accounts](#single-sign-on-and-existing-accounts)).
  The `acceptance` job signs in through a real, digest-pinned Dex. Setup is in
  [`operations.md` §14](operations.md#14-single-sign-on-openid-connect).
- **Consumers see what changed in an API's specification.** Each revision that
  replaces another records a summary of its changes, each marked breaking or
  not; the catalog has a **Changes** tab and
  `GET /api/catalog/:slug/changes` serves the same history.
- **Grantees are told when a specification changes**, in-app by default and by
  email if they opt in on the new **Notifications** card of their profile.
- **Specification reviews say when they are incomplete.** The comparison shown
  before a replace or rollback works within a fixed budget and reports
  `complete: false` when it runs out, instead of blocking the server.
- **Six security fixes**, listed under [security](#security).
- **Text meets WCAG AA contrast** throughout the portal, in both themes and
  with any branding colour.

## Install

From a clean shell, with Docker Compose v2 and `openssl`:

```bash
git clone https://github.com/ferrum-edge/ferrum-nexus.git
cd ferrum-nexus
git checkout --detach v0.3.0
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

## Upgrading from v0.2.0

`v0.2.0` is the supported upgrade source. A `v0.1.0` database also upgrades in
one run (CI covers both); read the
[`v0.2.0` notes](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.2.0/docs/release-notes.md#upgrading-from-v010)
first for what `002_api_gateway_plugins` and `003_messages_thread_latest` do.
Upgrade Nexus and Edge together, following the
[production upgrade procedure](operations.md#production-upgrade-procedure):

1. **Back up Nexus and Edge together**, as one point in time, following the
   [backup and restore runbook](operations.md#5-backup-and-restore). Take the
   Edge half with Edge's Admin API `GET /backup`, not as a copy of its database
   file: step 3 needs that export. This backup is your rollback.
2. **Stop every Nexus instance.**
3. **Move the gateway to Edge `v0.9.9` on a new database.** Edge `v0.9.9`
   changed its SQL `V001` baseline, so it refuses to start on a SQLite,
   PostgreSQL or MySQL gateway database created by `v0.9.8` or earlier (a `V001`
   checksum mismatch); Edge's changelog says to recreate the database and
   re-import the configuration. A MongoDB gateway database is unaffected and
   skips this step.
   1. Export the Nexus namespace from the running `v0.9.8` gateway with
      `GET /backup`: an `admin` token signed with `FERRUM_ADMIN_JWT_SECRET`
      and `X-Ferrum-Namespace` set to Nexus's `FERRUM_NAMESPACE`. The export
      from step 1 serves if nothing has written to the gateway since. See
      Edge's
      [backup and restore reference](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.9/docs/admin_backup_restore.md).
   2. Stop the gateway and set its database aside unchanged: it is the gateway
      half of your rollback.
   3. Start `v0.9.9` on an empty database with the same Edge secrets
      (`FERRUM_ADMIN_JWT_SECRET`, `FERRUM_BASIC_AUTH_HMAC_SECRET`) and import
      the export into the same namespace with `POST /restore?confirm=true`.
      Restore keeps every resource id, so the consumer, proxy and plugin-config
      ids Nexus recorded still resolve, and issued credentials keep working.
      It validates the whole export against `v0.9.9`'s rules first: a refusal
      (`400`) names what it refused and writes nothing. Fix that resource in
      the export and import again.
4. **Run the migrations once from the new Nexus image**
   (`node server/dist/db/migrate-cli.js`). It applies `004_api_spec_changes`,
   `005_notification_preferences` and `006_user_identities`; re-running it is
   safe. Nexus also migrates at startup, so a single-instance deployment may
   skip this step.
5. **Start `v0.3.0`** on every instance and verify it as the procedure says:
   `schema_migrations` lists `001_initial` through `006_user_identities`, and a
   known client still calls an API through the gateway with its existing
   credential.

On the Compose stack, from the checkout you installed from, with the four
secrets you saved at install time exported again (never newly generated values)
and `docker-compose.yml` unchanged. The gateway's database is
`/data/ferrum.db` in the `ferrumdata` volume, and its Admin API listens only on
the Compose network, at `http://ferrum-edge:9000`:

```bash
docker compose stop nexus
# Export the `nexus` namespace with GET /backup now (step 3.1).
docker compose stop ferrum-edge
docker compose run --rm --no-deps ferrum-edge-init \
  sh -c 'mkdir /data/edge-v0.9.8 && mv /data/ferrum.db* /data/edge-v0.9.8/'
git fetch --tags origin
git checkout --detach v0.3.0
set -a
. ./release/compatibility.env
set +a
docker compose up -d ferrum-edge
# Import the export with POST /restore?confirm=true now (step 3.3), then:
docker compose up -d --build
```

The `mv` keeps the old database in the same volume, under `edge-v0.9.8/`.
Start Nexus only after the import, so it never works against an empty gateway.
`--build` rebuilds the Nexus image from the new checkout, and Nexus migrates
the retained `pgdata` database when it starts.

What the migrations do (all three only add tables, on every backend, and copy
no data):

- **`004_api_spec_changes`** adds `api_spec_changes`, one change summary per
  published revision. Revisions published before the upgrade have none, so
  each API's **Changes** tab starts with its first revision after it.
- **`005_notification_preferences`** adds `user_notification_preferences`.
  Every existing account gets the defaults: the spec-change notice in-app, no
  email.
- **`006_user_identities`** adds `user_identities`, `user_email_proofs` and
  `user_password_locks`. No upgraded account is linked to a provider, holds a
  recorded address proof or is barred from its password.
- **MySQL needs no runner change.** Each is `CREATE TABLE IF NOT EXISTS` only,
  so all three are replay-safe under the existing runner.

### Single sign-on and existing accounts

Nothing changes until an administrator configures a provider; the default
login policy, `local_and_sso`, keeps password sign-in. Once one is configured:

- **An existing account is linked only on a recorded proof of its address**: a
  redeemed verification link, a completed password reset, or an earlier
  provider-verified provisioning or link. The registration policy never counts,
  whatever `email_verified` says, and upgraded accounts start with no proof.
  An automatic link without one is refused with `account_exists`; `admin` and
  `super_admin` accounts are never linked automatically.
- **Explicit links need the same proof.** A user links their own account from
  **Profile → Linked sign-in**; without a recorded proof the link is refused
  with `address_unproven`, even when the provider asserts the address verified,
  and accepting a link records no proof of its own. Otherwise whoever
  registered an address first could link their own identity and keep it after
  the rightful holder resets the password.
- **The founding `super_admin` is exempt.** The account seated with the
  bootstrap token links without a proof, because the token already proves the
  operator owns it. Earlier releases recorded that seat too, so an upgraded
  portal's founder keeps the exemption.
- **Without SMTP only the founder can link.** With `require_email_verification`
  off and no SMTP configured, nothing can record a proof, since verification
  and reset mail stays queued. To offer single sign-on to existing accounts,
  configure SMTP and have their holders verify or use **Forgot password**, or
  let the provider create accounts (`jit_provisioning`) instead.
- **`sso_only`** can be saved only by a `super_admin` who has linked their own
  account to an enabled provider. `NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN=true` keeps
  password sign-in open to `super_admin` accounts under it.

The full rules are in
[`operations.md`, "How accounts are matched"](operations.md#how-accounts-are-matched).

### Behaviour changes to plan for

All are listed in the [changelog](../CHANGELOG.md#030---2026-10-01).

- **Parameter `name` is limited to 1,024 characters and `in` to 64**, counted
  in UTF-16 code units (GHSA-qw45-p9g8-rprj). An upload whose path items or
  operations list a longer one, inline or behind a `$ref`, answers
  `400 SPEC_INVALID` with `details.reason` `"parameter_name_too_long"` or
  `"parameter_in_too_long"`. The limits also apply when a stored revision is
  read back, so **a revision stored under `v0.2.0` past either limit stops being
  served from the catalog**, and a review comparing it reports
  `complete: false`, until its provider publishes a revision within the limits.
- **The documentation render budget counts what the viewer renders**
  (GHSA-r4wm-2vch-9jxm). Some documents accepted before are now refused, chiefly
  ones with many primitive schemas, wide `oneOf`, `anyOf` or `allOf` lists or
  long enums, and ones using a `$ref` longer than 2,048 characters. A published
  document over the limit is no longer served from the catalog until a revision
  within it replaces it.
- **Revision comparisons gain `complete`.** `SpecDiff.complete: false` means
  the comparison ran out of budget, or a stored side no longer passes the
  upload checks: it lists added and removed operations but no changed ones.
- **Plugin settings Edge `v0.9.9` refuses are refused first.** A
  `correlation_id` or `request_deduplication` header name in the gateway-owned
  `x-consumer-*` namespace (any case, `_` and `-` alike) and an execution
  trigger path prefix with an empty segment (`/a//b`, `/;x/b`) or a dot segment
  carrying a `;` parameter (`/..;x/b`) answer `400 VALIDATION_FAILED`. A plugin
  configured this way under `v0.2.0` fails the gateway import in step 3: change
  it in the export (and then in the portal), or remove it before exporting.
- **Responses that set cookies are never cacheable.** Sign-in and other
  cookie-setting responses change from `Cache-Control: no-store` to
  `private, no-store`, and `GET /api/branding` no longer slides the session.
- **Queued mail with a single-use link is sealed.** Rows an earlier version
  queued are sealed in place by the outbox worker. Do not downgrade before
  failing queued sealed rows: an older instance would email the ciphertext.
- **HTTP Basic changes stop while one is unconfirmed.** While any `basicauth`
  change on an identity is unconfirmed, issuing, rotating or revoking a single
  one answers `409 CONFLICT`; the owner can revoke all of that identity's HTTP
  Basic credentials at once, or an administrator can reconcile the consumer.
- **New audit actions** record single sign-on (`auth.sso_login`,
  `auth.sso_provision`, `auth.sso_link`, `auth.sso_unlink`,
  `auth.sso_claims_sync`, `auth.sso_deprovision`), spec-change notices
  (`api.spec_notify`) and notification preferences
  (`user.notification_preferences_update`); `auth.login` records
  `break_glass: true`. Update any tooling that reads the audit log.

**Rollback** is a restore of the backup taken in step 1, Nexus and Edge
together: put the set-aside gateway database back and run Edge `v0.9.8` on it,
and restore the Nexus database. Never run `v0.2.0` over a database `v0.3.0`
migrated.

## Security

`v0.3.0` fixes these advisories, each of which affects `v0.2.0`:

- **GHSA-qw45-p9g8-rprj** (medium): a provider could make the specification
  review comparison, and the catalog's documentation viewer, spend CPU in
  proportion to a parameter name's length at every place the parameter was
  listed, blocking the server's event loop on one request. Each parameter's
  identity is now read once per document, the comparison works within a fixed
  budget, and parameter names and `in` are capped (see
  [behaviour changes](#behaviour-changes-to-plan-for)). Affects `v0.2.0`.
- **GHSA-r4wm-2vch-9jxm** (low): primitive schema entries bypassed the
  documentation render budget.
- **GHSA-pr4m-gv4h-3x72** (medium): a shared cache in front of the portal could
  replay session cookies from `GET /api/branding`.
- **GHSA-5526-6x2h-9hjw** (medium): revoking an HTTP Basic credential could
  report success while leaving it working.
- **GHSA-cx8j-q289-8w35** (medium): a reader of the queued mail could take over
  accounts with reset links.
- **GHSA-8wv5-62xv-93cg** (low): hCaptcha tokens were not bound to the portal's
  configured site key.

Upgrade any deployment running `v0.2.0`.

## Schema and upgrades

- **`v0.3.0` freezes `004_api_spec_changes`, `005_notification_preferences`
  and `006_user_identities`** on every backend.
  `server/src/db/released-migrations.ts` lists them with `release: 'v0.3.0'`
  beside `001_initial` (`v0.1.0`) and `002`/`003` (`v0.2.0`), each with a SHA-256
  checksum per backend, and CI fails on any edit to them. Later releases change
  the schema only with forward migrations that upgrade a `v0.3.0` database in
  place; see
  [schema versioning and upgrades](operations.md#schema-versioning-and-upgrades).
- **Every release is an upgrade source.** The released-baseline upgrade test
  builds a database as `v0.1.0`, `v0.2.0` and `v0.3.0` each left it, migrates it
  with the current code and reads every value back.
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
  outside the source tree. A provider's client secret saved in the portal is
  encrypted under `NEXUS_SECRET_KEY`, like the SMTP password.
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
- SMTP must be configured for real email delivery, and, unless the provider
  creates the accounts, for any account but the founder to link a single
  sign-on identity.
- Rate limits are enforced per gateway process unless
  `FERRUM_RATE_LIMIT_SYNC_MODE=redis` is set.
- Compensation for a gateway write is held in memory: a process that dies
  between Edge applying a change and its undo running leaves no record, and
  recovery is operational (`docs/security.md`).
- The gateway database cannot be carried across this Edge upgrade as it is;
  step 3 of the [upgrade](#upgrading-from-v020) re-imports it, and nothing in
  CI exercises that import from a `v0.9.8` export. Rehearse it on a copy.
- A `ferrumdata` volume kept from a pre-release stack has to be recreated, and
  its Nexus database with it, so starting both volumes fresh is simpler.

## Release step

This file is published as the GitHub release notes for tag `v0.3.0`. Earlier
notes are kept at their tags:
[`v0.2.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.2.0/docs/release-notes.md)
and
[`v0.1.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.1.0/docs/release-notes.md).

1. Merge the release change and require every check, `acceptance` included,
   to pass on the merge commit.
2. Create tag `v0.3.0` at that commit and publish a GitHub release for it with
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
