import {
  AGENT_TOOL_CALL_LIMIT,
  AGENT_TOOL_CALL_WINDOW_SECONDS,
  AGENT_TOOL_NAME_PATTERN,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_TOOLS,
  OPENAPI_OPERATION_METHODS,
  mcpAllGroupForApi,
  mcpToolGroupForApi,
  agentEndpointPath,
  agentOperations,
  agentPathItems,
  agentToolName,
  isReadOnlyAgentMethod,
  type ApiAgents,
  type HttpMethod,
  type SpecEnforcementLevel,
} from '@ferrum-nexus/shared';

import type { EdgeRateLimitSyncConfig } from '../config/index.js';
import type { EdgePluginConfig, EdgePluginConfigWrite } from '../ferrum-admin/types.js';
import { conflict, specInvalid } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { writeBody } from './edge-plugins.js';

export interface AgentDeployment {
  apiId: string;
  slug: string;
  agents: ApiAgents;
  sync: EdgeRateLimitSyncConfig;
  /** Fresh, ownership-preserving reads, made under the canonical proxy lease. */
  live?: EdgePluginConfig[];
  specId?: string;
}

/** Ignore client-supplied IDs. Preserve only a currently published binding. */
export function identifyAgentTools(
  next: ApiAgents | null,
  previous: ApiAgents | null = null,
  rotate = false,
): ApiAgents | null {
  if (!next) return null;
  return {
    operations: next.operations.map(({ id: _id, ...tool }) => {
      const prior =
        !rotate &&
        previous?.operations.find(
          (item) =>
            item.method === tool.method && item.path === tool.path && item.name === tool.name,
        );
      return { ...tool, id: prior ? (prior.id ?? newId()) : newId() };
    }),
  };
}

/** Literal escaping matches Edge's regex::escape; slash is not a metacharacter. */
function escapeRegex(value: string): string {
  return value.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, '\\$&');
}

