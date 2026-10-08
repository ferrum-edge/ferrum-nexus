# Conversion recovery: released protocol and replay limits

The internal owner API dependency was first published in Edge v0.9.12. Nexus
`v0.4.0` paired with
[Edge v0.9.13](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.13),
source `9b83115de7ec23ab51ec4feae6bed65e596db425`, and canonical
[contracts-edge-0.9.13](https://github.com/ferrum-edge/ferrum-contracts/releases/tag/contracts-edge-0.9.13),
commit `9626821eb089c71f5d4d71268c7b8276a8a5ab50`. Nexus `v0.5.0` and `v0.5.1` pair with
[Edge v0.9.14](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.14) and
`contracts-edge-0.9.14`, which keep this protocol and report a store failure before
commit as `durable` `not_started` or `not_committed` instead of `unknown`. See the
[artifact identities](edge-0.9.11-adoption.md). To resolve an
unconfirmed mutation, follow the
[operator runbook](operations.md#resolving-an-unconfirmed-gateway-deployment-mutation).

## Released authority

Admin-only `GET /deployment-snapshot` accepts no query and returns a no-store
secret-complete body with a matching HTTP ETag. The original quoted strong token
is exactly `"deployment-v1-<32 lowercase hexadecimal characters>"`. It is distinct
from backup namespace tokens and credential row tags. The complete response is
kept encrypted: typed and raw SQL/BSON resources, supported unknown fields and
associations, historical credentials, trust revisions/timestamps, spec metadata,
namespace metadata and the change watermark. From Edge v0.9.13 (snapshot v2), stored
gzip specs and frozen external references appear in the evidence and `api_specs` only
as `{sha256, len}` (raw SQL blobs likewise, MongoDB rows as `bson_sha256`); the
required `api_spec_contents` array carries one base64 copy of each, outside the
digested evidence. Nexus requires it, matches it to `api_specs` in order and verifies
each decoded value against its digest before using a stored document. The token MACs
the `deployment_snapshot.v2` domain, so every token Edge v0.9.12 issued answers `412`.
Open JSON envelope conformance cannot certify completeness or authorize replay
through a hypothetical full-snapshot mutation DTO.

The two released selected operations are:

- `DELETE /proxies/{id}?conditional=true&cleanup_orphaned_upstream=false`.
- `PUT /api-specs/{id}?conditional=true`, with an ordinary OpenAPI document.

Each sends exactly one original `If-Match` field. No duplicate/unknown query,
async application, weak/list/wildcard/row token, unconditional fallback or
namespace-restore-minus-target is used. The owner compares complete original
namespace evidence inside its entry/commit-fenced transaction on SQLite,
PostgreSQL, MySQL and MongoDB. Driver retries retain the original expected
representation. Invalid input is 400, stale authority 412, graph conflict 409,
unsupported atomic topology 501, unavailable/uncertain application 503, and a
namespace past the 64 MiB canonical bound 507 (`durable` `not_started` before the
transaction, `not_committed` inside it). Nexus treats only such a `507` as a definite
refusal; it keeps the journal and never retries it.
Primary protocol authority is the released
[owner documentation](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.13/docs/deployment_mutations.md)
and [implementation](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.13/src/admin/deployment_mutations.rs).

## Nexus recovery ordering

Conversion seals immutable original catalog/revision/proxy/spec/plugin resources
and intent audit before teardown. It captures complete owner authority only after
binding those resources to the intended target; corrected uploads change only the
authorized catalog comparison shape and revision identity. Each intended native
operation journals its original authority as pending before HTTP. A missing,
uncertain or refused acknowledgement retains that original and blocks overlapping
replay. No new token is fetched merely to make the refused operation pass.

Dependent cleanup and journal removal require HTTP 200, `profile=deployment-v1`,
the expected target id, `durable=committed`, `live=applied`, explicit
`recovery_cleanup_authorized=true` and the applicable local covering cursor.
A CP/unserved durable-only 200 (`live=not_applicable`, authorization false) is
insufficient. Wrong/missing fields, lost transport, cancellation and failed owner
audit/lease release retain the journal; the original owner task may still settle.
This proof does not attest every remote data plane.

Acknowledged staging resources are compared before their own operation authority
is recorded. Unknown or changed proxy/spec/plugin state refuses mutation. The
original replay data remains immutable through corrected catalog upload and staged
replacement. Agent enrollment precedes initial namespace-token capture; admitted
replacement/cutover does not repeat that consumer mutation. Existing API/proxy
leases, transaction fences, transactional audits, cancellation/drain and consumer
credential row verification remain in place. Final catalog mode, current revision,
ownership, completion audit and journal deletion share one Nexus transaction.
Failed missing-deployment cleanup also seals complete authority before conditional
removal; uncertainty preserves the attempted identity and `withdrawn: false`.

## Bounded replay limitations

A shared proxy-group owner or an association with fields Nexus cannot reconstruct
is refused. Initial conversion also refuses a stored frozen external-reference
snapshot that ordinary importer replay cannot preserve. Generated validator
resource/config fields are carried in an explicit original-id extension; only the
owner regenerates operation schemas. Recovery creation omits the informational
provisioner header so original labels, including an absent origin, survive replay.
Snapshot comparisons still include every label and timestamp. Unsupported
closed-body fields refuse the write rather than being discarded. These are
representability limits, not missing released conditional APIs. No full-snapshot
mutation acceptance or original timestamps are manufactured. Already retained
legacy journals without original replacement authority cannot authorize in-place
corrected replacement; unchanged original reconciliation remains read-only, and
separately absent identities may be rebuilt with newly acknowledged staging
authority. A present partial with no
acknowledged staging authority, including a lost create response, cannot acquire
cleanup permission from a fresh snapshot.

An unconfirmed mutation requires separate operator resolution and, where
applicable, downstream application checks. Read-only investigation is safe;
automatic fresh-token replay or destructive cleanup is not. Namespace backup
restore remains an operator recovery contract and is never a conversion fallback.

## Test coverage

The four Nexus adapter contracts exercise production service paths with the
released HTTP mock; it does not reproduce owner raw SQL/BSON internals. Packaged
acceptance tests real v0.9.13 conversion traffic, preservation of complete consumer/
trust/upstream evidence, stale original-token refusal and invalid conditional modes.
Owner-side store behaviour is covered by Edge's own native store tests, not by Nexus.
