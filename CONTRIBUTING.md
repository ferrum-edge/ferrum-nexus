# Contributing to Ferrum Nexus

Thanks for helping improve Ferrum Nexus! This page covers setup, the checks to run before a PR,
and the ground rules. For how the test suites work and step-by-step recipes for common changes,
see [docs/contributing.md](docs/contributing.md).

## Prerequisites

- Node.js 22.14 or later (see `.nvmrc`).
- A Ferrum Edge gateway, only for end-to-end work. Unit and integration tests run against a
  built-in mock Admin API.

## Getting started

```bash
npm install
cp .env.example .env   # set NEXUS_SECRET_KEY, FERRUM_ADMIN_URL, FERRUM_ADMIN_JWT_SECRET
npm run migrate        # builds shared, then applies the schema
npm run dev            # backend on :8787, web on :5173 (override with NEXUS_PORT / NEXUS_WEB_PORT)
```

## Project layout

npm workspaces, in build-dependency order:

- `shared/` — types and constants used by server and web. **Build it first**
  (`npm run build --workspace shared`); every top-level script does this for you.
- `server/` — Fastify BFF. All Ferrum Edge Admin API traffic starts here.
- `web/` — React SPA (Vite).

## Checks to run before a PR

```bash
npm run typecheck      # tsc --noEmit across workspaces
npm test               # server: node --test via tsx; web: vitest
npm run format:check   # Prettier (fix with npm run format)
```

There is no ESLint: `npm run lint` is an alias for `npm run typecheck`.

Run a single backend test file:

```bash
cd server && npx tsx --test src/path/to/file.test.ts
```

If you touch `server/src/db/`, also run the cross-adapter smoke tests against PostgreSQL, MySQL,
and MongoDB; see
[docs/contributing.md](docs/contributing.md#cross-adapter-smoke-tests).

## Coverage

```bash
npm run test:coverage                      # server, then web
npm run test:coverage --workspace server   # prints Node's coverage table
npm run test:coverage --workspace web      # prints a text summary, writes web/coverage/lcov.info
```

CI runs the root script in a non-blocking `coverage` job and uploads the summary and
`web/coverage/lcov.info` as the `coverage-report` artifact. It never blocks a merge; it makes
coverage changes visible.

## Schema policy

`v0.1.0` froze the `001_initial` schema baseline. A schema change is a new forward migration with
a higher id in every backend, never an edit to a released one (CI rejects that), and it must
upgrade a retained database in place. See
[schema versioning and upgrades](docs/operations.md#schema-versioning-and-upgrades). A development
database created before `v0.1.0` is disposable: recreate it.

## Ground rules

1. Persistence only through the `NexusStore` interface. Never import a database driver in a
   service module. A new query is added to the interface and implemented in **all four**
   adapters.
2. Every state-changing endpoint requires a session and writes an audit row. The only exceptions
   are the pre-authentication endpoints (register, login, email verification, password recovery).
3. Plaintext credential material is returned exactly once and never stored.
4. All Ferrum Edge Admin API calls live in `server/src/ferrum-admin/`.
5. Service modules export a `createXService(...)` factory and are composed in
   `server/src/index.ts`. Routes receive services through their registration options.
6. TypeScript strict mode, no `any` without an escape-hatch comment, explicit return types at
   public boundaries, Prettier formatting.

The full list of architecture rules is in [CLAUDE.md](CLAUDE.md).

## Commit and PR conventions

- Small, focused PRs with a clear description of behavior changes.
- Add or update tests for anything you change.
- Update `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
- Ferrum Edge vocabularies adopted by Nexus are vendored under
  [`contracts/ferrum-contracts/`](contracts/ferrum-contracts/) and pinned in its `PIN` file. To
  bump the pin, download the adopted vocabulary files from the new immutable
  `contracts-edge-*` tag, update the tag, peeled commit SHA and each file's SHA-256 in `PIN`, then
  run CI. The shared contract test verifies the recorded digests and checks Nexus's local entries
  against the vendored vocabularies. Keep the vendored files out of formatting so their bytes stay
  identical to the tagged release.
- A new audit event must be:
  - added to the catalog in [docs/security.md](docs/security.md#10-audit-event-catalog);
  - classified in `AUDIT_COMMIT_CLASSES` (`server/src/audit/service.ts`). A `transactional` or
    `intent` event is recorded through `audit.forStore(tx)` inside the store transaction.

## License

By contributing, you agree that your contributions are licensed under the project's dual license
(see `LICENSE` and `LICENSE-COMMERCIAL.md`).
