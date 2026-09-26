/**
 * Minimal OpenAPI reader for the built-in documentation renderer.
 *
 * The portal deliberately ships no swagger-ui: specs are parsed and walked
 * structurally. Nothing here throws — a malformed document produces an error
 * result the UI renders as a panel.
 *
 * JSON is tried first, exactly as the server's `parseDocument` does. The `yaml`
 * parser accepts JSON too, but its flow-mapping parse is quadratic in mapping
 * width, so routing a JSON document through it turns a millisecond parse into a
 * multi-second freeze of the viewer's main thread on a document the server
 * happily accepts. Documents that open with `{` or `[` are therefore JSON, and
 * a JSON syntax error in one is reported as such rather than retried as YAML —
 * the same documents the server would reject, refused here for the same reason.
 */

import {
  createOpenApiRefResolver,
  keyOpenApiParameters,
  mergeOpenApiParameters,
  openApiRefSiblingsApply,
  resolveOpenApiPointer,
  type KeyedOpenApiParameter,
  type OpenApiRefFailure,
  type OpenApiRefOverrides,
  type OpenApiRefResolution,
  type OpenApiRefResolver,
} from '@ferrum-nexus/shared';
import { parse as parseYaml } from 'yaml';

/** A `$ref` that could not be resolved locally. */
export const UNRESOLVED_REF = Symbol('unresolved-ref');

/** JSON object with unknown members — every spec node is read through this. */
export type SpecNode = Record<string, unknown>;

/** Narrow an unknown value to a plain object. */
export function asRecord(value: unknown): SpecNode | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SpecNode)
    : null;
}

/** Narrow an unknown value to a string. */
export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Narrow an unknown value to an array. */
export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** HTTP methods rendered as operations, in display order. */
export const HTTP_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
] as const;

/** One HTTP method an operation can use. */
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * A parameter, request body or response after its Reference Objects have been
 * followed. An entry that could not be followed stays explicit, so the renderer
 * can say so instead of showing an empty — or, for a parameter, optional — row.
 */
export type SpecEntry = ResolvedSpecEntry | UnresolvedSpecEntry;

/**
 * A followed entry. `node` is the document's own object — shared by every
 * reference to it, never copied — and `overrides` carries the OpenAPI 3.1
 * `summary`/`description` siblings written next to the `$ref`, which the
 * renderer prefers over the node's own.
 */
export interface ResolvedSpecEntry {
  resolved: true;
  node: SpecNode;
  overrides: OpenApiRefOverrides;
}

/** A Reference Object that could not be followed, and why. */
export interface UnresolvedSpecEntry {
  resolved: false;
  ref: string;
  reason: OpenApiRefFailure;
}

/** A single operation, flattened from `paths[path][method]`. */
export interface SpecOperation {
  /** Stable id used as a React key and anchor. */
  id: string;
  method: HttpMethod;
  path: string;
  summary: string | null;
  description: string | null;
  operationId: string | null;
  deprecated: boolean;
  tags: string[];
  /**
   * The effective parameters: path-level ones the operation does not override
   * by `(in, name)`, then the operation's own.
   */
  parameters: SpecEntry[];
  requestBody: SpecEntry | null;
  /** `[statusCode, responseObject]` pairs in declaration order. */
  responses: Array<[string, SpecEntry]>;
}

/** Operations grouped under one tag. */
export interface SpecTagGroup {
  name: string;
  description: string | null;
  operations: SpecOperation[];
}

/** A server entry from the document root. */
export interface SpecServer {
  url: string;
  description: string | null;
}

/** Everything the renderer needs from a parsed document. */
export interface ParsedSpec {
  /** The raw document, kept for `$ref` resolution. */
  doc: SpecNode;
  title: string;
  version: string | null;
  description: string | null;
  /** `openapi` / `swagger` version string, when present. */
  specVersion: string | null;
  servers: SpecServer[];
  groups: SpecTagGroup[];
  operationCount: number;
  /** Names of the schemas under `components.schemas`, in declaration order. */
  schemaNames: string[];
}

/** Result of {@link parseSpecText}. */
export type SpecParseResult = { ok: true; spec: ParsedSpec } | { ok: false; error: string };

