# Acceptance suite — the packaged portal against a real Ferrum Edge

Everything else in this repository tests Nexus against a **mock** Admin API. The mock can be made
to fail in ways a real gateway cannot, but it can only confirm that Nexus sent the configuration it
meant to send. It cannot tell you whether a real gateway would then let the request through.

This suite answers that question. It runs the **production container image** against a **pinned
Ferrum Edge release**, PostgreSQL, a deterministic upstream, a real SMTP sink (Mailpit), and a real
OpenID Connect provider (Dex). Every access assertion sends a request to the gateway's
**data-plane listener** and checks whether it reached the backend. The Admin API is called exactly
once: to delete a proxy, the operator mistake the restore test recovers from.

## Running it

```bash
./e2e/run.sh              # everything
./e2e/run.sh dataplane    # the gateway matrix only
./e2e/run.sh sso          # single sign-on through Dex only
./e2e/run.sh browser      # the portal journey only
E2E_KEEP=1 ./e2e/run.sh   # leave the stack up afterwards
```

The only accepted argument is `all` (the default), `dataplane`, `sso`, or `browser`; anything else
is rejected before Docker starts.

You need Docker with `docker compose` (or `docker-compose`) and about 3 GB of free image space. By
default `run.sh` rebuilds the portal image from the current checkout (using Docker's build cache),
and Compose reuses or pulls the pinned Edge image. Set `NEXUS_IMAGE` to use a prebuilt image
instead, as CI does.

If `e2e/.env` does not exist, `run.sh` generates it with fresh random secrets and mode `0600`.
Existing files are changed to mode `0600` before they are read, and symlinks are refused. The file
is parsed as data: empty lines and comments are allowed, and other lines must be unique, allowlisted
`KEY=VALUE` records. Whitespace-only lines are rejected. Values may contain only letters, digits,
and `.`, `_`, `:`, `/`, `@`, `+`, `=`, or `-`; shell syntax, quotes, whitespace, and unknown keys
are rejected. The Edge image entry remains accepted for compatibility with older local files, but
the runner always uses the current pin from the compatibility record unless `FERRUM_EDGE_IMAGE` is
exported in the environment.

Nothing in this directory ships a working secret, so none can leak into a real deployment.

`run.sh` bootstraps the portal once, before either suite: it registers the first account with the
bootstrap token and turns email verification on. Both suites then sign in as that account, because
only the founding registration becomes `super_admin`. The bootstrap is idempotent, so re-running
against a stack kept with `E2E_KEEP=1` works. Without `E2E_KEEP`, the stack and its volumes are
removed at the end of the run.

## What is pinned, and why

`FERRUM_EDGE_IMAGE` names the Edge release **by digest**: a suite that claims "the portal agrees
with a real gateway" has to name the exact gateway build, and a tag can be re-pointed. The pin
lives only in the [compatibility record](../release/compatibility.env), which the runner reads on
every run, even when `e2e/.env` already exists. Export `FERRUM_EDGE_IMAGE` to test a different
image. Moving to a newer Edge is a one-line edit to the compatibility record.

Each run logs the Nexus image ID, and the Edge image ID and repository digest, that it actually
used.

Dex is pinned by digest in [`docker-compose.yml`](docker-compose.yml), with its release tag
alongside. Its configuration is [`dex/config.yaml`](dex/config.yaml): in-memory storage, one static
client, and two static password users, one in the `nexus-providers` group.

## The three parts

**`src/dataplane.test.ts`** — what the gateway permits:

- API-key, Basic, and JWT authentication: each denied before approval and served after it. The test
  also pins what reaches the backend: the API key and the basic-auth header are stripped; the
  bearer token is forwarded (Edge's `jwt_auth` cannot hide it).
- `routes` enforcement refuses an undeclared path; `docs_only` forwards it.
- Revocation removes access while the credential still authenticates (the gateway answers `403`,
  not `401`).
- Rotation: the replacement works, and the retired credential stops working.
- A browser preflight is answered from the configured CORS policy; an origin outside it is not
  echoed back.
- After restarting both services, everything still works from persisted state.
- An API whose proxy an operator deleted is restored in place: the same client, with the credential
  it already had, at the same address. An unapproved account is still refused.
- The Nexus and Edge databases are backed up together, both lost, and both restored from that
  backup ([runbook](../docs/operations.md#5-backup-and-restore)). An approved client's pre-backup
  credential still works, and a client revoked before the backup is still refused.

**`src/sso.test.ts`** — single sign-on through a real OpenID Connect provider. An HTTP client that
keeps cookies starts at `GET /api/auth/sso/dex/start`, follows the portal's redirect to Dex, submits
Dex's own login form, follows Dex back to the portal's callback, and then reads the session it got:

- The authorization request carries a PKCE `S256` challenge, `state` and `nonce`. Dex redeems the
  code only with the matching verifier, so a completed sign-in proves PKCE end to end. The nonce
  round-trips through Dex into the ID token; the portal's refusal of a mismatched one is covered by
  `server/src/sso/oidc.test.ts`.
- Dex's `groups` claim maps the account to `provider`; a user in no mapped group gets `client`. A
  second sign-in opens the same account, matched by the linked subject.
- A callback with a tampered `state` is refused (`/login?sso_error=invalid_state`) and opens no
  session, and the genuine callback cannot be replayed afterwards.

The issuer is `http://127.0.0.1:5556/dex`. The portal accepts a plain-HTTP issuer only on a literal
loopback host and only with `NEXUS_OIDC_ALLOW_HTTP_LOOPBACK=true`, so the stack sets that flag and
runs the portal in Dex's network namespace, where `127.0.0.1` is Dex for the portal as well as for
the test runner. That is why the portal's port is published on the `dex` service.
`NEXUS_OIDC_ALLOW_PRIVATE_ADDRESSES` stays off: the loopback flag is all a local provider needs.

**`src/journey.spec.ts`** — what a person can do, in a real browser (Playwright): register, verify
by following the link in a real email, sign in, find the API, read its **rendered** documentation,
request access, and see the provider's approval land.

The browser test stops before issuing a credential and calling the gateway. The data-plane suite
already covers that.

## Artifacts

`run.sh` writes each service's container logs to `e2e/artifacts/`. Playwright writes a trace and a
screenshot for a failed step to the same place, so one upload has everything a failure needs. The
logs carry request lines and gateway decisions, but not credentials: those are show-once in
responses and never logged.

## Adding a case

Put portal setup in `src/fixtures.ts` and assertions in the suite. Arrange state through the
portal's **public API**. If a test has to reach around the product to set something up, that setup
is part of what is being tested, and the assertion is worth less than it looks.

## MCP subsets and proposed manifest preview

The packaged-image data-plane suite extends the pinned v0.9.10 qualification with
API-key/basic-account and JWT-application subset list/call cases. Approval cannot
broaden the request; unapproved tools are hidden and denied while REST remains usable.
Explicit empty and omitted subsets, rename/re-add, changed spec, disable/re-enable,
revocation and deletion are exercised through production portal routes. Actual
PostgreSQL triggers force grant and policy persistence failures after Edge mutations;
compensation is asserted through the live listener and full upstream snapshots.
The independent account/application tool-call budget proof uses read-tool subsets.

A proposed service-manifest preview case runs against the packaged schema asset,
checks namespace/null rejection and redaction, and proves no request reaches the
upstream for declared references. Contract fixture/integrity checks run in the server
suite. These are hosted CI gates; adding cases does not claim they have passed.
