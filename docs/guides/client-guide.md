# Client guide

For developers who want to **use** an API published in the portal.

Your job is a short loop: find the API, ask for access, wait for the provider's
decision, issue a credential, call the API. This guide walks each step and
explains the couple of places where the portal behaves in a way that is not
obvious.

Related: [`provider-guide.md`](provider-guide.md) ·
[`../getting-started.md`](../getting-started.md) · [`../api.md`](../api.md)

---

## The one-minute version

1. **Register**, and verify your email if the portal asks.
2. **Browse the catalog** and read the API's documentation.
3. **Request access** with a justification. Wait for the provider.
4. **Issue a credential** of the type that API uses. **Save the secret — it is
   shown once.**
5. **Call the API** through the gateway at `/<namespace>/<slug>`.

Two ideas do all the work, and keeping them apart will save you a support
ticket: a **credential** proves who you are, and a **grant** decides what you
may reach. A missing credential is a `401`. A missing grant is a `403`.

---

## Registering and signing in

Open the portal and choose **Register**. You need an email address, a display
name and a password of **at least 12 characters**; company and phone are
optional and only help providers recognise you when they review your request.

Pick the role **Client**. (Choose _Provider_ only if you also intend to publish
APIs — a provider can do everything a client can.)

Depending on how your portal is configured you may hit one of these:

- **Registration is closed.** Self-service sign-up is off; ask an admin to
  create your account.
- **A CAPTCHA challenge.** Complete it as part of the form.
- **Email verification required.** You will not be able to sign in until you
  click the link in the verification email. It is single-use and expires after
  **24 hours**. If it has expired or never arrived, use **Resend the
  verification email** — it is on the confirmation screen after you register,
  and on the sign-in page whenever a sign-in is refused for an unverified
  address. A new link replaces the old one, so use the most recent email. The
  portal will only send one every 10 minutes; if a second click seems to do
  nothing, check your spam folder before trying again.

If verification is _not_ required, registering signs you straight in.

### If you forget your password

Choose **Forgot password?** under the password box on the sign-in page, enter
the address you registered with, and follow the link in the email. The link is
single-use and expires after **one hour**.

Two things to expect:

- The confirmation says "if an account exists for that address" and says it for
  every address. That is deliberate: the portal will not tell an anonymous
  visitor which addresses are registered. It is not a sign that anything went
  wrong.
- **Setting a new password signs you out everywhere** — every browser, tab and
  device. Sign in again with the new password. Your API credentials are
  unaffected: keys, Basic auth users and JWT secrets keep working, because they
  authenticate to the gateway rather than to the portal.

If the link has expired, just request another. Only one reset link per account
is live at a time, and requesting a second inside 10 minutes sends nothing —
so if no email arrives, wait rather than clicking repeatedly. If you never
receive one, the address may not be registered, or the account may have been
disabled; ask an administrator.

### Your profile

**Profile** lets you change your display name, company and phone, and set a new
password (you will need your current one). You cannot change your own email,
role or account status from here — ask an admin.

---

## Browsing the catalog

**API catalog** lists every API you are allowed to see. Each card shows the
name, version, owner and a badge for your relationship to it:

| Badge       | Meaning                                  |
| ----------- | ---------------------------------------- |
| **None**    | You have never asked for access.         |
| **Pending** | Your request is waiting on the provider. |
| **Granted** | You have active access.                  |
| **Denied**  | The provider declined your last request. |
| **Revoked** | Access you had was withdrawn.            |
| **Owner**   | You published this one.                  |

Filter by search text, by "accepts access requests", and by visibility.

### Reading the documentation

Open an API to get its rendered OpenAPI documentation — paths, operations,
parameters, request and response schemas — plus the raw document if you would
rather feed it to your own tooling. **You do not need access to read the
docs.** That is deliberate: you should be able to tell whether an API is worth
requesting before you ask.

### "I was sent a link but I cannot find it in the catalog"

That is an **internal** API. Internal means _unlisted_, not private: it does not
appear in general browsing, but anyone with the link can open it, read the
documentation and request access through the normal flow. Follow the link the
provider gave you.

### "The API I was using has disappeared"

It was probably **retired**. Retirement stops an API circulating to new users;
it does not break anything already running. If you hold an active grant it
stays visible to you and your integration keeps working. If you do not, the
provider has stopped onboarding — message them.

---

## Requesting access

