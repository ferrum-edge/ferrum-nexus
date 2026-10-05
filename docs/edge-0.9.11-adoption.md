# Draft Edge v0.9.12 adoption

Nexus PR #522 remains DRAFT. The filename preserves existing links from the
v0.9.11 candidate. The current candidate selects published v0.9.12 artifacts;
it does not finalize a Nexus release, close GHSA-93rq-89vr-38pc Part B or approve
a public-only supported profile.

## Published identities

- [Edge v0.9.12](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.12)
  is published at immutable unsigned lightweight tag source
  `0d917701b63ef38210c49df830f48cf0457cbc7d`. The default Docker Hub
  multi-architecture index in [`release/compatibility.env`](../release/compatibility.env)
  is `sha256:80526b59cbbdc2bfcc8bae9241da4e5395414cf07bf0be4effd4c73c51684ee4`.
  Root recorded successful hosted release jobs and verified distribution facts:
  release assets and sidecars, image indexes/configurations, default gateway/CNI
  pairing, authenticated hosted cosign/SLSA/SPDX evidence and ABI. This consumer
  change does not claim independent cryptographic verification. Anonymous GHCR
  pulls returned 401; the selected public image is Docker Hub.
- [contracts-edge-0.9.12](https://github.com/ferrum-edge/ferrum-contracts/releases/tag/contracts-edge-0.9.12)
  was published on 2026-10-05 at immutable unsigned lightweight tag commit
  `31f0a21d707795be293d15837c2f77c3d84219d8`. Its protected merge tree
  `1b480bf3e14e33d8a013247d2a30406159b6c04b` equals reviewed source
  `d9c84810152732524c54a9ed292dc59103f0619d`. Selected vocabularies, egress
  schema/fixtures and both new deployment schemas/fixtures are copied byte for
  byte. `PIN` records all 46 adopted paths and hashes. `SERVICE-MANIFEST-PIN`
  remains separate; shared manifest v1 and unreleased Alloy owner flags stay
  unchanged. Historical publication-pending prose inside canonical assets stays
  byte-identical even though the canonical release is now published.
- The released owner OpenAPI SHA-256 is
  `f7242228d73d34ad2d7da3c989ec6ba15bb6ae1f2f4c94a8e0a181b000caae77`.
  Full gzip ApiSpec content, raw SQL/BSON evidence and original namespace tokens
  come from `GET /deployment-snapshot`, not ordinary resource views or backup.

## Consumer adoption and remaining gates

The candidate uses the actual [released partial deployment protocol](edge-conversion-recovery-blocker.md):
original strong deployment authority, conditional selected proxy removal and
API-spec replacement, encrypted evidence retained before HTTP, and explicit
commit/application acknowledgement before dependent recovery or journal removal.
It preserves the released credential-complete row verification and ordinary CRUD
contracts. Refused or uncertain operations do not refresh authority or fall back
to unconditional cleanup or namespace replacement.

The older v0.9.11 missing-owner-capability blocker is satisfied by the published
Edge and canonical releases. Nexus qualification is still pending: fresh exact-head
Node checks, four-store service contracts, protocol/format gates and packaged
acceptance against the selected image. Strict cancellation, audit, lease, cleanup,
original replay and concurrent Admin controls remain required. Static inspection
and integrity checks establish no hosted test or acceptance result.

The [controlled public-only fixture](../e2e/public-only/README.md) additionally
requires a packaged Nexus digest, hosted DNS-rebinding/zero-private-canary
qualification and an explicit supported-profile owner decision. Internal deployment
API adoption does not supply that decision or close advisory Part B. Private-opt-in
acceptance does not qualify public-only support.

Nexus version markers remain unchanged. The owner-approved unreleased Node range is
`^22.22.2 || ^24.15.0 || >=26.0.0`, adopted through #521; the candidate still requires
exact-head qualification of every declared minimum and current major. Historical
Nexus releases retain their published Node support facts.
Released migrations 001–006 and hashes are immutable; prepared 007–011 remain
unreleased. No Nexus tag, release or advisory completion is created here.
