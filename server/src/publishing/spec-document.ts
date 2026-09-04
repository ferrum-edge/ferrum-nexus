/**
 * Turning an uploaded OpenAPI document into the one Nexus submits to Edge's
 * API-spec importer.
 *
 * A pure module: a document object in, a document object out. It never touches
 * the store, the Edge client or the network, so the exact bytes the gateway
 * will receive can be asserted without either.
 *
 * ## Why a spec, and not a plugin config
 *
 * `routes` enforcement is an Edge `openapi_validator`, and Edge's admission
 * refuses one on a proxy that has no `api_spec` attached:
 *
 * ```text
 * openapi_validator requires a proxy with an attached api_spec
 * ```
 *
 * (`validate_openapi_validator_precondition`, `src/admin/crud.rs`.) The stamp it
 * looks for — `Proxy.api_spec_id` — is set by exactly one thing, the spec
 * importer. So a portal cannot compose the validator itself and attach it: it
 * has to hand Edge the *document* and let the gateway generate the operation
 * table. That is what this module builds, and it is why a `routes` API's proxy
 * is created through `POST /api-specs` rather than `POST /proxies`
 * (issue #49; the inline-config approach was accepted by the mock and refused
 * by every real gateway).
 *
 * The trade is a good one. Edge's own extractor resolves `$ref`s, path-item
 * references, server bases and Swagger/3.0/3.1 draft differences — a portal
 * re-implementing that would be a second, subtly different linter rejecting
 * traffic the gateway itself would have accepted.
 *
 * ## What `routes` enforces, and what it deliberately does not
 *
 * {@link ROUTES_VALIDATE_EXTENSION} answers exactly one question: *is this path
 * and method in the document?* A request matching no generated operation is
 * rejected with `400` and an `application/problem+json` body. Request and
 * response body validation are switched off explicitly — a portal cannot ask a
 * provider whether their `$ref`ed schemas are meant to be enforcement or
 * documentation, and turning a documentation error into a production outage is
 * not a decision it gets to make on their behalf.
 *
 * ## The path the generated regexes have to match
 *
 * Edge matches operations against the **canonical policy path** — the full
 * client request path, which still carries the proxy's listen path
 * (`strip_listen_path` governs what goes *upstream*, not what policy sees). Its
 * extractor builds each matcher from the Paths key prefixed by the pathname of
 * `servers[0]`, so a document declaring `/invoices` and published at
 * `/nexus/billing` generates `^/nexus/billing/invoices$` only if the submitted
 * document says `servers: [{ url: "/nexus/billing" }]`.
 *
 * That is why {@link routesSpecDocument} **replaces** `servers`. The provider's
 * own `servers[0]` is their upstream — it is where `backend_scheme`,
 * `backend_host`, `backend_port` and `backend_path` come from, and it stays
 * authoritative for those on the `apis` row. Only the copy submitted to Edge is
 * rewritten, and only so the generated matchers line up with what clients
 * actually send. Leave it alone and every request 400s as an unknown
 * operation — including the declared ones.
 *
 * ## CORS preflights need nothing here
 *
 * `cors` runs at priority 100 and `openapi_validator` at 2960
 * (`docs/plugin_execution_order.md`), and `preflight_continue` defaults to
 * `false`, so the `cors` plugin answers a browser preflight with `204` and
 * short-circuits it long before the validator's unknown-operation check. No
 * synthetic `OPTIONS` operation and no method-wide bypass is needed — both were
 * written for the inline-config shape, and a bypass would have opened
 * *undeclared* paths to `OPTIONS` as well. Verified against a live gateway.
 *
 * @see docs/api_specs.md, docs/openapi_validator.md and
 * docs/plugin_execution_order.md in the Ferrum Edge repository.
 */

import type { EdgeApiSpecDocument, EdgePluginConfig, EdgeProxy } from '../ferrum-admin/types.js';

/** Name of the Edge plugin that enforces the operation table. */
export const OPENAPI_VALIDATOR_PLUGIN = 'openapi_validator';

/**
 * The plugin configs a proxy rebuild has to carry over by hand.
 *
 * Two kinds are dropped. Anything carrying an `api_spec_id` is **spec-owned**:
 * the importer generated it and regenerates it, so recreating a copy would
 * leave two. And `openapi_validator` is dropped whatever its tag says — in
 * `routes` mode the new spec brings its own, and in `docs_only` mode there must
 * not be one at all, which is the whole point of the conversion.
 */
