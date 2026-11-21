# Service-manifest preview

Nexus `v0.4.0` ships a read-only preview of Ferrum service manifests, the Nexus
consumer portion of [Alloy #27](https://github.com/ferrum-edge/ferrum-alloy/issues/27),
implemented in [#519](https://github.com/ferrum-edge/ferrum-nexus/pull/519). Its shared
v1 contract is published in `contracts-edge-0.9.20`, commit
`39da322083044c2e92617209e62983c92387f0ad` in
[ferrum-contracts](https://github.com/ferrum-edge/ferrum-contracts/tree/39da322083044c2e92617209e62983c92387f0ad).
The manifest schema and fixtures are byte-identical to `contracts-edge-0.9.12`; the
shared `fixtures/invalid-expectations.json` changes only in other contracts' entries.
The vendored [`PIN`](../contracts/ferrum-contracts/PIN) records SHA-256 for the
schema, every shared manifest fixture and the shared expectations, with every other
vendored contract file of the same publication. The copied `x-contract` metadata records the implemented shared
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

## Checks beyond the pinned contract

The preview also refuses what the producer or Ferrum Edge refuses, qualified against
ferrum-alloy `main` at `2b206a4616586b6193d25958b646e2478fc40a94`
(`ServiceManifest::validate`) and Ferrum Edge `main` at
`812bbd1a01677525d7b664ba46ba574f546efe6b`:

- **Cleartext telemetry.** `gateway.otel_endpoint` must use `https://`, or `http://` to a
  canonical loopback IP literal (`127.d.d.d` or `[::1]`, optionally with a numeric port).
  Edge v0.9.19 and later drop a cleartext exporter to any other host, `localhost`
  included, unless `allow_plaintext` is set, which Alloy's export never writes; Alloy
  refuses the manifest. The pinned `contracts-edge-0.9.20` still publishes
  `valid/orders-api.json` with `http://otel-collector:4318/v1/traces`, so the preview
  refuses that one shared valid fixture until ferrum-contracts#82 (which moves it to
  `https://`) is published and re-vendored.
- **Derived resource IDs.** Alloy derives `<proxy_id>-otel-tracing` for every export,
  with or without an exporter, plus `<proxy_id>-upstream` with a health check and
  `<proxy_id>-correlation-id` with correlation on. Each must fit Edge's 254-character
  resource ID limit, so an explicit `gateway.proxy_id` is at most 241 characters (239
  with correlation on).
- **Edge field bounds.** `api.public_path` at most 500 characters, `api.service_base_path`
  2049 (Edge's 2048-byte `backend_path` plus the trailing `/`), `upstream.host` 255,
  `health.path` 2048, `health.interval_seconds` 3600, and `health.timeout_ms` and every
  `timeouts.*` 86400000. ferrum-contracts `main` publishes the same bounds in the v1
  schema (ferrum-contracts#74) but no tag carries them yet; a bound the vendored schema
  declares itself always wins, and it is never clipped.

Intentionally narrower than v1: strings the schema leaves unbounded are capped at 2048
characters; every string refuses C0 control characters and DEL, `upstream.host`
included (Edge allows tab, LF and CR there); and `gateway.otel_endpoint` refuses user
information, a query and a fragment, since the preview never echoes it and a query is a
common place for a token.

## Related consumers

Choose the preview by what you have:

- **A service manifest** (the JSON data model of `ferrum.service_manifest` v1): this Nexus
  preview, or Foundry's Settings → Alloy Service Manifest card, documented in the
  [Foundry manifest preview guide](https://github.com/ferrum-edge/ferrum-foundry/blob/main/docs/alloy-manifest-preview.md).
  Both consume the same shared service-manifest schema and fixtures.
- **A diagnostic report**: Anvil's desktop Import → Diagnostic preview. It consumes the
  separate shared diagnostic contract, not service manifests, and refuses a manifest as
  "Cannot preview this input." Its accepted inputs are a `ferrum.diagnostic_report` 1.x
  report, a standalone `DiagnosticFinding`, a `ferrum.diagnostic_ref.v1` reference and the
  Alloy `diagnose --format json` envelope, as listed in Anvil's
  [shared diagnostic import](https://github.com/ferrum-edge/ferrum-anvil/blob/main/docs/architecture/shared-diagnostics-import.md)
  guide. [Anvil #312](https://github.com/ferrum-edge/ferrum-anvil/pull/312), merged on
  2026-10-04 as `c19c0a6abba896bfec972b3e083179c55ef8e38c`, introduced it against
  `contracts-edge-0.9.9-r2` and covered all 27 canonical diagnostic fixtures of that
  publication; that count describes the diagnostic contract at that revision, not the
  manifest fixtures.

Alloy's own producer and any apply path are tracked in Alloy #27 and are not part of
Nexus: the preview never publishes, applies or stores a manifest.

## Tests

The Nexus test suite covers integrity, all shared manifest fixtures, explicit
null/unknown/schema/method/protocol negative controls, bounds, authentication,
authorization, CSRF, redaction and absence of gateway writes. The packaged acceptance
suite runs the endpoint with the vendored contract asset in the production image.
