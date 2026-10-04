# Client guide

For developers who want to **call** an API published in the portal.

Related: [`provider-guide.md`](provider-guide.md) ·
[`../getting-started.md`](../getting-started.md) · [`../api.md`](../api.md)

---

## The one-minute version

1. **Register**, and verify your email if the portal asks.
2. **Find the API** in **API catalog** and read its documentation.
3. **Request access** on the API's **Access** tab. Wait for the provider.
4. **Issue a credential** of the type that API uses. **Save the secret: it is
   shown once.**
5. **Call the API** through the gateway at `<gateway>/<namespace>/<slug>`.

A **credential** proves who you are. A **grant** (an approved request) decides
what you may reach. A bad or missing credential is a `401`. A missing grant is a
`403`.

---

## Registering and signing in

On the sign-in page, choose **Register**. You need:

- a display name and an email address;
- a password of at least **12 characters**;
- optionally, a company and phone number. They help providers recognise you
  when they review your request.

Under **Account type**, pick **Client**. Pick **Provider** only if you also
want to publish APIs; a provider can do everything a client can. If the portal
allows only one type, the form tells you which one you get.

Depending on how the portal is configured, you may see:

- **"Not accepting self-service accounts".** Registration is closed. Ask an
  administrator to create your account.
- **A CAPTCHA.** Complete it as part of the form.
- **"Check your inbox for a verification link".** You cannot sign in until you
  click the link. It works once and expires after **24 hours**. If it expired
  or never arrived, use **Resend the verification email**. It appears on the
  confirmation screen, and on the sign-in page when a sign-in is refused for an
  unverified address. A new link replaces the old one. The portal sends at most
  one every 10 minutes, so check your spam folder before clicking again.

If verification is not required, your account is ready straight away.

### If you forget your password

1. On the sign-in page, choose **Forgot password?**.
2. Enter the address you registered with.
3. Follow the link in the email. It works once and expires after **one hour**.

What to expect:

- The confirmation always says "If an account exists for that address". The
  portal never tells a visitor which addresses are registered.
- **Setting a new password signs you out everywhere.** Your API credentials
  keep working, because they authenticate to the gateway, not the portal.
- Only one reset link is live at a time, and a second request within 10
  minutes sends nothing. If no email arrives, wait rather than clicking again.
  If it never arrives, the address may not be registered or the account may be
  disabled. Ask an administrator.

### Your profile

**Profile** lets you change your display name, company and phone, and set a
new password (you need your current one). Changing your password signs out your
other sessions. Only an administrator can change your role or account status.

---

## Browsing the catalog

**API catalog** lists every API you are allowed to see. Search by name, slug
or description. Each card shows the API's version, authentication method,
owner, and a badge for your relationship to it:

| Badge            | Meaning                                             |
| ---------------- | --------------------------------------------------- |
| **No access**    | The API needs approval and you have not asked yet.  |
| **Open access**  | No approval needed. Any portal account may call it. |
| **Pending**      | Your request is waiting on the provider.            |
| **Granted**      | You have active access.                             |
| **Denied**       | The provider declined your last request.            |
| **Revoked**      | Access you had was withdrawn.                       |
| **You own this** | You published this API.                             |

Cards also carry **Requestable** or **Open**, and **Unlisted**, **Private** or
**Retired** where they apply.

### Reading the documentation

Open an API and choose the **Documentation** tab for the rendered OpenAPI
document: operations, parameters, and request and response schemas. **You do
not need access to read the docs**, so you can judge an API before you ask for
it. For your own tooling, `GET /api/catalog/<slug>/spec` returns the document
as uploaded (`raw_spec`).

Large documents show 200 operation entries at first; **Show 200 more** adds
the next batch. An operation listed under several tags counts once per tag.

### Seeing what changed

The **Changes** tab lists each revision the provider published after the first,
newest first, with what it changed: operations added, removed or deprecated,
parameters, request bodies, responses and the fields of their schemas. Each
change is marked **Breaking** when a client written against the previous
revision may fail against the new one, for example a removed operation, a new
required parameter or a response field that is no longer sent. A rollback is
labelled as one.

