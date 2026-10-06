# MCP subset rollout and exposure identities

Nexus `v0.4.0` ships the optional tool subsets tracked by
[#446](https://github.com/ferrum-edge/ferrum-nexus/issues/446), implemented in
[#519](https://github.com/ferrum-edge/ferrum-nexus/pull/519). This page describes the
provider opt-in, the exposure-identity rules and the writer-drain rollout that an
upgrade to `v0.4.0` requires.

## Enrollment and rollout

Migration 011 adds nullable requested/approved tool arrays in all four datastores.
Retained nulls preserve phase-1 all-published-tools access. REST ACL groups and normal
credentials remain unchanged. Existing phase-1 APIs carry no exposure IDs and cannot
accept explicit subsets (including empty subsets) until their provider saves agents
or republishes the spec through the authenticated API. That write assigns identities,
enrolls existing null grants into a separate MCP-all group, and replaces tool policy
under the existing proxy lease and compensated publishing path. Disabled grantees
are skipped, never enrolled and never a reason to refuse: their grant rows remain, and
re-enabling the account rebuilds its groups, MCP included, from those rows. Consumers
missing from the portal or the gateway are skipped for consumer repair.

Enrollment runs only for a change that turns agents on or that assigns a retained
phase-1 selection its IDs; later builds do not read grantee consumers. It repairs
retained null-grant MCP-all membership while holding the proxy lease, then the
consumer key. It does not take the account lifecycle key: ordering
against a disable comes from re-reading the account's status under the consumer key,
because a disable commits the status change first and then strips groups under that
same key. The REST group must still be present and the account active before
membership is added, and a consumer that already carries the MCP-all group is not
written. Each enrollment commits an `access.mcp_enroll` intent row before its consumer
write. The publishing path preserves operator resource fields and unrelated consumer
groups.

Before rollout, stop and drain older Nexus request handlers and background writers
across all instances. Mixed phase-1 and subset-aware writers are unsafe: an old
publisher can overwrite tool policy with the REST approval group, and an old
consumer-group rebuild does not understand subset membership. Inventory existing
agent APIs, obtain each provider's authenticated save or republish, then qualify
discovery and calls using the pinned acceptance suite before allowing subset requests.
Retained APIs continue their phase-1 all-tools behavior until that opt-in write.

Follow the [supported topology](operations.md#supported-topologies): exactly one
active Nexus instance may perform gateway mutations. Lease fencing and transaction
queues do not promise global consistency across independent store objects or make
mixed writers safe.

Do not roll the application back while subset grants exist. Rollback planning must
remove subset grants and restore all-tools grants through the normal audited workflow
first; no history rewrite or manual gateway group copy is an approved migration path.

## Exposure changes

An exposure ID names one published tool definition. Each selected tool stores a
`definition_hash`: a SHA-256 over the canonical form of what Edge publishes for it,
with every local `$ref` resolved. That covers the tool name, method, path and Nexus
description, the operation's `summary` (Edge's tool title) and `description`, the
path and operation parameters, the request body's `required`, `description` and JSON
media schemas, the 2xx JSON response schemas (Edge's output schema), and the document's
OpenAPI version, which decides how Edge normalizes those schemas. Each `$ref`
contributes its own text and its target's digest. A reference Nexus cannot resolve from
the document root (external, anchor, dangling, a Request Body or Response chain that
does not end at an object, or reaching a `$id`, `$dynamicRef` or `$recursiveRef`
member) folds in the whole document except `info`, hashed as text; an unresolvable
selected Path Item or a document whose reading and hashing pass the work budget
hashes every tool from its selection and that digest. See
[agent-marketplace.md](agent-marketplace.md#optional-subsets-and-cross-repository-follow-up)
for the exact cases.

A tool keeps its ID across a spec revision, a rollback or an agents edit only while
its method, path, name and hash are all unchanged. Whitespace, `info` edits, and
changes to unselected operations or to components the tool does not reference carry.
Any change to the definition mints a new ID, a description-only edit included, in the
spec or in the provider's agent settings: descriptions are prompt text an agent acts
on. Disabling, removing and re-adding, or renaming also rotate IDs.

The write that rotates or removes an ID drops it from every explicit subset in the
same transaction, recording `access.tools_prune` per grant with `reason`
`definition_changed`, `tool_renamed` or `tool_removed`. Holders keep REST access and
their other tools, and need a new approval for the changed tool, which they request on
their existing grant (`POST /api/grants/:id/tool-requests`) without revoking it. A spec revision that changes a
tool's definition also names it in the revision's change summary and in the grantee
notice. Null all-tools holders intentionally continue to receive published tools,
changed ones included. APIs saved before definition hashes were stored compare
against a hash computed from the current revision, so upgrading rotates nothing by
itself. The stored hash is bound to the tool's ID: a release without hashes copies the
stored hash onto every ID it mints, and binding makes that copy never match, so a
downgrade and re-upgrade cannot carry an approval onto a definition it was not given
for.

## Consumer repair and revocation recovery

Explicit gateway consumer repair replays REST and approved MCP groups from fresh active
grants for that exact account or application identity, under its provisioning, consumer
and account lifecycle keys. Null/omitted approval restores MCP-all, explicit empty
restores REST alone, and explicit subsets restore their recorded exposure groups only.
It never substitutes current exposure IDs for expired approvals, restores MCP groups
when agent exposure is disabled, or replays access for a disabled account. Application
disable and catalog retirement still revoke nothing. Repair revokes the lost consumer's
live credential metadata and reports the total REST plus MCP group count; holders must
issue replacement credentials. Existing consumers and operator groups are left intact.

A failed targeted revocation restores its own claimed grant/request if any of its REST
or approved MCP groups survives, so partial membership can be cleaned up by retrying.
Restoration is refused when no authorization group remains (expired exposure groups
alone do not count), the consumer is missing, the grantee is disabled or another
revocation claim has replaced this one. An unreadable gateway retains the conservative
rollback behavior.

Revocation recovery takes the proxy, consumer and account lifecycle keys in that
order when MCP eligibility matters. If the proxy lease is lost, the original section
releases its keys before fallback acquires the current proxy and the inner keys again.
Restoration compares the revocation claim before writing and fences the transaction
through commit. The normal restoration and its rollback audit commit together. If
that audit transaction fails, recovery checks whether it committed, retries the
claim-specific restoration in its own fenced transaction when needed, and attempts
the rollback audit separately. This fallback can leave an audit gap if recording also
fails; it does not justify restoring a newer claim or expired tool coverage.

A missing gateway consumer during targeted revocation still returns HTTP `502`
with `EDGE_ERROR`. The grant and request remain revoked, with one `access.revoke`
and one `access.revoke_rollback` row reporting `grant_restored: false` and
`restore_skipped_reason: 'group_absent'`. It neither recreates the consumer nor writes
its groups. The strict fixtures corrected at `0c05113` verify this existing production
behavior; the correction did not change runtime revocation semantics.

## Test coverage

The store contracts run the production publishing and access subset cases, revocation,
exposure-change and membership-repair tests on SQLite, PostgreSQL, MySQL and MongoDB.
The packaged acceptance suite runs provider-narrowed subsets for account and
application identities with keyauth, basicauth and JWT credentials. Each case checks
the exact approved discovery result and actual dispatch, including after an account is
re-enabled with replacement credentials; forbidden calls return HTTP `200` with JSON-RPC
error `-32001` and no upstream effect. The suite also covers revocation, exposure-ID
rotation, explicit-empty versus omitted/null coverage, and checks that a changed or
re-enabled exposure cannot revive old IDs.
