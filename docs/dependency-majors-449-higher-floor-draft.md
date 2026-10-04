# Draft jsdom 30 / Undici 8 candidate

References [issue #449](https://github.com/ferrum-edge/ferrum-nexus/issues/449).
Prepared from main `48ea760098d1aa858dc7cee06bf7f8fb7536cdaf` (PR #520).
**The owner has not approved a higher released Node floor.** This branch and its
draft PR are a concrete proposal only. Main/released support remains Node 22.14. Root must
review the full candidate, obtain fresh independent review and qualify every hosted gate
before asking the owner to approve a released-profile change. Do not merge or mark #449 fixed
on the strength of this preparation.

## Compatibility proposal and primary evidence

The proposed source range is `^22.22.2 || ^24.15.0 || >=26.0.0`, declared identically in
the root, shared, server, web and e2e manifests; `.nvmrc` selects exactly 22.22.2. This retains
the Node 22 major, but excludes 22.14–22.22.1, Node 23/25, and Node 24 below 24.15.0.
Operators on those versions must upgrade before installing a future approved release.

Official npm metadata re-read on 2026-10-04:

- [jsdom 30.1.2](https://registry.npmjs.org/jsdom/30.1.2) requires the proposed range and
  directly depends on `undici: ^8.11.2`. Its published integrity is
  `sha512-0FFE/jE1rppmVfUrJUgxqXjcwolZYIGtAgj1pTussMhNZxIxi7W/PvfWaMNroGi2B36X1IKHbexpZ9DhkoOPiQ==`.
- [Undici 8.11.2](https://registry.npmjs.org/undici/8.11.2) requires `>=22.19.0`. Its published
  integrity is
  `sha512-u4UB2/IrKdU6lFxumHmmo1a3fCQO5tzQllRorfoRS63txhrB7xTpSn1PftwC4qEHkOaqP95fCWW4lJzwErwzhQ==`.
- The [official Node release index](https://nodejs.org/dist/index.json) lists 22.22.2,
  24.15.0 and 26.0.0; Node 26.10.0 is also published. No local Node binary was run.
- The [Undici 8 release](https://github.com/nodejs/undici/releases/tag/v8.0.0) enables H2
  by default and changes dispatcher handlers/global bridging. Its
  [migration guide](https://github.com/nodejs/undici/blob/7e016ad7e5bd6540170069a9a28b1e633b29664f/docs/docs/best-practices/migrating-from-v7-to-v8.md)
  describes the H1 opt-out and v2 handler boundary.

TypeScript 7.0.2, Vitest/coverage 5.0.3, Zod 4.6.5 and React Table 9.2.5 declarations are
unchanged. The native TypeScript AST audit scanner and its fail-closed structural fixtures
are retained. No legacy dispatcher handlers, interceptors or global-dispatcher-symbol reads
were found in Nexus's owned production HTTP consumers. They use Undici's public `request`
or `fetch` APIs with owned agents. No package-specific jsdom/Undici Dependabot ignores exist
at this base, so there is no matching ignore to remove; unrelated ignores remain.

## Transport and accessibility changes

The Admin agent sets `allowH2: false`, retaining the existing keep-alive margins, shared
deadline, single retry for an unanswered stale-socket GET/HEAD and no mutation replay.
The new real TLS server offers H2 and H1: the regression requires H1 ALPN on the warm and
fresh retry socket, exactly one reset-read retry, a single reset mutation, and valid
HS256 admin JWT/namespace headers. Its public Node TLS fixtures are trusted by a test-only
CA file without disabling certificate or hostname verification. Existing connection deadline,
read limit, response contract, credential-redaction and authorization tests still run.

OIDC's owned agent also disables H2 while retaining connection-time vetted DNS, hostname/SNI
verification, URL guards, strict issuer/nonce/PKCE checks, deadlines and redirect refusal.
Existing real-network rebinding/loopback tests remain. A new confidential-client exchange
uses the default transport through the vetted loopback lookup and checks Basic authentication,
the PKCE verifier and the absence of the secret from the request form.

CAPTCHA previously used Undici's global dispatcher. It now owns an H1 agent rather than
inheriting the new H2 default/global bridge. Vendor endpoint constants, the five-second budget,
form encoding and fail-closed checks are retained. A real HTTP regression checks delivery
and confirms a redirect never receives the vendor form. This agent is a process-lifetime pool,
as the prior global pool was; the server does not alter global dispatcher state.

The earlier jsdom PR's hosted log contained visible notification text but failed the three
accessible-name lookups. Upstream [jsdom #4091](https://github.com/jsdom/jsdom/issues/4091)
reports sibling text concatenation after computed-style changes. Static inspection is consistent
with that explanation: these tests render without Tailwind's block/flex layout styles.
This has not been locally reproduced. Notification buttons now reference their visible title
and current action with `aria-labelledby`, and their visible body/time with `aria-describedby`.
Tests require exact accessible names, visible text and descriptions, paging/filter/bell behavior
and an unlinked item's changing action. No hidden-role override, skipped test, CSS visibility
patch or weakened name matcher is used. Hosted jsdom 30 results must verify the hypothesis.

## Existing Docker pin meets the proposed floor

The Docker Registry HTTP API was read on 2026-10-04 for the existing immutable index:

```text
node:22-bookworm-slim
index: sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
revision: 81f419144a1251854c6d9afb09eaa39928e724e8
linux/amd64 manifest: sha256:25330af3531fb5e23318554a0aa911125b6e91b1b777edf7655501d207c067a2
linux/amd64 config: sha256:88f8ba583a884279252779bbe221bf1ff2c61cf236cc973f8ca97676ae6d07f0
linux/arm64/v8 manifest: sha256:a0ddbc73510e98f5e824fd64266ffe1c2c343ba9cf260d95ca2985ad632a3f3e
linux/arm64/v8 config: sha256:78175922b1739c305f3832562c569a07cbc0005b39db6b97a4a3ac328b9fae94
both configs: NODE_VERSION=22.23.3
```

The index's source annotation points to
[docker-node revision 81f4191](https://github.com/nodejs/docker-node/tree/81f419144a1251854c6d9afb09eaa39928e724e8/22/bookworm-slim).
Both Nexus image stages and the acceptance upstream retain this digest. No image or Node
process was run locally. The hosted Docker, acceptance and verbatim quickstart jobs must
validate the packaged result; OCI metadata alone does not qualify it.

## Pending lock producer and qualification

Both checked-in lockfiles are intentionally the unchanged PR #518 artifacts. They are stale
for this candidate, so ordinary `npm ci`/Docker gates are expected to fail at preparation.
There is no candidate lock provenance or passing candidate-test claim yet. The read-only
producer automatically runs for this PR's manifest/workflow changes and checks out the exact
PR head, not a synthetic merge commit. It selects Node 22.22.2, asserts the actual version,
records npm's actual version and enables strict engine checks. Lifecycle scripts are disabled.
The root graph is resolved afresh; the e2e graph is updated from its retained input lock.
This can move other versions admitted by existing ranges; inspect the whole output diff.

The artifact records source SHA, run/attempt, all five manifests, both input locks, `.nvmrc`,
CI/producer workflow hashes, Node/npm versions, both output locks and the lock diff with
SHA-256 output hashes. Guards require jsdom 30.1.2 and Undici 8.11.2 with the published engines
and integrity above, plus the unchanged exact first-stage dependency versions.
Root must collect a successful producer artifact for the actual source SHA, verify every
input against that immutable checkout and every output against the artifact, and apply the
real locks in a separate round. A later merge from main needs corresponding provenance if
it changes any producer input; never attribute an old artifact to a different input graph.

CI runs `checks (22.22.2)`, `checks (22)`, `checks (24.15.0)`, `checks (24)`,
`checks (26.0.0)` and `checks (26)` with strict engine checks and actual-version assertions.
`Supported Node minimum` requires the entire matrix to succeed and checks all declarations
and the exact matrix before reporting qualification. It never labels a newer runtime as
22.14 or treats a missing/minimum failure as success. Existing required context names and
repository settings are preserved. All four store contracts, SMTP/OIDC/MCP security suites,
Docker, acceptance, quickstart configuration, action pins and verbatim quickstart remain gates
for the final candidate. No MCP subset/runtime/service-manifest source is changed here.

After genuine locks, root and fresh independent review, and all hosted results are reviewable
on the final head, root may ask the owner to approve the support-profile tradeoff. Fix deltas
need review too. This preparation neither requests nor triggers an automated reviewer.

## Decline or rollback

If the owner declines, leave main and the released profile at their current floor and retain
the first-stage dependency upgrades. Do not merge this draft or close #449. This candidate
adds no schema migration. If a later approved release needs rollback, use the prior complete
release's manifests, genuine locks, Node declarations and image as one unit, following normal
backup/upgrade procedures; changing only `.nvmrc` cannot make jsdom 30 install on Node 22.14.
