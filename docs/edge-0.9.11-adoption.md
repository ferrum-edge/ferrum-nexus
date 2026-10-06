# Edge v0.9.13 adoption

Nexus `v0.4.0` pairs with published Edge v0.9.13 and `contracts-edge-0.9.13`. The
filename preserves existing links from the Edge v0.9.11 adoption; Nexus PR #522
adopted Edge v0.9.12, and PR #529 advanced the pin to Edge v0.9.13.
The public-only guarantee is granted only to a local data plane (see the
[topology decision](operations.md#backend-egress-admission-and-the-public-only-guarantee)).

## Published identities

- [Edge v0.9.13](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.13)
  was published on 2026-10-06 at tag source
  `9b83115de7ec23ab51ec4feae6bed65e596db425`, the merge of Edge #6026. The
  default Docker Hub multi-architecture index in
  [`release/compatibility.env`](../release/compatibility.env) is
  `sha256:6caa0987adb4c0a3a368fcd800bb0459cff3d3e219522e2e9c56280205862e50`; it
  resolves to
  `sha256:03822d924b7919d07a840baf757d016f2f05c8df8a8d0455a2eebae917aae2cc` on
  `linux/amd64` and
  `sha256:a628f8fc12c916793b96ba111c2bf4360ea84981b8bf766254b47c6140c02a80` on
  `linux/arm64`. Edge's release run published the release assets and checksum
  sidecars, the default, `-ebpf` and `-ebpf-tools` image indexes, and image
  signatures and attestations. Nexus does not independently verify those
  signatures.
- [contracts-edge-0.9.13](https://github.com/ferrum-edge/ferrum-contracts/releases/tag/contracts-edge-0.9.13)
  was published on 2026-10-06 at tag commit
  `9626821eb089c71f5d4d71268c7b8276a8a5ab50`, the merge of contracts #20, and
  reads every Edge-owned file at Edge `v0.9.13`. The vocabularies, the egress and
  deployment schemas (both majors of each) with their per-major fixtures, the
  acknowledgement schema and fixtures, and `fixtures/invalid-expectations.json`
  are copied byte for byte. `PIN` records all 96 adopted paths and hashes;
  `SERVICE-MANIFEST-PIN` moves to the same tag, and the shared manifest v1 schema
  and fixtures are byte-identical to `contracts-edge-0.9.12`.
- The released owner OpenAPI SHA-256 is
  `5f3e50e217b22b97d068490bdad9563ea450097a2daf7df4f80ff61f98559a81`.

## What changed for Nexus

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

Journals written by Nexus `v0.4.0` carry `authorityFormat: 2`: every deployment
snapshot they hold is Edge v0.9.13 authority. Journals written before carry no
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

[`release/compatibility.env`](../release/compatibility.env) pins the image above for
Nexus `v0.4.0`, and the packaged acceptance suite runs against it. The
[controlled public-only fixture](../e2e/public-only/README.md) runs a packaged Nexus
image against the same Edge release and covers the local data-plane profile only.

Nexus `v0.4.0` supports Node `^22.22.2 || ^24.15.0 || >=26.0.0` (adopted through
#521). It freezes migrations `007_outbox_recipient` to `011_mcp_tool_subsets`; this
Edge adoption itself adds no migration.
