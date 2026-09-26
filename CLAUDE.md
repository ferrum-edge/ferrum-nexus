# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ferrum Nexus is a **Backend-for-Frontend (BFF)** sitting in front of [Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge). Nexus owns portal accounts, approval workflow, audit history, branding, messaging, and the user-facing API catalog. Edge owns gateway runtime state (proxies, consumers, credentials, plugins).

The browser **never** talks to the Ferrum Edge Admin API directly. Every gateway mutation flows through the Nexus server (`server/`), which enforces RBAC + audit logging before forwarding.

## Release status

`v0.1.0` is the first supported release, paired with Ferrum Edge `v0.9.7`
(`release/compatibility.env`, `docs/release-notes.md`). It froze the `001_initial`
schema baseline: `server/src/db/released-migrations.ts` lists it with
`release: 'v0.1.0'`, and `released-migrations.test.ts` fails on any edit to it (or to
its MongoDB snapshot in `server/src/db/released/`). A schema change is now a new
forward migration with a higher id in every backend — never an edit to a released one
— and ships with an upgrade path for retained data (docs/operations.md, "Schema
versioning and upgrades"). Only disposable development databases created before
`v0.1.0` are recreated rather than upgraded.

## Workspace layout

npm workspaces — order of build dependency matters:

- `shared/` — TypeScript types, API DTOs, and constants consumed by both server and web. Its `package.json` points `main`/`types` at `dist/`, so **it must be built before typecheck/test/lint anywhere else.** Every top-level script does this automatically; if you call workspace scripts directly, prebuild shared first (`npm run build --workspace shared`).
- `server/` — Fastify 5 BFF. Composes services in [server/src/index.ts](server/src/index.ts) and integrates with the Ferrum Edge Admin API.
- `web/` — React 19 + TypeScript SPA (Vite, TanStack Router/Query/Table, Radix UI, Tailwind v4). Vite dev server proxies `/api` → `127.0.0.1:8787`.
- `docker/`, `docs/` — container assets, design docs, and user guides.

## Commands

Run from repo root unless noted.

```bash
npm install                              # install all workspaces

cp .env.example .env                     # then set NEXUS_SECRET_KEY + FERRUM_ADMIN_URL + FERRUM_ADMIN_JWT_SECRET
npm run migrate                          # build shared + initialize the schema (also runs at server startup)
                                         # `npm run migrate --workspace server` needs shared built first

npm run dev                              # concurrently: server (tsx watch) + web (vite). Backend :8787, web :5173

npm run build                            # shared → server → web (order enforced)
npm run typecheck                        # tsc --noEmit across workspaces
npm run lint                             # NOTE: this is just `tsc --noEmit` — there is no ESLint configured
npm test                                 # all workspaces (shared first)
npm test --workspace server              # backend only (node --test via tsx)
npm test --workspace web                 # frontend only (vitest)
./e2e/run.sh                             # acceptance: packaged image vs a real pinned Edge
npm run format / format:check            # Prettier
```

Run a single backend test file:

```bash
cd server && npx tsx --test src/path/to/file.test.ts
```

Backend tests boot the full Fastify app against in-memory SQLite plus a mock Ferrum Edge Admin API ([server/src/test/mock-ferrum-edge.ts](server/src/test/mock-ferrum-edge.ts)); use `buildTestApp()` from [server/src/test/helpers.ts](server/src/test/helpers.ts).

**Cross-adapter smoke tests** ([server/src/test/smoke.test.ts](server/src/test/smoke.test.ts)) run SQLite by default and opt into Postgres/MySQL/Mongo via `NEXUS_TEST_POSTGRES_URL`, `NEXUS_TEST_MYSQL_URL`, `NEXUS_TEST_MONGO_URL` (throwaway databases/schemas are created and dropped per run). Set those — e.g. against disposable Docker containers — whenever you change anything under `server/src/db/`.

**Acceptance suite** ([e2e/](e2e/)) runs the **packaged container image** against a real, digest-pinned Ferrum Edge release, PostgreSQL, a deterministic upstream and a real SMTP sink — with a browser journey and data-plane assertions made through the gateway's listener rather than its Admin API. `./e2e/run.sh` brings the stack up, runs it and tears it down; CI runs it as the `acceptance` job, a required check on `main`. The Edge pin lives in `release/compatibility.env`, shared with the Compose quickstart. Run it for anything that changes what Nexus writes to Edge, the auth/credential contract, or the container image.

## Architecture rules that affect every change

1. **Never reach into a database driver from a service module.** All persistence goes through `NexusStore` defined in [server/src/db/store.ts](server/src/db/store.ts). Four adapters implement it: `sqlite/` (synchronous better-sqlite3, self-contained reference), `postgres/` + `mysql/` (async, sharing all repo logic in `adapters/sql-repos.ts` over a small `SqlExecutor` with dialect shims in `adapters/sql-common.ts`), and `mongodb/` (one collection per logical table). If you add a query: extend the interface, implement it in sqlite, sql-repos, and mongodb, and cover it in the smoke suite. **Transaction bodies must be re-runnable**: the pooled adapters re-run a body the engine rolled back for contention (an InnoDB deadlock, a PostgreSQL `40001`, a Mongo write conflict), so everything a `store.transaction` body does must go through the transaction-scoped store or be idempotent — no gateway calls, no email enqueues, no in-memory bookkeeping. A body that genuinely cannot honour that passes `{ retry: false }`. Contention that outlives the retry budget surfaces as `NexusError('CONFLICT')`, never as a driver error; see `server/src/db/adapters/transaction-retry.ts`.
2. **String UUIDs everywhere, ISO-8601 timestamps as strings** (stored in text columns, never native timestamp types). Adapters convert booleans/JSON at the boundary; services see real booleans and parsed objects.
3. **Every state-changing endpoint requires a session and writes an `audit_logs` row** via the `audit` service and its `AuditAction` catalog — don't invent a parallel log. CSRF is enforced via the `X-Nexus-CSRF` header matching the `nexus_csrf` cookie (and the session's stored token).
4. **Service modules export a factory (`createXService(deps)`)** and are composed in [server/src/index.ts](server/src/index.ts). Routes register under `server/src/routes/` and receive services via the registration options object — route files never import service modules.
5. **One Ferrum consumer per Nexus identity per namespace** — the account itself (username `nexus-user-<user_id>`) and each of its applications (`nexus-app-<application_id>`); `application_id = null` on grants, requests and credentials means the account. Approvals add ACL group `nexus:api:<api_id>:approved` to the requesting identity's consumer; revocations remove it. Requestable APIs get an `access_control` plugin with `allowed_groups` restricted to that group. Edge's `PUT /consumers/{id}` is a whole-resource replace with no concurrency token, so **every consumer mutation must go through `edge.serializePerKey(consumerId, …)`**.
6. **Show-once credentials.** Plaintext credential material is returned exactly once from the API and never stored — only a SHA-256 fingerprint + last4 land in `credential_metadata`. Rotation is append-then-delete on the Edge credential array. Note the naming trap: Edge credential _types_ are `keyauth`/`basicauth`/`jwt`, while the auth _plugins_ are `key_auth`/`basic_auth`/`jwt_auth` (see `CREDENTIAL_TYPE_FOR_PLUGIN` in shared).
7. **Email goes through the outbox.** All transactional mail enqueues into `email_outbox`; a worker polls every 5s with exponential backoff up to 5 attempts. Use `EmailService.enqueue` with an `idempotencyKey` for at-most-once semantics (verification, mass email).
8. **The first registered user becomes `super_admin`.** Later registrations may choose only `client`/`provider`; admins are promoted by an existing admin. The last active `super_admin` cannot be demoted, disabled, or removed.
9. **Encrypted `app_settings` rows** (SMTP password, CAPTCHA secret) are AES-256-GCM-encrypted with keys HKDF-derived from `NEXUS_SECRET_KEY`. See [docs/operations.md](docs/operations.md) for key rotation.
10. **MongoDB requires a replica set** for multi-document transactions, which run through the driver's `session.withTransaction()` so a `TransientTransactionError` is retried instead of losing the body's work. Standalone Mongo is rejected at startup unless `NEXUS_DB_ALLOW_STANDALONE=true` (transactions then degrade to serialized, non-atomic execution — and to no retry, since there is nothing to roll back).
11. **All Ferrum Edge knowledge lives in `server/src/ferrum-admin/`** — the only module that knows Edge's HTTP shape, JWT contract (HS256, `role: 'admin'`, issuer must match the gateway's `FERRUM_ADMIN_JWT_ISSUER`, no `aud` unless configured), and plugin config schemas. Edge validates plugin/resource bodies against closed key sets — a typo'd field is a 400, not a no-op.
12. **Wire types live in `shared/`.** Routes and the web client both import DTOs from `@ferrum-nexus/shared` — never redeclare request/response shapes locally.
13. **Whole-resource `PUT`s to Edge carry what the portal does not own, and only address resources the portal created.** A plugin-config body built from scratch resets an operator's `priority_override` (and any field Edge adds later), so build one with `writeBody` in [server/src/publishing/edge-plugins.ts](server/src/publishing/edge-plugins.ts), which merges the portal-owned fields over the live resource. Ownership is a recorded id, not a plugin name — a proxy may legitimately carry two configs of one name — so palette plugins are addressed through `api_plugins.ferrum_plugin_config_id` and the first-class auth, `access_control`, `rate_limiting` and `cors` configs through `api_gateway_plugins`, and a config Nexus did not create is never replaced or deleted. Every plugin-config undo step is registered before the write it undoes (a lost acknowledgement can still mean it landed), and creates use a pre-minted id. `cors` and `rate_limit` are reconciled only when they actually change, compared with `isDeepStrictEqual` against the stored value.

