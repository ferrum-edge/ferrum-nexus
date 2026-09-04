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
- Exact CORS origins are mirrored onto the proxy's `allowed_ws_origins`, so
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
- `engines.node` is `>=22.12` (two dependencies already required it); the
  Vite dev server binds `127.0.0.1` so the documented URL works everywhere.
- The getting-started walkthrough and the compose example work on Linux
  out of the box: the Edge data volume is handed to the image's non-root
  user, `host.docker.internal` is defined for the gateway container, and
  `FERRUM_BASIC_AUTH_HMAC_SECRET` is set. Compose no longer hard-codes the
  Postgres password.

### Fixed

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

### Security

The rewrite was reviewed twice — once by an adversarial pass over the whole
codebase, once independently — and every finding below was proven with a
working exploit before being fixed, and is covered by a regression test that
fails without the fix.

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