An API accepts requests only if the provider marked it **requestable**. If the
Request access button is missing, the API is either not requestable, retired, or
you already have access or a pending request.

Click **Request access** and write a justification (up to 2000 characters).
Treat it as the case you are making to a human, because it is one. Say:

- what your integration does;
- which endpoints you need;
- roughly what call volume to expect;
- who to contact on your side.

"Need access" gets declined. "Nightly reconciliation of partner invoices —
`GET /invoices` and `GET /invoices/{id}`, about 200 calls a night, owner is the
Payments team" gets approved.

The provider is notified immediately. You will get an in-app notification and
an email when they decide.

### Tracking a request

The **Dashboard** shows your open requests and active grants; the catalog badge
reflects the current state. You can **cancel** your own request while it is
still pending — useful if you asked for the wrong API. Once decided, it can no
longer be cancelled.

### If you are declined

The provider can attach a note explaining why; it appears with the decision and
in the email. Fix whatever they raised and request again — a declined request
does not block a new one. If the note is unclear, **message the provider**
(below); that is faster than re-requesting blind.

---

## Credentials

**Credentials** is where you mint the secrets your code actually sends. They
belong to your account, not to an individual API: one credential works for
**every** API you are approved for that uses the matching authentication type.

### Choosing a type

Match the API's authentication method — the catalog page for each API says
which one it uses:

| API uses   | Issue this credential | What you send                                                   |
| ---------- | --------------------- | --------------------------------------------------------------- |
| API Key    | **keyauth**           | `X-API-Key: <key>`                                              |
| HTTP Basic | **basicauth**         | Basic auth, username `nexus-user-<your id>`, password as issued |
| JWT        | **jwt**               | `Authorization: Bearer <token you sign>`                        |

If you are approved for two APIs that use different methods, issue one
credential of each type.

### Issuing one

**Credentials → Issue credential**, pick the type, give it a label you will
recognise later (`nightly-job`, `staging`, `laptop`), and confirm.

> ### The secret is shown exactly once
>
> Copy it into your secret store **before you close the dialog.** The portal
> stores only a fingerprint and the last four characters; the gateway redacts
> credential material on every read. Nobody can recover it — not an
> administrator, not the database. If you lose it, **rotate**.

After the dialog closes, the credentials list shows the label, type, `…last4`
and status — never the secret.

### What the dialog gives you, per type

- **keyauth** — a single key, e.g. `nxs_pQ7v3H2s…`.
- **basicauth** — a **username** and a password. The username is your
  _consumer_ username (`nexus-user-<your id>`), not your email. That is a
  gateway requirement, not a portal quirk: the basic-auth credential has no
  username field of its own, and the gateway looks you up by the consumer name.
- **jwt** — a **signing secret** and a **key** (again your consumer username).
  You mint your own tokens with these; see below.

### Rotating

**Rotate** replaces a credential without downtime. The new secret is created on
the gateway first, so both work during the hand-off — deploy the new one, then
the old one is retired.

The rotation dialog shows the new secret **once**, same rule as issuing.

One caveat: portals cap how many live credentials of one type you may hold
(commonly **2**). If you are already at the cap when you rotate, there is no
room to add before removing, so the old credential is deleted first and there
is a brief window where neither works. Avoid it by revoking anything unused
before you rotate, so you rotate from below the cap.

### Revoking

**Revoke** deletes the credential from the gateway immediately. Anything still
using it starts getting `401`. Revoke as soon as a secret has leaked, a laptop
is lost, or an integration is decommissioned.

Hitting `409 CONFLICT` on issue means you are at the per-type cap — revoke or
rotate an existing one first.

---

## Calling an API

Requests go to the **gateway's proxy listener**, not to the portal.

**The catalog tells you the address.** Open the API, and the **Call this API**
panel on the _Access_ tab shows the full **invoke URL** with a copy button,
along with the exact header to send. The same URL appears next to each of your
granted APIs on the **Credentials** page. Append the operation path from the
OpenAPI document to it:

```
<invoke URL>/<the path from the OpenAPI document>
```

The invoke URL is the gateway's public origin followed by the API's listen
path, which is always `/<namespace>/<slug>` — for a namespace of `nexus` and a
slug of `billing`, `https://gateway.example.com/nexus/billing`.

