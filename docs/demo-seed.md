# Demo Seed

Ferrum Nexus includes a development-only SQLite seed script for quickly
previewing an active portal with users, providers, catalog APIs, requests,
grants, credentials, messages, notifications, audit history, email outbox rows,
and governance policy data.

The script is idempotent for its deterministic demo records. Re-running it
refreshes the seeded demo rows and keeps `admin@example.com` usable.

## What It Seeds

- 8 users across `admin`, `super_admin`, `provider`, and `client` roles.
- 3 organizations.
- 6 API catalog entries with OpenAPI specs, descriptions, contacts, key facts,
  lifecycle states, visibility states, and governance exception metadata.
- Access requests, active and revoked grants, Ferrum consumer mirrors, and
  credential metadata.
- Conversations, messages, notifications, audit entries, a mass email campaign,
  and sent / failed email outbox rows.
- A governance policy plus one pending and one approved policy exception.
- Branding and registration settings that make the local UI look populated.

## Local Demo Flow

From the repo root:

```bash
npm install

export NEXUS_SECRET_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export FERRUM_ADMIN_URL=http://127.0.0.1:8000
export FERRUM_ADMIN_JWT_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export NEXUS_DB_DRIVER=sqlite
export NEXUS_DB_URL=.context/dev.sqlite

npm run migrate --workspace server
npm run seed:demo
npm run dev
```

Open <http://127.0.0.1:5173>.

The `NEXUS_DB_URL=.context/dev.sqlite` value is interpreted relative to the
`server/` workspace when Nexus runs. The seed script writes to the matching
file at `server/.context/dev.sqlite` by default.

## Demo Logins

All seeded users use password `password123`.

| Email | Role / purpose |
| --- | --- |
| `admin@example.com` | Full demo admin with `admin`, `super_admin`, `provider`, and `client` roles |
| `provider-payments@example.com` | Payments provider |
| `provider-identity@example.com` | Identity provider with a pending governance exception |
| `provider-ops@example.com` | Logistics provider |
| `client-acme@example.com` | Client with active API access |
| `client-beta@example.com` | Client with pending and denied requests |

`pending-user@example.com` is intentionally left in
`pending_admin_approval`, and `disabled-user@example.com` is intentionally
disabled.

## Useful Pages

- `/catalog` — populated catalog with searchable API descriptions, contacts,
  tags, operation summaries, and key facts.
- `/provider/apis` — APIs owned by the logged-in provider persona.
- `/provider/requests` — pending, approved, and denied access requests.
- `/client/access` — active grants plus request history.
- `/client/credentials` — active and pending-removal credential metadata.
- `/messages` — access request, support, announcement, and admin-direct threads.
- `/admin/policy` — governance rules and pending exception review.
- `/admin/pending-registrations` — admin approval queue.
- `/admin/audit` — seeded audit trail.
- `/admin/mass-email` and `/admin/email/failed` API routes — campaign and
  outbox state.

## Refreshing Or Customizing

Refresh the default local demo database:

```bash
npm run seed:demo
```

Seed a different SQLite database path:

```bash
npm run seed:demo -- ./data/demo.sqlite
```

If you pass a custom path, set `NEXUS_DB_URL` so the server uses the same
database. When running through `npm --workspace server`, relative paths are
resolved from `server/`.

## Caveats

The seed script writes directly to SQLite and is meant for local development
only. It does not create Ferrum Edge runtime objects. Read-only portal flows
work without a running Edge Admin API; Edge-backed mutations such as publishing,
deleting Edge specs, creating new credentials, rotating credentials, and drift
sync still require a reachable Ferrum Edge Admin API.
