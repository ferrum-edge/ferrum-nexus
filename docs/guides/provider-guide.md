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

Optional, and expressed as **requests per window**: a `limit` (1 – 1 000 000)
and a `window_seconds` (1 – 86 400). `1000` per `60` is 1000 requests a minute.
Both ceilings are the gateway's own, so a larger number is refused by the form
rather than by the gateway half-way through publishing.

The limit is **per consumer**, not per source IP — which is the point of a
portal quota. One noisy client cannot exhaust everyone else's budget. Clients
see rate-limit headers on their responses and a `429` when they exceed it.

⚠️ **The quota is enforced per gateway process.** If your operator runs more
than one Ferrum Edge data-plane replica, each one counts separately, so the
effective limit is your number multiplied by the replica count — unless they
have configured Redis-synced counters (`FERRUM_RATE_LIMIT_SYNC_MODE=redis`).
Ask them which it is before you rely on the number as a hard ceiling; and note
that changing that setting only affects rate limits saved afterwards, so an old
API may need its limit re-saved.

### CORS

Optional, and only relevant if a **browser** calls your API directly. Server-to-
server clients are unaffected by any of this.

List the origins allowed to call you, one per line — `https://app.example.com`,
scheme and host (and port, if it is not the default), no path. Up to 64 of them.
Tick **Allow credentials** if those pages need to send cookies or an
`Authorization` header cross-origin.

**Leaving the box empty is a real choice, not an omission.** No origins means no
`cors` plugin is attached at all, so the gateway adds no CORS headers and a
browser will refuse any cross-origin call to your API. That is the right setting
for an API only ever called from a server. Clearing the box on an API that had a
policy removes the plugin again.

Note that CORS is a browser rule, not an access control: it decides which web
pages may read your responses, and nothing else. What actually protects the data
is the authentication plugin and the ACL group.

**Your CORS origins also guard WebSocket.** Publishing an HTTP API on Ferrum
Edge publishes WebSocket on the same path — the gateway passes upgrades through
transparently — and the CORS plugin does not run on an upgrade. The portal
mirrors the exact origins you list onto the proxy's WebSocket origin check, so
a page on any other origin is refused the socket. List `*`, or leave the box
empty, and there is **no** origin check on upgrades: anyone's page can open a
socket, and only your authentication plugin stands between it and your backend.
If your backend speaks WebSocket to browsers, list your origins.

### Enforcement level

By default your OpenAPI document is **documentation**. It is stored, rendered in
the catalog and handed to clients, and the gateway does not consult it: a client
with a key and a grant can call `/nexus/billing/anything-at-all` and the request
reaches your backend exactly like a declared one would. That is the right
default — it never breaks an API whose document is incomplete — but it is
usually not what "I uploaded my OpenAPI spec" feels like it should mean.

The **OpenAPI enforcement** select, next to the spec editor, offers two levels.

**Documentation only (default).** The behaviour above. Nothing is enforced.

**Reject requests to paths and methods not in the spec.** The portal hands your
document to the gateway, which builds one rule per declared operation; anything
matching none of them is answered `400` with an `application/problem+json` body,
before your backend is ever contacted. Concretely, for a document declaring
`GET /invoices` and `GET /invoices/{id}` published at `/nexus/billing`:

| Request                              | Result                                   |
| ------------------------------------ | ---------------------------------------- |
| `GET /nexus/billing/invoices`        | forwarded                                |
| `GET /nexus/billing/invoices/42`     | forwarded — `{id}` matches one segment   |
| `GET /nexus/billing/invoices/42/pdf` | `400` — `{id}` never spans a `/`         |
| `POST /nexus/billing/invoices`       | `400` — the document declares only `get` |
| `HEAD /nexus/billing/invoices`       | `400` — see below                        |
| `GET /nexus/billing/internal-debug`  | `400` — not in the document              |

#### What it does not do

**Request and response bodies are not validated.** A `POST` to a declared path
reaches your backend whatever its body contains, even if your document declares
a `requestBody` schema that the body violates. Enforcing schemas means
materialising them out of the document — resolving `$ref`s, converting between
JSON Schema drafts, handling media types and encodings — which is the gateway's
own spec importer's job. A second implementation living in the portal would
inevitably differ from it and start rejecting traffic the gateway itself would
have accepted, so the portal generates only the part it can generate exactly.

**`HEAD` is a separate operation.** OpenAPI treats `head` as its own path-item
key, so a document declaring only `get` on a path does not declare `head` on it,
and a `HEAD` request is rejected. If your backend serves `HEAD`, declare it.
The same goes for `TRACE` and any other method your clients actually send.

