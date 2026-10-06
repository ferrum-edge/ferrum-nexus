# Dependency major migrations for issue #449

This document preserves the first-stage and pre-approval integration history for
[issue #449](https://github.com/ferrum-edge/ferrum-nexus/issues/449). PR #518 completed the
Node 22.14-compatible first stage. The owner has now approved jsdom 30.1.2 / Undici 8.11.2
and the current unreleased supported range `^22.22.2 || ^24.15.0 || >=26.0.0`.
Published releases retain their historical Node 22.14+ profile until a new release ships.
The draft and pending owner/combined-head statements below describe earlier preparation
snapshots, superseded by explicit approval and the qualification of prior head `059b428`.
Fresh hosted qualification, full root and fresh independent review remain pending for the
documentation adoption head. Issue #449 remains open while root completes those gates and
PR #521's delivery. See the [migration notes](dependency-majors-449-higher-floor-draft.md)
for current approval, exact-head qualification, preserved lock provenance and rollback.

## Published versions and migration boundaries

The official npm metadata and published declarations inspected on 2026-10-04 identify these
stable releases:

- [TypeScript 7.0.2](https://registry.npmjs.org/typescript/7.0.2) declares Node >=16.20. All four
  manifests (`shared`, `server`, `web`, `e2e`) pin it exactly because the AST/service exports are
  explicitly unstable. The package root no longer exports the JavaScript compiler API.
- [Zod 4.6.5](https://registry.npmjs.org/zod/4.6.5) declares no Node engine floor. Configuration
  helpers use `ZodType<Output, Input>` instead of `ZodEffects`, and required secrets use the new
  `error` callback. Existing defaults, trimming, decimal-only bounds, boolean parsing and exact
  operator diagnostics remain covered; the environment enum has an explicit diagnostic too.
- [TanStack React Table 9.2.5](https://registry.npmjs.org/@tanstack%2freact-table/9.2.5) declares
  Node >=20. `useTable` takes explicitly registered features and the core row-model factory.
  The common `Columns` type includes that feature set, preserving contextual row types in every
  consumer route. Route queries continue to own sorting/order, filters and pagination; the table
  renders the returned page without a second sort, filter or slice. Entity ids key rows and cells,
  so reordering no longer transfers cell state between entities. Pointer/keyboard activation,
  toolbars, loading/error/empty states and server-total pagination remain covered.
- [Vitest 5.0.3](https://registry.npmjs.org/vitest/5.0.3) supports Node 22.12+ on the 22 line and
  peers with the existing Vite 8. Vitest and
  [V8 coverage 5.0.3](https://registry.npmjs.org/@vitest%2fcoverage-v8/5.0.3) are pinned together;
  installed Vitest-coupled peers must match. Standalone `@vitest/istanbul-lib-*` libraries retain
  their independent versions. jest-dom 7 registers its runtime matchers through the existing
  setup import, while `web/src/vitest.d.ts` extends `Matchers<R, T>` with the published
  `TestingLibraryMatchers<T, R>` argument and return types. Existing assertions remain intact,
  including the NotificationsPage accessible-name assertions.

The audit scan parses an isolated virtual project with TypeScript's native synchronous service,
rejects syntactic diagnostics, visits decoded nodes, and disposes the snapshot/service even on
failure. The scanner still checks catalog coverage, imports/aliases/literals, lexical binding and
shadowing, first-parameter transaction stores, helper callers/escapes/depth, service hooks and
hook aliases, scoped const audit bindings, direct awaits, catch/finally exits, non-audit writes,
intent/row-only exceptions, conditional actions and read-only filters. Existing fixtures are
retained; new fixtures exercise the AST boundary and migrated predicates. It does not use a
legacy compiler package, regex replacement for AST traversal, skipped scans or `ts-nocheck`.

## Remaining candidate and issue discrepancy

[jsdom 30.1.2](https://registry.npmjs.org/jsdom/30.1.2) requires
`^22.22.2 || ^24.15.0 || >=26.0.0`, and depends on Undici 8.
[Undici 8.11.2](https://registry.npmjs.org/undici/8.11.2) independently requires Node >=22.19.
Both exceed the released minimum. This draft declares jsdom 30.1.2 and Undici 8.11.2,
and both locks were imported byte-for-byte from verified hosted artifact `11308824128`.
The root lock still matches that artifact; the e2e lock now includes PR #523's verified
Node typings patch. Both retain the proposed workspace engines.
Owned transports disable H2 explicitly. Notifications now label buttons from their visible
title and action and describe them from the visible body and time, retaining role/name and
visibility assertions. Candidate `d3347dcae7b61186debf9457ab572ecd70971ba6` passed all 15
hosted checks after integrating PR #519. The new combined head after integrating PR #523
needs fresh hosted evidence and independent review.

The issue body says Dependabot ignores these package majors. At the migration base `2ad4d53`,
`.github/dependabot.yml` contains no package-specific ignores for them: its npm major ignores
cover only `@types/node`, and the Docker Node ignore is separate. There is no matching ignore to
remove. This discrepancy is documented here; the issue and Dependabot configuration are unchanged.

The authorized merge of main `559c350a5370335791cdc3082225dce6056cf547` brings qualified
PR #519's MCP subsets, forward migration `011` on all four stores and proposed service-manifest
consumer into this candidate. Its source, strict fixtures and immutable contract assets are
preserved without integration edits. Ferrum Edge 0.9.10 compatibility pins remain unchanged.
The subsequent authorized merge of main `1a908ea5c81e4685622345954266268684255b86`
brings PR #523's deterministic lock producer and e2e `@types/node` 22.20.4 to 22.20.5 patch.
It preserves all candidate application, MCP, migration and support-proposal changes.

## Hosted locks and qualification

The first stage's artifact is preserved as history in
[lock provenance](dependency-majors-449-lock-provenance.md). The original candidate import from
producer run `37217928511`, attempt 1, source `15c47ec5f92d47fa6d491d4cc8f16fa2aa1e50ec`
on Node `v22.22.2` / npm `10.9.7` is recorded in the
[draft notes](dependency-majors-449-higher-floor-draft.md#hosted-lock-import-qualification-pending).
Neither producer success nor the verified import qualifies the application or adopts a Node floor.

Both real npm lockfiles must come from GitHub-hosted npm, never a locally run installer or a
handwritten dependency graph. `.github/workflows/dependency-locks.yml` is an optional artifact
producer on manifest/workflow pull-request changes (or manual dispatch once available on the
default branch). It checks out the exact PR head, uses full-SHA-pinned actions and `contents: read`,
does not persist credentials or use caches/secrets/write permissions, and now runs Node 22.22.2 with
strict engine checks and `npm install --package-lock-only --ignore-scripts`. The original
Vitest 4 to 5 migration required a fresh root graph because npm 10 retained the old optional
peer cycle; that graph is already committed, and its historical resolution and hashes remain
recorded in the provenance document. The current producer retains both committed locks as
resolution inputs and copies both input locks into the provenance artifact. It rejects graph
changes when that lock's manifest declarations are unchanged, so an `e2e`-only update preserves
the root graph. TypeScript pins must agree across all four manifests; Vitest and coverage pins
and installed coupled peers must match. Zod and React Table checks use the input locked versions
when their declared ranges are unchanged, or the npm-resolved versions when those declarations
change. jsdom and Undici, which set the Node floor, must be present and every copy must be
resolved from the npm registry with a sha512 integrity and declare `engines` (checked with npm's
own semver) that admit every Node version the manifests support. No version or integrity is
hard-coded, so a reviewed bump passes. While no manifest of a lock moves a jsdom or Undici spec,
every copy's version, resolved URL and integrity must equal the committed lock's, so a change that
re-resolves the graph for another reason cannot move or dedupe either; jsdom depends on Undici, so
either spec moving releases both. The
candidate also records `.nvmrc` and CI as inputs and checks its actual Node version. It outputs
both locks and the complete diff, source SHA, tool versions, run identity, and SHA-256 input/output
manifests. Review every resolved-version movement before applying an artifact.

To apply a producer artifact, download it with `gh run download` for the exact source head. Verify
the successful producer run and its commit SHA, match `provenance/source-sha.txt` to the source
checkout, verify `provenance/input.sha256` against that checkout, and verify
`provenance/output.sha256` from the artifact directory. Review `locks.diff`, then copy only the
two generated lockfiles to their corresponding paths, inspect the complete diff, and commit with
hooks disabled before pushing. Keep the provenance artifact/run URL available for review.

The root lock is unchanged; the e2e lock incorporates only main's hosted-verified typings patch
while preserving the candidate engine declaration. Current input hashes and both historical
artifact identities are recorded in the draft notes and provenance document. At the PR #523
integration snapshot, fresh producer verification and combined-head runtime/CI qualification
were still pending. The optional producer
does not replace any required check:
all normal required checks must pass on the final head,
including `Supported Node minimum`, real Node 22/24 checks, store contracts, Docker, acceptance,
quickstart configuration and action pins. The candidate's additional per-major minima, Node 26
and verbatim quickstart jobs must pass too. Coverage remains its existing optional job.
No local project tooling was run for this migration. Root and a fresh independent reviewer
must review the combined candidate and integration delta, and every hosted gate must pass again.
At that preparation stage, owner approval to change the released profile was pending;
integration alone did not imply approval, authorize another owner request or close #449.
The explicit approval and qualified prior head `059b428` now supersede that historical status;
the documentation adoption head still requires its own hosted gates and root review.