If the panel shows only the listen path and says the gateway address is not
published, your portal administrator has not configured one yet. Ask them for
the gateway host rather than guessing a port — the portal deliberately shows
nothing rather than an address that might not route.

### API key (`keyauth`)

```bash
curl -sS https://gateway.example.com/nexus/billing/invoices \
  -H "X-API-Key: nxs_pQ7v3H2s…"
```

### HTTP Basic (`basicauth`)

The username is your **consumer username**, `nexus-user-<your id>` — exactly
the value the issue dialog showed you.

```bash
curl -sS https://gateway.example.com/nexus/billing/invoices \
  -u "nexus-user-7c1d…:<the password you saved>"
```

### JWT (`jwt`)

You sign your own short-lived HS256 tokens with the secret you were issued. The
**`sub` claim must be your consumer username** (the `jwt_key` value from the
dialog) — that is how the gateway identifies you.

```js
// npm i jose
import { SignJWT } from 'jose';

const token = await new SignJWT({})
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject('nexus-user-7c1d…') // jwt_key from the issue dialog
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(new TextEncoder().encode(process.env.NEXUS_JWT_SECRET));
```

```bash
curl -sS https://gateway.example.com/nexus/billing/invoices \
  -H "Authorization: Bearer $TOKEN"
```

Keep the lifetime short and mint per request or per batch. Never ship the
signing secret to a browser or a mobile app — anyone holding it can mint tokens
as you.

### Reading the failure

| Status        | Meaning                                         | Do this                                                                                                    |
| ------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **401**       | The gateway did not recognise your credential.  | Wrong or missing header; wrong credential _type_ for this API; the credential was revoked or rotated away. |
| **403**       | Authenticated, but not authorised for this API. | Your grant was revoked, or was never approved. Check the catalog badge.                                    |
| **404**       | Wrong path.                                     | Check the namespace and slug, and that the path exists in the document.                                    |
| **429**       | Rate limit.                                     | The provider set a per-consumer quota. Back off; check the rate-limit response headers.                    |
| **502 / 503** | The API's own backend is unhealthy.             | Not your credential. Message the provider.                                                                 |

A useful diagnostic: **401 is about the credential, 403 is about the grant.**
If you can call one approved API but not another, the credential is fine and
the second grant is the problem.

---

## Messaging a provider

**Messages** is a portal inbox — a conversation with a provider, optionally
about a specific API, kept alongside the access request it relates to.

Start one from an API's catalog page (**Message the provider**) or from
Messages. Give it a subject and a body; the provider is notified in-app and by
email, and their reply comes back the same way.

Asking the same provider about the same API twice continues the existing
thread rather than starting a new one, so the whole history stays in one place.

Leaving the recipient empty addresses the **platform administrators** instead —
use that for account problems, a provider who is not responding, or anything
that is not about one specific API. Any admin can pick it up.

---

## Notifications

The bell in the header. You are notified when:

- your access request is **approved**, **denied** or **revoked**;
- someone **messages** you;
- one of your **credentials is rotated**;
- an API you have access to **changes its authentication method** or is
  **removed**;
- an administrator sends a **platform announcement**.

Click one to jump to the relevant page; **Mark all read** clears the badge.
Most of these arrive by email too, if the portal has SMTP configured.

Notifications are a convenience, not a record. If you need to know exactly what
happened and when, ask an administrator to check the audit log.

---

## Troubleshooting

**"I lost my API key."** It cannot be recovered by anyone. Rotate the
credential and update your integration with the new secret.

**"My integration broke overnight and I changed nothing."** In order of
likelihood: your grant was revoked (check the catalog badge — you would have
been notified); the provider changed the API's **authentication method**, which
invalidates credentials of the old type (issue one of the new type); the
provider retired or deleted the API.

**"I get 401 with a credential I just issued."** Check you are using the right
_type_ for that API, and the right header. For `basicauth`, the username is
`nexus-user-<id>`, not your email. For `jwt`, the `sub` claim must be that same
consumer username.

**"Request access is greyed out."** The API is not requestable, or it is
retired, or you already have an active grant or a pending request.

**"I cannot sign in."** Verify your email if the portal requires it; if you
have been repeatedly retrying, you may have tripped the sign-in rate limit
(20 attempts per minute) — wait a minute. If your account was disabled, an
administrator has to re-enable it.

**"No emails are arriving."** The portal may not have SMTP configured yet.
In-app notifications still work; mention it to an administrator.
