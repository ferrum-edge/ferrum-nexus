# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ferrum Nexus is a **Backend-for-Frontend (BFF)** sitting in front of [Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge). Nexus owns portal accounts, approval workflow, audit history, branding, messaging, and the user-facing API catalog. Edge owns gateway runtime state (proxies, consumers, credentials, plugins).

The browser **never** talks to the Ferrum Edge Admin API directly. Every gateway mutation flows through the Nexus server (`server/`), which enforces RBAC + audit logging before forwarding.

## Workspace layout

npm workspaces — order of build dependency matters:

- `shared/` — TypeScript types and constants consumed by both server and web. Its `package.json` points `main`/`types` at `dist/`, so **it must be built before typecheck/test/lint anywhere else.** Every top-level script does this automatically; if you call workspace scripts directly, prebuild shared first (`npm run build --workspace shared`).
- `server/` — Fastify BFF. Composes services in [server/src/index.ts](server/src/index.ts) and integrates with Ferrum Edge Admin API.
- `web/` — React + TypeScript SPA (Vite, TanStack Router/Query/Table, Radix UI, Tailwind). Vite dev server proxies `/api` → `127.0.0.1:8787`.
- `docker/`, `docs/` — container assets and design docs.

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
npm test --workspace server              # backend only
npm test --workspace web                 # frontend only (vitest)
```

Run a single backend test file:

```bash
cd server && npx tsx --test src/path/to/file.test.ts
```

The backend test runner is `node --test` with the tsx loader (see [server/package.json](server/package.json) `scripts.test`). Backend tests boot Fastify against in-memory SQLite + a mock Ferrum Edge Admin API.

**Cross-adapter smoke tests** ([server/src/test/smoke.test.ts](server/src/test/smoke.test.ts)) run SQLite by default but opt into Postgres/MySQL/Mongo via `NEXUS_TEST_POSTGRES_URL`, `NEXUS_TEST_MYSQL_URL`, `NEXUS_TEST_MONGO_URL`. Set those when changing anything in `server/src/db/adapters/`.

## Architecture rules that affect every change

1. **Never reach into a database driver from a service module.** All persistence goes through `NexusStore` defined in [server/src/db/store.ts](server/src/db/store.ts). The four adapters (`sqlite/`, `postgres/`, `mysql/`, `mongodb/`) all implement the same interface; SQL adapters share repos in `adapters/sql-repos.ts`. If you add a query, add it to the interface and implement it in all four adapters.

2. **String UUIDs everywhere, ISO-8601 timestamps as strings.** That's how one logical schema works across SQLite/PG/MySQL/Mongo without ID-type conversions in service code.

3. **Every state-changing endpoint requires a session and writes an `audit_logs` row.** Use the existing `audit` service — don't invent a parallel log. CSRF is enforced via the `X-Nexus-CSRF` header matching the `nexus_csrf` cookie.

4. **Service modules export a factory (`createXService(...)`)** and are composed in [server/src/index.ts](server/src/index.ts). Routes register under `server/src/routes/` and receive services via the registration options object — don't import services into route files directly.

5. **One Ferrum consumer per Nexus user per namespace.** Approvals add ACL group `nexus:api:<api_id>:approved` to that consumer; revocations remove it. Requestable APIs get an `access_control` plugin allowing only that group.

6. **Show-once credentials.** Plaintext credential material is returned exactly once from the API and never stored — only a fingerprint + last4 lands in `credential_metadata`. Rotation is append-then-delete (new credential added to the Edge consumer, old one finalized later).

7. **Email goes through the outbox.** All transactional mail enqueues into `email_outbox`; a worker polls every 5s with exponential backoff up to 5 retries. Use `EmailService.enqueue` with an `idempotencyKey` for at-most-once semantics (mass email, verification).

8. **The first registered user becomes `super_admin`.** Subsequent users get the role they request. The last active `super_admin` cannot be removed or disabled.

9. **Encrypted `app_settings` rows** (SMTP password, CAPTCHA secret) are AES-256-GCM-encrypted with keys HKDF-derived from `NEXUS_SECRET_KEY`. Rotating that key requires the manual re-encrypt flow in [docs/operations.md](docs/operations.md).

10. **MongoDB requires a replica set** for credential rotation and grant approval (multi-document transactions). Standalone Mongo is rejected at startup unless `NEXUS_DB_ALLOW_STANDALONE=true`.

## Coding conventions

- TypeScript everywhere. No `any` without an escape-hatch comment.
- Explicit return types at public boundaries.
- Backend errors return `{ error: { code, message, details? } }` with a stable `code`.
- Prettier config: 2-space, single quotes, trailing commas, semicolons, 100-col print width. The `.prettierrc.json` is the source of truth.

## Where to start when…

- **Adding a route**: register it in the appropriate file under `server/src/routes/`, wire any new services into `server/src/index.ts`, add the corresponding API call in `web/src/lib/api.ts`.
- **Adding a DB column / table**: write a new migration file under `server/src/db/migrations/` (note the `.sql`, `.pg.sql`, `.mysql.sql` variants), update `NexusStore`, then implement in all four adapters. The Mongo adapter uses one collection per logical table.
- **Touching the Ferrum Edge integration**: changes go through `server/src/ferrum-admin/` — this is the only module that should know Edge's HTTP shape.
- **Adding an audit event**: append to the catalog in [docs/security.md](docs/security.md) and emit via the `audit` service.

## Agent-dispatch skills

`.claude/skills/` holds orchestration skills that dispatch **external** CLI coding agents as
implementation workers on isolated git worktrees. `.agents/skills` is a symlink to the same tree, so
both paths work; the shared binary resolver lives at `.claude/lib/resolve-agent-bin.sh`.

| Skill                                           | Worker                  | CLI            | Effort/model selection                                             |
| ----------------------------------------------- | ----------------------- | -------------- | ------------------------------------------------------------------ |
| `sol-agents`                                    | GPT-5.6 Sol             | `codex`        | `--effort medium\|high\|xhigh` (`--fast` only on explicit request) |
| `opus-agents`                                   | Claude Opus 5 1M        | `claude`       | `--effort`                                                         |
| `fable-agents`                                  | Claude Fable 5          | `claude`       | `--effort`                                                         |
| `grok-agents`                                   | Cursor Grok 4.6         | `cursor-agent` | effort maps to a `cursor-grok-4.6-*` sku                           |
| `composer-agents`                               | Cursor Composer 2.5     | `cursor-agent` | pinned model                                                       |
| `opencode-laguna-agents`                        | opencode laguna-s-2.1   | `opencode`     | `--model`                                                          |
| `deepseek-pro-agents` / `deepseek-flash-agents` | DeepSeek V4 Pro / Flash | `opencode`     | pinned model                                                       |
| `qwen-agents`                                   | Qwen3.8 Max             | `opencode`     | pinned model                                                       |

**Trigger shorthand.** "sol xhigh sub agent" (and the same shape for the other skills — "opus high",
"grok medium") means: use that skill as the orchestrator, dispatch a worker at that reasoning
effort, and follow the skill's worktree isolation, verification, and reporting rules. Never
substitute a different model, effort, or service tier than the one named.

Each skill is self-contained: `SKILL.md` is the orchestrator contract,
`references/agent-brief.md` and `references/continuation-brief.md` are the worker briefs, and
`scripts/dispatch-agent.sh` is the launcher that pins the model and sandbox. Workers are forbidden
from dispatching nested workers.
