# Service-manifest preview

Nexus `v0.4.0` ships a read-only preview of Ferrum service manifests, the Nexus
consumer portion of [Alloy #27](https://github.com/ferrum-edge/ferrum-alloy/issues/27),
implemented in [#519](https://github.com/ferrum-edge/ferrum-nexus/pull/519). Its shared
v1 contract is published in `contracts-edge-0.9.13`, commit
`9626821eb089c71f5d4d71268c7b8276a8a5ab50` in
[ferrum-contracts](https://github.com/ferrum-edge/ferrum-contracts/tree/9626821eb089c71f5d4d71268c7b8276a8a5ab50).
The manifest schema and fixtures are byte-identical to `contracts-edge-0.9.12`.
[`SERVICE-MANIFEST-PIN`](../contracts/ferrum-contracts/SERVICE-MANIFEST-PIN) records
SHA-256 for the schema, every shared manifest fixture and shared expectations.
The separate Edge vocabulary [`PIN`](../contracts/ferrum-contracts/PIN) adopts
the same publication. The copied `x-contract` metadata records the implemented shared
status. The response reports `contract_status: "implemented"` and the exact adopted
canonical commit without implying production apply.

## Preview boundary

Providers and administrators submit the manifest's JSON data model to the authenticated
`POST /api/service-manifests/preview` endpoint with session and CSRF authorization;
TOML/file parsing is not offered. Namespace authorization uses the
single configured portal namespace. Validation is strict before applying defaults and
adds bounded canonical-path/reference/presentation checks. The response contains only
redacted summary hints. OpenAPI references and agent metadata are informational and
cannot select/publish tools. TLS paths are never resolved or read; URLs are never fetched.
No manifest, diagnostic report, trace or secret is stored.

## Related consumers

[Anvil #312](https://github.com/ferrum-edge/ferrum-anvil/pull/312), merged on
2026-10-04 as `c19c0a6abba896bfec972b3e083179c55ef8e38c`, implements a diagnostic
JSON preview consumer of the same shared contract and covers all 27 canonical fixtures.
Alloy's own producer and any apply path are tracked in Alloy #27 and are not part of
Nexus: the preview never publishes, applies or stores a manifest.

## Tests

The Nexus test suite covers integrity, all shared manifest fixtures, explicit
null/unknown/schema/method/protocol negative controls, bounds, authentication,
authorization, CSRF, redaction and absence of gateway writes. The packaged acceptance
suite runs the endpoint with the vendored contract asset in the production image.
