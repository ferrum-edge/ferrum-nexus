import { MAX_SPEC_OPERATIONS, OPENAPI_OPERATION_METHODS, type HttpMethod } from './constants.js';
import { resolveOpenApiPointer } from './openapi.js';

/** A provider explicitly selected this operation; no spec extension grants access. */
export interface AgentTool {
  /**
   * Server-owned exposure identity. It lasts only while the binding (method,
   * path and name) and {@link AgentTool.definition_hash} stay the same; a new
   * id leaves every explicit subset grant that held the old one.
   */
  id?: string;
  path: string;
  method: HttpMethod;
  /** Unqualified tool name. Edge prefixes it with the API slug and a dot. */
  name: string;
  description: string;
  /**
   * Server-owned SHA-256 of the tool definition Edge publishes: the
   * description, the operation's summary, parameters, request body and 2xx
   * schemas, with references resolved. Accepted on input and never trusted.
   */
  definition_hash?: string;
}

/** null/absent means off. Every entry is an explicit opt-in, including mutations. */
export interface ApiAgents {
  operations: AgentTool[];
}

export interface AgentOperation extends AgentTool {
  read_only: boolean;
  /** Published Edge does not bridge HEAD, OPTIONS or TRACE. */
  supported: boolean;
}

export const MAX_AGENT_TOOLS = 256;
export const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.\-]{1,128}$/;
export const MAX_AGENT_DESCRIPTION_LENGTH = 2_048;
export const AGENT_TOOL_CALL_LIMIT = 60;
export const AGENT_TOOL_CALL_WINDOW_SECONDS = 60;

export function agentToolName(slug: string, tool: AgentTool): string {
  return `${slug}.${tool.name}`;
}

export function agentEndpointPath(listenPath: string): string {
  return `${listenPath}/mcp`;
}

export function isReadOnlyAgentMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where a Path Item reference may point. */
const PATH_ITEM_REF_BASES = ['#/paths/', '#/components/pathItems/', '#/webhooks/'];

/** Hops one Path Item reference chain may take. */
const MAX_PATH_ITEM_REF_HOPS = 32;

/**
 * A Path Item reached through its chain of references, read in place: nothing
 * is copied, so resolving many paths to one large Path Item costs each path
 * its chain, not the item's size.
 */
export interface AgentPathItem {
  /** The references followed, outermost first, `$ref` member included. */
  chain: readonly Record<string, unknown>[];
  /** What the innermost reference names. */
  target: Record<string, unknown>;
}

/** Shared reads of one document's Path Item chains; see {@link resolveAgentPathItem}. */
export interface AgentPathItemReader {
  /** Every reference node already resolved, keyed by identity. */
  memo?: WeakMap<object, AgentPathItem>;
  /** Called with a cost before each pointer is followed. */
  charge?: (cost: number) => void;
}

/**
 * `value`, the Path Item at `path`, through Edge's chain of local Path Item
 * references: at most 32 hops, acyclic, into `paths`, `components.pathItems`
 * or `webhooks`. Throws for any other chain.
 */
export function resolveAgentPathItem(
  document: Record<string, unknown>,
  path: string,
  value: Record<string, unknown>,
  reader: AgentPathItemReader = {},
): AgentPathItem {
  const { memo, charge } = reader;
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let item = value;
  let known = memo?.get(item);
  while (!known && Object.hasOwn(item, '$ref')) {
    const ref = item.$ref;
    if (
      typeof ref !== 'string' ||
      !PATH_ITEM_REF_BASES.some((base) => ref.startsWith(base)) ||
      seen.has(ref) ||
      seen.size >= MAX_PATH_ITEM_REF_HOPS
    ) {
      throw new Error(`Agent operation ${path} needs an acyclic local Path Item reference`);
    }
    charge?.(ref.length + 1);
    seen.add(ref);
    chain.push(item);
    const target = resolveOpenApiPointer(document, ref);
    if (!record(target)) throw new Error(`Cannot resolve agent operation ${path}`);
    item = target;
    known = memo?.get(item);
  }
  const tail: AgentPathItem = known ?? { chain: [], target: item };
  // A known chain ends at a Path Item, so joining it to this one repeats no
  // reference; only its length can pass the bound.
  if (chain.length + tail.chain.length > MAX_PATH_ITEM_REF_HOPS) {
    throw new Error(`Agent operation ${path} needs an acyclic local Path Item reference`);
  }
  let resolved: AgentPathItem = tail;
  if (!known) memo?.set(item, resolved);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const node = chain[index] as Record<string, unknown>;
    resolved = { chain: [node, ...resolved.chain], target: tail.target };
    memo?.set(node, resolved);
  }
  return resolved;
}

