# Draft conversion recovery: required owner capability

PR #522 remains draft. This source repair does not qualify the public-only
proposal or declare an advisory fixed. The candidate adopts the published
[Edge v0.9.11 baseline](edge-0.9.11-adoption.md), which lacks these owner fences.

## Released source evidence

The authority is immutable Edge
[`c764084b3b51c3f7ffde268c039688d35e49c553`](https://github.com/ferrum-edge/ferrum-edge/tree/c764084b3b51c3f7ffde268c039688d35e49c553).
A proxy row `If-Match` compares that row, not the complete spec/plugin cascade.
Separate reads and a Nexus lease cannot serialize external Admin writers.

The coherent `GET /backup?conditional=true` and namespace `If-Match` on
`POST /restore?confirm=true` atomically fence namespace replacement. They cannot
express the required field-preserving partial removal:

- `src/admin/mod.rs:6600` unconditionally assigns a new `updated_at` to every
  imported proxy, consumer, plugin config and upstream. Preparation invokes it
  at line 10688, including conditional restore.
- The same handler normalizes the complete candidate before import (line 10405)
  and prepares historical credentials again. A raw conditional backup is not a
  promise that every historical field round-trips unchanged.
- Trust restore advances existing server-owned revisions/timestamps; see
  `src/admin/mod.rs:6967` and `docs/admin_backup_restore.md`.

Replaying the original namespace body minus one proxy graph would therefore
modify unrelated resources and fields. Reading them again after the write cannot
repair this guarantee. Nexus does not call namespace restore, invent a supported
endpoint, refresh a rejected token, or fall back to unconditional partial deletion.

## Current behavior

Conversion records its original catalog shape, proxy, plugins and specification
in encrypted settings and marks repair before teardown. It retains the record
through staging, cutover and catalog commit. Ordinary PATCH compensation retains
its existing field ownership. Corrected agent uploads authorize only the new
catalog comparison shape; the original replay resources remain immutable.

Recovery can reconcile an unchanged deployment read-only or rebuild an absent
`docs_only` identity. An absent `routes` identity can be replayed onto staging,
but recovery refuses both a corrected API-spec replacement and the spec-owned
listen-path cutover. The acknowledged staging resources and encrypted attempt
remain intact, and failure records `withdrawn: false` without completion or journal
deletion. A concurrent Admin hosts edit after either fresh proxy read survives.
Ordinary publication and missing-deployment restore keep their released cutover;
the refusal is scoped to conversion recovery.

Recovery also refuses in-place API-spec replacement after a matching baseline
read: the importer does not compare an original namespace token inside its write.
Initial conversion refuses before proxy deletion, preserving the original identity
and all proxy/spec/plugin fields, upstreams and encrypted replay resources. The
refusal records repair-required state without invoking rollback or clearing the
journal. A deliberate read-only reconciliation can subsequently clear a matching
original; a corrected catalog requiring a live spec replacement cannot.
Only exact current observations of the original proxy, every plugin body and
specification document, together with the original catalog deployment shape and
revision identity, qualify `api.gateway_conversion_rollback`. The event and the
normal `api.gateway_restore` commit with catalog/ownership and journal deletion
in the existing lease-fenced transaction. Failure of either audit preserves those
rows and the journal; failed-restore repair bookkeeping remains allowed. Corrected
revisions, older journals without revision identity, staging and rebuilds do not
qualify. These separate observations do not assert atomic Edge CAS or fence an
external Admin writer.

Live partial cleanup and failed missing-deployment restore cleanup also refuse
before any cascade. A failed restore retains its attempted proxy id, every plugin
and operator field, and records `withdrawn: false` with the failure audit and repair
state. It never deletes security configs from a retained proxy. No proxy row token,
separate read, longer timeout or namespace replacement supplies the missing fence.

This refusal also blocks automatic rollback of a successful conversion when
catalog completion fails. If the catalog row disappeared, Nexus cannot safely
remove the remaining partial proxy graph with the released contract. The existing
`publishing-lifecycle.test.ts` expectation that no live orphan remains is retained;
its fault injection still targets catalog completion, after the new repair-state
write. That expectation is an unresolved owner capability gate, not a passing
qualification claim. Existing rollback tests that require removing a live partial
have the same blocker. Staging-policy/interruption, post-deletion compensation and
corrected agent replay/completion expectations also remain owner-API-dependent
gates. They are not weakened or skipped to qualify this refusal repair.

## Bounded Nexus runtime repairs and remaining gates

The assessment at `3fa76fcc91a7ee483367de9bb4b1671b0a984960` identified five
independently actionable defects. The super-admin fixture now permits cancellation
wrappers without changing its separate-instance lease topology. Catalog faults
and neighboring transaction interpositions have suite-owned unconditional
restoration and catalog faults require an intended-call witness. Lifecycle races
own both operations, observe early request completion, and release/join before
restoring methods; their outer 20-second limits and conversion/orphan assertions
remain strict. Reachable corrected-spec recovery controls perform real admitted
Admin proxy/plugin/spec writes, witness their HTTP calls and assert whole operator
state, catalog, ownership, journal and audit preservation. The original
post-conversion partial-resource scenarios remain explicit unreleased-contract
gates. The rollback audit now has the qualified original-reconciliation producer
described above, with native four-store audit-failure and false-event controls.

The baseline Node 24 run
[`37252738825`, job `111583514912`](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37252738825/job/111583514912)
reported 65 failures and one cancellation. The assessment separately classified
57 unsuccessful tests against unavailable owner behavior: 33 conversion-teardown
409 expectations, two staging-policy checks, eight interruption checkpoints, two
atomic rollback/completion checks, two post-deletion policy checks, three failed
rollback rebuild/cutover checks, two compensation-audit checks, two conditional
spec-replacement checks and three failed-restore withdrawal checks. Those strict
expectations remain. Fixing unreachable fixture waits exposes the real refusal
promptly; it does not qualify successful conversion. The retained original partial
controls also require the next owner release. New-head results require hosted CI;
these source repairs make no passing-test claim.

A failed missing-deployment restore can retain a proxy already cut over before
catalog/audit failure, because safe withdrawal is unavailable. Its retained id is
repair bookkeeping, not successful deployment adoption. This serving-state risk
remains until the owner contract can safely withdraw that graph.

## Required upstream API and ordering

The actionable internal dependency is
[Edge #6010](https://github.com/ferrum-edge/ferrum-edge/issues/6010), covering both
atomic proxy cascade removal and namespace-conditional API-spec replacement.
Neither capability exists in released v0.9.11.
The implementation is tracked by
[Edge PR #6012](https://github.com/ferrum-edge/ferrum-edge/pull/6012), still open
at this repair. Merge alone is insufficient: its immutable release and canonical
publication must exist before new Nexus pins or capability adoption. Released
migrations `001`–`006` and pending `007`–`011` are unchanged by these repairs.
A concrete proposed contract is:

`DELETE /proxies/{id}?conditional=true&cleanup_orphaned_upstream=false`

with `If-Match` carrying the original namespace token from the complete coherent
conditional backup. This proposal is not an existing API and Nexus never calls it.
The owner must compare that token and remove the selected proxy, its attached
specification, associations and affected plugin rows in one transaction under its
entry/commit lease fences. It must preserve every unrelated or unknown resource
and field, including the retained upstream, historical consumer credentials,
trust revisions and resource timestamps. Missing dependencies or an ownership
mismatch must refuse before mutation. Stale tokens must return `412`; unsupported
or unavailable authoritative state must refuse without an unconditional fallback.
The response must unambiguously acknowledge durable completion and successful
live application; ambiguous acknowledgement requires authoritative verification,
never a retry under a freshly captured token.

The proposed spec mutation is `PUT /api-specs/{id}?conditional=true` with that same
original coherent namespace `If-Match`. It must compare within the owner atomic
persistence/admission fences, preserve unrelated exact fields and reject stale,
missing, invalid or unavailable authority. A hosts/plugin/spec edit after baseline
validation must survive refusal. Nexus never calls this proposed endpoint.

The release must also expose enough of the coherent snapshot to validate the
exact targeted spec and generated plugin bodies that authorize removal. The
current proxy row token alone cannot provide that dependency coverage.

Order: owner implementation and concurrent proxy/plugin/spec regressions on all
stores; immutable Edge release and published contract; Nexus adoption using the
same original snapshot body/token, transient or encrypted credential handling,
complete acknowledgement and live-application checks; then exact-head hosted
four-store and packaged acceptance qualification. Root owns that implementation
ordering and release decision. The next immutable
Edge release and canonical publication are required before adopting #6010; this
v0.9.11 baseline does not claim any future API or release. No local project
execution was used for this repair.
