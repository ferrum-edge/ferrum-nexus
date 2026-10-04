# Agent marketplace: published MCP contract and subset grants

Issue [#446](https://github.com/ferrum-edge/ferrum-nexus/issues/446) exposes explicitly
selected API operations as MCP tools. Agents are off by default. This document
records the published dependency and the gates that must run in hosted CI; it
does not claim unexecuted tests passed.

## Published dependency

The checked-in `release/compatibility.env` already pins Edge **v0.9.10**:

```text
ferrumedge/ferrum-edge:v0.9.10@sha256:430d6a7d41361de5ad12562786481f97f1e97fef72a0b5f1a0699eced7cdd4cc
```

This change does not bump the image, release version or compatibility pin.
The [published release](https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.10)
was published October 1, 2026, at 12:59:57 UTC. Its tag resolves to
`ee040d5e3281fde424aa65f5b18004852c5b53b0`. Inspection used that published source
and registry artifacts, not current main. Registry index inspection matched the
checked-in digest. The pinned Linux amd64 manifest is
`sha256:18a8a962ad13bacb2505a122330bb25ce921b21a2f3cb5362a6ea93f11fe44d5`;
its binary layer is
`sha256:f87cf3cd82199e74e92a572ee794c4bfa9ea0fc793dbfdb1fd48d03dad07f127`.
The extracted, unexecuted `app/ferrum-edge` SHA-256 is
`52745149de09932b54bef79cbe5524e2376cb84d0fa7a4d8436ae0bcd19d6559`, matching
the release's Linux x86_64 binary checksum. This links the source contract to
the digest-pinned executable used by acceptance.

The tracking issue's old unchecked Edge #5906/#5907/#5908 boxes do not indicate
missing implementation. The released contract includes the bridge, ACL-group
tool grants and MCP governance. No unshipped v0.9.11 field is assumed.

Primary source contracts at this release:

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
upstream marker alone cannot prove that no backend request was made. These are
hosted acceptance assertions, not a claim that unexecuted gates have passed.

## Hosted qualification

No local project code, build, formatter or tests were executed for this change.
Required hosted gates include:

- Shared/server/web typecheck, build, format and tests, including the accessible
  operation picker and credential-placeholder connection recipe tests.
- Server publishing tests for extension stripping, closed request keys,
  route/endpoint/method collisions, explicit selection across revisions, owner
  and CSRF checks, audit intent/completion, lost acknowledgements, recorded
  ownership and compensated store failures with operator resource fields retained.
- `store-contracts` on all four adapters, including retained baseline upgrade,
  default-off migration `010`, subset migration `011`, selection/subset round-trip,
  production publishing/access mutations and transaction rollback;
  released migration checksums must remain unchanged.
- Packaged-image acceptance against the exact pin above: normal keyauth,
  basicauth and JWT credentials; account/application isolation; public/private
  approval; tools/list and tools/call;
  unapproved and revoked refusals with the same session/credential; read-only
  defaults, destructive opt-in, argument shielding, endpoint/REST bypass negative
  controls, tool-call-only consumer budgets and settings audit.
- Fresh independent security review before merge. Mock config tests do not prove
  real gateway execution or authorization.

## Optional subsets and cross-repository follow-up

Optional consumer `requested_tools` and provider `approved_tools` contain server-owned
exposure IDs from the catalog. Omission/null means all published tools, including future
ones; explicit `[]` means REST access only. Approval defaults to the requested selection
and may narrow it, never broaden it. Only currently published IDs can be requested or
approved. Request and approval admission share the publishing proxy lease.

IDs survive cosmetic descriptions and unchanged republishing. Rename, method/path changes,
removing and re-adding exposure, or disabling and re-enabling agents mint new IDs. Any
changed uploaded spec conservatively rotates all IDs, including a spec rollback, because
references or schemas can change callable semantics. Existing explicit subsets then fail
closed and do not regain tools if old names return. REST access remains. Null grants
retain their all-published-tools meaning. Revocation, deletion and bulk teardown remove
both REST and MCP groups; re-enable rebuilds only active grants, preserving operator groups.

Existing phase-1 APIs require an authenticated provider republish before accepting a
subset, including empty subsets. See the [draft upgrade tradeoff](mcp-subsets-migration-draft.md).
Hosted acceptance adds subset discovery/calls for keyauth, basicauth and JWT applications,
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
