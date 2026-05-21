# Security Policy

## Reporting a Vulnerability

If you believe you've found a security vulnerability in Ferrum Nexus, please
report it privately to the Ferrum Edge maintainers rather than opening a public
GitHub issue.

We will acknowledge receipt within 3 business days and aim to provide a
remediation timeline within 10 business days.

## Scope

In scope:

- The Ferrum Nexus backend (`server/`) and frontend (`web/`).
- Authentication, session handling, CSRF protection.
- Authorization checks for client, provider, and admin actions.
- Handling of Ferrum Edge Admin API credentials and tokens.
- Storage of portal credentials, secrets, and audit data.

Out of scope:

- Vulnerabilities in Ferrum Edge itself (please report to that project).
- Issues that require an attacker to already have administrator access.
- Self-XSS that requires manipulating one's own browser tooling.

## Hardening Defaults

Ferrum Nexus ships with the following hardening defaults:

- HttpOnly + Secure session cookies.
- CSRF tokens on all state-changing requests.
- Argon2id password hashing.
- Rate limiting on login, registration, credential creation, and access
  request endpoints.
- Server-side-only access to the Ferrum Edge Admin API — Admin API URLs,
  JWT secrets, and generated Admin tokens are never exposed to the browser.
- Encryption at rest for sensitive runtime settings (SMTP password, CAPTCHA
  secret) using a server-side key derivation from `NEXUS_SECRET_KEY`.
- Audit logging on every security-relevant mutation.
