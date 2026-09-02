# Provider guide

For teams who **publish** APIs in the portal.

Publishing is the moment a document becomes running gateway configuration:
uploading an OpenAPI spec creates a proxy on Ferrum Edge, attaches an
authentication plugin, and — if you make the API requestable — an access-control
gate that only approved consumers pass. Everything after that is deciding who
gets through it.

Related: [`client-guide.md`](client-guide.md) ·
[`../getting-started.md`](../getting-started.md) · [`../api.md`](../api.md)

---

## Before you start

You need:

- a **provider** account (or higher);
- an **OpenAPI 3.x** document, JSON or YAML;
- an upstream the gateway can reach — a hostname resolvable from the _gateway_,
  not from your laptop.

A provider can do everything a client can, so you can also request access to
other people's APIs from the same account.

---

## Publishing an API

**My APIs → Publish an API.**

### What the document must contain

Nexus is a portal, not a spec linter. It checks only what publishing actually
depends on:

- it parses as JSON or YAML and is an object;
- `openapi` is a **3.x** version string — **Swagger 2.0 is rejected**
  (`swagger: "2.0"`), because the fields Nexus reads do not exist there;
- `info.title` is present — it becomes the catalog's display title;
- `info.version` is present — it becomes the default revision label;
- `paths` is an object.

Everything else — schema correctness, `$ref` resolution, operation shape — is
left alone. Maximum document size is **2 MiB**.

A minimal document that publishes cleanly:

```yaml
openapi: 3.1.0
info:
  title: Billing API
  version: 2.4.0
  description: Invoices and payments for partner integrations.
servers:
  - url: https://billing.internal:8443/v2
paths:
  /invoices:
    get:
      summary: List invoices
      responses:
        '200': { description: OK }
```

### The upstream

The gateway needs to know where to forward. Two sources, in order:

1. **`upstream_url`**, if you supply one explicitly;
2. otherwise the document's first **absolute** `servers[].url`.

Relative server URLs (`/v2`, `./api`) are perfectly legal OpenAPI — they mean
"same origin as wherever this document is served from" — but there is no origin
to resolve them against here, so they yield no upstream and you must supply
one. If neither source produces an absolute `http(s)` URL, publishing fails
with a clear error naming `upstream_url`.

Scheme, host, port and base path are all taken from that URL. It must be
resolvable **from the gateway**: `localhost` on your laptop is not the
gateway's localhost.

### Name, slug and listen path

The **slug** determines where clients call you:

```
https://<gateway-host>/<namespace>/<slug>/...
```

Leave it blank and it is derived from the name (`Billing API v2` →
`billing-api-v2`), lowercase, hyphen-separated, max 60 characters. Slugs are
unique across the portal; a collision is a clear `409` so you can pick another.

**Choose it carefully — changing it later is not offered.** It is baked into
the gateway's listen path and into every client's configuration. If you truly
must change it, publish a new API and retire the old one.

### Authentication plugin

Pick how the gateway authenticates callers. This decides which credential type
your clients must issue:

| Choice                        | Clients issue | They send                                                            |
| ----------------------------- | ------------- | -------------------------------------------------------------------- |
| **API Key** (`key_auth`)      | `keyauth`     | `X-API-Key: <key>`                                                   |
| **HTTP Basic** (`basic_auth`) | `basicauth`   | Basic, username = the consumer's `nexus-user-<id>`                   |
| **JWT** (`jwt_auth`)          | `jwt`         | `Authorization: Bearer <HS256 token>`, `sub` = the consumer username |

API Key is the usual default: simplest for callers, and the gateway hides the
header from your upstream. Choose JWT when callers need short-lived
credentials they mint themselves.

> **HTTP Basic needs one piece of gateway configuration.** Publishing fails
> unless the operator has set `FERRUM_BASIC_AUTH_HMAC_SECRET` (at least 32
> bytes) on Ferrum Edge — it is the key the gateway hashes Basic passwords
> with, and it refuses to build the plugin without one. The publish error
> carries the gateway's own message in `details.gateway_message`; ask an
> operator to set it and try again.

### Requestable

**Requestable on** is the normal setting. It attaches an `access_control`
plugin to the proxy that allows **only** the API's approved group, and it puts
a Request access button on the catalog page. Nobody reaches your upstream
without an approval you made.

**Requestable off** removes that gate: the API is still authenticated, but
**every authenticated consumer in the portal can call it**. Use it for
genuinely open internal utilities and nothing else. Existing grants stay on
consumers and simply become inert.

