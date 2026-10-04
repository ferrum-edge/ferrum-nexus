# Draft conversion recovery: required owner capability

PR #522 remains draft. This source repair does not qualify the public-only
proposal, change release pins, or declare an advisory fixed.

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

Recovery can reconcile an unchanged original or rebuild an absent identity. It
refuses destructive removal of any live partial deployment, leaving operator
proxy/plugin/spec changes and the journal intact. Conversion teardown and
missing-deployment restore cleanup pass the released
`cleanup_orphaned_upstream=false` option, preserving a hand-owned last-referenced
upstream resource instead of reconstructing a dangling reference.

This refusal also blocks automatic rollback of a successful conversion when
catalog completion fails. If the catalog row disappeared, Nexus cannot safely
remove the remaining partial proxy graph with the released contract. The existing
`publishing-lifecycle.test.ts` expectation that no live orphan remains is retained;
its fault injection still targets catalog completion, after the new repair-state
write. That expectation is an unresolved owner capability gate, not a passing
qualification claim. Existing rollback tests that require removing a live partial
have the same blocker.

## Required upstream API and ordering

Root must file an Edge owner change for an opt-in, atomic proxy cascade removal.
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

The release must also expose enough of the coherent snapshot to validate the
exact targeted spec and generated plugin bodies that authorize removal. The
current proxy row token alone cannot provide that dependency coverage.

Order: owner implementation and concurrent proxy/plugin/spec regressions on all
stores; immutable Edge release and published contract; Nexus adoption using the
same original snapshot body/token, transient or encrypted credential handling,
complete acknowledgement and live-application checks; then exact-head hosted
four-store and packaged acceptance qualification. Root owns that filing,
ordering and release decision. No local project execution was used for this repair.
