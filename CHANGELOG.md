# Changelog

All notable changes to Ferrum Nexus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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

### Changed

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

### Fixed

- Email templates use `reset_url` and `verification_url` for account action
  links. Retired raw-token placeholders render empty and are rejected on save;
  template update audit events now include SHA-256 hashes of both body fields.
  Action links must be whole anchor destinations or standalone text URLs.
  Save and render checks restrict outbound links to the portal origin and
  operator-approved `NEXUS_EMAIL_TEMPLATE_ALLOWED_LINK_HOSTS`; an unsafe legacy
  template logs a warning and the built-in template is sent in its place.
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
  the Edge config id it produced (migration `015_api_plugin_config_id`) and
  saves, removals and reconciliation act on that config alone; a row written
  before the column adopts a single name match on its next save and never
  deletes the rest. The `api.plugin_set` and `api.plugin_remove` audit rows name
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

### Security

The rewrite was reviewed twice — once by an adversarial pass over the whole
codebase, once independently — and every finding below was proven with a
working exploit before being fixed, and is covered by a regression test that
fails without the fix.

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
  Migration `010_message_sender_index` adds the index the budget check runs on.
- **Gateway writes are exclusive across Nexus instances.** Every consumer
  and proxy read-modify-write now holds a database lease (`edge_leases`,
  migration `009`, 60 s TTL, renewed while held, up to 30 s wait, then
  `409 CONFLICT`) in addition to the in-process queue, so two instances over
  one database can no longer restore a revoked ACL group or drop a proxy's
  auth association by overwriting each other's whole-resource `PUT`. The
  single-writer topology in the operations guide is no longer required;
  proxy delete-and-recreate paths remain outside the lease and say so.
