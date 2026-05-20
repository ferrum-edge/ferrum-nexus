# Backend API Reference

All endpoints are mounted under `/api`. Responses are JSON. Errors have the
shape `{ error: { code, message, details? } }`.

State-changing requests must include the `X-Nexus-CSRF` header with the value
of the `nexus_csrf` cookie (set automatically by the server alongside the
session cookie).

## Auth

| Method | Path | Description |
| --- | --- | --- |
| POST | `/auth/register` | Register a new user. Returns `{ user, requiresVerification }`. |
| POST | `/auth/login` | Email + password login. Sets session cookie. |
| POST | `/auth/logout` | Destroy session. |
| POST | `/auth/verify-email` | Consume email verification token. |
| POST | `/auth/forgot-password` | Begin password reset (always 202). |
| POST | `/auth/reset-password` | Consume reset token + set new password. |
| POST | `/auth/change-password` | Authenticated; rotates session. |
| GET | `/me` | Current user. |
| PUT | `/me/contact` | Update name/phone. |
| GET | `/public/settings` | Public branding + CAPTCHA + flags. |

## Catalog (any authenticated user)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/catalog/apis` | List visible APIs (filtered by role). |
| GET | `/catalog/apis/:id` | API metadata + provider name. |
| GET | `/catalog/apis/:id/spec` | Latest stored raw OpenAPI document. |
| POST | `/catalog/apis/:id/access-requests` | Submit access request with justification. |

## Client

| Method | Path | Description |
| --- | --- | --- |
| GET | `/client/requests` | The user's access requests. |
| GET | `/client/access` | The user's active grants. |
| GET | `/client/credentials` | The user's credential metadata. |
| POST | `/client/credentials` | Create credential (returns secret once). |
| POST | `/client/credentials/:id/rotate` | Append new credential; mark old `pending_removal`. |
| POST | `/client/credentials/:id/finalize` | Delete a `pending_removal` credential. |

## Provider

| Method | Path | Description |
| --- | --- | --- |
| GET | `/provider/apis` | APIs owned by the authenticated provider. |
| POST | `/provider/apis` | Publish (validate + submit OAS to Edge). |
| PUT | `/provider/apis/:id/spec` | Replace OAS document. |
| PUT | `/provider/apis/:id/settings` | Update safe runtime settings. |
| DELETE | `/provider/apis/:id` | Delete owned API (also removes Edge proxy). |
| GET | `/provider/access-requests` | All requests for owned APIs. |
| POST | `/provider/access-requests/:id/approve` | Approve + add ACL group to Edge consumer. |
| POST | `/provider/access-requests/:id/deny` | Deny with reason. |
| GET | `/provider/apis/:id/consumers` | Active grants on this API. |
| POST | `/provider/grants/:id/revoke` | Revoke with reason. |
| POST | `/provider/test-credentials` | Provider creates a self-test credential. |
| POST | `/provider/apis/:id/announce` | Broadcast a message to authorized clients. |

## Messaging

| Method | Path | Description |
| --- | --- | --- |
| GET | `/messages` | Conversations the user participates in. |
| GET | `/messages/:conversationId` | Messages in a conversation. |
| POST | `/messages/:conversationId` | Send a message. |
| POST | `/messages/:conversationId/read` | Mark all unread messages read. |

## Notifications

| Method | Path | Description |
| --- | --- | --- |
| GET | `/notifications` | Recent notifications + unread count. |
| POST | `/notifications/:id/read` | Mark a notification read. |

## Admin

All require role `admin` or `super_admin`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/users` | List/search users. |
| PUT | `/admin/users/:id/status` | Set status (pending/active/disabled). |
| PUT | `/admin/users/:id/roles` | Replace role assignments. |
| GET | `/admin/organizations` | List organizations. |
| POST | `/admin/organizations` | Create org. |
| GET | `/admin/settings` | Full admin settings (encrypted secrets not exposed). |
| PUT | `/admin/settings/branding` | Update branding. |
| PUT | `/admin/settings/captcha` | Update CAPTCHA (secret encrypted). |
| PUT | `/admin/settings/sender` | Update SMTP (password encrypted). |
| PUT | `/admin/settings/registration` | Toggle registration / verification. |
| GET | `/admin/audit-logs` | Paginated audit log. |
| POST | `/admin/mass-email` | Queue a mass email campaign. |
| GET | `/admin/mass-email` | Recent campaigns. |
| GET | `/admin/drift` | Compare Nexus catalog to Ferrum Edge. |
| POST | `/admin/drift/sync` | Pull metadata updates from Edge. |
| POST | `/admin/imports/api-spec` | Import an existing Edge API into Nexus. |
| GET | `/admin/apis` | All APIs in the catalog (admin view). |
| DELETE | `/admin/god-mode/apis/:id` | Emergency delete with reason. |
| POST | `/admin/god-mode/grants/:id/revoke` | Emergency revoke with reason. |
| POST | `/admin/god-mode/users/:id/disable` | Emergency disable with reason. |
