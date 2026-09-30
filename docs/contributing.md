# Contributing: tests and recipes

Start with [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for prerequisites, setup, the checks to run
before a PR, and the ground rules. This page explains how the test suites work and lists the steps
for common changes.

## Dependency updates

The root `package.json` `allowScripts` map uses version-qualified keys for `esbuild`. When an
esbuild update changes a version, update its matching `esbuild@<version>` key as part of the same
change. Grouped Dependabot updates may require this manual refresh because the allowlist is separate
from the dependency manifest.

## Where things are documented

| Question                                           | Document                                   |
| -------------------------------------------------- | ------------------------------------------ |
| Why is the code shaped this way?                   | [`architecture.md`](architecture.md)       |
| What exactly does this endpoint accept and return? | [`api.md`](api.md)                         |
| How do I deploy, back up, or rotate a key?         | [`operations.md`](operations.md)           |
| What is the threat model? What audit events exist? | [`security.md`](security.md)               |
| How do I take it for a spin end to end?            | [`getting-started.md`](getting-started.md) |
| What do users actually see?                        | [`guides/`](guides/client-guide.md)        |

## Test layout

Tests are colocated `*.test.ts` files. The backend runs them with `node --test` and the tsx
loader (no Jest or Vitest); the web workspace uses Vitest. Commands are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#checks-to-run-before-a-pr).

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

`buildTestApp()` in `server/src/test/helpers.ts` boots the **real** Fastify app on an in-memory
SQLite database, talking over HTTP to a **real** in-process mock gateway. Nothing above the network
boundary is stubbed, so route wiring, the auth plugin, CSRF, the error handler, and the store run
exactly as in production.

`server/src/test/` covers, among much else: auth and sessions, the RBAC matrix, the founding
super admin and the last-super-admin guard, publishing, request → approve → ACL group added,
revoke → group removed, show-once credentials and rotation, outbox retry and backoff, settings
encryption, mass email, messaging, notifications, and god mode.

The harness makes tests deterministic:

- `BuildServerDeps` (in `server/src/index.ts`) lets a test substitute the store, the Edge client,
  the mail transport, the CAPTCHA transport, the upstream DNS resolver, and the post-registration
  hook.
- Under `NEXUS_ENV=test` the background workers (outbox, gateway teardown, expiry sweep, gateway
  reconciliation) do not start. A test calls `services.outbox.tick()` (and the others) itself, so
  nothing fires mid-assertion.

## The mock Ferrum Edge

`server/src/test/mock-ferrum-edge.ts` is a real `node:http` server, not a fetch stub, so the undici
dispatcher, timeouts, headers, and JSON handling in `ferrum-admin/client.ts` are genuinely
exercised. It implements the subset of the Admin API that Nexus uses, closely enough that a test
failing against it would very likely fail against a real gateway:

- HS256 admin JWT verification with the required `iss`/`sub`/`iat`/`nbf`/`exp`/`jti`/`role`
  claims. An `aud` claim is **rejected** unless the mock was configured with an audience.
- `X-Ferrum-Namespace` scoping on every namespaced route.
- Consumers: one unique keyspace across `id`/`username`/`custom_id`; `PUT` as a whole-resource
  replace with the credential-preservation rules; and the closed read projection (`keyauth.key`
  and `jwt.secret` become `[REDACTED]`, `basicauth` is omitted entirely).
- Credentials: `POST` appends (capped at 2 per type), `PUT` replaces, `DELETE /{type}` and
  `DELETE /{type}/{index}` remove.
- Flat `{"error": "..."}` error bodies.

Every request is recorded in `MockFerrumEdge.requests`, so a test can assert the exact gateway
calls behind an outcome. That is how the "did the approval really add the ACL group?" tests work.

If you change anything in `ferrum-admin/`, check that the mock still matches the real Admin API. A
mock that drifts optimistic is worse than no mock.

## Cross-adapter smoke tests

`server/src/test/smoke.test.ts` runs one behavioural suite against every store adapter. SQLite
always runs; each other backend runs when its URL is set and is skipped otherwise. Each run creates
a throwaway database with a random name and drops it afterwards, so the URL's user needs permission
to create databases.

```bash
export NEXUS_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:5432/postgres
export NEXUS_TEST_MYSQL_URL=mysql://root:pw@127.0.0.1:3306/mysql
export NEXUS_TEST_MONGO_URL='mongodb://127.0.0.1:27017/?replicaSet=rs0'
npm test --workspace server
```

**Always do this when touching `server/src/db/`.** A new store method implemented in three adapters
out of four typechecks fine and fails only at runtime, on whichever backend the reviewer does not
run. CI's `store-contracts` job runs this suite on all four backends, together with the MySQL
migration tests and the baseline-upgrade fixture.

The Mongo URL must point at a replica set (single-node is fine). A standalone `mongod` is rejected
at `init()` unless `NEXUS_DB_ALLOW_STANDALONE=true`, and the smoke suite's transaction cases need
real multi-document transactions.

## The acceptance suite

`e2e/` is the only place this repository tests against a **real** Ferrum Edge. The mock can only
confirm that Nexus sent the configuration it meant to send. The acceptance suite runs the
**packaged container image** against a digest-pinned Edge release and asserts by sending requests
to the gateway's **data-plane listener** and checking whether they reached the backend.

```bash
./e2e/run.sh              # stack up, suite, teardown
./e2e/run.sh dataplane    # the gateway matrix only
E2E_KEEP=1 ./e2e/run.sh   # leave the stack up afterwards
```

It runs as the `acceptance` job on every push to `main` and every pull request, and is a required
check. Run it locally for anything that changes what Nexus writes to Edge, the authentication or
credential contract, or the container image.

The Edge image is pinned by digest in one place, `release/compatibility.env`, so moving to a newer
Edge is a one-line change. See [e2e/README.md](../e2e/README.md) for overrides and what each half of
the suite asserts.

## The verbatim quickstart gate

The acceptance suite runs its own stack, but users run the README's full-stack Compose block, so
that block has its own gate:

- **`quickstart-gate.yml`** (`.github/workflows/`) checks out a release in a clean hosted runner,
  runs the lines between the README's `compose-quickstart` markers exactly as written, and follows
  the getting-started walkthrough to an authenticated request through the gateway
  ([release step](release-notes.md#release-step)). It runs on every `v*` tag push, on demand for any
  ref, and on pull requests that touch `README.md`, `docker/`, `release/`, or the gate itself.
- **The `quickstart-config` CI job** (`ci/check-compose-quickstart.sh`) runs on every push to
  `main` and every pull request. It requires exactly one marked block in the README, ending in
  `docker compose up -d`, repeated verbatim in the Compose example header,
  [operations](operations.md#compose), and the release notes.

## Adding things

| Task                 | Steps                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A route              | Register it in the right file under `server/src/routes/`, wire any new service in `server/src/index.ts`, add the DTO in `shared/src/api-contract.ts`, add the client call in `web/src/lib/api.ts`, and document it in [`api.md`](api.md).                                                                                                                                    |
| A service            | `<domain>/service.ts` exporting `create<Domain>Service(deps)`, constructed in the composition root and handed to its route plugin. Never import a service from a route file.                                                                                                                                                                                                 |
| A DB column or table | Add a forward migration with the next id for all three SQL dialects plus a `MONGO_MIGRATIONS` step, never an edit to a released one ([operations](operations.md#schema-versioning-and-upgrades)). List it in `server/src/db/released-migrations.ts` with `release: null`. Update `NexusStore`, implement it in **all four** adapters, and run the cross-adapter smoke tests. |
| An Edge call         | Only in `server/src/ferrum-admin/`. Extend the mock too.                                                                                                                                                                                                                                                                                                                     |
| An audit event       | Append to `AuditAction` in `server/src/audit/service.ts`, classify it in `AUDIT_COMMIT_CLASSES`, **and** add it to the catalog in [`security.md`](security.md#10-audit-event-catalog).                                                                                                                                                                                       |
| An error code        | Append to `shared/src/error-codes.ts` (never rename one: codes are public contract), add its status to `ERROR_CODE_STATUS`, and add a row to the table in [`api.md`](api.md#error-envelope-and-codes).                                                                                                                                                                       |
