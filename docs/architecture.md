# Architecture

Ferrum Nexus is a Backend-for-Frontend (BFF) that sits in front of a
[Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge) gateway. Edge owns
runtime gateway state — proxies, upstreams, plugins, consumers, credentials.
Nexus owns everything a _portal_ needs and a gateway has no opinion about:
accounts, roles, the approval workflow, audit history, branding, messaging,
notifications, and the user-facing API catalog.

This document is for an engineer who is about to change the code. It explains
the boundaries, the composition pattern, the persistence contract, and the
handful of Ferrum Edge behaviours that shaped the design.

- REST reference: [`api.md`](api.md)
- Deployment and operations: [`operations.md`](operations.md)
- Threat model and audit catalog: [`security.md`](security.md)
- Contributor workflow: [`contributing.md`](contributing.md)

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

Three rules define the boundary, and every change has to keep all three true:

1. **The browser never holds a gateway credential of any kind.** It has a Nexus
   session cookie. The Ferrum Edge Admin API is reached only from the server
   process, with a JWT the browser can neither see nor influence.
2. **Every gateway mutation is authorised and recorded first.** A request
   arrives → the session is resolved → CSRF is checked → the route's role guard
   runs → the service checks row-level ownership → the Edge call is made → an
   `audit_logs` row is written. Skipping any step is a bug, not a shortcut.
3. **Nexus never echoes upstream text to a browser.** Edge's flat
   `{"error": "..."}` bodies can carry operator-facing configuration detail, so
   `ferrum-admin/client.ts` logs them and returns a generic `EDGE_ERROR` /
   `EDGE_UNAVAILABLE` to the caller.

The only unauthenticated read in the whole API is `GET /api/branding`, which
exists so the login page can render with the right name, logo and colours
before a session exists. It carries the CAPTCHA _site_ key and never the
vendor secret.

---

## 2. Workspace and module map

npm workspaces, in build-dependency order. `shared/` points `main`/`types` at
`dist/`, so it must be built before anything else typechecks.

```
shared/    zero-dependency TypeScript: roles, error codes, wire entities,
           request/response DTOs, naming helpers (ACL groups, consumer
           usernames, listen paths). Imported by BOTH server and web, which is
           what keeps the contract from drifting.
server/    Fastify 5 BFF. Everything below.
web/       React 19 SPA (Vite, TanStack Router/Query/Table, Radix, Tailwind v4).
docker/    Dockerfile + docker-compose.example.yml
docs/      this tree
```

### `server/src`

| Path                                           | Responsibility                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `index.ts`                                     | Composition root: `buildServer(config, deps)` + `main()`. No business logic.                           |
| `config/index.ts`                              | The **only** reader of `process.env`. zod-validated into `NexusConfig`.                                |
| `lib/`                                         | `crypto.ts` (all cryptography), `errors.ts` (`NexusError` + helpers), `ids.ts`, `logger.ts`.           |
| `db/store.ts`                                  | The `NexusStore` interface: 17 repositories plus `init`/`migrate`/`close`/`healthCheck`/`transaction`. |
| `db/adapters/{sqlite,postgres,mysql,mongodb}/` | The four implementations.                                                                              |
| `db/adapters/sql-common.ts`, `sql-repos.ts`    | Dialect shims and the repo bodies shared by PG + MySQL.                                                |
| `db/migrations/`                               | `NNN_name.sql` (SQLite), `.pg.sql`, `.mysql.sql`. Mongo builds collections and indexes in code.        |
| `ferrum-admin/`                                | The **only** module that knows the Edge HTTP shape: `client.ts`, `jwt.ts`, `types.ts`.                 |
| `middleware/auth-plugin.ts`                    | Session resolution, sliding expiry, CSRF double-submit, RBAC guards.                                   |
| `middleware/error-handler.ts`                  | The single place an exception becomes an HTTP response.                                                |
| `audit/service.ts`                             | The only writer of `audit_logs`, plus the `AuditAction` catalog.                                       |
| `auth/`                                        | `service.ts` (register/login/logout/verify), `captcha.ts`.                                             |
| `users/service.ts`                             | Profile self-service, admin user management, organizations.                                            |
| `catalog/service.ts`                           | Browse and read permissions; `canList` vs `canView`.                                                   |
| `publishing/`                                  | `service.ts` (Edge proxy + plugin lifecycle), `oas.ts` (pure spec parsing).                            |
| `access/service.ts`                            | request → approve/deny → grant → revoke, and the ACL-group writes.                                     |
| `credentials/`                                 | `service.ts` (show-once issue/rotate/revoke), `consumers.ts` (the provisioner).                        |
| `messaging/service.ts`                         | 1:1 threads and the platform inbox.                                                                    |
| `notifications/service.ts`                     | The header bell. Courtesy channel only — never the record.                                             |
| `email/`                                       | `service.ts` (render + enqueue), `outbox-worker.ts` (the only SMTP caller), `templates.ts`.            |
| `admin/`                                       | `settings-service.ts`, `mass-email-service.ts`, `god-service.ts`.                                      |
| `routes/`                                      | One plugin per domain. Routes validate shapes and delegate; they never import a service module.        |
| `test/`                                        | `helpers.ts` boots the real app on in-memory SQLite; `mock-ferrum-edge.ts` is a real HTTP server.      |

