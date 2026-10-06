# Architecture

Ferrum Nexus is a Backend-for-Frontend (BFF) in front of a
[Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge) gateway. Edge owns
runtime gateway state: proxies, upstreams, plugins, consumers and credentials.
Nexus owns what a portal needs and a gateway does not: accounts, roles, the
approval workflow, audit history, branding, messaging, notifications and the
API catalog.

This document is for engineers changing the code. It covers the boundaries,
the composition pattern, the persistence contract, and the Ferrum Edge
behaviours that shaped the design.

- REST reference: [`api.md`](api.md)
- Deployment and operations: [`operations.md`](operations.md)
- Threat model and audit catalog: [`security.md`](security.md)
- Contributor workflow: [`contributing.md`](contributing.md)
- Edge response validation: [`edge-response-contracts.md`](edge-response-contracts.md)

---

## 1. Trust boundaries

```
Browser  (untrusted)
  |
  | HTTPS (same-origin), session cookie + X-Nexus-CSRF
  v
Ferrum Nexus SPA (web/)            served as static assets by the BFF in production
  |
  | fetch('/api/...', credentials: 'include')
  v
Ferrum Nexus BFF (server/)  -->  SMTP / Email provider     (via email_outbox)
  |   RBAC + CSRF + audit    \-> Nexus DB (PG / MySQL / SQLite / Mongo)
  |
  +--> Ferrum Edge Admin API (server-side only, short-lived HS256 admin JWT)
```

Every change must keep three rules true:

1. **The browser never holds a gateway credential.** It has a Nexus session
   cookie. Only the server process calls the Admin API, with a JWT the browser
   cannot see or influence.
2. **Every gateway mutation is authorised and recorded.** Session resolved →
   CSRF checked → route role guard → service ownership check → Edge call →
   `audit_logs` row. Skipping a step is a bug. `AUDIT_COMMIT_CLASSES` in
   `audit/service.ts` classifies how each action's row commits: in the store
   transaction that records the change, as an intent row before gateway work
   that cannot be undone, or after commit.
3. **Upstream text reaches the browser only when Edge is judging the caller's
   own input.** `ferrum-admin/client.ts` logs every Edge error body except for
   non-GET `/consumers` writes, which can carry show-once credential material
   and therefore log only method, path and status. A validation refusal (`400`,
   `409`, `422`) is echoed in `details.gateway_message`; an API-spec
   parse/validation failure becomes `EDGE_REJECTED_SPEC` with a bounded summary.
   `401`, `403` and `5xx` are never echoed. `classify()` is the only place this
   is decided.

The public reads are `GET /api/health`, `GET /api/health/edge`,
`GET /api/auth/captcha` and `GET /api/branding`. Branding lets the login page
render the right name, logo and colours before a session exists. It carries the
CAPTCHA _site_ key (never the secret) and the public part of the registration
policy (whether sign-up is open and which roles it offers).

---

## 2. Workspace and module map

npm workspaces, in build order. `shared/` points `main`/`types` at `dist/`, so
it must be built before anything else typechecks.

```
shared/    zero-dependency TypeScript: roles, error codes, wire entities,
           request/response DTOs, naming helpers (ACL groups, consumer
           usernames, listen paths), plugin descriptors. Imported by both
           server and web, which keeps the contract from drifting.
server/    Fastify 5 BFF.
web/       React 19 SPA (Vite, TanStack Router/Query/Table, Radix, Tailwind v4).
e2e/       Playwright and data-plane tests against a real gateway (not a workspace).
docker/    Dockerfile + docker-compose.example.yml
```

### `server/src`

| Path                                           | Responsibility                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                     | Composition root: `buildServer(config, deps)` + `main()`. No business logic.                                                                                           |
| `config/index.ts`                              | The **only** reader of `process.env`. zod-validated into `NexusConfig`.                                                                                                |
| `lib/`                                         | `crypto.ts`, `errors.ts` (`NexusError`), `keyed-serializer.ts` + `lease-fence.ts` (§5.2), `ids.ts`, `logger.ts`.                                                       |
| `db/store.ts`                                  | The `NexusStore` interface: 29 repositories plus `init`/`migrate`/`close`/`healthCheck`/`transaction`.                                                                 |
| `db/adapters/{sqlite,postgres,mysql,mongodb}/` | The four implementations.                                                                                                                                              |
| `db/adapters/sql-common.ts`, `sql-repos.ts`    | Dialect shims and the repository bodies shared by PostgreSQL and MySQL.                                                                                                |
| `db/migrations/`                               | SQL migrations per dialect: `.sql` (SQLite), `.pg.sql`, `.mysql.sql`. MongoDB declares its indexes in code.                                                            |
| `ferrum-admin/`                                | The **only** module that knows Edge's HTTP shape: `client.ts`, `jwt.ts`, `types.ts` and helpers.                                                                       |
| `middleware/auth-plugin.ts`                    | Session resolution, sliding expiry, CSRF double-submit, RBAC guards.                                                                                                   |
| `middleware/error-handler.ts`                  | The single place an exception becomes an HTTP response.                                                                                                                |
| `audit/service.ts`                             | The only writer of `audit_logs`, the `AuditAction` catalog, and how each action commits.                                                                               |
| `auth/`                                        | `service.ts` (register/login/logout/verify/reset), `captcha.ts`, `expiry-sweep.ts`.                                                                                    |
| `sso/`                                         | OpenID Connect single sign-on: `oidc.ts` (discovery, JWKS, PKCE, ID token validation), `mapping.ts`, `settings.ts`, `service.ts` (the flow, provisioning and linking). |
| `users/service.ts`                             | Profile self-service, admin user management, organizations.                                                                                                            |
| `applications/service.ts`                      | Per-account applications, each its own gateway identity (§5.4).                                                                                                        |
| `catalog/`                                     | `service.ts` (browse/read, `canList` vs `canView`), `read-access.ts` (the shared "may this account read it" check).                                                    |
| `publishing/`                                  | `service.ts` (proxy lifecycle), `edge-plugins.ts` (the binder), `spec-document.ts`, `oas.ts`, `viewers.ts`.                                                            |
| `plugins/`                                     | The provider plugin palette: `service.ts`, `schema.ts` (§5.7).                                                                                                         |
| `access/service.ts`                            | request → approve/deny → grant → revoke, and the ACL-group writes.                                                                                                     |
| `credentials/`                                 | `service.ts` (show-once issue/rotate/revoke), `consumers.ts` (the provisioner), `teardown-worker.ts`.                                                                  |
| `usage/service.ts`                             | Per-API usage and backend health, read from Edge's metrics.                                                                                                            |
| `messaging/service.ts`                         | 1:1 threads and the platform inbox.                                                                                                                                    |
| `notifications/service.ts`                     | The header bell and inbox. A courtesy channel, never the record.                                                                                                       |
| `email/`                                       | `service.ts` (render/enqueue, SMTP transport and inline SMTP diagnostics), `outbox-worker.ts` (queued sends), `templates.ts`.                                          |
| `admin/`                                       | `settings-service.ts`, `mass-email-service.ts`, `smtp-test-service.ts`, `god-service.ts`, `gateway-reconciliation.ts`, `rotate-key.ts`.                                |
| `routes/`                                      | One plugin per domain. Routes validate shapes and delegate to the services they are handed.                                                                            |
| `test/`                                        | `helpers.ts` boots the real app on in-memory SQLite; `mock-ferrum-edge.ts` is a real HTTP server.                                                                      |

### `web/src`

Pages live under `routes/`. Public: `LoginPage`, `RegisterPage`,
`VerifyEmailPage`, `ForgotPasswordPage`, `ResetPasswordPage`. Authenticated:
`DashboardPage`, `CatalogPage`, `CatalogDetailPage`, `ApplicationsPage`,
`CredentialsPage`, `MessagesPage`, `MessageThreadPage`, `NotificationsPage`,
`ProfilePage`, `ApisPage`, `ApiNewPage`, `ApiDetailPage`. Admin (`routes/admin/`):
`AdminUsersPage`, `AdminOrgsPage`, `AdminApisPage`, `AdminAuditPage`,
`AdminSettingsPage`, `AdminMassEmailPage`, `AdminGodPage`.

The route tree is in `router.tsx`. `components/layout/nav.ts` decides which
role sees which sidebar and header destination. Pages gate themselves with
`RoleGuard minRole=…`; the server enforces roles regardless.

---

## 3. The composition root