function pathRegex(path: string): string {
  return (
    '^' +
    path
      .split(/(\{[^{}/]+\})/)
      .map((part) => (/^\{[^{}/]+\}$/.test(part) ? '[^/]+' : escapeRegex(part)))
      .join('') +
    '$'
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** No automatic selections, name collisions, path escapes, or method-policy bypasses. */
export function validateAgents(
  agents: ApiAgents | null | undefined,
  document: Record<string, unknown>,
  enforcement: SpecEnforcementLevel,
  requestable: boolean,
  methods: HttpMethod[] | null,
): void {
  if (!agents) return;
  const invalid = (message: string): never => {
    throw specInvalid(message, { field: 'agents' });
  };
  if (enforcement !== 'routes') invalid('AI agents require routes enforcement');
  if (!requestable) invalid('AI agents require approved access requests');
  if (methods !== null && !methods.includes('POST')) {
    invalid('AI agents require POST in the method allow-list for the MCP endpoint');
  }
  if (agents.operations.length === 0 || agents.operations.length > MAX_AGENT_TOOLS) {
    invalid(`Select between 1 and ${MAX_AGENT_TOOLS} agent operations`);
  }
  let operations: ReturnType<typeof agentOperations> = [];
  try {
    operations = agentOperations(document);
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'Cannot resolve agent operations');
  }
  const names = new Set<string>();
  const selected = new Set<string>();
  for (const tool of agents.operations) {
    const key = `${tool.method} ${tool.path}`;
    const operation = operations.find(
      (item) => item.method === tool.method && item.path === tool.path,
    );
    if (!operation?.supported) invalid(`Unsupported or missing agent operation: ${key}`);
    if (methods !== null && !methods.includes(tool.method)) {
      invalid(`The method allow-list does not permit ${key}`);
    }
    if (!AGENT_TOOL_NAME_PATTERN.test(tool.name) || names.has(tool.name) || selected.has(key)) {
      invalid(`Agent tool names and operations must be valid and unique: ${key}`);
    }
    if (
      tool.description.trim() === '' ||
      tool.description.length > MAX_AGENT_DESCRIPTION_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(tool.description)
    ) {
      invalid(`Provide a plain-text description for ${key}`);
    }
    names.add(tool.name);
    selected.add(key);
  }
  // The endpoint claims a subtree. Check ALL REST operations, including those
  // not exposed, so enabling MCP cannot steal an existing REST route.
  for (const operation of operations) {
    const path = operation.path;
    if (
      /[%\\?#;\u0000-\u0020\u007f-\uffff]/.test(path) ||
      path.split('/').some((segment) => segment === '.' || segment === '..') ||
      path.includes('//') ||
      path.split('/').some((segment) => /[{}]/.test(segment) && !/^\{[^{}]+\}$/.test(segment))
    ) {
      invalid(`Agent APIs require canonical paths with whole-segment parameters: ${path}`);
    }
    if (
      new RegExp(pathRegex(path)).test('/mcp') ||
      path.toLowerCase().startsWith('/mcp/') ||
      path.toLowerCase() === '/mcp' ||
      /^\{[^{}]+\}$/.test(path.split('/')[1] ?? '')
    ) {
      invalid(`The MCP endpoint collides with a REST operation: ${path}`);
    }
  }
}

/**
 * The released importer cannot combine x-ferrum-validate and x-ferrum-mcp.
 * Embed a routes-only validator using the same literal-prefix matchers instead.
 * Only the exact endpoint bypasses it; mcp_gateway claims/rejects that endpoint
 * and its descendants. REST bodies, backend and auth remain unchanged.
 */
export function stampAgentDocument(
  document: Record<string, unknown>,
  proxy: Record<string, unknown>,
  deployment: AgentDeployment,
): void {
  const { agents, apiId, slug, sync } = deployment;
  const proxyId = String(proxy.id);
  const listenPath = String(proxy.listen_path);
  const endpoint = agentEndpointPath(listenPath);
  const tools = new Map(agents.operations.map((tool) => [`${tool.method} ${tool.path}`, tool]));
  const paths = agentPathItems(document);
  const routes: Record<string, unknown>[] = [];
  for (const [path, value] of Object.entries(paths)) {
    if (!record(value)) continue;
    const item = { ...value };
    delete item.servers;
    for (const method of OPENAPI_OPERATION_METHODS) {
      const operation = item[method];
      if (!record(operation)) continue;
      const upper = method.toUpperCase();
      const tool = tools.get(`${upper} ${path}`);
      const clean = { ...operation };
      delete clean.servers;
      for (const key of Object.keys(clean)) {
        if (key.startsWith('x-ferrum-')) delete clean[key];
      }
      clean['x-ferrum-mcp'] = tool
        ? {
            expose: true,
            name: tool.name,
            description: tool.description,
            annotations: {
              readOnlyHint: isReadOnlyAgentMethod(upper),
              destructiveHint: !isReadOnlyAgentMethod(upper),
            },
          }
        : { expose: false };
      item[method] = clean;
      const mounted = path === '/' ? listenPath : `${listenPath}${path}`;
      routes.push({ method: upper, path_template: mounted, path_regex: pathRegex(mounted) });
    }
    paths[path] = item;
  }
  document.paths = paths;
  delete document['x-ferrum-validate'];
  document['x-ferrum-mcp'] = { enabled: true, endpoint: { path: endpoint }, namespace: slug };

  const toolPolicy = Object.fromEntries(
    agents.operations.map((tool) => [
      agentToolName(slug, tool),
      {
        action: 'allow',
        allowed_groups: [
          mcpAllGroupForApi(apiId),
          // Legacy selections have no subset identity until an authenticated republish.
          ...(tool.id ? [mcpToolGroupForApi(apiId, tool.id)] : []),
        ],
      },
    ]),
  );
  const governorPolicy = Object.fromEntries(
    agents.operations.map((tool) => [
      agentToolName(slug, tool),
      { action: 'allow', risk: isReadOnlyAgentMethod(tool.method) ? 'low' : 'high' },
    ]),
  );
  const trigger = { when: { match: { path: { exact: [endpoint] } } } };
  const plugins: EdgePluginConfigWrite[] = [];
  const add = (
    role: string,
    name: string,
    settings: Record<string, unknown>,
    scoped = true,
  ): void => {
    // IDs are chosen before every write and regenerated from the recorded proxy
    // identity. Same-name operator rows are neither copied nor deleted.
    const id = `${proxyId}-nexus-${role}`;
    let live = deployment.live?.find((plugin) => plugin.id === id);
    if (
      live &&
      (!deployment.specId || live.plugin_name !== name || live.api_spec_id !== deployment.specId)
    ) {
      throw conflict('An agent plugin id is occupied by a resource Nexus does not own', { id });
    }
    if (!live && role === 'routes' && deployment.specId) {
      // Enabling on a routes API replaces its importer-generated validator.
      // Carry the resource fields from that owning spec, never a hand-owned
      // same-name config. Multiple candidates are ambiguous and not adopted.
      const validators =
        deployment.live?.filter(
          (plugin) => plugin.plugin_name === name && plugin.api_spec_id === deployment.specId,
        ) ?? [];
      if (validators.length > 1) {
        throw conflict('The owning spec has multiple route validators');
      }
      live = validators[0];
    }
    plugins.push({
      id,
      ...writeBody(proxyId, name, settings, { trigger: scoped ? trigger : null }, live),
    });
  };
  add(
    'routes',
    'openapi_validator',
    {
      enforcement_mode: 'block',
      validate_request: false,
      validate_response: false,
      fail_on_unknown_operation: true,
      operations: routes,
      bypass: { paths: [`^${escapeRegex(endpoint)}$`] },
    },
    false,
  );
  add(
    'mcp',
    'mcp_gateway',
    {
      mode: 'aggregate_router',
      endpoint: { path: endpoint },
      policy: { default_action: 'deny', hide_denied_tools: true, tools: toolPolicy },
      capabilities: {
        advertise_tools: true,
        advertise_resources: false,
        advertise_prompts: false,
        advertise_logging: false,
        advertise_completions: false,
        advertise_tasks: false,
        passthrough_unknown_methods: false,
      },
      validation: { validate_tool_arguments: true },
      observability: { log_raw_arguments: false, log_argument_hash: false },
    },
    false,
  );
  add('governor', 'ai_tool_governor', {
    mode: 'enforce',
    default_action: 'deny',
    inspect: { mcp_tool_calls: true, response_tool_calls: false },
    tools: governorPolicy,
    observability: { hash_arguments: false, max_argument_log_bytes: 0 },
  });
  add('shield', 'ai_prompt_shield', {
    action: 'reject',
    scan_fields: 'mcp_arguments',
    patterns: ['ssn', 'credit_card', 'api_key', 'aws_key'],
    max_scan_bytes: 1_048_576,
  });
  add('tool-budget', 'rate_limiting', {
    limit_by: 'consumer',
    limits: [
      {
        scope: 'default',
        window_seconds: AGENT_TOOL_CALL_WINDOW_SECONDS,
        max_requests: AGENT_TOOL_CALL_LIMIT,
      },
    ],
    mcp_tool_calls: { endpoint_path: endpoint },
    ...(sync.syncMode === 'redis' && sync.redisUrl !== undefined
      ? {
          sync_mode: 'redis',
          redis_url: sync.redisUrl,
          redis_tls: sync.redisTls,
          redis_failure_policy: 'fail_closed',
          redis_key_prefix: `nexus:${apiId}:mcp`,
        }
      : {}),
  });
  document['x-ferrum-plugins'] = plugins;
}
