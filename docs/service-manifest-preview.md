# Unreleased service-manifest preview

Nexus [#519](https://github.com/ferrum-edge/ferrum-nexus/pull/519) implements its
consumer portion of [Alloy #27](https://github.com/ferrum-edge/ferrum-alloy/issues/27).
The preview is Unreleased and the cross-repository manifest contract remains
PROPOSED; this is not a v1 freeze or a released-format claim. The immutable source is
`contracts-edge-0.9.9-r2`, commit `591c73a3f965fdab440c3a76b2707accdf491ba5` in
[ferrum-contracts](https://github.com/ferrum-edge/ferrum-contracts/tree/591c73a3f965fdab440c3a76b2707accdf491ba5).
[`SERVICE-MANIFEST-PIN`](../contracts/ferrum-contracts/SERVICE-MANIFEST-PIN) records
SHA-256 for the schema, every shared manifest valid/invalid fixture, and the shared
invalid-expectations file. The separate Edge vocabulary
[`PIN`](../contracts/ferrum-contracts/PIN) remains at `contracts-edge-0.9.9`, commit
`25c4e9e00033d7941a1dd0ab733fa74e735546ae`.

## Preview boundary

Providers and administrators submit the manifest's JSON data model to the authenticated
`POST /api/service-manifests/preview` endpoint with session and CSRF authorization;
TOML/file parsing is not offered. Namespace authorization uses the
single configured portal namespace. Validation is strict before applying defaults and
adds bounded canonical-path/reference/presentation checks. The response contains only
redacted summary hints. OpenAPI references and agent metadata are informational and
cannot select/publish tools. TLS paths are never resolved or read; URLs are never fetched.
No manifest, diagnostic report, trace or secret is stored.

## Cross-repository status

[Anvil #312](https://github.com/ferrum-edge/ferrum-anvil/pull/312) merged on
2026-10-04 at 16:22:43 UTC as `c19c0a6abba896bfec972b3e083179c55ef8e38c`.
Its diagnostic JSON preview consumer is implemented; it is no longer outstanding.
Root qualified its final head `591cb7343dc2cac3a3b540cdc7ba4dd7f2826c0d` with
whole-change and fresh independent reviews, all 14 hosted checks, all three workflows
and all seven required contexts passing, and zero review threads. Native code
qualification at `925e96253d36ea69a5f52a83a9c21602bb7557e4` executed all 14
diagnostic cases and all 11 spec files on Linux, macOS and Windows; final-head hosted
checks were repeated after its documentation update.

Anvil consumes the same published canonical r2 commit
`591c73a3f965fdab440c3a76b2707accdf491ba5` and covers all 27 canonical fixtures.
Its real Alloy producer golden came from source
`0c260f5379939ff46d681666bfbcd65b8518b08d`,
[run 37208769030](https://github.com/ferrum-edge/ferrum-alloy/actions/runs/37208769030),
artifact `11305688717`. Root verified archive identity, hashes and actual producer
sources. These are diagnostic-consumer qualification facts, not a manifest v1 freeze.

Nexus #519 is also qualified and merged, as recorded below. Alloy #27 remains open.
The cross-repository manifest contract remains PROPOSED pending the canonical
tracking/freeze decision and root's tracking-issue update. Neither consumer's merge
freezes the contract. No new release, image, tag or Edge API is introduced here.

## Nexus qualification

The Nexus test suite covers integrity, all shared manifest fixtures, explicit
null/unknown/schema/method/protocol negative controls, bounds, authentication,
authorization, CSRF, redaction and
absence of gateway writes. At `0c05113fdaa34bcce2c7ee5780191447359f105e`,
[packaged acceptance job 111474199807](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37215210346/job/111474199807)
passed with this endpoint and the vendored contract asset in the production image.
The executed subset/store qualification and its limits are recorded in the
[unreleased rollout](mcp-subsets-migration-draft.md#hosted-qualification-and-final-gate).
Those passed jobs do not claim all CI checks at that commit are green. Final PR #519
head `77fdb767ec8ef04e88f13df9fb291bc77fbd0344` subsequently passed all 11 hosted
checks across [CI 37221116488](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37221116488)
and [Verbatim quickstart 37221116610](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37221116610),
including all eight protected Actions contexts. Root completed whole and fresh independent
reviews with zero unresolved threads before merging it as
`559c350a5370335791cdc3082225dce6056cf547` on 2026-10-04 at 17:42:42 UTC.
Main's Node 22.14 minimum and the existing Edge v0.9.10 image digest were retained.

This higher-floor candidate integrates that qualified consumer without source or fixture
edits. Its combined head still requires all fresh hosted gates and root and independent
review under the separate [Node proposal](dependency-majors-449-higher-floor-draft.md#main-integration-and-current-gates).
Owner approval remains pending; prior main qualification does not approve this profile
or qualify the combined candidate.
