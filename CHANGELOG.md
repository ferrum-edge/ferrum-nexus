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
- Agent-dispatch skills under `.claude/skills/` (`.agents/skills` is a
  symlink to the same tree) for delegating work to external CLI coding
  agents on isolated git worktrees.

### Security

The rewrite was reviewed twice — once by an adversarial pass over the whole
codebase, once independently — and every finding below was proven with a
working exploit before being fixed, and is covered by a regression test that
fails without the fix.

- **Bootstrap election is atomic.** Concurrent registrations against an empty
  portal could _all_ become `super_admin`; the first-user promotion is now a
  single claim on a unique key.
- **`X-Forwarded-For` is only trusted from configured proxies**
  (`NEXUS_TRUSTED_PROXIES`, unset by default). Previously any client could
  forge `request.ip`, bypassing the login rate limit entirely and writing
  false addresses into the audit trail. Cookie `Secure` and HSTS moved to
  their own `NEXUS_COOKIE_SECURE` flag rather than riding on proxy trust.
- **Disabling an account now removes its gateway identity** — ACL groups and
  every credential type — not just its portal sessions. A disabled user's API
  key previously kept working against any API without an access-control
  plugin.
- **State transitions are compare-and-set.** Access decisions, grant
  revocations, role and status changes, and verification-token burns can no
  longer be won twice: a cancel racing an approve could leave working gateway
  access behind cancelled history, and concurrent demotions could empty the
  `super_admin` role entirely.
- **Gateway and portal state cannot silently diverge.** Auth-plugin changes
  attach the replacement before removing the incumbent (a failed swap used to
  leave a live proxy with _no_ authentication), and publish, spec update,
  approval and revocation all unwind their gateway writes when a later step
  fails.
- **Credential rotation re-reads its target inside the per-consumer queue**,
  so a raced rotation can no longer delete every credential of a type and
  hand back a secret that never worked.
- **Thread access follows the caller's current role**, not the immutable
  thread creator, so a demoted admin loses access to broadcast threads.
- **Attacker-authored OpenAPI documents are bounded** by size, path count and
  operation count, and the renderer bounds both schema nodes and mounted
  operation cards. A ~5 KB spec could previously freeze the browser of
  everyone who opened that catalog entry.
- **Password changes end every other session**, and the public health
  endpoint no longer discloses database or gateway internals to anonymous
  callers.
