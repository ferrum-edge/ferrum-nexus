# Edge v0.9.14 adoption

Nexus `v0.5.0` pairs with published Edge v0.9.14 and `contracts-edge-0.9.14`; Nexus
`v0.4.0` paired with Edge v0.9.13 and `contracts-edge-0.9.13`. The
filename preserves existing links from the Edge v0.9.11 adoption; Nexus PR #522
adopted Edge v0.9.12, PR #529 advanced the pin to Edge v0.9.13, and this adoption
advances it to Edge v0.9.14.
The public-only guarantee is granted to a local data plane, or to a control plane
whose data-plane attestation proves every expected data plane public-only (see the
[topology decision](operations.md#backend-egress-admission-and-the-public-only-guarantee)).

## Published identities

- [Edge v0.9.14](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.14)
  was published on 2026-10-07 at tag source
  `9bd4d5f9caa4ebe8f0ea13e76d8a6e2172eaca7d`, the merge of Edge #6050. The
  default Docker Hub multi-architecture index in
  [`release/compatibility.env`](../release/compatibility.env) is
  `sha256:15442f1b1d1758023fe871fe57be50f19caf34bbe6c499a6812f4ffd0da5e3f8`; it
  resolves to
  `sha256:12a8cd56090c0d4511bb3015b240e606b1b87989c644157566b8f6b6f635b3c2` on
  `linux/amd64` and
  `sha256:19d2886ed8c192cb0daba48ef0a27a0cd0526449dac74bf9438502322aabd9f2` on
  `linux/arm64`. Edge's release run published the release assets and checksum
  sidecars, the default, `-ebpf` and `-ebpf-tools` image indexes, and image
  signatures and attestations. Nexus does not independently verify those
  signatures.
- [contracts-edge-0.9.14](https://github.com/ferrum-edge/ferrum-contracts/releases/tag/contracts-edge-0.9.14)
  was published on 2026-10-08 at tag commit
  `ddbdd845733b7046c4393ac951011dafb774db33`, the merge of contracts #22, and
  reads every Edge-owned file at Edge `v0.9.14`. The vocabularies, the egress and
  deployment schemas (both majors of each) with their per-major fixtures, the
  acknowledgement schema and fixtures, and `fixtures/invalid-expectations.json`
  are copied byte for byte, including the 26 new `backend-egress-policy` v2
  attestation fixtures and the new `store-failure-not-committed` acknowledgement
  fixture. `PIN` records all 123 adopted paths and hashes; `SERVICE-MANIFEST-PIN`
  moves to the same tag, and the shared manifest v1 schema and fixtures are
  byte-identical to `contracts-edge-0.9.12`.
- The released owner OpenAPI SHA-256 is
  `6d286649ae744691e2eeb7d16607c538ca02e31bdeaafe98ab07fc861e7b9da4`.

## What changed for Nexus in Edge v0.9.14 (adopted by Nexus `v0.5.0`)

Edge v0.9.14 keeps every contract Nexus depends on: egress policy schema 2, deployment
snapshot v2 and its `deployment_snapshot.v2` tokens, and the acknowledgement shape
([Edge upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.14/docs/upgrade_guide.md#upgrading-to-0914)).

- **Control-plane data-plane attestation.** A control plane's
  `GET /backend-egress-policy` answer adds the optional `data_plane_attestation`
  object within schema 2. Nexus already read it (#538); the parser now also checks
  `connected_at` as an RFC 3339 `date-time`, which the canonical
  `entry-connected-at-without-offset` fixture requires, and every canonical v2
  fixture is tested for the verdict Nexus intends. A malformed or inconsistent
  attestation is still set aside and grants nothing.
- **Narrower `durable` outcomes.** A store failure before or inside the rolled-back
  mutation transaction now answers `503` with `durable` `not_started` or
  `not_committed`, not `unknown`. Nexus reports any acknowledgement with those values
  as `details.kind` `deployment_not_committed` (`502 EDGE_ERROR`); only
  `durable: "unknown"` stays `deployment_acknowledgement_uncertain`. Neither
  authorizes cleanup or replay, so the journal and its pending operation are kept as
  before.
- **Error classification.** Backend HTTP/2 resets are now `protocol_error` and
  charged to the target, and a buffered read timeout is `504`. Nexus does not map
  Edge's `error_class`; its per-API metrics count by status code, so some backend
  failures move from `502` to `504`.
- **ConfigSync revision 3.** The control plane and its data planes must run the
  same build. Nexus does not speak ConfigSync; it only reads the attestation the
  control plane reports.

## Edge v0.9.13 changes (adopted by Nexus `v0.4.0`)

Edge v0.9.13 changes two response contracts incompatibly and every snapshot token
([Edge upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.13/docs/upgrade_guide.md#upgrading-to-0913)):

- **Backend egress policy schema 2.** `public_only_guaranteed` is now true only with
  `enforcement_scope=local-data-plane`. Nexus reads schema 2 only and refuses schema
  1 (Edge v0.9.12 and earlier) under `unsupported_egress_policy_schema`, so Nexus
  `v0.4.0` pairs with Edge v0.9.13 only. The guarantee rule is unchanged: Nexus
  still requires `local-data-plane` explicitly together with
  `public_only_guaranteed=true`. `NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS=true` still
  requires `public_only_guaranteed=true` and is never relaxed to the policy-only
  reading schema 1 reported. Against Edge v0.9.13 it therefore admits no pairing
  the public profile refuses: a control plane now reports `false`, so a CP/DP
  pairing has no writes unless the operator sets `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`
  (see [the compatibility notes](operations.md#backend-egress-admission-and-the-public-only-guarantee)).
- **Deployment snapshot v2.** `GET /deployment-snapshot` carries stored spec
  documents and external-reference snapshots as `{sha256, len}` in the evidence and
  in `api_specs` (sorted by id and equal to `evidence.resources[5]`), raw SQL blobs
  as `{sha256, len}` and MongoDB rows with `bson_sha256`. The required
  `api_spec_contents` array carries one standard padded base64 copy of each stored
  document. Nexus requires that array, checks that it names every spec in order,
  and verifies each decoded value against the digest the token fences before it
  uses a stored document. `GET /api-specs/{id}` is never a substitute.
- **Snapshot tokens.** Deployment tokens now MAC the `deployment_snapshot.v2`
  domain. Every token issued by Edge v0.9.12 or earlier keeps its syntax but fails
  with `412`. Nexus never retries a refused operation with a fresh token: the
  journal and its pending operation are kept for operator resolution.
- **`507 Insufficient Storage`.** A namespace whose canonical representation would
  exceed 64 MiB (spec bytes excluded), or whose `api_spec_contents` would exceed
  256 MiB, is refused on the snapshot read and on both conditional mutations. Nexus
  treats a `507` whose acknowledgement reports `durable` `not_started` or
  `not_committed` as a definite refusal (`409 CONFLICT`, `details.kind`
  `namespace_snapshot_too_large`): no authority was issued and nothing was applied.
  It is deterministic for unchanged state, so it is never retried, and any journal
  is kept. Any other `507` body stays an unconfirmed result.

## Recovery journals

Journals written by Nexus `v0.4.0` and later carry `authorityFormat: 2`: every
deployment snapshot they hold is authority in the Edge v0.9.13 format, which Edge
v0.9.14 keeps. Journals written before carry no
marker and may hold Edge v0.9.12 authority (inline spec bytes, no
`api_spec_contents`). They remain readable, so custody checks, inspection and key
rotation keep working, and a journal whose recorded operations are all
acknowledged and whose live deployment already matches the catalog still completes
by observation. Anything that would use the older authority (a conditional
mutation, a stored-document comparison or deletion custody) is refused with
`409 CONFLICT`, `details.kind` `legacy_deployment_authority`, before any request
is sent. Settle conversions and restores before upgrading Edge; see the
[upgrade procedure](operations.md#upgrading-to-edge-v0913).

## Release status

[`release/compatibility.env`](../release/compatibility.env) pins the Edge v0.9.14 image
above for Nexus `v0.5.0`, and the packaged acceptance suite runs against it. The record
at the `v0.4.0` tag pins Edge v0.9.13. The
[controlled public-only fixture](../e2e/public-only/README.md) runs a packaged Nexus
image against the same Edge release on demand, outside CI, and covers the local
data-plane profile only.

Nexus supports Node `^22.22.2 || ^24.15.0 || >=26.0.0` since `v0.4.0` (adopted through
#521). `v0.4.0` froze migrations `007_outbox_recipient` to `011_mcp_tool_subsets`, and
`v0.5.0` froze `012_access_request_grant`; neither Edge adoption adds a migration.
