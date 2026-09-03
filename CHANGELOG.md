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
- **Routes-only OpenAPI enforcement** (`spec_enforcement: "routes"`): an Edge
  `openapi_validator` generated from the current document rejects paths and
  methods it does not declare, and is regenerated on every spec update.
  Request and response bodies are not validated; `docs_only` stays the
  default.
- `FERRUM_RATE_LIMIT_SYNC_MODE=redis` (+ `FERRUM_RATE_LIMIT_REDIS_URL`,
  `FERRUM_RATE_LIMIT_REDIS_TLS`) stamps Redis counter sync onto every rate
  limit Nexus writes; the operations guide warns that quotas are otherwise
  enforced per gateway process.
- Exact CORS origins are mirrored onto the proxy's `allowed_ws_origins`, so
  a browser cannot open a cross-site WebSocket to an API whose CORS policy
  would refuse it.

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
