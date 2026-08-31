# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ferrum Nexus is a **Backend-for-Frontend (BFF)** sitting in front of [Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge). Nexus owns portal accounts, approval workflow, audit history, branding, messaging, and the user-facing API catalog. Edge owns gateway runtime state (proxies, consumers, credentials, plugins).

The browser **never** talks to the Ferrum Edge Admin API directly. Every gateway mutation flows through the Nexus server (`server/`), which enforces RBAC + audit logging before forwarding.

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
npm run migrate --workspace server       # apply migrations (also runs automatically at server startup)

npm run dev                              # concurrently: server (tsx watch) + web (vite). Backend :8787, web :5173

npm run build                            # shared → server → web (order enforced)
npm run typecheck                        # tsc --noEmit across workspaces
npm run lint                             # NOTE: this is just `tsc --noEmit` — there is no ESLint configured
npm test                                 # all workspaces (shared first)
npm test --workspace server              # backend only (node --test via tsx)
npm test --workspace web                 # frontend only (vitest)
npm run format / format:check            # Prettier
```

Run a single backend test file:

```bash
cd server && npx tsx --test src/path/to/file.test.ts
```

Backend tests boot the full Fastify app against in-memory SQLite plus a mock Ferrum Edge Admin API ([server/src/test/mock-ferrum-edge.ts](server/src/test/mock-ferrum-edge.ts)); use `buildTestApp()` from [server/src/test/helpers.ts](server/src/test/helpers.ts).

**Cross-adapter smoke tests** ([server/src/test/smoke.test.ts](server/src/test/smoke.test.ts)) run SQLite by default and opt into Postgres/MySQL/Mongo via `NEXUS_TEST_POSTGRES_URL`, `NEXUS_TEST_MYSQL_URL`, `NEXUS_TEST_MONGO_URL` (throwaway databases/schemas are created and dropped per run). Set those — e.g. against disposable Docker containers — whenever you change anything under `server/src/db/`.

## Architecture rules that affect every change

1. **Never reach into a database driver from a service module.** All persistence goes through `NexusStore` defined in [server/src/db/store.ts](server/src/db/store.ts). Four adapters implement it: `sqlite/` (synchronous better-sqlite3, self-contained reference), `postgres/` + `mysql/` (async, sharing all repo logic in `adapters/sql-repos.ts` over a small `SqlExecutor` with dialect shims in `adapters/sql-common.ts`), and `mongodb/` (one collection per logical table). If you add a query: extend the interface, implement it in sqlite, sql-repos, and mongodb, and cover it in the smoke suite.
2. **String UUIDs everywhere, ISO-8601 timestamps as strings** (stored in text columns, never native timestamp types). Adapters convert booleans/JSON at the boundary; services see real booleans and parsed objects.
3. **Every state-changing endpoint requires a session and writes an `audit_logs` row** via the `audit` service and its `AuditAction` catalog — don't invent a parallel log. CSRF is enforced via the `X-Nexus-CSRF` header matching the `nexus_csrf` cookie (and the session's stored token).
4. **Service modules export a factory (`createXService(deps)`)** and are composed in [server/src/index.ts](server/src/index.ts). Routes register under `server/src/routes/` and receive services via the registration options object — route files never import service modules.
5. **One Ferrum consumer per Nexus user per namespace** (username `nexus-user-<user_id>`). Approvals add ACL group `nexus:api:<api_id>:approved` to that consumer; revocations remove it. Requestable APIs get an `access_control` plugin with `allowed_groups` restricted to that group. Edge's `PUT /consumers/{id}` is a whole-resource replace with no concurrency token, so **every consumer mutation must go through `edge.serializePerKey(consumerId, …)`**.
6. **Show-once credentials.** Plaintext credential material is returned exactly once from the API and never stored — only a SHA-256 fingerprint + last4 land in `credential_metadata`. Rotation is append-then-delete on the Edge credential array. Note the naming trap: Edge credential *types* are `keyauth`/`basicauth`/`jwt`, while the auth *plugins* are `key_auth`/`basic_auth`/`jwt_auth` (see `CREDENTIAL_TYPE_FOR_PLUGIN` in shared).
7. **Email goes through the outbox.** All transactional mail enqueues into `email_outbox`; a worker polls every 5s with exponential backoff up to 5 attempts. Use `EmailService.enqueue` with an `idempotencyKey` for at-most-once semantics (verification, mass email).
8. **The first registered user becomes `super_admin`.** Later registrations may choose only `client`/`provider`; admins are promoted by an existing admin. The last active `super_admin` cannot be demoted, disabled, or removed.
9. **Encrypted `app_settings` rows** (SMTP password, CAPTCHA secret) are AES-256-GCM-encrypted with keys HKDF-derived from `NEXUS_SECRET_KEY`. See [docs/operations.md](docs/operations.md) for key rotation.
10. **MongoDB requires a replica set** for multi-document transactions. Standalone Mongo is rejected at startup unless `NEXUS_DB_ALLOW_STANDALONE=true` (transactions then degrade to serialized, non-atomic execution).
11. **All Ferrum Edge knowledge lives in `server/src/ferrum-admin/`** — the only module that knows Edge's HTTP shape, JWT contract (HS256, `role: 'admin'`, issuer must match the gateway's `FERRUM_ADMIN_JWT_ISSUER`, no `aud` unless configured), and plugin config schemas. Edge validates plugin/resource bodies against closed key sets — a typo'd field is a 400, not a no-op.
12. **Wire types live in `shared/`.** Routes and the web client both import DTOs from `@ferrum-nexus/shared` — never redeclare request/response shapes locally.

## Coding conventions

- TypeScript strict everywhere. No `any` without an escape-hatch comment.
- Explicit return types at public boundaries.
- Backend errors are `NexusError` → `{ error: { code, message, details? } }` with stable codes from `shared/src/error-codes.ts`.
- Prettier: 2-space, single quotes, trailing commas, semicolons, 100-col. `.prettierrc.json` is the source of truth.

## Where to start when…

- **Adding a route**: register it in the appropriate file under `server/src/routes/`, wire any new services into `server/src/index.ts` (COMPOSITION sections), add DTOs to `shared/src/api-contract.ts`, and add the call in `web/src/lib/api.ts`.
- **Adding a DB column / table**: add a migration under `server/src/db/migrations/` (`.sql` = SQLite, `.pg.sql`, `.mysql.sql`; Mongo indexes are created in its adapter), update `NexusStore`, implement in sqlite + sql-repos + mongodb, extend the smoke suite.
- **Touching the Ferrum Edge integration**: only through `server/src/ferrum-admin/`; extend the mock in `server/src/test/mock-ferrum-edge.ts` to match.
- **Adding an audit event**: extend the `AuditAction` catalog in [server/src/audit/service.ts](server/src/audit/service.ts) and the table in [docs/security.md](docs/security.md).