export function handOwnedPlugins(configs: EdgePluginConfig[]): EdgePluginConfig[] {
  return configs.filter(
    (config) => config.api_spec_id == null && config.plugin_name !== OPENAPI_VALIDATOR_PLUGIN,
  );
}

/**
 * `x-ferrum-validate` for routes-only enforcement.
 *
 * A **closed** fixed-field object on Edge's side: a misspelled key is a `400`
 * with a spelling suggestion rather than a silently weaker policy. Only the
 * four settings the portal actually decides are sent; every omitted key keeps
 * the gateway's own default, which is what a portal that cannot let the
 * provider change it should do.
 *
 * `request.enabled` / `response.enabled` are the boundary of the feature — see
 * the module docblock — and `fail_on_unknown_operation` is what makes an
 * undeclared path a `400` instead of a pass-through.
 */
export const ROUTES_VALIDATE_EXTENSION: Readonly<Record<string, unknown>> = Object.freeze({
  mode: 'block',
  request: { enabled: false },
  response: { enabled: false },
  fail_on_unknown_operation: true,
});

/**
 * Fields a `GET /proxies/{id}` returns that must not be echoed into
 * `x-ferrum-proxy`.
 *
 * `namespace` comes from `X-Ferrum-Namespace` and the timestamps from the
 * server, exactly as on a `PUT /proxies/{id}`. `api_spec_id` is different in
 * kind: it is a server-managed ownership tag, and Edge answers a document that
 * copies one back with a `422` rather than ignoring it. `plugins` is dropped
 * because the importer rebuilds the association list itself — it re-associates
 * the regenerated validator and leaves every hand-owned association in place,
 * so sending a stale list could only fight it.
 */
const NON_SUBMITTABLE_PROXY_FIELDS = [
  'namespace',
  'created_at',
  'updated_at',
  'api_spec_id',
  'plugins',
] as const;

/**
 * The `x-ferrum-proxy` body for a proxy that already exists on the gateway.
 *
 * `PUT /api-specs/{id}` **re-inserts** the proxy from the submitted document
 * rather than merging into it, so anything missing here reverts to its serde
 * default — an operator's `hosts`, backend TLS, pooling or `upstream_id`, and
 * the timeouts and method list Nexus itself wrote. The only safe body is
 * therefore the document a fresh `GET` just returned, minus
 * {@link NON_SUBMITTABLE_PROXY_FIELDS}, with the handful of fields that are
 * actually changing overwritten by the caller. The index signature is
 * deliberate: unmodelled keys come straight off the wire and are never
 * interpreted.
 */
export function submittableProxyBody(proxy: EdgeProxy): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(proxy as unknown as Record<string, unknown>) };
  for (const field of NON_SUBMITTABLE_PROXY_FIELDS) delete body[field];
  return body;
}

/** Inputs beyond the provider's document. */
export interface RoutesSpecDocumentOptions {
  /** The proxy's listen path, e.g. `/nexus/billing`. */
  listenPath: string;
  /**
   * The `x-ferrum-proxy` body: a create body carrying an `id` for a new proxy,
   * or {@link submittableProxyBody} of an existing one for a replace.
   */
  proxy: Record<string, unknown>;
}

/**
 * The document Nexus submits to `POST` / `PUT /api-specs`.
 *
 * Three edits to the provider's own document, and nothing else:
 *
 * 1. every root `x-ferrum-*` key is **stripped**. A provider's document is
 *    input, not configuration: one that shipped its own `x-ferrum-proxy` would
 *    otherwise repoint the backend, and `x-ferrum-consumers` — which Edge
 *    rejects outright — would make the upload fail for a reason no provider
 *    could act on;
 * 2. `servers` is replaced with the listen path, so the generated operation
 *    matchers cover the path clients actually send (see the module docblock);
 * 3. `x-ferrum-proxy` and `x-ferrum-validate` are stamped on.
 *
 * The copy is shallow because only root keys move: `paths`, `components` and
 * everything under them are handed to Edge exactly as uploaded.
 */
export function routesSpecDocument(
  document: Record<string, unknown>,
  options: RoutesSpecDocumentOptions,
): EdgeApiSpecDocument {
  const submitted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key.startsWith('x-ferrum-')) continue;
    submitted[key] = value;
  }
  submitted.servers = [{ url: options.listenPath }];
  submitted['x-ferrum-proxy'] = options.proxy;
  submitted['x-ferrum-validate'] = { ...ROUTES_VALIDATE_EXTENSION };
  return submitted;
}
