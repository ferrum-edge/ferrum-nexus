# DRAFT: MCP subset rollout and exposure-identity tradeoff

This is an unreleased rollout proposal for Nexus #446, not a released compatibility
promise. Edge stays at the actual v0.9.10 digest; Node 22.14 and the named hosted gates
are unchanged. No unreleased Edge policy API is used.

Migration 011 adds nullable requested/approved tool arrays in all four datastores.
Retained nulls preserve phase-1 all-published-tools access. REST ACL groups and normal
credentials remain unchanged. Existing phase-1 APIs carry no exposure IDs and cannot
accept explicit subsets (including empty subsets) until their provider saves agents
or republishes the spec through the authenticated API. That write assigns identities,
enrolls existing null grants into a separate MCP-all group, and replaces tool policy
under the existing proxy lease and compensated publishing path. Disabled consumers
are not given new membership; enrollment may refuse while a disabled active-grant
holder still needs teardown. Complete that teardown and retry.

Before rollout, stop older Nexus writers across all instances. Do not run mixed phase-1
and subset-aware writers: an old publisher can overwrite tool policy with the REST
approval group and an old consumer-group rebuild does not understand subset membership.
Inventory existing agent APIs, republish each, then qualify discovery/calls using the
pinned acceptance suite before allowing subset requests. Do not roll the application
back while subset grants exist. Rollback planning must remove subset grants and restore
all-tools grants through the normal audited workflow first; no history rewrite or
manual gateway group copy is an approved migration path.

Exposure IDs persist only for a continuously published method/path/name binding.
Disabling, removing and re-adding, or renaming rotates IDs. Any changed spec bytes
conservatively rotate all IDs because indirect schema/reference changes can alter tool
semantics. Explicit subset holders then have REST access and no matching MCP tools;
providers must revoke and approve a new request to authorize changed exposure. Null
all-tools holders intentionally continue to receive published tools. Cosmetic tool
description edits and byte-identical spec republish retain IDs.

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

This deliberate fail-closed behavior can interrupt explicit-subset integrations after
spec changes. Root must assess this tradeoff and the drain/enrollment plan before merge.
Hosted checks and acceptance must pass on the exact pushed head; no local execution
or qualification is claimed.
