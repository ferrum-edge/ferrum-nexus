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
 * Replacing the root is not enough on its own. OpenAPI resolves `servers` at
 * three levels — root, Path Item, Operation — and the **nearest one wins**, so
 * a document that overrides `servers` on a path or an operation keeps that
 * override through the rewrite and Edge builds the matcher from it. The result
 * is a matcher describing a path no client can send (`^/other/one$` for an API
 * published at `/nexus/relserver`), and with
 * `fail_on_unknown_operation: true` that is a `400` on every declared
 * operation of an API the portal just reported as published. So every nested
 * `servers` is **stripped** as well — see {@link routesSpecDocument} for the
 * exact reach of that walk.
 *
 * A `$ref` is the same override wearing a disguise. Edge resolves a Path Item
 * reference as an *unrestricted* same-document JSON pointer and reads `servers`
 * off whatever it lands on, so `paths./invoices: { $ref: '#/webhooks/Invoices' }`
 * with a `servers` under that webhook produces the unreachable matcher just as
 * directly as writing it on the path would. The strip therefore covers every
 * container a submitted document may point into, and
 * {@link assertRoutesSubmittable} **refuses** a `routes` document that points
 * anywhere else — a rewrite that can be side-stepped by one indirection is not
 * a guarantee.
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

import type { SpecEnforcementLevel } from '@ferrum-nexus/shared';

import type { EdgeApiSpecDocument, EdgePluginConfig, EdgeProxy } from '../ferrum-admin/types.js';
import { specInvalid } from '../lib/errors.js';

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

/**
 * The Path Item keys that hold an Operation Object.
 *
 * OpenAPI's fixed set, and the only place below a Path Item where `servers` can
 * appear. Everything else under a path item (`parameters`, `summary`, `$ref`,
 * vendor extensions) is left exactly as uploaded.
 */
const OPENAPI_OPERATION_KEYS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

/** A plain object, i.e. something that could be an OpenAPI node. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A Path Item with `servers` gone from itself and from every operation under
 * it, or the node itself when it declared none.
 *
 * Returns the input by identity when nothing changed, which is what lets the
 * callers leave an untouched document byte-for-byte identical to today's
 * output rather than deep-copying the whole `paths` tree on every publish.
 */
function pathItemWithoutServers(item: unknown): unknown {
  if (!isRecord(item)) return item;
  let copy: Record<string, unknown> | null = null;
  const edited = (): Record<string, unknown> => (copy ??= { ...item });
  if ('servers' in item) delete edited().servers;
  for (const method of OPENAPI_OPERATION_KEYS) {
    const operation = item[method];
    if (!isRecord(operation) || !('servers' in operation)) continue;
    const withoutServers = { ...operation };
    delete withoutServers.servers;
    edited()[method] = withoutServers;
  }
  return copy ?? item;
}

/**
 * Every Path Item in a container, with nested `servers` stripped.
 *
 * `holdsPathItem` is what keeps the walk explicit: a Paths Object mixes path
 * templates with `^x-` specification extensions, and only the templates are
 * Path Items. The other containers walked below — `components.pathItems`, a
 * `webhooks` map and a Callback Object — are keyed by name or by runtime
 * expression rather than by path template, with nothing to tell apart, so they
 * pass `() => true`.
 */
function pathItemsWithoutServers(
  container: unknown,
  holdsPathItem: (key: string) => boolean,
): unknown {
  if (!isRecord(container)) return container;
  let copy: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(container)) {
    if (!holdsPathItem(key)) continue;
    const rewritten = pathItemWithoutServers(item);
    if (rewritten === item) continue;
    (copy ??= { ...container })[key] = rewritten;
  }
  return copy ?? container;
}

/**
 * Every Callback Object in a `components.callbacks` map, with nested `servers`
 * stripped from the Path Items inside it.
 *
 * A callback's `servers` normally describes a request the *provider's* service
 * makes outbound, which is why the `callbacks` hanging off an operation are
 * left exactly as uploaded. A `components.callbacks` entry is different in one
 * respect that matters: it is a named container of Path Items addressable by
 * JSON pointer, so Edge's resolver would read `servers` off one exactly as it
 * does off a `components.pathItems` entry. {@link assertRoutesSubmittable}
 * refuses the pointer that would do it; the strip is the second lock on the
 * same door, and it costs a document nothing an operation table can observe.
 */
function callbacksWithoutServers(container: unknown): unknown {
  if (!isRecord(container)) return container;
  let copy: Record<string, unknown> | null = null;
  for (const [name, callback] of Object.entries(container)) {
    const rewritten = pathItemsWithoutServers(callback, () => true);
    if (rewritten === callback) continue;
    (copy ??= { ...container })[name] = rewritten;
  }
  return copy ?? container;
}

/**
 * The containers a submitted document's `paths` may reference a Path Item in.
 *
 * Edge resolves a Path Item `$ref` as an **unrestricted** same-document JSON
 * pointer (`resolve_reference`, `src/admin/api_specs/extractor.rs`) and builds
 * the operation's matcher from the `servers` of whatever it lands on — Path
 * Items under `paths`, under `components.pathItems` and under `webhooks` are
 * all indexed for that. Those three are exactly the containers
 * {@link routesSpecDocument} strips, which is why they are exactly the three a
 * `routes` document is allowed to point into.
 */
const RESOLVABLE_PATH_ITEM_POINTERS = [
  '#/paths/',
  '#/components/pathItems/',
  '#/webhooks/',
] as const;

