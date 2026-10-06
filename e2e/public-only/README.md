# Public-only DNS rebinding proposal fixture

**Hosted qualification pending.** Owner authority is
published Edge `v0.9.13`, source `9b83115de7ec23ab51ec4feae6bed65e596db425`.
The candidate compatibility pin selects its default multi-architecture image
`ferrumedge/ferrum-edge:v0.9.13@sha256:6caa0987adb4c0a3a368fcd800bb0459cff3d3e219522e2e9c56280205862e50`.
Canonical `contracts-edge-0.9.13` at `9626821eb089c71f5d4d71268c7b8276a8a5ab50`
is published and adopted byte-for-byte. See [adoption facts](../../docs/edge-0.9.11-adoption.md).
Root must supply the packaged Nexus candidate digest and run this in hosted CI.
Publication establishes artifact identity; it does not attest this fixture. The
fixture exercises the local data-plane profile, the only pairing Nexus grants the
public-only guarantee. The candidate adopts released selected
conditional removal and API-spec replacement: full original deployment authority
is durable before HTTP, and committed/applied acknowledgement with explicit cleanup
authorization is required before dependent recovery. Uncertain results retain the
encrypted journal and attempted identity without fresh-token retry or unconditional
cleanup. Large journals preserve complete evidence in authenticated encrypted chunks
committed atomically with their manifest. This DNS fixture does not qualify conversion
custody, native-store boundaries or every recovery interleaving; those require their
own exact-head hosted gates.

This stack is separate from the private-opt-in acceptance stack. It admits
`rebind.fixture.test` while DNS returns `11.203.0.10`, proves real authenticated
gateway traffic, switches to `10.203.0.10`, waits beyond the explicit DNS cache/stale
TTLs, observes a private answer delivered to Edge, and checks that the private canary
has received zero requests. Upstream responses close the socket, and the fixture
sets the Edge idle pool bound to zero. It does not infer refresh from a sampled check.

Both networks are Docker `internal` networks with no published ports. The address
`11.203.0.10` is classified public by the exact Edge v1 complement; it belongs only
to the controlled fixture container in this isolated network. No unrelated public
service, Internet DNS server or external canary is contacted. The fixture DNS server
has no forwarder and serves only this name. Use a hosted disposable runner without
overlapping networks. The network isolation also confines the ordinary provider's
initial Nexus DNS lookup.

Root's hosted qualification job must generate fresh secrets (at least 32 characters),
export `NEXUS_SECRET_KEY`, `NEXUS_BOOTSTRAP_TOKEN`, `FERRUM_ADMIN_JWT_SECRET`
and `NEXUS_IMAGE`, load `FERRUM_EDGE_IMAGE` from the compatibility record, and use a
clean project/volume:

```sh
set -a
. ./release/compatibility.env
set +a
docker compose -f e2e/public-only/docker-compose.yml up -d --build controlled ferrum-edge nexus
docker compose -f e2e/public-only/docker-compose.yml run --build --rm probe
docker compose -f e2e/public-only/docker-compose.yml logs --no-color
docker compose -f e2e/public-only/docker-compose.yml down -v
```

The probe first asserts, as the founding admin, that health reports
`public_egress_guaranteed: true`. After the rebind it requires Edge's coarse egress
refusal, HTTP `502` with `X-Gateway-Error: connection_failure`, while the controlled
DNS server has counted a private answer delivered to Edge and the canary has counted
nothing.

**Negative control.** Run the same stack once more, on a fresh project and volume,
with the enforcement turned off. The probe then requires the private canary to
receive the rebound request, proving the harness detects a leak:

```sh
export FIXTURE_EDGE_ALLOW_IPS=both
export FIXTURE_NEXUS_ALLOW_PRIVATE_UPSTREAMS=true
export FIXTURE_CONTROL_RUN=true
```

then repeat the commands above. A control run that does not observe the leak fails,
and so does an enforcing run that observes one.

Keep logs as hosted artifacts; do not print session cookies or show-once credentials.
A missing capability is a failure, never a skip or mocked production pass. Successful
exact-image hosted evidence and explicit owner approval remain required before landing. This tests one operator-established Admin/traffic process pairing, not CPs,
load-balanced Admin endpoints, remote data planes, future process replacements or fleets.