### Visibility

| Visibility   | In the catalog      | Openable by link | Requestable |
| ------------ | ------------------- | ---------------- | ----------- |
| **Public**   | listed for everyone | yes              | yes         |
| **Internal** | **unlisted**        | **yes**          | yes         |

**Internal means unlisted, not secret.** Anyone with the link can open the page,
read the documentation and raise an access request. That is deliberate — there
is no provider-initiated grant flow, so a link that could not be acted on would
be useless. What protects your data is the access-control gate, not whether the
documentation is readable.

If a document itself is too sensitive to show a signed-in portal user, do not
publish it here.

### Rate limit

Optional, and expressed as **requests per window**: a `limit` (1 – 10 000 000)
and a `window_seconds` (1 – 86 400). `1000` per `60` is 1000 requests a minute.

The limit is **per consumer**, not per source IP — which is the point of a
portal quota. One noisy client cannot exhaust everyone else's budget. Clients
see rate-limit headers on their responses and a `429` when they exceed it.

### What publishing actually does

```
apis row ─┬─ proxy          name `nexus-<slug>`, listening on /<namespace>/<slug>
          ├─ plugin_config  your auth plugin
          ├─ plugin_config  access_control      — only when requestable
          └─ plugin_config  rate_limiting       — only when a rate limit is set
```

If any step fails, everything created is torn back down and nothing is saved on
either side. A failed publish leaves no debris.

---

## Updating an API

**My APIs → the API → Settings.** Everything here is safe to change on a live
API, but two of them have consequences worth reading first.

| Change                     | Effect                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Name, description, version | Catalog metadata only.                                                                                                     |
| Visibility                 | Listing only. Existing grants and calls are unaffected.                                                                    |
| Upstream URL               | Re-points the gateway's backend. Takes effect immediately.                                                                 |
| Rate limit                 | Attaches, updates, or (cleared) removes the quota.                                                                         |
| **Requestable → off**      | ⚠️ Removes the access gate. **Every authenticated consumer can now call this API.** Existing grants stay but become inert. |
| **Authentication plugin**  | ⚠️ Breaks every existing client until they issue a new credential.                                                         |

### Changing the authentication plugin

Credentials are typed. Switching from API Key to JWT does not convert anyone's
key — it makes their key stop satisfying this API. Every grantee is notified
in-app that the method changed and that they need a matching credential, but
their integration is broken from the moment you save until they act.

If you have live consumers, coordinate it: tell them first, agree a window,
then switch. Their old credentials keep working for any _other_ API of the old
type, so nothing else breaks.

---

## Updating the spec safely

**My APIs → the API → Spec → Upload new revision.**

Each upload is a new revision and becomes the current one; older revisions are
retained. The version label defaults to the document's `info.version` — set it
explicitly if your catalog version differs.

### The upstream-following rule

Uploading a spec **can** move the gateway's backend, but only when the proxy is
still pointing exactly where the _previous_ revision said it should. As soon as
you set an explicit upstream, the document stops being authoritative for it and
later uploads leave the backend alone.

In practice:

- If you have never set an explicit upstream, changing `servers[0].url` and
  re-uploading **moves your traffic**. That is usually what you want, and
  occasionally a nasty surprise.
- If you set the upstream explicitly, spec uploads are documentation-only.

Set the upstream explicitly for anything production-facing. It makes "publish
new docs" and "move the backend" two separate, deliberate acts.

### A safe update routine

1. Upload to a staging portal first if you have one.
2. Publish additive changes (new endpoints, new optional fields) freely.
3. For breaking changes, prefer a **new API with a new slug** — say
   `billing-v3` — and retire the old one once clients have migrated. Clients get
   a migration window instead of an outage.
4. Bump the version label so the catalog shows what changed.

---

## Reviewing access

Requests for the APIs you own land in your inbox, with an in-app notification
and an email.

Each request shows the requester (name, email, company), the API, and their
justification. Judge whether the case they made matches the data behind the
API. If the justification is thin, **message them** rather than declining
blind — the conversation stays attached to the request.

### Approve

Approving adds the API's access group to that user's gateway consumer and
records an active grant. You can attach a note, which the requester sees and
receives by email.

Access is live immediately — as soon as they hold a credential of the right
type, their calls pass. There is no separate publish step.

If the gateway is unreachable when you approve, nothing is committed: the
request stays pending and you can simply approve again once it recovers. The
portal never claims access the gateway would not honour.

### Deny

