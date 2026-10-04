# Unreleased MCP subset rollout and exposure identities

Nexus [#519](https://github.com/ferrum-edge/ferrum-nexus/pull/519) implements the
optional tool subsets tracked by [#446](https://github.com/ferrum-edge/ferrum-nexus/issues/446).
Root accepted the provider opt-in, exposure-identity tradeoff and writer-drain plan
below. The implementation remains Unreleased. It uses the existing digest-pinned
Edge v0.9.10 policy contract and keeps the declared Node 22.14 minimum.

## Enrollment and rollout

Migration 011 adds nullable requested/approved tool arrays in all four datastores.
Retained nulls preserve phase-1 all-published-tools access. REST ACL groups and normal
credentials remain unchanged. Existing phase-1 APIs carry no exposure IDs and cannot
accept explicit subsets (including empty subsets) until their provider saves agents
or republishes the spec through the authenticated API. That write assigns identities,
enrolls existing null grants into a separate MCP-all group, and replaces tool policy
under the existing proxy lease and compensated publishing path. Disabled consumers
are not given new membership; enrollment may refuse while a disabled active-grant
holder still needs teardown. Complete that teardown and retry.

Enrollment repairs retained null-grant MCP-all membership while holding the proxy
lease, then the consumer key, then the account lifecycle key. The REST group must
still be present and the account active before membership is added. The publishing
path preserves operator resource fields and unrelated consumer groups.

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

Exposure IDs persist only for a continuously published method/path/name binding.
Disabling, removing and re-adding, or renaming rotates IDs. Any changed spec bytes
conservatively rotate all IDs because indirect schema/reference changes can alter tool
semantics. Explicit subset holders then have REST access and no matching MCP tools;
providers must revoke and approve a new request to authorize changed exposure. Null
all-tools holders intentionally continue to receive published tools. Cosmetic tool
description edits in provider agent settings and byte-identical spec republish retain
IDs; changing uploaded spec bytes still rotates IDs even for a description-only edit.

This accepted fail-closed behavior can interrupt explicit-subset integrations after
spec changes. Providers must plan reapproval for changed exposure; an old explicit
approval never silently covers a replacement tool.

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

These passed jobs do not establish that every `0c05113` CI check passed. The active
branch ruleset requires fresh results for these eight contexts on the final documentation
and main-integration head: `Supported Node minimum`, `checks (22)`, `checks (24)`,
`store-contracts`, `docker`, `acceptance`, `quickstart-config` and `action-pins`. The
`checks (22.14.0)` matrix job remains an explicit Node 22.14.0 minimum-version check, but
is not a separate required context in that ruleset. The `Supported Node minimum` gate was
integrated from main commit `48ea760098d1aa858dc7cee06bf7f8fb7536cdaf`
([#520](https://github.com/ferrum-edge/ferrum-nexus/pull/520)). Root's final qualification
requires fresh results for all reported hosted checks, including `checks (22.14.0)`,
coverage and quickstart. No repository code, formatter, build or test was executed locally
for this documentation and integration update.
