# Provider guide

For teams who **publish** APIs in the portal.

Publishing turns an OpenAPI document into live gateway configuration. The
portal creates a proxy on Ferrum Edge, attaches an authentication plugin and,
if the API needs approval, an access-control gate that only approved callers
pass. After that, your job is deciding who gets through.

Related: [`client-guide.md`](client-guide.md) ·
[`../getting-started.md`](../getting-started.md) · [`../api.md`](../api.md)

---

## Before you start

You need:

- a **Provider** account (or higher);
- an **OpenAPI 3.x** document, JSON or YAML;
- a backend the **gateway** can reach. `localhost` on your laptop is not the
  gateway's localhost.

A provider can do everything a client can, so you can also request access to
other people's APIs from the same account.

---

## Publishing an API

1. In the sidebar, open **Publishing → My APIs** and choose **Publish an API**.
2. Paste the document into the **OpenAPI document** editor, or use **Upload
   file**.
3. Fill in the settings beside it (described below): **Name**, **Slug**,
   **Authentication**, **Visibility**, **Require an approved access request**,
   **Upstream URL**, and the optional rate limit, CORS, enforcement and proxy
   settings.
4. Choose **Publish API**.

If any step fails, everything created is removed and nothing is saved.

### What the document must contain

The portal checks only what publishing depends on:

- it parses as JSON or YAML and is an object;
- `openapi` is a **3.x** version. **Swagger 2.0 is rejected**;
- `info.title` (the catalog title) and `info.version` (the version label) are
  present;
- `paths` is an object.

Schema correctness and `$ref` resolution are not checked. Size limits:

| Limit                                               | Value   |
| --------------------------------------------------- | ------- |
| Document size                                       | 2 MiB   |
| Nesting depth (the root is level one)               | 200     |
| Paths                                               | 2,000   |
| Operations                                          | 3,000   |
| Schema nodes + parameters + media types + responses | 100,000 |

The last limit protects catalog readers, whose browsers render the document.
It counts what the documentation page shows for each operation: parameter
rows, responses, media types, and each schema node (including primitives),
property, `items` and `oneOf`/`anyOf`/`allOf` entry and enum value (up to 12)
of the schemas they hold. Reuse is cheap: a `$ref` to a component costs two
units wherever it appears, and the component itself is counted once, however
many operations use it. Components no operation reaches, descriptions,
examples and `x-*` extensions do not count. A `$ref` may be at most 2,048
characters long. A document past any limit is refused with `SPEC_INVALID`
naming the limit.

A minimal document that publishes cleanly:

```yaml
openapi: 3.1.0
info:
  title: Billing API
  version: 2.4.0
  description: Invoices and payments for partner integrations.
servers:
  - url: https://www.example.com/billing/v2
paths:
  /invoices:
    get:
      summary: List invoices
      responses:
        '200': { description: OK }
```

### The upstream

The gateway forwards to, in order:

1. the **Upstream URL** field, if you fill it in;
2. otherwise the document's first usable **absolute** `servers[].url`.

Server variables are replaced with their string `default`, which must be in
`enum` when one is declared. For example, `https://{env}.api.example.com/v1`
with `variables.env.default: prod` becomes `https://prod.api.example.com/v1`.
Entries with unresolved variables are skipped. Relative URLs (`/v2`) have no
origin to resolve against and are skipped too. If nothing usable remains,
publishing fails and asks for `upstream_url`. The upstream, after expansion,
may be at most 2,000 characters.

Scheme, host, port and base path all come from that URL.

