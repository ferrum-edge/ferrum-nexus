# Agent marketplace: published MCP contract and subset grants

Issue [#446](https://github.com/ferrum-edge/ferrum-nexus/issues/446) exposes explicitly
selected API operations as MCP tools. Agents are off by default. This document
records the published Edge dependency and the configuration Nexus writes; the
[acceptance suite](../e2e/README.md) lists what is tested against a real gateway.

## Published dependency

The MCP contract Nexus uses (the OpenAPI bridge, ACL-group tool grants and MCP
governance) was first published in
[Edge v0.9.10](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.10), whose
tag resolves to `ee040d5e3281fde424aa65f5b18004852c5b53b0`; the source links below
point at that release. Nexus `v0.5.2` pins Edge v0.9.15 (Nexus `v0.5.0` and `v0.5.1`
pinned Edge v0.9.14, and `v0.4.0` Edge v0.9.13); `main` pins v0.9.17 in
[`release/compatibility.env`](../release/compatibility.env). The packaged acceptance suite
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

The deterministic fixture's full upstream-snapshot proof, and what it does not cover,
is described in the [acceptance suite](../e2e/README.md#what-each-suite-asserts).

## Optional subsets and cross-repository follow-up

Optional consumer `requested_tools` and provider `approved_tools` contain server-owned
exposure IDs from the catalog: omission/null means all published tools, including future
ones, and explicit `[]` means REST access only. Approval may narrow a request, never
broaden it. The request, approval, pruning and tool-request rules are in
[`api.md`](api.md#optional-mcp-access-subsets).

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
statuses reach it, so a legitimate document stays far below the budget. One build
therefore costs work proportional to the budget (the charge that crosses it being at
most one collection or string of the document) plus a constant per selected tool;
sorting each object's keys adds a log factor. A fallback first makes one shallow
top-level copy without `info`, then takes one canonical pass over the document. A budget
fallback is recorded as `tool_hash_fallback: true` in the `api.publish`, `api.update`,
`api.spec_update` or `api.spec_rollback` audit row that commits the change, which
explains a later mass rotation: once every tool hashes the whole document, any change
outside `info` re-ids all of them. A
`$ref: "#"` names the whole document, `info` included. Each fallback only folds in more
than Edge publishes, so it can cost a re-approval but never carries a changed tool.
Selections are validated (existing, unique operations and names, at most 256) before
any hashing; validation reads each Path Item in place, resolving each reference node
once, and cuts an operation's name and description to their limits before cleaning
them.

APIs published before tool subsets require an authenticated provider republish before
accepting a subset, including empty subsets. See the
[upgrade tradeoff](mcp-subsets-migration-draft.md).

Connection recipes follow the primary client documentation for
[VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
and [Claude Code HTTP MCP](https://code.claude.com/docs/en/mcp). They contain only
header placeholders and the gateway public URL. Credentials stay in the client's
protected configuration, outside URLs and portal session cookies.

## Agent document bounds

The document submitted for an agent API cannot keep a path's Path Item reference: each
operation carries its own `x-ferrum-mcp` mark, and two paths sharing one Path Item expose
different tools. So every path holds a copy of the Path Item it resolves to, and 2,000
paths referencing one large Path Item would otherwise stamp to gigabytes on every
publish. Every request that rebuilds that document (publish, spec revision, rollback,
restore, and a PATCH that edits the agents or converts the enforcement level) bounds it
before it builds anything or writes to the gateway: an upper bound on its compact JSON
size is charged to a work meter with a budget of `MAX_AGENT_DOCUMENT_BYTES` (8 MiB, twice
the expanded upload limit). It charges every root member, every path's reference chain
and resolved Path Item in full, a route per operation at the longer of the real and
staging listen paths, and every selected tool. Each object of the document is measured
once and remembered, so the check reads the document about once however much the stamp
would copy, plus each path's reference chain and operation slots. It stops at the first
charge past the budget with `400 SPEC_INVALID` (`reason: "agent_document_too_large"`).

An agent selection is admitted only if the document has at most 3,000
(`MAX_SPEC_OPERATIONS`) operations after Path Item references resolve. Each path counts
every operation its resolved Path Item holds, so a Path Item that 2,000 paths reference
counts 2,000 times. The upload limit uses the same number but counts differently: only
the method keys each path declares itself, so a path that is a `$ref` counts none. A
document can therefore pass the upload and still be refused for agents with
`400 SPEC_INVALID`. The resolved count is checked:

- on publish, spec revision, rollback and restore of an agent API;
- on a PATCH that edits the agents or converts the enforcement level;
- by the provider's operation picker, which will not enable agents past it.

Checking a live deployment's routes is not capped (restore, enforcement conversion and
their recovery all do this). That check reads every operation, however many the document
resolves to, so a routes API without agents is never refused for it.

Compensation rebuilds the document the gateway already holds, so neither bound refuses
it. A PATCH that leaves the agents and the enforcement level alone (visibility, status,
name, description and the other catalog or proxy settings) is not bounded either. So an
agent API published before the bounds, whose document is larger or resolves to more
operations, can still be edited and retired. Turning its agents off submits the document
without copies, and is the way to revise it again.