## Coding conventions

- TypeScript strict everywhere. No `any` without an escape-hatch comment.
- Explicit return types at public boundaries.
- Backend errors are `NexusError` → `{ error: { code, message, details? } }` with stable codes from `shared/src/error-codes.ts`.
- Prettier: 2-space, single quotes, trailing commas, semicolons, 100-col. `.prettierrc.json` is the source of truth.

## Where to start when…

- **Adding a route**: register it in the appropriate file under `server/src/routes/`, wire any new services into `server/src/index.ts` (COMPOSITION sections), add DTOs to `shared/src/api-contract.ts`, and add the call in `web/src/lib/api.ts`.
- **Adding a DB column / table**: `001_initial` is frozen, so add a forward migration with the next id — `NNN_description.sql`, `.pg.sql` and `.mysql.sql` under `server/src/db/migrations/` plus a `MONGO_MIGRATIONS` step — and list it in `server/src/db/released-migrations.ts` with `release: null` and its checksums (plus its `server/src/db/released/` MongoDB snapshot) in the same change, the release that ships it setting `release`; then update `NexusStore`, implement in sqlite + sql-repos + mongodb, extend the smoke suite and the upgrade fixture in `server/src/test/baseline-upgrade.test.ts`.
- **Touching the Ferrum Edge integration**: only through `server/src/ferrum-admin/`; extend the mock in `server/src/test/mock-ferrum-edge.ts` to match.
- **Adding an audit event**: extend the `AuditAction` catalog in [server/src/audit/service.ts](server/src/audit/service.ts) and the table in [docs/security.md](docs/security.md).

