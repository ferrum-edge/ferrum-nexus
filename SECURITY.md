# Security Policy

## Reporting a vulnerability

Please **do not** open public GitHub issues for security problems.

Report vulnerabilities privately via GitHub Security Advisories on this
repository ("Report a vulnerability"). Include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof of concept helps).
- Affected version or commit, and your deployment configuration
  (database driver, auth settings) if relevant.

We aim to acknowledge reports within 72 hours and to ship a fix or
mitigation guidance within 30 days for confirmed issues.

## Scope

Ferrum Nexus is the trusted intermediary between untrusted browsers and the
Ferrum Edge Admin API. Reports of particular interest:

- Session, CSRF, or RBAC bypasses in the BFF.
- Any path by which a browser can reach the Ferrum Edge Admin API directly
  or influence Admin API calls beyond its role.
- Credential-material leakage (plaintext credentials are shown once and
  never stored).
- Audit-log evasion for state-changing operations.
- Encryption weaknesses in stored settings (AES-256-GCM with keys derived
  from `NEXUS_SECRET_KEY`).

See [docs/security.md](docs/security.md) for the threat model and hardening
guide.

## Supported versions

Security fixes land on `main`. Pin releases and track `main` for advisories.
