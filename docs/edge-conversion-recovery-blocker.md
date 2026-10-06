# Draft conversion recovery: released dependency and pending qualification

PR #522 remains draft. The internal owner API dependency is now published in
[Edge v0.9.12](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.12),
source `0d917701b63ef38210c49df830f48cf0457cbc7d`, and canonical
[contracts-edge-0.9.12](https://github.com/ferrum-edge/ferrum-contracts/releases/tag/contracts-edge-0.9.12),
commit `31f0a21d707795be293d15837c2f77c3d84219d8`. Consumer qualification and
the CP/DP part of advisory Part B remain open. See the
[artifact identities and remaining gates](edge-0.9.11-adoption.md).

## Released authority

Admin-only `GET /deployment-snapshot` accepts no query and returns a no-store
secret-complete body with a matching HTTP ETag. The original quoted strong token
is exactly `"deployment-v1-<32 lowercase hexadecimal characters>"`. It is distinct
from backup namespace tokens and credential row tags. The complete response is
kept encrypted: typed and raw SQL/BSON resources, supported unknown fields and
associations, historical credentials, trust revisions/timestamps, full gzip specs
and frozen external references, namespace metadata and the change watermark.
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
unsupported atomic topology 501 and unavailable/uncertain application 503.
Primary protocol authority is the released
[owner documentation](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.12/docs/deployment_mutations.md)
and [implementation](https://github.com/ferrum-edge/ferrum-edge/blob/v0.9.12/src/admin/deployment_mutations.rs).

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

An unconfirmed mutation requires separate operator/root resolution and, where
applicable, downstream application qualification. Read-only investigation is safe;
automatic fresh-token replay or destructive cleanup is not. Namespace backup
restore remains an operator recovery contract and is never a conversion fallback.

## Qualification

The four Nexus adapter contracts exercise production service paths with the
released HTTP mock; it does not reproduce owner raw SQL/BSON internals. Packaged
acceptance tests real v0.9.12 conversion traffic, preservation of complete consumer/
trust/upstream evidence, stale original-token refusal and invalid conditional modes.
Exact-head hosted checks, native owner store coverage and actual packaged execution are
required before landing. Existing strict fault witnesses are retained; no future
capability mock, skip or advisory completion replaces those gates.
