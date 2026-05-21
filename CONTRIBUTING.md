# Contributing

Thanks for your interest in Ferrum Nexus. This document outlines how to set
up a local development environment and the conventions used in the codebase.

## Local Setup

Requirements:

- Node.js 20.19+ (or 22.12+)
- npm 10+
- A running Ferrum Edge instance (or its mock — see `server/src/ferrum-admin`)
- One of: SQLite (default), PostgreSQL, MySQL, or MongoDB

```bash
# Install workspace deps
npm install

# Copy env template and edit
cp .env.example .env

# Run database migrations (SQLite by default)
npm run migrate --workspace server

# Start backend and frontend together
npm run dev
```

The backend listens on `http://127.0.0.1:8787` and the Vite dev server runs on
`http://127.0.0.1:5173` with `/api` proxied to the backend.

## Project Layout

```
server/   Fastify backend (BFF + Admin API integration)
web/      React + TypeScript SPA
shared/   Shared TypeScript types
docker/   Production container assets
docs/     Architecture and operational docs
```

See `docs/architecture.md` for the design rationale.

## Coding Conventions

- TypeScript everywhere. No `any` unless escape-hatched with a comment.
- Functions and modules have explicit return types at the public boundary.
- Server modules export a single `register(opts)` plugin where possible so they
  can be composed by `server/src/index.ts`.
- Database access goes through `server/src/db/store.ts` — never reach into the
  driver directly from a service module.
- All state-changing endpoints require a session and write an audit log entry.
- Public-facing strings live in the UI; backend errors return a stable code +
  human-readable message.

## Tests

```bash
npm test                     # all
npm test --workspace server  # backend only
npm test --workspace web     # frontend only
```

The backend test harness boots Fastify against an in-memory SQLite database and
a mock Ferrum Edge Admin API.

## Commit / PR Conventions

- Branches: `<user>/<short-topic>`.
- Commits: short imperative subject (~70 chars), optional body with rationale.
- PRs: include a Summary and Test plan section.

## License Acknowledgement

By contributing you agree your contributions are made under the project's
[PolyForm Noncommercial 1.0.0](LICENSE) license and the optional
[Commercial License](LICENSE-COMMERCIAL.md) terms.