It is a structural comparison of the two documents. It cannot see how the API
behaves, so a change it does not list can still affect you. The history is
readable by everyone who can read the documentation.

If you have access to an API, you are told when a new revision changes it: a
notice in the bell that links to the **Changes** tab. You get one until you
read it, however many revisions the provider publishes; until then it is kept
up to date with the latest. Under **Profile → Notifications** you can turn the
notice off, or turn on an email as well, sent at most once per API per clock
hour.

### "I was sent a link but cannot find the API in the catalog"

It is an **internal** (unlisted) API. It does not appear in browsing, but
anyone with the link can open it, read the docs and request access. Use the
link the provider gave you.

### "The API I was using has disappeared"

It was probably **retired**. A retired API takes no new requests, but it keeps
working for everyone already approved, and stays visible to them. If you had no
grant, the provider has stopped onboarding. Message them.

---

## Requesting access

1. Open the API and choose the **Access** tab.
2. Under **Requesting for**, choose who the access is for: **My account**, or
   one of your [applications](#applications).
3. Fill in **Why do you need access?** (up to 2000 characters).
4. Choose **Request access**.

Write the justification for a human reviewer. Say what your integration does,
which endpoints you need, roughly how many calls to expect, and who to contact.
"Need access" gets declined. "Nightly reconciliation of partner invoices:
`GET /invoices` and `GET /invoices/{id}`, about 200 calls a night, owner is the
Payments team" gets approved.

The provider is notified straight away. You get an in-app notification, and an
email, when they decide.

Access is tracked **per identity**. The Access tab shows the state of the
identity you picked. A grant or pending request for one application does not
stop you requesting the same API for another identity.

If there is no request form, the API does not need approval (the tab says so),
it is retired, or the selected identity already has a grant or a pending
request.

### Tracking and withdrawing a request

The **Dashboard** lists your access requests and credentials. While a request
is pending, **Withdraw request** on the Access tab cancels it. Once the provider
has decided, it can no longer be withdrawn.

### If you are declined

The provider's note appears under **Last decision** on the Access tab and in
the email. Fix what they raised and request again; a declined request does not
block a new one. If the note is unclear, [message the
provider](#messaging-a-provider).

---

## Applications

By default everything belongs to **your account**: you request access as
yourself, and a credential issued to your account works for every API your
account is approved for. That is enough while you have one integration.

An **application** is a separate identity you own. Each application is approved
for its own APIs and has its own credentials. A credential issued to your
billing worker can call only what the billing worker was approved for. The
gateway enforces this.

To create one: **Applications → New application**, give it a name, then choose
it under **Requesting for** and under **Identity** when you issue a credential.

- **A label is not an identity.** Naming a credential "production" changes
  nothing about what it can call. Only the **Identity** field does.
- **Disable** stops an application getting new access or new credentials. Its
  existing credentials keep working.
- **Delete** removes its gateway identity. Its credentials stop working at once
  and its approvals are given up. You must type the application's name to
  confirm, and it cannot be undone.

Your account's own access is never affected by your applications.

---

## Credentials

**Credentials** is where you create the secrets your code sends. Each
credential belongs to **one identity** (your account or one application) and
works for every API that identity is approved for that uses the matching
authentication method. The **Your API access** card on the same page lists your
granted APIs with the address to call.

### Choosing a type

Match the API's authentication method, shown on its catalog page:

| API uses   | Credential type              | What you send                                                                              |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| API Key    | **API Key** (`keyauth`)      | `X-API-Key: <key>`                                                                         |
| HTTP Basic | **HTTP Basic** (`basicauth`) | Basic auth: the consumer username (`nexus-user-<id>` or `nexus-app-<id>`) and the password |
| JWT        | **JWT** (`jwt`)              | `Authorization: Bearer <token you sign>`                                                   |

If you use APIs with different methods, issue one credential of each type. The
method is the provider's choice. It also decides whether the provider's server
sees your credential: read [Your token reaches the provider's
backend](#jwt-jwt) before you use JWT.

### Issuing one

1. **Credentials → Issue credential**.
2. **Identity**: your account, or one of your applications. This decides which
   APIs the credential can call.
3. **Credential type**: as in the table above.
4. **Label** (optional): a note to yourself, such as `nightly-job`.
5. Choose **Issue**.

> **The secret is shown exactly once.**
> Copy it into your secret store before you close the dialog. The portal keeps
> only a fingerprint and the last four characters. Nobody can recover it, not
> even an administrator. If you lose it, rotate.

The dialog shows, per type:

- **API Key**: the key, for example `nxs_pQ7v3H2s…`.
- **HTTP Basic**: a username and a password. The username is the identity's
  **consumer username** (`nexus-user-<your id>` or
  `nexus-app-<application id>`), not your email. The gateway looks you up by
  that name.
- **JWT**: a **JWT signing secret** and the **JWT subject (sub)**, which is the
  consumer username. You sign your own tokens with these.

### Rotating

**Rotate** replaces a credential in one step. The new secret is created and
the old one is revoked in the same operation. There is no overlap: callers
still using the old secret get `401` as soon as the gateway applies the change.
The new secret is shown once, and only to you: nobody else can rotate your
credentials, not even an administrator.

For a cutover with no downtime, **issue** a new credential, deploy it, then
**revoke** the old one.

### Revoking

**Revoke** deletes the credential from the gateway. Anything still using it gets
`401`. Revoke as soon as a secret leaks, a laptop is lost, or an integration is
retired.

An administrator can also revoke your credential, for example during an
incident. If that happens, issue a new one yourself.

### The per-type limit

Each identity may hold a limited number of live credentials of each type
(**2** by default; the operator sets `FERRUM_MAX_CREDENTIALS_PER_TYPE`). Issuing
past the limit returns `409 CONFLICT`. Revoke or rotate one first.

---

## Calling an API

Requests go to the **gateway**, not to the portal.

**The Access tab tells you where.** Once the selected identity can call the API,
the **Call this API** panel shows the **Invoke URL**, the header to send, the
consumer name, and a copyable `curl` example for that identity. Use a
credential issued to the same identity. Append the operation path from the
OpenAPI document:

```
<invoke URL>/<path from the OpenAPI document>
```

The invoke URL is the gateway's public address plus `/<namespace>/<slug>`. For
namespace `nexus` and slug `billing`:
`https://gateway.example.com/nexus/billing`.

If the panel shows only a **Gateway path** and says no gateway address is
configured, ask an administrator for the gateway address. Do not guess a port.

### API key

```bash
curl -sS https://gateway.example.com/nexus/billing/invoices \
  -H "X-API-Key: nxs_pQ7v3H2s…"
```

### HTTP Basic

The username is the consumer username the issue dialog showed you. `-u` builds
the `Authorization: Basic` header. Quote the pair so the shell leaves the
password alone.

```bash
curl -sS https://gateway.example.com/nexus/billing/invoices \
  -u "nexus-user-7c1d…:<the password you saved>"
```

### JWT (`jwt`)

Sign short-lived HS256 tokens with the signing secret. The **`sub` claim must
be the consumer username**, and the token must carry an `exp`.

```js
// npm i jose
import { SignJWT } from 'jose';

const token = await new SignJWT({})
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject('nexus-user-7c1d…') // "JWT subject (sub)" from the issue dialog
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(new TextEncoder().encode(process.env.NEXUS_JWT_SECRET));
```

```bash
curl -sS https://gateway.example.com/nexus/billing/invoices \
  -H "Authorization: Bearer $TOKEN"
```

Keep lifetimes short. Never ship the signing secret to a browser or mobile app:
anyone holding it can mint tokens as you.

> **Your token reaches the provider's backend.**
> The gateway strips an API key or Basic password before forwarding a request.
> It does **not** strip `Authorization: Bearer`, so the provider's server sees
> every token you send. It can replay a token until it expires (the gateway does
> not cap `exp`), but it never sees your signing secret. Keep tokens short-lived
> and put nothing in a claim you would not show the provider.

### Reading the failure

| Status        | Meaning                                     | What to check                                                                               |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **401**       | The gateway did not accept your credential. | Header missing or wrong; wrong credential type for this API; credential revoked or rotated. |
| **403**       | Authenticated, but not approved.            | Grant revoked or never approved, or the credential belongs to a different identity.         |
| **404**       | Wrong path.                                 | Namespace, slug, and that the path exists in the document.                                  |
| **429**       | Rate limit.                                 | Back off; see below.                                                                        |
| **502 / 503** | The API's backend is unhealthy.             | Not your credential. Message the provider.                                                  |

If you can call one approved API but not another, the credential is fine and the
second grant is the problem.

### Staying under a rate limit

The portal does not show your remaining quota; the gateway counts it. When a
provider sets a quota, responses carry:

| Header                  | Meaning                      |
| ----------------------- | ---------------------------- |
| `x-ratelimit-limit`     | Requests allowed per window  |
| `x-ratelimit-remaining` | Requests left in this window |
| `x-ratelimit-window`    | Window length, in seconds    |

Slow down as `x-ratelimit-remaining` nears zero rather than waiting for a `429`.
There is no reset timestamp: after a `429`, wait at least
`x-ratelimit-window` seconds. Requests rejected before the rate-limit check
carry no headers, and an API with no quota never sends them.

---

## Messaging a provider

**Messages** is the portal inbox.

- To reach a provider, open their API and choose **Message provider**. Asking
  the same provider about the same API again continues the existing thread.
- To reach the portal administrators (account problems, an unresponsive
  provider), choose **Messages → New message**. Any administrator can reply.

The other side is notified in-app and by email, and replies come back the same
way. Each account can send a limited number of messages per day (200 by
default).

---

## Notifications

The bell in the header shows your ten latest notifications. **View all** opens
the full list, where you can page back and show **Unread only**. Click a
notification to mark it read and open the related page. **Mark all read** clears
the badge.

You are notified when:

- your access request is **approved** or **denied**, or your access is
  **revoked**;
- someone **messages** you;
- one of your **credentials is rotated**;
- an API you use **changes its authentication method** (your old credential
  stops working on that API only) or is **removed**;
- a provider lets you **view a private API**, or an administrator **changes your
  role**;
- an administrator sends a **platform announcement**.

Most of these also arrive by email if the portal has email configured.

---

## Limits

| Limit                                     | Default         | Set by the operator with                     |
| ----------------------------------------- | --------------- | -------------------------------------------- |
| Live credentials per type, per identity   | 2               | `FERRUM_MAX_CREDENTIALS_PER_TYPE`            |
| Applications per account                  | 20              | `NEXUS_MAX_APPLICATIONS_PER_OWNER`           |
| Access requests per account, rolling 24 h | 20              | `NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY` |
| Messages per account, rolling 24 h        | 200             | `NEXUS_MAX_MESSAGES_PER_USER_PER_DAY`        |
| Justification length                      | 2000 characters | —                                            |

---

## Troubleshooting

**"I lost my API key."** Nobody can recover it. Rotate the credential and deploy
the new secret.

**"My integration broke overnight and I changed nothing."** In order of
likelihood:

- your grant was revoked (check the catalog badge; you were notified);
- the provider changed the API's authentication method. Your credential still
  works on your other APIs; issue one of the new type for this one;
- the API was deleted.

**"I get 401 with a credential I just issued."** Check the credential type
matches the API, and the header. For HTTP Basic the username is the consumer
username, not your email. For JWT, `sub` must be that same consumer username and
the token needs an `exp`.

**"I get 403 but my account is approved."** The grant belongs to one identity.
A credential issued to a different identity (your account versus an
application) cannot use it.

**"There is no Request access form."** The API needs no approval, is retired,
or the selected identity already has a grant or a pending request. The
**Request access** button stays disabled until you write a justification.

**"I cannot sign in."** Verify your email if the portal requires it. After many
attempts you may hit the sign-in rate limit (20 per minute); wait a minute. A
disabled account can only be re-enabled by an administrator.

**"No emails are arriving."** The portal may not have email configured yet.
In-app notifications still work; tell an administrator.
