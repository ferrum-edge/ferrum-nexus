# Getting started

A complete walkthrough: from an empty machine to a client calling a published
API through the gateway with a credential the portal issued.

You will play three roles in sequence — the operator who runs the stack, a
**provider** who publishes an API, and a **client** who requests access and
calls it. Allow about twenty minutes.

Everything here uses `curl` against the real routes, so you can follow along
without the SPA; the corresponding UI steps are noted as you go.

---

## 1. Prerequisites

- **Node.js 22.12+** — see [`.nvmrc`](../.nvmrc).
- **Docker**, for the Ferrum Edge gateway.
- `curl` and `jq` for the examples.

No database server is needed: Nexus defaults to SQLite.

---

## 2. Start a Ferrum Edge gateway

Nexus is a front end for a gateway, so the gateway comes first. The only thing
that has to match on both sides is the **admin JWT secret** (and, later, the
namespace).

The gateway image is distroless `nonroot` and runs as **UID 65532**, and it
bakes in no `/data` directory. A brand-new named volume is therefore root-owned,
so SQLite cannot create its database file and the container exits on startup.
Create the volume and hand it to that user first — this is a one-time step:

```bash
docker volume create ferrum-data
docker run --rm -v ferrum-data:/data alpine chown 65532:65532 /data
```

Then start the gateway:

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
  -e FERRUM_ADMIN_JWT_SECRET="$FERRUM_ADMIN_JWT_SECRET" \
  -e FERRUM_BASIC_AUTH_HMAC_SECRET="$FERRUM_BASIC_AUTH_HMAC_SECRET" \
  -e FERRUM_ADMIN_BIND_ADDRESS=0.0.0.0 \
  -e FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true \
  -v ferrum-data:/data \
  ferrumedge/ferrum-edge:latest run -m database
```

Two additions worth explaining before you move on:

- `--add-host=host.docker.internal:host-gateway` makes the hostname the
  walkthrough uses for the upstream resolve inside the container. Docker
  Desktop provides it anyway, so this is harmless there and **required** on
  plain Linux, where it does not exist by default.
- `FERRUM_BASIC_AUTH_HMAC_SECRET` (at least 32 bytes) is what the gateway hashes
  Basic-auth passwords with. Set it now: without it the gateway refuses to build
  the `basic_auth` plugin at all, so publishing a `basic_auth` API fails with a
  `400` from Edge. Nexus passes the gateway's own message through in
  `EDGE_ERROR.details.gateway_message`, which is where you will see it.

Two ports, and confusing them is the most common first-run mistake:

| Port   | What it is         | Who talks to it                         |
| ------ | ------------------ | --------------------------------------- |
| `9000` | **Admin API**      | the Nexus server only — never a browser |
| `8000` | **Proxy listener** | API clients calling published APIs      |

`FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true` is acceptable here because the Admin
API is bound to loopback on your machine. In production, put it behind TLS or
on a private network — see [`security.md`](security.md#9-ferrum-edge-admin-jwt-hygiene).

Check it is alive:

```bash
curl -sf http://127.0.0.1:8000/ >/dev/null && echo "proxy listener up"
```

> **If your gateway uses a different issuer**, note it now: Nexus stamps
> `iss: ferrum-edge` by default and the gateway rejects a mismatch. Set
> `FERRUM_ADMIN_JWT_ISSUER` in the next step to match.

---

## 3. Set up Ferrum Nexus

```bash
git clone https://github.com/ferrum-edge/ferrum-nexus.git
cd ferrum-nexus
npm install

cp .env.example .env
```

Edit `.env`:

```bash
NEXUS_SECRET_KEY=<paste `openssl rand -hex 32`>
FERRUM_ADMIN_URL=http://127.0.0.1:9000
FERRUM_ADMIN_JWT_SECRET=<the same value you exported in step 2>
FERRUM_NAMESPACE=nexus
NEXUS_PUBLIC_URL=http://127.0.0.1:5173

# Where the gateway's PROXY listener answers — not the Admin API, not the
# portal. The catalog shows each API's full invoke URL from this, so a client
# never has to guess the port. An admin can change it later in
# Settings → Gateway.
FERRUM_GATEWAY_PUBLIC_URL=http://127.0.0.1:8000

# Session cookies are `Secure` by default, which a browser will not store over
# plain http. This walkthrough is http-only, so say so; production keeps the
# default and serves the portal over https.
NEXUS_ENV=development

# Publishing refuses loopback, private-range and `.internal` upstreams unless
# this is set — the walkthrough's `host.docker.internal` upstream is one of
# them. Leave it unset (the default) anywhere the catalog is not fully trusted.
NEXUS_ALLOW_PRIVATE_UPSTREAMS=true

