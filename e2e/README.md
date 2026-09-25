# Acceptance suite — the packaged portal against a real Ferrum Edge

Everything else in this repository tests Nexus against a **mock** Admin API.
That mock is valuable — it can be made to fail in ways a real gateway cannot be
asked to on demand — but it can only ever confirm that Nexus sent the
configuration it meant to send. It cannot tell you whether a real gateway would
then let the request through.

This suite answers that question, and only that question. It runs the
**production container image** against a **pinned Ferrum Edge release**,
PostgreSQL, a deterministic upstream and a real SMTP sink, and every assertion
about access is made by sending a request to the gateway's **data-plane
listener** and seeing whether it reached the backend. The Admin API is
consulted exactly once, to delete a proxy — the operator mistake the restore
test exists to recover from.

## Running it

```bash
./e2e/run.sh              # the whole thing
./e2e/run.sh dataplane    # the gateway matrix only
./e2e/run.sh browser      # the portal journey only
E2E_KEEP=1 ./e2e/run.sh   # leave the stack up afterwards
```

It needs Docker with `docker compose` (or `docker-compose`), and about 3 GB of
free image space. The default local path rebuilds the portal from the current
checkout on every run, using Docker's build cache, and Compose reuses or pulls
the pinned Edge image as needed. CI can pass `NEXUS_IMAGE` to use the image it
already built.

`run.sh` generates `e2e/.env` with fresh per-run secrets if there is not one
already. Nothing in this directory ships a working secret: a compose file with
one in it is a secret that ends up in somebody's real deployment. The runner
accepts only `all`, `dataplane`, or `browser` as its optional argument and
rejects extra arguments before creating the environment or starting Docker.

Every run starts from empty volumes. `run.sh` bootstraps the portal once —
registering the first account with the bootstrap token and turning email
verification on — and both suites then sign in as it. That is deliberate: only
the _first_ registration becomes `super_admin`, so two suites sharing one stack
cannot each claim it. The bootstrap is idempotent, so re-running against a
stack left up with `E2E_KEEP=1` works.

## What is pinned, and why

`FERRUM_EDGE_IMAGE` names a release **by digest**. A suite whose whole claim is
"the portal agrees with a real gateway" has to name the gateway build it agreed
with, and a tag can be re-pointed where a digest cannot. The
[compatibility record](../release/compatibility.env) is the only place it is
written. The runner uses that pin on every run, even when a generated `.env`
already exists. An exported `FERRUM_EDGE_IMAGE` takes precedence for an
intentional override. Moving to a newer Edge is a deliberate one-line edit
there, and the diff says which release the guarantee now covers. Each run logs
the Nexus image ID and the Edge image ID and repository digest actually used.

## The two halves

**`src/dataplane.test.ts`** — what the gateway permits:

- API-key, Basic and JWT authentication, each denied before approval and
  serving after it, with the credential's onward journey to the backend pinned
  (the API key and the basic-auth header are stripped; the bearer token is
  not — that asymmetry is Edge's `jwt_auth` default, and the test states it
  rather than asserting a uniform rule that is not true);
- `routes` enforcement refusing an undeclared path, and `docs_only` forwarding
  it, so the two modes stay honestly different;
- revocation taking access away while the credential still authenticates —
  they are different things, and conflating them is how a portal revokes the
  wrong one;
- rotation: the replacement works, the retired secret stops;
- a browser preflight answered from the configured CORS policy, and an origin
  outside it not echoed back;
- both services restarted, and everything still working from persisted state;
- an API whose proxy an operator deleted, restored in place: the same client,
  with the credential it already had, at the same address — and an unapproved
  account still refused;
- the Nexus database and the Edge database backed up together, both lost, and
  both restored from that backup (the runbook in `docs/operations.md` §5): an
  approved client's pre-backup credential is served through the restored pair,
  and a client whose grant was revoked before the backup is still refused.

**`src/journey.spec.ts`** — what a person can do, in a real browser: register,
verify by following the link out of a real email, sign in, find the API, read
its **rendered** documentation, request access, and see the provider's approval
land.

The browser test deliberately stops before issuing a credential and calling the
gateway. The data-plane suite already proves that end; doing it twice would
make the journey slower without making it say more.

## Artifacts

`run.sh` writes container logs for every service to `e2e/artifacts/`, and
Playwright writes a trace and a screenshot for a failed step to the same place,
so one upload has everything a failure needs. The logs carry request lines and
gateway decisions; they do not carry credentials, which are show-once in
responses and never logged.

## Adding a case

Put portal setup in `src/fixtures.ts` and assertions in the suite. Anything
that arranges state should do it through the portal's **public API** — if a
test has to reach around the product to set something up, the setup is part of
what is being tested and the assertion is worth less than it looks.