function readServers(doc: SpecNode): SpecServer[] {
  const servers = asArray(doc.servers);
  if (!servers) return [];
  const result: SpecServer[] = [];
  for (const entry of servers) {
    const record = asRecord(entry);
    const url = record ? asString(record.url) : null;
    if (url) result.push({ url, description: record ? asString(record.description) : null });
  }
  return result;
}

function readTagDescriptions(doc: SpecNode): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const entry of asArray(doc.tags) ?? []) {
    const record = asRecord(entry);
    const name = record ? asString(record.name) : null;
    const description = record ? asString(record.description) : null;
    if (name && description) descriptions.set(name, description);
  }
  return descriptions;
}

/** A resolution as the renderer consumes it. */
function toEntry(resolution: OpenApiRefResolution): SpecEntry {
  return resolution.ok
    ? { resolved: true, node: resolution.value, overrides: resolution.overrides }
    : { resolved: false, ref: resolution.ref, reason: resolution.reason };
}

/** A keyed parameter together with the entry the renderer shows for it. */
interface EntryParameter extends KeyedOpenApiParameter {
  entry: SpecEntry;
}

/**
 * The object members of one `parameters` list, each resolved once and keyed by
 * `(in, name)`; anything that is not an object was never a parameter.
 */
function readParameters(
  resolver: OpenApiRefResolver,
  value: unknown,
  inherited: boolean,
): EntryParameter[] {
  const nodes: SpecNode[] = [];
  for (const item of asArray(value) ?? []) {
    const record = asRecord(item);
    if (record) nodes.push(record);
  }
  return keyOpenApiParameters(resolver, nodes, inherited).map((keyed) => ({
    ...keyed,
    // Every node is an object, so each one was resolved.
    entry: toEntry(keyed.resolution!),
  }));
}

/**
 * Every operation of the document. One resolver serves the whole document, so
 * each distinct `$ref` is followed once however many places use it, and a
 * path item's parameters are resolved once for all the operations beneath it.
 */
function readOperations(doc: SpecNode, specVersion: string | null): SpecOperation[] {
  const paths = asRecord(doc.paths);
  if (!paths) return [];
  const operations: SpecOperation[] = [];
  const resolver = createOpenApiRefResolver(doc, {
    siblingsApply: openApiRefSiblingsApply(specVersion),
  });
  const resolve = (node: SpecNode): SpecEntry => toEntry(resolver.resolve(node));

  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = asRecord(pathValue);
    if (!pathItem) continue;
    const sharedParameters = readParameters(resolver, pathItem.parameters, true);

    for (const method of HTTP_METHODS) {
      const operation = asRecord(pathItem[method]);
      if (!operation) continue;

      const ownParameters = readParameters(resolver, operation.parameters, false);
      const merged = mergeOpenApiParameters(sharedParameters, ownParameters);
      const parameters = merged.map((parameter) => parameter.entry);

      const responses: Array<[string, SpecEntry]> = [];
      const responsesNode = asRecord(operation.responses);
      if (responsesNode) {
        for (const [status, value] of Object.entries(responsesNode)) {
          const record = asRecord(value);
          if (record) responses.push([status, resolve(record)]);
        }
      }
      const requestBody = asRecord(operation.requestBody);

      const tags = [
        ...new Set(
          (asArray(operation.tags) ?? [])
            .map(asString)
            .filter((tag): tag is string => tag !== null),
        ),
      ];

      operations.push({
        id: `${method}-${path}`,
        method,
        path,
        summary: asString(operation.summary),
        description: asString(operation.description),
        operationId: asString(operation.operationId),
        deprecated: operation.deprecated === true,
        tags,
        parameters,
        requestBody: requestBody ? resolve(requestBody) : null,
        responses,
      });
    }
  }
  return operations;
}

function groupByTag(
  operations: SpecOperation[],
  descriptions: Map<string, string>,
): SpecTagGroup[] {
  const groups = new Map<string, SpecOperation[]>();
  for (const operation of operations) {
    const names = operation.tags.length > 0 ? operation.tags : ['Untagged'];
    for (const name of names) {
      const existing = groups.get(name);
      if (existing) existing.push(operation);
      else groups.set(name, [operation]);
    }
  }
  return [...groups.entries()].map(([name, ops]) => ({
    name,
    description: descriptions.get(name) ?? null,
    operations: ops,
  }));
}

