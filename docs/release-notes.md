# Ferrum Nexus v0.4.0 — release notes

**Released 2026-10-06.** Paired with Ferrum Edge `v0.9.13`. The pair is recorded
in [`release/compatibility.env`](../release/compatibility.env), which the
README quickstart, the Compose example, the getting-started walkthrough and the
real-stack `acceptance` CI job all read, so every one of them runs the same
gateway build. `v0.4.0` lets providers expose API operations as MCP tools and
grant consumers a subset of them, admits a backend write only when the gateway
attests public-only egress, recovers enforcement conversions through Edge's
conditional deployment API, and fixes twelve security advisories that affect
`v0.3.0`. It upgrades a `v0.3.0` database in place with five forward migrations,
and the gateway's database carries over unchanged. **Read the
[upgrade](#upgrading-from-v030) before starting:** it raises the Node floor,
requires every older Nexus writer to be stopped and drained, refuses backend
writes to a gateway that does not enforce public-only egress, and needs Nexus
and Edge upgraded in one window. The full list of changes is in the
[changelog](../CHANGELOG.md#040---2026-10-06).

## Supported combination

| Component      | Version                                | Pinned as                                                                                                |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Ferrum Nexus   | `v0.4.0`                               | Git tag `v0.4.0`; build `docker/Dockerfile` from that checkout                                           |
| Ferrum Edge    | `v0.9.13`                              | `ferrumedge/ferrum-edge:v0.9.13@sha256:6caa0987adb4c0a3a368fcd800bb0459cff3d3e219522e2e9c56280205862e50` |
| Node.js        | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | Source installs; the image uses a digest-pinned Node 22 base (22.23.3)                                   |
| Nexus database | PostgreSQL 17 (Compose sample)         | Also supported: SQLite, MySQL, MongoDB replica set — see [schema and upgrades](#schema-and-upgrades)     |

- **Ferrum Edge `v0.9.13`** is the
  [published release](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.13)
  (tag commit `9b83115de7ec23ab51ec4feae6bed65e596db425`). The digest above is
  the multi-architecture image index; it resolves to
  `sha256:03822d924b7919d07a840baf757d016f2f05c8df8a8d0455a2eebae917aae2cc` on
  `linux/amd64` and
  `sha256:a628f8fc12c916793b96ba111c2bf4360ea84981b8bf766254b47c6140c02a80` on
  `linux/arm64`. Both were checked against the Docker Hub registry on
  2026-10-06. Nexus vendors the matching contracts, `contracts-edge-0.9.13`
  (`9626821eb089c71f5d4d71268c7b8276a8a5ab50`).
- **What changed on the Edge side.** Edge `v0.9.13` reports its backend egress
  policy as `schema_version: 2`, serves deployment snapshot v2 (stored spec
  documents as digests plus a separate `api_spec_contents` array), signs
  deployment tokens in a new domain so every earlier token answers `412`, and can
  answer `507` for a namespace past its conditional size bound. Nexus `v0.4.0`
  reads only these forms, so it pairs with Edge `v0.9.13` only, and Edge
  `v0.9.12` or earlier is refused rather than guessed. Edge's schema
  migrations are unchanged from `v0.9.9` to `v0.9.13`, so a gateway database
  `v0.9.9` created opens in place, unlike the `v0.3.0` upgrade. Read Edge's
  [upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.13/docs/upgrade_guide.md#upgrading-to-0913)
  from `0.9.10` to `0.9.13` and its
  [changelog](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.13/CHANGELOG.md)
  for the data-plane changes your clients may notice, such as TLS source
  selectors that must match their field, buffered HTTP/3 uploads taking
  request-buffer admission and route deadlines bounding early body collection.
- **Other Edge versions are unverified.** Nexus `v0.4.0` has not been tested
  against any other Edge release; upgrade the gateway together with the portal.
- **No prebuilt Nexus image.** The release is a tagged source build: the
  Dockerfile uses a digest-pinned Node 22 base in both stages and `npm ci`
  against the committed lockfile. The tag, the base digest and the lockfile are
  the reproducible inputs; byte-for-byte image equality across Docker platforms
  is not promised. Record the local image ID you build with each deployment.

## Highlights

- **Agent-ready API listings with tool subsets.** A provider can expose
  selected OpenAPI operations of a requestable `routes` API as MCP tools (off by
  default). Existing approvals gate every tool, and normal credentials
  authenticate discovery and calls. A consumer can request, and a provider
  approve, a subset of the published tools; an explicit approval never follows a
  changed tool definition, so a revision that rewrites a tool's schema or prompt
  text drops it from every subset until it is approved again. See the
  [agent marketplace](agent-marketplace.md) and the
  [subset rollout](mcp-subsets-migration-draft.md).
- **Verified public-only gateway egress.** Before every backend write Nexus
  reads the gateway's egress policy and admits the write only when a local data
  plane attests public-only egress. `GET /api/health/edge` reports the verdict to
  administrators as `public_egress_guaranteed`. See
  [backend egress admission](operations.md#backend-egress-admission-and-the-public-only-guarantee).
- **Conditional recovery of gateway conversions.** Enforcement conversions and
  gateway restores keep an encrypted recovery journal and use Edge's conditional
  deployment API with the original snapshot authority; an unconfirmed result is
  kept for an operator instead of being retried with fresh authority. See the
  [operator runbook](operations.md#resolving-an-unconfirmed-gateway-deployment-mutation).
- **Security mail is never stuck behind a campaign.** The outbox claims
  verification and password-recovery mail ahead of routine notifications and
  mass email, and mass-email campaigns are bounded in aggregate and queued in
  chunks.
- **A read-only service-manifest preview** validates a Ferrum service manifest
  against the published shared v1 contract without publishing anything. See the
  [preview](service-manifest-preview.md).
- **Twelve security fixes**, listed under [security](#security).

## Install

From a clean shell, with Docker Compose v2 and `openssl`:

```bash
git clone https://github.com/ferrum-edge/ferrum-nexus.git
cd ferrum-nexus
git checkout --detach v0.4.0
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

## Upgrading from v0.3.0

`v0.3.0` is the supported upgrade source. A `v0.2.0` or `v0.1.0` database also
upgrades in one run (CI covers every release), but those releases ran Edge
`v0.9.8`, whose SQL gateway database Edge `v0.9.9` and later refuse: first follow
the [`v0.3.0` notes](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.3.0/docs/release-notes.md#upgrading-from-v020)
to export and re-import the gateway's configuration. Upgrade Nexus and Edge
together, in one maintenance window, following the
[production upgrade procedure](operations.md#production-upgrade-procedure):

1. **Check the prerequisites.**
   - **Node.** A source install needs Node `^22.22.2 || ^24.15.0 || >=26.0.0`;
     Node 22.14 to 22.22.1, Node 24 before 24.15.0, and Node 23 and 25 are no
     longer supported. The container image already carries Node 22.23.3.
   - **Gateway egress.** By default Nexus writes to the gateway only when a
     single Edge process that answers the Admin API and serves the traffic runs
     `FERRUM_BACKEND_ALLOW_IPS=public` with no `FERRUM_BACKEND_ALLOW_CIDRS`
     overlay. Edge's production default (`both`), an allow-CIDR overlay and a
     control plane with remote data planes all get every backend write refused
     and health `degraded`. Configure the gateway accordingly, or choose an
     opt-out (see [egress admission](#egress-admission-and-its-opt-outs)). The
     `v0.3.0` Compose example did not set the variable: add
     `FERRUM_BACKEND_ALLOW_IPS: public` to the `ferrum-edge` service's
     `environment` in your `docker-compose.yml`, or copy the new example over
     it.
   - **Agent APIs.** Inventory the APIs whose providers will want tool subsets:
     each needs one authenticated save of its agent settings, or a republish,
     after the upgrade before it accepts an explicit subset.
2. **Settle gateway recovery work on the old pairing.** Edge `v0.9.13` refuses
   every deployment token an earlier Edge issued, so a conversion or restore in
   flight across the upgrade cannot finish on its own. `v0.3.0` writes no
   recovery journals, so for a `v0.3.0` deployment this is a check: no
   `app_settings` row whose key starts with `gateway_recovery:` or
   `gateway_restore_cleanup:` should exist. Run
   `POST /api/apis/:id/restore-gateway` for every API whose `gateway_state` is
   `repair_required` until it completes, and ask providers not to change
   `spec_enforcement` or restore gateways until the upgrade is done. A
   deployment that ran an interim build from `main` follows
   [Upgrading to Edge v0.9.13](operations.md#upgrading-to-edge-v0913) step 2.
3. **Stop and drain every Nexus instance**, request handlers and background
   workers alike. Older and newer writers must never run together: an older
   publisher overwrites tool policy with the REST approval group, an older
   consumer-group rebuild does not understand subset membership, and an older
   mail producer or worker does not take part in the new recipient fence.
4. **Back up Nexus and Edge together**, as one point in time, following the
   [backup and restore runbook](operations.md#5-backup-and-restore). This backup
   is your rollback.
5. **Upgrade Edge to `v0.9.13`** on its existing database. A control plane and
   its data planes must run the same build. Keep Nexus stopped until step 7:
   Nexus `v0.3.0` is not tested against Edge `v0.9.13`, and Nexus `v0.4.0`
   refuses an older gateway's egress policy.
6. **Run the migrations once from the new Nexus image**
   (`node server/dist/db/migrate-cli.js`). It applies `007_outbox_recipient`,
   `008_email_lifecycle_fence`, `009_outbox_priority`, `010_api_agents` and
   `011_mcp_tool_subsets`; re-running it is safe. Nexus also migrates at
   startup, so a single-instance deployment may skip this step.
7. **Start `v0.4.0`** on every instance and verify it as the procedure says:
   `schema_migrations` lists `001_initial` through `011_mcp_tool_subsets`;
   `GET /api/health/edge`, read as an administrator, reports `status: "ok"` and,
   for a local public-only data plane, `public_egress_guaranteed: true`; and a
   known client still calls an API through the gateway with its existing
   credential.
8. **Enable tool subsets per API.** After the providers from step 1 save their
   agent settings or republish, check discovery and calls for those APIs before
   approving explicit subsets.

On the Compose stack, from the checkout you installed from, with the four
secrets you saved at install time exported again (never newly generated
values):

```bash
docker compose stop nexus
git fetch --tags origin
git checkout --detach v0.4.0
set -a
. ./release/compatibility.env
set +a
# Add FERRUM_BACKEND_ALLOW_IPS: public to the ferrum-edge service first (step 1).
docker compose up -d ferrum-edge
docker compose up -d --build
```

Take the paired backup (step 4) after `docker compose stop nexus` and before
`docker compose up -d ferrum-edge`. The gateway keeps the `ferrumdata` volume as
it is, and Nexus migrates the retained `pgdata` database when it starts.

What the migrations do, on every backend:

- **`007_outbox_recipient`** adds a nullable account binding to each outbox
  row. Existing messages and delivery state are kept; new account mail is
  bound to the account it was written for.
- **`008_email_lifecycle_fence`** adds an internal fence to each account,
  initialized empty, that orders account mail with address release. It changes
  no account data and does not appear in any API response.
- **`009_outbox_priority`** adds a delivery priority to every outbox row.
  Retained rows become normal priority, except rows whose idempotency key starts
  with `verify:` or `reset:`, which become high. Building its index on a large
  outbox can delay startup.
- **`010_api_agents`** adds the agent settings of each API. Every retained API
  starts with agents off.
- **`011_mcp_tool_subsets`** adds the requested and approved tools of access
  requests and grants. Every retained request and grant keeps covering all
  published tools.
- **MySQL** replays an interrupted upgrade: the runner checks each added
  column's live definition and each added index under an advisory lock before
  replaying it, and `009`'s priority assignment is idempotent.

### Egress admission and its opt-outs

Nexus admits a backend write only when the gateway's
`GET /backend-egress-policy` reports schema 2 with
`enforcement_scope=local-data-plane` and `public_only_guaranteed=true`. Two
opt-outs each relax only their own check; under either, startup logs
`BACKEND EGRESS NOT GUARANTEED`, the pairing is never reported as public-only,
and each publish, update and restore audit row records `egress_profile` and
`enforcement_scope`.

- **`NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`** keeps its meaning (Nexus skips its own
  upstream screening) and now also admits a gateway that reports weaker,
  well-formed metadata, such as a control plane with remote data planes,
  `both` mode or an allow-CIDR overlay. Against Edge `v0.9.13` it is the only way
  a control-plane/data-plane pairing publishes; enforce
  `FERRUM_BACKEND_ALLOW_IPS=public` without allow CIDRs on every data plane
  yourself.
- **`NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS=true`** (new) waives only the gateway
  attestation and keeps Nexus's own upstream screening. It still requires
  `public_only_guaranteed=true`, which Edge `v0.9.13` reports only for a local
  data plane, so against this Edge it admits nothing the default refuses.

Missing, malformed or unsupported-schema metadata is refused under every
profile. The [topology table](operations.md#backend-egress-admission-and-the-public-only-guarantee)
lists the outcome for each pairing.

### Behaviour changes to plan for

All are listed in the [changelog](../CHANGELOG.md#040---2026-10-06).

- **Gateway writes need public-only egress** unless an opt-out is set (see
  above). A refused write answers before any gateway change, and health reads
  `degraded`.
- **Rollback discards subsets.** Rollback restores the pre-upgrade backup (see
  below), so explicit tool-subset grants made after the upgrade are lost with
  every other post-upgrade change. To keep an audit trail, remove subset grants
  and restore all-tools grants through the normal audited workflow first.
- **A changed tool definition drops its approval.** A spec revision, rollback
  or agents edit that changes a selected tool's definition, a description-only
  edit included, gives it a new exposure ID and removes the old one from every
  explicit subset (`access.tools_prune`). Holders keep REST access and their
  other tools.
- **An agent API's document is bounded.** A publish, revision, rollback,
  restore, or a `PATCH` of `agents` or `spec_enforcement` whose built document
  would exceed 8 MiB answers `400 SPEC_INVALID`
  (`reason: "agent_document_too_large"`). An API already published with a
  larger document keeps serving; turn its agents off to revise it.
- **Mass email is bounded.** `NEXUS_MAX_MASS_EMAIL_BYTES` (default 64 MiB)
  caps one campaign's rendered size, and `NEXUS_MAX_MASS_EMAILS_PER_DAY`
  (default **5**) caps campaigns per administrator per rolling 24 hours; both
  answer `429 QUOTA_EXCEEDED`. Set the second explicitly to keep a higher
  ceiling. `admin.mass_email_complete` now carries the enqueued count.
- **The SMTP test is bounded and recorded first.** An `admin` may send it only
  to their own address (`403 FORBIDDEN` otherwise), every administrator may send
  ten an hour, and `admin.smtp_test` commits before the send, with the result in
  a new `admin.smtp_test_complete` row.
- **Only a credential's owner can rotate it.** Rotating another identity's
  credential is `403 FORBIDDEN` for every role; administrators revoke instead.
- **Single sign-on links and promotions are stricter.** Automatic linking
  refuses an account that is, or whose claims would make it, an administrator;
  claims do not promote an account that holds an identity at a lower-trust
  provider; a manual or claims promotion ends the account's other sessions; and
  a callback in flight when its provider was disabled or removed is refused.
- **OpenID Connect requests ignore proxy settings.** Discovery, key-set and
  token requests always connect directly and dial only vetted addresses; a
  deployment whose only egress is a proxy must allow direct egress to the
  identity provider.
- **Password-reset links are revoked** when a newer one is issued and when the
  account is disabled.
- **Edge response text no longer appears in credential-write errors**:
  non-GET `/consumers` failures omit `details.gateway_message`.
- **New audit actions**: `access.mcp_enroll`, `access.tools_prune`,
  `api.agents_update_start`, `api.gateway_conversion_start`,
  `api.gateway_conversion_rollback`, `user.address_release`,
  `admin.smtp_test_complete` and `admin.mass_email_complete`; update any tooling
  that reads the audit log.

**Rollback** is a restore of the backup taken in step 4, Nexus and Edge
together: restore the Edge database and run Edge `v0.9.9` on it, and restore
the Nexus database. Never run `v0.3.0` over a database `v0.4.0` migrated, and
never run Edge `v0.9.9` against a running Nexus `v0.4.0`. Settle recovery
journals again before rolling back: tokens Edge `v0.9.13` issued do not verify
on an earlier Edge.

## Security

`v0.4.0` fixes these published advisories, each of which affects `v0.3.0`:

- **GHSA-8w4q-fv8h-jv73** (medium): automatic OpenID Connect account linking
  could give a lower-trust provider's identity administrator rights.
- **GHSA-mr69-2744-f78w** (medium): an administrator could rotate another
  identity's gateway credential and receive its plaintext.
- **GHSA-fgq6-8q7j-qmww** (medium): issuing a new password-reset link left
  earlier reset links valid.
- **GHSA-rqrj-7g3f-c6ww** (medium): mass-email limits multiplied into unbounded
  database work and delayed account-recovery mail.
- **GHSA-p9qg-f2w6-c4qj** (low): an in-flight OpenID Connect callback could
  commit after its provider was disabled or removed.
- **GHSA-cq2h-g4g3-rw3p** (low): OpenID Connect provider requests validated one
  DNS answer but connected using another, permitting DNS rebinding.
- **GHSA-whpj-2fr3-jjrw** (low): SMTP test delivery happened before its audit
  record was durable.
- **GHSA-xx68-cpwv-x264** (low): the admin SMTP test endpoint could send
  unlimited mail to arbitrary recipients.
- **GHSA-qc7r-4j9m-pm44** (low): credential-write errors from Ferrum Edge could
  copy show-once secrets into Nexus logs.
- **GHSA-99p3-8fmh-3pfc** (low): quickstart and required CI containers were
  selected by mutable image tags.
- **GHSA-hf6x-q9cp-9g6f** (low): the acceptance test runner executed
  `e2e/.env` as shell code.
- **GHSA-gwhq-6vwf-9mmq** (low): generated acceptance test secrets could be
  written world-readable.

Upgrade any deployment running `v0.3.0`.

## Schema and upgrades

- **`v0.4.0` freezes `007_outbox_recipient`, `008_email_lifecycle_fence`,
  `009_outbox_priority`, `010_api_agents` and `011_mcp_tool_subsets`** on every
  backend. `server/src/db/released-migrations.ts` lists them with
  `release: 'v0.4.0'` beside `001_initial` (`v0.1.0`), `002`/`003` (`v0.2.0`)
  and `004` to `006` (`v0.3.0`), each with a SHA-256 checksum per backend, and
  CI fails on any edit to them. Later releases change the schema only with
  forward migrations that upgrade a `v0.4.0` database in place; see
  [schema versioning and upgrades](operations.md#schema-versioning-and-upgrades).
- **Every release is an upgrade source.** The released-baseline upgrade test
  builds a database as `v0.1.0`, `v0.2.0`, `v0.3.0` and `v0.4.0` each left it,
  migrates it with the current code and reads every value back.
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
- A control plane with remote data planes is never reported as public-only.
  Against Edge `v0.9.13` it publishes only with
  `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`, which also skips Nexus's own upstream
  screening; public-only egress on each data plane is then the operator's to
  enforce.
- The public-only DNS-rebinding fixture
  ([`e2e/public-only/`](../e2e/public-only/README.md)) runs on demand with a
  packaged image; it is not part of the required CI checks.
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

This file is published as the GitHub release notes for tag `v0.4.0`. Earlier
notes are kept at their tags:
[`v0.3.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.3.0/docs/release-notes.md),
[`v0.2.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.2.0/docs/release-notes.md)
and
[`v0.1.0`](https://github.com/ferrum-edge/ferrum-nexus/blob/v0.1.0/docs/release-notes.md).

1. Merge the release change and require every check, `acceptance` included,
   to pass on the merge commit.
2. Create tag `v0.4.0` at that commit and publish a GitHub release for it with
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