**Trailing slashes are literal.** A declared `/invoices` does not also allow
`/invoices/`, and vice versa. Declare whichever spelling your clients use.

**Your `servers` entry is not part of the matched path.** The rules are built
against the path clients actually send — `/nexus/billing/invoices`, listen path
included — and the portal rewrites the document's server base to your listen
path before handing it over so they line up. Your own `servers[0]` keeps doing
its other job: naming the upstream the gateway forwards to.

#### CORS preflights

Nothing to do. A browser's `OPTIONS` preflight targets a path with no `options`
operation behind it, but the gateway's CORS plugin runs well before the
route check and answers the preflight itself, so it never reaches the rules.
You do not have to declare an `options` operation, and adding or removing your
CORS origins later does not disturb the enforced surface.

#### Turning it on and off

Both directions are available from the API's Settings tab, and the change is
complete when the request returns.

**Switching between the two levels briefly interrupts the API.** The gateway can
only attach the enforcement rules to a route it builds from your document, and
only detach them by rebuilding the route without it — so the portal recreates
the route in place. Your settings, your plugins, your credentials and your
clients' grants all come through unchanged, and the URL never moves, but for a
second or so the API answers `404`. Nothing else in the portal does this: spec
uploads, CORS changes and every other setting are applied in place while the API
keeps serving. Prefer a quiet moment for the switch, the way you would for a
deploy.

Every spec upload regenerates the rules — in place, without the interruption —
so the enforced surface always matches the revision currently shown in the
catalog: a path you delete from your document stops being reachable, and one you
add becomes reachable, in the same operation. Because of that, uploading a
document that declares **no** operations while enforcement is on is refused: the
portal will not record a level it is not enforcing, and rules that allow nothing
would reject every request. Switch back to documentation-only first if that is
genuinely what you want.

### Advanced

Three settings that go onto the gateway proxy itself rather than onto a plugin.
All of them are optional, and all of them are safe to change on a live API.

**Allowed HTTP methods.** Tick the methods your API actually serves and the
gateway answers `405` to everything else — before authentication, before the
access gate, before anything. Tick nothing and every method is accepted, which
is the default and means a `GET`-only catalog API still accepts `POST` at the
gateway once a client holds a key. The **Use the methods declared in the spec**
button fills the list in from your OpenAPI document. You do not need to tick
`OPTIONS` for CORS: the portal adds it to the gateway's copy of the list
whenever you have a CORS policy, because a preflight rejected with `405` would
never reach the CORS plugin.

**Backend timeouts.** Connect, read and write, in milliseconds, 100 – 300 000.
Leave them blank to keep the gateway defaults shown in the boxes (5000 / 30 000
/ 30 000). The read timeout is the one that matters most: without it a hung
upstream holds a gateway worker for the full default. The three travel together
— filling one in and leaving the others blank gives the blank ones their
default value.

**Circuit breaker.** When on, five consecutive failures (a 500, 502, 503 or 504,
or a connection error) stop the gateway forwarding to your backend for thirty
seconds; it then lets one probe through at a time until three succeed. Clients
see a fast failure instead of a slow one, and a struggling backend is not
hammered while it recovers. The thresholds are not adjustable from the portal —
that is an operator setting on the proxy.

### What publishing actually does

```
apis row ─── proxy          name `nexus-<slug>`, listening on /<namespace>/<slug>
              │             plus your Advanced settings: allowed methods,
              │             timeouts, circuit breaker, WebSocket origins
              │
              │ …then the proxy is told to run them
              ├─ plugin_config  your auth plugin
              ├─ plugin_config  access_control      — only when requestable
              ├─ plugin_config  rate_limiting       — only when a rate limit is set
              ├─ plugin_config  cors                — only when origins are listed
              └─ plugin_config  openapi_validator   — only at the `routes` enforcement level,
                                                      and built by the gateway from your document
```

The last step matters: on Ferrum Edge a plugin has to be both configured _and_
listed on the proxy before the gateway runs it, so publishing finishes by
attaching the whole set to the proxy in one write. Nothing you configure here is
live until that lands.

