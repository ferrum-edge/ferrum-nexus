# Draft jsdom 30 / Undici 8 candidate

References [issue #449](https://github.com/ferrum-edge/ferrum-nexus/issues/449).
Prepared from main `48ea760098d1aa858dc7cee06bf7f8fb7536cdaf` (PR #520).
This continuation integrates main `559c350a5370335791cdc3082225dce6056cf547`
(qualified PR #519) into candidate `aa2904bf41784c930f7d41af69603e22a9216a4c`
through a normal merge.
**The owner has not approved a higher released Node floor.** This branch and its
draft PR are a concrete proposal only. Main/released support remains Node 22.14. Root must
review the combined candidate, obtain fresh independent review and qualify every hosted gate.
The existing owner decision is pending; this integration neither implies approval nor
authorizes another owner request. Do not merge or mark #449 fixed on this preparation.

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

## Hosted lock import; qualification pending

Both checked-in lockfiles are copied byte-for-byte from the successful
[producer run 37217928511, attempt 1](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37217928511).
It checked out exact source `15c47ec5f92d47fa6d491d4cc8f16fa2aa1e50ec`, not a synthetic
merge commit, and ran actual Node `v22.22.2` and npm `10.9.7` with strict engine checks and
lifecycle scripts disabled. No local installer, formatter, build or test generated the locks,
and the generated graph and integrity fields were not edited during import.

Artifact `11308824128` is named
`dependency-locks-15c47ec5f92d47fa6d491d4cc8f16fa2aa1e50ec`. GitHub metadata identifies
the same source/run and repository `1244400882` (`ferrum-edge/ferrum-nexus`), with expiry
`2026-10-18T16:45:42Z`; it was nonexpired when verified on 2026-10-04. The downloaded
archive's SHA-256 matches GitHub's digest:
`06cfb6dd727d02621f026c45c6ba495f4c414803dc08a61a676dfb5809e43bba`.
Its ten members are safe relative regular files. Root verified provenance independently;
the import round rechecked the archive hash, all ten input hashes against immutable source
Git objects and the clean assigned checkout, and all three output hashes against the extracted
artifact. The retained root input lock also matches the source lock hash.

The verified input manifest is:

```text
54eda345e33afbd33910013850cb250193773ae5166ae9446eae1301f42aeeb4  package.json
3457d1d11dcf0d3fa883dc0093c356b65cb22b4be2f67f879947ab72514f8656  shared/package.json
cb5020c8613a52edbf613785391f98b6809d3f03a529fc129fb6522e3e528636  server/package.json
8ef1cb39cb4cafbd19d3b0da589593c6a67b0c6004dbe01c320416a3cf6d534c  web/package.json
d4c228f0a8fd06be71aa0b19d892021b9283c6bdd0ee4f12a7f27307a6a9c8de  e2e/package.json
6aa9d160035c01ee2863ecedb3c0cb9a08097958d1a42c0230712f155d5a4a0b  package-lock.json
f26b2b4bc2f68800b0a6add2c850947ef92fa71fe51ac3a173a21986aad56a7f  e2e/package-lock.json
4c42fb8d6334c5cdcac68b93f96c581fb83b1f58cda898cff115e5e941ef717d  .nvmrc
0e11469a8eba880b1e05fcf6888d8751f05df7ccad3ef2c8361192888ed87c9e  .github/workflows/ci.yml
d84a5593cc6e6665d6dc1bb1ceb42d8ab4333704188de4626f3c5920cd61f444  .github/workflows/dependency-locks.yml
```

The verified output manifest is:

```text
0ed9c2de1dab8e5828e496a135fc1b67f91d2191f4c986e3ea79b19b5e8e6a12  package-lock.json
c46908b663e2ca75765120e87c6d14688eaa251078cd481e42b30fced790645a  e2e/package-lock.json
3f4129955361d27df6a197c6cf0c9ed8c635f3f6ed134ad099d1dc8b62840380  locks.diff
```

Static JSON inspection confirms all five manifests match their lock metadata, jsdom 30.1.2
and Undici 8.11.2 have the published engines and integrity above, and TypeScript 7.0.2,
Vitest/coverage and coupled peers 5.0.3, Zod 4.6.5 and React Table 9.2.5 remain resolved.
The fresh root graph updates jsdom's CSS/DOM/URL/cookie dependencies and removes obsolete
jsdom dependencies. MongoDB's existing URL dependencies move to nested paths with their
versions and integrity retained; `lru-cache` 11.5.3 becomes shared with `path-scurry`.
No other direct dependency version moves. The e2e graph retains every dependency entry and
only adds the proposed engine declaration. Preserve the artifact for review beyond its expiry.
A later merge from main needs corresponding provenance if it changes a producer input;
this artifact always describes the preparation source above, not the subsequent import head.

Initial source-head Docker job `111482158543` stopped at `npm ci` with `EUSAGE` because
the old locks resolved Undici 7.30.0 and jsdom 26.1.0. The six checks lanes, coverage,
store-contracts, acceptance image build and verbatim quickstart stopped on the same mismatch;
`Supported Node minimum` then failed because the checks matrix failed. Those logs do not
establish runtime or application-test results, and no jobs were manually rerun for this import.

On import head `bc389dfe1510692057793930817d35d0c1e18f6a`, `checks (26)` job
`111484640849` in [run 37218770763](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37218770763)
installed and typechecked, then reported 2,196 server tests: 2,176 passed, 19 skipped and
one failed. The new confidential OIDC regression stopped before token exchange: discovery
advertised `localhost`, while the mock authorizer's canonical issuer was `127.0.0.1`.
This follow-up gives that fixture an explicit `localhost` issuer while retaining the default
`127.0.0.1` and loopback-only host options. Discovery, exact authorization endpoint validation
and signed-token issuer now share one identity. Assertions reject a different origin/path
and validate the healthy token through the default vetted Undici transport, retaining Basic
authentication encoding, PKCE and the absence of a form client secret. No production transport
or security guard is changed. The later `aa2904` hosted qualification below includes this
correction and the exact hosted formatter fixes; the earlier job remains a historical failure.

## Main integration and current gates

Pre-integration candidate `aa2904bf41784c930f7d41af69603e22a9216a4c` passed all 15
Actions check runs across [CI 37219830100](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37219830100),
[Verbatim quickstart 37219830156](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37219830156)
and [Dependency lock artifacts 37219830157](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37219830157).
Root completed full and independent review of that head and its fix deltas. This is prior-head
evidence; it does not qualify the combined candidate or approve the released Node profile.

Nexus [#519](https://github.com/ferrum-edge/ferrum-nexus/pull/519) was qualified at final head
`77fdb767ec8ef04e88f13df9fb291bc77fbd0344`: all 11 check runs across
[CI 37221116488](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37221116488)
and [Verbatim quickstart 37221116610](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37221116610)
passed. Root completed whole and fresh independent reviews before it merged at
`559c350a5370335791cdc3082225dce6056cf547` on 2026-10-04 at 17:42:42 UTC;
issue #446 closed at 17:42:43 UTC. Its MCP subsets, migration 011, manifest consumer,
authorization, claim comparisons, leases, compensation, bounds/redaction and strict fixtures
are preserved without source edits. The manifest contract remains PROPOSED pending the
canonical tracking/freeze decision. That main head's implementation and qualification are complete.

The immutable heads share base `48ea760098d1aa858dc7cee06bf7f8fb7536cdaf`. Their only
overlapping changed files are `.github/workflows/ci.yml`, `CHANGELOG.md` and `README.md`.
The normal merge is conflict-free: CI retains all six candidate lanes and the fail-closed
minimum aggregate together with main's migration-011 inventory assertion. Both changelog
entries remain under Unreleased, and README retains the draft profile and manifest pin.
Manual documentation edits distinguish the qualified parents from the unqualified combined
head and preserve the pending owner decision. Candidate H1 opt-outs, canonical OIDC fixture,
accessible notification regressions and all existing MCP strict fixtures are unchanged.

Main changes no package manifest or lockfile relative to the shared base. Both candidate
locks remain byte-for-byte the outputs of artifact `11308824128`; no graph regeneration or
manual dependency edit was needed. The original producer is still run `37217928511`, attempt 1,
source `15c47ec5f92d47fa6d491d4cc8f16fa2aa1e50ec`, and its archive digest remains
`06cfb6dd727d02621f026c45c6ba495f4c414803dc08a61a676dfb5809e43bba`.
The five manifest hashes, `.nvmrc` and producer-workflow hash still match the original input
manifest above. The imported locks retain the original output hashes. Only the CI input
changes during this integration, to include migration 011; its SHA-256 is recorded below.
This is an integration record, not a new producer artifact or a relabeling of the old source:

```text
318c2c47b84d173bd44b7d9fb45d7fa7e9f20ab80ed72dad9831fbe8be8523b4  .github/workflows/ci.yml
0ed9c2de1dab8e5828e496a135fc1b67f91d2191f4c986e3ea79b19b5e8e6a12  package-lock.json
c46908b663e2ca75765120e87c6d14688eaa251078cd481e42b30fced790645a  e2e/package-lock.json
```

Static inspection found no additional integration change needed for TypeScript 7, Zod 4
or Vitest 5: main already uses the same versions and shared DTOs, and manifest validation
uses Zod 4's strict objects and public refinements. New subset controls and their exact
accessible-name fixtures are retained for hosted jsdom 30 execution. Edge mutations continue
through the candidate's owned H1 Admin agent. This inspection is not runtime qualification;
no repository code, installer, formatter, build or test was executed locally.

CI runs `checks (22.22.2)`, `checks (22)`, `checks (24.15.0)`, `checks (24)`,
`checks (26.0.0)` and `checks (26)` with strict engine checks and actual-version assertions.
`Supported Node minimum` requires the entire matrix to succeed and checks all declarations
and the exact matrix before reporting qualification. It never labels a newer runtime as
22.14 or treats a missing/minimum failure as success. Existing required context names and
repository settings are preserved. All four store contracts, SMTP/OIDC/MCP security suites,
Docker, acceptance, quickstart configuration, action pins and verbatim quickstart remain gates
for the combined candidate. Release compatibility and Docker image digests are unchanged.

**Combined-head runtime/CI qualification, full root and fresh independent review remain
PENDING. Owner approval remains PENDING.** Neither the successful parents nor the producer
qualify this combined head or adopt a published Node floor. Root owns exact-head combined-delta
review, independent review of any new logic and all fresh hosted CI after this push. This
continuation neither requests nor triggers an automated reviewer, authorizes merging draft
PR #521, closes #449, nor asks the owner again.

## Decline or rollback

If the owner declines, leave main and the released profile at their current floor and retain
the first-stage dependency upgrades and main's qualified MCP work. Do not merge this draft
or close #449. The dependency proposal adds no schema migration; integrated main adds 011.
The [MCP rollout and rollback limits](mcp-subsets-migration-draft.md) apply: drain older writers
and do not roll back the application while subset grants exist. If a later approved release
needs rollback, use the prior complete release's manifests, genuine locks, Node declarations
and image as one unit, following normal backup/upgrade procedures; changing only `.nvmrc`
cannot make jsdom 30 install on Node 22.14.
