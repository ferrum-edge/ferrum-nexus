# Agent marketplace: published MCP contract and subset grants

Issue [#446](https://github.com/ferrum-edge/ferrum-nexus/issues/446) exposes explicitly
selected API operations as MCP tools. Agents are off by default. This document
records the published Edge dependency and what the test suites cover.

## Published dependency

The MCP contract Nexus uses (the OpenAPI bridge, ACL-group tool grants and MCP
governance) was first published in
[Edge v0.9.10](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.10), whose
tag resolves to `ee040d5e3281fde424aa65f5b18004852c5b53b0`; the source links below
point at that release. Nexus `v0.5.2` pins Edge v0.9.15 (Nexus `v0.5.0` and `v0.5.1`
pinned Edge v0.9.14, and `v0.4.0` Edge v0.9.13) in
[`release/compatibility.env`](../release/compatibility.env); the packaged acceptance suite
runs the agent journeys against the pinned image.

From Edge v0.9.15 an agent-enabled API serves MCP and its REST operations over HTTP
only. Its `mcp_gateway`, blocking `openapi_validator`, `ai_tool_governor`,
`ai_prompt_shield` and tool-call `rate_limiting` configs gate admission and run on
HTTP requests only, so Edge refuses a native WebSocket request to that proxy with
`403` and a native gRPC request with a trailers-only `PERMISSION_DENIED` (gRPC
status 7), both with rejection phase `route_protocol_admission`, instead of serving
it without that governance. Aggregate MCP sessions keep Edge's default cap of 128 per
authenticated principal (`sessions.max_sessions_per_principal`, which Nexus does not
set); at the cap the principal's oldest session is replaced. When the gateway-wide
session store is full, a caller with no session to replace is refused instead of
evicting another caller's session.

Primary source contracts (Edge v0.9.10):

- [API spec importer and MCP extensions](https://github.com/ferrum-edge/ferrum-edge/blob/ee040d5e3281fde424aa65f5b18004852c5b53b0/src/admin/api_specs/extractor.rs)
- [MCP gateway policy and validation](https://github.com/ferrum-edge/ferrum-edge/blob/ee040d5e3281fde424aa65f5b18004852c5b53b0/src/plugins/mcp_gateway.rs)
- [REST bridge methods, argument mapping and dispatch](https://github.com/ferrum-edge/ferrum-edge/blob/ee040d5e3281fde424aa65f5b18004852c5b53b0/src/plugins/mcp_openapi_bridge.rs)
- [Tool governor](https://github.com/ferrum-edge/ferrum-edge/blob/ee040d5e3281fde424aa65f5b18004852c5b53b0/src/plugins/ai_tool_governor.rs)
- [Argument shield](https://github.com/ferrum-edge/ferrum-edge/blob/ee040d5e3281fde424aa65f5b18004852c5b53b0/src/plugins/ai_prompt_shield.rs)
- [MCP tool-call counting](https://github.com/ferrum-edge/ferrum-edge/blob/ee040d5e3281fde424aa65f5b18004852c5b53b0/src/plugins/rate_limiting.rs)

## Exact configuration boundary

Nexus supplies document `x-ferrum-mcp` keys `enabled`, `endpoint.path` and
`namespace`. Each operation has explicit `expose`; selected operations additionally
have `name`, `description` and `annotations.readOnlyHint`/`destructiveHint`.
Provider-supplied gateway extensions do not select operations or configure policy.
The bridge supports GET/POST/PUT/PATCH/DELETE. HEAD is read-only but cannot be
bridged on this release; the picker shows it disabled. Options and trace are also
unavailable. Supporting HEAD is a future Edge dependency, not an invented API.

The embedded gateway uses `mode: aggregate_router`, an exact `endpoint.path`,
`policy.default_action: deny`, `policy.hide_denied_tools: true`, and an
`action: allow` entry for each selected public namespaced tool, with
`allowed_groups: [nexus:api:<id>:mcp:all, nexus:api:<id>:mcp:tool:<exposure-id>]`.
The ordinary REST approval group is never a tool policy group. Only tools are advertised; resources, prompts,
logging, completions, tasks and unknown-method passthrough are disabled. Argument
validation is enabled. Raw arguments and argument hashes are not enabled in
gateway observability.

The governor uses `mode: enforce`, `default_action: deny`,
`inspect.mcp_tool_calls: true`, `inspect.response_tool_calls: false`, selected
namespaced tools with `action: allow` and low/high risk, plus
`observability.hash_arguments: false` and `max_argument_log_bytes: 0`. The shield
uses `action: reject`, `scan_fields: mcp_arguments`, sensitive-data `patterns`
and `max_scan_bytes: 1048576`. The separate `rate_limiting` config uses
`limit_by: consumer`, one default rule with `window_seconds: 60` and
`max_requests: 60`, and **`mcp_tool_calls.endpoint_path`** to count calls instead
of transport requests. With operator Redis sync it also uses `sync_mode`,
`redis_url`, `redis_tls`, `redis_failure_policy: fail_closed` and a stable
API-specific `redis_key_prefix`. Local counters are per Edge process.

The importer rejects combining `x-ferrum-validate` with `x-ferrum-mcp`.
Nexus embeds `openapi_validator` with `enforcement_mode: block`, request/response
validation false, `fail_on_unknown_operation: true`, literal-prefix operation
matchers and `bypass.paths` containing only the anchored exact MCP endpoint.
This preserves the REST route gate while the MCP gateway claims that endpoint.
The governor, shield and budget each have an exact-path trigger. Transcript audit
sinks and remote approval configuration remain operator-owned.

## MCP client and denial contract at the pin

The released gateway defaults `endpoint.protocol_versions` to **`2025-11-25`**.
Its admission of a configured `2025-03-26` does not put that version in the default
set. `initialize` negotiates: a supported request is echoed, and an unsupported
request receives the preferred version. Clients must check the returned
`result.protocolVersion` against their own supported versions, then send that
version in `MCP-Protocol-Version` alongside the returned `Mcp-Session-Id`. Nexus
acceptance advertises `2025-11-25` and reads both values from the initialize
response. It also covers fallback from `2025-03-26` and verifies that asserting an
unsupported version on discovery or a call returns HTTP 400 with JSON-RPC
`-32600`, without executing a backend operation. See the immutable
[default and admission](https://github.com/ferrum-edge/ferrum-edge/blob/ee040d5e3281fde424aa65f5b18004852c5b53b0/src/plugins/mcp_gateway.rs#L1413),
[post-initialize gate](https://github.com/ferrum-edge/ferrum-edge/blob/ee040d5e3281fde424aa65f5b18004852c5b53b0/src/plugins/mcp_gateway.rs#L1776)
and [negotiation](https://github.com/ferrum-edge/ferrum-edge/blob/ee040d5e3281fde424aa65f5b18004852c5b53b0/src/plugins/mcp_gateway.rs#L6248).

Tool-call quota denial is an MCP application error carried over **HTTP 200**:
the response has JSON-RPC `error.code: -32015` and message
`MCP tool-call rate limit exceeded`, with no `result`. It must not execute the
tool. The release's
[refusal path](https://github.com/ferrum-edge/ferrum-edge/blob/ee040d5e3281fde424aa65f5b18004852c5b53b0/src/plugins/rate_limiting.rs#L1025)
and [response builder](https://github.com/ferrum-edge/ferrum-edge/blob/ee040d5e3281fde424aa65f5b18004852c5b53b0/src/plugins/rate_limiting.rs#L1398)
define this behavior; an HTTP status alone cannot distinguish it from success.
Acceptance checks the entire error-only envelope, exactly 60 backend executions,
repeated denials across downstream sessions, discovery without a charge and REST
access after exhaustion. A second keyauth credential for the exhausted
**account consumer** must receive the same exact quota error without a tool result. An
approved **application of that same account** must retain its own consumer budget
and execute a tool once. The account/application grants, all three credentials
and their initial sessions are arranged before exhaustion; no policy replacement,
restart or rotation occurs during the budget proof, which must finish within
60 seconds.

The deterministic fixture records the total and the full per-route request counts
for every HTTP method and raw URL it receives. Repeated requests increment their
counts; unknown paths, query strings, wrong routes and other methods are retained.
Only exact **`GET /health`** (Compose's health probe) and exact
**`GET /__e2e/requests`** (the snapshot read) are excluded. The snapshot is read
through a separate approved, routes-enforced REST API at the real gateway, not
through Edge's Admin API or a mocked data plane. The fixture retains up to 1,024
distinct method/raw-URL pairs; overflow makes the acceptance assertion fail,
rather than permitting an incomplete comparison. Reading a snapshot never resets
the counters.

Strict full-snapshot equality around unapproved, revoked, unsupported-version,
unselected-destructive, shielded, malformed, invalid-argument and quota-denied
probes establishes zero requests received by this configured upstream between
the snapshot reads, including dispatches to unintended methods or paths. Exact
snapshot increments also require one opted-in DELETE, 60 admitted account GETs,
the REST probe after exhaustion and one same-account application GET. This proof
covers the tested requests and this fixture; it does not establish behavior at
other destinations or for untested inputs. A gateway-authored error without the
upstream marker alone cannot prove that no backend request was made.

## Test coverage

- Shared/server/web typecheck, build, format and tests, including the accessible
  operation picker and credential-placeholder connection recipe tests.
- Server publishing tests for extension stripping, closed request keys,
  route/endpoint/method collisions, explicit selection across revisions, owner
  and CSRF checks, audit intent/completion, lost acknowledgements, recorded
  ownership and compensated store failures with operator resource fields retained.
- `store-contracts` on all four adapters, including retained baseline upgrade,
  default-off migration `010`, subset migration `011`, selection/subset round-trip,
  production publishing/access mutations and transaction rollback.
- Packaged-image acceptance against the pinned Edge image: normal keyauth,
  basicauth and JWT credentials; account/application isolation; public/private
  approval; tools/list and tools/call;
  unapproved and revoked refusals with the same session/credential; read-only
  defaults, destructive opt-in, argument shielding, endpoint/REST bypass negative
  controls, tool-call-only consumer budgets and settings audit.

Mock config tests do not prove real gateway execution or authorization; the
packaged acceptance suite does that against the pinned gateway.

## Optional subsets and cross-repository follow-up

Optional consumer `requested_tools` and provider `approved_tools` contain server-owned
exposure IDs from the catalog. Omission/null means all published tools, including future
ones; explicit `[]` means REST access only. Approval defaults to the requested selection
and may narrow it, never broaden it. Only currently published IDs can be requested or
approved. Request and approval admission share the publishing proxy lease.

An ID names one published tool definition. Each tool stores a `definition_hash`, a
SHA-256 over the canonical, reference-resolved definition Edge publishes for it: name,
method, path and Nexus description; the operation's `summary` (the tool title) and
`description`; path and operation parameters; the request body's `required`,
`description` and JSON schemas; the 2xx JSON response schemas (the output schema); and
the document's OpenAPI version. Each `$ref` is hashed as its own text together with the
digest of its target, so changing either changes the hash. The stored hash is bound to
the tool's ID, so a hash copied onto another ID never matches.

Some references are not followed. The whole document except `info`, hashed as text
without following its references, is folded into a tool's hash when the definition
reaches an external or anchor `$ref`, a local pointer that names nothing, or a `$id`,
`$dynamicRef` or `$recursiveRef` member (a schema property of that name included), or
when its Request Body or a 2xx Response is a reference chain that does not end at an
object within 32 acyclic local hops. Every tool of the document is hashed from its
selection and that whole-document digest instead when a selected Path Item does not
resolve, or when reading and hashing every selected tool would pass a fixed work
budget: 16 Mi units across the document's tools, or 1,024 levels of nesting through
values and references. One meter per build is charged a unit for every member of a
document collection read (each Path Item, Request Body and Response reference hop,
each key of a Responses or Content map, and each key and array element of the
parameters, schemas and examples hashed) before it is read, plus every key and pointer
before it is parsed and every character as it is hashed. Nothing is copied out of the
document, and each selected Path Item, Request Body or Response reference, Content map
and acyclic schema reference target is read once per build however many tools and
statuses reach it, so a legitimate document stays far below the budget. A budget
fallback is recorded as `tool_hash_fallback: true` in the `api.publish`, `api.update`,
`api.spec_update` or `api.spec_rollback` audit row that commits the change, which
explains a later mass rotation: once every tool hashes the whole document, any change
outside `info` re-ids all of them. A
`$ref: "#"` names the whole document, `info` included. Each fallback only folds in more
than Edge publishes, so it can cost a re-approval but never carries a changed tool.
Selections are validated (existing, unique operations and names) before any hashing.

A spec revision, rollback or agents edit keeps a tool's ID only while its method,
path, name and hash are unchanged, so explicit subsets carry across whitespace, `info`
edits and changes to other operations or unreferenced components. Any change to the
definition mints a new ID, including a description-only edit in the spec or in agent
settings, because descriptions are prompt text an agent acts on. Rename, method/path
changes, removing and re-adding exposure, or disabling and re-enabling agents also mint
new IDs. A revision cannot drop a selected operation.

The write that retires an ID drops it from every explicit subset in the same transaction
and records `access.tools_prune` per grant, with `reason` `definition_changed`,
`tool_renamed` or `tool_removed`. Those holders keep REST access and their remaining
tools, and do not regain a tool if its old name or definition returns. A revision that
changes a tool's definition names it in the change summary (`agent_tools_changed`) and
the grantee notice; an agents edit that redefines or renames a tool sends the affected
subset holders an in-app notice, naming a renamed tool by its old and new name. Without
it a renamed tool would just vanish from an explicit subset, while an all-tools grant
keeps it under the new name.

Getting a changed or renamed tool back takes a tool request on the grant the holder
already has (`POST /api/grants/:id/tool-requests`): a pending request with `grant_id`
set, decided through the ordinary approve, deny and cancel endpoints under the same
review check, proxy lease, application key and daily budget as a request for access.
Approval rewrites the identity's consumer once with the REST group and the widened tool
groups, then commits the grant's new subset inside the consumer key, so REST access and
the tools already held never lapse (`access.tools_request`, `access.tools_approve`). A
failure after the gateway write takes back only the added tool groups, or every group of
the API if the grant was revoked meanwhile and no other active grant needs them. Denial
changes nothing. An API's owner cannot file one. Revoking a grant cancels its pending tool
request.

Null grants retain their all-published-tools meaning, changed tools included. Revocation,
deletion and bulk teardown remove both REST and MCP groups; re-enable rebuilds only
active grants, preserving operator groups.

All-tools grantees approved while agents were enabled receive the MCP-all group with
their approval, and account re-enable and consumer repair rebuild it. Only a change that
turns agents on, or that gives a retained phase-1 selection its exposure IDs, enrolls
existing all-tools grantees (`access.mcp_enroll`); ordinary spec revisions, rollbacks,
agents edits, restores and conversions read no grantee consumer from the gateway.

Existing phase-1 APIs require an authenticated provider republish before accepting a
subset, including empty subsets. See the [upgrade tradeoff](mcp-subsets-migration-draft.md).
Acceptance adds subset discovery/calls for keyauth, basicauth and JWT applications,
empty/omitted subsets, lifecycle changes and actual PostgreSQL-induced approval/policy
rollback. The independent-budget proof now uses explicit read-tool subsets.

Anvil, Alloy and Foundry tracking work is cross-repository follow-up and is
not required to use this phase with an ordinary MCP client. No transcript sink UI
or arbitrary provider policy editor is introduced.

Connection recipes follow the primary client documentation for
[VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
and [Claude Code HTTP MCP](https://code.claude.com/docs/en/mcp). They contain only
header placeholders and the gateway public URL. Credentials stay in the client's
protected configuration, outside URLs and portal session cookies.
