# Unreleased MCP subset rollout and exposure identities

Nexus [#519](https://github.com/ferrum-edge/ferrum-nexus/pull/519) implements the
optional tool subsets tracked by [#446](https://github.com/ferrum-edge/ferrum-nexus/issues/446).
Root accepted the provider opt-in, exposure-identity tradeoff and writer-drain plan
below. The implementation is qualified and merged but remains Unreleased. It uses the
existing digest-pinned Edge v0.9.10 policy contract. Main retains Node 22.14; this higher-floor
candidate integrates that implementation under the separate, owner-pending
[Node proposal](dependency-majors-449-higher-floor-draft.md).

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

Enrollment repairs retained null-grant MCP-all membership while holding the proxy
lease, then the consumer key. It does not take the account lifecycle key: ordering
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
`definition_changed` or `tool_removed`. Holders keep REST access and their other
tools, and need a new approval for the changed tool. A spec revision that changes a
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

## Hosted qualification and final gate

The following executed evidence applies to code commit
`0c05113fdaa34bcce2c7ee5780191447359f105e`, in
[run 37215210346](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37215210346):

- [store-contracts, job 111474199932](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37215210346/job/111474199932)
  passed production publishing/access subset cases and revocation, exposure-change
  and membership-repair tests on SQLite, PostgreSQL, MySQL and MongoDB. The job
  reported **1,365 tests: 1,349 passed, 16 skipped, zero failed**.
- [Packaged acceptance, job 111474199807](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37215210346/job/111474199807)
  passed all six provider-narrowed subset cases: account and application identities
  with keyauth, basicauth and JWT credentials. Each case checked the exact approved
  `list_invoices` discovery result and actual dispatch, including after account
  re-enable with replacement credentials. Forbidden calls returned HTTP `200` with
  JSON-RPC error `-32001` and no upstream effects. The suite also passed revocation,
  exposure-ID rotation, explicit-empty versus omitted/null coverage and checks that
  changed or re-enabled exposure cannot revive old IDs.

These passed jobs do not establish that every `0c05113` CI check passed. Final PR #519
head `77fdb767ec8ef04e88f13df9fb291bc77fbd0344` subsequently passed all 11 hosted
checks across [CI 37221116488](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37221116488)
and [Verbatim quickstart 37221116610](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37221116610).
That includes all eight protected Actions contexts: `Supported Node minimum`, `checks (22)`,
`checks (24)`, `store-contracts`, `docker`, `acceptance`, `quickstart-config` and `action-pins`,
plus the exact `checks (22.14.0)` minimum, coverage and quickstart. Root completed whole and
fresh independent reviews with zero unresolved threads. The PR merged at
`559c350a5370335791cdc3082225dce6056cf547` on 2026-10-04 at 17:42:42 UTC; #446
closed at 17:42:43 UTC. This completes main's implementation and qualification, not a release.

The higher-floor candidate integrates that immutable main commit with a normal merge,
preserving its MCP source and fixtures. The combined head requires fresh hosted results and root and
independent review; neither parent's results qualify it. Its six proposed minimum/current
Node lanes and unchanged eight protected contexts are documented in the
[integration record](dependency-majors-449-higher-floor-draft.md#main-integration-and-current-gates).
Owner approval to change the released Node profile remains pending. No repository code,
installer, formatter, build or test was executed locally for this integration.
