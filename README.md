# Ferrum Nexus

Ferrum Nexus is the multi-user developer portal and workflow layer that sits in
front of [Ferrum Edge](https://github.com/ferrum-edge/ferrum-edge). Ferrum Edge
owns proxies, upstreams, plugins, consumers, credentials, and runtime gateway
behavior. **Ferrum Nexus owns portal accounts, approvals, messaging,
notifications, branding, audit history, request state, and the user-facing API
catalog.**

The browser never talks to the Ferrum Edge Admin API directly — every gateway
mutation goes through the Nexus backend, which enforces RBAC, audit logging,
and per-user authorization before forwarding to Edge.

> Required Notice: Copyright Ferrum Nexus (https://github.com/ferrum-edge)

## Features

- **API clients** can register, verify their email (and re-send the link),
  reset a forgotten password, manage contact info, create and rotate
  gateway credentials, browse the API catalog with rendered OpenAPI docs,
  request access with a justification, message providers, and receive
  email + in-app notifications.
- **API providers** can publish OpenAPI specs (which create Ferrum Edge
  proxies), choose whether an API is externally requestable, review and
  approve / deny / revoke access requests, edit safe runtime settings (rate
  limits, auth plugin selection, access policy, browser CORS policy, the
  upstream), message clients, and create test consumers for their own APIs.
- **Portal admins** can configure CAPTCHA, branding, email senders and
  templates, send mass emails, manage users / providers / APIs / grants,
  view a historical audit log, and use **god mode** for emergency revoke,
  spec deletion, user disablement, and direct platform messaging.
- **Ferrum integration** uses one Ferrum consumer per Nexus client account
  per namespace. Approvals add an `acl_group` (`nexus:api:<api_id>:approved`)
  to the consumer; revocations remove it. Each requestable API gets an
  `access_control` plugin that allows only that group.

## Architecture

```
Browser
  |
  | HTTPS (same-origin)
  v
Ferrum Nexus SPA (web/)
  |
  | Session cookie + CSRF
  v
Ferrum Nexus BFF (server/)  -->  SMTP / Email provider
  |                          \-> Nexus DB (PG / MySQL / SQLite / Mongo)
  |
  +--> Ferrum Edge Admin API (server-side only, JWT-protected)
```

See [`docs/architecture.md`](docs/architecture.md) for the full design.

## Quickstart

```bash
# Requires Node.js 22.12+ (see .nvmrc)
npm install

cp .env.example .env
# edit .env — at minimum set NEXUS_SECRET_KEY and FERRUM_ADMIN_JWT_SECRET
# (both at least 32 characters; FERRUM_ADMIN_URL defaults to http://127.0.0.1:9000)

npm run migrate   # builds shared, then applies migrations
npm run dev
```

Open <http://127.0.0.1:5173>. The backend serves on `http://127.0.0.1:8787`.

The first user to register becomes the initial `super_admin`, so that one
registration has to prove it comes from you: while the portal has no accounts
the sign-up form asks for a **bootstrap token**. Set `NEXUS_BOOTSTRAP_TOKEN`
yourself, or leave it blank and copy the token the server prints at startup:

```
FIRST-RUN BOOTSTRAP: this portal has no accounts yet.
...
    2f6c1b…  ← paste this into the form's "Bootstrap token" field
```

The generated token lives for the life of that process and differs per
instance, so pin `NEXUS_BOOTSTRAP_TOKEN` for anything running more than one.

## Database

Ferrum Nexus uses string UUIDs across all databases so PostgreSQL, MySQL,
SQLite, and MongoDB share the same logical schema.

```bash
# choose with NEXUS_DB_DRIVER in .env
NEXUS_DB_DRIVER=sqlite      # default; file at ./data/nexus.sqlite
NEXUS_DB_DRIVER=postgres    # NEXUS_DB_URL=postgres://...
NEXUS_DB_DRIVER=mysql       # NEXUS_DB_URL=mysql://...
NEXUS_DB_DRIVER=mongodb     # NEXUS_DB_URL=mongodb+srv://...
```

> Note: with MongoDB, multi-document workflows require a replica set for
> transactional atomicity. See [`docs/operations.md`](docs/operations.md).

## Docker

```bash
docker build -t ferrum-nexus -f docker/Dockerfile .
# FERRUM_ADMIN_JWT_SECRET must match the gateway's own value, and both
# secrets must be at least 32 characters or the server refuses to start.
# The container binds 0.0.0.0, so publish the port on loopback (as below)
# rather than `-p 8787:8787`, which would offer it on every host interface.
docker run --rm -p 127.0.0.1:8787:8787 \
  -e NEXUS_SECRET_KEY=$(openssl rand -hex 32) \
  -e FERRUM_ADMIN_URL=http://host.docker.internal:9000 \
  -e FERRUM_ADMIN_JWT_SECRET="$FERRUM_ADMIN_JWT_SECRET" \
  ferrum-nexus
```

The bootstrap token is printed to the container log
(`docker logs`); pass `-e NEXUS_BOOTSTRAP_TOKEN=…` to choose it instead.

For a full stack alongside Postgres and a Ferrum Edge instance, copy
[`docker/docker-compose.example.yml`](docker/docker-compose.example.yml) and
export its four required secrets first — compose refuses to start without them:

```bash
cp docker/docker-compose.example.yml docker-compose.yml
export NEXUS_SECRET_KEY=$(openssl rand -hex 32)
export NEXUS_DB_PASSWORD=$(openssl rand -hex 16)
export FERRUM_ADMIN_JWT_SECRET=$(openssl rand -hex 32)
export FERRUM_BASIC_AUTH_HMAC_SECRET=$(openssl rand -hex 32)
docker compose up -d
```

## Documentation

Start here:

- [`docs/getting-started.md`](docs/getting-started.md) — end-to-end walkthrough:
  stand up a gateway, publish an API, approve access, and call it with an
  issued credential.

Guides by role:

- [`docs/guides/client-guide.md`](docs/guides/client-guide.md) — consuming APIs.
- [`docs/guides/provider-guide.md`](docs/guides/provider-guide.md) — publishing
  APIs and reviewing access requests.
- [`docs/guides/admin-guide.md`](docs/guides/admin-guide.md) — running the
  portal.

Reference:

- [`docs/architecture.md`](docs/architecture.md) — design rationale, module
  layout, and trust boundaries.
- [`docs/api.md`](docs/api.md) — Nexus backend REST API reference.
- [`docs/operations.md`](docs/operations.md) — running, scaling, backup,
  key rotation, and observability.
- [`docs/security.md`](docs/security.md) — threat model and hardening.
- [`docs/contributing.md`](docs/contributing.md) → [`CONTRIBUTING.md`](CONTRIBUTING.md)

## License

Ferrum Nexus is dual-licensed:

- [PolyForm Noncommercial 1.0.0](LICENSE) for personal, research,
  educational, and nonprofit use.
- [Commercial License](LICENSE-COMMERCIAL.md) for commercial use.

See [`SECURITY.md`](SECURITY.md) to report security issues.