/** One member of a resolved Path Item: the outermost reference that sets it wins. */
export function agentPathItemMember(item: AgentPathItem, key: string): unknown {
  for (const sibling of item.chain) {
    if (key !== '$ref' && Object.hasOwn(sibling, key)) return sibling[key];
  }
  return Object.hasOwn(item.target, key) ? item.target[key] : undefined;
}

/** Every Path Item of `document` with a path, resolved in place, in document order. */
function agentPathItemEntries(document: Record<string, unknown>): [string, AgentPathItem][] {
  if (!record(document.paths)) return [];
  const memo = new WeakMap<object, AgentPathItem>();
  const items: [string, AgentPathItem][] = [];
  for (const [path, value] of Object.entries(document.paths)) {
    if (!path.startsWith('/') || !record(value)) continue;
    items.push([path, resolveAgentPathItem(document, path, value, { memo })]);
  }
  return items;
}

/**
 * Resolve only Path Item objects, with Edge's sibling overlay and a bounded
 * chain, as copies a caller may rewrite. Each copy costs its Path Item's size,
 * so only the stamped document, which must hold every one, builds them, and
 * only once the server has bounded the size of all of them together.
 */
export function agentPathItems(document: Record<string, unknown>): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const [path, { chain, target }] of agentPathItemEntries(document)) {
    let item = { ...target };
    for (const sibling of [...chain].reverse()) {
      const { $ref: _ref, ...overlay } = sibling;
      item = { ...item, ...overlay };
    }
    paths[path] = item;
  }
  return paths;
}

/** Browser defaults are hints only. The server requires an explicit selection payload. */
export function agentOperations(document: Record<string, unknown>): AgentOperation[] {
  const operations: AgentOperation[] = [];
  for (const [path, item] of agentPathItemEntries(document)) {
    for (const method of OPENAPI_OPERATION_METHODS) {
      const operation = agentPathItemMember(item, method);
      if (!record(operation)) continue;
      if (operations.length >= MAX_SPEC_OPERATIONS) {
        throw new Error(
          `OpenAPI document resolves to more than ${MAX_SPEC_OPERATIONS} operations`,
        );
      }
      const upper = method.toUpperCase() as HttpMethod;
      const operationId = typeof operation.operationId === 'string' ? operation.operationId : '';
      const fallback = `${method}_${path}`;
      // Cut before cleaning: one operation may be reached from every path,
      // and each replacement keeps the length, so this reads the same text.
      const name = (operationId || fallback).slice(0, 128).replace(/[^A-Za-z0-9_.-]/g, '_');
      const text = operation.summary || operation.description;
      operations.push({
        path,
        method: upper,
        name,
        description: (typeof text === 'string' ? text : `${upper} ${path}`)
          .slice(0, MAX_AGENT_DESCRIPTION_LENGTH)
          .replace(/[\u0000-\u001f\u007f]/g, ' '),
        read_only: isReadOnlyAgentMethod(upper),
        supported: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(upper),
      });
    }
  }
  return operations;
}

/** null/omitted covers all published tools; [] covers no MCP tools. */
export function grantedAgentTools(agents: ApiAgents, subset?: string[] | null): ApiAgents {
  return {
    operations: agents.operations.filter(
      (tool) => subset == null || (tool.id && subset.includes(tool.id)),
    ),
  };
}

export function mcpAllGroupForApi(apiId: string): string {
  return `nexus:api:${apiId}:mcp:all`;
}

export function mcpToolGroupForApi(apiId: string, toolId: string): string {
  return `nexus:api:${apiId}:mcp:tool:${toolId}`;
}

export function mcpGroupsForGrant(apiId: string, subset?: string[] | null): string[] {
  return subset == null
    ? [mcpAllGroupForApi(apiId)]
    : subset.map((id) => mcpToolGroupForApi(apiId, id));
}

/** Exact API namespace only; unrelated operator groups are preserved. */
export function isMcpGroupForApi(group: string, apiId: string): boolean {
  return group === mcpAllGroupForApi(apiId) || group.startsWith(`nexus:api:${apiId}:mcp:tool:`);
}