Declining changes nothing on the gateway. **Attach a note.** A decline with a
reason usually produces a corrected request; a silent one produces a support
thread. The requester can request again after fixing whatever you raised.

### Revoke

**Grants → Revoke** removes the access group from that consumer. Effect is
immediate: their next call gets a `403`. Their credential still authenticates —
it just no longer authorises this API.

Add a reason. It is recorded, shown to the grantee and emailed to them.
Revoking also marks the originating request as revoked, so their history reads
"approved, then revoked" rather than staying approved.

### Who else can act on your API

Portal **admins** and **super admins** can approve, deny and revoke on any API,
and can edit or delete one. That is intentional — someone has to be able to cut
off access at 3 a.m. when the owner is unreachable. Every such action is
audited with the actor's identity, and emergency actions taken through god mode
additionally require a recorded reason.

---

## Test consumers

**My APIs → the API → Create test consumer** gives you a disposable identity
for your own API, so you can verify the whole path — routing, authentication,
access control, rate limiting — without borrowing a real client's credential.

It creates a consumer named `nexus-test-<api id>` carrying this API's access
group, plus one credential of the API's authentication type. The secret is
**shown once**, exactly like a client credential.

```bash
curl -sS https://gateway.example.com/nexus/billing/invoices \
  -H "X-API-Key: <the test key>"
```

Creating one again **replaces** the previous one — the old consumer is deleted
and a fresh credential issued. That is the only way to reset its show-once
state, and it is why a test consumer is not a substitute for a real credential:
treat it as throwaway. Create one, verify, and do not build anything permanent
on it.

Worth testing with it after every significant change: a `200` on a normal call,
a `401` with no credential, and — if you set a rate limit — a `429` under load.

---

## Messaging clients

**Messages** is a portal inbox. Clients can start a thread from your API's
catalog page; you can reply, and start threads yourself.

Use it for:

- clarifying a thin justification before you decide;
- warning grantees about a breaking change or a maintenance window;
- explaining a decline in more detail than the note allowed.

Threads about the same API with the same client continue rather than
fragmenting, so the history stays in one place. Both sides get in-app
notifications and email.

For an announcement to _every_ portal user rather than one client, ask an
administrator — that is what mass email and platform broadcast are for.

---

## Retiring versus deleting

These are very different operations and the difference matters.

### Retire — reversible, breaks nothing

**Settings → Status → Retired.**

- The gateway is **untouched**: the proxy, its plugins and every active grant
  keep working. Integrations already in production carry on.
- The API disappears from the catalog for everyone **except** its owner, its
  existing grantees and admins.
- New access requests are refused.

Retirement is how you say "stop onboarding onto this" without breaking the
people already on it. It is reversible — set the status back to Published.

**This is almost always what you want.**

### Delete — permanent, breaks everything

**Settings → Delete API.**

- The proxy and all its plugins are **removed from the gateway**. Every call
  starts failing immediately.
- The access group is stripped from every grantee's consumer.
- All grants, access requests and spec revisions are deleted.
- Grantees are notified that the API was removed.

There is no undo, and re-publishing under the same slug does not restore
anyone's access — every client has to request again.

Sensible sequence for decommissioning: **retire**, tell your grantees, leave it
retired for a migration window, then delete once nobody is calling it.

---

## Troubleshooting

**"Publishing failed with a spec error."** The message names the offending
field. Common causes: a Swagger 2.0 document (`swagger: "2.0"` — convert to
OpenAPI 3); a missing `info.title` or `info.version`; a missing `paths` object;
YAML that does not parse.

**"No upstream could be determined."** Your document has no absolute
`servers[].url` — only relative ones, or none. Supply `upstream_url` explicitly.

**"The slug is already in use."** Someone published under that slug. Pick
another; slugs are unique portal-wide.

**"Publishing failed with a gateway error."** Ferrum Edge rejected or could not
be reached. Nothing was saved — the operation rolled itself back cleanly, so
retry once the gateway is healthy. If it persists, an admin can find the
upstream error text in the server log; it is deliberately not shown in the
browser.

**"A client says they get 403."** They are authenticated but not authorised:
their grant was revoked or never approved. Check **Grants** for their account.

**"A client says they get 401."** Their credential is missing, revoked, or of
the wrong type for this API — most often after an authentication-plugin change.

**"A client says they get 502/503."** That is your upstream, not the portal.
Check that the backend is healthy and reachable **from the gateway**.

**"My rate limit is not being applied."** It attaches per consumer. Confirm the
limit is saved in Settings, and remember a test consumer counts as its own
consumer with its own budget.