**Private destinations are refused by default.** With
`NEXUS_ALLOW_PRIVATE_UPSTREAMS=false` (the default), the portal refuses an
upstream that is loopback, private (RFC 1918, CGNAT, link-local), named
`localhost` or ending in `.local`, `.internal`, `.localhost` or `.home.arpa`,
resolves to any private address, or does not resolve at all. A portal that
fronts internal services opts in with `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`; see
[`../operations.md`](../operations.md#server) and
[`../security.md`](../security.md#1-threat-model).

### Name, slug and listen path

Clients call your API at:

```
https://<gateway-host>/<namespace>/<slug>/...
```

Leave **Slug** blank to derive it from the name (`Billing API v2` →
`billing-api-v2`): lowercase letters, digits and hyphens, at most 60
characters. Slugs are unique across the portal; a taken slug is a `409`.

**Choose the slug carefully: it cannot be changed.** It is part of every
client's configuration. To move, publish a new API and retire the old one.

### Authentication

Choose how the gateway authenticates callers. This decides which credential
type clients issue:

| Authentication                | Clients issue | They send                                                                       |
| ----------------------------- | ------------- | ------------------------------------------------------------------------------- |
| **API Key** (`key_auth`)      | API Key       | `X-API-Key: <key>`                                                              |
| **HTTP Basic** (`basic_auth`) | HTTP Basic    | Basic auth with their consumer username (`nexus-user-<id>` or `nexus-app-<id>`) |
| **JWT** (`jwt_auth`)          | JWT           | `Authorization: Bearer <HS256 token>`, `sub` = the consumer username            |

API Key is the usual choice: simplest for callers, and the gateway removes the
header before it reaches your backend. Choose JWT when callers should mint
short-lived tokens themselves.

> **With JWT, your backend receives callers' live tokens.** The gateway removes
> an API key or Basic password before forwarding, but forwards
> `Authorization: Bearer` unchanged; Ferrum Edge cannot hide it. Each token works
> for that caller until its `exp`, so do not log it, echo it or pass it on.

> **HTTP Basic needs gateway configuration.** Publishing fails unless the
> operator has set `FERRUM_BASIC_AUTH_HMAC_SECRET` (at least 32 bytes) on Ferrum
> Edge. The error carries the gateway's message in `details.gateway_message`.

### Available to AI agents

This setting is **off by default**. Enable it only on an API using **routes**
enforcement and **Require an approved access request**. The operation picker
preselects GET operations. POST, PUT, PATCH and DELETE require an explicit tick;
HEAD is read-only but unavailable in the published Edge bridge, as are OPTIONS
and TRACE. Choose a unique tool name and a plain-text description for each
selected operation. Destructive annotations describe risk; a client must still
decide when to ask its user for confirmation.

The MCP endpoint is `/<namespace>/<slug>/mcp`, and public tool names are
`<slug>.<tool-name>`. REST calls continue to use the same upstream, authentication
and declared operation table. If you set a method allow-list, include POST for
the MCP transport and each selected operation's method. The endpoint reserves
its subtree: REST paths there, or a first-segment parameter that could match it,
are refused. Agent APIs require canonical ASCII paths with whole-segment
parameters; escaped paths, dot segments and path parameters using `;` are refused.

Every exposed tool requires the existing API approval group. A public listing
is discoverable in the portal; it is **not** anonymous MCP access. Private
listings keep their existing viewer rules. An account's approval does not grant
its applications access, or vice versa. Revocation removes the approval group
and the same credential and MCP session lose access on the next gateway call.
Approval covers all explicitly exposed tools on this API, including any added
later; per-tool subset requests are deferred to phase 2.

The picker displays fixed protection: an enforcing tool governor with unselected
tools denied, argument-only prompt shielding for SSNs, credit cards, API and AWS
keys, and 60 tool calls per consumer per 60-second window. With local counters
that budget applies per gateway process; the operator's Redis configuration
shares it across processes and fails closed on Redis errors. Initialize and
discovery calls do not spend this budget. The regular REST quota remains separate.
These plugins are not free-form palette settings. Transcript sinks, remote
approval webhooks and other AI operator configuration cannot be supplied here.

The catalog shows an **AI agents** badge and your selected tool list. Approved
consumers see **Connect an agent** with the gateway endpoint, normal credential
header and copyable VS Code and Claude Code recipes. Recipes contain placeholders,
never secrets in URLs, portal session cookies or Edge Admin credentials. Updating
the spec does not automatically select new operations. Remove or change a missing
selection in Settings before uploading a spec that deletes it.

Consumers can request all published tools or select individual tools. In the review
dialog you can narrow their selection or approve REST-only access with no tools.
All-tools grants intentionally include future published tools; explicit subsets do not.
Changing what a tool does or says invalidates its exposure ID: renaming or removing
it, disabling agents, editing its description in Settings, or uploading a spec that
changes its summary, description, parameters, request body or success response
schemas. The change removes the old ID from every subset, so affected holders keep REST
access and their other tools but need a new grant for the changed tool. Revoke the old
grant before accepting that identity's new request. A spec update that leaves a tool's
definition alone (an `info.version` bump, another operation, an unreferenced schema)
keeps its ID, so subsets carry; a bump of the document's `openapi` version rotates every
tool. Grantees are told which tools changed, after a spec update or an edit in Settings.
Historical request/grant coverage marks expired IDs explicitly.

Existing phase-1 APIs must be republished once before accepting subsets. Review the
[upgrade tradeoff](../mcp-subsets-migration-draft.md) before rollout.

See the [published contract and test coverage](../agent-marketplace.md).

### Require an approved access request

**On** (the normal setting) attaches an `access_control` plugin that admits
only callers you approved, and shows a request form on the catalog page.

**Off** removes that gate. The API still needs a credential, but **every portal
account with a credential of the right type can call it**. Use it only for
genuinely open utilities. Existing grants stay but have no effect.

### Visibility

| Visibility              | In the catalog           | Opens from a link        | Can request access       |
| ----------------------- | ------------------------ | ------------------------ | ------------------------ |
| **Public**              | Listed                   | Yes                      | Yes                      |
| **Internal (unlisted)** | Not listed               | Yes, for any account     | Yes                      |
| **Private**             | Only for allowed viewers | Only for allowed viewers | Only for allowed viewers |

**Internal means unlisted, not secret.** Anyone with the link can read the
docs and request access. Use it to hand a prospective client a link without
advertising the API.

**Private hides the API** from everyone except you, admins, approved clients
and accounts you authorize. To anyone else it answers "not found", in search,
listings and the spec endpoint alike.

**Visibility controls the documentation, not calls.** What stops unapproved
callers is **Require an approved access request**. A private API with that
turned off can be called by anyone who knows its URL and holds a credential. If
the document itself is too sensitive for signed-in portal users, do not publish
it here.

#### Authorizing viewers

Open **My APIs → your API → Viewers**, enter the **Email address** of an
existing portal account, optionally a **Note**, and choose **Authorize**. They
are notified and can read the API.

- **Authorizing is not approving.** A viewer can read the docs, not call the
  API; they still request access and you approve it. Removing a viewer does not
  touch any grant they hold.
- The account must already exist; an unregistered address is refused.
- The list is kept whatever the visibility and is enforced only while the API
  is Private.

### Rate limit

Tick **Enforce a rate limit**, then set **Requests** (1–1,000,000) and a
**Window** of per second, per minute or per hour. (The API accepts any window
from 1 to 86,400 seconds.)

The limit is **per caller**, not per IP, so one noisy client cannot use up
everyone else's budget. Callers get rate-limit headers and a `429` when they
exceed it.

> **The quota is counted per gateway process.** With several Ferrum Edge
> replicas, each counts separately, so the real limit is your number times the
> replica count, unless the operator runs Redis-synced counters
> (`FERRUM_RATE_LIMIT_SYNC_MODE=redis`). Changing that setting affects only rate
> limits saved afterwards, so an older API may need its limit saved again.

### CORS

Only needed when browsers call your API directly from another site.

- **CORS allowed origins**: one per line, up to 64. Scheme and host (and port
  if non-default), no path, for example `https://app.example.com`.
- **Allow credentials**: tick if those pages send cookies or an
  `Authorization` header.
- **Additional CORS request headers**: custom headers, one per line. The
  authentication header and standard browser headers are allowed
  automatically. Allowed methods follow the API's method list, plus `OPTIONS`.

**An empty origins box is a real choice.** No `cors` plugin is attached, the
gateway adds no CORS headers, and browsers refuse cross-origin calls. That is
right for a server-to-server API. Clearing the box later removes the plugin.

CORS only decides which web pages may read your responses. Authentication and
access control are what protect the data.

**Enforce WebSocket origins** (on by default) rejects WebSocket upgrades from
origins outside your list. Edge accepts upgrades on API paths and its CORS
plugin does not check them, so keep this on for browser WebSocket clients. It
needs exact origins (no wildcards) and also rejects clients that send **no**
`Origin` header, so turn it off if non-browser clients omit it. Authentication
and access control apply either way.

### Enforcement level

By default your OpenAPI document is **documentation only**. The gateway does not
consult it: a client with a key and a grant can call
`/nexus/billing/anything-at-all` and the request reaches your backend. That
never breaks an API with an incomplete document, but it may not be what you
expect.

The **OpenAPI enforcement** select, under the document on the publish page and
on the **Settings** tab, has two levels:

- **Documentation only (default)** (`docs_only`): nothing is enforced.
- **Reject requests to paths and methods not in the spec** (`routes`): the
  gateway builds one rule per declared operation and answers anything else
  with `400` and an `application/problem+json` body, before your backend is
  contacted.

For a document declaring `GET /invoices` and `GET /invoices/{id}`, published at
`/nexus/billing`:

| Request                              | Result                                 |
| ------------------------------------ | -------------------------------------- |
| `GET /nexus/billing/invoices`        | forwarded                              |
| `GET /nexus/billing/invoices/42`     | forwarded (`{id}` matches one segment) |
| `GET /nexus/billing/invoices/42/pdf` | `400` (`{id}` never spans a `/`)       |
| `POST /nexus/billing/invoices`       | `400` (only `get` is declared)         |
| `HEAD /nexus/billing/invoices`       | `400` (see below)                      |
| `GET /nexus/billing/internal-debug`  | `400` (not in the document)            |

#### What it does not do

- **Bodies are not validated.** A `POST` to a declared path reaches your backend
  whatever its body contains. Only the path and method are checked.
- **`HEAD` is its own operation.** Declaring `get` does not declare `head`.
  Declare `head`, `trace` or any other method your clients send.
- **Trailing slashes are literal.** `/invoices` does not allow `/invoices/`.
  Declare the spelling your clients use.
- **`servers` entries do not affect matching.** Rules match the path clients
  send, listen path included. The portal rewrites the document's server base to
  your listen path in the copy it gives the gateway, and removes `servers`
  overrides on paths, operations and reusable path items (they would otherwise
  make every operation answer `400`). Your stored document is unchanged, and
  `servers[0]` still names the upstream. Servers inside operation callbacks are
  left alone.
- **Path `$ref`s must stay inside the document's path items.** At `routes`, a
  path whose `$ref` points anywhere other than `#/paths/`,
  `#/components/pathItems/` or `#/webhooks/` (including another file) is refused
  with a `400` naming the path. Inline it, move it under
  `components.pathItems`, or publish at `docs_only`.

In the catalog, clients at either level see the document with its `servers`
replaced by the gateway address (or the listen path when no gateway address is
configured).

**CORS preflights need nothing.** The gateway's CORS plugin answers `OPTIONS`
preflights before the route check, so you do not declare `options`.

#### Turning it on and off

Change the level on the **Settings** tab. The change is complete when the save
returns.

**Switching level briefly interrupts the API.** The gateway can only attach or
detach the rules by rebuilding the route, so the portal recreates it in place.
Settings, plugins, credentials, grants and the URL all carry over, but for about
a second the API answers `404`. Nothing else does this: spec uploads and every
other setting apply while the API keeps serving. Switch at a quiet moment.

Every spec upload regenerates the rules in place, so the enforced paths always
match the current revision. Uploading a document with **no** operations while
at `routes` is refused (`400 SPEC_INVALID`, `details.reason: "no_operations"`),
because it would reject every request. Switch to documentation only first if
that is really what you want.

### Advanced proxy settings

Three optional settings written onto the gateway proxy. All are safe to change
on a live API.

- **Allowed HTTP methods.** Tick the methods you serve and the gateway answers
  `405` to all others, before authentication or any plugin. With none ticked
  (the default), every method is accepted. **Use the methods declared in the
  spec** fills the list from your document. `OPTIONS` is added automatically
  when a CORS policy is set.
- **Connect / Read / Write timeout (ms).** 100–300,000. Blank uses the gateway
  defaults (5,000 / 30,000 / 30,000). The three are saved together: filling in
  one gives the blank ones their default.
- **Trip a circuit breaker when the backend fails.** After 5 consecutive
  failures (500, 502, 503, 504 or a connection error), the gateway stops
  forwarding for 30 seconds, then lets one probe through at a time until 3
  succeed. Callers get a fast failure instead of a slow one. The thresholds are
  fixed in the portal; the operator can change them on the proxy.

### What publishing creates

```
apis row ─── proxy  nexus-<slug>, listening on /<namespace>/<slug>
              │     plus allowed methods, timeouts, circuit breaker, WebSocket origins
              ├─ plugin  your auth plugin
              ├─ plugin  access_control     only when approval is required
              ├─ plugin  rate_limiting      only when a rate limit is set
              ├─ plugin  cors               only when origins are listed
              └─ plugin  openapi_validator  only at `routes`; built by the gateway from your document
```

**Your URL is never open by accident.** The portal builds the proxy at a
private, random path, attaches and enables every plugin, and moves it to
`/<namespace>/<slug>` last. Until then your URL answers `404`; it never answers
without the authentication, access control or rate limit you chose. A level
switch works the same way, which is why it shows as a brief `404`.

---

## Plugins

**My APIs → your API → Plugins.** The **Settings** tab defines what your API
is. The **Plugins** tab adds optional gateway behaviour you can switch on or off
at any time without republishing.

Each card is off until you choose **Turn on**. Saving writes the plugin to the
gateway and attaches it to your proxy in one step, so it is live immediately.
If the gateway refuses, nothing is saved.

| Plugin                   | What it does                                                                                        | What callers see                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Security headers**     | Adds browser hardening headers and strips headers that reveal your stack                            | No change in how the API is called                                                 |
| **Request size limit**   | Rejects a request body over your limit (default 1 MiB) before it reaches your backend               | `413 Payload Too Large`; document the limit on upload endpoints                    |
| **Response size limit**  | Refuses a response over your limit; a declared length gets 502, a stream starts 200 then is cut off | `502 Bad Gateway`, or a `200` whose body is cut off for an unknown-length stream   |
| **IP allow / deny list** | Restricts callers by source address. A deny match always wins                                       | Unlisted addresses are rejected before authentication                              |
| **Bot filter**           | Blocks requests whose `User-Agent` contains a listed string; an allow list is checked first         | Legitimate SDKs should send a recognisable `User-Agent`                            |
| **Correlation ID**       | Gives every call an id, forwards it to your backend and echoes it back                              | They can send their own id, or quote the gateway's in a support request            |
| **Response compression** | Compresses responses (gzip, Brotli) when the caller asks                                            | A compressed body when they send `Accept-Encoding`                                 |
| **Idempotency keys**     | A retried write with the same key replays the first response instead of running again               | They send a unique key per operation; reusing a key with a different body is `409` |
| **Maintenance / sunset** | Returns a fixed response instead of calling your backend                                            | Your status and message: `503` for maintenance, `410` for a retired endpoint       |

Notes:

- The **bot filter** is coarse. `User-Agent` is trivially spoofed; it deters
  casual scrapers, not determined ones.
- **Response size limit has two contracts.** A response that declares its length
  is refused with `502 Bad Gateway` before any body is sent. A response of
  unknown length (a chunked or streamed body, SSE included) commits `200` first
  and is then cut off once it passes the limit, so a consumer sees a truncated
  stream rather than a `502`. Paginate bodies that can grow without bound.
- **Security headers → Strict-Transport-Security** sends
  `max-age=31536000; includeSubDomains`, pinning browsers to HTTPS for a year on
  your whole domain and every subdomain. Turn it on only when that is true.
- **Compression and idempotency keys work together.** The portal orders them so
  headers are final before the idempotency fingerprint is taken. If an operator
  has overridden the order in a conflicting way, the save says which priorities
  to change.
- **Response caching is no longer offered.** The gateway will not cache
  authenticated responses unless your backend opts in (`Cache-Control: public`,
  `must-revalidate` or `s-maxage`), so the portal could not promise hits. An
  existing caching plugin stays in place and shows **Remove response caching**.
  An operator can configure caching directly.

### Limiting a plugin to some requests

The IP list, bot filter, idempotency keys and maintenance cards offer **Only run
on some requests**: a **Methods** list, a **Path prefix**, or both. For example,
to retire one endpoint, turn on Maintenance / sunset with status `410` and set
the path prefix to that endpoint.

The prefix matches the full path clients send, so it starts with your gateway
path (`/nexus/your-slug/…`). It must be a plain path: no `%` escapes,
backslashes, or `.` / `..` segments.

The other cards (security headers, both size limits, compression and
correlation ID) apply to the whole API; the gateway does not support per-request
conditions for them.

### Pausing versus removing

- Untick **Active** and save to pause a plugin. Its settings stay on the gateway
  and come back when you tick it again.
- **Remove** deletes the plugin and its settings.

### Not offered

- **Other authentication methods** (HMAC signatures, JWKS, OAuth 2.0
  introspection, mutual TLS). These replace the authentication choice and need
  new credential types; they are not built.
- **Serving your spec from the gateway** (`spec_expose`). The catalog already
  serves it.
- **Operator plugins** (logging, tracing, metrics, fault injection and the
  like). Ask your administrator.

---

## Usage and backend health

**My APIs → your API → Overview → Usage** is a live read of what the gateway
reports for your proxy. The page refreshes it every 30 seconds; the server
caches it for 10.

| Row               | What it is                                                              |
| ----------------- | ----------------------------------------------------------------------- |
| **Backend**       | Healthy, Failing, Recovering or Unknown, with the reason                |
| **Requests**      | Every call the gateway counted for this API                             |
| **By status**     | The same total split into 2xx / 3xx / 4xx / 5xx                         |
| **Turned away**   | `429` (rate limit), `401` (bad or missing credential), `403` (no grant) |
| **Latency (p95)** | p95, with p50 and p99, in milliseconds                                  |

**Counts are cumulative since the gateway process started.** A gateway restart
resets them to zero. They are not "this week" or "since you published". Nexus
keeps no history; for trends, point Prometheus and Grafana at the gateway (your
administrator has the details in the operations guide).

The card cannot tell you **who** is calling (there is no per-client breakdown),
**which endpoints** are busy, or anything about calls that never reached the
gateway.

**Backend states:**

- **Unknown**: the gateway has nothing to report, either because nothing has
  called the API yet or because no circuit breaker is configured. It never
  means the backend is down.
- **Failing**: the circuit breaker has opened, or health checks removed a
  target. The card says since when.
- **Recovering**: the breaker is letting probe requests through.

If the card says gateway metrics are unavailable, the counters are missing, not
zero; the API may be serving normally.

### "Gateway deployment missing"

If the gateway was rebuilt and no longer holds your proxy, the Overview shows
**Gateway deployment missing** and your URL fails. Choose **Restore gateway
deployment**. It rebuilds the proxy, authentication and access control from
what the portal holds; grants and client credentials carry over.

---

## Updating an API

**My APIs → your API → Settings**, then **Save settings**. Changes apply to the
gateway immediately.

| Change                                       | Effect                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Name, description, version                   | Catalog text only.                                                                                                 |
| Visibility                                   | Who can see the docs. Grants and calls are unaffected. Private enforces the viewer list; leaving Private keeps it. |
| Upstream URL                                 | Moves the gateway's backend. Leave blank to keep the current one.                                                  |
| Rate limit                                   | Adds, changes or (unticked) removes the quota.                                                                     |
| CORS                                         | Adds, replaces or (emptied) removes the CORS policy and its WebSocket origin check.                                |
| Allowed methods, timeouts, circuit breaker   | Apply immediately. Untick every method, or clear the timeouts, to return to the defaults.                          |
| OpenAPI enforcement                          | Briefly interrupts the API; see [Turning it on and off](#turning-it-on-and-off).                                   |
| **Require an approved access request → off** | Removes the gate. **Every portal account with a matching credential can call the API.**                            |
| **Authentication**                           | Cuts off callers using the old method until they issue a new credential. See below.                                |
| Status → Retired                             | See [Retiring versus deleting](#retiring-versus-deleting).                                                         |

### Changing the authentication method

Credentials are typed. Switching from API Key to JWT does not convert anyone's
key: from the moment you save, their key no longer works on **this** API.

When you change **Authentication**, the Settings tab shows a warning and a
checkbox: **Invalidate portal-issued old-method credentials here and notify
their holders**. If any account with access holds a live credential of the old
type and you save without ticking it, the save is refused with
`409 ACCESS_DISRUPTION_CONFIRMATION_REQUIRED`. The error says how many
accounts would be affected, and nothing is written. Use that to check the
impact before you commit.

When you confirm:

- **Nobody's credential is revoked.** Credentials belong to the caller, not to
  your API, and still work on their other APIs of that type. What they lose is
  this API until they issue a credential of the new type.
- Every affected account is notified and pointed to its credentials page.
- The API's **test consumer** credential is revoked, since it exists only for
  this API. Create a new one afterwards.

Tell your callers and agree a window before you switch.

If **Require an approved access request** is off, there is no list of callers,
so the change is never refused and nobody is notified. Announce it yourself.

---

## Updating the spec safely

**My APIs → your API → Specification**:

1. Edit the document in the editor, or **Upload file**.
2. Choose **Review changes**. The portal compares your draft with what the API
   serves now.
3. Read the comparison, then choose **Publish revision**.

Each published document becomes a new, current revision. The API's version
label follows the document's `info.version`, so bump it when you publish. The
portal keeps a limited number of older revisions (10 by default,
`NEXUS_SPEC_HISTORY_LIMIT`) and drops the oldest as new ones arrive.

Everyone who can read your API's documentation sees what each published
revision changed on the catalog page's **Changes** tab, with breaking changes
marked. That summary is recorded when you publish and stays after the revision
itself is dropped.

### Reading the review

The review lists operations that would **stop being served** first, then added
operations, changed operations, and changes to `info` or `servers`. Removed
operations are the ones that break callers.

Treat it as a prompt, not a verdict. It compares paths, methods and the shape of
each operation, but does not read schemas or follow `$ref`s. A response that
quietly drops a required field shows up at most as "changed", never as
breaking.

### Revision history and rollback

**Revision history** on the Specification tab lists retained revisions, newest
first, with who published each and when. **View document** shows the original
upload exactly.

**Review & roll back** on an older revision shows the comparison from what the
API serves today, then **Roll back** republishes that document as a **new**
revision. History is never rewritten. The API keeps its id, slug, URL, plugins
and every approved client. If the gateway refuses, nothing changes.

- A revision you see today can be pruned by later uploads. Rolling back to one
  that is gone answers "no longer retained".
- At the `routes` [enforcement level](#enforcement-level), a rollback changes
  what the gateway accepts, exactly as an upload does.

### When an upload moves your backend

An upload **can** move the gateway's backend. The rule:

> Your API follows its document while its recorded upstream is still the
> `servers[0].url` of the **previous** revision. Then any change to that URL
> (scheme, host, port **or base path**) moves the backend. If the recorded
> upstream is anything else, it is pinned and uploads never touch it.

URLs are compared after normalization, so `https://api.example.com/v2` and
`https://api.example.com:443/v2/` are the same, while `/v2` → `/v3` on the same
host **is** a move.

In practice:

- If you never set **Upstream URL**, editing `servers[0].url` and publishing
  **moves your traffic**, even for a base-path-only change.
- If you set **Upstream URL**, uploads only change documentation.
- Setting the upstream back to exactly the document's URL makes the API follow
  the document again.

For production APIs, set **Upstream URL** explicitly so publishing docs and
moving the backend stay separate decisions. If an upload that moves the backend
fails, the move is undone.

### If enforcement is on

At `routes`, an upload also changes **what the gateway accepts**: a removed path
stops working when the revision lands, and an added one starts working. Check
the path changes, not just the prose. A failed upload restores the previous
rules. Uploads apply in place without interrupting the API; only
[changing the level](#turning-it-on-and-off) causes the brief `404`.

### A safe update routine

1. Try the change on a staging portal first, if you have one.
2. Publish additive changes (new endpoints, new optional fields) freely.
3. For breaking changes, publish a **new API with a new slug** (say
   `billing-v3`) and retire the old one once clients have moved.
4. Bump `info.version` so the catalog shows the change.

---

## Reviewing access

New requests notify you in-app and appear on your **Dashboard** under **Pending
requests for your APIs**.

Open **My APIs → your API → Requests**. **Request status** starts at **Pending**;
choose **Approved**, **Denied** or **All** for history (All includes cancelled
and revoked requests). Both **Requests** and **Grants** show 50 records per page
with **Previous** / **Next**.

Each request shows the requester (name, email, company) and their
justification. If it is thin, use **Message** on the row to ask before you
decide.

### Approve

**Approve** adds the API's access group to the requester's gateway consumer and
creates a grant. An optional **Decision note** is shown to the requester and
emailed to them. Access is live at once: calls pass as soon as they hold a
credential of the right type.

If the gateway is unreachable, nothing is saved and the request stays pending.
Approve again once the gateway is back.

### Deny

**Deny** changes nothing on the gateway. **Add a decision note.** A reason
usually brings a corrected request; a silent decline brings a support thread.
The requester can ask again.

### Revoke

On **Grants**, **Grant status** starts at **Active**; choose **Revoked** or
**All** for history. **Revoke** removes the access group from that caller. Their
next call gets `403`; their credential still works on their other APIs.

Add a **Reason**. It is recorded, shown to the caller and emailed. The original
request is marked revoked too.

### Who else can act on your API

Admins and super admins can approve, deny and revoke on any API, and edit or
delete it, so someone can cut off access when you are unreachable. Every such
action is audited with the actor, and god-mode actions also record a reason.

---

## Test consumer

**My APIs → your API → Test consumer → Create test credential** gives you a
throwaway identity for your own API, so you can check routing, authentication,
access control and rate limiting without borrowing a client's credential.

It creates a gateway consumer named `nexus-test-<api id>` with this API's
access group and one credential of the API's authentication type. The secret is
**shown once**.

```bash
curl -sS https://gateway.example.com/nexus/billing/invoices \
  -H "X-API-Key: <the test key>"
```

Creating it again **replaces** the previous one: the old consumer is deleted and
a new credential issued. Do not build anything permanent on it.

After a significant change, check for a `200` on a normal call, a `401` with no
credential, and, if you set a rate limit, a `429` under load. The test consumer
has its own rate-limit budget.

---

## Messaging clients

**Messages** is the portal inbox. Clients can message you from your API's
catalog page, and you can reply. To start a conversation yourself, use
**Message** on a row in **Requests** (to ask about a justification or explain a
decision) or **Grants** (to warn callers about a change). Conversations about
the same API with the same client continue in one thread.

For announcements to everyone, ask an administrator: that is what mass email
and platform broadcasts are for.

---

## Retiring versus deleting

### Retire: reversible, breaks nothing

**Settings → Status → Retired**, then **Save settings**.

- The gateway is **untouched**. Existing grants and integrations keep working.
- The API disappears from the catalog for everyone except you, its current
  grantees and admins.
- New access requests, and approval of still-pending ones, are refused.

Set the status back to **Published** to undo it. **This is almost always what
you want.**

### Delete: permanent, breaks everything

**Settings → Danger zone → Delete API**, then type the slug to confirm.

- The proxy and its plugins are **removed from the gateway**. Every call fails
  at once.
- The access group is removed from every grantee.
- All grants, access requests and spec revisions are deleted.
- Grantees are notified that the API was removed.

There is no undo. Publishing again under the same slug restores nobody's
access; every client must request again.

To decommission: **retire**, tell your grantees, wait out a migration window,
then delete once nobody is calling.

---

## Limits

| Limit                     | Default | Set by the operator with   |
| ------------------------- | ------- | -------------------------- |
| APIs you own at once      | 50      | `NEXUS_MAX_APIS_PER_OWNER` |
| Older spec revisions kept | 10      | `NEXUS_SPEC_HISTORY_LIMIT` |
| CORS origins per API      | 64      | —                          |

Past the API limit, publishing is refused with `429 QUOTA_EXCEEDED`. Deleting an
API frees a slot; retiring one does not.

---

## Troubleshooting

**"Publishing failed with a spec error."** The message names the problem.
Common causes: Swagger 2.0 (convert to OpenAPI 3); missing `info.title`,
`info.version` or `paths`; YAML that does not parse; a size limit.

**"No upstream could be determined."** The document has no usable absolute
`servers[].url`. Fill in **Upstream URL**.

**"The upstream is refused."** It is private or does not resolve from the
server. See [The upstream](#the-upstream).

**"The slug is already in use."** Slugs are unique portal-wide. Pick another.

**"Publishing failed with a gateway error."** Nothing was saved, so retry once
the gateway is healthy. If the gateway rejected the request itself (for example
the spec, or a missing `FERRUM_BASIC_AUTH_HMAC_SECRET`), the error includes its
message: `400 EDGE_REJECTED_SPEC` with the gateway's reason (up to 500
characters) for a refused spec, or `details.gateway_message` otherwise. For
other failures the browser shows a generic `502`, and the details are in the
server log.

**"A client gets 403."** They are authenticated but not approved for this API,
or their credential belongs to a different identity than the grant. Check
**Grants**.

**"A client gets 401."** Their credential is missing, revoked or the wrong type,
most often after an authentication change.

**"A client gets 502/503."** That is your backend. Check **Backend** on the
Overview tab: **Failing** confirms it and says since when. **Unknown** does not
clear your backend; it usually means there is no circuit breaker. Check the
backend is healthy and reachable **from the gateway**.

**"My rate limit is not applied."** Confirm it is saved on **Settings**. It is
per caller, and each caller (including the test consumer) has its own budget.
With several gateway replicas, see the note under [Rate limit](#rate-limit).
