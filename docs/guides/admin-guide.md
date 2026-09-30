# Admin guide

For the people who run the portal: accounts and roles, organizations, settings,
email, mass email, the audit log, and god mode.

Everything here lives under **Administration** in the sidebar. Two roles use
it. An **admin** manages accounts, APIs and most settings. A **super admin**
also controls who holds admin roles, the security-sensitive settings, and god
mode. Each section says which role it needs.

Related: [`provider-guide.md`](provider-guide.md) ·
[`../operations.md`](../operations.md) · [`../security.md`](../security.md)

---

## Roles and users

### The role model

Roles are ordered, and each role has everything the one below it has:

```
client  <  provider  <  admin  <  super_admin
```

| Role            | Adds                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| **Client**      | Catalog, access requests, applications, credentials, messages, notifications, profile |
| **Provider**    | Publishing APIs, and deciding access requests on their **own** APIs                   |
| **Admin**       | Users, organizations, every API and grant, settings, templates, mass email, audit log |
| **Super Admin** | Granting and removing admin roles; SMTP, CAPTCHA and gateway settings; god mode       |

Visitors can register only as Client or Provider. Admin roles are granted by a
super admin.

### Rules the portal enforces

- **Only a super admin grants or removes admin roles.** An admin can move
  accounts between Client and Provider, nothing more. An admin also cannot
  disable or re-enable an Admin or Super Admin account. Either attempt returns
  `403`.
- **Only a super admin changes SMTP, CAPTCHA or the gateway address.** Whoever
  controls the mail relay receives every verification and password-reset link;
  whoever controls the gateway address decides where clients send their
  credentials. Admins can still edit branding, registration policy, email
  templates and send mass email.
- **The last active super admin cannot be demoted or disabled.** The request is
  refused with `409 LAST_SUPER_ADMIN`.
- **Nobody can disable their own account**, through the Users page or god mode.

