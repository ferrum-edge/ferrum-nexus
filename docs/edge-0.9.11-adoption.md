# Edge v0.9.15 adoption

`main` pairs with published Edge v0.9.15 and `contracts-edge-0.9.15` for the next Nexus
release. Nexus `v0.5.0` and `v0.5.1` pair with Edge v0.9.14 and `contracts-edge-0.9.14`,
and Nexus `v0.4.0` paired with Edge v0.9.13 and `contracts-edge-0.9.13`. The
filename preserves existing links from the Edge v0.9.11 adoption; Nexus PR #522
adopted Edge v0.9.12, PR #529 advanced the pin to Edge v0.9.13, PR #542 to Edge
v0.9.14, and this adoption advances it to Edge v0.9.15.
The public-only guarantee is granted to a local data plane, or to a control plane
whose data-plane attestation proves every expected data plane public-only (see the
[topology decision](operations.md#backend-egress-admission-and-the-public-only-guarantee)).

## Published identities

- [Edge v0.9.15](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.15)
  was published on 2026-10-08 at tag source
  `25b37395ff61bfea0f3ffd189d9011c4984fa755`, the merge of Edge #6103. The
  default Docker Hub multi-architecture index in
  [`release/compatibility.env`](../release/compatibility.env) is
  `sha256:29b468dfeea13b1ecaac8dfbc7e019f310e71e647611d43800a1dc64436eaca3`; it
  resolves to
  `sha256:0404dc6d70d67abb70feea4e5aa295fdb1c19a0968900f467fc4b908528d19d1` on
  `linux/amd64` and
  `sha256:51b8134770441b3ad340ba87ca9acd8a03fd864315c54d79911b27d95437c91a` on
  `linux/arm64`. Edge's release run published the release assets and checksum
  sidecars and the default and `-ebpf` image indexes. Nexus does not independently
  verify image signatures or attestations.
- [contracts-edge-0.9.15](https://github.com/ferrum-edge/ferrum-contracts/releases/tag/contracts-edge-0.9.15)
  was published on 2026-10-08 at tag commit
  `6fb64c5dc2e014204c17609fc717d976f3b4589e`, the merge of contracts #23, and
  reads every Edge-owned file at Edge `v0.9.15`. No contract gets a new major and no
  schema changes its wire rules. The five vocabularies, the egress v2, deployment
  snapshot v2 and acknowledgement schemas change only in provenance, descriptions and
  vocabulary entries, and `fixtures/invalid-expectations.json` only in other
  contracts' entries. All are copied byte for byte; every other vendored fixture is
  unchanged. `PIN` still records 123
  adopted paths and hashes; `SERVICE-MANIFEST-PIN` moves to the same tag, and the
  shared manifest v1 schema and fixtures are byte-identical to
  `contracts-edge-0.9.12`.
- The released owner OpenAPI SHA-256 is
  `f6c7d8b1d247060c4d0ae66e5c149ad3d76721addb8176eff45b6fc3d1b4d6b2`.
- Nexus `v0.5.0` and `v0.5.1` pin
  [Edge v0.9.14](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.14), tag
  source `9bd4d5f9caa4ebe8f0ea13e76d8a6e2172eaca7d`, index
  `sha256:15442f1b1d1758023fe871fe57be50f19caf34bbe6c499a6812f4ffd0da5e3f8`, with
  `contracts-edge-0.9.14` at `ddbdd845733b7046c4393ac951011dafb774db33` (owner
  OpenAPI SHA-256 `6d286649ae744691e2eeb7d16607c538ca02e31bdeaafe98ab07fc861e7b9da4`).

## What changed for Nexus in Edge v0.9.15

Edge v0.9.15 is a security release. It keeps every contract Nexus depends on: egress
policy schema 2 and its data-plane attestation, deployment snapshot v2 and its
`deployment_snapshot.v2` tokens, and the acknowledgement shape; the ConfigSync
protocol revision stays `3`
([Edge upgrade guide](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.15/docs/upgrade_guide.md#upgrading-to-0915)).
The full review is in
[Upgrading to Edge v0.9.15](operations.md#upgrading-to-edge-v0915); in short:

- **External identity header** (Edge #6088). `X-Consumer-Username` carries only a
  mapped Consumer, and `X-Authenticated-Identity` is new and gateway-owned. Every
  Nexus caller is a mapped Consumer, so backends see no change. Nexus now refuses
  `X-Authenticated-Identity` as a palette `correlation_id` or
  `request_deduplication` `header_name`, as Edge does, and the mock gateway models
  the same refusal. Nexus writes no LDAP config, so the removed `consumer_mapping`
  does not affect it.
- **Protocol flavor admission** (Edge #6090). A native gRPC or WebSocket request is
  refused with `403` (`route_protocol_admission`) when the route's HTTP view runs an
  authentication or admission plugin its flavor view omits. On Nexus proxies that is
  `routes` spec enforcement, agent APIs and idempotency keys with
  `enforce_required`; the palette help and provider guide say so.
- **Plugin-config limits** (Edge #6079). `rate_limiting` adds `ipv6_prefix`, which
  Nexus never sets (its quotas count by Consumer), and `mcp_gateway` caps aggregate
  sessions at 128 per principal by default, which Nexus keeps. The mock gateway
  accepts `ipv6_prefix` from `1` to `128` only.
- **Plugin-secret environment references** (Edge #6089), **namespace-bound TLS
  references** (Edge #6094) and **ConfigSync admission** (Edge #6078). Nexus writes
  no environment reference or `backend_tls_*` field, mints `admin` Admin JWTs only,
  and never calls the control plane's gRPC API.

## Edge v0.9.14 changes (adopted by Nexus `v0.5.0`)

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
v0.9.14 and v0.9.15 keep. Journals written before carry no
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

[`release/compatibility.env`](../release/compatibility.env) on `main` pins the Edge
v0.9.15 image above for the next Nexus release, and the packaged acceptance suite runs
against it. The record at the `v0.5.1` and `v0.5.0` tags pins Edge v0.9.14, and at the
`v0.4.0` tag Edge v0.9.13. The
[controlled public-only fixture](../e2e/public-only/README.md) runs a packaged Nexus
image against the same Edge release on demand, outside CI, and covers the local
data-plane profile only.

Nexus supports Node `^22.22.2 || ^24.15.0 || >=26.0.0` since `v0.4.0` (adopted through
#521). `v0.4.0` froze migrations `007_outbox_recipient` to `011_mcp_tool_subsets`,
`v0.5.0` froze `012_access_request_grant`, and `v0.5.1` froze
`013_account_recovery_jobs`; no Edge adoption adds a migration.