/**
 * The HTTP methods a document declares, uppercased and deduplicated.
 *
 * Feeds the "use the methods declared in the spec" shortcut on the publish and
 * settings forms; a document that does not parse simply declares none. The
 * caller decides the order — Edge's `allowed_methods` enum is the canonical
 * one — so this returns a set-like list, not a sorted one.
 */
export function declaredMethods(text: string): string[] {
  const result = parseSpecText(text);
  if (!result.ok) return [];
  const found = new Set<string>();
  for (const group of result.spec.groups) {
    for (const operation of group.operations) found.add(operation.method.toUpperCase());
  }
  return [...found];
}

/** The message of a thrown parser error, for the panel the UI renders. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse an OpenAPI document supplied as JSON or YAML text.
 *
 * JSON first — see the module docblock for why the distinction is not merely
 * cosmetic. Never throws: syntax errors and structurally invalid documents both
 * come back as `{ ok: false, error }`.
 */
export function parseSpecText(text: string): SpecParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, error: 'The specification is empty.' };

  let parsed: unknown;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      return { ok: false, error: `Could not parse the specification as JSON: ${reason(error)}` };
    }
  } else {
    try {
      parsed = parseYaml(trimmed) as unknown;
    } catch (error) {
      return { ok: false, error: `Could not parse the specification: ${reason(error)}` };
    }
  }

  const doc = asRecord(parsed);
  if (!doc) {
    return {
      ok: false,
      error: 'The specification is not an object (expected an OpenAPI document).',
    };
  }

  const specVersion = asString(doc.openapi) ?? asString(doc.swagger);
  const info = asRecord(doc.info);
  const paths = asRecord(doc.paths);
  if (!paths && !specVersion) {
    return {
      ok: false,
      error: 'This does not look like an OpenAPI document: no `openapi`/`swagger` or `paths` key.',
    };
  }

  const operations = readOperations(doc, specVersion);
  const components = asRecord(doc.components);
  const schemas = components ? asRecord(components.schemas) : null;

  return {
    ok: true,
    spec: {
      doc,
      title: (info ? asString(info.title) : null) ?? 'Untitled API',
      version: info ? asString(info.version) : null,
      description: info ? asString(info.description) : null,
      specVersion,
      servers: readServers(doc),
      groups: groupByTag(operations, readTagDescriptions(doc)),
      operationCount: operations.length,
      schemaNames: schemas ? Object.keys(schemas) : [],
    },
  };
}

/** Pointers already walked, per document; see {@link resolveRef}. */
const resolvedRefs = new WeakMap<SpecNode, Map<string, SpecNode | typeof UNRESOLVED_REF>>();

/**
 * Resolve a local `#/a/b/c` reference against `doc`.
 *
 * External references (anything not starting with `#/`) and dangling pointers
 * return {@link UNRESOLVED_REF} so the caller can render a placeholder instead
 * of pretending the schema is empty. Only own members are followed. Memoised
 * per document, so a schema `$ref` used across a page is walked once.
 */
export function resolveRef(doc: SpecNode, ref: string): SpecNode | typeof UNRESOLVED_REF {
  if (!ref.startsWith('#/')) return UNRESOLVED_REF;
  let known = resolvedRefs.get(doc);
  if (!known) {
    known = new Map();
    resolvedRefs.set(doc, known);
  }
  const cached = known.get(ref);
  if (cached !== undefined) return cached;
  const resolved = asRecord(resolveOpenApiPointer(doc, ref)) ?? UNRESOLVED_REF;
  known.set(ref, resolved);
  return resolved;
}

/** Longest `$ref` shown in full; the document can make one as long as it likes. */
export const MAX_DISPLAYED_REF_LENGTH = 200;

/** `ref` for display, cut to {@link MAX_DISPLAYED_REF_LENGTH} characters. */
export function displayedRef(ref: string): string {
  return ref.length > MAX_DISPLAYED_REF_LENGTH ? `${ref.slice(0, MAX_DISPLAYED_REF_LENGTH)}…` : ref;
}

/**
 * Short display name for a `$ref` (`#/components/schemas/Pet` → `Pet`), cut
 * like {@link displayedRef}.
 */
export function refName(ref: string): string {
  return displayedRef(ref.slice(ref.lastIndexOf('/') + 1));
}
