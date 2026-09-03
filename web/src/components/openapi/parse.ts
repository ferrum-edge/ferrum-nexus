/**
 * Minimal OpenAPI reader for the built-in documentation renderer.
 *
 * The portal deliberately ships no swagger-ui: specs are parsed with `yaml`
 * (which also accepts JSON) and walked structurally. Nothing here throws — a
 * malformed document produces an error result the UI renders as a panel.
 */

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
  /** Path-level parameters merged ahead of operation-level ones. */
  parameters: SpecNode[];
  requestBody: SpecNode | null;
  /** `[statusCode, responseObject]` pairs in declaration order. */
  responses: Array<[string, SpecNode]>;
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

function readOperations(doc: SpecNode): SpecOperation[] {
  const paths = asRecord(doc.paths);
  if (!paths) return [];
  const operations: SpecOperation[] = [];

  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = asRecord(pathValue);
    if (!pathItem) continue;
    const sharedParameters = (asArray(pathItem.parameters) ?? [])
      .map(asRecord)
      .filter((entry): entry is SpecNode => entry !== null);

    for (const method of HTTP_METHODS) {
      const operation = asRecord(pathItem[method]);
      if (!operation) continue;

      const ownParameters = (asArray(operation.parameters) ?? [])
        .map(asRecord)
        .filter((entry): entry is SpecNode => entry !== null);

      const responses: Array<[string, SpecNode]> = [];
      const responsesNode = asRecord(operation.responses);
      if (responsesNode) {
        for (const [status, value] of Object.entries(responsesNode)) {
          const record = asRecord(value);
          if (record) responses.push([status, record]);
        }
      }

      const tags = (asArray(operation.tags) ?? [])
        .map(asString)
        .filter((tag): tag is string => tag !== null);

      operations.push({
        id: `${method}-${path}`,
        method,
        path,
        summary: asString(operation.summary),
        description: asString(operation.description),
        operationId: asString(operation.operationId),
        deprecated: operation.deprecated === true,
        tags,
        parameters: [...sharedParameters, ...ownParameters],
        requestBody: asRecord(operation.requestBody),
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

/**
 * Parse an OpenAPI document supplied as YAML or JSON text.
 *
 * Never throws: syntax errors and structurally invalid documents both come back
 * as `{ ok: false, error }`.
 */
export function parseSpecText(text: string): SpecParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, error: 'The specification is empty.' };

  let parsed: unknown;
  try {
    parsed = parseYaml(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not parse the specification: ${message}` };
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

  const operations = readOperations(doc);
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

/**
 * Resolve a local `#/a/b/c` reference against `doc`.
 *
 * External references (anything not starting with `#/`) and dangling pointers
 * return {@link UNRESOLVED_REF} so the caller can render a placeholder instead
 * of pretending the schema is empty.
 */
export function resolveRef(doc: SpecNode, ref: string): SpecNode | typeof UNRESOLVED_REF {
  if (!ref.startsWith('#/')) return UNRESOLVED_REF;
  let current: unknown = doc;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    const record = asRecord(current);
    if (!record || !(segment in record)) return UNRESOLVED_REF;
    current = record[segment];
  }
  const resolved = asRecord(current);
  return resolved ?? UNRESOLVED_REF;
}

/** Short display name for a `$ref` (`#/components/schemas/Pet` → `Pet`). */
export function refName(ref: string): string {
  const parts = ref.split('/');
  return parts[parts.length - 1] ?? ref;
}
