# Admin guide

For the people who run the portal: accounts and roles, organizations, branding,
CAPTCHA, email, mass email, the audit log, and god mode.

Two roles are covered here. An **admin** manages users, content and settings.
A **super admin** additionally controls who else becomes an administrator, and
holds the four god-mode operations. Everything below says which is which.

Related: [`provider-guide.md`](provider-guide.md) ·
[`../operations.md`](../operations.md) · [`../security.md`](../security.md)

---

## Roles and users

### The role model

Roles are strictly ordered and a higher role inherits everything below it:

```
client  <  provider  <  admin  <  super_admin
```

| Role            | Gets                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| **client**      | Catalog, access requests, own credentials, messaging, notifications, profile              |
| **provider**    | Everything a client has, plus publishing APIs and deciding requests on their **own** APIs |
| **admin**       | Everything, plus users, organizations, any API, any grant, settings, email, audit log     |
| **super_admin** | Everything, plus granting/revoking admin roles and god mode                               |

Only **client** and **provider** are self-selectable at registration. Admin
roles are conferred, never requested.

### The rules the portal enforces for you

Two guardrails you cannot switch off, and it is worth knowing them before you
hit them:

**An admin cannot make another admin.** Only a **super admin** may promote an
account _to_ `admin`/`super_admin`, or demote one _from_ those roles, or disable
an existing administrator. An admin trying it gets a clear `403`. This is what
keeps a single compromised admin account from escalating itself.

**The last active super admin is untouchable.** Demoting, disabling or removing
the only remaining active `super_admin` is refused. The check asks "is anyone
else left?", so it triggers exactly when it should.

> **Create a second super admin on day one.** The guard is a safety net, not a
> convenience — the situation where you notice it is one where you have already
> lost your only administrator.

You also cannot disable **your own** account, ordinary route or god mode.

### The first user

The first account ever registered becomes `super_admin` automatically, is
auto-verified, and bypasses the registration policy. That is how a fresh
install bootstraps. Every later registration gets only the role it asked for,
subject to your policy.

### Managing accounts

**Administration → Users.** Filter by role, status, organization, or search
across email and display name.

Per account you can change the **display name**, **role**, **organization** and
**status**. You cannot change someone's email address or password from here —
they change their own password from their profile; an email change means a new
account.

### Disabling an account

Setting status to **disabled**:

- **destroys every session the account holds**, so open browser tabs get a
  `401` on their next request rather than a working page;
- blocks sign-in with `403 USER_DISABLED`;
- leaves their **grants and gateway credentials intact**.

That last point matters. A disabled user cannot use the _portal_, but their API
keys keep working against the _gateway_, because those are two different
systems. If you are disabling someone because of a security incident, use
**god mode → Disable user with "revoke grants"**, which does both.

Re-enabling is just setting the status back to active; they sign in again
normally.

---

## Organizations

**Administration → Organizations.** A lightweight grouping — a name and an
optional description — used to tag accounts, mainly so mass email can target
"everyone at Acme" and so user lists can be filtered by customer.

Create one, then assign accounts to it by editing the user's `org_id`.
Organizations carry no permissions of their own: membership never grants or
restricts access to anything. Access is always decided per user, per API.

Names are unique case-insensitively.

---

## Branding

**Administration → Settings → Branding.** Applies to the portal UI _and_ to
every outbound email.

| Field                       | Notes                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Portal name**             | Header, page titles, and `{{portal_name}}` in every email.                                                                                      |
| **Logo**                    | Uploaded and stored as a data URL, max ~512 KiB encoded. A small PNG or SVG is right; a full-resolution photo will be rejected.                 |
| **Primary / accent colour** | CSS hex values. Drive the SPA's theme variables.                                                                                                |
| **Default theme**           | `dark`, `light`, or `system` — what a visitor sees before they choose. Individual users can override it and their choice is remembered locally. |
| **Tagline**                 | Short line on the login and register pages.                                                                                                     |
| **Support email**           | Surfaced in the footer. Point it at a monitored inbox.                                                                                          |

Branding is served **unauthenticated** (the login page needs it before anyone
signs in), so keep it to genuinely public information.

---

## CAPTCHA

**Administration → Settings → CAPTCHA.** Protects registration and sign-in from
automated abuse. Enable it if self-service registration is open to the
internet.

Supported providers: **Cloudflare Turnstile**, **hCaptcha**, **reCAPTCHA**.

