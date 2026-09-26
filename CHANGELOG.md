# Changelog

All notable changes to Ferrum Nexus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The verbatim quickstart gate (#287), closing out the `v0.1.0` release
  criteria of #286 and #287. `.github/workflows/quickstart-gate.yml` checks out
  a release in a clean hosted runner — on every `v*` tag push, on demand with a
  `ref` that defaults to the latest published release, and on pull requests
  that touch the install surface — runs the README's marked full-stack block
  exactly as written, waits a bounded time for healthy services, and follows
  the getting-started walkthrough to a `200` through the gateway on `:8000`
  with an issued key, a `401` without it and a `403` after revocation, then
  tears the stack down. The `quickstart-config` job now also fails when the
  README's markers are missing or duplicated, or when the Compose example,
  `docs/operations.md` or `docs/release-notes.md` stop repeating the block
  verbatim. The getting-started walkthrough says how to follow it on the
  Compose stack, whose portal logs a generated bootstrap token and publishes
  only public upstreams, and the release notes' release step requires the
  gate's green run.

### Fixed

- Opening a thread or replying no longer answers `500` for a message that was
  already stored and audited when working out who to notify fails (#393).
  Recipient discovery — the other seat of a direct thread, the owner of a
  platform thread, or the admins behind one — and the re-read that decorates a
  new thread for the response now sit inside the same best-effort boundary as
  the in-app notification and the queued email: the failure is logged and the
  send answers `201` with the durable message, so the sender's retry no longer
  stores a second copy. Message and audit failures stay fatal and atomic.
- Cross-instance leases are fenced (#384). Every acquisition of an
  `edge_leases` lock now writes a fresh owner token, and every database
  transaction opened while the lock is held verifies that token — and, on
  PostgreSQL, MySQL and MongoDB, locks the lease row — just before it commits.
  An instance that stalled past the 60-second lease TTL while another took the
  key over now fails with `409 CONFLICT` and rolls back instead of committing
  over the new holder's work; before, an API deletion resumed that way could
  drop the API's rows after another instance had built a test consumer for it.
  The lease-guarded writes that were not yet transactional now are: a sign-in's
  password re-check and its session, a password change's replacement session, a
  gateway identity's owner check, registration, consumer binding and removal
  (including the compensation of an abandoned test-consumer creation, which no
  longer removes a registration a newer attempt has claimed), a consumer
  mapping recorded after provisioning or removed by an account teardown, the
  credential rows revoked by a consumer teardown, a gateway restore's repair flag, and a god-mode broadcast's
  daily count and the audit row it charges. A refused sign-in is told to sign
  in again, and a password change whose new password had already committed is
  told so and to sign in with it, rather than to retry. No schema change: the
  token is stored in the existing `owner` column. Ferrum Edge still cannot reject a stale
  holder's gateway write, so the single gateway-writing instance guidance is
  unchanged (`docs/security.md`, "Cross-instance locks are fenced at commit").
- The publish-time render ceiling now charges every response entry, including
  one that declares no `content` or names an already-charged `$ref`, and
  `too_much_to_render` details report the new `responses` count alongside
  `schema_nodes`, `parameters` and `media_types` (#390). Previously a
  `responses` map of empty entries cost nothing, so one repeated by YAML aliases
  across many operations could keep the upload check busy for about a second
  without reaching the ceiling; the count now stops at the ceiling instead.
- A message reply draft now belongs to its conversation (#391). Opening another
  conversation shows that conversation's own draft instead of carrying the text
  across, and a reply that finishes sending clears the composer only if it
  still holds the text that was sent, so edits made while the reply was in
  flight — or a draft in another conversation — are kept. A failed send keeps
  the draft.
- Retired APIs in the catalog are labeled as retired and no longer show a new
  access-request form. Existing identity grants remain visible, and pending
  requests can still be withdrawn (#376).
- The catalog's **Call this API** panel now follows the selected identity
  (#374). On an API that needs approval it appears only for an identity that
  holds an active grant, and its example, Consumer and JWT `sub` use that
  identity's consumer — `nexus-app-<id>` for an application — instead of always
  the account's, which could be unapproved. The access card's badge reflects the
  selected identity rather than the account-wide state, and an API without
  approval lets the caller choose which identity the example calls as.
- The catalog's copyable HTTP Basic example now authenticates (#375): it uses
  `curl --user 'nexus-user-<id>:<your password>'`, which curl encodes into the
  `Authorization: Basic` header, instead of a literal `base64(...)` header, and
  the shown and copied text are the same shell-quoted command.
- Approval, application deletion and API deletion now refresh dependent grant,
  credential, request, catalog and application count caches (#379).
- **API settings change only the gateway plugin configs the portal created,
  and a plugin-config write whose acknowledgement is lost is compensated.**
  - `PATCH /api/apis/:id` used to find the API's `rate_limiting`, `cors`,
    `access_control` and auth configs by plugin name, so a provider's quota,
    CORS, `requestable` or `auth_plugin` change could rewrite or delete a
    config of the same name that a gateway operator had attached to the proxy.
    Nexus now records the Edge config id of every first-class config it
    creates (forward migration `002_api_gateway_plugins`, new store repository
    `apiGatewayPlugins`) and acts on those ids alone; an operator's config is
    left exactly as it is, and the portal creates its own beside it when it
    owns none. Every role is recorded, with a `NULL` config id where the
    portal owns no config, so the record is complete from the first change.
    An API published before the upgrade has its configs recognised role by
    role, by the values the portal wrote rather than by name — an auth config
    only while it is exactly the empty config the portal writes. A change to a
    setting whose proxy carries two such candidates, or to `auth_plugin`,
    `requestable` or `cors` when the proxy's only auth, `access_control` or
    `cors` configs no longer match the API's settings, is refused with
    `409 CONFLICT` naming the plugin — for an auth swap, because the outgoing
    config left attached would keep accepting the credentials the portal tells
    grantees to replace. A hand-edited limiter is left to the operator, the
    portal's own is created beside it, and the `api.update` row names it under
    `unowned_same_name_configs`, as it does the same-name configs of a role the
    API does not use. `002_api_gateway_plugins` is listed in the
    released-migration manifest as pending (`release: null`), so CI checks its
    artifacts until the release that ships it freezes them.
  - A `PUT /plugins/config/{id}` Edge applied but never acknowledged used to
    leave the change live — a palette security plugin disabled or an
    allow-list replaced, a first-class quota raised — while the request failed
    and the portal kept showing the old setting. The compensating write, which
    restores the whole live resource including `enabled` and `trigger`, is now
    registered before the `PUT`; new configs are created under an id minted
    before the `POST`, so an unacknowledged create is withdrawn too; and a
    removed config that has to be put back is recreated under its own id.
  - A palette `set` or `remove` that reached the gateway and then failed now
    writes an `api.plugin_rollback` audit row recording whether the gateway was
    restored (`restored`), and when it was not, the step errors and the config
    to inspect. `docs/security.md` now states that compensation is held in
    memory: a process that dies between Edge applying a change and the undo
    running leaves no record, and recovery is operational.
- **OpenAPI documentation follows parameter inheritance and reusable
  components (#377, #378).**
  - An operation parameter now replaces the path-level parameter with the
    same `name` and `in` instead of rendering beside it, so an override no
    longer shows two contradictory rows; parameters that share only a name
    across locations stay distinct. The revision comparison applies the same
    rule, shared from `@ferrum-nexus/shared`, and compares parameters in a
    canonical order, so removing an overridden path-level definition, moving
    one between levels or reordering them no longer reports a `parameters`
    change. A parameter whose reference cannot be followed is never merged
    away.
  - Parameters, request bodies and responses written as local `$ref`s to
    `components` now render the object they name — a required header shows as
    required, and a referenced body or response shows its description and
    schema. Chains are followed up to a fixed hop limit with a cycle guard,
    JSON-pointer escapes and percent-encoding are honoured, and only a
    document's own members are followed. External, dangling, circular or
    overlong references render as an explicit unresolved marker instead of an
    empty or optional row, and any reference the viewer displays is cut to 200
    characters. From OpenAPI 3.1 on, a `description` or `summary`
    next to a `$ref` overrides the referenced one, as the specification allows.
  - References are followed through one memoised resolver per document, in
    the viewer, the revision comparison and publish-time validation alike: each
    distinct `$ref` is walked once however many parameters use it, JSON
    pointers longer than the nesting limit are refused, and a 3.1 sibling
    override no longer copies the referenced object. The publish-time render
    ceiling now charges a `$ref`'d parameter, request body or response for the
    object it names, each distinct object once however many places reference
    it, so a document is newly refused with `too_much_to_render` only when the
    components its operations reference, counted once each, take it past the
    ceiling. The count enumerates each object once and stops at the first
    charge past the ceiling. An empty `parameters` list and a missing one no
    longer read as a change.
- **Application deletion is atomic, race-free and quota-preserving (#363,
  #364, #365).**
  - The rolling access-request budget
    (`NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY`) counts the requester's
    `access.request` audit rows instead of `access_requests` rows, and that
    audit row is now written in the request's own transaction. Deleting an
    application cascades its requests away, so create application → request →
    delete → repeat used to hand the account its allowance back every time
    (#363). A deleted application's requests, like cancelled ones, now stay
    charged until they leave the 24-hour window, and a creation that rolls back
    charges nothing. `AccessRequestRepo.countByUserSince` is removed.
  - On MongoDB, deleting an application runs its per-collection cascade
    (grants, access requests, credentials, consumer mapping, then the
    application) in one session transaction, joining the caller's when there
    is one; it used to be five loose writes, so a failure part-way left some
    collections emptied and the application standing (#364).
    `ApplicationsService.remove` counts and deletes in one transaction on every
    backend, so the `revoked_grants` / `revoked_credentials` it reports are
    exactly what went, and a retry after the gateway consumer was already
    removed finishes the rows without recreating anything on the gateway.
  - Filing an access request for an application holds the identity's
    provisioning name key — the one its deletion holds — re-reads the
    application (exists, owned, `active`) inside it, and keeps it until the
    request has committed and the provider has been notified. A delete that
    finished after the route resolved the application used to leave MongoDB
    holding a pending request for an application that no longer existed, and
    the SQL backends failing a foreign key (#365); that request now gets
    `404 NOT_FOUND` with no charge, no `access.request` row and no provider
    notice, and a request that won the key is removed by the delete that
    follows it.
- The local acceptance runner now rebuilds Nexus from the current checkout on
  every default run, follows the checked-in Ferrum Edge digest even when a
  generated `e2e/.env` is present, and logs the image IDs and Edge repository
  digest used. Explicit `NEXUS_IMAGE` and `FERRUM_EDGE_IMAGE` overrides remain
  available, and unsupported suite names or extra arguments fail before
  environment or Docker side effects. Mocked shell regressions cover these
  paths (#366, #367).
- Application create/update and private-API viewer authorize/revoke now write
  their audit rows in the same store transaction as the change they describe
  (#362). Previously the row was committed first and the audit written after,
  so a failed audit insert left an unaudited application (counted against the
  owner's quota and blocking a same-name retry), an unaudited rename or disable,
  a viewer who could read the private documentation with no authorization row,
  or a withdrawn authorization with no revocation row — all behind a `500`.
  Application creation keeps its owner quota lease outside the transaction and
  both the insert and its audit inside it; the viewer notification is still sent
  only after the authorization commits. Covered on every adapter by the new
  application and viewer audit store contract.
- A test-consumer creation (`POST /api/apis/:id/test-consumer`) racing the
  deletion of its API can no longer leave a gateway consumer and
  `gateway_identities` registration behind for an API that no longer exists
  (#373). The creation read the API before taking the identity's name lock and
  never re-read it, and the deletion released that lock between its identity
  teardown and its row delete, so a creation that had loaded the API a moment
  earlier answered `201` over an orphan. The creation now re-reads and
  re-authorises the API inside the lock, and the deletion drops the API's rows
  before releasing it: a creation either completes first and is swept by the
  deletion, or answers `404 NOT_FOUND` having created nothing. Deterministic
  race tests cover both orderings and the gap between teardown and row delete.
  A creation whose API had its `auth_plugin` swapped while the credential was
  being issued now revokes that credential and answers `409 CONFLICT` for the
  client to retry, instead of returning a key of the old flavour. A deletion
  whose row delete fails after the teardown logs what the teardown collected
  and keeps the identity's registration, so the retried `DELETE` still records
  the collected `test_consumer_id` in its `api.delete` audit row; and two
  concurrent deletions of one API can no longer both answer `200` and both
  write `api.delete` — the one that finds the row already gone answers `404`.
- Account role changes, enables, disables and administrative account edits
  (ordinary and god-mode), gateway-revocation retries, and application and API
  deletions now write their audit rows in the same store transaction as the
  change they describe. Previously the change committed first, so a failed audit
  insert left it applied with no record behind a `500`, and repeating the
  request then found nothing left to change and recorded nothing either. A
  disable's sessions now end, and its gateway revocation is queued, in that
  transaction too. Deletions, whose gateway work cannot be rolled back, commit a
  new `application.delete_start` / `api.delete_start` row before the first
  gateway call and their `application.delete` / `api.delete` row with the local
  delete (`god.delete_api` joins the latter), so a failed completion leaves the
  portal rows in place for the retry. What runs after a committed disable is
  recorded as its outcome: `user.gateway_teardown_complete` (now also written,
  with `details.inline: true`, when the admin request's own immediate attempt
  lands) and the new `god.disable_user_complete`, which carries the grant sweep
  and any `failed_steps` that `user.disable` and `god.disable_user` used to. The
  transition rows now read `gateway_teardown: "queued"`. The actions are listed
  in `TRANSACTIONAL_AUDIT_ACTIONS`; a source scan fails the build when one is
  recorded outside its transaction, and a new store contract fails each audit
  insert on every adapter and asserts that nothing committed.
- Access approvals, denials, cancellations and revocations (ordinary,
  god-mode and the god-mode grant sweep), credential issues, rotations,
  revocations and reconciles, publishes, API edits and retirements, palette
  plugin changes, test-consumer creations, gateway consumer repairs and
  organization changes now also write their audit rows in the transaction that
  makes the change (#389). A failed insert no longer leaves the change applied
  and unaudited behind a `500`; where the gateway was written first it is
  compensated like any failed row write — an approval's ACL group comes back
  off, an issued key or a new API's proxy is withdrawn, a plugin change is
  undone, a test consumer is taken back down. Gateway work that cannot be undone,
  or only best-effort, commits a new intent row first: `api.plugin_remove_start`
  before a palette plugin's config is deleted, and `credential.revoke_start`
  with a credential's move to `retiring`; a failed completion leaves the row
  for the repeat, which records it; a rotation at the per-type cap, which deletes
  the old key before appending its replacement, commits a
  `credential.revoke_start` row with `operation: "rotate"` the same way, and a
  rollback of its replacement names the retired key. A revocation the gateway
  refused still puts the grant back when its `access.revoke_rollback` row cannot
  be written (or the lease fence refuses the combined write), recording the row
  best-effort afterwards, and a consumer repair that cannot commit deletes the
  consumer it recreated, so a repeat repairs it rather than finding it present.
  The god-mode sweep's `access.revoke` rows now commit with each grant's claim,
  so a gateway refusal is reported in
  `god.disable_user_complete`'s `failed_grants` rather than on the row, and the
  `audit` failure stage is gone. A repeated application, API or plugin removal
  that finds the gateway side already collected copies what the earlier
  attempt's start row recorded — `consumer_id`, `test_consumer_*`,
  `plugin_config_id` — and adds `resumed: true`. A god-mode disable whose inline
  `user.gateway_teardown_complete` row cannot be written now still writes
  `god.disable_user_complete`, naming `record_gateway_teardown` in
  `failed_steps`. Every audit action is now classified as `transactional`,
  `intent` or `post_commit` (with its reason) in `AUDIT_COMMIT_CLASSES`, and the
  source scan is deny-by-default: an unclassified action does not compile, and
  it also fails a record that is not directly awaited, is `.catch`ed or sits in
  a swallowing `try` (including a `catch` that can return before it rethrows),
  a transactional record in a callback that writes nothing else, aliased
  imports of the audit module, and a transaction hook bound, passed or
  destructured under another name.
- The specification editor enforces the 2 MiB document limit before reading or
  parsing (#403). A selected file larger than the limit is refused from its
  size without being read, keeping the current draft and saying why; text over
  the limit, counted in UTF-8 bytes as the server counts it, is no longer
  parsed; and the publish and revision-review preflight now refuses such a
  document instead of calling it valid and sending it to a server that will
  reject it. The server's byte check stays the authority.
- A specification upload that finishes late no longer overwrites newer work in
  the editor (#401). A read is applied only while it is still the latest
  selection and the draft has not changed since it started, so typing, choosing
  another file, the page replacing the draft or the editor closing all drop an
  earlier pending read. Choosing the same file again still reloads it.
- Spec updates, spec rollbacks and gateway restores now write their
  `api.spec_update`, `api.spec_rollback` and `api.gateway_restore` rows in the
  transaction that makes the change (#400). A failed insert rolls the revision
  or the proxy adoption back and the gateway change is compensated, instead of
  leaving a live deployment unaudited. Because that compensation is
  best-effort, a revision that rewrites a live proxy first commits a new
  `api.spec_revision_start` intent row under the proxy lease, and a restore a
  new `api.gateway_restore_start` row (naming the proxy id it is about to
  create) under its restore key, before the first gateway write; a failure to
  record either stops the operation before the gateway is touched. A revision
  that fails after its start row records a new `api.spec_revision_failed` row
  saying whether the gateway was put back (`restored`); a restore keeps
  recording `api.gateway_restore_failed`. All three completion actions are now
  classified `transactional` and the two start rows `intent`.
- An `auth_plugin` change that leaves an enabled config of the outgoing plugin
  associated with the proxy — an operator's, which the portal never deletes, on
  a recorded API or beside the portal's recognised config on an unrecorded one —
  no longer reports the outgoing credentials as invalidated (#397). The
  `api.update` row records `existing_credentials_invalidated: false` and lists
  the configs under `outgoing_auth_configs_remaining` (also on
  `api.auth_plugin_changed` and in the `PATCH /api/apis/:id` response), and
  grantees are told a gateway configuration outside the portal still accepts
  their existing credentials instead of being told they stopped working. The
  `409 ACCESS_DISRUPTION_CONFIRMATION_REQUIRED` refusal carries the same list in
  its `details` and no longer claims the grantees would be locked out; a
  disabled or unassociated config is not counted. A non-matching config beside a
  recognised candidate is now also named under `unowned_same_name_configs` when
  the role is first recorded.

## [0.1.0] - 2026-09-25

The first supported release, paired with Ferrum Edge `v0.9.7`. See
[`docs/release-notes.md`](docs/release-notes.md) for the supported combination,
installation and known limitations.

### Added

- A released-schema boundary with upgrade and restore guarantees (#286).
  `server/src/db/released-migrations.ts` lists each released migration with a
  SHA-256 checksum per backend (the MongoDB step through a committed index
  snapshot), and `released-migrations.test.ts` fails CI when a released
  migration is edited, renamed, deleted or preceded by a new one, or when the
  backends disagree on migration ids. `001_initial` is the baseline this
  release freezes. A baseline-shaped fixture (accounts, API ids and slugs,
  provider ownership, specification history, grants, credential metadata,
  gateway mappings, plain and encrypted settings) is upgraded to the
  current schema and re-migrated as a no-op on SQLite in every run and on
  PostgreSQL, MySQL and MongoDB in `store-contracts`. `docs/operations.md`
  separates the development reset from the production upgrade procedure and
  gains a backup-and-restore runbook for the Nexus/Edge pair, and the acceptance
  suite now backs up, destroys and restores the packaged portal's PostgreSQL
  database together with the real gateway's, then proves an approved client's
  pre-backup credential is still served and a revoked client is still refused.
  The MongoDB adapter exports `BASELINE_INDEXES`, `MONGO_MIGRATIONS` and
  `runMongoMigrations`, and the SQLite and PostgreSQL migration drivers are
  exported for the upgrade tests.
- Branding presets, so a portal can be re-skinned from **Administration →
  Settings → Branding** without touching CSS. `PUT /api/admin/settings`
  `branding` and `GET /api/branding` gain `radius` (`none`|`sm`|`md`|`lg`),
  `font_preset` (`system`|`inter`|`manrope` — the two named faces are bundled
  and self-hosted, loaded only when selected), `sidebar_style`
  (`surface`|`contrast`), `login_layout` (`split`|`centered`), `footer_text`
  (≤ 200) and `footer_links` (≤ 5 `{ label, url }`, `http(s)` only; anything
  else is `400`, and a malformed stored link is dropped on read). The branding
  tab groups Identity / Appearance / Footer, previews both themes live from the
  unsaved values (colours, corners, typeface, rail), and replaces the native
  file input with a styled logo upload. `DEFAULT_BRANDING` now matches the
  stylesheet's ember identity (`#f97316` / `#38bdf8`) instead of the indigo
  pair the SPA never used.
- CAPTCHA lockout recovery (#252). Enabling CAPTCHA — or changing its
  `provider`, `site_key` or `secret_key` while it is on — now requires a
  `captcha_token` that the **new** configuration verifies with the vendor, and
  the whole patch is refused with `400 CAPTCHA_SELF_TEST_FAILED` (a new error
  code) without storing anything if it cannot be proven. The admin settings page
  renders the widget from the pending values to mint that token. For a portal
  already stuck, `NEXUS_CAPTCHA_ENFORCEMENT=disabled` (accepted values
  `enforced` — the default — and `disabled`) makes register and login skip
  verification and hides the widget without touching a stored setting; it logs a
  startup banner, is reported as `captcha.enforcement` on
  `GET /api/admin/settings`, marks the sessions it admits with
  `captcha_bypassed: true` in the audit log, and cannot be set through the API.
  Two supporting rules come with the self-test: `provider` cannot move while
  CAPTCHA is enabled unless the same patch carries `secret_key` (a vendor secret
  is never posted to another vendor), and a `captcha` patch is refused with
  `409 CONFLICT` when the stored rows moved while the vendor was being asked,
  rather than committing a merge nothing proved.
- Gateway resource attribution via `labels.provisioned-by: ferrum-nexus`, including API-spec-generated resources (requires Ferrum Edge resource-label support).
- Test coverage collection: `npm run test:coverage` runs the server suite
  under `node --experimental-test-coverage` and then the web suite under
  `vitest run --coverage` (`@vitest/coverage-v8`, text + lcov reporters). CI
  runs it in a non-blocking `coverage` job that uploads the text summary and
  `web/coverage/lcov.info` as an artifact; no required check changes.
- `NEXUS_WEB_PORT` (alias `VITE_DEV_PORT`) and `NEXUS_API_PROXY_TARGET` for
  `npm run dev`, so a second Nexus (or Foundry) stack can pick free ports
  without editing `web/vite.config.ts`. Defaults stay 5173 and
  `http://127.0.0.1:8787`; the `/api` proxy follows `NEXUS_PORT` when the
  explicit target is unset.
- Ground-up rewrite of the portal: Fastify BFF (`server/`), React SPA
  (`web/`), shared types (`shared/`).
- Portal accounts with sessions, CSRF protection, and role-based access
  control (`client`, `provider`, `admin`, `super_admin`); first registered
  user becomes `super_admin`.
- API catalog with rendered OpenAPI documentation and access requests with
  justification, approval / denial / revocation workflow.
- OpenAPI-driven API publishing that creates Ferrum Edge proxies, with
  per-API access control via consumer ACL groups.
- Show-once gateway credential issuance and rotation (one Ferrum consumer
  per user per namespace).
- Messaging between clients and providers, in-app notifications, and
  transactional email via a retrying outbox worker.
- Admin console: branding, CAPTCHA, email senders/templates, mass email,
  user/provider/API/grant management, historical audit log, and god mode.
- Database adapters for SQLite (default), PostgreSQL, MySQL, and MongoDB
  over one logical schema (string UUIDs, ISO-8601 timestamps).
- Docker image and example compose stack; CI workflow (typecheck, tests,
  build).
- Agent-dispatch skills under `.claude/skills/` (`.agents/skills` is a
  symlink to the same tree) for delegating work to external CLI coding
  agents on isolated git worktrees.
- **Self-service password reset** (`POST /api/auth/forgot-password`,
  `POST /api/auth/reset-password`) and **re-sending a lost verification
  email** (`POST /api/auth/resend-verification`), with a `password_reset`
  email template, portal pages, and a "Forgot password?" link. All three
  routes answer identically and take the same time whether or not the
  address exists, is throttled or is disabled, so they cannot be used to
  enumerate accounts. Email tokens now carry a `purpose`, so a verification
  link can never be redeemed as a reset link.
- **Per-API CORS policy** (`cors: { allowed_origins, allow_credentials }` on
  publish and update), attached to the proxy as an Edge `cors` plugin.
  Omitting it means the gateway adds no CORS headers.
- **`upstream_url` on the API object** — the normalized backend the proxy was
  last pointed at — returned by every list/get/publish/update response and
  kept in sync on `PATCH` and spec-following updates.
- `NEXUS_ALLOW_PRIVATE_UPSTREAMS` (default `false`): publishing refuses
  loopback, private, link-local and `.internal`/`.local` upstreams unless a
  deployment opts in. See `docs/security.md`.
- `GET /api/health` distinguishes a gateway that answered `503` with
  `ready: false` (`edge.status: "not_ready"`) from one that is unreachable
  (`"down"`), and answers HTTP `503` itself only when the database is down.
  The Docker image now ships a `HEALTHCHECK` on it.
- A root `npm run migrate` script that builds `shared` first, so migrations
  work on a clean clone.
- **The catalog tells clients where to call.** A `gateway.public_url` setting
  (env default `FERRUM_GATEWAY_PUBLIC_URL`) and derived `listen_path` /
  `invoke_url` fields on every API object, with a "Call this API" panel and
  the auth-header recipe on the catalog and credentials pages.
- **Usage and backend status per API** (`GET /api/apis/:id/usage`): requests
  by status class and method, 401/403/429 counts, interpolated latency
  percentiles and a healthy/failing/recovering verdict, read from Edge's
  `/metrics` and `/admin/metrics` with a 10-second cache. Cumulative since the
  gateway process started; never a 5xx when the gateway is unreachable.
- **Provider runtime settings** for the proxy: an HTTP method allow-list
  (`OPTIONS` is added automatically when a CORS policy exists so preflight
  still works), backend connect/read/write timeouts, and a circuit breaker
  with Edge's defaults.
- **Routes-only OpenAPI enforcement** (`spec_enforcement: "routes"`): the
  API's proxy is created through Edge's API-spec importer (`POST /api-specs`)
  from the current document, so the gateway's own `openapi_validator`
  rejects paths and methods the document does not declare; every spec update
  goes through `PUT /api-specs/{id}` and regenerates it. Request and response
  bodies are not validated; `docs_only` (a hand-made proxy) stays the
  default, and switching levels rebuilds the proxy under the same id with a
  brief interruption. Verified against a live gateway — Edge refuses a
  directly attached validator on a proxy it does not own, which the mock now
  models too.
- `FERRUM_RATE_LIMIT_SYNC_MODE=redis` (+ `FERRUM_RATE_LIMIT_REDIS_URL`,
  `FERRUM_RATE_LIMIT_REDIS_TLS`) stamps Redis counter sync onto every rate
  limit Nexus writes; the operations guide warns that quotas are otherwise
  enforced per gateway process.
- With WebSocket origin enforcement enabled, exact CORS origins are mirrored
  onto the proxy's `allowed_ws_origins`, so
  a browser cannot open a cross-site WebSocket to an API whose CORS policy
  would refuse it.
- **Provider plugin palette** (`GET`/`PUT`/`DELETE /api/apis/:id/plugins/:name`
  and a Plugins tab): providers attach curated, schema-validated Edge plugins
  to their own API — `security_headers`, `request_size_limiting`,
  `response_size_limiting`, `ip_restriction`, `bot_detection`,
  `correlation_id`, `compression`, `response_caching`,
  `request_deduplication` and `request_termination` — with an execution
  trigger (methods, path prefix) where Edge accepts one. The descriptor
  catalog in `shared/src/plugins.ts` is the single source of truth for the
  forms and the validation; configs are proxy-scoped and associated on the
  proxy like the first-class ones. Operator plugins (logging, telemetry,
  mesh, chaos) and the auth family stay out of the palette.
- **Gateway reference reconciliation.** Retargeting `FERRUM_ADMIN_URL` at a
  different Ferrum Edge — or rebuilding the one it already names — left every
  stored `ferrum_consumer_id` and `ferrum_proxy_id` pointing at nothing, with
  `GET /api/health` still green: legacy accounts failed approvals and
  credential issuance with `502 EDGE_ERROR`, and legacy APIs kept dead proxy
  ids that served no traffic. A background pass
  (`NEXUS_GATEWAY_RECONCILE_INTERVAL_MS`, 15 min, plus one at startup, bounded
  by `NEXUS_GATEWAY_RECONCILE_SAMPLE`) now checks those references against the
  gateway and reports `edge.reconciliation` on both health endpoints, degrading
  the portal when any are orphaned. Nothing is ever repaired automatically:
  `POST /api/admin/gateway/reconcile` and `POST /api/admin/gateway/repair` are
  `super_admin` only and audited, and the repair recreates each consumer under
  the same identity with its approved ACL groups replayed, revokes the
  credential rows whose show-once material died with the old gateway rather
  than minting replacements, and clears dead proxy ids so providers republish
  through the ordinary flow. See `docs/operations.md` §13.

### Changed

- **The `001_initial` schema baseline is frozen** (#286). The released-migration
  manifest records it with `release: 'v0.1.0'`, so CI now rejects any edit to
  it on every backend; a schema change is a new forward migration that upgrades
  a `v0.1.0` database in place. Only disposable databases from pre-release
  buildout checkouts are recreated.
- **Ferrum Edge `v0.9.7` is the supported gateway** (#287).
  `release/compatibility.env` pins
  `ferrumedge/ferrum-edge:v0.9.7@sha256:4c9530e09443649526dc4fbbec0720ba7b47ceb91b0dd5cb06db85430908874a`
  (the multi-architecture index) and names `NEXUS_RELEASE_TAG=v0.1.0`; the
  README quickstart, the Compose example, the getting-started walkthrough and
  the `acceptance` job all read it.
- Reading one proxy's plugin configs uses Edge `v0.9.7`'s
  `GET /plugins/config?proxy_id=…` filter instead of paging every plugin config
  in the namespace and filtering in the portal. The filtered set is still paged
  to its end, so a proxy with more than 1000 configs is read completely, and a
  gateway older than the filter (which ignores it) still gets a correct answer.
  The mock gateway honours the filter and refuses any other list parameter.
- Portal redesign. A design-system foundation (`web/src/styles/globals.css`,
  `web/src/components/ui/`) now carries every page: sidebar tokens with an
  active-rail indicator and a signed-in card, a translucent header that shows the
  current section and page instead of repeating the portal name, page headers
  with breadcrumbs and inline badges, stat tiles, skeleton loading rows, search
  inputs, toolbar-hosted table filters, status dots on badges, animated dialogs,
  popovers and toasts with tone icons, a split-hero sign-in layout, a designed
  404, and 24 more icons. Every route was reworked on top of it — dashboard with
  quick actions, catalog cards with owners and result counts, catalog and API
  workspace headers with an at-a-glance strip and copyable URLs, a two-column
  publish form with a sticky settings rail, avatar-led lists for requests,
  grants, users, threads and audit entries, a card footer convention for forms,
  a sober danger-zone treatment for god mode, radio-card role choice and
  password reveal toggles on the public forms, and a tidier OpenAPI viewer.
  Behaviour, routes, API calls and copy that tests assert on are unchanged.
- Consolidated the buildout database history into one `001_initial` schema per
  SQL dialect and one MongoDB initial index setup. Removed legacy backfills and
  upgrade runbooks. Development databases must be recreated after baseline changes.
  Server builds now ship SQL assets beside the compiled runner.
- `POST /api/apis` and `PATCH /api/apis/:id` accept `cors.origins` as an alias
  for `cors.allowed_origins`. Sending both with different values is `400`
  naming both keys. Responses still emit `allowed_origins` only.
- The branding response cache invalidates immediately after local settings writes,
  including reads overlapping those changes, and never caches `bootstrap_required`.
  Its TTL bounds cross-instance server staleness of the remaining fields; changed
  payloads receive a new ETag.
- Every Ferrum Edge admin JWT now carries an `ns` claim naming the configured
  namespace, so a gateway running with `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true`
  accepts Nexus.
- `EDGE_ERROR` responses for a gateway `400`/`409`/`422` include the gateway's
  own validation text in `details.gateway_message` (for example that
  `FERRUM_BASIC_AUTH_HMAC_SECRET` must be set before a `basic_auth` API can be
  published). `401`/`403`/`5xx` stay opaque.
- Rate limits are capped at 1 000 000 requests per window, the ceiling Edge
  enforces, instead of being accepted and then rejected by the gateway.
- Changing SMTP or CAPTCHA settings requires `super_admin`; branding and the
  registration policy stay at `admin`. The settings UI disables those sections
  for other admins.
- `engines.node` is `>=22.14` (SQLite's Node-API 10 binding requires it); the
  Vite dev server binds `127.0.0.1` so the documented URL works everywhere.
- Three wire fields were added, all additive: `Message.broadcast` (true for the
  rows a god-mode broadcast writes), `MassEmailResponse.batch_id` (the
  campaign's idempotency key, generated when the caller supplies none) and
  `GodBroadcastResponse.delivered` / `.failed`.
- One new audit action, `god.broadcast_complete`, records what a broadcast
  achieved. `god.broadcast` now records the _attempt_ — it is written before the
  fan-out, because it is what the daily broadcast ceiling counts.
- The getting-started walkthrough and the compose example work on Linux
  out of the box: the Edge data volume is handed to the image's non-root
  user, `host.docker.internal` is defined for the gateway container, and
  `FERRUM_BASIC_AUTH_HMAC_SECRET` is set. Compose no longer hard-codes the
  Postgres password.

### Performance

- Hot paths that re-parsed, fanned out or over-read (#343).
  `GET /api/catalog/:slug/spec` caches its normalized document in process per
  revision and server address (gateway origin + listen path), bounded at 64
  documents and 32 MiB, after the visibility check; revisions are immutable, so
  a new revision, rollback or origin change is a different key. The route also
  gains a 60/minute per-account rate limit, the only one in the catalog. The
  applications list attaches `active_grants` and `active_credentials` with two
  grouped counts per page (`grants.countByApplications`,
  `credentials.countByApplications`, on every store adapter) instead of three
  queries per row; the response is unchanged. `credentials.listByConsumer`
  takes an optional status filter, and issue, rotate, revoke, reconcile and
  teardown read only a consumer's `active`/`retiring` rows under its lock
  rather than every revoked row rotation has ever left behind. The session
  hook no longer resolves the cookie for requests outside `/api` — the static
  assets and the SPA shell — so a page load's scripts, styles and fonts cost no
  store reads. A god-mode broadcast with email prepares the `mass` template and
  branding once, as mass email does, instead of once per recipient.

### Fixed

- Web mutations with local error handling no longer show a second global toast;
  stale 401 responses recheck the session before signing out, and email
  verification and self-edits refresh the auth store (#346).
- Open catalog APIs (`requestable: false`) now report `access_state: 'open'`
  instead of `'none'`, so the catalog card and detail page show **Open access**
  rather than **No access** (#267).
- Credential rotation copy no longer promises a switch-over window. The
  credentials banner, rotation confirmation, rotation email, and user-facing
  docs state that rotate revokes the previous value as part of the operation
  (#268).

- Specification revisions are ordered by publication sequence rather than by
  their timestamp (#270). `api_specs` gains a per-API `revision_seq` that every
  adapter assigns in the transaction that inserts the row; listings return the
  current revision first and then history newest-first by that sequence, and
  `NEXUS_SPEC_HISTORY_LIMIT` retention deletes from the same order. Previously
  the order was `created_at DESC, id DESC`, so revisions published in the same
  millisecond were ranked by their random UUID — which could list historical
  revisions ahead of the current one and permanently delete newer history in
  place of older. The column is part of the `001_initial` baseline, so
  development databases must be recreated under the buildout schema policy in
  `docs/operations.md`.
- Closed mobile navigation is inert and hidden from assistive technology. Opening
  the drawer moves focus into it; Escape, navigation and backdrop dismissal return
  focus to the toggle. Desktop navigation remains available across viewport changes (#265).
- Informational badges, including API Key and GET method labels, derive readable
  text independently from their brand tint in both themes. Default and custom
  colours reach at least 4.5:1 contrast on the portal's badge surfaces (#269).
- Saved portal branding and the document title apply after an authenticated
  reload without a theme toggle. Session changes preserve and refresh the public
  branding query while still removing account-specific cached data (#271).
- `npm run dev` proxied every path starting with `/api` to the backend —
  including the SPA's own `/apis`, `/apis/new` and `/apis/:id` routes — so a
  reload or deep link on the publishing pages returned the backend's JSON 404
  instead of the page. The proxy now matches `/api` and `/api/...` only.
- Branding colours now drive the whole accent scale. `BrandingStyles` derives
  hover and active shades, a readable button foreground, the soft tint, the
  focus ring and a glow from `primary_color` per theme (and the `info` tokens
  from `accent_color`), instead of writing `--accent` alone and leaving the
  tints on the stylesheet's ember default — which put orange highlights under
  indigo icons on every active navigation item, stat tile and message bubble.
- The portal's configured `default_theme` is honoured until a visitor picks a
  theme; it is cached under `nexus:theme-default` so the pre-paint bootstrap
  script applies it on the next visit too. The portal name sets the document
  title, the logo doubles as the favicon, and a default favicon ships.
- `Select` accepts a width class without fighting its default full width, so
  the users page's role/status/organization filters no longer stack full-width.
- Email templates use `reset_url` and `verification_url` for account action
  links. Retired raw-token placeholders render empty and are rejected on save;
  template update audit events now include SHA-256 hashes of both body fields.
  Action links must be whole anchor destinations or standalone text URLs.
  Save and render checks restrict outbound links to the portal origin and
  operator-approved `NEXUS_EMAIL_TEMPLATE_ALLOWED_LINK_HOSTS`; an unsafe legacy
  template logs a warning and the built-in template is sent in its place.
- Spec revisions register their gateway re-import compensation before issuing
  `PUT /api-specs/{id}`, so a write applied with a lost acknowledgement restores
  the previous document and backend. A failed restore writes the existing
  `api.gateway_repair_required` audit event with `phase: 'compensation'` (#214,
  GHSA-5mfx-x488-p4f9).
- Compensate approvals whose gateway write was not acknowledged and record the
  uncertain outcome in the rollback audit.
- Require the provider role as well as API ownership for access decisions;
  administrators retain oversight after an owner is demoted.

- Catalog specifications and the Documentation tab now show gateway server
  addresses throughout normalized JSON/YAML documents. Provider spec editing
  reads the original upload through an owner/admin-only endpoint.
- Require the environment SMTP connection before clearing a password override,
  and audit SMTP password-source transitions without recording setting values.
- **A test consumer whose creation was applied but never acknowledged was
  orphaned on the gateway.** When Edge stored the `nexus-test-<api_id>` consumer
  and then failed to answer, the caller held no id for it, so the compensation
  skipped its delete and dropped the `gateway_identities` registration anyway —
  leaving a consumer carrying the API's `nexus:api:<id>:approved` group with
  nothing in the portal that could ever find it again. Nexus now names every
  consumer it asks Edge to create, so the id of the create being compensated
  for is known even when no answer came back: the first consumer of a username
  takes an id derived from the namespace and that username, a replacement takes
  a fresh one recorded on the `gateway_identities` row _before_ the `POST`. The
  compensation settles the question with one `GET /consumers/{id}` and deletes
  what it finds — no namespace-wide username scan, and no reuse of the replaced
  consumer's id, which the credential mirror is keyed on. A lookup or delete
  that _fails_ now keeps the registration, which is the only thing that leads
  back to an orphan.
- **Deleting an API left its test consumer, key and ACL group on the gateway.**
  `DELETE /api/apis/:id` tore down the proxy and every portal row but never the
  API's own `nexus-test-<api_id>` identity — and once the API row was gone,
  nothing could look it up by name again, so the leak was permanent. The
  deletion now runs the same teardown the account-disable path uses, between the
  proxy delete and the row delete, revoking the credential mirror and consuming
  the registration. A consumer that is already gone is not an error; a gateway
  failure answers `502 EDGE_ERROR` and leaves the API in the catalog to be
  deleted again rather than reporting success over a stranded identity. The
  `api.delete` audit row gains `test_consumer_id` and
  `test_consumer_revoked_credentials` when there was one to collect.
- **A failed recovery-link mint spent the throttle window and leaked account
  existence.** `POST /api/auth/forgot-password` and
  `POST /api/auth/resend-verification` committed the issue claim before, and
  outside, the transaction that minted the token, so a transient store failure
  burned the recipient's ten-minute window on nothing: the retry took the
  throttle's early return, answered the uniform `200`, and sent no link.
  Meanwhile the escaping `500` was an existence oracle — only an address with an
  account reaches the mint, so a partially failing store answered `500` for a
  real address and `200` for an unknown one. The claim is now the first write of
  the minting transaction, so it rolls back with a failed mint, and both
  endpoints answer the documented `200 { "ok": true }` whatever happens, logging
  the fault at `warn` instead.
- **Five documented workflow steps the browser could not complete.** The
  mass-email and god-mode broadcast composers emitted one audience shape
  (`{ scope: 'filtered', roles: [oneRole], status: 'active' }`), so the
  "Administrator" audience sent `roles: ['admin']` and silently skipped every
  `super_admin`, and the guide's mandatory pre-send test — an explicit audience
  of one, addressed to yourself — could not be composed. Both composers now
  offer the audience model the server has always accepted: multi-select roles
  with an **All administrative roles** shortcut, a status choice, an
  organization filter, and a named recipient list with **Add myself**.
  Alongside it: `GET /api/branding` now carries the public registration policy
  so the sign-up form offers only roles the server accepts and the Settings card
  edits the stored value instead of advertising a constant; the admin user
  directory gained an organization column, organization and status filters, and
  a row editor for `org_id` and `display_name`; providers can start a
  conversation with a named requester or grantee from the Requests and Grants
  tabs; and the portal-wide API list opens the management workspace, with the
  same **Manage API** link on the catalog page for administrators, so an admin
  can act on somebody else's API without god mode.
- CORS preflights now include authentication and custom request headers and
  follow the API's method list. Auth/method changes reconcile the plugin while
  retaining operator settings and extra headers (#149).
- WebSocket origin enforcement is explicit via `cors.enforce_websocket_origins`
  (default false), allowing origin-less clients unless providers opt into the
  browser-only CSWSH gate. Existing proxies change when CORS is saved (#151).
- Compression and request deduplication receive compatible default priorities;
  operator overrides are preserved and incompatible orders get a clear 400.
  Response caching is removed from the offered palette because its default
  template cannot enable authenticated storage without backend shared-cache
  opt-in; existing installations remain removable (#170).

- **A god-mode broadcast no longer spends the broadcasting admin's own message
  budget, and is no longer exempt from every bound.** It writes one `messages`
  row per recipient with the acting super admin as the sender, and the rolling
  daily budget counted exactly those rows against them: one announcement to a
  portal larger than the budget refused every ordinary message that
  administrator sent for the next 24 hours — including the support follow-up an
  incident broadcast generates — while further broadcasts, which were never
  budget-checked at all, stayed available. Broadcast rows now carry a
  `broadcast` flag the budget query skips, and the broadcast path carries two
  explicit ceilings of its own, both enforced before the first row is written:
  `NEXUS_MAX_BROADCAST_RECIPIENTS` (default 5 000) and
  `NEXUS_MAX_BROADCASTS_PER_DAY` (default 20). The daily ceiling counts
  `god.broadcast` audit rows, so that row is now written **before** the first
  recipient is touched: an announcement that reached the whole portal and then
  failed to record itself used to be uncharged, absent from the trail, and
  answered with a `500` whose retry announced everything twice. What the attempt
  achieved — `delivered` and `failed`, counted per recipient rather than assumed
  from the audience size — is a second row, `god.broadcast_complete`, and the
  same two numbers are on `GodBroadcastResponse`. An audience that matches
  nobody is refused rather than spending a daily slot on a no-op.
- **The daily message budget is now exact across instances**, and
  `docs/operations.md` no longer claims that counting durable rows made it so.
  The count and the insert were separate statements on separate connections, so
  two instances at quota − 1 both committed; what ordered them on a single
  instance was the store's in-process transaction queue, which is why the
  single-process regression tests could not fail. The whole count-and-insert
  now runs inside a per-sender lease in `edge_leases`, exercised by a
  cross-adapter contract that builds its second instance over a **second store
  object** against the same database — two pools, two transaction queues — so
  the case genuinely fails without the lease. A sender whose lease is held
  elsewhere past the wait gets `409 CONFLICT`, on the broadcast path too.
- **Messaging records its audit row inside the transaction that writes the
  message.** A failed audit write used to return `500` for a message that was
  durably stored and visible to both participants, with no `message.send` row —
  and the sender's natural retry stored a second copy. Thread creation and
  replies now commit their rows and their records together.
- **A mass-email fan-out that fails partway now queues nothing, and a retry is
  safe.** Each recipient's row used to commit on its own with the
  `admin.mass_email` row written after the loop, so a failure delivered to part
  of the audience, recorded nothing, and answered with a bare `500`; because the
  batch id was generated inside the call and never surfaced, the retry minted a
  new one and mailed those recipients again. Every outbox row and the audit row
  now commit in one transaction, and `POST /api/admin/mass-email` returns
  `batch_id` on success and carries it in the failure body
  (`500 OUTBOX_FAILURE`, `details: { batch_id, recipients, enqueued }`) so the
  retry can reuse the key either way. Database contention keeps its own code —
  `409 CONFLICT` with the batch id — rather than being reported as a broken
  outbox. Because the fan-out is now one transaction, the audience has a ceiling
  to match the broadcast path's: `NEXUS_MAX_MASS_EMAIL_RECIPIENTS` (default
  5 000, `0` disables), enforced before anything is rendered or written. On
  MongoDB the 16 MB per-transaction cap is a hard wall at roughly 800 recipients
  with a 10 KB body; on the SQL adapters an unbounded fan-out is an unbounded
  stall for every other write on the instance, since transaction bodies are
  serialised per store object.
- **A palette save deleted an operator's hand-made plugin config of the same
  name.** Ownership was inferred from the plugin name, so every other config
  of that name on the proxy looked like a leftover duplicate and was removed —
  including a per-path deny gate Nexus never created. `api_plugins` now records
  the Edge config id it produced (`ferrum_plugin_config_id`) and
  saves, removals and reconciliation act on that config alone. A row without
  a recorded id creates a fresh config on save and leaves existing configs alone. The `api.plugin_set` and `api.plugin_remove` audit rows name
  the config id they touched.
- **An ordinary portal save reset an operator's `priority_override`.** The body
  sent to `PUT /plugins/config/{id}` was built from scratch, and that endpoint
  is a whole-resource replace, so a field the portal has no control for was
  cleared on every palette save and every `cors`/`rate_limit` reconcile. Write
  bodies are now merged over the live resource, so every field the portal does
  not own survives — including any Edge adds later.
- **An unrelated API save rewrote the `cors` and `rate_limit` gateway
  configs.** Both were reconciled on presence rather than on change, so a
  description fix rebuilt them from the portal's two-field view — discarding an
  operator's `allowed_headers`, `max_age` or a `sync_mode: redis` that made the
  quota cluster-wide, re-enabling a config they had switched off, and naming two
  unchanged fields in the audit row. They are now compared against the stored
  value first, and a genuine change merges over the live config instead of
  replacing it. A replay still repairs a dropped plugin association.
- SPA validation failures now show the server message in an accessible error
  toast, with inline errors on profile and gateway settings forms. Public auth
  forms retain their inline-only error handling (#175).
- Session refresh returning 401 now clears the query cache through the shared
  sign-out path. Signing in after sign-out also clears cached data before
  accepting the next principal (#177).
- Upgrade better-sqlite3 to 13.0.3 to replace the native cleanup path that
  aborts on Node 24.20.0. Raise the Node minimum from 22.12 to 22.14 and
  retain hosted checks on the minimum and current Node 22/24 releases.
- **Published APIs were unprotected on a live gateway.** Nexus created the
  auth, access-control and rate-limit plugin configs but never listed them in
  the proxy's `plugins[]`, which is what Ferrum Edge actually enforces; every
  published API answered unauthenticated requests. Plugin configs are now
  associated on publish and on every later change, and proxy writes are
  read-modify-write so operator-set fields (hosts, timeouts, TLS,
  `upstream_id`) and the associations survive an upstream move.
- `GET /plugins/config` is paged; a namespace with more than 1000 plugin
  configs could previously hide an API's own plugins from edits and cleanup.
- Sliding sessions re-issue the session cookies, so the browser's cookie
  lifetime tracks the server's instead of expiring at the original login
  wall-clock.
- God-mode disable of the acting last `super_admin` reports
  `LAST_SUPER_ADMIN` rather than `CONFLICT`.
- `GET /api/health` documented a gateway version it can never observe.

- **`npm run rotate-secret-key`** re-encrypts the encrypted `app_settings`
  rows from `NEXUS_SECRET_KEY_PREVIOUS` to the new `NEXUS_SECRET_KEY` in one
  transaction, so rotating the master key no longer leaves the SMTP password
  unreadable or locks every admin out of a CAPTCHA-enabled portal; the runbook
  in `docs/operations.md` §7 is rewritten around it.
- **The server and `npm run migrate` read the root `.env`** the quickstart
  tells you to create (working directory or its parent; exported variables
  win; images with no file are unaffected). A clean checkout previously failed
  with "NEXUS_SECRET_KEY is required".
- **The Compose example builds from the repository root** it is copied to;
  its previous `context: ..` pointed at the parent directory.

- **Disabling an account now tears down every gateway identity it holds**,
  including provider test consumers (`nexus-test-<apiId>`), whose key and
  approval group previously stayed live behind a `gateway_teardown: "ok"`.
- **A credential mutation re-checks the owner inside the consumer lock**, so
  an issue, rotation, test-consumer issuance or approval that was in flight
  when the account was disabled is refused (or removed by the teardown that
  follows it) instead of minting a live key for a disabled account.
- **Rotation at the per-type cap can no longer leave the portal disagreeing
  with the gateway.** The retired row is revoked the moment Edge confirms the
  delete; a failed append answers `502` saying the previous credential was
  removed and a new one must be issued, and a failed metadata insert deletes
  the key it just appended. `docs/operations.md` gains the reconciliation
  procedure the mismatch error now points at.
- **An admin-rotated credential keeps its owner.** The replacement used to be
  assigned to the administrator, so the client could neither see nor revoke
  it; the admin is now the audit actor only.

- **The catalog pages the whole filtered set.** The viewer rule (owned,
  granted, or published-and-public) is now part of the store query, so a
  public API older than 200 internal ones is no longer invisible and `total`
  is exact. `MAX_PAGE_SIZE` is unchanged.
- **Conversations page from the newest end.** `GET /api/threads/:id` and the
  new `GET /api/threads/:id/messages` take `limit` and `before` and answer a
  `MessagePage` (`items`, `total`, `has_more`, `next_before`); the thread page
  opens on the latest window with "Load older messages", so reply 201 no
  longer vanishes. The admin inbox predicate (platform thread or admin
  participates) moved into the store query as well.

- **A `routes` spec revision holds the proxy lease.** The fresh read, the
  `PUT /api-specs/{id}` replace, the store write and the compensation run
  under `proxy:<id>`, so a concurrent runtime PATCH (methods, timeouts,
  backend, WebSocket origins) is no longer overwritten by the importer's
  re-insert; the publish cutover takes the same key.
- **A failed enforcement conversion restores the original proxy.** On any
  rebuild failure the half-built replacement is removed and the captured
  proxy, its hand-owned plugins and the original mode are rebuilt through the
  staging path before the error is returned; if that restoration fails too,
  an `api.gateway_repair_required` audit row carries the snapshot an admin
  needs. Previously the live proxy was deleted and a retry answered 404.
- **Spec revision history is bounded.** `NEXUS_SPEC_HISTORY_LIMIT` (default 10) keeps the newest historical revisions per API, pruned inside the
  transaction that makes a revision current, so the per-owner storage bound
  is now `MAX_SPEC_BYTES × (limit + 1) × NEXUS_MAX_APIS_PER_OWNER`.
- **Spec following compares the whole upstream.** An API follows its document
  while its stored `upstream_url` equals the previous revision's normalised
  `servers[0]`, and then moves on any scheme, host, port or base-path change;
  a same-host pin with a different path is left alone. Base-path-only changes
  previously reported success while the gateway kept the old path.

- **Workers recover abandoned claims on every tick**, not only at start, and
  claim one row at a time with a per-row budget (60 s; SMTP timeouts are now
  pinned so a hung send cannot outlive the 5-minute stale threshold). A crash
  followed by a quick restart no longer strands gateway teardowns or
  transactional mail, and a store failure mid-batch leaves the rest workable.
- **The last-super-admin rule holds across instances.** Every transition that
  can shrink the active super-admin set (demotion, disable, god-mode disable)
  runs under a store-level lease (`users:super-admins`) taken outside the
  transaction, so two instances can no longer each demote the other.
- **SQLite no longer mistakes an unrelated caller for a nested transaction.**
  Nesting is tracked with `AsyncLocalStorage`; an independent transaction
  started while another body is awaiting queues behind it instead of joining
  it and losing its writes to the other's rollback. The remaining hazard, a
  bare root-store write issued while a body is open, is documented on the
  store contract.
- **A transaction rolled back for contention is retried instead of losing its
  work.** MongoDB drives transactions through the driver's
  `session.withTransaction()`, backing off between runs and giving up after 5
  seconds of contention (inside a 15-second cap on the transaction as a whole),
  and the PostgreSQL and MySQL adapters re-run a body the engine rolled back
  with a serialization failure or an InnoDB deadlock over up to 5 attempts,
  backing off with jitter. A write conflict or a deadlock used to surface as
  `500` with a raw driver error and the body's writes silently gone; contention
  that outlives the budget is now `409 CONFLICT` with
  `details.reason = "transaction_contention"`, and no driver error type reaches
  a response. Transaction bodies are re-runnable by contract —
  `{ retry: false }` opts one out.
- **Two people replying to one thread at the same moment no longer deadlock on
  MySQL.** A send now takes the thread row before inserting the message that
  references it, so the foreign key's shared lock and the `last_message_at`
  update cannot form a cycle; one of the two replies used to be rolled back as
  the deadlock victim and lost behind a `500`.
- **Changing an API's `auth_plugin` no longer cuts clients off in silence.**
  Edge runs one authentication plugin per proxy, so swapping `key_auth` for
  `basic_auth` on a published API turned every issued key into a `401` the
  instant it landed, while `PATCH /api/apis/:id` answered `200` and the
  credentials page went on offering the dead keys (#234). Such a change is now
  refused with `409 ACCESS_DISRUPTION_CONFIRMATION_REQUIRED` — nothing written
  on either side — and `details` says which credential flavour breaks and how
  many accounts holding access are carrying one. Re-sending with
  `"confirm_access_disruption": true` carries the change out and notifies every
  grantee to issue a credential of the new flavour. **No grantee credential is
  revoked**: a credential belongs to its holder's consumer, not to one API, and
  it goes on serving every other API of that flavour — what a grantee loses is
  this API, until they re-issue. The API's own `nexus-test-<api_id>`
  credentials, which can no longer authenticate anything, are revoked with the
  change, each with its own `credential.revoke` row and one
  `api.auth_plugin_changed` summary. Those revocations run last, after the swap
  is durable, so a swap the gateway refuses leaves every credential exactly as
  it was. The settings form warns and carries the acknowledgement.
- **Credential and access concurrency and ownership gaps (#341).**
  - Deleting an application runs under the identity's provisioning name key,
    the one a first credential or approval provisions its Ferrum consumer
    under, and `ensureConsumer` re-reads the application (existence, owner,
    `active`) inside that key. A delete racing a first issue can no longer
    leave a live `nexus-app-<id>` consumer — with a working key on it — that
    nothing in the portal tracks, on SQL (where the mapping insert failed the
    foreign key after the consumer was created) or MongoDB (where the mapping
    was written for a deleted application). With no mapping, the delete looks
    for the consumer at the derived id and removes it only when it still
    carries the application's username; `application.delete` then records
    `unmapped_consumer: true`.
  - Issuing a credential re-checks the application inside the consumer key, as
    rotation already did: an application disabled or deleted after the route
    resolved it gets `409` / `404`, never a new secret.
  - The god-mode grant sweep (`revoke_grants: true`) no longer swallows gateway
    failures. A grant whose ACL removal fails stays `revoked` instead of being
    put back to `active` — which let a later re-enable restore the access the
    super admin removed — its `access.revoke` row carries
    `acl_group_removed: false` and `cause`, and the disable answers with the
    error (`502 EDGE_ERROR`, `details.failed_grants`) after both audit rows
    record `failed_steps: ["revoke_grants"]`, `failed_grant_revocations` and
    `failed_grants`. The account teardown that follows strips the group; if it
    fails too, it stays queued. A store failure while finding the consumer is
    reported as stage `lookup` (`500 INTERNAL`), not as a gateway failure, and
    a consumer already gone from the gateway counts as its group removed. The
    sweep also moves each originating request to `revoked`, as a targeted
    revocation does.
  - Re-enabling an account rebuilds each identity's `nexus:api:<id>:approved`
    groups from its active grants alone instead of merging them into the live
    list. A re-enable cancels a queued teardown, so a sweep whose ACL removal
    failed, followed by a teardown that failed as well, used to leave a
    revoked grant's group live on the gateway — access the portal showed as
    revoked, that no provider could revoke again. Groups outside that
    namespace, which the portal did not create, are kept.
  - `POST /api/admin/credentials/reconcile` only acts on a consumer the portal
    owns — a recorded mapping whose username still matches the live consumer,
    a registered gateway identity bound to it, or portal credential rows
    against it whose live username is still the one Nexus derives for their
    owner — and answers `403 FORBIDDEN` before any gateway write for anything
    else, such as a consumer an operator created by hand. A `consumer_id` that
    is not consumer-id shaped is `400 VALIDATION_FAILED` before a lease is
    taken on it.
  - Revoking a grant holds the API's `proxy:<id>` lease, the one approval holds,
    from its claim through the ACL removal and the grantee's notice, so a
    re-request approved while a revocation is in flight can no longer have its
    new group stripped by the older revocation, nor be announced before it.
  - An approval writes its grant inside the consumer key, straight after the
    ACL group lands, and re-checks the application there. An application
    delete between the two could leave, on MongoDB, an active grant for an
    application that no longer existed.
- **Store adapter parity for the case-insensitive matching and retry edges**
  (#345). SQLite's built-in `lower()` folds ASCII only — unlike PostgreSQL,
  MySQL and the JS `toLowerCase()` the search term uses — so the adapter now
  registers a deterministic Unicode `lower` in `openSqliteDatabase`; the
  `ux_organizations_name` and `ux_applications_owner_name` unique indexes now
  refuse "Übersicht" alongside "übersicht" and search finds non-ASCII fold
  matches (an existing file database must be recreated, or those `lower(...)`
  indexes `REINDEX`ed, under the disposable buildout policy). MongoDB filters
  now `AND` a singular and its plural (`role`/`roles`, `api_id`/`api_ids`,
  `action`/`actions`) instead of overwriting one with the other, and
  `notifications.createMany` / `settings.setMany` run in a session transaction
  so a failing batch rolls back the entries before it, matching SQL. A MySQL
  `ER_LOCK_WAIT_TIMEOUT` is no longer retried — the server already waited out
  `innodb_lock_wait_timeout` — so one request can no longer stall ~250 s, and a
  MongoDB `UnknownTransactionCommitResult` no longer surfaces a `CONFLICT`
  claiming "Nothing was saved"; it reports the commit outcome as unknown.
- **The private-upstream check unwraps IPv6 transition addresses** (#344).
  It read only the leading hextet of an IPv6 address, so a NAT64
  (`64:ff9b::a00:1`, i.e. `10.0.0.1`), 6to4 (`2002::/16`) or site-local
  (`fec0::/10`) literal or AAAA answer passed as public — on a DNS64/NAT64
  network an AAAA-only name could reach RFC 1918 space through the translator.
  IPv4-mapped, NAT64 well-known-prefix and 6to4 addresses are now judged as the
  IPv4 address they carry; `fec0::/10`, the rest of `::/16` (including
  IPv4-compatible `::a.b.c.d`) and the rest of `64:ff9b::/32` (including
  local-use `64:ff9b:1::/48`) are refused. An IPv4-mapped _literal_ upstream is
  now judged the same way as an IPv4-mapped DNS answer already was, so
  `::ffff:93.184.216.34` is accepted rather than refused.
- **Authorizing a private API's viewer no longer reveals administrators**
  (#344). An administrator's address answered `409 CONFLICT` with
  "Administrators can already read every API", which told any provider which
  addresses hold the admin role. It now gets the same `400 VALIDATION_FAILED`
  an unknown address gets, and nothing is written.
- **Registration hashes the password before refusing a taken address** (#344),
  so the `409 CONFLICT` for a duplicate costs what a registration costs instead
  of returning an order of magnitude sooner. That registration reveals whether
  an address is taken remains an accepted, documented risk (`docs/security.md`).
- **`NEXUS_TRUSTED_PROXIES` entries are parsed as real addresses** (#348). A
  character-class check accepted `deadbeef`, `::::` and `10.0.0.1/999`, which
  Fastify then refused while constructing the server — so a typo passed
  configuration and crashed startup. Each entry must now be an IPv4 or IPv6
  address with an optional prefix of 1–32 or 1–128, anything else is a
  configuration error naming the variable, and the `loopback` / `linklocal` /
  `uniquelocal` keywords are lower-cased before they reach Fastify, which
  matches them case-sensitively.

- A password-reset or verification-resend delivery that failed no longer
  spends the recipient's 10-minute throttle window (#342). The message is now
  rendered before the throttle claim and queued through the minting
  transaction, so a template that cannot be rendered claims nothing and an
  outbox insert that fails rolls back the claim, the token and the audit row
  with it. Both endpoints still answer the uniform `200 { "ok": true }`, and
  the next request issues the link.
- The gateway repair no longer clears the proxy reference of an API a restore
  has just rebuilt (#342). `POST /api/admin/gateway/repair` now flags an
  orphaned proxy under the same per-API lock `restore-gateway` holds, asks the
  gateway again before clearing anything, and writes the cleared reference and
  its `api.gateway_repair_required` row in one transaction. An API whose proxy
  is live again is reported with `flagged: false` and left deployed, instead of
  being marked `repair_required` with its live proxy still holding the listen
  path and the next restore answering `409`.

### Security

The rewrite was reviewed twice — once by an adversarial pass over the whole
codebase, once independently — and every finding below was proven with a
working exploit before being fixed, and is covered by a regression test that
fails without the fix.

- **CI actions are pinned to commit SHAs** (#351). `actions/checkout`,
  `actions/setup-node` and `actions/upload-artifact` ran from movable `v4` tags
  that could be repointed without a reviewed Nexus commit. They are now pinned
  to the commits those tags resolve to, an `action-pins` CI job rejects any
  tag-referenced action, and Dependabot proposes grouped action bumps.
- **A published OpenAPI document can no longer freeze a reader's browser.**
  The catalog viewer parses documents that open with `{` or `[` as JSON — the
  YAML parser accepts JSON but its cost grows quadratically with the width of a
  mapping, which stalled the tab for seconds before drawing anything. Rendering
  now spends a single node allowance across the whole page, divided between the
  operations the reader has expanded, instead of a fresh one per schema; a
  branch that exhausts it shows one "truncated" notice and its siblings are not
  mounted. Publishing additionally refuses a document that declares more than
  100,000 schema nodes, parameters and media types together
  (`SPEC_INVALID`, `details.reason = "too_much_to_render"`) — bytes, paths and
  operations bound none of what a reader actually pays for.
- **Bootstrap election is atomic.** Concurrent registrations against an empty
  portal could _all_ become `super_admin`; the first-user promotion is now a
  single claim on a unique key.
- **`X-Forwarded-For` is only trusted from configured proxies**
  (`NEXUS_TRUSTED_PROXIES`, unset by default). Previously any client could
  forge `request.ip`, bypassing the login rate limit entirely and writing
  false addresses into the audit trail. Cookie `Secure` and HSTS moved to
  their own `NEXUS_COOKIE_SECURE` flag rather than riding on proxy trust.
- **Disabling an account now removes its gateway identity** — ACL groups and
  every credential type — not just its portal sessions. A disabled user's API
  key previously kept working against any API without an access-control
  plugin.
- **State transitions are compare-and-set.** Access decisions, grant
  revocations, role and status changes, and verification-token burns can no
  longer be won twice: a cancel racing an approve could leave working gateway
  access behind cancelled history, and concurrent demotions could empty the
  `super_admin` role entirely.
- **Gateway and portal state cannot silently diverge.** Auth-plugin changes
  attach the replacement before removing the incumbent (a failed swap used to
  leave a live proxy with _no_ authentication), and publish, spec update,
  approval and revocation all unwind their gateway writes when a later step
  fails.
- **Credential rotation re-reads its target inside the per-consumer queue**,
  so a raced rotation can no longer delete every credential of a type and
  hand back a secret that never worked.
- **Thread access follows the caller's current role**, not the immutable
  thread creator, so a demoted admin loses access to broadcast threads.
- **Attacker-authored OpenAPI documents are bounded** by size, path count and
  operation count, and the renderer bounds both schema nodes and mounted
  operation cards. A ~5 KB spec could previously freeze the browser of
  everyone who opened that catalog entry.
- **Password changes end every other session**, and the public health
  endpoint no longer discloses database or gateway internals to anonymous
  callers.
- **The founding registration needs a bootstrap token.** While the portal
  has no accounts, `POST /api/auth/register` refuses everything that does not
  carry `bootstrap_token`: `NEXUS_BOOTSTRAP_TOKEN`, or the per-process value
  the server prints at startup. A fresh deployment reachable before its
  operator registered used to hand `super_admin` to whoever connected first.
  `GET /api/branding` reports `bootstrap_required` so the sign-up form asks
  for it, and the single-container quickstarts now publish on loopback.
- **Upstream hostnames are resolved before they are accepted.** With
  `NEXUS_ALLOW_PRIVATE_UPSTREAMS=false` the private-upstream guard used to
  judge only IP literals and a short suffix list, so `127.0.0.1.nip.io` or
  any attacker-controlled record turned the gateway into an internal SSRF
  path. Every publish, upstream change and spec-following move now resolves
  A and AAAA and refuses a name if any answer is non-public or the lookup
  fails (`details.reason = unresolvable_upstream`). Names re-pointed after
  publish are screened by Edge's own `FERRUM_BACKEND_ALLOW_IPS=public`.
- **Health probes are cached and rate limited.** `GET /api/health` and
  `GET /api/health/edge` reuse one database probe and one gateway probe per
  `NEXUS_HEALTH_CACHE_MS` (default 5 s) with concurrent callers coalesced,
  and sit behind a 120 req/min per-IP limiter, so anonymous traffic can no
  longer be amplified into unbounded Admin API and database work.
- **Gateway revocation on account disable is durable.** Disabling an
  account enqueues a `gateway_teardown_jobs` row in the same transaction as
  the status change; a worker retries the Edge teardown with backoff until it
  succeeds, the disable response reports `gateway_teardown: "pending"`
  instead of a swallowed `failed`, admins see the pending state and can
  retry (`POST /api/users/:id/gateway-teardown/retry`), and re-enabling
  cancels the job. A disabled user's API key used to stay valid for good
  whenever the Admin API was unreachable at the moment of disable.
- **A new proxy is never reachable before its security plugins are on it.**
  Publishing (and a `docs_only` ↔ `routes` conversion) creates the proxy on an
  unguessable staging listen path (`/<namespace>/.staging/<random>`), attaches
  and associates the auth, ACL, rate-limit and CORS configs there, and moves
  it to `/<namespace>/<slug>` as the last gateway write — a whole-resource
  `PUT /proxies/{id}` for a hand-owned proxy, `PUT /api-specs/{id}` for a
  spec-owned one. Until now the real path was live, unauthenticated and
  unlimited for the round trips between proxy creation and the association.
- **Publishing is bounded per account.** `NEXUS_MAX_APIS_PER_OWNER`
  (default 50, `0` = unlimited) caps how many APIs one account may own,
  refused with `429 QUOTA_EXCEEDED` before the first gateway call; the
  mutating `/api/apis/*` routes carry a 30 req/min per-account limiter. An
  open-registration provider could previously create proxies, plugin
  configs, slugs and 2 MiB documents without limit.
- **Messaging is bounded per account.** `POST /api/threads` and
  `POST /api/threads/:id/messages` carry per-account limiters (10 and 30 per
  minute), a rolling 24-hour budget (`NEXUS_MAX_MESSAGES_PER_USER_PER_DAY`,
  default 200, refused with `429 QUOTA_EXCEEDED` before any row is written),
  and the `message_received` email is coalesced to one per recipient per
  thread per 10 minutes through the outbox idempotency key — the default
  template now announces activity instead of quoting a message. One
  self-registered account could previously mail-bomb every administrator
  and grow the message, audit, notification and outbox tables without limit.
  The initial schema includes the sender index the budget check runs on.
- **Gateway writes are exclusive across Nexus instances.** Every consumer
  and proxy read-modify-write now holds a database lease (`edge_leases`,
  60 s TTL, renewed while held, up to 30 s wait, then
  `409 CONFLICT`) in addition to the in-process queue, so two instances over
  one database can no longer restore a revoked ACL group or drop a proxy's
  auth association by overwriting each other's whole-resource `PUT`. The
  single-writer topology in the operations guide is no longer required;
  proxy delete-and-recreate paths remain outside the lease and say so.
- **The environment SMTP password is never sent to another relay** (#342).
  A stored `smtp.password` that no longer decrypts — `NEXUS_SECRET_KEY`
  swapped without `rotate-secret-key` — used to read as absent, so the email
  service fell back to `NEXUS_SMTP_PASSWORD` and presented it to the _stored_
  host under the _stored_ username. An unreadable override now fails closed
  (no password is sent, and a `warn` line without any secret says so), and the
  environment password is used only while the effective host, port, TLS mode
  and username are the environment's own. `smtp.password_set` now reports
  whether a password would actually be presented.
