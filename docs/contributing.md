# Contributing

**The contributor guide lives at [`../CONTRIBUTING.md`](../CONTRIBUTING.md).**
Start there for prerequisites, setup, the checks to run before a PR, and the
ground rules.

This page adds the dev-docs detail that does not belong in a top-level
CONTRIBUTING file.

---

## Where things are documented

| Question                                           | Document                                   |
| -------------------------------------------------- | ------------------------------------------ |
| Why is the code shaped this way?                   | [`architecture.md`](architecture.md)       |
| What exactly does this endpoint accept and return? | [`api.md`](api.md)                         |
| How do I deploy, back up, or rotate a key?         | [`operations.md`](operations.md)           |
| What is the threat model? What audit events exist? | [`security.md`](security.md)               |
| How do I take it for a spin end to end?            | [`getting-started.md`](getting-started.md) |
| What do users actually see?                        | [`guides/`](guides/client-guide.md)        |

---

## Test layout

Tests are colocated `*.test.ts` files, run by `node --test` with the tsx
loader — there is no Jest or Vitest on the backend.

```bash
npm test                          # every workspace (shared builds first)
npm test --workspace server       # backend only
npm test --workspace web          # frontend only (vitest)

cd server && npx tsx --test src/publishing/oas.test.ts   # one file
```

`shared/` must be built before anything else typechecks or tests, because its
`package.json` points `main`/`types` at `dist/`. Every top-level script does
that for you; if you invoke a workspace script directly, run
`npm run build --workspace shared` first.

### Unit tests

Pure modules are tested directly, with no harness:

| File                                                                | Covers                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------- |
| `shared/src/roles.test.ts`, `constants.test.ts`                     | role ordering, ACL-group and consumer naming helpers    |
| `server/src/config/index.test.ts`                                   | env validation, defaults, the plaintext-http guard      |
| `server/src/lib/crypto.test.ts`                                     | scrypt round trip, AES-GCM blob format, HKDF separation |
| `server/src/ferrum-admin/jwt.test.ts`                               | the exact claim set, `aud` omission, cache refresh      |
| `server/src/ferrum-admin/client.test.ts`                            | error classification, `applied: false`, serialisation   |
| `server/src/publishing/oas.test.ts`                                 | spec parsing, upstream resolution, slugify              |
| `server/src/email/templates.test.ts`                                | placeholder interpolation and HTML escaping             |
| `server/src/email/outbox-worker.test.ts`                            | claim/retry/backoff/fail state machine                  |
| `server/src/db/adapters/sql-common.test.ts`, `sqlite/index.test.ts` | dialect shims, repo semantics                           |

### Integration tests

`server/src/test/helpers.ts` boots the **real** Fastify app on an in-memory
SQLite database, talking to a **real** in-process mock gateway over HTTP.
Nothing above the network boundary is stubbed, so route wiring, the auth
plugin, CSRF, the error handler and the store are exercised exactly as in
production.

`server/src/test/` covers auth and sessions, the RBAC matrix,
first-user-super-admin, the publishing flow, request → approve → ACL group
added, revoke → group removed, credential show-once and rotation, outbox
retry/backoff, admin settings encryption round trip, mass email, messaging,
notifications, god mode and the last-super-admin guard.

The harness exposes what a test needs to be deterministic: `BuildServerDeps`
substitutes the store, the Edge client, the mail transport, the CAPTCHA
transport and the post-registration hook, and the outbox timer is off under
`NEXUS_ENV=test` so a test drives `services.outbox.tick()` by hand and no timer
fires mid-assertion.

## The mock Ferrum Edge

`server/src/test/mock-ferrum-edge.ts` is a real `node:http` server, not a fetch
stub, so the undici dispatcher, timeouts, headers and JSON handling in
`ferrum-admin/client.ts` are all genuinely exercised. It implements the subset
of the Admin API that Nexus uses, closely enough that a test failing against it
would very likely fail against a real gateway:

- HS256 admin JWT verification with the required `iss`/`sub`/`iat`/`nbf`/
  `exp`/`jti`/`role` claims, and an `aud` claim **rejected** unless the mock was
  configured with an audience;
- `X-Ferrum-Namespace` scoping on every namespaced route;
- consumers with one unique keyspace across `id`/`username`/`custom_id`, `PUT`
  whole-resource replace with the credential-preservation rules, and the closed
  read projection — `keyauth.key` and `jwt.secret` become `[REDACTED]`,
  `basicauth` is omitted entirely;
- credentials: `POST` appends (capped), `PUT` replaces,
  `DELETE /{type}` and `DELETE /{type}/{index}`;
- flat `{"error": "..."}` error bodies.

Every request is recorded in `MockFerrumEdge.requests`, so a test can assert
not just the outcome but the exact gateway calls that produced it — which is
how the "did the approval really add the ACL group?" tests work.

If you change anything in `ferrum-admin/`, check whether the mock still
reflects the real Admin API. A mock that drifts optimistic is worse than no
mock.

## Cross-adapter smoke tests

`server/src/test/smoke.test.ts` runs the core happy path against SQLite always,
and against the other three when a URL is exported:

```bash
export NEXUS_TEST_POSTGRES_URL=postgres://nexus:nexus@127.0.0.1:5432/nexus_test
export NEXUS_TEST_MYSQL_URL=mysql://nexus:nexus@127.0.0.1:3306/nexus_test
export NEXUS_TEST_MONGO_URL='mongodb://127.0.0.1:27017/nexus_test?replicaSet=rs0'
npm test --workspace server
```

**Always do this when touching `server/src/db/adapters/`.** A new store method
implemented in three adapters out of four typechecks fine and fails only at
runtime, on whichever backend the reviewer does not run.

The Mongo URL must point at a replica set — a standalone `mongod` is rejected
at `init()` unless `NEXUS_DB_ALLOW_STANDALONE=true`, and the transactional
paths the smoke test exercises are exactly what standalone cannot do.

## Adding things

| Task                 | Steps                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A route              | Register it in the right file under `server/src/routes/`, wire any new service in `server/src/index.ts`, add the client call in `web/src/lib/api.ts`, add the DTO in `shared/src/api-contract.ts`, document it in [`api.md`](api.md). |
| A service            | `<domain>/service.ts` exporting `create<Domain>Service(deps)`, constructed in the composition root and handed to its route plugin. Never import a service from a route file.                                                          |
| A DB column or table | New migration under `server/src/db/migrations/` (`.sql`, `.pg.sql`, `.mysql.sql`), update `NexusStore`, implement in **all four** adapters, run the cross-adapter smoke tests.                                                        |
| An Edge call         | Only in `server/src/ferrum-admin/`. Extend the mock too.                                                                                                                                                                              |
| An audit event       | Append to `AuditAction` in `server/src/audit/service.ts` **and** to the catalog in [`security.md`](security.md#10-audit-event-catalog).                                                                                               |
| An error code        | Append to `shared/src/error-codes.ts` (never rename one — they are public contract), add its status to `ERROR_CODE_STATUS`, and add a row to the table in [`api.md`](api.md#error-envelope-and-codes).                                |

## A note on `lint`

`npm run lint` is `tsc --noEmit`. There is no ESLint in this repo — formatting
is Prettier (`npm run format`, checked in CI with `npm run format:check`) and
correctness is TypeScript strict mode. Do not add `any` without an
escape-hatch comment explaining why.