`server/src/index.ts` is the only file that constructs anything. Services take
an explicit dependency object. None of them reads `process.env`, opens a
socket, or imports another service for a side effect.

Adding a feature takes three edits:

1. write `<domain>/service.ts` exporting `create<Domain>Service(deps)`;
2. construct it in the `COMPOSITION — services` block, in dependency order;
3. register its route plugin in `COMPOSITION — routes`, passing the service
   through the registration options.

```ts
await app.register(
  async (scope) => scope.register(credentialsRoutes, { credentials, applications }),
  { prefix: '/api/credentials' },
);
```

Why this shape:

- **Routes cannot reach a service they were not handed.** A route file imports
  service _types_ and a few pure constants, never a constructed service.
- **Tests substitute at the seams that matter.** `BuildServerDeps` swaps the
  store, the Edge client, the mail transport, the CAPTCHA transport, the
  upstream DNS resolver and the post-registration hook.
- **One provisioner, shared.** `credentials`, `access` and `applications` all
  mutate the same Edge consumers, so `createConsumerProvisioner(...)` is built
  once and passed to each. That puts every consumer write behind the same
  per-consumer lock (§5.2).

Four background pollers start after `app.ready()` and stop on `onClose`: the
email outbox (§7), gateway teardown (§7.1), the hourly session/token expiry
sweep (§8.1), and the periodic gateway-reference reconciliation
(`NEXUS_GATEWAY_RECONCILE_INTERVAL_MS`, see
[`operations.md`](operations.md#13-retargeting-or-rebuilding-ferrum-edge)). All
four are off under `NEXUS_ENV=test`, where tests call `tick()` / `scan()`
directly.

---

## 4. Persistence: `NexusStore` and four adapters

**No service module touches a database driver.** All persistence goes through
[`server/src/db/store.ts`](../server/src/db/store.ts). A new query goes into
the interface and into **all four** adapters.

```
NexusStore
├── sqlite/index.ts      reference implementation (better-sqlite3, synchronous)
├── postgres/index.ts ─┐
├── mysql/index.ts   ──┴─> sql-common.ts (dialect shims) + sql-repos.ts (bodies)
└── mongodb/index.ts     one collection per logical table
```

### 4.1 String UUIDs, ISO-8601 strings

Every `id` is a `crypto.randomUUID()` string and every timestamp an ISO-8601
string, stored as text on all four backends. One logical schema therefore works
everywhere, with no ID-type conversion in service code. MySQL uses
`dateStrings: true` and `VARCHAR` timestamp columns, never `DATETIME`.

### 4.2 The SQLite adapter is the reference

better-sqlite3 is synchronous and cannot hold `BEGIN` open across an `await`.
So `transaction()` runs bodies through a per-connection promise queue: one body
at a time, `BEGIN IMMEDIATE` before it, `COMMIT` on resolve, `ROLLBACK` on
reject. A nested call joins the running transaction. The other adapters present
the same contract with their native primitives.

The transaction queue belongs to one store object, including on PostgreSQL,
MySQL and MongoDB; independent stores do not share it. Production composes all
services over one store. In the supported single-serving-instance topology,
that queue orders a returning SSO callback's transactional settings re-read
and commit against a settings save. Returning callbacks deliberately hold
only the account lifecycle lease; they do not promise a provider cutoff at
commit across independent stores. See
[the SSO authorization boundary](security.md#single-sign-on-openid-connect) and
[supported topologies](operations.md#supported-topologies).

With one connection, any statement issued while a body holds `BEGIN` would run
inside that transaction. The adapter therefore gates **every** repository call
on transaction ownership, tracked with an `AsyncLocalStorage` token:

- a call from the open body (the body, `tx.*`, a nested `transaction()`) runs
  immediately;
- any other call (another request, a worker, a stray continuation) waits and
  runs after the body commits or rolls back.

Nobody reads uncommitted rows, and no unrelated write disappears with someone
else's rollback. The rule for service code: **a transaction body must never
wait on another async context's store call.**

Pragmas: `foreign_keys = ON`, `busy_timeout = 5000`, and for file-backed
databases `journal_mode = WAL` + `synchronous = NORMAL`.

### 4.3 PostgreSQL and MySQL share one repository file

`sql-repos.ts` holds every repository once, in portable SQL. `sql-common.ts`
absorbs the differences:

- `?` placeholders become `$1 … $n` for `pg`;
- `"double quoted"` identifiers become backticks for MySQL (only `"key"` needs
  it; `KEY` is reserved in MySQL);
- case-insensitive substring filters use `POSITION(? IN lower(coalesce(col, '')))`,
  which avoids `LIKE … ESCAPE '\'` — MySQL and PostgreSQL disagree on
  backslashes in string literals.

Row decoding matches SQLite: 0/1 become booleans, `*_json` columns are parsed,
absent columns are `null` (never `undefined`). Each adapter supplies only an
executor, lifecycle, and its engine's contention classifier.

Both engines can roll a transaction back only because another collided with it:
an InnoDB deadlock (`ER_LOCK_DEADLOCK`) or a PostgreSQL serialization failure
or deadlock (`40001`, `40P01`). The shared shell retries up to five attempts
with jittered backoff (10 ms doubling, capped at 200 ms), then fails with
`CONFLICT` and `details.reason = "transaction_contention"`. **A transaction
body may therefore run more than once**, so everything it does must go through
the transaction-scoped store or be idempotent. A body that cannot honour this
passes `{ retry: false }`. See
[`adapters/transaction-retry.ts`](../server/src/db/adapters/transaction-retry.ts).

SQLite does not share these bodies: it is synchronous, has no contention to
retry, and wrapping every statement in a `Promise` would make the reference
harder to read.

### 4.4 MongoDB

One collection per logical table, with the SQL table names (the `COLLECTIONS`
map in `adapters/mongodb/index.ts`). Physical differences:

1. `_id` holds the string UUID; the mappers are the only place `_id` and `id`
   meet. For `app_settings`, `_id` _is_ the setting key.
2. Booleans and structured values (`rate_limit`, audit `details`, setting
   `value`) are native BSON, normalised on write so an absent nested field
   behaves like a JSON round trip.
3. `organizations.name_lower` and `apis.slug_lower` stand in for SQLite's
   `lower(...)` expression indexes. They never leave the adapter.
4. Partial unique indexes use `partialFilterExpression`, matching SQLite's
   `CREATE UNIQUE INDEX … WHERE …` one-for-one.

Transactions use the driver's `session.withTransaction()`, which re-runs the
body on `TransientTransactionError` and re-commits on
`UnknownTransactionCommitResult`. MongoDB fails the loser of a contended
document immediately instead of queueing it, so the adapter adds the SQL
backoff before each re-run and bounds retries by wall clock (5 s of
contention) rather than attempt count. The whole transaction is capped at 15 s.

**Replica set required.** `init()` probes with `hello` and refuses a standalone
`mongod` unless `NEXUS_DB_ALLOW_STANDALONE=true`, because credential rotation
and grant approval need multi-document transactions. With the opt-in,
`transaction()` runs the body sequentially: a throw part-way leaves earlier
writes in place. That is an evaluation mode, not a production configuration.
See [`operations.md`](operations.md#mongodb).

### 4.5 Migrations

`db/migrate.ts` owns ordering, idempotency and "already applied". Adapters
supply three primitives: `ensureMigrationsTable`, `listApplied`,
`applyMigration`. Applied ids go in `schema_migrations`. The id (for example
`001_initial`, `002_api_gateway_plugins`) is shared across dialects, so a
migration can never apply twice on one database.

`db/released-migrations.ts` records each released migration's per-backend
checksum (SQL files, and `db/released/<id>.mongodb.json` for MongoDB). A schema
change is a new forward migration with a higher id in every backend; CI rejects
an edit to a released one
([operations](operations.md#schema-versioning-and-upgrades)). The server build
copies SQL files to `server/dist/db/migrations/`, and each runner loads the
directory beside its own module.

---

## 5. Ferrum Edge integration

Everything that knows Edge's HTTP shape lives in `server/src/ferrum-admin/`.
Above it, code deals in domain objects and `NexusError`s.

### 5.1 The admin JWT contract

Edge verifies HS256 tokens and rejects one missing any required claim.
`jwt.ts` mints exactly:

| Claim          | Value                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `alg` (header) | `HS256`                                                                                               |
| `iss`          | `FERRUM_ADMIN_JWT_ISSUER` (default `ferrum-edge`) — **must equal the gateway's issuer**               |
| `sub`          | `ferrum-nexus` by default; per call, the acting Nexus user id, so Edge's own audit log names a person |
| `iat`, `nbf`   | now (identical)                                                                                       |
| `exp`          | `iat + FERRUM_ADMIN_JWT_TTL` (default 60 s, range 5–3600)                                             |
| `jti`          | fresh UUID                                                                                            |
| `role`         | `admin`                                                                                               |
| `ns`           | `FERRUM_NAMESPACE`, always — required by a gateway with `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true`   |
| `aud`          | **omitted unless** `FERRUM_ADMIN_JWT_AUDIENCE` is set; Edge rejects an unexpected `aud`               |

Tokens are cached in a 256-entry LRU keyed by a hash of every signing input
(including the secret) and re-minted when less than `min(60, ttl / 4)` seconds
remain. Every call also sends `X-Ferrum-Namespace`, which overrides any
`namespace` in the body.

**Connection pooling.** Calls use pooled keep-alive connections. The client's
idle lifetime (4 s, raised to at most 8 s by a `Keep-Alive: timeout=N` hint,
minus a 2 s margin) stays under Edge's default admin idle bound
(`FERRUM_HTTP_HEADER_READ_TIMEOUT_SECONDS`, 10 s). If the gateway still closes
a pooled socket first, a **read** (`GET`/`HEAD`, no response byte yet, closed
rather than refused or timed out) is retried once on a fresh connection within
the same deadline. Writes are never replayed. See
[`operations.md`](operations.md#connection-pooling-and-the-gateways-idle-bound).

**Failure classes:**

| Code                  | HTTP | Meaning                                                                                      |
| --------------------- | ---- | -------------------------------------------------------------------------------------------- |
| `EDGE_UNAVAILABLE`    | 502  | DNS, connect, TLS, socket or timeout. A write may already have reached the gateway.          |
| `EDGE_ERROR`          | 502  | The gateway refused the request.                                                             |
| `EDGE_REJECTED_SPEC`  | 400  | An API-spec write failed Edge's parse/validation (4xx, excluding 401/403).                   |
| `EDGE_PROTOCOL_ERROR` | 502  | An invalid HTTP/JSON response, including malformed UTF-8. Diagnostics carry status + reason. |

A `503` with `applied: false` means the write **is durable** but not yet live.
It surfaces as `EDGE_ERROR` with an explicit message and is never retried
automatically, because a blind retry of a create would `409`. Credential writes
retain the distinction as `kind: "write_durable_not_live"` without returning
Edge's reason text. The exact status and body each call accepts is in
[`edge-response-contracts.md`](edge-response-contracts.md); why `401`/`403`/`5xx`
stay opaque is in
[`security.md` §9](security.md#9-ferrum-edge-admin-jwt-hygiene).

**Health.** Edge answers `GET /health` with `503` and a complete health body
while `starting`, `draining` or `unavailable`. `probe()` reports that as
`reachable: true, ready: false`, and `/api/health` renders it as
`edge.status = "not_ready"`, distinct from an unreachable `"down"`. Edge has no
`/version` endpoint, so `edge_version` is `null` against a stock gateway.

### 5.2 `serializePerKey`, and the concurrency hazard it fixes

`PUT /consumers/{id}` is a **whole-resource replace with no concurrency
token** (no ETag, no `If-Match`, no version). Two concurrent read-modify-writes
on one consumer both read the old state, and one overwrites the other:

```
t0  approve API-A: GET consumer -> acl_groups = []
t0  approve API-B: GET consumer -> acl_groups = []
t1  approve API-A: PUT acl_groups = [nexus:api:A:approved]
t2  approve API-B: PUT acl_groups = [nexus:api:B:approved]   <-- A is gone
```

Nexus would believe it granted API-A while the gateway answers 403.

The fix is `edge.serializePerKey(key, fn)` (`createKeyedSerializer` in
`lib/keyed-serializer.ts`): an in-process promise queue per key, **plus a lease
row in `edge_leases`** taken inside it so the lock also holds across Nexus
instances. Different keys run concurrently. **Every** consumer write goes
through it: ACL-group changes (`ConsumerProvisioner.mutateAclGroups`),
credential appends and deletes. A rotation re-reads the consumer _inside_ the
lock, so the array length it checks and the index it deletes cannot drift.

A `PUT` body must also be built from a fresh `GET` because omitting `keyauth`
or `jwt` from it **deletes those credentials**. The provisioner echoes
`current.credentials` back, redacted placeholders and all.

**Leases.** One row per key with an owner token and expiry: 60 s TTL renewed at
half that, a 30 s wait for a contended key, then `409 CONFLICT` asking the user
to retry. A crashed holder blocks the key only until its lease expires. Every
`store.transaction` opened inside the section verifies the owner token before
committing (`lib/lease-fence.ts`), so a paused holder that resumes after
another instance took the key cannot commit database writes. Edge has no
fencing token, so that holder could still send a stale gateway write; the
supported deployment therefore has one active gateway-writing instance. See
[`operations.md`](operations.md#8-scaling) and
[`security.md`](security.md#cross-instance-locks-are-fenced-at-commit).

**Keys must be canonical.** A consumer is keyed by its **Ferrum consumer id**;
a proxy by `proxy:<id>`. A few wrappers take a different outer key and nest a
canonical key inside it, always outer first:

| Key                                  | Where                      | Why                                                          |
| ------------------------------------ | -------------------------- | ------------------------------------------------------------ |
| `consumer-name:[namespace,username]` | `credentials/consumers.ts` | First provisioning of an identity, before its id is known.   |
| `test-consumer:<username>`           | `publishing/service.ts`    | A provider test consumer, whose id changes on every replace. |
| `proxy-palette:<proxy id>`           | `plugins/service.ts`       | Serialises palette changes on one API across plugin names.   |

Neither the queue nor the lease is re-entrant: nesting the _same_ key
deadlocks. Code that composes several proxy writes takes the key once
(`binder.withProxy`) and uses the `…Locked` helpers inside.

**Proxy writes are read-modify-write too.** `PUT /proxies/{id}` is also a
whole-resource replace, against a struct with `deny_unknown_fields`, and `Proxy`
is much wider than Nexus models (`hosts`, timeouts, backend TLS, pooling,
`upstream_id`, stream listeners, the plugin association list). A body built
from Nexus's fields alone would reset all of those. So every proxy write goes
through `mutateProxy`: `GET /proxies/{id}`, overwrite only the changing fields,
`PUT` the whole document back minus the server-owned `namespace` /
`created_at` / `updated_at`, all under `serializePerKey('proxy:<id>', …)`.
Without it, an auth change and a plugin change on different instances could
leave a proxy running the plugin with no authentication.

### 5.3 The plugin naming trap

Edge's _plugin_ names and _credential-type_ keys differ. Mixing them up
produces a credential that authenticates nothing:

| Nexus `auth_plugin` | Edge plugin name | Edge credential key (`Consumer.credentials`) |
| ------------------- | ---------------- | -------------------------------------------- |
| `key_auth`          | `key_auth`       | `keyauth`                                    |
| `basic_auth`        | `basic_auth`     | `basicauth`                                  |
| `jwt_auth`          | `jwt_auth`       | `jwt`                                        |

`CREDENTIAL_TYPE_FOR_PLUGIN` in
[`shared/src/constants.ts`](../shared/src/constants.ts) is the single mapping.
Never hand-write either spelling.

Plugin configs are closed key sets; a typo is a `400`. What Nexus sends:

- **Auth plugins** — `{}`. `key_auth` defaults to `header:X-API-Key` with
  `hide_credentials: true`; `basic_auth` defaults `hide_credentials` to `true`;
  `jwt_auth` defaults to `token_lookup: header:Authorization` and
  `consumer_claim_field: sub`. Edge has no `hide_credentials` for `jwt_auth`,
  so a bearer token is forwarded upstream while a key or Basic password is
  stripped. This is Edge's asymmetry; it is documented in [`api.md`](api.md)
  and [`security.md` §5](security.md#5-show-once-credentials) and pinned by
  `e2e/src/dataplane.test.ts`.
- **`access_control`** — `{ allowed_groups: ['nexus:api:<api_id>:approved'] }`
  only. Never `allowed_consumers`.
- **`rate_limiting`** — `limit_by: 'consumer'`, `expose_headers: true`, and one
  `limits` entry with `scope: "default"` using `window_seconds` +
  `max_requests`. Edge's preset keys (`requests_per_second|minute|hour`) cannot
  be mixed with the custom pair, so Nexus uses only the custom pair.
- **`cors`** — `{ allowed_origins, allow_credentials }` only. Edge's other CORS
  keys keep their native defaults; sending a key the provider cannot change
  would only freeze that default.
- **`openapi_validator`** — **Nexus never writes one.** Edge refuses a
  hand-built validator on a proxy with no attached API spec, so `routes`
  enforcement submits the _document_ and lets Edge generate the plugin (see
  [Spec-owned proxies](#spec-owned-proxies)).

Plugins are created as `{ plugin_name, scope: 'proxy', proxy_id, enabled,
config }` **and then associated**. A proxy-scoped config does not run until
the proxy's own `plugins[]` lists `{ plugin_config_id }` for it. So every
create is followed by an association write on the proxy, and every removal is
preceded by a disassociation, both through `mutateProxy`.

**The portal owns configs by id, not by name.** `api_gateway_plugins` holds one
row per `(api_id, role)` for the first-class roles (`auth`, `access_control`,
`rate_limit`, `cors`), with the id of the config the portal created, or `NULL`
when it owns none in that role. Only those recorded ids decide which config a
settings change may replace, repair or delete. Edge allows several configs of
one plugin name on a proxy, and an operator's own limiter, CORS policy or gate
is not the portal's to rewrite:

- setting a quota beside an operator's `rate_limiting` creates the portal's
  own config next to it (both run, so the stricter wins), and clearing the
  quota deletes only the portal's;
- a recorded id no longer on the proxy means an operator removed it; the next
  change creates a fresh config rather than adopting another of that name.

**APIs published before `002_api_gateway_plugins`** have no rows, so their
configs are recognised role by role, conservatively. A config counts as the
portal's only if the API uses that role and the config still holds what the
portal wrote (the empty auth config, its ACL group, its quota, its CORS
origins). An auth config with settings of its own is never adopted or deleted.
The outcomes:

| Situation                                                    | Result                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| One matching config                                          | Adopted and recorded on the first successful change.                                           |
| Role not used by the API                                     | Recorded as owning nothing (`NULL`).                                                           |
| Two candidates, or an unmatched auth/`access_control`/`cors` | Ambiguous or unrecognised. A `PATCH` touching that role gets `409 CONFLICT` naming the plugin. |
| Unmatched `rate_limiting`                                    | Left to the operator; the portal creates its own beside it.                                    |

The operator resolves a `409` by removing the config or bringing it back in
line (for auth, the empty default config). Configs left beside the portal's are
listed on the audit row under `unowned_same_name_configs`. An auth swap that
leaves an outgoing auth config attached lists it under
`outgoing_auth_configs_remaining` and records
`existing_credentials_invalidated: false`, rather than claiming the old
credentials stopped working. Once a role is recorded, the record alone governs
it. Upgrade notes:
[`operations.md`](operations.md#schema-versioning-and-upgrades).

### 5.4 One consumer per identity per namespace

An **identity** is a Nexus account or one of its applications. Each maps to
exactly one Edge consumer in the configured namespace:

- `username` = `nexus-user-<user_id>` (`consumerUsernameForUser`) or
  `nexus-app-<application_id>` (`consumerUsernameForApplication`). Never
  derived from anything editable: `access_control` matches usernames
  byte-for-byte, so an identity must not move when something is renamed.
- `custom_id` = the raw user or application id, a reverse lookup for operators.
- `id` = a UUIDv8 from SHA-256 of
  `["ferrum-nexus-consumer-v1", namespace, username]` (first 128 bits, version
  and variant bits set; `derivedConsumerId` in `ferrum-admin/client.ts`). The
  `consumers` table caches the id, including Edge-assigned ids adopted from
  older deployments.

#### Why applications are separate consumers

ACL groups live on the consumer, so one consumer means **one permission set**:
every credential it holds reaches every approved API. Credential labels change
nothing about what a secret can reach.

An application is a separate identity all the way down: its own consumer,
access requests, grants and credentials. Two applications of one owner approved
for different APIs cannot call each other's, because Edge's ACL matching
enforces it.

Each `consumers` row carries the owning `user_id` and a nullable
`application_id`, so teardown, repair and audit find an account's application
consumers too. Disabling an account strips **every** one of them and keeps the
rows, so re-enabling can replay each identity's grants. Account-scoped access
(`application_id = NULL`) remains the default.

**Provisioning is lazy.** The consumer is created the first time an identity is
approved for an API or issues a credential. `ensure` does one `GET` of the
derived id and, on `404`, one `POST` with that id, regardless of namespace size.
Only a refused create (`409`) falls back to a logged legacy username scan,
which throws past 10,000 consumers (see **Consumer identity recovery** in
[`operations.md`](operations.md#consumer-identity-recovery)). A failed or
malformed response never authorises a create. A derived id that belongs to a
different username is refused.

The mapping lookup, create/adopt and mapping insert share the
`consumer-name:[namespace,username]` lease, so a concurrent first credential and
first approval initialise one identity. That lease is released before the
consumer-id lease is taken; they never nest.

**Provider test consumers.** Each API has a disposable `nexus-test-<api_id>`
consumer with the API's ACL group and one credential of its auth type.
Recreating it deletes and replaces it, since that is the only way to reset its
show-once state. A replacement gets a fresh id, not the derived one (which
stays with the first consumer of that username), and that id is recorded in
`gateway_identities` _before_ the create, so a create whose acknowledgement was
lost is still found with one `GET /consumers/{id}`. Account teardown deletes
test consumers outright.

### 5.5 The ACL group flow

One ACL group per API, held on the requester's consumer. The proxy's
`access_control` config is written **once**, at publish, and never touched
again, so approvals contend on one consumer rather than on a config shared by
every approved user.

```
                 client                     provider/admin                Ferrum Edge
                   │                              │                            │
 POST /api/access-requests                        │                            │
  {api_id, justification}                         │                            │
                   │──── access_requests row ─────┤                            │
                   │      status = pending        │                            │
                   │                              │                            │
                   │      POST /api/access-requests/:id/approve                │
                   │                              │  claim: pending → approved │
                   │                              │  serializePerKey(consumer):│
                   │                              │  GET  /consumers/{id}      │
                   │                              │  acl_groups += ────────────┤
                   │                              │    nexus:api:<api_id>:approved
                   │                              │  PUT  /consumers/{id} ─────┤
                   │                              │  grants row (active)       │
                   │                                                           │
                   │   the proxy's access_control plugin already says:         │
                   │   allowed_groups = [nexus:api:<api_id>:approved]          │
                   v                                                           v
             calls now pass                                        gateway authorises
```

**Approval order: claim, gateway, grant row.** The claim is an atomic
compare-and-set out of `pending`, so a racing cancel or deny loses before
anything reaches Edge. The gateway write comes before the grant row: if Edge
fails, the request goes back to `pending` and no grant exists. The reverse
would leave Nexus claiming access the gateway rejects. If the grant row then
fails, `unwindApproval` takes the group back off.

**Revocation order is reversed: claim the grant, then the gateway.** Flipping
the grant to `revoked` first means the portal never shows access as active
while the group still opens the door; `unwindRevocation` restores it if the
gateway write fails. The originating request is also moved to `revoked`, so the
history reads "approved, then revoked". An identity with no consumer never had
the group, so there is nothing to remove.

### 5.6 Publishing: a multi-write sequence with no transaction

Edge has no cross-resource transaction. `publish` creates the proxy, then each
plugin config, then associates them all in **one** `PUT /proxies/{id}`. If any
step fails it **rolls back what it created** (plugin configs, then the proxy,
which cascades association rows and any config the explicit deletes missed)
and rethrows. Nexus rows are written last, so a failed publish leaves nothing
on either side.

```
apis row ─── proxy          name `nexus-<slug>`, listen_path `/<namespace>/<slug>`
              │             allowed_methods, backend_{connect,read,write}_timeout_ms,
              │             circuit_breaker, allowed_ws_origins
              │
              │ proxy.plugins[] ─ the association list: a config the proxy does
              │                   not name is stored but never runs
              ├─ plugin_config  the auth plugin (key_auth | basic_auth | jwt_auth)
              ├─ plugin_config  access_control    — only when `requestable`
              ├─ plugin_config  rate_limiting     — only when a rate limit is set
              ├─ plugin_config  cors              — only when `cors` names origins
              ├─ plugin_config  openapi_validator — only when `spec_enforcement`
              │                                     is `routes`; generated and
              │                                     owned by Edge, not by Nexus
              └─ plugin_config  … one per `api_plugins` row — the provider
                                  plugin palette (§5.7)
```

#### The listen path is written last

Edge serves a proxy from the moment it exists, and its plugins do not run
until associated. Creating the proxy at `/<namespace>/<slug>` would expose the
API, open and unlimited, for the round trips it takes to attach auth, ACL,
rate-limit and CORS. Rollback cannot un-serve those requests. Reordering does
not help: Edge refuses a plugin config for a proxy that does not exist, and
`allowed_methods` must be `null` or non-empty, so there is no deny-all proxy.

So every write happens on a **staging listen path**, and moving to the real one
is the final gateway call. `stagingListenPath()` mints
`/<namespace>/.staging/<32 hex>` from 16 random bytes. A slug cannot start with
`.`, so it never collides with a real path, and 128 bits make it unguessable.

| #   | `docs_only`                                         | `routes`                                    |
| --- | --------------------------------------------------- | ------------------------------------------- |
| 1   | `POST /proxies` at the **staging** path             | `POST /api-specs` at the **staging** path   |
| 2   | `POST /plugins/config` × N                          | `POST /plugins/config` × N                  |
| 3   | `PUT /proxies/{id}` — the association write         | `PUT /proxies/{id}` — the association write |
| 4   | `PUT /proxies/{id}` — **cutover** to `/<ns>/<slug>` | `PUT /api-specs/{id}` — **cutover**         |

Step 4 is `cutOverToListenPath`. For a spec-owned proxy, the spec `PUT` moves
`x-ferrum-proxy.listen_path` and regenerates the operation table under the new
prefix (`servers[0].url` stays `/`). Moving only the proxy would leave the
validator matching the staging path. Edge updates the proxy in place (same id,
same `created_at`), and its uniqueness check excludes the proxy being written.

The real path is therefore either `404` or fully gated, never open. The
`spec_enforcement` conversion, which deletes and recreates the proxy, and its
undo both take the same staging detour.

**Locking.** API `PATCH` and spec revision share the `proxy:<id>` lease. `PATCH`
holds it from its catalog re-read through gateway writes, rollback and catalog
persistence, so a conversion snapshots state only after earlier edits finish.
Spec revision re-reads its mode and current revision after taking the lease.

**Spec revision undo.** The undo (previous document and backend, read under
the lease) is registered before `PUT /api-specs/{id}`, so a re-import Edge
applied but did not acknowledge is still restored before the lease is
released. A revision that rewrites the proxy first commits an
`api.spec_revision_start` intent row; a failed restore writes
`api.gateway_repair_required` and the catalog keeps its previous revision. The
full audit sequence is in [`api.md`](api.md).

**Spec change summaries.** Under the same lease, after the previous revision is
re-read, `publishing/spec-changes.ts` compares it with the new document for
consumers: operations, parameters, request bodies, responses and their schemas,
each change classified as breaking or not. The comparison is pure and bounded
(each shared component compared once per direction, a fixed work budget, capped
output), so it runs before the store transaction rather than inside a body that
may re-run. The summary commits with the revision in `api_spec_changes`, which
has no foreign key to `api_specs` and so outlives retention. The catalog serves
it under the detail page's visibility rule
([`api.md`](api.md#get-apicatalogslugchanges)).

**Spec change notices.** Once the revision has committed and the proxy lease is
released, `publishing/spec-change-notices.ts` tells the API's grantees what
changed: an in-app notice and an outbox email per account, as each account's
`user_notification_preferences` allow. The publish starts it and does not wait
for it; it never rejects, so it can neither slow the publish nor fail it. Its
fan-outs run one at a time per API, and of several waiting only the newest
runs. On a graceful stop no further batch starts and the server waits at most
10 seconds; what is left is skipped. It is coalesced two ways: an unread notice
for the API is rewritten rather than repeated, keeping a breaking mark, and one
email per API per account per clock hour goes out through the outbox
idempotency key. One fan-out queues at most `NEXUS_MAX_MASS_EMAIL_RECIPIENTS`
emails. Each batch of
200 accounts re-reads grants and account status, and commits its notices,
emails and `api.spec_notify` audit row together; a failed batch does not stop
the next.

### Spec-owned proxies

Nexus composes and attaches every plugin above except `openapi_validator`.
Edge refuses one on a proxy with no `api_spec_id`, and only the API-spec
importer sets that field. So a `routes`-level API gets its whole proxy from
`POST /api-specs`, using a document built from the provider's own
(`publishing/spec-document.ts`):

- **`servers` is replaced with `[{ url: '/' }]`.** Edge mounts each operation
  at listen prefix + server pathname + Paths key, so a root server makes
  `/invoices` match `/<namespace>/<slug>/invoices` with the prefix applied
  once. Nested `servers` (Path Items, operations, referenceable components,
  callbacks, webhooks) are stripped so nothing adds a base back. The upstream
  lives in the explicit `x-ferrum-proxy` backend fields. Stored provider bytes
  are unchanged, and catalog documents still show the external invoke URL.
- **`x-ferrum-proxy`** carries the proxy body, including a Nexus-minted `id`,
  so `ferrum_proxy_id` is a plain proxy id in either mode.
- **`x-ferrum-validate`** is `{ mode: 'block', request: { enabled: false },
response: { enabled: false }, fail_on_unknown_operation: true }`. Undeclared
  paths get `400`; bodies are not validated, since a portal cannot know whether
  a provider's `$ref`ed schemas are meant as enforcement or documentation.
- **Every root `x-ferrum-*` key the provider wrote is stripped.** A document is
  input, not configuration.

**Supported Edge importer contract.** Routes enforcement needs an Edge build
that includes [ferrum-edge#5470](https://github.com/ferrum-edge/ferrum-edge/pull/5470)
(listen-prefix mounting) and
[ferrum-edge#5491](https://github.com/ferrum-edge/ferrum-edge/pull/5491)
(literal root-path matching). Older importers are not supported, and Nexus does
not switch behaviour by Edge version. See Edge's
[API-spec contract](https://github.com/ferrum-edge/ferrum-edge/blob/main/docs/api_specs.md)
and [validator matching rules](https://github.com/ferrum-edge/ferrum-edge/blob/main/docs/openapi_validator.md).

Matching details: trailing slashes on the listen prefix are trimmed when
joining non-root Paths keys. Paths key `/` matches the literal listen path
(`/p2/oas2` → `^/p2/oas2$`, `/p2/oas2/` → `^/p2/oas2/$`); other trailing
slashes stay literal. Backend paths and `strip_listen_path` affect forwarding,
not matching. Validators are not rewritten at startup: to fix an API whose
matchers carry a doubled prefix, upload its current spec as a new revision.

Edge creates the proxy, generates the validator and associates it in one
transaction, then tags both with the spec id. Consequences:

1. **A spec revision is `PUT /api-specs/{id}`.** It re-inserts the proxy from
   the submitted `x-ferrum-proxy`, so the body is built from a fresh
   `GET /proxies/{id}` and a backend move rides in the same call. Hand-owned
   plugin configs and their associations survive.
2. **`PUT /proxies/{id}` still works** on a spec-owned proxy and keeps the
   stamp and association list, so runtime-settings `PATCH`es use `mutateProxy`
   as usual.
3. **Changing the level rebuilds the proxy.** Edge cannot attach a spec to an
   existing proxy, detach one without deleting it, or accept a spec naming an
   existing proxy id. The conversion deletes the proxy and rebuilds it under
   the same id on a fresh staging path, carrying the proxy document and every
   hand-owned plugin config across with their original ids, then cuts over.
   The API answers `404` in between; the audit row says `proxy_rebuilt: true`.

**CORS and the validator.** `cors` runs at priority 100 and `openapi_validator`
at 2960, and `preflight_continue` defaults to `false`, so a preflight is
answered `204` before the unknown-operation check. No synthetic `OPTIONS`
operation or method-wide bypass is needed.

#### Proxy settings derived from CORS

Two proxy fields are partly derived from the CORS policy, because Edge checks
them before and independently of the `cors` plugin:

- a method outside `allowed_methods` gets `405` **before any plugin runs**, so
  the gateway list gains `OPTIONS` whenever the API has a CORS policy. The
  `apis` row keeps the provider's own list, so removing CORS removes the
  implied `OPTIONS`;
- `allowed_ws_origins` is the WebSocket upgrade origin check, which `cors`
  never runs for. Exact CORS origins are mirrored into it. A wildcard, no
  policy, or `cors.enforce_websocket_origins: false` leaves it `[]` (no check).

Both are recomputed whenever either input changes, in one read-modify-write
with one undo step. A `PATCH` that does not name a setting does not write it,
so hand-tuned proxy timeouts survive unrelated changes.

#### How `PATCH` reconciles plugins

The SPA sends the whole settings block on every save, so `cors` and
`rate_limit` are compared with the stored value (`isDeepStrictEqual`) and
reconciled only when they changed. An unchanged save leaves the gateway config
as the operator left it (`allowed_headers`, `max_age`, `sync_mode: 'redis'`,
`enabled: false`) and does not name the field in the audit row, but still
restores a dropped association. A real change merges the portal's keys over
the live config, so operator keys survive. (Palette plugins do not merge,
because a provider must be able to clear their optional fields.) All of this
applies only to the config the portal **owns** in that role (§5.3).

Each plugin change has a matching undo step, ordered so the gateway is never
_less_ restrictive than the portal claims:

- an auth swap creates and associates the replacement before detaching the old
  one (briefly both work, which beats a proxy with no auth);
- a removal disassociates before deleting;
- `DELETE /api/apis/:id` deletes the **proxy first**, because Edge's
  `DELETE /plugins/config/{id}` clears associations instead of refusing, and
  deleting the auth config first would leave the proxy unauthenticated.

#### Upstream and lifecycle

The `apis` row records `upstream_url`, the normalised
`scheme://host:port[/basePath]` of the backend the proxy last pointed at. It is
rewritten at publish, on a `PATCH` with a new `upstream_url`, and on a spec
revision the proxy follows (in the same store transaction). The upstream comes
from the provider's explicit `upstream_url`, else the document's first
_absolute_ `servers[].url`; relative server URLs yield none.

**Retire ≠ delete.** `status: 'retired'` is a catalog state only: the proxy and
plugins are untouched, grants keep working, and the API is hidden from the
catalog except for its owner, grantees and admins. `DELETE /api/apis/:id` is the
destructive path: it revokes grants, strips ACL groups, tears down the Edge
objects and removes the rows.

### Agent-ready listings

`apis.agents_json` (MongoDB: `apis.agents`) stores an explicit operation selection,
with `null` meaning off. Forward migration `010` upgrades retained APIs in place
on SQLite, PostgreSQL, MySQL and MongoDB; no released migration is edited. Wire
types and the bounded Path Item selection helper live in `shared/src/agents.ts`.
Publishing, settings updates, revision/rollback and restore validate the selection
against the document and the method policy before gateway writes. Existing owner
or admin authorization, session/CSRF checks and transactional completion audits
apply; settings mutations also record `api.agents_update_start` intent.

The active deployment uses the same spec-owned proxy and backend as REST. Nexus
strips provider gateway extensions, resolves bounded local Path Item references,
then stamps every operation with an explicit expose true/false and the selected
name, description and risk annotations. The released importer cannot combine
`x-ferrum-validate` with `x-ferrum-mcp`, so agent APIs embed an `openapi_validator`
operation table with an exact, anchored MCP endpoint bypass. Unknown REST paths
still fail; `mcp_gateway` claims the endpoint and refuses malformed traffic and
descendants instead of forwarding them. APIs with agents off keep the existing
`x-ferrum-validate` path unchanged.

Five spec-owned plugin configs have ids derived from the recorded proxy id:
routes, MCP gateway, governor, shield and tool-call budget. Existing ids are
accepted only with matching plugin name and owning spec id. Fresh reads under
the canonical proxy lease preserve resource-level operator fields with `writeBody`;
same-name operator configs are never adopted. The spec importer owns creation,
replacement and removal. Enabling on an existing routes API carries the previous
spec-generated validator's resource fields into the new fixed validator. Undo
captures removed resource fields before each spec replacement so a lost
acknowledgement is compensated along with a failed store/audit commit.

Each selected tool's `policy.tools` entry admits the separate MCP-all group or its
server-owned exposure group. The REST approval group never authorizes a tool.
Default deny and hidden denied tools prevent implicit exposure. The existing
`access_control` gate also applies to initialization, discovery and calls. The existing credential/consumer identity remains the authorization boundary; requests
and grants add nullable tool subsets with parity across all four stores. Fixed governor, argument shield
and consumer budget triggers match only this API's exact MCP endpoint. Nexus does
not proxy data-plane MCP or configure transcript sinks. See
[agent-marketplace.md](agent-marketplace.md) for release provenance and limitations.

### 5.7 The provider plugin palette

The configs above come from fields on the `apis` row. The **palette** is what
a provider adds on top: a curated set of Edge plugins (`security_headers`,
`ip_restriction`, `request_deduplication`, `request_termination` and others)
they can switch on and off, one `api_plugins` row and one proxy-scoped config
each. `response_caching` is retired: existing installations can be removed but
not added or enabled.

**Same machinery.** A palette config is created, associated, replaced and
deleted exactly like `rate_limiting` and `cors`. `publishing/edge-plugins.ts`
holds `mutateProxy`, `attach`, `associate`/`disassociate`, the undo steps and
`reconcileOptionalPlugin`, and both `publishing/service.ts` and
`plugins/service.ts` use it. A second GET-merge-PUT implementation would mean a
second lock key, which is no lock at all (§5.2).

**One descriptor per plugin.** `PROVIDER_PLUGINS` in `shared/src/plugins.ts`
describes each plugin once: Edge name, category, and `PluginFieldSpec[]` whose
`key` **is** the Edge config key. From it:

- `server/src/plugins/schema.ts` builds a `.strict()` zod schema, so an unknown
  key is a portal `400`, not a gateway `400` half-way through;
- `web/src/components/plugins/PluginForm.tsx` renders the form generically;
  adding a plugin is a descriptor and nothing else.

Each descriptor exposes a **curated subset** of the Edge schema. Optional fields
the provider left alone are omitted, so Edge's defaults apply.

Details that matter:

- **`enabled: false` pauses, it does not remove.** The config and association
  stay. Nexus validates the body either way, because Edge does not validate a
  disabled plugin strictly.
- **`trigger`** is `{ methods?, path_prefix? }`, compiled (`edgeTriggerFor` in
  `ferrum-admin/palette.ts`) into Edge's `all`/`match` predicate tree.
  Descriptors carry `supports_trigger`; Edge refuses triggers on plugins that
  set response-header policy, a fixed body ceiling or trailers.
- **Priority.** `compression` and `request_deduplication` are written with
  `priority_override` 3005 and 4060 so compression runs first; a live operator
  override always wins.
- **`request_deduplication` follows `FERRUM_RATE_LIMIT_SYNC_MODE`.** In `local`
  mode its records are per gateway process, so N replicas may execute a key up
  to N times. In `redis` mode the operator's Redis settings are stamped into
  the config. Replay and in-flight semantics are Edge's
  ([ferrum-edge#4844](https://github.com/ferrum-edge/ferrum-edge/pull/4844));
  clients must reuse the same key when retrying the same operation.

**Ownership is by config id.** The `api_plugins` row records the Edge config id
it created (`ferrum_plugin_config_id`); saves and removals act on that config
alone. An operator's config of the same name (a per-path deny gate, say) is
never replaced or deleted. A row with no recorded id owns nothing: saving
creates a fresh config, removal leaves unowned configs alone. A recorded id no
longer on the gateway means an operator removed it; the next save creates a new
one.

**A `PUT` carries what the portal does not own.** `PUT /plugins/config/{id}`
replaces the whole resource. `writeBody` in `publishing/edge-plugins.ts` merges
the portal's fields (`plugin_name`, `scope`, `proxy_id`, `enabled`, `config`,
`trigger`) over the live resource, so fields like `priority_override` survive.
Create, replace, undo and proxy-rebuild restore all use it.

**Failure handling.** The `api_plugins` row is written last but **inside** the
compensated block, so a store failure rolls the gateway back (a
`request_termination` with no row would leave the API answering 503 with no
way to switch it off in the UI). Every undo step is registered **before** the
gateway write it undoes, because a write Edge applied but did not acknowledge
fails just like a refused one. A replace's undo is the whole live resource; a
create uses an id minted beforehand; a removed config is recreated under its own
id. Any failed `set` or `remove` that reached the gateway writes
`api.plugin_rollback` with `restored: true` or `restored: false` (plus step
errors and the config id). API deletion drops the rows in the same transaction
as specs and grants; the proxy delete cascades the gateway configs.

Out of scope: the auth family (`hmac_auth`, `jwks_auth`, `oauth2_introspection`,
`mtls_auth`) changes the credential model (§6), and `spec_expose` needs a
public spec endpoint. Either could be added without changing this machinery.

---

## 6. Show-once credentials

Nexus generates the secret, returns it in exactly one HTTP response, and stores
only a SHA-256 fingerprint and the last four characters in
`credential_metadata`. **Edge enforces the same independently**: Admin API
reads redact `keyauth.key` and `jwt.secret` to `[REDACTED]` and never return
`basicauth` material. There is no read path back to the plaintext.

Two Edge schema facts a portal could get wrong:

- **`basicauth` has no username field.** The entry is exactly one of
  `password` / `password_hash`; the lookup key is the _consumer's_ `username`.
  The username shown to the user is therefore the consumer username
  (`nexus-user-<id>` or `nexus-app-<id>`).
- **`jwt` has no key or kid field.** The entry is exactly `{ secret }` (32–4096
  chars). `jwt_auth` finds the consumer from `consumer_claim_field` (default
  `sub`), matched against username, id or custom_id. So
  `ShowOnceSecret.jwt_key` carries the **consumer username**, the value the
  client puts in `sub`.

### 6.1 Locating an entry to delete

Edge gives credential entries **no id**, and reads redact the material, so
nothing on the wire identifies a specific entry. What is stable is _order_:
`POST` appends, and `DELETE /{type}/{index}` removes by 0-based index (the
array re-indexes).

Nexus writes one `credential_metadata` row per append. Each carries
**`edge_ordinal`**, a strictly increasing counter per `(consumer, type)`
assigned as `MAX + 1` in the insert statement, inside the same per-consumer
lock as the Edge append. So ordinal order _is_ append order, and the
non-revoked rows for a pair, ordered by ordinal, mirror the Edge array. A row's
position in that list is its index.

A row with an unknown gateway position has `edge_ordinal = NULL`. Such rows sort
before every row with an ordinal, but not among themselves. A lone such row is
still index 0; two or more make the target **ambiguous**, refused with
`409 CONFLICT` until an admin runs `POST /api/admin/credentials/reconcile`
(§6.3).

`resolveCredentialIndex` computes the position and checks it against the live
array length read inside the same lock. On a mismatch (someone hand-edited the
consumer), a revoke with only one live row deletes the whole credential type;
anything else is **refused** rather than risk deleting someone else's key.

One mismatch is Nexus's own and is settled instead. Every destructive call
marks its row `retiring` **before** the gateway `DELETE` and `revoked` after, so
a delete whose acknowledgement was lost leaves an intent record. When the
mirror is exactly one row longer than the array and exactly one live row is
`retiring`, the next rotate, revoke or issue settles it (`credential.settle`).
Every other shape is refused.

`basicauth` never appears in a read, so the length check cannot apply and the
mirror is the only record of its positions. It is kept provable instead: a
`basicauth` row is written as `retiring` before its append and activated only
once Edge acknowledges it, so no entry reaches the gateway without a row. A
`retiring` `basicauth` row means an outcome the gateway never confirmed, and
while one exists, issuing, rotating and revoking any other `basicauth`
credential of that consumer is refused with `409 CONFLICT`. A revoke with no
other `active` row of the type deletes the whole type instead of an index, and
settles the `retiring` rows with it; an explicit `clear_type=true` revoke does
the same while active rows remain. See
[`security.md` §5](security.md#5-show-once-credentials) and
[`operations.md` §12](operations.md#12-the-credential-mirror).

### 6.2 Rotation sequence

```
POST /api/credentials/:id/rotate
  │
  ├─ caller must own the credential             any other caller, admin included: 403
  │
  └─ serializePerKey(consumer):
       re-read the row; owner checked again
       GET /consumers/{id}                      fresh view, same lock
       rows      = live credential_metadata rows for (consumer, type), by edge_ordinal
       position  = index of the target
       appendFirst = (edge array length < FERRUM_MAX_CREDENTIALS_PER_TYPE)

       if appendFirst:                          the normal path
         POST   /consumers/{id}/credentials/{type}   -> new secret, returned once
         old row -> 'retiring'
         DELETE /consumers/{id}/credentials/{type}/{position}
              (the append does not move the old entry's index)
              on failure: withdraw the append, restore the old row if the
              array proves the delete never applied, report the error
       else:                                    already at the cap
         old row -> 'retiring'
         DELETE /consumers/{id}/credentials/{type}/{position}
              on failure: restore the old row if the delete never applied
         old row -> 'revoked'
         POST   /consumers/{id}/credentials/{type}   -> new secret, returned once

       append-first: old row -> 'revoked'
       new row: rotated_from_id = old id, next edge_ordinal
```

Append-then-delete keeps both secrets live only for the duration of the call;
the old entry is gone before the response returns. At the cap there is no room
to append, so the old entry goes first, briefly leaving no working credential
of that type (and if the append then fails, the caller is told to issue a new
credential). `FERRUM_MAX_CREDENTIALS_PER_TYPE` (default 2) and the matching
gateway setting above 1 avoid that gap. For a caller-controlled cutover, issue
a new credential, deploy it, then revoke the old one.

### 6.3 Reconciling a consumer

`POST /api/admin/credentials/reconcile` (admin and above) takes a
`consumer_id` and `credential_type`. Inside the consumer's lock it issues
`DELETE /consumers/{id}/credentials/{type}` and moves every live row for the
pair to `revoked`. Only a consumer the portal owns (a recorded mapping, a
registered gateway identity, or portal credential rows) can be reconciled;
anything else is `403 FORBIDDEN` before Edge is touched. It writes a
`credential.reconcile` audit row and notifies each affected owner.

This is the only repair that needs no per-entry identity, so it is the answer to
both a drifted array and ambiguous rows. Owners then issue fresh credentials,
which carry ordinals. Operational detail:
[`operations.md` §12](operations.md#12-the-credential-mirror).

---

## 7. Email: the outbox

**Transactional mail uses the outbox.** `EmailService` renders messages into
`email_outbox`, and `outbox-worker.ts` delivers them through the SMTP transport
in `email/service.ts`. That service also implements the inline SMTP diagnostic
(`EmailService.sendTest`, called by `admin/smtp-test-service.ts`), so the
settings page can report a relay error immediately. Queued transactional
delivery and this diagnostic share the transport. A slow or broken relay
cannot turn an approval into a 502, and queued mail has retries.

```
service ──enqueue──> email_outbox(pending) ──claim──> sending ──┬─> sent
                                                                └─> reschedule (pending, backoff)
                                                                    └─ after 5 attempts -> failed
```

- The claim is an atomic `pending → sending` flip that increments `attempts`,
  so two workers never claim the same row.
- Claims choose the highest `priority` among due pending rows: verification
  (registration and resend) and password recovery are high (`2`), other
  transactional notifications normal (`1`), and new campaigns low (`0`). Within
  a lane, the earliest due time comes first (null first), then oldest creation
  time and ascending id. The worker claims one message at a time, so security
  mail arriving during a campaign send is considered at the next claim. It
  cannot preempt active SMTP, bypass backoff or eliminate polling/relay delay.
  Continuous high-priority traffic can delay lower lanes.
- Forward `009_outbox_priority` preserves existing rows at normal priority,
  promoting the durable `verify:` and `reset:` idempotency namespaces to high
  without inspecting rendered or sealed content. Unclassified legacy messages
  stay normal; delivery status, retries and recipient/claim fences are retained.
- Backoff is `30s · 2^attempts`, capped at one hour, plus up to 10% jitter.
  `OUTBOX_MAX_ATTEMPTS` is 5.
- Every tick first returns rows left `sending` for over five minutes (a crashed
  worker) to `pending`.
- **With SMTP unconfigured the worker claims nothing.** Mail waits in `pending`
  until an admin configures SMTP, instead of burning its retries.
- `enqueue` with an `idempotencyKey` is at-most-once (unique index on
  `email_outbox.idempotency_key`). For example, registration uses
  `verify:<user_id>` and mass email `mass:<batch>:<user_id>`.
- SMTP settings are read on **every** tick, so edits apply without a restart.
- Account-bound enqueue and claim transactions write the recipient's internal
  `email_lifecycle_fence` while it still owns the address. Immediately before
  SMTP, the worker takes the account's mail-handoff lease, then the account
  lifecycle lease just long enough to commit that same recipient write with a
  refresh of the sending generation. The lifecycle lease is released before
  SMTP, so a disable, sign-in or credential change never waits on a slow relay.
  The SMTP send budget starts once the lifecycle lease is held, so waiting for
  it never shortens the relay's time.
  Address release takes the mail-handoff lease before the lifecycle lease and
  writes the account before scanning the outbox, so new inserts and handoffs
  cannot escape cancellation by reading an old committed address. The sender
  holds the mail-handoff lease until SMTP settles or its connection is actually
  cancelled; a timeout destroys the owned socket and MIME source before
  settling the row.
- Messages rendered from the `verification` and `password_reset` templates
  carry a single-use link, so they are stored **sealed** (`email/sealed-outbox.ts`):
  one AES-256-GCM envelope bound to the row id and recipient, opened only by the
  worker just before it sends. See
  [security.md](security.md#queued-single-use-links-are-sealed).

Templates: nine keys (`EMAIL_TEMPLATE_KEYS` in `shared/src/constants.ts`),
each with a built-in default in `email/templates.ts` and an optional admin
override in `email_templates`. Resolution is override-first, never a mix.
`{{placeholder}}` values are HTML-escaped in `body_html`; subject and
`body_text` are plain text. Only variables named in `rawHtmlVars` (the
mass-email body) skip escaping.

### 7.1 Gateway teardown jobs

Disabling an account owes Edge a revocation (every ACL group off the consumer,
every credential deleted), and that cannot commit with the database write. So
the disable writes a `gateway_teardown_jobs` row **in the transaction that sets
`status = 'disabled'`**, runs the revocation immediately, and hands any failure
to `credentials/teardown-worker.ts`.

```
disable(tx) ──> gateway_teardown_jobs(pending) ──claim──> sending ──┬─> done
                                                                    └─> reschedule (pending, backoff)
                                                                        └─ retried until it lands
```

- One row per account (`user_id` is unique), so re-disabling resets the job.
- Backoff is `10s · 2^attempts`, capped at five minutes, plus jitter.
- **There is no `failed` state.** An undeliverable email can be dropped; a
  credential that still authenticates cannot. Retries continue while the
  account is disabled. Re-enabling deletes the job, and the worker drops any job
  whose account is no longer disabled.
- Success writes `user.gateway_teardown_complete` with the system as actor. An
  admin request whose immediate attempt succeeded writes the same row as that
  admin with `details.inline: true`.
- `POST /api/users/:id/gateway-teardown/retry` is the operator handle.

See [`security.md`](security.md#disabling-an-account) for why the disable may
commit ahead of the revocation.

---

## 8. Session and CSRF model

### 8.1 Sessions

- The session token is **opaque random material** (32 bytes, base64url), not a
  JWT.
- Only an **HMAC-SHA-256** of it is stored (`sessions.token_hash`), under a key
  HKDF-derived from `NEXUS_SECRET_KEY` with info `nexus-session-hmac-v1`. That
  key is separate from the settings-encryption key, so a leak of one cannot
  forge the other.
- The `nexus_session` cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and
  `Secure` unless `NEXUS_COOKIE_SECURE=false`.
- **Sliding expiry.** The row is rewritten only when less than half the TTL
  remains, and both cookies are then re-issued with a fresh `Max-Age`. Routes
  marked `sharedCacheable` (`GET /api/branding`) never slide, and any response
  that sets a cookie is forced to `Cache-Control: private, no-store` with
  `Vary: Cookie`.
- A session whose account is no longer active is deleted on the next request,
  along with every other session of that user.
- **Expired rows are purged** by `auth/expiry-sweep.ts`: expired sessions and
  email tokens, once at startup and then hourly. Reads already ignore them.
- **A single sign-on issues the same session.** `sso/service.ts` calls
  `auth.issueSession` inside the transaction that provisions, links or syncs
  the account, and the callback sets the cookie pair through the same helper
  as `POST /api/auth/login`. The only other cookie is `nexus_sso`, the sealed
  `state`/`nonce`/PKCE verifier of one attempt, scoped to `/api/auth/sso`
  (see [`security.md`](security.md#single-sign-on-openid-connect)).

### 8.2 CSRF

Double-submit, **bound to the session**:

```
X-Nexus-CSRF header  ==  nexus_csrf cookie  ==  sessions.csrf_token
```

All three must match, compared in constant time. The `nexus_csrf` cookie is
deliberately _not_ `HttpOnly`, so the SPA can read it.

The check runs on every mutating (non-`GET`/`HEAD`/`OPTIONS`) `/api` request
that carries a session. Only routes reached before a session exists are exempt
(`CSRF_EXEMPT_PATHS` in `middleware/auth-plugin.ts`; list in
[`api.md`](api.md)). **Logout is not exempt.** An anonymous mutation is
rejected by the route's own guard with `401`, not by CSRF.

---

## 9. Errors, validation and the API surface

Every non-2xx response is `{ error: { code, message, details? } }` with a code
from [`shared/src/error-codes.ts`](../shared/src/error-codes.ts). `NexusError`
takes its HTTP status from `ERROR_CODE_STATUS`; nobody passes a status by hand.
`middleware/error-handler.ts` is the only place an exception becomes a
response: 5xx is logged in full at error level, lower statuses at debug, and
unknown exceptions get a generic message.

Input is validated with zod through `parseOrThrow`, which turns a `ZodError`
into `VALIDATION_FAILED` with per-field `details`. `routes/common.ts` coerces
query strings once: `limit` must be in `[1, MAX_PAGE_SIZE]`, `offset` ≥ 0, and
query booleans are normalised.

List endpoints return `{ items, total }` (`Paginated<T>`), where `total`
ignores `limit`/`offset`. Visibility predicates are pushed into the query, not
applied to a fetched page. The catalog's rule (mine, granted to me, authorised
to read, or published and public) travels as `ApiFilter.visible_to`; the admin
inbox's "platform thread, or one I am in" as
`ThreadFilter.platform_or_participant_user_id`. So `offset` reaches past the
first page and `total` counts the whole permitted set.

A thread's transcript is the exception: it is cursor-paginated from the newest
end (`?limit=&before=`, returning a `MessagePage`), because new replies would
shift any offset.

Full reference: [`api.md`](api.md).

---

## 10. Where the invariants live

| Invariant                                   | Owner                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Role ordering and capability derivation     | `shared/src/roles.ts`, `auth/service.ts` (`capabilitiesFor`)                         |
| Error codes and their HTTP statuses         | `shared/src/error-codes.ts`                                                          |
| ACL group / consumer / listen-path naming   | `shared/src/constants.ts`                                                            |
| Session, sliding expiry, CSRF, RBAC guards  | `middleware/auth-plugin.ts`                                                          |
| Password hashing, settings encryption, HMAC | `lib/crypto.ts`                                                                      |
| Edge HTTP shape and error classification    | `ferrum-admin/client.ts`                                                             |
| Admin JWT claims                            | `ferrum-admin/jwt.ts`                                                                |
| Per-key serialisation and leases            | `lib/keyed-serializer.ts`, `lib/lease-fence.ts`, `credentials/consumers.ts`          |
| Audit action catalog and commit classes     | `audit/service.ts` — mirrored in [`security.md`](security.md#10-audit-event-catalog) |
| Catalog visibility                          | `catalog/service.ts` (`canList` / `canView`), `catalog/read-access.ts`               |
| Last-super-admin guard                      | `users/service.ts` and `admin/god-service.ts` (both, on purpose)                     |

### Proposed service-manifest intake

The preview service is composed in `server/src/index.ts` and injected into its route.
It compiles the exact vendored schema with the existing Zod dependency, refusing
unsupported schema keywords at startup. Validation precedes defaults; explicit nulls
are never interpreted as omission. Local presentation/reference budgets further narrow
accepted input. The configured Edge namespace is the authorization boundary for this
single-namespace portal. The service returns an allow-listed redacted DTO from `shared/`
and has no store, gateway, network or source-file reader dependency. The manifest format
remains PROPOSED; preview cannot invoke the publishing service or install agent policy.