### `web/src`

Pages under `routes/` (public: `LoginPage`, `RegisterPage`, `VerifyEmailPage`;
authenticated: `DashboardPage`, `CatalogPage`, `CatalogDetailPage`,
`CredentialsPage`, `MessagesPage`, `MessageThreadPage`, `ProfilePage`,
`ApisPage`, `ApiNewPage`, `ApiDetailPage`; admin: `AdminUsersPage`,
`AdminOrgsPage`, `AdminApisPage`, `AdminAuditPage`, `AdminSettingsPage`,
`AdminMassEmailPage`, `AdminGodPage`). The route tree lives in `router.tsx`;
`components/layout/nav.ts` is the single source of truth for which role sees
which destination, read by both the sidebar and the route guards.

---

## 3. The composition root

`server/src/index.ts` is the only file that constructs anything. Services take
an explicit dependency object; none of them reads `process.env`, opens a
socket, or imports another service's module for a side effect.

Adding a feature is three edits:

1. write `<domain>/service.ts` exporting `create<Domain>Service(deps)`;
2. construct it in the `COMPOSITION — services` block;
3. register its route plugin in `COMPOSITION — routes`, passing the service
   through the registration options.

```ts
await app.register(async (scope) => scope.register(credentialsRoutes, { credentials }), {
  prefix: '/api/credentials',
});
```

Why this shape:

- **Routes are trivially testable and impossible to couple.** A route file
  imports types and its own zod schemas. There is no import edge from
  `routes/*` to `*/service.ts`, so a route cannot reach a service it was not
  handed.
- **Tests substitute at the seams that matter.** `BuildServerDeps` lets a test
  swap the store, the Edge client, the mail transport, the CAPTCHA transport
  and the post-registration hook, and turn the outbox timer off so
  `services.outbox.tick()` runs one deterministic cycle.
- **One provisioner, shared.** `credentials` and `access` both mutate the same
  Edge consumer, so `createConsumerProvisioner(...)` is built once and passed
  to both — that is what puts every consumer write behind the same per-consumer
  queue (§5.2).

Ordering inside the block is dependency order: audit → captcha → email →
notifications → auth → settings → users → messaging → massEmail → provisioner
→ catalog → credentials → publishing → access → god → outbox.

---

## 4. Persistence: `NexusStore` and four adapters

**Rule: no service module ever touches a database driver.** All persistence
goes through the `NexusStore` interface in
[`server/src/db/store.ts`](../server/src/db/store.ts). Adding a query means
adding it to the interface and implementing it in **all four** adapters. The
cross-adapter smoke test exists to catch a missed one.

