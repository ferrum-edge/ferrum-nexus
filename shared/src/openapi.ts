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

import { MAX_SPEC_DEPTH } from './constants.js';

/** Longest `$ref` → `$ref` chain followed before giving up. */
export const MAX_OPENAPI_REF_HOPS = 32;

/**
 * Most segments a JSON pointer may have. A document nests at most
 * `MAX_SPEC_DEPTH` levels, so a longer pointer can never name anything; it is
 * refused before any segment is decoded.
 */
export const MAX_OPENAPI_POINTER_SEGMENTS = MAX_SPEC_DEPTH;

/** Why a Reference Object could not be followed. */
export type OpenApiRefFailure = 'external' | 'missing' | 'cycle' | 'depth';

/**
 * Reference Object siblings that replace the target's own members (OpenAPI 3.1
 * and later). Kept apart from the target so a reference never copies it.
 */
export interface OpenApiRefOverrides {
  summary?: string;
  description?: string;
}

/** The outcome of following one Reference Object to the object it names. */
export type OpenApiRefResolution =
  | { ok: true; value: Record<string, unknown>; overrides: OpenApiRefOverrides }
  | { ok: false; ref: string; reason: OpenApiRefFailure };

/**
 * Work counters a caller may pass to a resolver, so a test can assert how much
 * resolving a document cost without timing it.
 */
export interface OpenApiResolveStats {
  /** JSON pointers walked against the document. */
  pointerLookups: number;
  /** Pointer segments decoded across those walks. */
  pointerSegments: number;
}

const NO_OVERRIDES: OpenApiRefOverrides = Object.freeze({});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The value a local JSON pointer (`#/a/b~1c`) names in `document`, or
 * `undefined` when it names nothing.
 *
 * Segments are percent-decoded (a pointer in a URI fragment may be) and then
 * unescaped per RFC 6901 — `~1` before `~0`. Only own members are followed, so a
 * pointer can never walk into `__proto__` or other inherited properties. A
 * pointer with more than {@link MAX_OPENAPI_POINTER_SEGMENTS} segments names
 * nothing.
 */
export function resolveOpenApiPointer(document: unknown, ref: string): unknown {
  return walkPointer(document, ref, undefined);
}

