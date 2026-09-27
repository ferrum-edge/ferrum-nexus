# Acceptance suite — the packaged portal against a real Ferrum Edge

Everything else in this repository tests Nexus against a **mock** Admin API. The mock can be made
to fail in ways a real gateway cannot, but it can only confirm that Nexus sent the configuration it
meant to send. It cannot tell you whether a real gateway would then let the request through.

This suite answers that question. It runs the **production container image** against a **pinned
Ferrum Edge release**, PostgreSQL, a deterministic upstream, and a real SMTP sink (Mailpit). Every
access assertion sends a request to the gateway's **data-plane listener** and checks whether it
reached the backend. The Admin API is called exactly once: to delete a proxy, the operator mistake
the restore test recovers from.

## Running it

```bash
./e2e/run.sh              # everything
./e2e/run.sh dataplane    # the gateway matrix only
./e2e/run.sh browser      # the portal journey only
E2E_KEEP=1 ./e2e/run.sh   # leave the stack up afterwards
```

The only accepted argument is `all` (the default), `dataplane`, or `browser`; anything else is
rejected before Docker starts.

You need Docker with `docker compose` (or `docker-compose`) and about 3 GB of free image space. By
default `run.sh` rebuilds the portal image from the current checkout (using Docker's build cache),
and Compose reuses or pulls the pinned Edge image. Set `NEXUS_IMAGE` to use a prebuilt image
instead, as CI does.

If `e2e/.env` does not exist, `run.sh` generates it with fresh random secrets. Nothing in this
directory ships a working secret, so none can leak into a real deployment.

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

## The two halves

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
