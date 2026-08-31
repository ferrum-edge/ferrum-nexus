# Changelog

All notable changes to Ferrum Nexus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Ground-up rewrite of the portal: Fastify BFF (`server/`), React SPA
  (`web/`), shared types (`shared/`).
- Portal accounts with sessions, CSRF protection, and role-based access
  control (`client`, `provider`, `admin`, `super_admin`); first registered
  user becomes `super_admin`.
- API catalog with rendered OpenAPI documentation and access requests with
  justification, approval / denial / revocation workflow.
- OpenAPI-driven API publishing that creates Ferrum Edge proxies, with
  per-API access control via consumer ACL groups.
- Show-once gateway credential issuance and rotation (one Ferrum consumer
  per user per namespace).
- Messaging between clients and providers, in-app notifications, and
  transactional email via a retrying outbox worker.
- Admin console: branding, CAPTCHA, email senders/templates, mass email,
  user/provider/API/grant management, historical audit log, and god mode.
- Database adapters for SQLite (default), PostgreSQL, MySQL, and MongoDB
  over one logical schema (string UUIDs, ISO-8601 timestamps).
- Docker image and example compose stack; CI workflow (typecheck, tests,
  build).