```
NexusStore
├── sqlite/index.ts      reference implementation (better-sqlite3, synchronous)
├── postgres/index.ts ─┐
├── mysql/index.ts   ──┴─> sql-common.ts (dialect shims) + sql-repos.ts (bodies)
└── mongodb/index.ts     one collection per logical table
```

### 4.1 String UUIDs, ISO-8601 strings

Every `id` is a `crypto.randomUUID()` string and every timestamp is an
ISO-8601 string, stored as text on all four backends. That is the reason one
logical schema works everywhere with no ID-type conversion in service code: a
record read from Mongo is indistinguishable from one read from SQLite. MySQL is
configured with `dateStrings: true` and timestamps live in `VARCHAR` columns,
never `DATETIME`, so there is nothing for a driver to reinterpret.

### 4.2 The SQLite adapter is the reference

better-sqlite3 is synchronous, so every repo method returns an already-settled
promise. Because a synchronous driver cannot hold `BEGIN` open across an
`await`, `transaction()` funnels bodies through a per-connection promise queue:
one body at a time, `BEGIN IMMEDIATE` before it, `COMMIT` on resolve,
`ROLLBACK` on reject, and a nested call joins the running transaction rather
than starting a second one. The other three adapters must present that same
contract using their native primitive.

Pragmas on open: `foreign_keys = ON`, `busy_timeout = 5000`, and for
file-backed databases `journal_mode = WAL` + `synchronous = NORMAL`.

### 4.3 PostgreSQL and MySQL share one repo file

`sql-repos.ts` contains the seventeen repositories written **once**, against a
single portable SQL text; `sql-common.ts` absorbs the differences:

- positional `?` placeholders, rewritten to `$1 … $n` for `pg`;
- `"double quoted"` identifiers, rewritten to backticks for MySQL (only
  `"key"` genuinely needs it — `KEY` is reserved in MySQL, not in PostgreSQL);
- `POSITION(? IN lower(coalesce(col, '')))` for case-insensitive substring
  filters, which sidesteps `LIKE … ESCAPE '\'` — the one construct whose
  literal spelling differs, because MySQL treats backslash as an escape inside
  string literals and PostgreSQL does not.

Row decoding mirrors the SQLite adapter exactly: 0/1 becomes real booleans,
`*_json` columns come back parsed, absent columns come back `null` (never
`undefined`). Each adapter supplies only an executor (a pool, or a checked-out
transaction connection) plus lifecycle; neither adds query logic.

The SQLite adapter deliberately does _not_ share these bodies — it is
synchronous underneath, and wrapping every statement to fit a `Promise`-shaped
repo would make the reference implementation worse to read.

### 4.4 MongoDB

One collection per logical table, same names as the SQL migrations
(`users`, `apis`, `api_specs`, `access_requests`, `grants`, `consumers`,
`credential_metadata`, `message_threads`, `messages`, `notifications`,
`email_outbox`, `audit_logs`, `app_settings`, `email_templates`,
`email_verification_tokens`, `organizations`, `sessions`). Four documented
physical differences:

1. `_id` holds the string UUID; the mappers are the only place `_id` and `id`
   meet. For `app_settings`, `_id` _is_ the setting key.
2. Booleans and structured values are stored natively (`rate_limit`, audit
   `details`, setting `value` are BSON documents, not JSON text), normalised on
   write so an absent nested field behaves like a JSON round trip would.
3. `organizations.name_lower` and `apis.slug_lower` are derived fields carrying
   what SQLite indexes as `lower(...)`, because MongoDB has no expression
   indexes. They never leave the adapter. `users.email` needs no companion —
   it is lowercased on write, as in the SQL adapters.
4. Partial unique indexes use `partialFilterExpression`, which lines up
   one-for-one with SQLite's `CREATE UNIQUE INDEX … WHERE …`.

