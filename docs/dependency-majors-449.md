# Dependency major migrations for issue #449

This is partial progress on [issue #449](https://github.com/ferrum-edge/ferrum-nexus/issues/449).
PR #518 completed the Node 22.14-compatible first stage described below. The issue remains
open for jsdom 30 and Undici 8. This branch prepares that second stage as a **draft**, with
higher Node minima in its manifests and workflows. No released support-profile change has
been approved. Main and the released profile retain Node 22.14; PR #520's stable
`Supported Node minimum` gate qualifies the actual declared minimum through the matrix.
See the [higher-floor candidate notes](dependency-majors-449-higher-floor-draft.md) for
compatibility costs, published evidence, imported locks, pending qualification and rollback.

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
and both current locks are imported byte-for-byte from verified hosted artifact `11308824128`.
The root lock resolves those versions; both locks include the proposed workspace engines.
Owned transports disable H2 explicitly. Notifications now label buttons from their visible
title and action and describe them from the visible body and time, retaining role/name and
visibility assertions. The candidate still needs hosted evidence and fresh independent review.

The issue body says Dependabot ignores these package majors. At the migration base `2ad4d53`,
`.github/dependabot.yml` contains no package-specific ignores for them: its npm major ignores
cover only `@types/node`, and the Docker Node ignore is separate. There is no matching ignore to
remove. This discrepancy is documented here; the issue and Dependabot configuration are unchanged.

The existing MCP functionality, forward migration `010` on all four stores, vendored contracts,
and Ferrum Edge 0.9.10 compatibility pins are outside this migration and remain unchanged.

## Hosted locks and qualification

The first stage's artifact is preserved as history in
[lock provenance](dependency-majors-449-lock-provenance.md). The current candidate import from
producer run `37217928511`, attempt 1, source `15c47ec5f92d47fa6d491d4cc8f16fa2aa1e50ec`
on Node `v22.22.2` / npm `10.9.7` is recorded in the
[draft notes](dependency-majors-449-higher-floor-draft.md#hosted-lock-import-qualification-pending).
Neither producer success nor the verified import qualifies the application or adopts a Node floor.

Both real npm lockfiles must come from GitHub-hosted npm, never a locally run installer or a
handwritten dependency graph. `.github/workflows/dependency-locks.yml` is an optional artifact
producer on manifest/workflow pull-request changes (or manual dispatch once available on the
default branch). It checks out the exact PR head, uses full-SHA-pinned actions and `contents: read`,
does not persist credentials or use caches/secrets/write permissions, and now runs Node 22.22.2 with
strict engine checks and `npm install --package-lock-only --ignore-scripts`. npm 10 retains the
old optional Vitest/coverage peer cycle during an in-place update, so the producer resolves a
fresh root graph from the manifests and retains the input lock in the provenance artifact.
Review any other resolved-version movement in its diff too. It generates both the root and
separate `e2e` locks, checks the intended dependency families, and uploads both plus a diff,
source SHA, tool versions, run identity, and SHA-256 input/output manifests. Its exact
jsdom/Undici version, engine and integrity guards must pass as well as the retained first-stage
dependency-family guards.

To apply a producer artifact, download it with `gh run download` for the exact source head. Verify
the successful producer run and its commit SHA, match `provenance/source-sha.txt` to the source
checkout, verify `provenance/input.sha256` against that checkout, and verify
`provenance/output.sha256` from the artifact directory. Review `locks.diff`, then copy only the
two generated lockfiles to their corresponding paths, inspect the complete diff, and commit with
hooks disabled before pushing. Keep the provenance artifact/run URL available for review.

The candidate locks are applied; final-head runtime/CI qualification remains pending. The optional
producer does not replace any required check: all normal required checks must pass on the final head,
including `Supported Node minimum`, real Node 22/24 checks, store contracts, Docker, acceptance,
quickstart configuration and action pins. The candidate's additional per-major minima, Node 26
and verbatim quickstart jobs must pass too. Coverage remains its existing optional job.
No local project tooling was run for this migration. Root and a fresh independent reviewer
must review the full candidate and subsequent fix deltas. Only after that and complete hosted
qualification may root ask the owner to approve the released-profile change. This draft is
not merge authorization and does not close #449.
