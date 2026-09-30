# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and other coding agents working in this repository.

## What this is

Ferrum Nexus is a **Backend-for-Frontend (BFF)** in front of
[Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge).

- **Nexus owns** portal accounts, the approval workflow, audit history, branding, messaging, and
  the API catalog.
- **Edge owns** gateway runtime state: proxies, consumers, credentials, plugins.

The browser **never** talks to the Edge Admin API. Every gateway mutation goes through the Nexus
server (`server/`), which enforces RBAC and writes the audit log before forwarding.

## Release status

`v0.2.0` is the current release, paired with Ferrum Edge `v0.9.8`
(`release/compatibility.env`). `v0.1.0`, the first supported release, froze the `001_initial`
schema baseline; `v0.2.0` froze the forward migrations `002` and `003`:

- `server/src/db/released-migrations.ts` lists every shipped or pending migration with its
  per-backend checksums; `released-migrations.test.ts` fails on any edit to a released one (or to
  its MongoDB snapshot in `server/src/db/released/`).
- A schema change is a new forward migration with a higher id in every backend, never an edit to a
  released one, and it must upgrade retained data in place. See
  [docs/operations.md, "Schema versioning and upgrades"](docs/operations.md#schema-versioning-and-upgrades).
- Development databases created before `v0.1.0` are disposable: recreate them.

## Workspace layout

npm workspaces, in build-dependency order:

- `shared/` — TypeScript types, API DTOs, and constants used by server and web. Its `package.json`
  points `main`/`types` at `dist/`, so **it must be built before typecheck, test, or lint anywhere
  else.** Every top-level script does this. If you call a workspace script directly, run
  `npm run build --workspace shared` first.
- `server/` — Fastify 5 BFF. Services are composed in [server/src/index.ts](server/src/index.ts).
- `web/` — React 19 + TypeScript SPA (Vite, TanStack Router/Query/Table, Radix UI, Tailwind v4).
  The Vite dev server proxies `/api` to `127.0.0.1:8787`.

Also: `e2e/` (acceptance suite), `docker/` (image and Compose files), `release/` (the Edge
compatibility pin), `ci/` (CI scripts), `docs/` (design docs and user guides).

## Commands

Run from the repo root unless noted.

```bash
npm install                              # all workspaces
cp .env.example .env                     # then set NEXUS_SECRET_KEY, FERRUM_ADMIN_URL, FERRUM_ADMIN_JWT_SECRET
npm run migrate                          # build shared, then apply migrations (the server also migrates at startup)
npm run dev                              # server (tsx watch) on :8787 + web (vite) on :5173

npm run build                            # shared → server → web
npm run typecheck                        # tsc --noEmit across workspaces
npm run lint                             # alias for typecheck; there is no ESLint
npm test                                 # all workspaces (shared first)
npm test --workspace server              # backend only (node --test via tsx)
npm test --workspace web                 # frontend only (vitest)
npm run format                           # Prettier; format:check in CI
./e2e/run.sh                             # acceptance: packaged image vs a real pinned Edge
```

One backend test file:

```bash
cd server && npx tsx --test src/path/to/file.test.ts
```

**Backend tests** boot the full Fastify app on in-memory SQLite against a mock Edge Admin API
([server/src/test/mock-ferrum-edge.ts](server/src/test/mock-ferrum-edge.ts)). Use `buildTestApp()`
from [server/src/test/helpers.ts](server/src/test/helpers.ts).

**Cross-adapter smoke tests** ([server/src/test/smoke.test.ts](server/src/test/smoke.test.ts)) run
on SQLite by default. Set `NEXUS_TEST_POSTGRES_URL`, `NEXUS_TEST_MYSQL_URL`, and/or
`NEXUS_TEST_MONGO_URL` (for example, disposable Docker containers) to also run Postgres, MySQL,
and MongoDB. Do this whenever you change anything under `server/src/db/`. CI's `store-contracts`
job runs all four.

**The acceptance suite** ([e2e/](e2e/README.md)) runs the **packaged container image** against a
real, digest-pinned Edge release (pinned in `release/compatibility.env`), PostgreSQL, a
deterministic upstream, a real SMTP sink, and a digest-pinned Dex OpenID Connect provider. It
asserts through the gateway's data-plane listener, not its Admin API, signs in through Dex
(`./e2e/run.sh sso`), and includes a browser journey. CI runs it as the required `acceptance` job.
Run it for anything that changes what Nexus writes to Edge, the auth or credential contract, or the
container image.

## Architecture rules that affect every change

1. **Persistence goes only through `NexusStore`** ([server/src/db/store.ts](server/src/db/store.ts)).
   Never reach into a database driver from a service module.
   - Four adapters implement it: `sqlite/` (synchronous better-sqlite3, the self-contained
     reference), `postgres/` and `mysql/` (async; they share repo logic in `adapters/sql-repos.ts`
     over a small `SqlExecutor`, with dialect shims in `adapters/sql-common.ts`), and `mongodb/`
     (one collection per logical table).
   - To add a query: extend the interface, implement it in sqlite, sql-repos, and mongodb, and
     cover it in the smoke suite.
   - **Transaction bodies must be re-runnable.** The pooled adapters re-run a body the engine
     rolled back for contention (InnoDB deadlock, PostgreSQL `40001`, Mongo write conflict). So
     everything a `store.transaction` body does must go through the transaction-scoped store or be
     idempotent: no gateway calls, no email enqueues, no in-memory bookkeeping. A body that cannot
     honour this passes `{ retry: false }`. Contention that outlasts the retry budget surfaces as
     `NexusError('CONFLICT')`, never a driver error (`server/src/db/adapters/transaction-retry.ts`).
   - **Leases fence transactions.** Every `createKeyedSerializer` acquisition writes a fresh owner
     token, and every `store.transaction` opened inside the section verifies it just before commit
     (`server/src/lib/lease-fence.ts`). A holder that stalled past the TTL gets `CONFLICT` instead
     of committing. So a lease-guarded check-then-write belongs in **one** transaction, opened
     after taking the key.
2. **String UUIDs everywhere; timestamps are ISO-8601 strings** in text columns, never native
   timestamp types. Adapters convert booleans and JSON at the boundary, so services see real
   booleans and parsed objects.
3. **Every state-changing endpoint requires a session and writes an `audit_logs` row** through the
   `audit` service and its `AuditAction` catalog. Don't invent a parallel log. The only
   session-less writes are the pre-authentication `/api/auth` endpoints (register, login, email
   verification, password recovery), which still audit their successes. CSRF: the `X-Nexus-CSRF`
   header must match both the `nexus_csrf` cookie and the session's stored token.
4. **Service modules export a factory (`createXService(deps)`)** composed in
   [server/src/index.ts](server/src/index.ts). Routes live under `server/src/routes/` and get
   services through their registration options. Route files never import service modules.
5. **One Ferrum consumer per Nexus identity per namespace**: the account itself (username
   `nexus-user-<user_id>`) and each of its applications (`nexus-app-<application_id>`).
   `application_id = null` on grants, requests, and credentials means the account.
   - Approval adds ACL group `nexus:api:<api_id>:approved` to the requesting identity's consumer;
     revocation removes it. Requestable APIs get an `access_control` plugin whose `allowed_groups`
     is that group.
   - Edge's `PUT /consumers/{id}` is a whole-resource replace with no concurrency token, so
     **every consumer mutation must go through `edge.serializePerKey(consumerId, …)`**.
6. **Show-once credentials.** Plaintext credential material is returned exactly once and never
   stored; only a SHA-256 fingerprint and last4 go into `credential_metadata`. Rotation is
   append-then-delete on the Edge credential array. Naming trap: Edge credential _types_ are
   `keyauth`/`basicauth`/`jwt`, but the auth _plugins_ are `key_auth`/`basic_auth`/`jwt_auth`
   (see `CREDENTIAL_TYPE_FOR_PLUGIN` in `shared/src/constants.ts`).
7. **Email goes through the outbox.** All transactional mail is enqueued into `email_outbox`. A
   worker polls every 5 s and retries with exponential backoff, up to 5 attempts
   (`OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_MAX_ATTEMPTS`). Use `EmailService.enqueue` with an
   `idempotencyKey` for at-most-once sends (verification, mass email).
8. **Founding `super_admin`.** While the portal has no active `super_admin`, the next registration
   becomes one, but only if it presents the bootstrap token (`NEXUS_BOOTSTRAP_TOKEN`, or the
   per-process token printed at startup). Other registrations may choose only `client` or
   `provider`. Only a `super_admin` can grant or remove `admin`. The last active `super_admin`
   cannot be demoted, disabled, or removed (`LAST_SUPER_ADMIN`).
   Single sign-on (`server/src/sso/`) never grants, removes or changes `super_admin` from claims,
   and the founding registration works under every login policy, `sso_only` included.
9. **Encrypted `app_settings` rows** (SMTP password, CAPTCHA secret, SSO client secrets) use
   AES-256-GCM with keys HKDF-derived from `NEXUS_SECRET_KEY`. Key rotation:
   [docs/operations.md](docs/operations.md).
10. **MongoDB requires a replica set** for multi-document transactions. They run through the
    driver's `session.withTransaction()`, so a `TransientTransactionError` is retried rather than
    losing the body's work. Standalone Mongo is rejected at startup unless
    `NEXUS_DB_ALLOW_STANDALONE=true`; transactions then become serialized, non-atomic, and
    never retried.
11. **All Edge Admin API calls go through `server/src/ferrum-admin/`**, the only module that knows
    Edge's HTTP shape and admin JWT contract (HS256, `role: 'admin'`, issuer must match the
    gateway's `FERRUM_ADMIN_JWT_ISSUER`, no `aud` unless configured). Edge validates plugin and
    resource bodies against closed key sets: a typo'd field is a 400, not a no-op. Palette plugin
    config keys are described once in `shared/src/plugins.ts`.
12. **Wire types live in `shared/`.** Routes and the web client both import DTOs from
    `@ferrum-nexus/shared`. Never redeclare request or response shapes locally.
13. **Whole-resource `PUT`s to Edge must preserve what the portal does not own, and may only touch
    resources the portal created.**
    - A plugin-config body built from scratch resets an operator's `priority_override` (and any
      field Edge adds later). Build it with `writeBody` in
      [server/src/publishing/edge-plugins.ts](server/src/publishing/edge-plugins.ts), which merges
      the portal-owned fields over the live resource.
    - Ownership is a recorded id, not a plugin name (a proxy may legitimately carry two configs of
      one name). Palette plugins are addressed through `api_plugins.ferrum_plugin_config_id`; the
      first-class auth, `access_control`, `rate_limiting`, and `cors` configs through
      `api_gateway_plugins`. A config Nexus did not create is never replaced or deleted.
    - Register every plugin-config undo step before the write it undoes (a lost acknowledgement can
      still mean the write landed), and create with a pre-minted id.
    - `cors` and `rate_limit` are reconciled only when they actually change, compared with
      `isDeepStrictEqual` against the stored value.

