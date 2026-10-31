/**
 * Declaring the gateway's credential in the catalog document.
 *
 * The document a consumer reads at `GET /api/catalog/:slug/spec` is the
 * provider's upload with its `servers` pointed at the gateway. Its
 * `security`, though, is still the provider's: what their *upstream* wants.
 * The gateway in front of it always demands a credential of its own (the
 * API's `auth_plugin`), which the provider's document cannot know about. An
 * Alloy service exported with `ferrum-alloy openapi export`, for example,
 * declares no security at all. Every tool that reads security from the
 * document (an importer such as Anvil's, a code generator, a "try it"
 * console) then builds requests the gateway answers with `401`.
 *
 * {@link stampGatewaySecurity} adds that requirement, in standard OpenAPI
 * terms, so the document describes what a request through the gateway has to
 * carry:
 *
 * - one security scheme for the auth plugin, with the header Edge reads for it
 *   ({@link gatewaySecurityScheme}), under `components.securitySchemes`;
 * - an explicit `security` on every operation the gateway serves: each
 *   operation of a Path Item under `paths`, inline or reached through a chain
 *   of Path Item `$ref`s. It is the operation's own `security`, or the root's
 *   when it has none, with the gateway's scheme added. OpenAPI lists
 *   alternatives, each one a set of schemes that must all be present, so the
 *   scheme is added to each alternative, and an operation that requires
 *   nothing (no `security`, `[]` or `[{}]`) now requires the gateway's scheme
 *   alone.
 *
 * The root `security` is left as uploaded. It is also the default of webhook
 * and callback operations, which describe requests the provider's service
 * makes, not ones the gateway receives, and those keep their meaning.
 *
 * ## Header collisions
 *
 * A request has one `Authorization` and one `X-API-Key` header. When the
 * gateway reads one of them, a provider scheme sent in the same header cannot
 * be satisfied alongside the gateway's: `key_auth` and `basic_auth` remove the
 * header before forwarding, and `jwt_auth` forwards the gateway token in it.
 * Such a scheme is therefore dropped from each requirement, and identical
 * alternatives left behind are merged. Its definition stays in
 * `securitySchemes`. Schemes in other headers, the query, cookies or the TLS
 * layer (`mutualTLS`) are kept, because a client can still send them.
 *
 * ## What it does not do
 *
 * - It says nothing about the caller. The scheme describes the credential
 *   type, never a consumer name, key or secret, so one rendering serves every
 *   viewer (the catalog cache key holds no viewer).
 * - It is documentation, not enforcement: the gateway's `key_auth`,
 *   `basic_auth` or `jwt_auth` plugin decides. The MCP endpoint of an
 *   agent-enabled API is not an operation of the document and is not described.
 * - Webhooks and callbacks are not changed, except a reusable Path Item or
 *   webhook that a path references: the gateway serves that one, so its
 *   operations are stamped wherever else it is used.
 * - A `components` or `components.securitySchemes` that is present but not an
 *   object is invalid OpenAPI that no tool can read; it is replaced, so the
 *   gateway scheme can be defined.
 */

import { resolveOpenApiPointer, type AuthPluginType } from '@ferrum-nexus/shared';

/**
 * Name the gateway's scheme is registered under, when the provider's document
 * does not already use it. Otherwise `_2`, `_3`, … is appended.
 */
export const GATEWAY_SECURITY_SCHEME_NAME = 'ferrum_gateway';

/** The header `key_auth` reads with the empty config Nexus sends it. */
const KEY_AUTH_HEADER = 'X-API-Key';

/** Path Item keys that hold an Operation Object. */
const OPERATION_KEYS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * Longest `$ref` chain followed from a security scheme entry to its definition,
 * or from a path to the Path Item it is served from.
 */
