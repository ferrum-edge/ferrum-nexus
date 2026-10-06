# Getting started

This walkthrough takes you from an empty machine to a client calling a
published API through the gateway, with a credential the portal issued.

It targets Ferrum Nexus `v0.4.0` with Ferrum Edge `v0.9.13`, the supported pair
in the [release notes](release-notes.md). To upgrade a deployment that keeps
its data, see [schema versioning and upgrades](operations.md#schema-versioning-and-upgrades).
A development database created before `v0.1.0` needs the
[development reset](operations.md#buildout-schema-policy).

You play three roles in turn: the operator who runs the stack, a **provider**
who publishes an API, and a **client** who requests access and calls it. Allow
about twenty minutes.

Every step uses `curl` against the real API routes, so you can follow along
without the web UI. The matching UI steps are noted as you go.

> **Started the [Compose stack](../README.md#docker) instead?** Skip steps 2
> and 3 and step 5's echo server. Three things differ:
>
> - The portal is at <http://127.0.0.1:8787>, not `:5173`.
> - The bootstrap token in step 4 is the one `docker compose logs nexus` prints.
> - The Compose portal publishes only public upstreams (it does not set
>   `NEXUS_ALLOW_PRIVATE_UPSTREAMS`), so step 5's `servers[0].url` must be a
>   public HTTPS backend.
>
> Every release's [verbatim quickstart gate](release-notes.md#release-step)
> follows this path.

---

## 1. Prerequisites

- **Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`**, the supported profile since
  `v0.4.0`. Node 23 and 25 are not supported.
- **Docker**, for the Ferrum Edge gateway.
- `curl` and `jq` for the examples.

No database server is needed: Nexus defaults to SQLite.

[`.nvmrc`](../.nvmrc) pins Node 22.22.2, the lowest supported version. Releases
before `v0.4.0` supported Node 22.14 or later.

---

## 2. Start a Ferrum Edge gateway

Nexus is a front end for a gateway, so the gateway comes first.

Clone Nexus, check out the release tag, and load the
[compatibility record](../release/compatibility.env). The record names the
exact Edge image this release was tested with, the same one the
[Compose example](operations.md#compose) uses:

```bash
git clone https://github.com/ferrum-edge/ferrum-nexus.git
cd ferrum-nexus
git checkout --detach v0.4.0
set -a
. ./release/compatibility.env
set +a
```

The gateway image runs as **UID 65532** and ships `/data` owned by that user.
Docker copies that ownership into a **new** named volume, so a fresh volume
works as-is (the `docker run` below creates `ferrum-data` if it does not
exist):

```bash
docker volume create ferrum-data
```

A bind mount, or a volume created against an older image, keeps its existing
owner. Fix it before starting the gateway, or SQLite cannot write:

```bash
docker run --rm \
  -v ferrum-data:/data \
  alpine:3@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 \
  chown 65532:65532 /data
```

See the Edge [Docker guide](https://github.com/ferrum-edge/ferrum-edge/blob/main/docs/docker.md#volume-mounts)
for details.

Start the gateway:

```bash
export FERRUM_ADMIN_JWT_SECRET="$(openssl rand -hex 32)"
export FERRUM_BASIC_AUTH_HMAC_SECRET="$(openssl rand -hex 32)"

docker run -d --name ferrum-edge \
  -p 127.0.0.1:8000:8000 \
  -p 127.0.0.1:9000:9000 \
  --add-host=host.docker.internal:host-gateway \
  -e FERRUM_MODE=database \
  -e FERRUM_DB_TYPE=sqlite \
  -e FERRUM_DB_URL='sqlite:///data/ferrum.db?mode=rwc' \
  -e FERRUM_NAMESPACE=nexus \
  -e FERRUM_ADMIN_JWT_SECRET \
  -e FERRUM_BASIC_AUTH_HMAC_SECRET \
  -e FERRUM_ADMIN_BIND_ADDRESS=0.0.0.0 \
  -e FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true \
  -v ferrum-data:/data \
  "${FERRUM_EDGE_IMAGE:?set FERRUM_EDGE_IMAGE to a published version or digest}" run -m database
```

`-e NAME` with no value passes the exported variable through, so the secrets
never appear on the command line.

Three settings need explaining:

- **`FERRUM_NAMESPACE` must be the same on the gateway and the portal.** The
  Admin API accepts writes into any namespace, but a gateway's proxy listener
  routes only its own (`ferrum` when unset). If the two differ, publishing
  still succeeds and the catalog still shows an invoke URL, but every call
  answers `404`. This walkthrough uses `nexus` on both sides;
  [step 3](#3-set-up-ferrum-nexus) shows how the portal reports a mismatch.
- **`--add-host=host.docker.internal:host-gateway`** lets the container reach
  services on your host by that name. Docker Desktop provides it anyway; plain
  Linux needs the flag.
- **`FERRUM_BASIC_AUTH_HMAC_SECRET`** (at least 32 bytes) is how the gateway
  hashes Basic-auth passwords. Without it the gateway refuses the `basic_auth`
  plugin, and publishing a `basic_auth` API fails with `EDGE_ERROR`. The
  gateway's reason is in `details.gateway_message`.

The gateway has two ports. Confusing them is the most common first-run mistake:

| Port   | What it is         | Who talks to it                        |
| ------ | ------------------ | -------------------------------------- |
| `9000` | **Admin API**      | the Nexus server only, never a browser |
| `8000` | **Proxy listener** | API clients calling published APIs     |

`FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true` is acceptable here because the Admin
API is published on loopback only. In production, put it behind TLS or on a
private network; see [`security.md`](security.md#9-ferrum-edge-admin-jwt-hygiene).

Check that the proxy listener is up:

```bash
# No route is published yet, so `/` answers 404. Without -f, curl still
# succeeds on a 404 and fails only when nothing is listening.
curl -s -o /dev/null http://127.0.0.1:8000/ && echo "proxy listener up"
```

> **If your gateway uses a different JWT issuer**, note it now. Nexus signs
> Admin API tokens with `iss: ferrum-edge` by default and the gateway rejects a
> mismatch. Set `FERRUM_ADMIN_JWT_ISSUER` in the next step to match.

---

## 3. Set up Ferrum Nexus

```bash
npm install
cp .env.example .env
```

Set these values in `.env`. Most of the keys already exist in the file; change
them in place:

```bash
NEXUS_SECRET_KEY=<paste `openssl rand -hex 32`>
FERRUM_ADMIN_URL=http://127.0.0.1:9000
FERRUM_ADMIN_JWT_SECRET=<the value you exported in step 2>
# Must match the gateway's FERRUM_NAMESPACE from step 2.
FERRUM_NAMESPACE=nexus
NEXUS_PUBLIC_URL=http://127.0.0.1:5173

# The gateway's PROXY listener (not the Admin API, not the portal). The catalog
# builds each API's invoke URL from it. Admins can change it later in
# Administration → Settings → Gateway.
FERRUM_GATEWAY_PUBLIC_URL=http://127.0.0.1:8000

# This walkthrough runs over plain http. The session cookies are Secure unless
# NEXUS_COOKIE_SECURE=false; production keeps them Secure and serves https.
NEXUS_ENV=development
NEXUS_COOKIE_SECURE=false

# Publishing refuses loopback, private-range and .internal upstreams unless
# this is true, and the walkthrough's host.docker.internal upstream is one of
# them. Leave it false wherever providers are not fully trusted.
NEXUS_ALLOW_PRIVATE_UPSTREAMS=true

# The secret the first registration must present to become super_admin
# (at least 16 characters). Leave it blank and the server generates one per
# process and prints it at startup.
NEXUS_BOOTSTRAP_TOKEN=walkthrough-bootstrap-token
```

Then start it:

```bash
npm run migrate   # also runs automatically at startup
npm run dev       # backend :8787, web :5173 (NEXUS_PORT / NEXUS_WEB_PORT)
```

Run `npm run migrate` from the repo root. The root script builds the `shared`
workspace first; `npm run migrate --workspace server` fails on a clean clone
until `npm run build --workspace shared` has run.

Confirm that Nexus can reach its database and the gateway:

```bash
curl -s http://127.0.0.1:8787/api/health | jq '{status, db: .database.status, edge: .edge.status}'
```

```json
{ "status": "ok", "db": "ok", "edge": "ok" }
```

If `edge` is not `ok`, the overall `status` is `degraded`:

- **`edge: "down"`**: Nexus cannot reach or authenticate to the Admin API.
  Check `FERRUM_ADMIN_URL`, that the JWT secret matches on both sides, and that
  `FERRUM_ADMIN_JWT_ISSUER` matches the gateway's issuer.
- **`edge: "degraded"`** with `edge.reason: "namespace_unserved"`: the gateway
  is healthy but does not route the namespace this portal publishes into. An
  anonymous request sees only that verdict. The gateway's own namespace is
  shown to admins only, so [step 4](#4-first-run-register-the-founding-super-admin)
  reads it once you have an admin session.

While the namespaces disagree, publishing is refused with
`409 EDGE_NAMESPACE_UNSERVED`. To fix it, set the portal's `FERRUM_NAMESPACE`
to the gateway's, or restart the gateway with the portal's value, then restart
the portal. Reads and `DELETE` keep working, so anything already published into
the wrong namespace can be removed.

> **Watch out for a leftover `export`.** An exported `FERRUM_NAMESPACE` or
> `FERRUM_ADMIN_URL` beats the value in `.env`. When they disagree, the server
> prints a banner naming both values. Outside `NEXUS_ENV=production` it also
> **refuses to start** until you `unset` the variable, make `.env` agree, or
> set `NEXUS_ALLOW_ENV_OVERRIDE=true`.

---

## 4. First run: register the founding super admin

**The first account registered becomes `super_admin`**, whatever role it asks
for, and its email is marked verified. Because of that, the registration must
carry the **bootstrap token** to prove it comes from whoever runs the server.

The token is:

- `NEXUS_BOOTSTRAP_TOKEN`, if set (as in step 3), or
- a token the server generates and prints at startup while the portal has no
  active super admin:

  ```
  FIRST-RUN BOOTSTRAP: this portal has no super_admin yet.
  …
      2f6c1b0e…
  ```

  It changes on every restart and differs per instance, so set
  `NEXUS_BOOTSTRAP_TOKEN` when you run more than one instance.

While the portal has no active super admin, a registration without the right
token is refused with `403 FORBIDDEN` and creates nothing. Once a super admin
exists, the field is ignored and registrations create ordinary accounts.

In the browser: open <http://127.0.0.1:5173>, click **Register** and fill in
the form. It asks for the bootstrap token while the portal has no super admin.

With curl:

```bash
curl -sS -c admin.txt -X POST http://127.0.0.1:8787/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"root@example.com","password":"correct-horse-battery-staple",
       "display_name":"Root","role":"provider",
       "bootstrap_token":"walkthrough-bootstrap-token"}' | jq '.user.role'
```

```
"super_admin"
```

The response stored the session cookies in `admin.txt`. Every mutation also
needs the CSRF token in a header, so save it:

```bash
ADMIN_CSRF=$(curl -sS -b admin.txt http://127.0.0.1:8787/api/auth/me | jq -r .csrf_token)
```

### If `edge.status` reported `degraded`: read the namespace detail

With an admin session, the health route includes the gateway's side of the
namespace check:

```bash
curl -s http://127.0.0.1:8787/api/health -b admin.txt | jq '.edge | {status, reason, namespace_routing}'
```

```json
{
  "status": "degraded",
  "reason": "namespace_unserved",
  "namespace_routing": {
    "configured": "nexusiso",
    "active": "nexus",
    "serving_scope": "single-namespace-data-plane",
    "data_plane_single_namespace": true,
    "unserved": true,
    "unserved_mutation_observed": false,
    "checked_at": "2026-09-12T09:12:44.117Z"
  }
}
```

`configured` is the portal's `FERRUM_NAMESPACE` and `active` is the gateway's.
Make them match as described in [step 3](#3-set-up-ferrum-nexus).

> Create a **second** `super_admin` before you go to production. The last
> active super admin cannot be demoted or disabled, so with only one you have
> no fallback.

Now register the provider and client accounts used in the rest of the
walkthrough, keeping each one's cookie jar and CSRF token:

```bash
# provider
curl -sS -c provider.txt -X POST http://127.0.0.1:8787/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"pat@example.com","password":"correct-horse-battery-staple",
       "display_name":"Pat Provider","role":"provider"}' >/dev/null
PROVIDER_CSRF=$(curl -sS -b provider.txt http://127.0.0.1:8787/api/auth/me | jq -r .csrf_token)

# client
curl -sS -c client.txt -X POST http://127.0.0.1:8787/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"cleo@example.com","password":"correct-horse-battery-staple",
       "display_name":"Cleo Client","role":"client"}' >/dev/null
CLIENT_CSRF=$(curl -sS -b client.txt http://127.0.0.1:8787/api/auth/me | jq -r .csrf_token)
```

---

## 5. Publish an API (as the provider)

The gateway needs a backend to forward to. Any HTTP service works; here, run a
throwaway echo server:

```bash
docker run -d --name echo -p 8081:80 \
  ealen/echo-server:latest@sha256:ec8a6e95890df937a1eb5fafca033a32172d4f43c1fea1f302931d5f230a137f
```

This publishes port 8081 on **all** interfaces on purpose. The gateway reaches
it from inside its container through the host's bridge address, not loopback,
so a port published only on `127.0.0.1` would be unreachable. Port 8081 is open
to your network until step 11 removes the container.

Write a minimal OpenAPI 3 document. Nexus requires only `openapi` (3.x),
`info.title`, `info.version` and a `paths` object. The first absolute
`servers[].url` becomes the upstream, so you don't have to enter it twice.

```bash
cat > billing-openapi.yaml <<'YAML'
openapi: 3.1.0
info:
  title: Billing API
  version: 2.4.0
  description: Invoices and payments for partner integrations.
servers:
  - url: http://host.docker.internal:8081
paths:
  /invoices:
    get:
      summary: List invoices
      responses:
        '200':
          description: OK
  /invoices/{id}:
    get:
      summary: Get one invoice
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: OK
        '404':
          description: Not found
YAML
```

> `host.docker.internal` resolves inside the gateway container only because of
> Docker Desktop or the `--add-host` flag from step 2. If you started the
> gateway without it, recreate the container with the flag. Alternatively, put
> both containers on one user-defined network (`docker network create demo`,
> then `--network demo` on each) and use `http://echo` as the upstream.

In the browser: **My APIs → Publish an API**. Paste the document and choose the
auth plugin, visibility and rate limit. The optional **Advanced** section
restricts the HTTP methods the gateway accepts, sets backend timeouts and turns
on a circuit breaker.

With curl:

```bash
SPEC=$(jq -Rs . < billing-openapi.yaml)

curl -sS -b provider.txt -X POST http://127.0.0.1:8787/api/apis \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $PROVIDER_CSRF" \
  -d "{\"name\":\"Billing API\",
       \"slug\":\"billing\",
       \"version\":\"2.4.0\",
       \"spec\":$SPEC,
       \"auth_plugin\":\"key_auth\",
       \"requestable\":true,
       \"visibility\":\"public\",
       \"rate_limit\":{\"limit\":1000,\"window_seconds\":60}}" | jq '.api | {id, slug, ferrum_proxy_id}'
```

```json
{ "id": "2b1c…", "slug": "billing", "ferrum_proxy_id": "9d4f…" }
```

That call created four objects on the gateway. If any step fails, Nexus
deletes what it already created:

1. a proxy named `nexus-billing` on the listen path **`/nexus/billing`**,
   forwarding to `http://host.docker.internal:8081`;
2. a `key_auth` plugin;
3. an `access_control` plugin that allows only `nexus:api:2b1c…:approved`,
   because `requestable` is `true`;
4. a `rate_limiting` plugin: 1000 requests per 60 seconds **per consumer**.

The listen path is always `/<namespace>/<slug>`.

> **The rate limit is counted per gateway process.** With N data-plane replicas
> a client gets N × 1000 requests a minute, because Edge keeps the counters in
> memory by default. To share one counter, set `FERRUM_RATE_LIMIT_SYNC_MODE=redis`
> and `FERRUM_RATE_LIMIT_REDIS_URL` on Nexus. The setting applies to rate
> limits saved after the change. See
> [operations.md](operations.md#ferrum-edge-integration).

Save the API id:

```bash
API_ID=$(curl -sS -b provider.txt 'http://127.0.0.1:8787/api/apis?mine=true' | jq -r '.items[0].id')
```

---

## 6. Request access (as the client)

The client finds the API in the catalog and asks for access with a
justification.

In the browser: **API catalog → Billing API → Request access**.

```bash
curl -sS -b client.txt 'http://127.0.0.1:8787/api/catalog?q=billing' \
  | jq '.items[] | {name, slug, requestable, access_state}'
```

```json
{ "name": "Billing API", "slug": "billing", "requestable": true, "access_state": "none" }
```

An API published with `requestable: false` has no `access_control` plugin and
reports `access_state: "open"`: any portal account with a credential can call
it.

```bash
curl -sS -b client.txt -X POST http://127.0.0.1:8787/api/access-requests \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $CLIENT_CSRF" \
  -d "{\"api_id\":\"$API_ID\",
       \"justification\":\"Reconciling partner invoices nightly for the Acme integration.\"}" \
  | jq '{id: .access_request.id, status: .access_request.status}'
```

```json
{ "id": "7ae3…", "status": "pending" }
```

The provider gets an in-app notification.

---

## 7. Approve it (as the provider)

In the browser: **My APIs → Billing API → Requests → Approve**.

```bash
REQ_ID=$(curl -sS -b provider.txt 'http://127.0.0.1:8787/api/access-requests?status=pending' \
          | jq -r '.items[0].id')

curl -sS -b provider.txt -X POST "http://127.0.0.1:8787/api/access-requests/$REQ_ID/approve" \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $PROVIDER_CSRF" \
  -d '{"decision_note":"Approved for the nightly reconciliation job."}' \
  | jq '{status: .access_request.status, acl_group: .grant.acl_group}'
```

```json
{ "status": "approved", "acl_group": "nexus:api:2b1c…:approved" }
```

Behind the scenes, Nexus creates Cleo's Ferrum consumer (`nexus-user-<her id>`)
if it does not exist yet, adds the ACL group to it, and only then records the
grant. If the gateway write fails, the request goes back to `pending` and can
be approved again.

The client gets a notification and an `access_approved` email. The email waits
in the outbox as `pending` until SMTP is configured, which is fine for now.

---

## 8. Issue a credential (as the client)

Approval **authorizes** the client. The client still needs a credential to
**authenticate**. The API uses the `key_auth` plugin, whose credential type is
`keyauth` (no underscore; the naming comes from Ferrum Edge). The UI picks the
right type for you.

In the browser: **Credentials → Issue credential → API key**.

```bash
curl -sS -b client.txt -X POST http://127.0.0.1:8787/api/credentials \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $CLIENT_CSRF" \
  -d '{"credential_type":"keyauth","label":"nightly-job"}' \
  | jq '{consumer_username, key: .secret.key, last4: .credential.last4}'
```

```json
{
  "consumer_username": "nexus-user-7c1d…",
  "key": "nxs_pQ7v3H2s…",
  "last4": "s9fA"
}
```

> ### Save that key now
>
> It is shown only once. Nexus stores a SHA-256 fingerprint and the last four
> characters, and Ferrum Edge redacts credential material on every read, so
> nobody can recover it. If you lose it, rotate the credential.

```bash
export API_KEY='nxs_pQ7v3H2s…'
```

---

## 9. Call the API through the gateway

The API's catalog page shows its full URL under **Call this API**, built from
`FERRUM_GATEWAY_PUBLIC_URL`. The API responses carry the same value as
`invoke_url`. Here it is `http://127.0.0.1:8000/nexus/billing`: the proxy
listener (`:8000`) plus the listen path.

Call it with the key:

```bash
curl -sS -i http://127.0.0.1:8000/nexus/billing/invoices \
  -H "X-API-Key: $API_KEY"
```

A `200` means every layer passed: the proxy routed the request, `key_auth`
identified the consumer, `access_control` found `nexus:api:2b1c…:approved` in
its groups, and `rate_limiting` let it through.

Without the key, the gateway refuses the call:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/nexus/billing/invoices
# 401
```

How to send the credential depends on the API's auth plugin:

| API `auth_plugin` | Credential type | How to call                                                                                                                 |
| ----------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `key_auth`        | `keyauth`       | `-H "X-API-Key: $KEY"`                                                                                                      |
| `basic_auth`      | `basicauth`     | `-u "$CONSUMER_USERNAME:$PASSWORD"`; the username is the **consumer** username, `nexus-user-<id>`                           |
| `jwt_auth`        | `jwt`           | `-H "Authorization: Bearer $JWT"`, an HS256 token signed with `jwt_secret` whose `sub` is `jwt_key` (the consumer username) |

The [client guide](guides/client-guide.md#calling-an-api) has full Basic and
JWT examples.

### Watch a revocation take effect

As the provider (or an admin), revoke the grant and call again:

```bash
GRANT_ID=$(curl -sS -b provider.txt 'http://127.0.0.1:8787/api/grants?status=active' \
            | jq -r '.items[0].id')

curl -sS -b provider.txt -X POST "http://127.0.0.1:8787/api/grants/$GRANT_ID/revoke" \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $PROVIDER_CSRF" \
  -d '{"reason":"Walkthrough demo."}' | jq -r '.grant.status'

curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/nexus/billing/invoices \
  -H "X-API-Key: $API_KEY"
# 403: the key still authenticates, but the ACL group is gone
```

`401` versus `403` is the whole model: **credentials authenticate, grants
authorize.**

---

## 10. Check the audit trail (as the super admin)

Every change you just made wrote an audit row.

In the browser: **Administration → Audit log**.

```bash
curl -sS -b admin.txt 'http://127.0.0.1:8787/api/admin/audit-logs?limit=10' \
  | jq -r '.items[] | "\(.created_at)  \(.actor.display_name // "-")  \(.action)  \(.target_type)"'
```

```
2026-08-31T09:41:02.882Z  Pat Provider  access.revoke        grant
2026-08-31T09:38:55.117Z  Cleo Client   credential.issue     credential
2026-08-31T09:37:20.004Z  Pat Provider  access.approve       access_request
2026-08-31T09:35:11.640Z  Cleo Client   access.request       access_request
2026-08-31T09:31:48.203Z  Pat Provider  api.publish          api
…
```

The full list of actions is in [`security.md`](security.md#10-audit-event-catalog).

---

## 11. Clean up

```bash
docker rm -f ferrum-edge echo
docker volume rm ferrum-data
rm -f admin.txt provider.txt client.txt billing-openapi.yaml
# for a clean Nexus database (the default SQLite file is server/data/nexus.sqlite):
rm -rf server/data/
```

---

## Where to go next

**Finish the setup** in **Administration → Settings**, as a super admin:

- **SMTP.** Until it is configured, every email waits in the outbox as
  `pending`. Configure it and use **Send test email**. See
  [`operations.md`](operations.md#6-the-email-outbox).
- **Registration policy.** Close self-service registration, restrict
  `allowed_roles`, or require email verification.
- **CAPTCHA.** Turnstile, hCaptcha or reCAPTCHA, if registration is open to
  the internet.
- **Branding.** Portal name, logo, colors and default theme.
- **A second `super_admin`.**

**Go deeper:**

| Guide                                                  | For                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| [`guides/client-guide.md`](guides/client-guide.md)     | API consumers: catalog, access requests, credentials, calling APIs        |
| [`guides/provider-guide.md`](guides/provider-guide.md) | API providers: publishing, spec updates, reviewing access, test consumers |
| [`guides/admin-guide.md`](guides/admin-guide.md)       | Portal admins: users, branding, email, mass email, audit, god mode        |
| [`api.md`](api.md)                                     | The complete REST reference                                               |
| [`architecture.md`](architecture.md)                   | Why it is built this way                                                  |
| [`operations.md`](operations.md)                       | Production deployment, backups, scaling, key rotation                     |
| [`security.md`](security.md)                           | Threat model, RBAC matrix, audit catalog                                  |

**Before production**, work through the
[hardening checklist](security.md#11-hardening-checklist) and read
[scaling](operations.md#8-scaling) for the single-writer limit before planning
more than one instance.
