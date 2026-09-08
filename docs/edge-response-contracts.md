# Edge client response contracts

The Admin API client validates the status and JSON shape before returning data.
Protocol failures are `NexusError` instances with code `EDGE_PROTOCOL_ERROR`, HTTP status
502, and `details.kind: "protocol_error"`. Diagnostics contain the upstream status
and a fixed reason, never response bytes, redirect locations or parser messages.
Successful JSON responses must contain valid UTF-8 bytes; decoding fails closed
instead of replacing malformed bytes inside identities or credentials. Legal JSON
Unicode escapes retain their existing semantics. Safe absence and tolerated-status
exceptions run before decoding; text metrics retain their existing decoding.
JSON responses are limited to 16 MiB. Redirects are not followed. The client does
not retry writes: a failed acknowledgement does not establish whether a write
was applied.

The contracts were checked against Ferrum Edge commit
`46782aa7d585357297a20cd63bbce5687fed81cb`: `src/admin/crud.rs` resource handlers,
`src/admin/mod.rs` credential/namespace/probe handlers,
`src/admin/api_specs/handlers.rs`, `src/admin/metrics.rs`, and the response
projections in `src/config/types.rs`.

- `consumers.get`, `proxies.get`, `pluginConfigs.get`: 200 with a resource of the
  expected shape, identity and namespace. Only HTTP 404 returns `null`; 204,
  empty/invalid JSON, JSON `null` and other shapes throw.
- Resource lists and `listNamespaces`: 200 with typed `data` entries and coherent
  `pagination` counters. Only a valid empty page is empty.
- `consumers.getByUsername`: valid consumer pages, scanned to completion or a
  match. `null` requires a completed scan without a match; malformed pages and
  the existing scan cap throw.
- `pluginConfigs.listByProxy`: valid plugin pages filtered by proxy. Empty
  results require valid pages; the existing 50-page scan cap is unchanged.
- `apiSpecs.findByProxy`: 200 with typed `items`, coherent flat counters and
  matching `proxy_id`. Only a valid empty filtered page returns `null`; Edge
  uses `items`, not `data`.
- Resource/spec/namespace create: 201 with the corresponding resource or spec
  reference. Empty bodies are invalid. Namespace setup alone tolerates 409/501.
- Resource/spec replace: 200 with the corresponding resource or spec reference.
  Empty bodies are invalid.
- Credential append, replace, delete by index: 200 with a consumer. Even DELETE
  by index requires a body.
- Resource delete and whole credential-type delete: 204 with no content. Proxy,
  plugin and spec deletes additionally tolerate 404; consumer and credential
  deletes retain their existing error on 404.
- `health`: 200 or 503 with a health object. A health-shaped 503 means reachable
  but not ready; malformed responses throw.
- `live`: 200 with `{"status":"ok"}` or an empty status-only acknowledgement.
  404 is `false`; invalid bodies and other statuses throw. Current Edge emits
  the JSON object.
- `version`: 200 with a nonempty version string. 404/405 return `null` because
  current Edge has no version endpoint. Other malformed responses throw.
- `ensureNamespace` lookup: 200 with a namespace object. Only 404 starts
  creation. Failures remain logged and swallowed because resource writes
  implicitly create namespaces.
- Metrics and combined probe: valid telemetry/health response. Their public
  best-effort contracts remain: failures become unavailable telemetry or an
  unreachable probe. No failure is resource absence.

Resource validation preserves unmodelled fields for whole-resource replacement.
Proxy responses must include a valid `plugins` association array, including `[]`
when no plugins are associated. Missing, null or malformed snapshots fail before
the binder can construct a replacement that drops existing security associations.
Edge always serializes this array; nullable `listen_path` on non-HTTP proxies and
unrelated wire fields remain accepted. This response requirement is distinct from
Edge's PUT behavior: omitting `plugins` preserves associations, while an explicit
empty array clears them.
Plugin configurations may legitimately be `null` on Edge for plugins without
settings; response and write types accept these values. Binder attach, proxy-rebuild
restore and rollback preserve the operator's actual `null` config. Composed
`EdgePluginSettings` remain object-only: optional-plugin reconciliation uses a
separate `null` argument to mean removal, while restoration writes the saved config
directly. The palette reads its settings from Nexus storage, and the publishing
spec filter carries Edge configs through unchanged. Consumer credential types
hidden by Edge's response projection are not required to appear in the map.

The socket response matrix lives in
`server/src/ferrum-admin/client.protocol.test.ts`. API-spec error bodies follow
Edge's `ApiSpecParseError` shape: `error` is the category, string `details` is
the explanation, and `code` is the machine-readable discriminant. Validation
failures instead contain `failures[]` with `resource_type` and `errors[]`.
For POST/PUT API-spec writes, 4xx parse/validation categories map to
`400 EDGE_REJECTED_SPEC`, except 401/403. Public summaries include string details
and each resource's first error within 500 characters, with a separately bounded
`gateway_code`. The full parsed structure stays in the server log, bounded by
the existing 16 MiB response limit. Flat errors retain their previous mapping;
5xx and authentication errors remain opaque 502 responses.

The upload validator uses the typed upstream URL's 2,000-character limit for
expanded server URLs too. This keeps one input rule regardless of source and
leaves headroom below Edge's 2,048-character backend path ceiling. A 200-level
object/array nesting limit leaves generous serialization stack headroom; the
iterative check covers both JSON and YAML before persistence or gateway writes.
Request serialization failures independently map to `INTERNAL`, outside the
transport error handler.

Binder restoration and rollback of nullable configs over HTTP are covered in
`server/src/ferrum-admin/client.test.ts`.
That suite also uses the mock Edge behind an HTTP relay to omit only `plugins`
from a stored proxy snapshot, proving association fails before any proxy PUT and
the original security associations remain effective, then succeeds on a complete read.
The separate
`server/src/test/gateway-protocol-teardown.test.ts` checks pending work and recovery
through the existing teardown service and worker. These tests run in hosted CI;
no local project execution was used to prepare this change.
