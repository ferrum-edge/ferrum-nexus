# Security Model

## Threat model summary

| Threat | Mitigation |
| --- | --- |
| Credential theft via SPA | Browser never receives Ferrum Admin tokens. Session cookie is HttpOnly + SameSite=Lax. |
| CSRF | Server emits CSRF token in `nexus_csrf` cookie; required on state-changing requests via `X-Nexus-CSRF`. |
| Password attacks | Argon2id hashing. Failed-login counter blocks after 10 attempts; resettable by password reset. Rate limiting on `/api/auth/*`. |
| Spec injection | OpenAPI documents are parsed locally and rejected if missing `x-ferrum-proxy` or using unsupported versions. Edge enforces consumer + credential rejection from specs. |
| Privilege escalation | Every provider and admin action goes through `requireRole`; no role implied by user input. First registered user is bootstrapped as `super_admin`; subsequent users only get the role they choose. Role assignment and god-mode actions require `super_admin`, and the last active `super_admin` cannot be removed or disabled. |
| Stored secrets | Plaintext credentials are never stored. App settings (SMTP password, CAPTCHA secret) are encrypted with AES-256-GCM derived from `NEXUS_SECRET_KEY`. |
| Audit gap | Every mutation writes an `audit_logs` row with actor, target, before/after, IP, and user agent. |
| Brute force on access requests | Rate-limited at the global Fastify level; access requests further capped per user via the application logic (one pending per API). |
| Token replay | Email verification and password reset tokens are single-use, time-bound, and consumed on the first valid use. |

## Required configuration

`NEXUS_SECRET_KEY` MUST be at least 32 characters of entropy. Generate with:

```bash
openssl rand -hex 32
```

Set `NEXUS_SESSION_SECURE=true` in production to mark cookies as Secure (only
sent over HTTPS).

## Audit events

The audit log captures (non-exhaustive):

- `user.register`, `admin.user_status`, `admin.user_roles`
- `access_request.create`, `access_request.approve`, `access_request.deny`,
  `access_grant.revoke`, `admin.god_revoke`
- `api.publish`, `api.spec_replace`, `api.settings_update`, `api.delete`,
  `api.import`, `admin.god_delete_api`
- `credential.create`, `credential.rotate`, `credential.finalize`
- `consumer.create`
- `admin.branding_update`, `admin.captcha_update`, `admin.sender_update`,
  `admin.registration_update`, `admin.mass_email`, `admin.drift_sync`,
  `admin.import_api`, `admin.god_disable_user`

All entries are append-only — there is no delete endpoint. Operators wanting
to redact entries should do so directly in the database with an out-of-band
ticket recorded in the same store.

## Reporting

See [SECURITY.md](../SECURITY.md).