**Replica set required.** `init()` probes with `hello` and refuses to start
against a standalone `mongod` unless `NEXUS_DB_ALLOW_STANDALONE=true`, because
credential rotation and grant approval both depend on real multi-document
transactions. With the opt-in, `transaction()` degrades to sequential
execution — the body still runs and is still serialised, but a throw part-way
through leaves earlier writes in place. That is an evaluation mode, not a
supported production configuration. See
[`operations.md`](operations.md#mongodb).

### 4.5 Migrations

`db/migrate.ts` owns ordering, idempotency and "already applied"; adapters
supply three primitives (`ensureMigrationsTable`, `listApplied`,
`applyMigration`). Applied ids are recorded in `schema_migrations`. The numeric
prefix plus description (`001_initial`) is the id, shared across dialects, so
the same logical migration can never be applied twice on one database.

---

## 5. Ferrum Edge integration

Everything that knows Edge's HTTP shape lives in `server/src/ferrum-admin/`.
Above it, the codebase deals in domain objects and `NexusError`s.

### 5.1 The admin JWT contract

Edge verifies HS256 tokens and rejects one that is missing any required claim.
`jwt.ts` mints exactly:

| Claim          | Value                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `alg` (header) | `HS256`                                                                                                             |
| `iss`          | `FERRUM_ADMIN_JWT_ISSUER` — **must equal the gateway's configured issuer** (default `ferrum-edge`)                  |
| `sub`          | `ferrum-nexus` by default; overridden per call with the acting Nexus user id, so Edge's own audit log names a human |
| `iat`, `nbf`   | now (identical)                                                                                                     |
| `exp`          | `iat + FERRUM_ADMIN_JWT_TTL` (default 60s; Edge caps at 3600)                                                       |
| `jti`          | fresh UUID                                                                                                          |
| `role`         | `admin`                                                                                                             |
| `aud`          | **omitted unless** `FERRUM_ADMIN_JWT_AUDIENCE` is set — an unexpected `aud` is rejected outright                    |

Tokens are cached in a 256-entry LRU keyed by every signing input (the secret
is hashed into the key, never stored in it) and re-minted once the remaining
lifetime drops below `min(60, ttl / 4)` seconds. The namespace goes on every
namespace-scoped call as `X-Ferrum-Namespace`, which overrides any `namespace`
in the body.

Failures classify into exactly two codes: `EDGE_UNAVAILABLE` (DNS, connect,
TLS, socket, timeout — nothing reached the gateway) and `EDGE_ERROR` (the
gateway answered non-2xx). A `503` carrying `applied: false` is special: the
write **is durable**, it just is not live yet. It surfaces as `EDGE_ERROR` with
an explicit message and is never retried automatically, because a blind retry
of a create would `409`.

### 5.2 `serializePerKey`, and the concurrency hazard it fixes

`PUT /consumers/{id}` on the Admin API is a **whole-resource replace with no
concurrency token**. There is no ETag, no `If-Match`, no version field. Two
concurrent read-modify-write round trips against the same consumer therefore
both read the pre-change state and one silently overwrites the other:

```
t0  approve API-A: GET consumer -> acl_groups = []
t0  approve API-B: GET consumer -> acl_groups = []
t1  approve API-A: PUT acl_groups = [nexus:api:A:approved]
t2  approve API-B: PUT acl_groups = [nexus:api:B:approved]   <-- A is gone
```

Nexus lost a grant it believes it made, and the user gets a 403 from the
gateway on an API the portal shows as approved.

The fix is `edge.serializePerKey(consumerId, fn)` — an in-process promise queue
keyed by consumer id. Independent consumers still run concurrently; the same
consumer never has two in-flight mutations. **Every** consumer write goes
through it: ACL-group changes (via `ConsumerProvisioner.mutateAclGroups`),
credential appends, and credential deletes. A rotation also re-reads the
consumer _inside_ the serialised block, so the array length it checks and the
index it deletes cannot drift apart.

There is a second reason the body must be built from a fresh `GET`: omitting
`keyauth` or `jwt` from a `PUT` body **deletes those credentials**. The
provisioner always echoes `current.credentials` back, redacted placeholders and
all.

> **Multi-instance caveat.** This serialises within one Node process. A
> horizontally scaled Nexus needs sticky routing per consumer or an external
> lock; until then, run one writer. See
> [`operations.md`](operations.md#8-scaling).

### 5.3 The plugin naming trap

Edge's _plugin_ names and its _credential-type_ keys are deliberately
different, and mixing them up produces a credential that authenticates nothing:

| Nexus `auth_plugin` | Edge plugin name | Edge credential key (`Consumer.credentials`) |
| ------------------- | ---------------- | -------------------------------------------- |
| `key_auth`          | `key_auth`       | `keyauth`                                    |
| `basic_auth`        | `basic_auth`     | `basicauth`                                  |
| `jwt_auth`          | `jwt_auth`       | `jwt`                                        |

Note the underscore. The plugin is `key_auth`; the credential bucket is
`keyauth`. `CREDENTIAL_TYPE_FOR_PLUGIN` in
[`shared/src/constants.ts`](../shared/src/constants.ts) is the single mapping —
never hand-write either spelling.

Plugin configs are closed key sets; a typo is a 400. What Nexus sends:

- **auth plugins** — `{}` for all three. `key_auth` defaults to
  `header:X-API-Key` + `hide_credentials: true`, which is exactly what the
  portal documents; `basic_auth`'s config **must** be `{}` or `null`;
  `jwt_auth` defaults to `token_lookup: header:Authorization` and
  `consumer_claim_field: sub`.
- **`access_control`** — `{ allowed_groups: ['nexus:api:<api_id>:approved'] }`,
  and nothing else. Never `allowed_consumers`.
- **`rate_limiting`** — `limit_by: 'consumer'`, `expose_headers: true`, and a
  `limits` array with exactly one `scope: "default"` entry using the
  custom-window pair (`window_seconds` + `max_requests`). Edge also offers a
  preset trio (`requests_per_second|minute|hour`); mixing the two families in
  one rule is a 400, so Nexus only ever uses the custom pair.

Plugins attach as `{ plugin_name, scope: 'proxy', proxy_id, enabled, config }`.
Nexus stores the proxy id on the `apis` row but **not** the plugin config ids —
they are looked up with `GET /plugins/config` filtered by `proxy_id` whenever
they need changing, which keeps the schema free of ids whose lifecycle Nexus
does not own and reconciles automatically if an operator recreates one by hand.

### 5.4 One consumer per user per namespace

Each Nexus account maps to exactly one Edge consumer in the configured
namespace:

- `username` = `nexus-user-<user_id>` (`consumerUsernameForUser`). Never derived
  from anything user-editable — `access_control` matches usernames
  byte-for-byte.
- `custom_id` = the raw Nexus user id, giving operators a reverse lookup from
  the gateway back into the portal.
- `id` is assigned by Edge and cached in the `consumers` table, so the hot paths
  never scan `GET /consumers`.

The provisioner is lazy: the consumer is created the first time a user is
approved for an API _or_ issues a credential, whichever comes first. If a
consumer exists on the gateway without a Nexus row — a database restore, say —
`ensureConsumer` finds it by username and re-caches it rather than 409-ing on a
re-create.

Providers also get a disposable **test consumer** per API, `nexus-test-<api_id>`,
carrying that API's ACL group and one credential of the API's auth type.
Recreating it deletes and replaces it, because deleting is the only way to reset
its show-once state.

### 5.5 The ACL group flow

One ACL group per API, held on the requester's consumer. The `access_control`
plugin on the proxy is written **once**, at publish time, and never touched
again — approvals contend on one consumer row instead of on a plugin config
shared by every approved user.

```
                 client                     provider/admin                Ferrum Edge
                   │                              │                            │
 POST /api/access-requests                        │                            │
  {api_id, justification}                         │                            │
                   │──── access_requests row ─────┤                            │
                   │      status = pending        │                            │
                   │                              │                            │
                   │      POST /api/access-requests/:id/approve                │
                   │                              │                            │
                   │                              │  serializePerKey(consumer):│
                   │                              │  GET  /consumers/{id}      │
                   │                              │  acl_groups += ────────────┤
                   │                              │    nexus:api:<api_id>:approved
                   │                              │  PUT  /consumers/{id} ─────┤
                   │                              │                            │
                   │      grants row (active) + request -> approved            │
                   │      in ONE store transaction                             │
                   │                                                           │
                   │   the proxy's access_control plugin already says:          │
                   │   allowed_groups = [nexus:api:<api_id>:approved]           │
                   v                                                           v
             calls now pass                                        gateway authorises
```

Revocation is the mirror image: `acl_groups -= group`, then flip the grant to
`revoked` (and drag the originating request to `revoked` too, so the
requester's history reads "approved, then revoked").

**Ordering is deliberate: the gateway write happens _before_ the grant row is
committed.** If Edge fails, no grant exists and the request stays pending,
which the provider can simply retry. The reverse order would leave Nexus
claiming an access the gateway would reject — a lie the UI cannot detect.
Revocation is idempotent: a user with no consumer never had the group, so
there is nothing to remove.

### 5.6 Publishing: a multi-write sequence with no transaction

Edge has no cross-resource transaction, so `publish` creates the proxy, then
each plugin config, and **rolls back what it created** (delete plugin configs,
then the proxy) if any step fails, before rethrowing. The Nexus rows are
written last, so a failed publish leaves nothing behind on either side.

```
apis row ─┬─ proxy          name `nexus-<slug>`, listen_path `/<namespace>/<slug>`
          ├─ plugin_config  the auth plugin (key_auth | basic_auth | jwt_auth)
          ├─ plugin_config  access_control    — only when `requestable`
          └─ plugin_config  rate_limiting     — only when a rate limit is set
```

The upstream comes from the provider's explicit `upstream_url`, else the
document's first _absolute_ `servers[].url`. Relative server URLs are legal
OpenAPI but unusable as a backend, so they yield no upstream and the provider
must supply one.

**Retire ≠ delete.** `status: 'retired'` is a catalog state only: the proxy and
its plugins are untouched, existing grants keep working, and the API stops
appearing in the catalog for anyone but its owner, its grantees and admins.
Retiring must never silently break an integration already in production.
`DELETE /api/apis/:id` is the destructive path — it revokes grants, strips ACL
groups, tears down the Edge objects and removes the rows.

---

## 6. Show-once credentials

Nexus generates the secret, returns it in exactly one HTTP response, and stores
only a SHA-256 fingerprint and the last four characters in
`credential_metadata`. **Edge enforces the same thing independently**: every
ordinary Admin API read redacts `keyauth.key` and `jwt.secret` to the literal
`[REDACTED]` and omits `basicauth` entirely. There is no read path back to the
plaintext on either side.

Two consequences of Edge's schemas that a portal would otherwise get wrong:

- **`basicauth` has no username field.** The entry accepts exactly one of
  `password` / `password_hash`; the lookup key is the _consumer's_ `username`.
  So the username shown to the user is `nexus-user-<id>` — inventing a
  per-credential name would produce a credential that cannot authenticate.
- **`jwt` has no key/kid field.** The entry is exactly `{ secret }` (32–4096
  chars) and `additionalProperties: false` rejects `algorithm`, `kid` and
  friends. The consumer is located from `jwt_auth`'s `consumer_claim_field`
  (default `sub`), matched against the consumer's username/id/custom_id. So
  `ShowOnceSecret.jwt_key` carries the **consumer username** — the value the
  client must put in `sub`.

### 6.1 Locating an entry to delete

Edge gives credential entries **no id**, and reads redact the material, so
there is nothing on the wire to match a specific entry against. What is stable
is _ordering_: `POST` appends, `DELETE /{type}/{index}` removes by 0-based
index (the array re-indexes), and Nexus writes one `credential_metadata` row
per append. The non-revoked rows for a `(consumer, type)` pair, oldest first,
are a mirror of the Edge array — a row's position in that list is its index.

`resolveCredentialIndex` computes that position and cross-checks it against the
live array length read inside the same serialised block. On a mismatch (someone
hand-edited the consumer) it degrades to deleting the whole credential type
when only one row is live, and otherwise **refuses** rather than deleting
somebody else's key.

### 6.2 Rotation sequence

```
POST /api/credentials/:id/rotate
  │
  └─ serializePerKey(consumer):
       GET /consumers/{id}                      fresh view, same critical section
       rows      = live credential_metadata rows for (consumer, type), oldest first
       position  = index of the target
       appendFirst = (edge array length < FERRUM_MAX_CREDENTIALS_PER_TYPE)

       if appendFirst:                          the normal path
         POST   /consumers/{id}/credentials/{type}   -> new secret, returned once
         DELETE /consumers/{id}/credentials/{type}/{position}
              (POST appends, so the old entry's index is unchanged)
       else:                                    already at the gateway cap
         DELETE /consumers/{id}/credentials/{type}/{position}
         POST   /consumers/{id}/credentials/{type}   -> new secret, returned once

       old row -> status 'revoked', new row -> rotated_from_id = old id
```

Append-then-delete keeps both secrets live across the hand-off, which is the
whole point of a rotation. At the cap there is no room to append, so the old
entry has to go first — briefly leaving the account with no working credential
of that type. Raising `FERRUM_MAX_CREDENTIALS_PER_TYPE` (and the matching
gateway setting) above 1 avoids that window.

---

## 7. Email: the outbox

**Nothing in Nexus sends mail inline.** Every message is rendered by
`EmailService` and inserted into `email_outbox`; `outbox-worker.ts` drains the
queue out of band. That keeps a slow or broken relay from turning an approval
into a 502, and gives retries somewhere to live.

```
service ──enqueue──> email_outbox(pending) ──claim──> sending ──┬─> sent
                                                                └─> reschedule (pending, backoff)
                                                                    └─ after 5 attempts -> failed
```

- The claim is an atomic `pending → sending` flip that also increments
  `attempts`, so two workers never claim the same row.
- Backoff is `30s · 2^attempts`, capped at one hour, plus up to 10% jitter.
  `OUTBOX_MAX_ATTEMPTS` is 5.
- A `sending` row untouched for five minutes is assumed to belong to a crashed
  worker and is released on the next `start()`.
- **With SMTP unconfigured the worker claims nothing.** The transport factory
  returns `null` and queued mail waits in `pending` until an admin fills the
  settings in, rather than being burned through five retries and marked
  `failed`.
- `enqueue` is at-most-once when given an `idempotencyKey` — a unique index on
  `email_outbox.idempotency_key` does the work. Verification mail uses
  `verify:<user_id>`; mass email uses `mass:<batch>:<user_id>`.
- The worker asks the email service for SMTP settings on **every** tick, so an
  admin editing them takes effect on the next poll without a restart.

Templates: seven keys, each with a built-in default in `email/templates.ts` and
an optional admin override in `email_templates`. Resolution is override-first,
default-second, never a mix. `{{placeholder}}` values are HTML-escaped in
`body_html`; subject and `body_text` are plain text and interpolated verbatim.
Only variables explicitly named in `rawHtmlVars` (the mass-email body) skip
escaping.

---

## 8. Session and CSRF model

### 8.1 Sessions

- The session token is **opaque random material** (32 bytes, base64url), not a
  JWT. Nothing about the user is encoded in it.
- Only an **HMAC-SHA-256** of the token is stored (`sessions.token_hash`), under
  a key HKDF-derived from `NEXUS_SECRET_KEY` with info
  `nexus-session-hmac-v1` — separate from the settings-encryption key, so a
  leak of one cannot forge the other.
- The cookie `nexus_session` is `HttpOnly`, `SameSite=Lax`, `Path=/`, and
  `Secure` when `NEXUS_TRUST_PROXY=true`.
- **Sliding expiry.** Every request extends the session, but the row is only
  written when less than half the TTL remains, so a busy SPA does not issue one
  `UPDATE` per request.
- A session whose account was disabled or deleted is destroyed on the next
  request, along with every other session for that user.

### 8.2 CSRF

Double-submit **bound to the session**, which is stronger than plain
double-submit:

```
X-Nexus-CSRF header  ==  nexus_csrf cookie  ==  sessions.csrf_token
```

All three must match, compared in constant time. The `nexus_csrf` cookie is
deliberately _not_ `HttpOnly` — the browser has to read it to echo it back.

The check runs on every mutating (`non-GET/HEAD/OPTIONS`) `/api` request that
carries a session. Exempt paths are only those reached before a session exists:
`/api/auth/login`, `/api/auth/register`, `/api/auth/verify-email`,
`/api/auth/captcha`. **Logout is not exempt** — signing someone out is a state
change like any other. An anonymous mutation is rejected by the route's own
guard with `401`, not by CSRF, because there is no session-bound token to
compare against yet.

---

## 9. Errors, validation and the API surface

Every non-2xx response is `{ error: { code, message, details? } }` with a
stable code from [`shared/src/error-codes.ts`](../shared/src/error-codes.ts).
`NexusError` looks its HTTP status up from `ERROR_CODE_STATUS`; nobody passes a
status by hand. `middleware/error-handler.ts` is the only place an exception
becomes a response: 5xx is logged in full and answered generically, sub-500 is
logged at debug and answered with its own message.

Input validation is zod, always through `parseOrThrow`, which converts a
`ZodError` into `VALIDATION_FAILED` with per-field `details`. Query strings are
coerced once in `routes/common.ts` (`limit`/`offset` clamped to
`[1, MAX_PAGE_SIZE]`, query booleans normalised) rather than in each handler.

List endpoints share one envelope, `{ items, total }`, where `total` ignores
`limit`/`offset`. Two endpoints scan a bounded page and filter in memory
instead of pushing the predicate into SQL — the catalog (visibility depends on
per-row grants) and the admin thread list (the platform inbox has no
`ThreadFilter` predicate). Both are capped at `MAX_PAGE_SIZE` rows and both are
human-sized surfaces by construction.

Full reference: [`api.md`](api.md).

---

## 10. Where the invariants live

If you are changing something, these are the files that own the rules:

| Invariant                                  | Owner                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Role ordering and capability derivation    | `shared/src/roles.ts`, `auth/service.ts` (`capabilitiesFor`)                         |
| Error codes and their HTTP statuses        | `shared/src/error-codes.ts`                                                          |
| ACL group / consumer / listen-path naming  | `shared/src/constants.ts`                                                            |
| Session, sliding expiry, CSRF, RBAC guards | `middleware/auth-plugin.ts`                                                          |
| Every cryptographic decision               | `lib/crypto.ts`                                                                      |
| Edge HTTP shape and error classification   | `ferrum-admin/client.ts`                                                             |
| Admin JWT claims                           | `ferrum-admin/jwt.ts`                                                                |
| Consumer serialisation                     | `ferrum-admin/client.ts` (`createKeyedSerializer`) + `credentials/consumers.ts`      |
| Audit action catalog                       | `audit/service.ts` — mirrored in [`security.md`](security.md#10-audit-event-catalog) |
| Catalog visibility                         | `catalog/service.ts` (`canList` / `canView`)                                         |
| Last-super-admin guard                     | `users/service.ts` and `admin/god-service.ts` (both, on purpose)                     |