function walkPointer(
  document: unknown,
  ref: string,
  stats: OpenApiResolveStats | undefined,
): unknown {
  if (stats) stats.pointerLookups += 1;
  if (ref === '#') return document;
  if (!ref.startsWith('#/')) return undefined;
  // Counted before splitting, so an overlong pointer costs one scan and no
  // allocation per segment.
  let segments = 1;
  for (let index = 2; index < ref.length; index += 1) {
    if (ref.charCodeAt(index) === 0x2f && ++segments > MAX_OPENAPI_POINTER_SEGMENTS) {
      return undefined;
    }
  }
  let current: unknown = document;
  for (const rawSegment of ref.slice(2).split('/')) {
    if (stats) stats.pointerSegments += 1;
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

/** How a resolver follows chains. */
export interface OpenApiResolveOptions {
  /** See {@link openApiRefSiblingsApply}. */
  siblingsApply?: boolean;
  /** Incremented as pointers are walked; see {@link OpenApiResolveStats}. */
  stats?: OpenApiResolveStats;
}

/**
 * Follows the Reference Objects of one document. Create one per document and
 * reuse it for every reference in it.
 */
export interface OpenApiRefResolver {
  /**
   * Follow `value` through any chain of local Reference Objects to the object
   * it finally names. A value that is not a Reference Object resolves to
   * itself. The returned `value` is always an object of the document itself,
   * never a copy; see {@link OpenApiRefOverrides}.
   */
  resolve(value: Record<string, unknown>): OpenApiRefResolution;
}

/**
 * What following one `$ref` string leads to. `length` is the number of pointer
 * lookups the chain takes from that string, so the hop limit can be applied to
 * a memoised tail wherever a chain starts.
 */
type ChainOutcome =
  | { ok: true; value: Record<string, unknown>; overrides: OpenApiRefOverrides; length: number }
  | { ok: false; ref: string; reason: Exclude<OpenApiRefFailure, 'depth'>; length: number };

/** `outer` siblings of a Reference Object, falling back to `inner` per field. */
function mergeOverrides(
  outer: Record<string, unknown>,
  inner: OpenApiRefOverrides,
): OpenApiRefOverrides {
  const summary = typeof outer.summary === 'string' ? outer.summary : inner.summary;
  const description = typeof outer.description === 'string' ? outer.description : inner.description;
  if (summary === inner.summary && description === inner.description) return inner;
  const merged: OpenApiRefOverrides = {};
  if (summary !== undefined) merged.summary = summary;
  if (description !== undefined) merged.description = description;
  return merged;
}

/**
 * A resolver for `document`.
 *
 * Every `$ref` string is followed at most once per resolver: the outcome of the
 * chain it starts — the object it ends at, or why it cannot be followed — is
 * memoised, and a later chain that reaches it stops there. Resolving a document
 * therefore costs one pointer walk per distinct reference string, however many
 * places use each one and however long the chains between them are; each walk
 * is bounded by {@link MAX_OPENAPI_POINTER_SEGMENTS}.
 *
 * When `siblingsApply` is set (OpenAPI 3.1+), a `summary` or `description`
 * written next to a `$ref` replaces the target's; the outermost one wins. The
 * replacements are reported in `overrides`, never merged into a copy of the
 * target.
 *
 * A chain longer than {@link MAX_OPENAPI_REF_HOPS} fails with `depth` and
 * reports the reference it started from; any other failure reports the
 * reference at which it was detected.
 */
export function createOpenApiRefResolver(
  document: unknown,
  { siblingsApply = false, stats }: OpenApiResolveOptions = {},
): OpenApiRefResolver {
  const outcomes = new Map<string, ChainOutcome>();

  // Iterative, so a chain as long as the document allows cannot exhaust the
  // stack. Every string pushed here is new to `outcomes` and is memoised before
  // returning, which is what keeps the total work linear in distinct refs.
  const follow = (start: string): ChainOutcome => {
    const known = outcomes.get(start);
    if (known) return known;
    const chain: Array<{ ref: string; target: Record<string, unknown> }> = [];
    const onChain = new Map<string, number>();
    let ref = start;
    let tail: ChainOutcome;
    for (;;) {
      const memoised = outcomes.get(ref);
      if (memoised) {
        tail = memoised;
        break;
      }
      const cycleStart = onChain.get(ref);
      if (cycleStart !== undefined) {
        // Every reference on the loop reports itself as the one that repeats,
        // exactly as a walk starting there would find it.
        for (const link of chain.slice(cycleStart)) {
          outcomes.set(link.ref, { ok: false, ref: link.ref, reason: 'cycle', length: 0 });
        }
        chain.length = cycleStart;
        tail = outcomes.get(ref)!;
        break;
      }
      if (!ref.startsWith('#')) {
        tail = { ok: false, ref, reason: 'external', length: 0 };
        outcomes.set(ref, tail);
        break;
      }
      const target = walkPointer(document, ref, stats);
      if (!isPlainRecord(target)) {
        tail = { ok: false, ref, reason: 'missing', length: 1 };
        outcomes.set(ref, tail);
        break;
      }
      const next = openApiRefOf(target);
      if (next === null) {
        tail = { ok: true, value: target, overrides: NO_OVERRIDES, length: 1 };
        outcomes.set(ref, tail);
        break;
      }
      onChain.set(ref, chain.length);
      chain.push({ ref, target });
      ref = next;
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const { ref: link, target } = chain[index]!;
      if (tail.ok) {
        tail = {
          ok: true,
          value: tail.value,
          overrides: siblingsApply ? mergeOverrides(target, tail.overrides) : NO_OVERRIDES,
          length: tail.length + 1,
        };
      } else if (tail.reason !== 'cycle') {
        tail = { ...tail, length: tail.length + 1 };
      }
      outcomes.set(link, tail);
    }
    return outcomes.get(start)!;
  };

  return {
    resolve(value) {
      const ref = openApiRefOf(value);
      if (ref === null) return { ok: true, value, overrides: NO_OVERRIDES };
      const outcome = follow(ref);
      // `length` counts lookups: a chain may take MAX_OPENAPI_REF_HOPS of them
      // and must end within them, as an object or as a failure detected there.
      if (outcome.length > MAX_OPENAPI_REF_HOPS) return { ok: false, ref, reason: 'depth' };
      if (!outcome.ok) return { ok: false, ref: outcome.ref, reason: outcome.reason };
      return {
        ok: true,
        value: outcome.value,
        overrides: siblingsApply ? mergeOverrides(value, outcome.overrides) : NO_OVERRIDES,
      };
    },
  };
}

/**
 * Follow one value with a resolver of its own. For a single lookup only — a
 * caller resolving several references of one document shares one
 * {@link createOpenApiRefResolver} between them.
 */
export function resolveOpenApiObject(
  document: unknown,
  value: Record<string, unknown>,
  options: OpenApiResolveOptions = {},
): OpenApiRefResolution {
  return createOpenApiRefResolver(document, options).resolve(value);
}

/**
 * The `(in, name)` identity of a resolved parameter, or `null` when it has none
 * — a reference that cannot be resolved, or an object missing either field. A
 * parameter without an identity is never merged with another one.
 *
 * `in` is compared as written; `name` is compared case-insensitively for
 * headers only, since HTTP header names are.
 */
function parameterKeyOf(resolution: OpenApiRefResolution | null): string | null {
  if (resolution === null || !resolution.ok) return null;
  const { name, in: location } = resolution.value;
  if (typeof name !== 'string' || typeof location !== 'string') return null;
  return `${location}\u0000${location === 'header' ? name.toLowerCase() : name}`;
}

/** See {@link parameterKeyOf}; `parameter` is followed through `resolver`. */
export function openApiParameterKey(
  resolver: OpenApiRefResolver,
  parameter: unknown,
): string | null {
  return parameterKeyOf(isPlainRecord(parameter) ? resolver.resolve(parameter) : null);
}

/** One parameter of an operation's effective list, with its identity. */
export interface KeyedOpenApiParameter {
  /** The entry exactly as written — a Reference Object stays one. */
  parameter: unknown;
  /**
   * What the entry resolves to, so a caller that needs the parameter itself
   * never follows the reference a second time; `null` for a non-object entry.
   */
  resolution: OpenApiRefResolution | null;
  /** See {@link openApiParameterKey}; `null` for an entry with no identity. */
  key: string | null;
  /** Declared on the path item rather than the operation. */
  inherited: boolean;
}

/**
 * Resolve each parameter of one `parameters` list and attach its identity.
 * Path-item lists are keyed once and reused for every operation beneath them.
 */
export function keyOpenApiParameters(
  resolver: OpenApiRefResolver,
  parameters: readonly unknown[],
  inherited: boolean,
): KeyedOpenApiParameter[] {
  return parameters.map((parameter) => {
    const resolution = isPlainRecord(parameter) ? resolver.resolve(parameter) : null;
    return { parameter, resolution, key: parameterKeyOf(resolution), inherited };
  });
}

/**
 * The parameters an operation actually takes: every path-item parameter the
 * operation does not redeclare, followed by the operation's own, each in
 * declaration order. An operation parameter with the same `(in, name)` as a
 * path-item one replaces it; parameters sharing only a name (a `query` and a
 * `header` `id`, say) are distinct and both kept. Entries without an identity
 * are never merged away.
 */
export function mergeOpenApiParameters<T extends KeyedOpenApiParameter>(
  pathParameters: readonly T[],
  operationParameters: readonly T[],
): T[] {
  const overridden = new Set<string>();
  for (const entry of operationParameters) {
    if (entry.key !== null) overridden.add(entry.key);
  }
  return [
    ...pathParameters.filter((entry) => entry.key === null || !overridden.has(entry.key)),
    ...operationParameters,
  ];
}
