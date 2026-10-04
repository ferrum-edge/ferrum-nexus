# Public-only DNS rebinding proposal fixture

**Unqualified.** Owner authority is Edge `c764084b3b51c3f7ffde268c039688d35e49c553`
(tag `v0.9.11`). Root must supply actual distribution-qualified Edge and packaged Nexus
image index digests, finish the canonical contract pin, and run this in hosted CI.
No current compatibility pin is changed. The existing pinned v0.9.10 acceptance image
does not establish support for the new policy/verification endpoints; the existing suite
also requires endpoint qualification before it can pass this candidate.

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
export `NEXUS_SECRET_KEY`, `NEXUS_BOOTSTRAP_TOKEN`, `FERRUM_ADMIN_JWT_SECRET`,
`FERRUM_EDGE_IMAGE` and `NEXUS_IMAGE`, and use a clean project/volume:

```sh
docker compose -f e2e/public-only/docker-compose.yml up -d --build controlled ferrum-edge nexus
docker compose -f e2e/public-only/docker-compose.yml run --build --rm probe
docker compose -f e2e/public-only/docker-compose.yml logs --no-color
docker compose -f e2e/public-only/docker-compose.yml down -v
```

Keep logs as hosted artifacts; do not print session cookies or show-once credentials.
A missing capability is a failure, never a skip or mocked production pass. Publication
facts and successful exact-image evidence must replace this unqualified status before
landing. This tests one operator-established Admin/traffic process pairing, not CPs,
load-balanced Admin endpoints, remote data planes, future process replacements or fleets.
