# Draft Edge v0.9.11 adoption baseline

Nexus PR #522 remains DRAFT. This candidate selects published artifacts, but
does not finalize a Nexus release, declare GHSA-93rq-89vr-38pc fixed or grant
public-only supported-profile approval.

## Published identities

- [Edge v0.9.11](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.11)
  is published at immutable source `c764084b3b51c3f7ffde268c039688d35e49c553`.
  The default Docker Hub multi-architecture index selected in
  [`release/compatibility.env`](../release/compatibility.env) is
  `sha256:2476b502855940e28157858fc24008545cb3baeb3084c9610e1d4505cbe0d36e`.
  Root verified the published asset hashes, amd64/arm64 manifests and exact
  default-image gateway/CNI binary pairing. Authenticated hosted attestations
  qualified the GHCR distribution; anonymous GHCR pulls were not established,
  and published configs lack an image revision label.
- [contracts-edge-0.9.11](https://github.com/ferrum-edge/ferrum-contracts/releases/tag/contracts-edge-0.9.11)
  was published at `390edbd5b2485af0988e02f7827fde778d76ae0a` on 2026-10-04.
  Nexus copies vocabularies, the egress schema and fixtures, and the manifest
  schema and fixtures directly from that immutable tagged source. `PIN` and
  `SERVICE-MANIFEST-PIN` record the full commit and every adopted file hash.
  Historical prepared-publication and owner PROPOSED description text stays
  byte-identical. Current shared manifest v1 status is EXISTING/implemented;
  Alloy owner `81cbb410d34ff5fba1f3d54cfd2e7ebccaed397e` remains unreleased.

The egress endpoint and credential-complete verification are released in this
baseline. All response fields, mode/class arrays, evaluation order and conservative
guarantee semantics remain strict. Metadata is process-scoped: public-only
admission still requires the actual local serving data plane and operator-established
Admin/traffic identity. No missing-policy fallback or longer acceptance timeout is
introduced. Existing HTTP behavior, private opt-in and Node 22.14 support remain.

## Outstanding qualification and owner work

The previous exact-head packaged acceptance used v0.9.10, whose
`GET /backend-egress-policy` returned 404 and prevented portal health readiness.
The candidate now uses the real published v0.9.11 image. This fixes the artifact
selection; exact-head hosted acceptance must establish the runtime result.
The [controlled public-only fixture](../e2e/public-only/README.md) still requires
hosted qualification with a packaged Nexus digest and explicit owner approval.
It retains isolated controlled public DNS rebinding, real authenticated gateway
traffic, an observed private answer after DNS expiry, and the zero-request private
canary assertion. Private-opt-in acceptance cannot qualify public-only support.

[Edge #6010](https://github.com/ferrum-edge/ferrum-edge/issues/6010) is actionable
internal owner work for dependency-fenced cascade removal and API-spec replacement.
Neither exists in v0.9.11. Nexus refuses initial conversion teardown, live in-place
spec recovery and failed missing-deployment cleanup before destructive mutation.
It preserves original or attempted identity, exact operator fields, security
configs, upstreams and immutable encrypted conversion evidence. Read-only
reconciliation and absent-identity rebuilding remain available. See the
[adoption seam and required ordering](edge-conversion-recovery-blocker.md).

Automatic rollback and vanished-catalog cleanup expectations remain required
failing gates awaiting owner implementation; their mocks and assertions are not
weakened. #6010 needs owner review, exact-head hosted qualification, the next
immutable Edge release and canonical publication, then Nexus adoption and full
four-store/packaged qualification. This baseline claims no future capability or
future release identity.

Nexus version and migration release markers are unchanged. Released migrations
001–006 and their hashes remain immutable; prepared 007–011 remain unreleased.
New notes stay under Unreleased. Static inspection and integrity checks do not
establish hosted build, format, test or acceptance success.