const MAX_REF_HOPS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The Security Scheme Object for an auth plugin, as Nexus configures it on
 * Edge (`authPluginConfig` sends `{}`, so each plugin uses Edge's defaults).
 */
export function gatewaySecurityScheme(authPlugin: AuthPluginType): Record<string, unknown> {
  switch (authPlugin) {
    case 'key_auth':
      return {
        type: 'apiKey',
        in: 'header',
        name: KEY_AUTH_HEADER,
        description:
          'Ferrum Edge gateway credential: a keyauth key issued in the developer portal, ' +
          'sent exactly as it was shown when it was issued.',
      };
    case 'basic_auth':
      return {
        type: 'http',
        scheme: 'basic',
        description:
          'Ferrum Edge gateway credential: a basicauth password issued in the developer ' +
          'portal. The username is the gateway consumer username (nexus-user-<id> or ' +
          'nexus-app-<id>), not the portal email.',
      };
    case 'jwt_auth':
      return {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Ferrum Edge gateway credential: a short-lived HS256 token signed with the secret ' +
          'of a jwt credential issued in the developer portal. Its sub claim is the gateway ' +
          'consumer username (nexus-user-<id> or nexus-app-<id>), and it must carry an exp claim.',
      };
  }
}

/** The request header the gateway reads its credential from, lowercased. */
function gatewayHeader(authPlugin: AuthPluginType): string {
  return authPlugin === 'key_auth' ? KEY_AUTH_HEADER.toLowerCase() : 'authorization';
}

/**
 * The header a provider scheme is sent in, lowercased, or `null` when it is
 * not sent in a header (query, cookie, TLS) or its type is unknown.
 */
function schemeHeader(scheme: Record<string, unknown>): string | null {
  switch (scheme.type) {
    case 'apiKey':
      return scheme.in === 'header' && typeof scheme.name === 'string'
        ? scheme.name.toLowerCase()
        : null;
    case 'http':
    case 'oauth2':
    case 'openIdConnect':
      return 'authorization';
    default:
      return null;
  }
}

/**
 * Follow a scheme entry's local `$ref` chain to its definition, if it ends at
 * one. References resolve against the whole document, percent-decoded and
 * RFC 6901-unescaped, as an OpenAPI client resolves them.
 */
function resolveScheme(document: unknown, entry: unknown): Record<string, unknown> | null {
  let current = entry;
  for (let hop = 0; hop <= MAX_REF_HOPS; hop += 1) {
    if (!isRecord(current)) return null;
    const ref = current.$ref;
    if (typeof ref !== 'string') return current;
    current = resolveOpenApiPointer(document, ref);
  }
  return null;
}

/** Names of the provider's schemes sent in the header the gateway reads. */
function collidingSchemes(
  document: Record<string, unknown>,
  schemes: Record<string, unknown>,
  authPlugin: AuthPluginType,
): Set<string> {
  const header = gatewayHeader(authPlugin);
  const colliding = new Set<string>();
  for (const [name, entry] of Object.entries(schemes)) {
    const scheme = resolveScheme(document, entry);
    if (scheme !== null && schemeHeader(scheme) === header) colliding.add(name);
  }
  return colliding;
}

/** A name for the gateway scheme that the document does not already define. */
function freeSchemeName(schemes: Record<string, unknown>): string {
  if (!Object.hasOwn(schemes, GATEWAY_SECURITY_SCHEME_NAME)) return GATEWAY_SECURITY_SCHEME_NAME;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${GATEWAY_SECURITY_SCHEME_NAME}_${suffix}`;
    if (!Object.hasOwn(schemes, candidate)) return candidate;
  }
}

/**
 * One `security` value with the gateway's scheme added to every alternative.
 *
 * Anything that is not an array of requirement objects (absent, or invalid)
 * reads as "nothing required" and becomes the gateway's scheme alone, as does
 * an alternative that is not an object.
 */
function withGatewayRequirement(
  security: unknown,
  name: string,
  colliding: ReadonlySet<string>,
): Record<string, unknown>[] {
  const alternatives = Array.isArray(security) && security.length > 0 ? security : [{}];
  const result: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const alternative of alternatives) {
    const entries = isRecord(alternative)
      ? Object.entries(alternative).filter(([scheme]) => !colliding.has(scheme) && scheme !== name)
      : [];
    entries.push([name, []]);
    const key = JSON.stringify([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    if (seen.has(key)) continue;
    seen.add(key);
    // `Object.fromEntries` defines own properties, so a provider key such as
    // `__proto__` stays a key instead of reaching the prototype.
    result.push(Object.fromEntries(entries));
  }
  return result;
}

/** Where a Path Item `$ref` points: one entry of `paths`, `webhooks` or `components.pathItems`. */
type PathItemRegistry = 'paths' | 'webhooks' | 'pathItems';

/** Percent-decode and RFC 6901-unescape one pointer segment, or `null` if malformed. */
function pointerSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** The registry entry a Path Item `$ref` names, or `null` for anything else. */
function pathItemTarget(ref: string): { registry: PathItemRegistry; key: string } | null {
  if (!ref.startsWith('#/')) return null;
  const segments = ref.slice(2).split('/').map(pointerSegment);
  if (segments.some((segment) => segment === null)) return null;
  const [first, second, third] = segments as string[];
  if (segments.length === 2 && first === 'paths') return { registry: 'paths', key: second! };
  if (segments.length === 2 && first === 'webhooks') return { registry: 'webhooks', key: second! };
  if (segments.length === 3 && first === 'components' && second === 'pathItems') {
    return { registry: 'pathItems', key: third! };
  }
  return null;
}

/**
 * The document with the gateway's credential declared on every operation the
 * gateway serves; see the module comment. The input is not modified: changed
 * nodes are copied, everything else is shared.
 */
export function stampGatewaySecurity(
  document: Record<string, unknown>,
  authPlugin: AuthPluginType,
): Record<string, unknown> {
  const components = isRecord(document.components) ? document.components : {};
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  const name = freeSchemeName(schemes);
  const colliding = collidingSchemes(document, schemes, authPlugin);
  const rootSecurity = document.security;

  /** A Path Item with an explicit, gateway-stamped `security` on every operation. */
  const stampPathItem = (item: unknown): unknown => {
    if (!isRecord(item)) return item;
    let copy: Record<string, unknown> | null = null;
    for (const method of OPERATION_KEYS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      const own = Object.hasOwn(operation, 'security') ? operation.security : rootSecurity;
      copy ??= { ...item };
      copy[method] = { ...operation, security: withGatewayRequirement(own, name, colliding) };
    }
    return copy ?? item;
  };

  const registries: Record<PathItemRegistry, unknown> = {
    paths: document.paths,
    webhooks: document.webhooks,
    pathItems: components.pathItems,
  };
  // Registry entries a path is served from through its `$ref` chain. An entry
  // of `paths` is stamped as a path anyway, so only the other two are kept.
  const referenced: Record<'webhooks' | 'pathItems', Set<string>> = {
    webhooks: new Set(),
    pathItems: new Set(),
  };
  const follow = (item: unknown): void => {
    let current = item;
    const seen = new Set<string>();
    for (let hop = 0; hop < MAX_REF_HOPS; hop += 1) {
      if (!isRecord(current) || typeof current.$ref !== 'string') return;
      const target = pathItemTarget(current.$ref);
      if (target === null) return;
      const id = `${target.registry}\n${target.key}`;
      if (seen.has(id)) return;
      seen.add(id);
      if (target.registry !== 'paths') referenced[target.registry].add(target.key);
      const registry = registries[target.registry];
      if (!isRecord(registry) || !Object.hasOwn(registry, target.key)) return;
      current = registry[target.key];
    }
  };

  const copy: Record<string, unknown> = {
    ...document,
    components: {
      ...components,
      securitySchemes: { ...schemes, [name]: gatewaySecurityScheme(authPlugin) },
    },
  };
  // `Object.fromEntries` defines own properties, so a provider key such as
  // `__proto__` stays a key instead of reaching the prototype.
  if (isRecord(document.paths)) {
    copy.paths = Object.fromEntries(
      Object.entries(document.paths).map(([template, item]) => {
        if (!template.startsWith('/')) return [template, item];
        follow(item);
        return [template, stampPathItem(item)];
      }),
    );
  }
  const stampReferenced = (registry: Record<string, unknown>, keys: ReadonlySet<string>) =>
    Object.fromEntries(
      Object.entries(registry).map(([key, item]) => [
        key,
        keys.has(key) ? stampPathItem(item) : item,
      ]),
    );
  if (referenced.pathItems.size > 0 && isRecord(components.pathItems)) {
    (copy.components as Record<string, unknown>).pathItems = stampReferenced(
      components.pathItems,
      referenced.pathItems,
    );
  }
  if (referenced.webhooks.size > 0 && isRecord(document.webhooks)) {
    copy.webhooks = stampReferenced(document.webhooks, referenced.webhooks);
  }
  return copy;
}
