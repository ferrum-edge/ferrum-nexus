# Security Policy

## Reporting a vulnerability

Please **do not** open public GitHub issues for security problems.

Report vulnerabilities privately through GitHub Security Advisories on this
repository (**Security → Report a vulnerability**). Include:

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
guide, and [docs/known-limitations.md](docs/known-limitations.md) for the standing
deployment, gateway-write and single sign-on limits.

## Supported versions

| Version                  | Security fixes                                                    |
| ------------------------ | ----------------------------------------------------------------- |
| 1.x, latest minor        | Yes, from `1.0.0` onward, as patch releases of that minor release |
| 1.x, earlier minors      | No; upgrade to the latest 1.x release                             |
| 0.x, latest release      | Until `1.0.0` is released, as a new 0.x release                   |
| 0.x, any earlier release | No                                                                |

Security fixes land on `main` first and ship in the next release. From `1.0.0` onward
they are released as patch releases of the latest 1.x minor release, which is
compatible with the earlier 1.x releases, so upgrading within 1.x is how an older 1.x
deployment receives a fix. Before `1.0.0`, only the latest 0.x release is supported,
and a fix ships in the next 0.x release. Each release supports one Ferrum Edge
release, named in its
[compatibility record](release/compatibility.env); run that pair. Watch this
repository's security advisories and release notes for fixes.