# Secret the very first registration must present to claim `super_admin`.
# Pinning it here means the walkthrough can paste one known value; leave it
# unset and the server generates one per process and prints it at startup.
NEXUS_BOOTSTRAP_TOKEN=walkthrough-bootstrap-token
```

Then:

```bash
npm run migrate   # also runs automatically at startup
npm run dev       # backend :8787, web :5173
```

> Run `npm run migrate` from the repo root, not
> `npm run migrate --workspace server`: the server imports
> `@ferrum-nexus/shared` from its build output, and only the root script builds
> that workspace first. On a clean clone the workspace-level script fails until
> you have run `npm run build --workspace shared` yourself.

Confirm both halves are talking:

```bash
curl -s http://127.0.0.1:8787/api/health | jq '{status, db: .database.status, edge: .edge.status}'
```

```json
{ "status": "ok", "db": "ok", "edge": "ok" }
```

`edge: "down"` (and an overall `degraded`) means Nexus cannot reach the Admin
API. Check `FERRUM_ADMIN_URL`, that the secret matches on both sides, and that
`FERRUM_ADMIN_JWT_ISSUER` matches the gateway's issuer.

---

## 4. First run: register the founding super admin

**The first account ever registered becomes `super_admin`**, regardless of the
role it asks for, and is automatically email-verified. That is how the platform
bootstraps — and why that one registration has to prove it comes from whoever
runs the server: it must carry the **bootstrap token**.

Where the token comes from:

- `NEXUS_BOOTSTRAP_TOKEN`, if you set it — as the step above does.
- Otherwise the server generates one per process and prints it at startup,
  but only while the user table is empty:

  ```
  FIRST-RUN BOOTSTRAP: this portal has no accounts yet.
  …
      2f6c1b0e…      ← the token
  ```

  It changes on every restart, and each instance prints its own, so pin
  `NEXUS_BOOTSTRAP_TOKEN` for anything running more than one process.

A registration against an empty portal without the right token is refused with
`403 FORBIDDEN` and creates nothing, so the token cannot be worn down by
guessing at it. Once any account exists the field is ignored entirely: replaying
it later just produces an ordinary `client`.

In the browser: open <http://127.0.0.1:5173>, click **Register**, fill the form
— it asks for the bootstrap token while the portal is empty.

Or with curl:

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

The response set the session cookies into `admin.txt`. Grab the CSRF token —
every mutation needs it echoed in a header:

```bash
ADMIN_CSRF=$(curl -sS -b admin.txt http://127.0.0.1:8787/api/auth/me | jq -r .csrf_token)
```

> Create a **second** `super_admin` before you go to production. The last active
> one cannot be demoted or disabled, which is a safety net, not a lock you want
> to be standing behind alone.

Now create the two accounts you will use for the rest of the walkthrough.
Register them the same way (`role: "provider"` and `role: "client"`), and keep
each one's cookie jar:

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

You need a backend for the gateway to forward to. Any HTTP service will do —
for the walkthrough, run a throwaway echo server:

```bash
docker run -d --name echo -p 8081:80 ealen/echo-server
```

Note the missing `127.0.0.1:` — the echo server is published on **all**
interfaces on purpose. The gateway reaches it from inside its own container via
the host's docker0/bridge address, which is not loopback, so a port published
only on `127.0.0.1` would be unreachable and every proxied call would fail to
connect. This opens port 8081 to your LAN for the length of the walkthrough;
step 11 removes the container.

Write a minimal OpenAPI 3.1 document. Nexus requires only `openapi` (3.x),
`info.title`, `info.version` and a `paths` object; it is a portal, not a spec
linter. The first **absolute** `servers[].url` becomes the upstream, so you do
not have to type it twice.

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

> `host.docker.internal` is how the gateway container reaches a service running
> on your host. Docker Desktop defines it for you; on plain Linux it only exists
> because of the `--add-host=host.docker.internal:host-gateway` flag in step 2.
> If you started the gateway without that flag, add it and recreate the
> container — or put both containers on one user-defined network
> (`docker network create demo`, `--network demo` on each) and use `http://echo`
> as the upstream instead.

In the browser: **My APIs → Publish an API**, paste the document, choose the
auth plugin, visibility and rate limit. The **Advanced** section is optional:
it restricts the HTTP methods the gateway accepts (the button fills it in from
the document you just pasted), sets backend timeouts, and turns on a circuit
breaker.

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

Four things just happened on the gateway, in one atomic-ish sequence that rolls
itself back if any step fails:

1. a proxy named `nexus-billing`, listening on **`/nexus/billing`**, forwarding
   to `http://host.docker.internal:8081`;
2. a `key_auth` plugin config;
3. an `access_control` plugin config allowing only
   `nexus:api:2b1c…:approved`, because `requestable: true`;
4. a `rate_limiting` plugin config, 1000 requests per 60 seconds **per
   consumer**.

> ⚠️ That quota is enforced **per gateway process**. One data-plane replica
> makes it exactly 1000/minute; N replicas make it N × 1000/minute, because
> Edge keeps the counters in memory unless the plugin config names a Redis
> endpoint. Set `FERRUM_RATE_LIMIT_SYNC_MODE=redis` and
> `FERRUM_RATE_LIMIT_REDIS_URL` on Nexus to share one counter across replicas;
> the change applies to rate limits saved after it. See
> [operations.md](operations.md#ferrum-edge-integration).

Save the id:

```bash
API_ID=$(curl -sS -b provider.txt 'http://127.0.0.1:8787/api/apis?mine=true' | jq -r '.items[0].id')
```

The listen path is always `/<namespace>/<slug>` — here `/nexus/billing`.

---

## 6. Request access (as the client)

The client browses the catalog and asks for access with a justification.

In the browser: **API catalog → Billing API → Request access**.

```bash
curl -sS -b client.txt 'http://127.0.0.1:8787/api/catalog?q=billing' \
  | jq '.items[] | {name, slug, requestable, access_state}'
```

```json
{ "name": "Billing API", "slug": "billing", "requestable": true, "access_state": "none" }
```

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

The provider gets an in-app notification immediately.

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

Under the hood: Cleo's Ferrum consumer (`nexus-user-<her id>`) is created if it
did not exist, the ACL group is added to it, and only then are the grant row and
the request status committed. If the gateway had failed, nothing would have been
committed and the request would still be `pending`, safe to approve again.

The client gets a notification and an `access_approved` email (queued in the
outbox — it stays `pending` until SMTP is configured, which is fine for now).

---

## 8. Issue a credential (as the client)

Approval grants _authorisation_. The client still needs a credential to
_authenticate_. The API uses `key_auth`, so the matching credential type is
`keyauth` — note the missing underscore; that asymmetry is Ferrum Edge's, and
the portal picks the right one for you in the UI.

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
> This is the only time it is ever shown. Nexus stores a SHA-256 fingerprint
> and the last four characters; Ferrum Edge redacts credential material on
> every read. Nobody — not you, not an admin, not the database — can recover
> it. If it is lost, rotate.

```bash
export API_KEY='nxs_pQ7v3H2s…'
```

---

## 9. Call the API through the gateway

The catalog page for the API shows the exact URL under **Call this API** —
that is what `FERRUM_GATEWAY_PUBLIC_URL` is for, and it is the same value the
`invoke_url` field carries on every API the API returns. For this walkthrough
it is `http://127.0.0.1:8000/nexus/billing`: the **proxy listener** (`:8000`)
followed by the listen path `/<namespace>/<slug>`.

Copy it from the portal, and call it with the key:

```bash
curl -sS -i http://127.0.0.1:8000/nexus/billing/invoices \
  -H "X-API-Key: $API_KEY"
```

A `200` means all four layers agreed: the proxy routed it, `key_auth`
authenticated the consumer, `access_control` found
`nexus:api:2b1c…:approved` in that consumer's groups, and `rate_limiting`
let it through.

Prove that the authorisation is real — drop the key:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/nexus/billing/invoices
# 401
```

The header depends on the API's auth plugin:

| API `auth_plugin` | Credential type | How to call                                                                                                                 |
| ----------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `key_auth`        | `keyauth`       | `-H "X-API-Key: $KEY"`                                                                                                      |
| `basic_auth`      | `basicauth`     | `-u "$CONSUMER_USERNAME:$PASSWORD"` — the username is the **consumer** username, `nexus-user-<id>`                          |
| `jwt_auth`        | `jwt`           | `-H "Authorization: Bearer $JWT"`, an HS256 token signed with `jwt_secret` whose `sub` is `jwt_key` (the consumer username) |

See [`guides/client-guide.md`](guides/client-guide.md#calling-an-api) for the
Basic and JWT recipes in full.

### Watch a revocation take effect

As the provider (or an admin), revoke the grant and try again:

```bash
GRANT_ID=$(curl -sS -b provider.txt 'http://127.0.0.1:8787/api/grants?status=active' \
            | jq -r '.items[0].id')

curl -sS -b provider.txt -X POST "http://127.0.0.1:8787/api/grants/$GRANT_ID/revoke" \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $PROVIDER_CSRF" \
  -d '{"reason":"Walkthrough demo."}' | jq -r '.grant.status'

curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/nexus/billing/invoices \
  -H "X-API-Key: $API_KEY"
# 403 — the credential still authenticates; the ACL group is gone
```

That `401` vs `403` distinction is the whole model in one line:
**credentials authenticate, grants authorise.**

---

## 10. Check the audit trail (as the super admin)

Every state change you just made left a row.

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

The full catalog is in [`security.md`](security.md#10-audit-event-catalog).

---

## 11. Clean up

```bash
docker rm -f ferrum-edge echo
docker volume rm ferrum-data
rm -f admin.txt provider.txt client.txt billing-openapi.yaml
# and, for a clean Nexus slate:
rm -rf data/
```

---

## Where to go next

**Finish the setup** (Administration → Settings, as a super admin):

- **SMTP** — until a host is set, every email sits in the outbox as `pending`.
  Configure it and hit **Send test email**. See
  [`operations.md`](operations.md#6-the-email-outbox).
- **Registration policy** — close self-service registration, restrict
  `allowed_roles`, or require email verification.
- **CAPTCHA** — Turnstile, hCaptcha or reCAPTCHA, if registration is open to
  the internet.
- **Branding** — portal name, logo, colours, default theme.
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

**For production**, do not stop here: work through the hardening checklist in
[`security.md`](security.md#11-hardening-checklist), and read the
single-writer caveat in [`operations.md`](operations.md#8-scaling) before you
plan a multi-instance deployment.
