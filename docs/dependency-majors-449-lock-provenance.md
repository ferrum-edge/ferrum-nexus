# Hosted lock provenance for issue #449

The owner has approved jsdom 30.1.2 / Undici 8.11.2 and the current unreleased supported
Node range `^22.22.2 || ^24.15.0 || >=26.0.0`. Prior head `059b428` is qualified below;
fresh hosted qualification and review remain pending for this documentation adoption head.
Published releases retain their historical Node 22.14+ profile until a new release ships.

## Historical first-stage artifact; higher-floor locks imported

The records below preserve PR #518's historical lock provenance. This candidate's locks were
originally imported byte-for-byte at `bc389dfe1510692057793930817d35d0c1e18f6a` from verified
artifact `11308824128`, produced by
[run 37217928511, attempt 1](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37217928511)
from source `15c47ec5f92d47fa6d491d4cc8f16fa2aa1e50ec` on Node `v22.22.2` / npm `10.9.7`.
The root lock resolves jsdom 30.1.2 and Undici 8.11.2; both include the now-approved workspace engines.
The archive SHA-256 is `06cfb6dd727d02621f026c45c6ba495f4c414803dc08a61a676dfb5809e43bba`;
the [historical import notes](dependency-majors-449-higher-floor-draft.md#hosted-lock-import-qualification-pending)
record the verified input/output manifests and full import facts. The
[main integration record](dependency-majors-449-higher-floor-draft.md#main-integration-and-current-gates)
preserves that producer/source binding, the prior PR #519 integration and its qualification,
and the current PR #523 merge inputs. The root lock retains the imported hash; the e2e lock
now incorporates only main's verified Node typings patch while retaining the approved engine range.
Its current hash differs from the original higher-floor output. Parent `d3347dc` passed all
15 hosted checks. Combined-head qualification and owner approval were pending at that stage;
the later `059b428` qualification and explicit owner approval supersede that historical status.

## Historical PR #523 producer and integration

Main `1a908ea5c81e4685622345954266268684255b86` merged PR #523's qualified source
`27e4312e97f585e1a2da83d231730033f285e9a8`. Its
[producer run 37284706045, attempt 1](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37284706045)
used Node `v22.14.0` / npm `10.9.2`, strict engines and no lifecycle scripts. Root verified
artifact `11333906619`, archive SHA-256
`9d2b39759f335280bd2dd06e3bc8ed7a251cf2c67885cecd4a359e024ce0116d`, every input/output
hash and both output locks byte-for-byte against that source. The complete output diff was empty:

```text
6aa9d160035c01ee2863ecedb3c0cb9a08097958d1a42c0230712f155d5a4a0b  package-lock.json
48444847efb1d6252f0ae60c064712402caf0ec0dcabd15ee57d6fc80893ea3b  e2e/package-lock.json
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  locks.diff
```

These historical main outputs retain their original identity; they are not current candidate
outputs. The normal merge incorporates main's e2e `@types/node` 22.20.4 to 22.20.5 patch
without regenerating either graph. It combines the deterministic producer with the candidate's
Node 22.22.2 witness and exact jsdom/Undici guards. Current candidate lock hashes are:

```text
0ed9c2de1dab8e5828e496a135fc1b67f91d2191f4c986e3ea79b19b5e8e6a12  package-lock.json
4f37d761e1d573e90e2667de9df142f420917b81c6f2d059dd78b975ca2cf36e  e2e/package-lock.json
```

The migration notes record all ten producer-input hashes retained at `059b428` and unchanged
by this documentation adoption. Both historical artifact records keep their original source
identities and hashes. Their Node 22.14 and original higher-floor producer records are not
rewritten by the subsequent qualification or owner approval.

## Qualified prior-head producer and current documentation status

[Producer run 37290169451, attempt 1](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37290169451)
checked out exact source `059b4284bf0aeb003f61a57c11ca9be70140c167` in repository
`1244400882` (`ferrum-edge/ferrum-nexus`) and used Node `v22.22.2` / npm `10.9.7`.
Artifact `11336281445` is named
`dependency-locks-059b4284bf0aeb003f61a57c11ca9be70140c167`; its archive SHA-256 is
`759eb689a394aac309cc431ceb3c6648164bf8e16f2f9022cc11647dce900244`.
Root verified the exact repository/source/run binding, all ten input and three output hashes,
and both complete input/output/current locks byte-for-byte. Its complete output diff is empty:

```text
0ed9c2de1dab8e5828e496a135fc1b67f91d2191f4c986e3ea79b19b5e8e6a12  package-lock.json
4f37d761e1d573e90e2667de9df142f420917b81c6f2d059dd78b975ca2cf36e  e2e/package-lock.json
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  locks.diff
```

That exact prior head passed all 15 hosted checks across CI `37290169452`, producer
`37290169451` and verbatim quickstart `37290169560`, and completed full root and fresh
independent review. The [qualification record](dependency-majors-449-higher-floor-draft.md#qualified-prior-head-and-current-documentation-head)
links those runs and preserves the review history. The explicit owner approval is current;
the earlier pending decision is historical. No new lock import is needed.

This documentation adoption changes no source, producer input, manifest or lock. Its hosted
qualification, full root review and fresh independent review remain pending. No artifact or
successful gate is claimed for the new documentation head; root owns those post-push gates.

## PR #518 provenance

In PR #518, both locks were copied byte-for-byte from the successful
[producer run 37205184516, attempt 1](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/37205184516).
The producer checked out source commit `d3114c2a439cbd0e7581666efb1309de34975cb1`, used
Node `v22.14.0` and npm `10.9.2`, disabled lifecycle scripts, and enabled strict engine checks.
No local npm, Node, compiler, formatter, build or test command generated these files.

Artifact id: `11303763958`.
Artifact name: `dependency-locks-d3114c2a439cbd0e7581666efb1309de34975cb1`.
GitHub's artifact digest: `sha256:440c39d8fcfea469e59628f07461c5a2c78a298576728299cd3629c7990f1964`.
The artifact includes both output locks, `locks.diff`, the original root input lock, and provenance
manifests. Its retention is 14 days; preserve the downloaded artifact for longer-lived review.

All input hashes were verified against the clean source checkout before copying the locks, and
all three output hashes were verified against the downloaded artifact. The input manifest is:

```text
6b059f2370a5db9d1cfa66acb09fa21419d641f81a4ea55844e8a0b940eb5034  package.json
5eb14be4fc972c1c444652d58fdb82193ef3b89181a5eae543db62a22820cc20  shared/package.json
0e304504be48b19f8f0cb2ceb7d258df32ffb8e01d531604c606804b6d73435f  server/package.json
973859247d02f04fa2187751186e5df218a08be11734df0834750ca9dd8d3d28  web/package.json
cb6b866185479c5d41f4004e7106fc8fa1e7d81f6daad9a03c6430f3de03ef4f  e2e/package.json
6ccc6f9085ef6067a79cfb959b56e09057cb5afc157f4a620b42b09f0e040374  package-lock.json
bed482f4027e4d98954f7209facfc73e38d140040dff0df250262bb3f293ec2e  e2e/package-lock.json
3e12d094ed325287e3a8f68f59861ee4d942d50c14df031d14700db0f7e5f7ff  .github/workflows/dependency-locks.yml
```

The output manifest is:

```text
6aa9d160035c01ee2863ecedb3c0cb9a08097958d1a42c0230712f155d5a4a0b  package-lock.json
f26b2b4bc2f68800b0a6add2c850947ef92fa71fe51ac3a173a21986aad56a7f  e2e/package-lock.json
325b159e0ac3ada0678a4eba4999f0ecc71a45fb8cdf7a9bb125e84a87e1a12d  locks.diff
```

The root graph was resolved afresh because in-place npm 10 updates retained a Vitest 4 optional
peer cycle or failed peer resolution. This also refreshed other versions admitted by the existing
manifest ranges, including Vite 8.3.2, Undici 7.30.0, Nodemailer 10.0.14, pg 8.23.1, Node typings
22.20.5 and TanStack Query/Router patches. Those movements required whole-diff review and the
normal hosted runtime/store/acceptance gates; the engine-compatible producer is not evidence
that application tests pass. The `e2e` graph retained its other locked dependencies.

The PR #518 producer confirmed TypeScript 7.0.2, Zod 4.6.5, React Table 9.2.5 and matched
Vitest peers 5.0.3, with independently versioned Istanbul libraries. That artifact resolved
jsdom 26.1.0 and Undici major 7. Application qualification and independent review of the
audit scanner, security implications and new test logic were separate gates. No required
CI check or baseline was changed in that first stage.