Setup, whichever you pick:

1. Create a site at the vendor and register your portal's domain.
2. Copy the **site key** and the **secret key**.
3. In Settings → CAPTCHA: choose the provider, paste the site key, paste the
   secret key, tick **Enabled**, save.
4. Sign out and load the login page in a private window. The widget should
   render; complete it and sign in.

Two things to know:

- **The secret key is write-only.** It is stored encrypted and never shown
  again — the form displays only whether one is set. Keep your own copy in a
  password manager. You will need it after a `NEXUS_SECRET_KEY` rotation (see
  [`../operations.md`](../operations.md#7-rotating-nexus_secret_key)).
- **It fails closed.** Enabled with a missing or wrong secret, or an
  unreachable vendor, means **nobody can register or sign in** — every attempt
  returns a CAPTCHA error. Always verify with a real sign-in in a private
  window immediately after enabling. If you lock yourself out, an operator can
  clear the setting directly in the database or re-run with a corrected
  configuration.

The site key is public by design (it appears in the login page's config). The
secret never leaves the server.

---

## Registration policy

**Administration → Settings → Registration.**

| Setting                        | Effect                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| **Open registration**          | Off means no self-service sign-up at all; you create accounts.                             |
| **Allowed roles**              | Which roles a visitor may self-select. Restrict to `client` if providers should be vetted. |
| **Require email verification** | Users must click an emailed link before they can sign in.                                  |

> **Do not turn on email verification before SMTP works.** Verification links
> go through the outbox; with no SMTP host configured they queue forever and
> every new user is locked out. Configure SMTP, send a test, _then_ enable it.

Verification links are single-use and expire after 24 hours. If a user's link
expires or never arrives, the simplest remedy is to look them up in
Administration → Users and confirm their status yourself.

The policy never applies to the very first account.

---

## Email

**Administration → Settings → Email.**

### SMTP

| Field                   | Notes                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| **Host**                | Until this is set, **all portal email queues and nothing sends.**                         |
| **Port**                | 587 for STARTTLS, 465 for implicit TLS.                                                   |
| **Secure**              | On for implicit TLS (465); off for 587.                                                   |
| **Username / Password** | Omit both for an unauthenticated relay. The password is write-only and stored encrypted.  |
| **From address**        | RFC 5322, e.g. `Acme Portal <no-reply@acme.example>`. Must be one your relay will accept. |

Settings saved here **override** the deployment's environment variables, so you
can move to a different relay without a redeploy. The worker re-reads them on
every poll — a fix takes effect within about five seconds, no restart.

**Send test email** delivers a probe **straight through SMTP, bypassing the
outbox**, so you get the real error immediately instead of finding it in the
queue. A misconfiguration returns the relay's own message
(`getaddrinfo ENOTFOUND …`, `535 authentication failed`). Always run it after
changing anything.

### The quiet failure mode

With no SMTP host, queued mail sits in `pending` **indefinitely** rather than
failing. That is deliberate — configuring SMTP later delivers the backlog
instead of losing it — but it means "no email is arriving" and "no errors
anywhere" can both be true at once. If users report missing mail, check the
SMTP host first, and ask an operator to check the outbox queue
([`../operations.md`](../operations.md#6-the-email-outbox)).

### Email templates

**Administration → Settings → Email templates.** Seven transactional templates,
each with a built-in default you can override:

| Key                  | Sent when                                              |
| -------------------- | ------------------------------------------------------ |
| `verification`       | A new account must verify its email address.           |
| `access_approved`    | An access request is approved.                         |
| `access_denied`      | An access request is declined.                         |
| `access_revoked`     | A grant is revoked.                                    |
| `message_received`   | Someone receives a portal message.                     |
| `mass`               | The frame around a mass email or a platform broadcast. |
| `credential_rotated` | A user's gateway credential is rotated.                |

Each has a **subject**, an **HTML body** and a **plain-text body**; all three
are required when you save. Editing one stores an override; until then the
built-in default is used. Resolution is override-first, default-second — never
a mix.

#### Placeholders

Write `{{variable_name}}`. An unknown or absent placeholder renders as an empty
string, so a partially-filled template still sends. Values interpolated into
the **HTML** body are HTML-escaped, so a display name containing `<script>` can
never become markup; the subject and text body are plain text and interpolated
verbatim.

**Available in every template:**

`portal_name` · `portal_url` · `recipient_name` · `recipient_email` · `year`

**Per template, in addition:**

| Template             | Extra placeholders                                                    |
| -------------------- | --------------------------------------------------------------------- |
| `verification`       | `verification_url`, `verification_token`                              |
| `access_approved`    | `api_name`, `api_slug`, `api_url`, `decided_by_name`, `decision_note` |
| `access_denied`      | `api_name`, `api_slug`, `decided_by_name`, `decision_note`            |
| `access_revoked`     | `api_name`, `api_slug`, `revoked_by_name`, `reason`                   |
| `message_received`   | `sender_name`, `thread_subject`, `message_preview`, `thread_url`      |
| `mass`               | `subject`, `body_html`, `body_text`                                   |
| `credential_rotated` | `credential_label`, `credential_last4`, `credentials_url`             |

The editor shows the exact list for the template you have open. Using a
placeholder that is not on that template's list is not an error — it simply
renders empty.

Two worth handling carefully: `verification_url` is the only way a new user can
complete sign-up, so never remove it from the `verification` template; and in
`mass`, `body_html` is inserted **as HTML** without escaping (that is the point
of a composer), so only administrators can author it.

---

## Mass email

**Administration → Mass email.** Compose a subject and a body and send to a
selected audience.

### Audience

| Scope        | Reaches                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| **All**      | Every **active** account. Other filters are ignored. Disabled accounts are never mailed. |
| **Filtered** | Combine role, status and organization.                                                   |
| **Explicit** | A specific list of accounts, up to 5000.                                                 |

### How it sends

**One queued message per recipient**, never a BCC blast. A bad address retries
and eventually fails on its own instead of taking the whole send down with it,
and each recipient's delivery state is visible individually.

The response tells you both numbers: `recipients` (how many matched) and
`enqueued` (how many rows were actually created).

### Idempotency

Supply an **idempotency key** (8–128 characters) and the send becomes
at-most-once: re-posting the same request with the same key enqueues nothing
new. Use it whenever you are sending to a large audience — if the request times
out, you can safely retry without double-mailing everyone.

Without a key, each send is a fresh batch and **sending twice mails everyone
twice**.

### Before you press send

- Send to yourself first with an **explicit** audience of one.
- Check the plain-text body as well as the HTML — plenty of clients render it.
- Confirm SMTP is healthy; otherwise you are queueing thousands of messages
  against a relay that is not working.
- Every send is audited with the subject, audience scope and counts.

---

## The audit log

**Administration → Audit log.** Every state-changing operation in the portal
writes exactly one row. It is append-only — nothing in the application can edit
or delete an entry.

Each row records **who** (actor and their role at the time), **what** (a
dot-namespaced action such as `access.approve`), **which thing** (target type
and id), **structured detail**, the client **IP**, and **when**.

Filter by actor, action, target type, target id, and a time range.

### Reading it

Actions are `<domain>.<verb>`: `auth.*`, `user.*`, `org.*`, `api.*`,
`access.*`, `credential.*`, `message.*`, `notification.*`, `admin.*` and
`god.*`. The complete catalog, with what each `details` object contains, is in
[`../security.md`](../security.md#10-audit-event-catalog).

Investigations that come up often:

| Question                          | Filter                                                            |
| --------------------------------- | ----------------------------------------------------------------- |
| Everything one person did         | `actor_user_id` = their id                                        |
| Who approved this access          | `target_type` = `access_request`, `target_id` = the request id    |
| Every emergency action this month | `action` starting `god.` (query one at a time), with a date range |
| History of one API                | `target_type` = `api`, `target_id` = the API id                   |
| When was this credential issued   | `target_type` = `credential`, `target_id` = the credential id     |

### What it does not contain

**Reads.** Browsing the catalog, opening a spec, listing grants and reading the
audit log itself write no rows. The log records _changes_; auditing every page
view would bury them.

**Secrets.** A settings update records the _names_ of the keys that changed and
never their values. A credential event records the type and the last four
characters, never the material.

**Failed sign-ins.** They are rate-limited rather than logged — recording them
would let anyone fill the table by guessing.

---

## God mode (super admin only)

**Administration → God mode.** Four emergency operations, all requiring a
**written reason**.

Nothing here is a new capability — every action is reachable through an ordinary
endpoint by _somebody_. What god mode adds is doing it to **someone else's
resources without being the owner**, and the obligation to say why.

Every god-mode action writes **two** audit rows: the ordinary one for the
underlying operation (`access.revoke`, `api.delete`, …) and a `god.*` row
carrying your reason. An emergency action leaves a trail of both what was done
and why it was done this way.

### Revoke grant

**Blast radius: one user, one API.**

Revokes any grant regardless of who owns the API. The access group is removed
from that user's gateway consumer; their next call to that API is a `403`.
Their credential still authenticates, and their access to every other API is
untouched.

_Use when_ a provider is unreachable and access must stop now.

### Delete API

**Blast radius: one API, every consumer of it. Irreversible.**

Removes the API and its gateway proxy and plugins whoever owns it. Every call
starts failing immediately, the access group is stripped from every grantee, and
all grants, requests and spec revisions are deleted. Grantees are notified.

**Revoke grants** (optional) additionally records each revocation as an
individual `access.revoke` entry before the deletion. Deletion removes the
grants either way; this makes each one legible to a later audit review. Turn it
on if the deletion is part of an incident.

_Use when_ an API is leaking data or violating policy and the owner cannot act.
For anything less urgent, ask the provider to **retire** it instead — retiring
stops new onboarding without breaking live integrations.

### Disable user

**Blast radius: one account, everywhere.**

Disables the account, **destroys every session it holds** (open tabs get a
`401` on the next request), and blocks sign-in.

**Revoke grants** (optional but usually correct) additionally strips every
access group from their gateway consumer. Without it, the person is locked out
of the _portal_ while their API keys keep working against the _gateway_ — the
gap that catches people out. For a security incident, turn it on.

Refused for the **last active super admin**, and for your own account.

_Use when_ an account is compromised or an employee has left.

### Broadcast

**Blast radius: everyone in the selected audience.**

Sends a platform message: a bell notification to every recipient, plus the
message dropped into each recipient's **platform inbox thread** — so it survives
being dismissed from the bell, and any administrator can follow up in the same
thread. Optionally enqueues an email as well.

Audience selection works exactly like mass email (all / filtered / explicit).
You are excluded from your own broadcast.

_Use for_ incident notices, maintenance windows and forced credential
rotations — anything people must not miss. For routine announcements, prefer
**mass email**: broadcast creates an inbox thread per recipient, which is a lot
of noise for a newsletter.

---

## Routine checks

**Daily-ish**

- `GET /api/health` is `ok` (or `degraded` with a known gateway issue).
- No unexpected `god.*` entries in the audit log.

**Weekly**

- Skim the audit log for `user.role_change` and `api.delete`.
- Check the email outbox for `failed` rows
  ([`../operations.md`](../operations.md#6-the-email-outbox)).
- Review pending access requests that no provider has touched — clients tend to
  message support rather than chase.

**On a schedule**

- Confirm at least **two** active super admins exist.
- Review admin accounts: is everyone who holds `admin` still supposed to?
- Verify backups restore — of the Nexus database **and** the Ferrum Edge state.
- Send an SMTP test; relay credentials expire quietly.

---

## Troubleshooting

**"I cannot promote someone to admin."** You are an `admin`, not a
`super_admin`. Only a super admin confers admin roles.

**"I cannot disable this account."** It is the last active super admin, it is
an administrator and you are only an admin, or it is your own account.

**"Nobody can sign in or register after I enabled CAPTCHA."** CAPTCHA fails
closed. The secret key is missing or wrong, or the vendor is unreachable. An
operator can clear the CAPTCHA settings server-side to restore access.

**"New users never get their verification email."** SMTP is unconfigured or
broken, so verification mail is sitting in the queue. Fix SMTP and send a test;
the backlog will drain. As a stopgap, disable **Require email verification**.

**"A user says they were disabled but their API key still works."** Expected —
disabling blocks the portal, not the gateway. Use god mode → Disable user with
**revoke grants**, or revoke their grants individually.

**"A provider is unresponsive and a client is blocked."** Any admin can approve,
deny or revoke on any API through the ordinary routes — you do not need god
mode for that, and the ordinary route leaves a cleaner trail.

**"Everything gateway-related is failing with a 502."** The Ferrum Edge Admin
API is unreachable or rejecting Nexus's credentials. Check
`GET /api/health/edge`; if it is down, this is an operator issue — see
[`../operations.md`](../operations.md#9-health-checks). The portal itself keeps
working; only publishing, approvals and credential operations are affected.