## Coding conventions

- TypeScript strict everywhere. No `any` without an escape-hatch comment.
- Explicit return types at public boundaries.
- Backend errors are `NexusError` → `{ error: { code, message, details? } }`, with stable codes
  from `shared/src/error-codes.ts`.
- Prettier (`.prettierrc.json` is the source of truth): 2-space indent, single quotes, trailing
  commas, semicolons, 100 columns.

## Where to start when…

- **Adding a route**: register it in the right file under `server/src/routes/`, wire any new
  service into `server/src/index.ts` (the "COMPOSITION" sections), add DTOs to
  `shared/src/api-contract.ts`, and add the call to `web/src/lib/api.ts`.
- **Adding a DB column or table**: add a forward migration with the next id:
  `NNN_description.sql`, `.pg.sql`, and `.mysql.sql` under `server/src/db/migrations/`, plus a
  `MONGO_MIGRATIONS` step. In the same change, list it in `server/src/db/released-migrations.ts`
  with `release: null` and its checksums, and add its MongoDB snapshot under
  `server/src/db/released/`; the release that ships it sets `release`. Then update `NexusStore`,
  implement it in sqlite, sql-repos, and mongodb, and extend the smoke suite and the upgrade
  fixture in `server/src/test/baseline-upgrade.test.ts`.
