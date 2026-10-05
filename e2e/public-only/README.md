# Public-only DNS rebinding proposal fixture

**Hosted qualification pending; owner approval pending.** Owner authority is
published Edge `v0.9.12`, source `0d917701b63ef38210c49df830f48cf0457cbc7d`.
The candidate compatibility pin selects its default multi-architecture image
`ferrumedge/ferrum-edge:v0.9.12@sha256:80526b59cbbdc2bfcc8bae9241da4e5395414cf07bf0be4effd4c73c51684ee4`.
Canonical `contracts-edge-0.9.12` at `31f0a21d707795be293d15837c2f77c3d84219d8`
is published and adopted byte-for-byte. See [adoption facts](../../docs/edge-0.9.11-adoption.md).
Root must supply the packaged Nexus candidate digest and run this in hosted CI.
Publication establishes artifact identity; it does not attest this fixture or grant
public-only supported-profile approval. Edge #6010 capabilities are absent.

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

Keep logs as hosted artifacts; do not print session cookies or show-once credentials.
A missing capability is a failure, never a skip or mocked production pass. Successful
exact-image hosted evidence and explicit owner approval remain required before landing. This tests one operator-established Admin/traffic process pairing, not CPs,
load-balanced Admin endpoints, remote data planes, future process replacements or fleets.
