# Contributing to Ferrum Nexus

Thanks for helping improve Ferrum Nexus!

## Prerequisites

- Node.js 20.19+ (or 22.12+) — see `.nvmrc`.
- A Ferrum Edge gateway for end-to-end work (unit and integration tests run
  against a built-in mock Admin API and need no gateway).

## Getting started

```bash
npm install
cp .env.example .env   # set NEXUS_SECRET_KEY, FERRUM_ADMIN_URL, FERRUM_ADMIN_JWT_SECRET
npm run migrate --workspace server
npm run dev            # backend on :8787, web on :5173
```

## Project layout

npm workspaces, in build-dependency order:

- `shared/` — types/constants used by both server and web. **Build it first**
  (`npm run build --workspace shared`); every top-level script does this
  automatically.
- `server/` — Fastify BFF. All Ferrum Edge Admin API traffic originates here.
- `web/` — React SPA (Vite).

## Checks to run before a PR

```bash
npm run typecheck   # tsc --noEmit across workspaces
npm test            # server: node --test via tsx; web: vitest
npm run format:check
```

Run a single backend test file:

```bash
cd server && npx tsx --test src/path/to/file.test.ts
```

Cross-adapter smoke tests default to SQLite; export
`NEXUS_TEST_POSTGRES_URL`, `NEXUS_TEST_MYSQL_URL`, or `NEXUS_TEST_MONGO_URL`
to also exercise those adapters — always do this when touching
`server/src/db/adapters/`.

## Ground rules

1. Persistence only through the `NexusStore` interface — never import a DB
   driver in a service module. New queries are added to the interface and
   implemented in **all four** adapters.
2. Every state-changing endpoint requires a session and writes an audit row.
3. Plaintext credential material is returned exactly once and never stored.
4. All Ferrum Edge knowledge lives in `server/src/ferrum-admin/`.
5. Service modules export a `createXService(...)` factory and are composed
   in `server/src/index.ts`; routes receive services via registration
   options.
6. TypeScript strict mode; no `any` without an escape-hatch comment;
   explicit return types at public boundaries; Prettier formatting
   (`npm run format`).

## Commit / PR conventions

- Small, focused PRs with a clear description of behavior changes.
- Add or update tests for anything you change.
- Update `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
- New audit events must be added to the catalog in `docs/security.md`.

## License

By contributing you agree that your contributions are licensed under the
project's dual license (see `LICENSE` and `LICENSE-COMMERCIAL.md`).
