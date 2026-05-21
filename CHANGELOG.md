# Changelog

All notable changes to Ferrum Nexus will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Initial v1 implementation per the Ferrum Nexus Technical Software Plan.
- Multi-user developer portal with client, provider, and admin roles.
- Session-based authentication with Argon2id password hashing, CSRF
  protection, and rate limiting.
- Ferrum Edge Admin API integration: namespaces, API specs, consumers,
  credentials, plugins (auth + `access_control` + rate limiting).
- API catalog with OpenAPI viewer, request-access workflow, approve / deny /
  revoke flows that map to Ferrum consumer ACL group membership.
- Credential lifecycle for `keyauth`, `basicauth`, `jwt`, `hmac_auth`, and
  `mtls_auth` with zero-downtime rotation (append-then-delete) and show-once
  display.
- In-app notifications and a DB-backed email outbox with SMTP delivery.
- Audit log for security-relevant actions.
- Admin features: branding, CAPTCHA toggle, sender configuration, mass email,
  god-mode actions, drift sync from Ferrum Edge.
- Pluggable database layer with SQLite (default), PostgreSQL, MySQL, and
  MongoDB adapters using string UUID identifiers.
- React + TypeScript SPA built with Vite, Tailwind, TanStack Router/Query/
  Table, and Radix UI primitives.
- Docker production image and `docker-compose.example.yml` for end-to-end
  local testing alongside a Ferrum Edge instance.