/**
 * Refuse a `routes` document whose `paths` reference a Path Item this module
 * does not rewrite.
 *
 * The `servers` strip is only a guarantee if it cannot be side-stepped, and one
 * `$ref` side-steps it: Edge resolves the pointer, reads `servers` off the
 * resolved item and generates `^/other/invoices$` for an API published at
 * `/nexus/billing` — a matcher no client can hit, and with
 * `fail_on_unknown_operation: true` a `400` on every declared operation of an
 * API the portal just reported as published. Nexus could chase an arbitrary
 * pointer and rewrite whatever it finds, but that is a second implementation of
 * Edge's resolver, and the whole reason `routes` hands Edge the document is not
 * to have one of those.
 *
 * So the pointers that stay inside {@link RESOLVABLE_PATH_ITEM_POINTERS} are
 * accepted — the strip walk has already been over all three — and anything
 * else, an external document included, is refused with a message naming the
 * path and the ways out. Refusing is the same trade
 * {@link assertRoutesEnforceable} makes in `publishing/service.ts`: a `400` on
 * upload the provider can act on, rather than a `201` and an API that rejects
 * every request.
 *
 * A no-op for `docs_only`, whose document Edge never generates matchers from,
 * so callers can pass the level straight through.
 *
 * @throws NexusError `SPEC_INVALID`
 */
export function assertRoutesSubmittable(
  enforcement: SpecEnforcementLevel,
  document: Record<string, unknown>,
): void {
  if (enforcement !== 'routes') return;
  const paths = document.paths;
  if (!isRecord(paths)) return;
  for (const [template, item] of Object.entries(paths)) {
    if (!template.startsWith('/') || !isRecord(item)) continue;
    if (!('$ref' in item)) continue;
    // A non-string `$ref` is not a reference at all; it matches no pointer
    // below and is refused with the same message rather than submitted.
    const reference = typeof item.$ref === 'string' ? item.$ref : '';
    if (RESOLVABLE_PATH_ITEM_POINTERS.some((pointer) => reference.startsWith(pointer))) continue;
    throw specInvalid(
      `The path '${template}' is a $ref the gateway would resolve outside the part of the ` +
        "document 'routes' enforcement can rewrite, so it could reintroduce a server base no " +
        'client can reach; write the path item inline, or reference one under ' +
        "'#/components/pathItems/', '#/webhooks/' or '#/paths/', or set the enforcement level " +
        "back to 'docs_only'",
      { field: 'spec', path: template, reason: 'unresolvable_path_item_ref' },
    );
  }
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
 *    matchers cover the path clients actually send (see the module docblock),
 *    and every **nested** `servers` is stripped so nothing can override that
 *    replacement back to a path no client can reach;
 * 3. `x-ferrum-proxy` and `x-ferrum-validate` are stamped on.
 *
 * ## What the `servers` strip reaches, and what it deliberately does not
 *
 * An explicit shallow walk, not an arbitrary recursion — the point is that the
 * set of nodes Nexus rewrites is knowable by reading this function:
 *
 * - **`paths.<template>`** and **`paths.<template>.<method>`**, the two nested
 *   levels OpenAPI resolves `servers` at. Only keys that are path templates are
 *   walked; a Paths Object's `^x-` extensions are data, not Path Items;
 * - **`components.pathItems.<name>`**, **`webhooks.<name>`** and
 *   **`components.callbacks.<name>.<expression>`**, with their operations. Each
 *   is a Path Item addressable by JSON pointer, and Edge resolves a path
 *   template that is a `$ref` to one as an unrestricted same-document pointer —
 *   producing exactly the same operation-table entry, and therefore exactly the
 *   same unreachable matcher, as writing the override on the path would;
 * - **not** the callbacks hanging off an operation
 *   (`paths.*.<method>.callbacks.*`). A callback describes a request the
 *   *provider's* service makes to the client's URL. It is not served by this
 *   proxy, Edge's extractor builds no listen-path matcher from it, and a
 *   `servers` there is genuinely the provider's own — rewriting it would
 *   corrupt documentation to no enforcement benefit. Nothing can `$ref` its way
 *   into one either: {@link assertRoutesSubmittable}, called first, refuses a
 *   `paths` entry pointing outside the three containers above.
 *
 * Only nodes that actually carried a `servers` key are copied; everything else
 * is passed through by identity, so a document with no nested `servers` is
 * submitted exactly as it was uploaded.
 *
 * @throws NexusError `SPEC_INVALID` for a `paths` entry that references a Path
 * Item outside the containers above
 */
export function routesSpecDocument(
  document: Record<string, unknown>,
  options: RoutesSpecDocumentOptions,
): EdgeApiSpecDocument {
  assertRoutesSubmittable('routes', document);
  const submitted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key.startsWith('x-ferrum-')) continue;
    submitted[key] = value;
  }
  submitted.servers = [{ url: options.listenPath }];
  const paths = pathItemsWithoutServers(submitted.paths, (key) => key.startsWith('/'));
  if (paths !== submitted.paths) submitted.paths = paths;
  const webhooks = pathItemsWithoutServers(submitted.webhooks, () => true);
  if (webhooks !== submitted.webhooks) submitted.webhooks = webhooks;
  const components = submitted.components;
  if (isRecord(components)) {
    let rewritten: Record<string, unknown> | null = null;
    const edited = (): Record<string, unknown> => (rewritten ??= { ...components });
    const pathItems = pathItemsWithoutServers(components.pathItems, () => true);
    if (pathItems !== components.pathItems) edited().pathItems = pathItems;
    const callbacks = callbacksWithoutServers(components.callbacks);
    if (callbacks !== components.callbacks) edited().callbacks = callbacks;
    if (rewritten !== null) submitted.components = rewritten;
  }
  submitted['x-ferrum-proxy'] = options.proxy;
  submitted['x-ferrum-validate'] = { ...ROUTES_VALIDATE_EXTENSION };
  return submitted;
}