- **Touching the Edge integration**: only through `server/src/ferrum-admin/`, and extend the mock
  in `server/src/test/mock-ferrum-edge.ts` to match.
- **Adding an audit event**: extend `AuditAction` in
  [server/src/audit/service.ts](server/src/audit/service.ts) and classify it in
  `AUDIT_COMMIT_CLASSES`. Record `transactional` and `intent` actions through
  `audit.forStore(tx)` inside the transaction (`transactional-audit.test.ts` enforces this). Add
  it to the catalog in [docs/security.md](docs/security.md#10-audit-event-catalog).
- **Adding an error code**: see [docs/contributing.md](docs/contributing.md#adding-things).

## Agent-dispatch skills

`.agents/skills/` holds the canonical skills that dispatch **external** CLI coding agents as
workers on isolated git worktrees. `.claude/skills/` holds thin Claude Code wrappers that point at
them. The tree mirrors [ferrum-edge](https://github.com/ferrum-edge/ferrum-edge)'s
`.agents/skills`, adapted to this repository. The shared binary resolver is
`.agents/skills/_lib/resolve-agent-bin.sh`.

| Skill (directory)        | Worker model (pinned by the launcher)       | CLI            | `--effort` / `--fast`                                             |
| ------------------------ | ------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| `astra-agents`           | `gpt-6-astra`                               | `codex`        | `low` to `max`, `ultra`; `--fast` on explicit request             |
| `sol-agents`             | `gpt-6-sol`                                 | `codex`        | `low` to `max`, `ultra`; `--fast` on explicit request             |
| `luna-agents`            | `gpt-6-luna`                                | `codex`        | `low` to `max`; `--fast` on explicit request                      |
| `opus-agents`            | `claude-opus-5-5[1m]`                       | `claude`       | `low` to `max`; `--fast` on explicit request                      |
| `fable-5-1-agents`       | `claude-fable-5-1`                          | `claude`       | `low` to `max`                                                    |
| `grok-agents`            | `cursor-grok-4.6-<effort>`                  | `cursor-agent` | picks the SKU (default `high`; `max` clamps to `xhigh`); `--fast` |
| `composer-agents`        | `composer-2.5`                              | `cursor-agent` | ignored; `--fast` selects `composer-2.5-fast`                     |
| `opencode-laguna-agents` | `opencode/laguna-s-2.1-free` (default)      | `opencode`     | ignored; `--model opencode/<model>` overrides the model           |
| `deepseek-pro-agents`    | `alibaba-token-plan/deepseek-v4.1-flash`    | `opencode`     | ignored                                                           |
| `deepseek-flash-agents`  | `alibaba-token-plan/deepseek-v4-flash-0731` | `opencode`     | ignored                                                           |
| `qwen-agents`            | `alibaba-token-plan/qwen3.8-max`            | `opencode`     | ignored                                                           |

`low` to `max` is `low|medium|high|xhigh|max`. "Ignored" means the launcher accepts `--effort` for
parity with the other skills but the model has no effort tiers; the `opencode` launchers accept only
`medium|high|xhigh|max`. The `opencode-laguna-agents` skill registers under the name `opencode-agents`.

**Trigger shorthand.** "astra xhigh sub agent" (and the same shape for other skills: "opus high",
"grok medium") means: use that skill as the orchestrator, dispatch a worker at that reasoning
effort, and follow the skill's worktree isolation, verification, and reporting rules. Never
substitute a different model, effort, or service tier than the one named.

Each canonical skill is self-contained: `SKILL.md` is the orchestrator contract,
`references/agent-brief.md` and `references/continuation-brief.md` are the worker briefs, and
`scripts/dispatch-agent.sh` is the launcher that pins the model and sandbox. Workers validate
through remote CI rather than local builds or tests, and must not dispatch nested workers.
