/**
 * OpenAPI normalization shared by the documentation renderer (`web/`) and the
 * revision comparison (`server/`), so the two agree on what an operation's
 * effective contract is.
 *
 * Two rules live here:
 *
 * - **Local Reference Objects.** `#/…` JSON pointers are resolved against the
 *   document, following chains with a hop limit and a cycle guard. Anything
 *   else — an external reference, a dangling pointer, a cycle, a chain past the
 *   limit — is reported as unresolved rather than treated as an empty object.
 * - **Parameter inheritance.** A parameter is identified by `name` plus `in`.
 *   Path-item parameters apply to every operation beneath them unless the
 *   operation declares a parameter with the same identity, which then replaces
 *   the path-level definition outright.
 */

/** Longest `$ref` → `$ref` chain followed before giving up. */
export const MAX_OPENAPI_REF_HOPS = 32;

/** Why a Reference Object could not be followed. */
export type OpenApiRefFailure = 'external' | 'missing' | 'cycle' | 'depth';

/** The outcome of following one Reference Object to the object it names. */
export type OpenApiRefResolution =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; ref: string; reason: OpenApiRefFailure };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The value a local JSON pointer (`#/a/b~1c`) names in `document`, or
 * `undefined` when it names nothing.
 *
 * Segments are percent-decoded (a pointer in a URI fragment may be) and then
 * unescaped per RFC 6901 — `~1` before `~0`. Only own members are followed, so a
 * pointer can never walk into `__proto__` or other inherited properties.
 */
export function resolveOpenApiPointer(document: unknown, ref: string): unknown {
  if (ref === '#') return document;
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = document;
  for (const rawSegment of ref.slice(2).split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return undefined;
    }
    const segment = decoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (isPlainRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** The `$ref` string an object carries, when it is a Reference Object. */
export function openApiRefOf(value: unknown): string | null {
  if (!isPlainRecord(value)) return null;
  return typeof value.$ref === 'string' ? value.$ref : null;
}

/**
 * Whether Reference Object siblings `summary`/`description` override the
 * target's, which OpenAPI allows from 3.1 on. In 3.0 (and Swagger 2) every
 * sibling of `$ref` is ignored.
 */
export function openApiRefSiblingsApply(specVersion: string | null): boolean {
  if (specVersion === null) return false;
  const match = /^(\d+)\.(\d+)/.exec(specVersion.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 1);
}

/** How {@link resolveOpenApiObject} follows a chain. */
export interface OpenApiResolveOptions {
  /** See {@link openApiRefSiblingsApply}. */
  siblingsApply?: boolean;
  /**
   * Pointer lookups already made against the same document. A caller resolving
   * many references passes one map for all of them, so each hop after the first
   * visit of a pointer is a map lookup instead of a fresh walk.
   */
  pointerCache?: Map<string, unknown>;
}

/**
 * Follow `value` through any chain of local Reference Objects to the object it
 * finally names. A value that is not a Reference Object resolves to itself.
 *
 * When `siblingsApply` is set (OpenAPI 3.1+), a `summary` or `description`
 * written next to a `$ref` replaces the target's; the outermost one wins.
 */
export function resolveOpenApiObject(
  document: unknown,
  value: Record<string, unknown>,
  { siblingsApply = false, pointerCache }: OpenApiResolveOptions = {},
): OpenApiRefResolution {
  const overrides: Record<string, unknown> = {};
  const visited = new Set<string>();
  let current: Record<string, unknown> = value;
  for (let hops = 0; ; hops += 1) {
    const ref = openApiRefOf(current);
    if (ref === null) break;
    if (siblingsApply) {
      for (const field of ['summary', 'description'] as const) {
        if (typeof current[field] === 'string' && !(field in overrides)) {
          overrides[field] = current[field];
        }
      }
    }
    if (!ref.startsWith('#')) return { ok: false, ref, reason: 'external' };
    if (visited.has(ref)) return { ok: false, ref, reason: 'cycle' };
    if (hops >= MAX_OPENAPI_REF_HOPS) return { ok: false, ref, reason: 'depth' };
    visited.add(ref);
    let target: unknown;
    if (pointerCache?.has(ref)) {
      target = pointerCache.get(ref);
    } else {
      target = resolveOpenApiPointer(document, ref);
      pointerCache?.set(ref, target);
    }
    if (!isPlainRecord(target)) return { ok: false, ref, reason: 'missing' };
    current = target;
  }
  if (Object.keys(overrides).length === 0) return { ok: true, value: current };
  return { ok: true, value: { ...current, ...overrides } };
}

/**
 * The `(in, name)` identity of a parameter, or `null` when it has none — a
 * reference that cannot be resolved, or an object missing either field. A
 * parameter without an identity is never merged with another one.
 *
 * `in` is compared as written; `name` is compared case-insensitively for
 * headers only, since HTTP header names are.
 */
export function openApiParameterKey(
  document: unknown,
  parameter: unknown,
  pointerCache?: Map<string, unknown>,
): string | null {
  if (!isPlainRecord(parameter)) return null;
  const resolved = resolveOpenApiObject(document, parameter, { pointerCache });
  if (!resolved.ok) return null;
  const { name, in: location } = resolved.value;
  if (typeof name !== 'string' || typeof location !== 'string') return null;
  return `${location}\u0000${location === 'header' ? name.toLowerCase() : name}`;
}

/** One parameter of an operation's effective list, with its identity. */
export interface KeyedOpenApiParameter {
  /** The entry exactly as written — a Reference Object stays one. */
  parameter: unknown;
  /** See {@link openApiParameterKey}; `null` for an entry with no identity. */
  key: string | null;
  /** Declared on the path item rather than the operation. */
  inherited: boolean;
}

/**
 * Attach its identity to each parameter of one `parameters` list. Path-item
 * lists are keyed once and reused for every operation beneath them.
 */
export function keyOpenApiParameters(
  document: unknown,
  parameters: readonly unknown[],
  inherited: boolean,
  pointerCache?: Map<string, unknown>,
): KeyedOpenApiParameter[] {
  return parameters.map((parameter) => ({
    parameter,
    key: openApiParameterKey(document, parameter, pointerCache),
    inherited,
  }));
}

/**
 * The parameters an operation actually takes: every path-item parameter the
 * operation does not redeclare, followed by the operation's own, each in
 * declaration order. An operation parameter with the same `(in, name)` as a
 * path-item one replaces it; parameters sharing only a name (a `query` and a
 * `header` `id`, say) are distinct and both kept. Entries without an identity
 * are never merged away.
 */
export function mergeOpenApiParameters(
  pathParameters: readonly KeyedOpenApiParameter[],
  operationParameters: readonly KeyedOpenApiParameter[],
): KeyedOpenApiParameter[] {
  const overridden = new Set<string>();
  for (const entry of operationParameters) {
    if (entry.key !== null) overridden.add(entry.key);
  }
  return [
    ...pathParameters.filter((entry) => entry.key === null || !overridden.has(entry.key)),
    ...operationParameters,
  ];
}