At the `routes` enforcement level the route itself is created _from_ your
document rather than alongside it — the gateway will only build the enforcement
rules for a route it owns. That is invisible day to day; the one place it shows
is [switching levels](#turning-it-on-and-off).

If any step fails, everything created is torn back down and nothing is saved on
either side. A failed publish leaves no debris.

---

## Plugins

**My APIs → the API → Plugins.** Everything on the Settings tab is part of what
your API _is_ — how callers authenticate, whether they need a grant, their
quota, browser CORS, spec enforcement. The Plugins tab is the layer on top:
gateway behaviour you can add or take away at any time without republishing.

Each card is off until you turn it on. Turning one on writes a plugin
configuration to the gateway and attaches it to your proxy in the same
operation, so it is live the moment the card saves. If the gateway refuses the
change nothing is saved on either side.

### What is on offer

| Plugin                   | What it does                                                                                                                                        | What your consumers see                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Security headers**     | Adds the browser hardening headers to every response and strips the ones that advertise your stack                                                  | Nothing changes in how the API is called                                                               |
| **Request size limit**   | Rejects an upload over your ceiling with `413`, before a byte reaches your backend                                                                  | `413 Payload Too Large` — document the ceiling next to any upload endpoint                             |
| **Response size limit**  | Refuses to relay a backend response over your ceiling, answering `502` instead                                                                      | `502 Bad Gateway` — paginate anything that can grow without bound                                      |
| **IP allow / deny list** | Restricts who may call the API by source address. A deny match always beats an allow match                                                          | Callers from an unlisted address are rejected before authentication                                    |
| **Bot filter**           | Blocks requests whose `User-Agent` matches a pattern you list                                                                                       | Legitimate SDKs should send a recognisable `User-Agent`; the allow list is checked first               |
| **Correlation ID**       | Gives every call a stable id, forwards it to your backend and echoes it back                                                                        | They may send their own id, or read the one the gateway minted, and quote it in a support ticket       |
| **Response compression** | Compresses responses when the caller asks for it                                                                                                    | A compressed body when they send `Accept-Encoding`; every mainstream client handles it                 |
| **Response caching**     | Serves a repeated read from the gateway instead of your backend. Each caller keeps its own partition, so one consumer never sees another's response | `X-Cache-Status` and `Age` headers; `Cache-Control: no-cache` bypasses the cache                       |
| **Idempotency keys**     | Makes a retried write safe: the first call with a given key runs, an identical retry replays the first response                                     | They send a unique key per operation and may safely retry; a reused key with a different body is `409` |
| **Maintenance / sunset** | Answers with a canned response instead of calling your backend                                                                                      | The status and message you choose — `503` for a maintenance window, `410` for a retired endpoint       |

The **bot filter is a coarse filter, not bot defence**: the `User-Agent` is
client-controlled and trivially spoofed. It keeps casual scrapers off a public
catalog API; it will not stop anyone who is trying.

**Security headers: HSTS is the one to think about.** Turning it on tells
browsers to use HTTPS for your whole domain, including every subdomain, for a
year. Only switch it on when that is true.

### Restricting a plugin to some requests

Some cards offer **Only run on some requests** — a method list, a path prefix,
or both. That is how you retire one endpoint without touching the rest: turn on
Maintenance / sunset, choose `410`, and set the path prefix to the endpoint's
path.

The prefix is matched against the whole request path as the client sends it, so
it starts with your gateway path (`/nexus/your-slug/…`); the placeholder in the
box shows the right shape. It has to be a plain path — no `%` escapes, no
backslashes, no `.` or `..` segments — because the gateway compares a
canonicalised path that never contains any of those, so such a prefix could
only ever silently fail to match.

**Not every plugin can be restricted.** The cards without the option are ones
the gateway applies to a whole proxy or not at all: security headers, the two
size limits, compression, correlation IDs and response caching. Their effect is
decided once for the proxy rather than per request, so a per-request condition
could only be half applied — the gateway rejects it rather than pretend.

### Pausing versus removing

A configured card has an **Active** checkbox and a **Remove** button, and they
are different things:

- **Unchecking Active** leaves the configuration on the gateway with your
  settings intact, but the gateway stops running it. Tick it again and you are
  back where you were.
- **Remove** detaches and deletes the configuration. The settings are gone.

Pause is the right one for a temporary change; remove is for a decision.

### What is not offered, and why

**Other authentication methods** — HMAC signatures, JWKS from your own identity
provider, OAuth 2.0 token introspection, mutual TLS. These are not extra
plugins on top of your authentication choice; they _replace_ it, and each needs
its own kind of credential for the portal to issue, rotate and show once. They
belong with the authentication setting on the Settings tab, and they are not
built yet.

**Serving your spec from the gateway** (`spec_expose`) — your document is
already served by the portal's catalog, and publishing it at a second address
on the gateway is a routing decision rather than a plugin toggle.

**Everything operators use to run the gateway** — log shipping, tracing,
metrics, alerting, mesh, fault injection, load testing. Those are how the
platform is run, not how your API behaves for the people calling it. Ask your
administrator if you need something from that list.

---

## Usage and backend health

**My APIs → the API → Overview → Usage.** The card is a live read of what the
gateway itself reports for your proxy — refreshed every 30 seconds, cached for
10 — not a Nexus database of its own.

It shows:

| Row             | What it is                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Backend**     | Healthy, Failing, Recovering or Unknown, with a sentence saying why                                                        |
| **Requests**    | Every call the gateway has counted for this API                                                                            |
| **By status**   | The same total split into 2xx / 3xx / 4xx / 5xx                                                                            |
| **Turned away** | The three refusals worth watching separately: `429` (your rate limit), `401` (bad or missing credential), `403` (no grant) |
| **Latency**     | p95, with p50 and p99 beside it, in milliseconds                                                                           |

### Read the window before you read the numbers

Every count is **cumulative since the gateway process started**. It is not "this
week" and not "since you published" — a gateway restart puts every number back
to zero. The line under the card says when the sample was taken.

That is a deliberate limit, not an oversight. Ferrum Edge exposes no per-proxy
time window, and Nexus keeps no history, so any "requests this month" here would
be invented. If you need rates, trends or retention, point Prometheus and
Grafana at the gateway — your administrator has the details in the operations
guide.

### What it cannot tell you

- **Who is calling.** The gateway's request counter carries no consumer label,
  so there is no per-client breakdown and no unique-consumer count. **Grants**
  tells you who _may_ call; nothing tells you who did.
- **Which endpoints are hot.** Counts are per API, not per path.
- **Anything about a call that never reached the gateway.** A client with a DNS
  problem or a blocked egress rule shows up nowhere here.

### Making sense of "Unknown"

Unknown means the gateway reported nothing about your backend, and the card says
which of the two reasons applies:

- **No traffic yet** — nothing has called this API since the gateway started.
- **No circuit breaker is configured** — Edge tracks backend state through a
  circuit breaker, and this proxy has none, so there is nothing to report even
  though calls are flowing.

Unknown is never a claim that your backend is down. **Failing** is: it means the
circuit breaker has opened, or health checking has pulled a target out of
rotation, and the `since` line says when that started. **Recovering** means the
breaker is half-open and letting probe traffic through to find out whether the
backend is back.

If the whole card says gateway metrics are unavailable, Nexus could not read the
gateway — the API itself may well be serving traffic normally.

---

## Updating an API

**My APIs → the API → Settings.** Everything here is safe to change on a live
API, but two of them have consequences worth reading first.

| Change                     | Effect                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Name, description, version | Catalog metadata only.                                                                                                     |
| Visibility                 | Listing only. Existing grants and calls are unaffected.                                                                    |
| Upstream URL               | Re-points the gateway's backend. Takes effect immediately, and the upstream shown on the API page updates with it.         |
| Rate limit                 | Attaches, updates, or (cleared) removes the quota.                                                                         |
| CORS                       | Attaches, replaces, or (cleared) removes the browser CORS policy — and with it the WebSocket origin check.                 |
| Allowed methods            | Takes effect immediately. Untick everything to accept every method again.                                                  |
| Timeouts, circuit breaker  | Take effect immediately. Clearing the timeout boxes restores the gateway defaults.                                         |
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

### If enforcement is on

At the `routes` [enforcement level](#enforcement-level) an upload also changes
**what the gateway will accept**: a path you remove from the document stops
being reachable the moment the revision lands, and one you add becomes
reachable. Uploading is therefore a traffic change as well as a documentation
change — check the diff of your `paths` before you publish, not only your
prose. If the upload cannot be saved, the previous rules are put back, so a
failed upload never leaves the gateway enforcing a revision the catalog does not
show.

An upload is applied in place: your API keeps serving throughout, and its
authentication is never off for an instant. The interruption described under
[Turning it on and off](#turning-it-on-and-off) applies only to _changing the
level_, not to uploading a new revision at a level you are already on.

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
Check the **Backend** row on the Overview tab first: _Failing_ confirms the
gateway agrees with them and says since when. _Unknown_ does not clear your
backend — it usually just means this proxy has no circuit breaker — so check
that the backend is healthy and reachable **from the gateway**.

**"My rate limit is not being applied."** It attaches per consumer. Confirm the
limit is saved in Settings, and remember a test consumer counts as its own
consumer with its own budget.