## Agent-dispatch skills

`.agents/skills/` holds the canonical orchestration skills that dispatch **external** CLI coding
agents as implementation workers on isolated git worktrees, and `.claude/skills/` holds thin Claude
Code wrappers that point at them. The tree mirrors
[ferrum-edge](https://github.com/ferrum-edge/ferrum-edge)'s `.agents/skills` and is kept in sync
with it, with the guidance files, invariants, and validation commands adapted to this repository.
The shared binary resolver lives at `.agents/skills/_lib/resolve-agent-bin.sh`.

| Skill                                           | Worker                  | CLI            | Effort/model selection                                                              |
| ----------------------------------------------- | ----------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `astra-agents`                                  | GPT-6 Astra             | `codex`        | `--effort low\|medium\|high\|xhigh\|max\|ultra` (`--fast` only on explicit request) |
| `sol-agents`                                    | GPT-6 Sol               | `codex`        | `--effort low\|medium\|high\|xhigh\|max\|ultra` (`--fast` only on explicit request) |
| `luna-agents`                                   | GPT-6 Luna              | `codex`        | `--effort low\|medium\|high\|xhigh\|max` (`--fast` only on explicit request)        |
| `opus-agents`                                   | Claude Opus 5.5 1M      | `claude`       | `--effort low\|medium\|high\|xhigh\|max` (`--fast` only on explicit request)        |
| `fable-5-1-agents`                              | Claude Fable 5.1        | `claude`       | `--effort low\|medium\|high\|xhigh\|max`                                            |
| `grok-agents`                                   | Cursor Grok 4.6         | `cursor-agent` | `--effort low\|medium\|high\|xhigh\|max` maps to a `cursor-grok-4.6-*` sku          |
| `composer-agents`                               | Cursor Composer 2.5     | `cursor-agent` | pinned model; `--effort low\|medium\|high\|xhigh\|max`                              |
| `opencode-laguna-agents`                        | opencode laguna-s-2.1   | `opencode`     | pinned model; `--effort medium\|high\|xhigh\|max`                                   |
| `deepseek-pro-agents` / `deepseek-flash-agents` | DeepSeek V4 Pro / Flash | `opencode`     | pinned model; `--effort medium\|high\|xhigh\|max`                                   |
| `qwen-agents`                                   | Qwen3.8 Max             | `opencode`     | pinned model; `--effort medium\|high\|xhigh\|max`                                   |

**Trigger shorthand.** "astra xhigh sub agent" (and the same shape for the other skills — "opus
high", "grok medium") means: use that skill as the orchestrator, dispatch a worker at that
reasoning effort, and follow the skill's worktree isolation, verification, and reporting rules.
Never substitute a different model, effort, or service tier than the one named.

Each canonical skill is self-contained: `SKILL.md` is the orchestrator contract,
`references/agent-brief.md` and `references/continuation-brief.md` are the worker briefs, and
`scripts/dispatch-agent.sh` is the launcher that pins the model and sandbox. Workers validate
through remote CI rather than local builds or tests, and are forbidden from dispatching nested
workers.