> **Create a second super admin on day one.** If you lose the only one, recovery
> needs server access; see
> [`../operations.md`](../operations.md#recovering-a-portal-with-no-super-admin).

### The first super admin

While the portal has no active super admin, the next registration becomes one,
is marked as verified, and ignores the registration policy. That registration
must include the **bootstrap token**: `NEXUS_BOOTSTRAP_TOKEN`, or the one-time
value the server prints at startup. The register form shows a **Bootstrap
token** field while this applies. See
[`../operations.md`](../operations.md#first-run-and-the-bootstrap-token).

### Managing accounts

**Administration → Users** lists every account. Search by name or email, and
filter by role, status and organization.

On each row you can:

- change the **role** with the role selector;
- choose **Edit** to change the display name or organization;
- choose **Disable** or **Enable**.

You cannot change an account's email or password. Users change their own
password from **Profile**; a new email address means a new account.

### Disabling an account

Disabling an account:

- ends every session it holds, so open browser tabs get `401` on their next
  request;
- blocks sign-in with `403 USER_DISABLED`;
- **revokes its gateway access**: every credential of every type on its own
  consumer and on each of its applications is deleted, its access groups are
  removed, and any provider test consumer it created is deleted;
- **keeps its grants**, so re-enabling can restore the access it was approved
  for.

If the gateway is unreachable, the account is still disabled, the response
says `gateway_teardown: "pending"`, and the revocation is retried until it
succeeds. The row shows **Gateway revocation pending** with a **Retry** button.
Treat that as an open incident: the account's keys keep working until it
clears. See [`../operations.md`](../operations.md#11-gateway-revocation-for-disabled-accounts).

**Re-enabling** sets the status back to active and cancels any queued
revocation. The user signs in normally. Access groups come back for every grant
that is still active, but credentials do not: the user issues new ones. Revoked
grants and test consumers are not recreated. If restoring the gateway groups
fails, the request returns an error after the status has changed; enable the
account again to finish. It is safe to repeat.

To also withdraw the account's approvals, use [god mode → Disable an
account](#disable-an-account) with **Also revoke every grant held by this
account**.

---

## Organizations

**Administration → Organizations** holds a name and optional description per
organization. Names are unique, ignoring case.

Assign an account to one from **Users → Edit**. Organizations exist for
filtering the user list and targeting mass email ("everyone at Acme"). They
carry no permissions: access is always decided per account, per API.

---

## Settings

**Administration → Settings** has five tabs: **Branding**, **Gateway**,
**CAPTCHA** (which also holds the registration policy), **Email** and
**Templates**.

### Branding

Applies to the portal UI and every outbound email. Branding is served without
sign-in (the login page needs it), so keep it to public information.

| Field                     | Notes                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| **Portal name**           | Header, page titles, and `{{portal_name}}` in emails.                                               |
| **Support email**         | Linked from the footer and the sign-in page. Use a monitored inbox.                                 |
| **Tagline**               | Headline of the sign-in hero. Leave empty for the default.                                          |
| **Logo**                  | PNG or SVG under 256 KB. Also used as the browser tab icon.                                         |
| **Primary colour**        | `#rgb` or `#rrggbb`. Drives buttons, active navigation, focus rings and derived tints.              |
| **Accent colour**         | `#rgb` or `#rrggbb`. Secondary emphasis such as informational badges.                               |
| **Default theme**         | Dark, Light, or follow the visitor's system setting. Visitors can override it.                      |
| **Corners**               | Square, Subtle, Rounded (default) or Soft.                                                          |
| **Typeface**              | System (no download), Inter or Manrope (both bundled).                                              |
| **Navigation rail**       | Match surfaces, or High contrast (an always-dark rail).                                             |
| **Sign-in layout**        | Split (branded panel beside the form) or Centered (form only).                                      |
| **Footer text** and links | An optional legal line and up to five `http(s)` links, shown in the footer and on the sign-in page. |

Colours with alpha (`#rgba`, `#rrggbbaa`) are refused. The **Preview** card
shows both themes as you edit.

### Gateway (super admin)

**Public gateway URL** is the address clients send API requests to: the
gateway's proxy listener. It is not the Admin API address Nexus uses, and not
the portal's own address (`NEXUS_PUBLIC_URL`).

It must be an absolute `http(s)` origin: scheme, host, and port if
non-default, with no path, query string or credentials. For example,
`https://api.example.com`.

Once set, every API shows an invoke URL of `<origin>/<namespace>/<slug>` in the
catalog, on the client's Credentials page and on the provider's API overview.
Until then, clients see only the listen path and are told to ask you.

If the field is blank, the portal uses the `FERRUM_GATEWAY_PUBLIC_URL`
environment variable. A saved value wins over the environment.

This tab also shows **Gateway references need repair** when the gateway no
longer holds objects the portal created, for example after the gateway was
rebuilt. See [`../operations.md`](../operations.md#13-retargeting-or-rebuilding-ferrum-edge).

### CAPTCHA (super admin)

Protects sign-in and registration from automated abuse. Turn it on if
self-service registration is open to the internet. Providers: **Cloudflare
Turnstile**, **hCaptcha** and **Google reCAPTCHA**.

1. At the vendor, create a site for your portal's domain and copy the **site
   key** and **secret key**.
2. In **Settings → CAPTCHA**, tick **Require a CAPTCHA challenge**, choose the
   **Provider**, and paste both keys.
3. Choose **Test this CAPTCHA configuration** and complete the challenge. You
   cannot save until the test passes, and it runs again whenever you change the
   provider or either key.
4. Save. Then load the sign-in page in a private window and check the widget
   works.

Things to know:

- **The secret key is write-only.** It is stored encrypted and never shown
  again. Keep your own copy; you will need it after a `NEXUS_SECRET_KEY`
  rotation ([`../operations.md`](../operations.md#7-rotating-nexus_secret_key)).
- **It fails closed.** If the vendor later becomes unreachable or the secret
  stops working, nobody can sign in or register. Turning CAPTCHA off never
  needs a challenge, so a signed-in super admin can always switch it off.
- **If nobody can sign in**, an operator restarts the server with
  `NEXUS_CAPTCHA_ENFORCEMENT=disabled`. Challenges are skipped without changing
  your settings, this card shows a warning, and sessions created meanwhile are
  audited with `captcha_bypassed: true`. See
  [`../operations.md`](../operations.md#recovering-a-portal-locked-out-by-captcha).

The site key is public by design; the secret never leaves the server.

### Registration policy

The **Registration** card sits on the CAPTCHA tab and is editable by any admin.

| Setting                                       | Effect                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Allow self-service registration**           | Off means nobody can sign up; you create accounts.                                          |
| **Require email verification before sign-in** | Users must click an emailed link before they can sign in.                                   |
| **Self-selectable roles**                     | Which of Client and Provider a visitor may pick. Untick Provider to vet providers yourself. |

The sign-up form offers exactly the roles you allow. With none ticked, nobody
can register; turn registration off instead so the form says so plainly.

> **Do not require email verification before email works.** With no SMTP host,
> verification mail waits in the outbox and every new user is locked out.
> Configure SMTP, send a test, then turn verification on.

Verification links expire after 24 hours. Users can request a new one from the
confirmation screen or the sign-in page. There is no admin control to mark an
address verified; if mail is broken, turn verification off until it is fixed.

### Email (super admin for SMTP)

**Settings → Email → Email delivery**:

| Field                   | Notes                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| **SMTP host**           | Until this is set, **all portal email queues and nothing is sent.**                      |
| **Port**                | 587 for STARTTLS, 465 for implicit TLS.                                                  |
| **Use TLS (implicit)**  | On for 465; off for STARTTLS on 587.                                                     |
| **Username / Password** | Leave both empty for an unauthenticated relay. The password is write-only and encrypted. |
| **From address**        | For example `Acme Portal <no-reply@acme.example>`. Your relay must accept it.            |

Saved settings override the deployment's environment variables. The email
worker re-reads them every poll (5 seconds), so no restart is needed.

**Send test email** (any admin) sends one message **directly through SMTP**
using the saved settings, not through the outbox, and shows the relay's own
error (for example `535 authentication failed`). It defaults to your own
address. Run it after every change.

**The quiet failure mode:** with no SMTP host, queued mail waits in `pending`
indefinitely rather than failing, so configuring SMTP later delivers the
backlog. It also means "no email arrives" and "no errors anywhere" can both be
true. If users report missing mail, check the SMTP host first, then ask an
operator to check the outbox ([`../operations.md`](../operations.md#6-the-email-outbox)).

### Email templates

**Settings → Templates** holds nine templates, each with a built-in default:

| Key                  | Sent when                                                      |
| -------------------- | -------------------------------------------------------------- |
| `verification`       | A new account must verify its email address.                   |
| `password_reset`     | Someone asks to reset a password.                              |
| `access_approved`    | An access request is approved.                                 |
| `access_denied`      | An access request is declined.                                 |
| `access_revoked`     | A grant is revoked.                                            |
| `message_received`   | New activity in a message thread.                              |
| `mass`               | The frame around a mass email or broadcast email.              |
| `credential_rotated` | A user's gateway credential is rotated.                        |
| `spec_updated`       | An API a user has access to publishes a changed spec revision. |

Each has a **Subject**, **HTML body** and **Plain-text body**; all three are
required to save. Saving stores an override. The portal uses your override if
there is one, otherwise the default, never a mix.

`message_received` is sent at most once per recipient, per thread, per **10
minutes**, however many messages arrive. The default wording therefore
announces activity and links to the thread. `{{message_preview}}` quotes only
the message that opened the window. In-app notifications are not batched.

`spec_updated` is sent at most once per API, per recipient, per **hour**, for
the first revision in that hour; it links to the API's Changes tab, which lists
every revision. `{{summary}}` and `{{changes}}` quote names from the provider's
document as plain text. Users can turn it off on their profile page.

Handle three templates with care:

- `verification` must keep `{{verification_url}}`, or new users cannot finish
  signing up.
- `password_reset` must keep `{{reset_url}}`, or nobody can recover a password.
  The default also says the link expires in an hour, works once, and signs the
  user out everywhere. Keep those facts in any rewrite.
- In `mass`, `{{body_html}}` is inserted as HTML without escaping.

#### Placeholders

Write `{{name}}`. An unknown or missing placeholder renders as empty text.
Values in the HTML body are HTML-escaped; the subject and plain-text body are
inserted as-is. The editor lists the variables available for the open
template.

**Every template:** `portal_name` · `portal_url` · `recipient_name` ·
`recipient_email` · `year`

| Template             | Also available                                                                     |
| -------------------- | ---------------------------------------------------------------------------------- |
| `verification`       | `verification_url`                                                                 |
| `password_reset`     | `reset_url`                                                                        |
| `access_approved`    | `api_name`, `api_slug`, `api_url`, `decided_by_name`, `decision_note`              |
| `access_denied`      | `api_name`, `api_slug`, `decided_by_name`, `decision_note`                         |
| `access_revoked`     | `api_name`, `api_slug`, `revoked_by_name`, `reason`                                |
| `message_received`   | `sender_name`, `thread_subject`, `message_preview`, `thread_url`                   |
| `mass`               | `subject`, `body_html`, `body_text`                                                |
| `credential_rotated` | `credential_label`, `credential_last4`, `credentials_url`                          |
| `spec_updated`       | `api_name`, `api_slug`, `version`, `headline`, `summary`, `changes`, `changes_url` |

The retired `reset_token` and `verification_token` placeholders render empty,
and saving a template that contains either is refused. Use `{{reset_url}}` and
`{{verification_url}}`; the server builds those links from `NEXUS_PUBLIC_URL`.

**Links and attributes:**

- Only a `*_url` placeholder (`portal_url`, `api_url`, `thread_url`, …) may
  appear in a URL or attribute, and it must be the **whole** value.
  `{{portal_url}}/help` is refused.
- Put `{{reset_url}}` and `{{verification_url}}` only as a whole anchor target,
  such as `<a href="{{reset_url}}">Reset password</a>`. In the plain-text body,
  surround them with whitespace or put them on their own line. Never put them
  in the subject, visible HTML text, an image, CSS, another attribute or a
  query parameter.
- Absolute links must point at the portal's own origin or a host the operator
  approved with `NEXUS_EMAIL_TEMPLATE_ALLOWED_LINK_HOSTS` (comma-separated exact
  `host[:port]`; empty by default; not editable in Settings). Subdomains and
  other ports are not implied.
- Always refused: `javascript:` and `data:` URLs, active HTML, HTML comments,
  malformed tags or attributes, CSS escapes, comments and imports, and
  unsupported named entities (use literal characters or numeric entities).
  Simple inline styles and approved CSS `url(...)` work.

A refused save names the field and the host or construct. Templates are checked
again before each email is queued, including mass-email HTML. A stored template
that no longer passes is skipped in favour of the default, with a warning in the
server log; edit it or restore the default to clear the warning. A mass email
that links to an unapproved host is refused and nothing is queued.

Each save is audited as `admin.template_update`, with SHA-256 digests of the two
bodies (`body_html_sha256`, `body_text_sha256`) rather than the bodies
themselves.

---

## Mass email

**Administration → Mass email** sends one announcement to a chosen audience.

1. Choose the **Audience** (below).
2. Write a **Subject** (up to 300 characters) and a **Plain-text body**. The
   **HTML body** is optional; if you leave it empty, the plain text is used.
3. Choose **Send** and confirm.

### Audience

| Audience              | Reaches                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| **Everyone**          | Every **active** account. Disabled accounts are never included.        |
| **Filtered**          | Any combination of **Roles**, **Account status** and **Organization**. |
| **Specific accounts** | Accounts you pick with **Find an account**, up to 5000.                |

Under **Filtered**, leave every role unticked to include all roles.
**Admin and Super Admin are separate roles**: ticking only Admin misses every
super admin. **All administrative roles** ticks both.

**Add myself**, under Specific accounts, is the quick way to send yourself a
test first.

### How it sends

Each recipient gets their own queued message, never a BCC. One bad address
retries and fails on its own without affecting the rest.

The whole campaign is queued in one transaction: it is either queued in full or
not at all. The response reports `recipients` (audience size), `enqueued`
(messages queued) and `batch_id`. A failure returns `500` with
`details: { batch_id, recipients, enqueued: 0 }`; a busy portal returns `409`.
Both are safe to retry.

One campaign may reach at most `NEXUS_MAX_MASS_EMAIL_RECIPIENTS` accounts (5000
by default). A larger audience is refused before anything is queued, with a
message naming the limit and the setting. On a MongoDB-backed portal a long
body lowers the practical limit, to roughly 800 recipients at 10 KB.

### Retrying safely

The composer gives each campaign a random ID. After a timeout or network error,
send the **unchanged** form again from the same page: it reuses the ID, so
nobody is mailed twice. **Mass email already queued** means the first attempt
had succeeded and the retry added nothing.

Changing the content or audience, or a successful send, starts a new campaign.
Reloading or leaving the page loses the ID, so check the audit log
(`admin.mass_email`) before sending again.

API callers get the same protection by sending an `idempotency_key` (8–128
characters). Without one, **every send is a new campaign**.

### Before you send

- Send to yourself first (Specific accounts → **Add myself**).
- Read the plain-text body as well as the HTML; many clients show it.
- Run **Send test email**, so you are not queueing thousands of messages
  against a broken relay.

Every send is audited with the subject, audience and counts.

---

## The audit log

**Administration → Audit log** records every state-changing operation. It is
append-only: nothing in the application edits or deletes an entry.

Each row records **who** (the actor and their role at the time), **what** (an
action such as `access.approve`), the **target** (type and id), structured
details, the client IP, and when.

Filter by **action** (exact name), **actor user ID**, **target ID**, and a
**From**/**To** time range. The API (`GET /api/admin/audit-logs`) also filters
by `target_type`.

Actions are named `<domain>.<verb>`. Domains: `auth`, `user`, `org`, `api`,
`access`, `application`, `credential`, `test_consumer`, `message`,
`notification`, `admin`, `gateway` and `god`. The full catalog, with each
action's details, is in [`../security.md`](../security.md#10-audit-event-catalog).

Common investigations:

| Question                        | Filter                                                  |
| ------------------------------- | ------------------------------------------------------- |
| Everything one person did       | Actor user ID = their id                                |
| Who approved this request       | Target ID = the access request id                       |
| History of one API              | Target ID = the API id                                  |
| When was this credential issued | Target ID = the credential id                           |
| Emergency actions this month    | Action = each `god.*` action in turn, with a date range |

The log does **not** contain:

- **reads** (browsing, opening specs, reading the audit log);
- **secrets**: a settings change records which keys changed, never their
  values; a credential event records the type and last four characters only;
- **failed sign-ins**, which are rate-limited instead, so nobody can flood the
  table by guessing.

---

## God mode (super admin)

**Administration → God mode** holds four emergency operations. Each needs a
written **Reason** and a typed confirmation.

God mode adds no new capability. It lets you act on **someone else's**
resources without owning them, and records why. Every action writes two audit
rows: the ordinary one (`access.revoke`, `api.delete`, …) and a `god.*` row with
your reason.

Each picker lists the 200 most recent records. For anything older, paste the
exact **Grant ID**, **API ID** or **Account ID**. Check the ID shown in the
confirmation dialog before you confirm. The usual role, self-disable and
last-super-admin rules still apply.

### Emergency grant revocation

**Affects:** one identity, one API. Confirm by typing `REVOKE`.

Revokes any grant, whoever owns the API. The API's access group is removed from
the grantee's gateway consumer, so their next call to that API gets `403`. Their
credential and their other APIs are untouched.

_Use when_ access must stop now and the provider cannot be reached.

### Delete an API

**Affects:** one API and all its consumers. **Irreversible.** Confirm by typing
the API's slug (`DELETE` for an ID outside the picker list).

Removes the API, its gateway proxy and plugins, whoever owns it. Calls start
failing immediately; the access group comes off every grantee; all grants,
requests and spec revisions are deleted; grantees are notified.

**Also revoke every active grant for this API** records each grant as its own
`access.revoke` entry before the deletion. The grants go either way; this makes
each one visible in the audit log. Turn it on during an incident.

_Use when_ an API is leaking data or breaking policy and the owner cannot act.
Otherwise ask the provider to **retire** it, which stops new onboarding without
breaking anyone.

### Disable an account

**Affects:** one account, everywhere. Confirm by typing the account's email
(`DISABLE` for an ID outside the picker list).

Disables the account exactly as [Disabling an account](#disabling-an-account)
describes: sessions end, sign-in is blocked, and its gateway credentials are
revoked. **Also revoke every grant held by this account** additionally revokes
its approvals, so re-enabling it later does not restore any access. For a
security incident, turn it on.

Refused for the last active super admin and for your own account.

_Use when_ an account is compromised or someone has left.

### Platform broadcast

**Affects:** everyone in the audience except you. Confirm by typing `BROADCAST`.

Each recipient gets a bell notification and the message in their **platform
inbox thread**, where any admin can follow up. Tick **Also send this as an
email** to queue an email too. The audience picker works as in [mass
email](#audience); use **All administrative roles** for an incident, because
ticking only Admin leaves out every super admin.

Limits, checked before anything is written:

- `NEXUS_MAX_BROADCAST_RECIPIENTS` (default 5000) per broadcast;
- `NEXUS_MAX_BROADCASTS_PER_DAY` (default 20) per super admin in a rolling
  24 hours. A slot is used as soon as you confirm, even if the send then
  fails. An audience that matches nobody is refused and uses no slot.

Broadcasts do not count against your own daily message allowance.

The response reports `delivered` (inboxes reached) and `failed`. One unreachable
account never stops the rest. The audit log records the attempt
(`god.broadcast`) and the outcome (`god.broadcast_complete`) separately.

Retrying unchanged content from the same form does not send duplicate email.
API callers can pass `idempotency_key` (8–128 characters); without one,
identical content to the same audience is still not emailed twice. This applies
to email only: in-app notifications and inbox messages are sent on every call.

_Use for_ incidents, maintenance windows and forced credential rotations. For
routine news, use **mass email**: a broadcast adds an inbox thread per
recipient.

---

## Routine checks

**Daily**

- `GET /api/health` reports `ok` (or `degraded` for a known gateway issue).
- No unexpected `god.*` entries in the audit log.
- No accounts showing **Gateway revocation pending** on the Users page.

**Weekly**

- Skim the audit log for `user.role_change` and `api.delete`.
- Check the email outbox for `failed` rows
  ([`../operations.md`](../operations.md#6-the-email-outbox)).
- Look for access requests no provider has answered. Clients tend to message
  support rather than chase.

**Periodically**

- Confirm at least **two** active super admins.
- Review who holds Admin and Super Admin.
- Test that backups restore, for both the Nexus database **and** Ferrum Edge.
- Run **Send test email**; relay credentials expire quietly.

---

## Troubleshooting

**"I cannot promote someone to admin."** Only a super admin can grant admin
roles.

**"I cannot disable this account."** It is the last active super admin, it is
an administrator and you are an admin, or it is your own account.

**"Nobody can sign in or register after CAPTCHA was turned on."** CAPTCHA fails
closed, so a broken vendor or secret refuses every attempt. If a super admin is
still signed in, untick **Require a CAPTCHA challenge** and save. Otherwise an
operator restarts the server with `NEXUS_CAPTCHA_ENFORCEMENT=disabled`
([runbook](../operations.md#recovering-a-portal-locked-out-by-captcha)).

**"New users never get their verification email."** SMTP is missing or broken
and the mail is waiting in the outbox. Fix SMTP and send a test; the backlog
then drains. Meanwhile, turn off **Require email verification before sign-in**.

**"A disabled user's API key still works."** The gateway revocation has not
finished. On **Users**, look for **Gateway revocation pending** on that account
and choose **Retry**. If it keeps failing, the gateway is unreachable; see
[`../operations.md`](../operations.md#11-gateway-revocation-for-disabled-accounts).

**"A provider is unresponsive and a client is blocked."** Any admin can
approve, deny or revoke on any API without god mode, and that leaves a cleaner
trail. Open **Administration → All APIs** and select the API to reach its
management page, including **Requests** and **Grants**. The catalog page also
shows **Manage API** to admins.

**"Everything gateway-related fails with 502."** Nexus cannot reach the Ferrum
Edge Admin API, or Edge rejects its credentials. Check `GET /api/health/edge`
and hand it to an operator ([`../operations.md`](../operations.md#9-health-checks)).
The portal keeps working; publishing, approvals and credential operations fail
until it is fixed.
