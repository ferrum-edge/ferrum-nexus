# Edge client response contracts

The Admin API client (`server/src/ferrum-admin/client.ts`) checks the status
code and JSON shape of every Ferrum Edge response before returning data. This
page lists what each call accepts. Error classification in general is in
[`architecture.md` §5.1](architecture.md#51-the-admin-jwt-contract).

## General rules

- **Protocol failures** throw `NexusError` with code `EDGE_PROTOCOL_ERROR`,
  HTTP 502 and `details.kind: "protocol_error"`. Diagnostics hold only the
  upstream status and a fixed reason; never response bytes, redirect locations
  or parser messages.
- **UTF-8.** Successful JSON bodies must be valid UTF-8; decoding fails closed
  rather than replacing malformed bytes inside identities or credentials. Legal
  JSON Unicode escapes keep their normal meaning. Allowed-absence (`404`) and
  tolerated-status checks run before decoding. Prometheus text keeps its own
  decoding.
- **Limits.** JSON responses are capped at 16 MiB. Redirects are not followed.
- **No write retries.** A failed acknowledgement does not show whether a write
  was applied, so writes are never retried.

The contracts were checked against Ferrum Edge commit
`46782aa7d585357297a20cd63bbce5687fed81cb`: the resource handlers in
`src/admin/crud.rs`, the credential/namespace/probe handlers in
`src/admin/mod.rs`, `src/admin/api_specs/handlers.rs`, `src/admin/metrics.rs`,
and the response projections in `src/config/types.rs`.

## Per-call contracts

| Call                                                | Accepts                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `consumers.get`, `proxies.get`, `pluginConfigs.get` | `200` with a resource of the expected shape, id and namespace. Only `404` returns `null`; `204`, empty or invalid JSON, JSON `null` and other shapes throw.                                |
| Resource lists, `listNamespaces`                    | `200` with typed `data` entries and consistent `pagination` counters. Only a valid empty page is empty.                                                                                    |
| `consumers.getByUsername`                           | Valid consumer pages, scanned to a match or the end. `null` only after a complete scan with no match; malformed pages and hitting the scan cap throw.                                      |
| `consumers.ensure`                                  | `GET` by the derived UUID, then create on `404`. Only a create `409` falls back to the legacy username scan; other errors propagate with no retry. An existing id must match the username. |
| `pluginConfigs.listByProxy`                         | Valid pages of `GET /plugins/config?proxy_id=` (Edge v0.9.7+, which pages and totals the filtered set). Every page is read, up to the 50-page cap.                                         |
| `apiSpecs.findByProxy`                              | `200` with typed `items` (not `data`), consistent flat counters and matching `proxy_id`. Only a valid empty page returns `null`.                                                           |
| Resource, spec and namespace create                 | `201` with the resource or spec reference. Empty bodies are invalid. Namespace setup alone tolerates `409`/`501`.                                                                          |
| Resource and spec replace                           | `200` with the resource or spec reference. Empty bodies are invalid.                                                                                                                       |
| Credential append, replace, delete by index         | `200` with a consumer. Delete by index also requires a body.                                                                                                                               |
| Resource delete, whole credential-type delete       | `204` with no content. Proxy, plugin and spec deletes also accept `404`; consumer and credential deletes treat `404` as an error.                                                          |
| `health`                                            | `200` or `503` with a health object. A health-shaped `503` means reachable but not ready; anything malformed throws.                                                                       |
| `live`                                              | `200` with `{"status":"ok"}` or an empty body. `404` is `false`; other bodies and statuses throw.                                                                                          |
| `version`                                           | `200` with a non-empty `version` string. `404`/`405` return `null` (Edge has no version endpoint).                                                                                         |
| `ensureNamespace` lookup                            | `200` with a namespace object. Only `404` starts creation. Failures are logged and swallowed, because resource writes create namespaces implicitly.                                        |
| Metrics, combined probe                             | A valid telemetry or health response. Failures become unavailable telemetry or an unreachable probe, never "resource absent".                                                              |

Edge's OpenAPI exposes only `offset`/`limit` on `GET /consumers` and ignores
unknown query keys. The mock Edge (`server/src/test/mock-ferrum-edge.ts`)
rejects unknown filters on both `GET /consumers` and `GET /plugins/config`, so
tests catch accidental reliance on filtering.

## Proxy and plugin bodies

Resource validation keeps unmodelled fields, because Nexus writes whole
resources back with `PUT`.

**Proxy `plugins` must be present.** A proxy response must include a valid
`plugins` association array (`[]` when empty). A missing, `null` or malformed
array fails before the binder builds a replacement body that would drop
existing security associations. Edge always serializes it. Nullable
`listen_path` on non-HTTP proxies and unrelated fields are accepted. On the
write side, Edge's `PUT` preserves associations when `plugins` is omitted and
clears them when it is an explicit `[]`.

**Plugin `config` may be `null`** on Edge for plugins without settings;
response and write types accept it. Binder attach, proxy-rebuild restore and
rollback preserve an operator's `null` config. Composed `EdgePluginSettings`
stay object-only: optional-plugin reconciliation uses a separate `null`
argument to mean removal, while restores write the saved config directly. The
palette reads its settings from Nexus storage, and the publishing spec filter
passes Edge configs through unchanged.

Consumer credential types that Edge's response projection hides need not
appear in the `credentials` map.

## API-spec errors

API-spec error bodies follow Edge's `ApiSpecParseError` shape: `error` is the
category, string `details` the explanation, and `code` the machine-readable
discriminant. Validation failures carry `failures[]` with `resource_type` and
`errors[]` instead.

For API-spec writes rejected with a 4xx status (other than `401`/`403`), the
client returns `EDGE_REJECTED_SPEC` with only the HTTP status. Other Edge errors
also use fixed messages and safe status details. Error response text and
response objects are omitted from logs because Edge may echo submitted secrets.

## Upload limits

The upload validator applies the 2,000-character upstream URL limit to
expanded server URLs as well, leaving headroom below Edge's 2,048-character
backend path limit. Specs are limited to 200 levels of object/array nesting,
checked iteratively for both JSON and YAML before anything is stored or sent to
the gateway. Request serialization failures map to `INTERNAL`, outside the
transport error handling.

## Tests

- `server/src/ferrum-admin/client.protocol.test.ts` — the socket-level response
  matrix.
- `server/src/ferrum-admin/client.test.ts` — binder restore and rollback of
  `null` configs over HTTP, and a relay that drops `plugins` from a stored proxy
  to prove association fails before any proxy `PUT` and succeeds on a complete
  read.
- `server/src/test/gateway-protocol-teardown.test.ts` — pending work and
  recovery through the teardown service and worker.
