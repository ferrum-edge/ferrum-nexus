# Proposed service-manifest preview

Nexus implements only its consumer portion of Alloy #27. The contract remains
PROPOSED; this is not a v1 freeze or a released-format claim. The immutable source is
`contracts-edge-0.9.9-r2`, commit `591c73a3f965fdab440c3a76b2707accdf491ba5` in
ferrum-contracts. `SERVICE-MANIFEST-PIN` records SHA-256 for the schema, every shared
valid/invalid fixture, and the shared invalid-expectations file. Existing Edge
vocabulary pins are unchanged.

Providers and administrators submit the manifest's JSON data model to the authenticated
preview endpoint; TOML/file parsing is not offered. Namespace authorization uses the
single configured portal namespace. Validation is strict before applying defaults and
adds bounded canonical-path/reference/presentation checks. The response contains only
redacted summary hints. OpenAPI references and agent metadata are informational and
cannot select/publish tools. TLS paths are never resolved or read; URLs are never fetched.
No manifest, diagnostic report, trace or secret is stored. Anvil diagnostic import is
still outstanding, so cross-repository Alloy #27 must remain open.

Hosted tests verify integrity, all shared fixtures, explicit null/unknown/schema/method/
protocol negative controls, bounds, authentication, authorization, CSRF, redaction and
absence of gateway writes. The packaged-image acceptance gate exercises this endpoint
with the vendored contract asset present. Node 22.14 remains the compatibility floor.
