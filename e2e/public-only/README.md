# Public-only DNS rebinding fixture

This fixture runs against published Edge `v0.9.17`, source
`669c574c1d1e88e84dccb26a8159939e6694644d`, through the multi-architecture image
`ferrumedge/ferrum-edge:v0.9.17@sha256:f8942bed8d3b77c257d7266c9227450dd3d8c139759a07c47d060521a5fd41d1`
that the compatibility record pins for the next Nexus release. Canonical
`contracts-edge-0.9.17` at `f7ba1a9b9885900d1e110f76d38e37a02eda13c8` is adopted
byte-for-byte. See [adoption facts](../../docs/edge-0.9.11-adoption.md). It needs a
packaged Nexus image and runs on demand; it is not part of the required CI checks. The
fixture exercises the local data-plane profile, the only pairing Nexus grants the
public-only guarantee. It does not cover conversion custody, native-store
boundaries or recovery interleavings; the acceptance suite and store contracts
cover Nexus-side recovery, and Edge's own tests cover owner-side store behaviour.

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

To run it, generate fresh secrets (at least 32 characters),
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
A missing capability is a failure, never a skip or mocked production pass. This tests one
operator-established Admin/traffic process pairing, not CPs,
load-balanced Admin endpoints, remote data planes, future process replacements or fleets.
