import { OPENAPI_OPERATION_METHODS, type HttpMethod } from './constants.js';
import { resolveOpenApiPointer } from './openapi.js';

/** A provider explicitly selected this operation; no spec extension grants access. */
export interface AgentTool {
  /** Server-owned exposure identity. Changes to bindings invalidate subset grants. */
  id?: string;
  path: string;
  method: HttpMethod;
  /** Unqualified tool name. Edge prefixes it with the API slug and a dot. */
  name: string;
  description: string;
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

/** Resolve only Path Item objects, with Edge's sibling overlay and a bounded chain. */
export function agentPathItems(document: Record<string, unknown>): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  if (!record(document.paths)) return paths;
  for (const [path, value] of Object.entries(document.paths)) {
    if (!path.startsWith('/') || !record(value)) continue;
    let item = value;
    const chain: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    while (Object.hasOwn(item, '$ref')) {
      const ref = item.$ref;
      if (
        typeof ref !== 'string' ||
        !['#/paths/', '#/components/pathItems/', '#/webhooks/'].some((base) =>
          ref.startsWith(base),
        ) ||
        seen.has(ref) ||
        seen.size >= 32
      ) {
        throw new Error(`Agent operation ${path} needs an acyclic local Path Item reference`);
      }
      seen.add(ref);
      chain.push(item);
      const target = resolveOpenApiPointer(document, ref);
      if (!record(target)) throw new Error(`Cannot resolve agent operation ${path}`);
      item = target;
    }
    item = { ...item };
    for (const sibling of chain.reverse()) {
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
  for (const [path, value] of Object.entries(agentPathItems(document))) {
    if (!record(value)) continue;
    for (const method of OPENAPI_OPERATION_METHODS) {
      const operation = value[method];
      if (!record(operation)) continue;
      const upper = method.toUpperCase() as HttpMethod;
      const operationId = typeof operation.operationId === 'string' ? operation.operationId : '';
      const fallback = `${method}_${path}`;
      const name = (operationId || fallback).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
      const text = operation.summary || operation.description;
      operations.push({
        path,
        method: upper,
        name,
        description: (typeof text === 'string' ? text : `${upper} ${path}`)
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .slice(0, MAX_AGENT_DESCRIPTION_LENGTH),
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
