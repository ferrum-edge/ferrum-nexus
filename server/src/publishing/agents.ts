import { createHash } from 'node:crypto';

import {
  AGENT_TOOL_CALL_LIMIT,
  AGENT_TOOL_CALL_WINDOW_SECONDS,
  AGENT_TOOL_NAME_PATTERN,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_TOOLS,
  MAX_OPENAPI_REF_HOPS,
  MAX_SPEC_BYTES,
  OPENAPI_OPERATION_METHODS,
  mcpAllGroupForApi,
  mcpToolGroupForApi,
  agentEndpointPath,
  agentOperations,
  agentPathItems,
  agentToolName,
  isReadOnlyAgentMethod,
  resolveOpenApiPointer,
  type AgentTool,
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

/** The selection fields a tool's identity and definition depend on. */
type AgentToolSelection = Pick<AgentTool, 'method' | 'path' | 'name' | 'description'>;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isJsonMediaType(mediaType: string): boolean {
  const essence = (mediaType.split(';')[0] ?? mediaType).trim().toLowerCase();
  return essence === 'application/json' || essence.endsWith('+json');
}

/** The schemas of every JSON media type in a Content map, keyed by media type. */
function jsonMediaSchemas(content: unknown): Record<string, unknown> | null {
  if (!record(content)) return null;
  const schemas: Record<string, unknown> = {};
  for (const [mediaType, media] of Object.entries(content)) {
    if (isJsonMediaType(mediaType)) schemas[mediaType] = record(media) ? media.schema : media;
  }
  return schemas;
}

/**
 * A Request Body or Response, through its chain of local Reference Objects,
 * with each reference's sibling fields laid over its target. Anything that
 * does not resolve is returned as it is, for the canonical form to fold in.
 */
function followReference(document: Record<string, unknown>, value: unknown): unknown {
  let current = value;
  const overlays: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (record(current) && typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (!ref.startsWith('#/') || seen.has(ref) || seen.size >= MAX_OPENAPI_REF_HOPS) {
      return value;
    }
    const target = resolveOpenApiPointer(document, ref);
    if (target === undefined) return value;
    seen.add(ref);
    const { $ref: _ref, ...overlay } = current;
    overlays.push(overlay);
    current = target;
  }
  if (!record(current)) return current;
  // The outermost reference's siblings win, as in agentPathItems.
  let resolved = { ...current };
  for (const overlay of overlays.reverse()) resolved = { ...resolved, ...overlay };
  return resolved;
}

/**
 * What Edge's MCP bridge publishes for one selected operation, before its
 * schema references are resolved. It mirrors the pinned extractor's
 * `generate_mcp_bridge_operation`, over-including where that is simpler: an
 * extra field only costs a re-approval, a missing one would let an explicit
 * subset follow a changed tool.
 */
function toolDefinition(
  document: Record<string, unknown>,
  paths: Record<string, unknown>,
  tool: AgentToolSelection,
): Record<string, unknown> {
  const item = paths[tool.path];
  const operation = record(item) ? item[tool.method.toLowerCase()] : undefined;
  const definition: Record<string, unknown> = {
    // Edge normalizes schemas by the document's OpenAPI version.
    openapi: document.openapi ?? null,
    method: tool.method,
    path: tool.path,
    name: tool.name,
    description: tool.description,
  };
  // validateAgents refuses a selection with no operation; this stays total.
  if (!record(item) || !record(operation)) return { ...definition, operation: null };
  const body = followReference(document, operation.requestBody ?? null);
  const responses = record(operation.responses) ? operation.responses : {};
  const outputs: Record<string, unknown> = {};
  for (const [status, value] of Object.entries(responses)) {
    if (!/^2([0-9]{2}|XX)$/.test(status)) continue;
    const response = followReference(document, value);
    outputs[status] = record(response) ? jsonMediaSchemas(response.content) : response;
  }
  return {
    ...definition,
    // Edge's tool title.
    summary: operation.summary ?? null,
    operation_description: operation.description ?? null,
    // Path Item parameters, then the operation's own, which override them.
    parameters: [item.parameters ?? null, operation.parameters ?? null],
    request_body: record(body)
      ? {
          required: body.required ?? null,
          description: body.description ?? null,
          content: jsonMediaSchemas(body.content),
        }
      : body,
    // Edge publishes the first 2xx JSON object schema as the output schema.
    responses: outputs,
  };
}

/**
 * JSON Schema keywords that make a reference mean something other than a
 * pointer from the document root: a resource identifier rebases the
 * references beneath it, and dynamic references resolve at evaluation time.
 */
const REBASING_KEYWORDS = ['$id', '$dynamicRef', '$recursiveRef'];

/**
 * Hash input, in characters, that resolving references may cost one build of
 * tool hashes (every tool of one document) before it falls back to the whole
 * document. A legitimate document resolves each target once, so it stays far
 * below this; past it, references are amplifying the work.
 */
export const MAX_DEFINITION_HASH_WORK = 8 * MAX_SPEC_BYTES;

/** Nesting, through values and references together, one tool hash may descend. */
export const MAX_DEFINITION_HASH_DEPTH = 1_024;

/** Work counters a test may pass, to assert what hashing cost without timing it. */
export interface DefinitionHashStats {
  /** Characters fed to SHA-256, the whole-document fallback included. */
  hashed: number;
  /** Local references looked up in the document. */
  lookups: number;
  /** Whether the build ran out of budget and hashed every tool by the whole document. */
  overBudget: boolean;
}

/** Thrown when one build of tool hashes exceeds its work or depth budget. */
class HashBudgetExceeded extends Error {}

/** A reference target's digest, and whether anything beneath it was unresolvable. */
interface TargetDigest {
  text: string;
  unresolved: boolean;
}

/** One digest computation: what it inherits from what it reached. */
interface HashFrame {
  unresolved: boolean;
  /**
   * Whether it reached a cycle. Such a digest depends on where the cycle was
   * entered, so it is reused only within the tool that computed it.
   */
  cyclic: boolean;
}

/**
 * A pointer's segments as {@link resolveOpenApiPointer} decodes them, so every
 * spelling of one location is one key. Called only on a pointer that resolved.
 */
function pointerKey(ref: string): string {
  if (ref === '#') return '[]';
  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~'));
  return JSON.stringify(segments);
}

/** Canonical JSON with sorted keys, streamed into `write`, with every `$ref` left as text. */
function writeLiteral(value: unknown, write: (text: string) => void): void {
  if (Array.isArray(value)) {
    write('[');
    value.forEach((item, index) => {
      if (index > 0) write(',');
      writeLiteral(item, write);
    });
    write(']');
  } else if (record(value)) {
    write('{');
    Object.keys(value)
      .sort()
      .forEach((key, index) => {
        write(`${index > 0 ? ',' : ''}${JSON.stringify(key)}:`);
        writeLiteral(value[key], write);
      });
    write('}');
  } else {
    write(JSON.stringify(value ?? null));
  }
}

/** The SHA-256 of {@link writeLiteral}'s form of `value`. Linear in its size. */
function literalDigest(value: unknown, stats: DefinitionHashStats): string {
  const hash = createHash('sha256');
  writeLiteral(value, (text) => {
    stats.hashed += text.length;
    hash.update(text);
  });
  return hash.digest('hex');
}

/**
 * Digests tool definitions of one document, every local `$ref` in them
 * replaced by the reference string together with the digest of what it names.
 *
 * - **Memo by node.** A target is keyed by the object it resolves to (or, for
 *   a scalar, its decoded location), so the many spellings of one pointer are
 *   one entry. A digest that reached no cycle depends only on its content, and
 *   is shared by every tool of the build. A reference back into a target
 *   still being digested stands for itself, as its distance up the stack of
 *   targets: its content is already part of that enclosing target. A digest
 *   that reached one depends on where the cycle was entered, so it is reused
 *   within its tool only. Either way a tool's hash never depends on which
 *   other tools were hashed.
 * - **Budget.** Every character hashed, across the build, is charged to
 *   {@link MAX_DEFINITION_HASH_WORK}, and nesting to
 *   {@link MAX_DEFINITION_HASH_DEPTH}. Past either, {@link HashBudgetExceeded}
 *   abandons the build.
 * - Anything Nexus cannot resolve from the document root (an external or
 *   anchor reference, a dangling pointer, a rebased or dynamic reference) is
 *   reported as `unresolved`.
 */
function resolvingDigester(
  document: Record<string, unknown>,
  stats: DefinitionHashStats,
): (definition: Record<string, unknown>) => TargetDigest {
  const shared = new Map<unknown, TargetDigest>();
  let work = 0;
  const spend = (count: number): void => {
    stats.hashed += count;
    work += count;
    if (work > MAX_DEFINITION_HASH_WORK) throw new HashBudgetExceeded();
  };
  return (definition) => {
    const local = new Map<unknown, TargetDigest>();
    const active = new Map<object, number>();
    let frame: HashFrame = { unresolved: false, cyclic: false };
    let depth = 0;

    const digest = (value: unknown): string => {
      const hash = createHash('sha256');
      emit(value, (text) => {
        spend(text.length);
        hash.update(text);
      });
      return hash.digest('hex');
    };

    const target = (ref: string): string => {
      const quoted = JSON.stringify(ref);
      if (ref !== '#' && !ref.startsWith('#/')) {
        frame.unresolved = true;
        return `[${quoted},"external"]`;
      }
      stats.lookups += 1;
      const resolved = resolveOpenApiPointer(document, ref);
      if (resolved === undefined) {
        frame.unresolved = true;
        return `[${quoted},"missing"]`;
      }
      const node = typeof resolved === 'object' && resolved !== null ? resolved : null;
      const key = node ?? pointerKey(ref);
      const index = node ? active.get(node) : undefined;
      if (index !== undefined) {
        frame.cyclic = true;
        return `[${quoted},"cycle:${active.size - index}"]`;
      }
      const known = shared.get(key) ?? local.get(key);
      if (known) {
        frame.unresolved ||= known.unresolved;
        // Only a digest that reached a cycle is kept for this tool alone.
        frame.cyclic ||= !shared.has(key);
        return `[${quoted},${known.text}]`;
      }
      const outer = frame;
      frame = { unresolved: false, cyclic: false };
      if (node) active.set(node, active.size);
      const computed: TargetDigest = {
        text: JSON.stringify(`sha256:${digest(resolved)}`),
        unresolved: frame.unresolved,
      };
      if (node) active.delete(node);
      (frame.cyclic ? local : shared).set(key, computed);
      outer.unresolved ||= frame.unresolved;
      outer.cyclic ||= frame.cyclic;
      frame = outer;
      return `[${quoted},${computed.text}]`;
    };

    const emit = (value: unknown, write: (text: string) => void): void => {
      depth += 1;
      if (depth > MAX_DEFINITION_HASH_DEPTH) throw new HashBudgetExceeded();
      if (Array.isArray(value)) {
        write('[');
        value.forEach((item, index) => {
          if (index > 0) write(',');
          emit(item, write);
        });
        write(']');
      } else if (record(value)) {
        if (REBASING_KEYWORDS.some((keyword) => Object.hasOwn(value, keyword))) {
          frame.unresolved = true;
        }
        write('{');
        Object.keys(value)
          .sort()
          .forEach((key, index) => {
            write(`${index > 0 ? ',' : ''}${JSON.stringify(key)}:`);
            const child = value[key];
            if (key === '$ref' && typeof child === 'string') write(target(child));
            else emit(child, write);
          });
        write('}');
      } else {
        write(JSON.stringify(value ?? null));
      }
      depth -= 1;
    };

    const text = digest(definition);
    return { text, unresolved: frame.unresolved };
  };
}

/** The fields of a selection that name a tool, as hash input. */
function selectionText(tool: AgentToolSelection): string {
  return JSON.stringify([tool.method, tool.path, tool.name, tool.description]);
}

/**
 * Unbound definition digests of `tools`, all in one `document`; see
 * {@link agentToolDefinitionDigests}.
 */
function definitionDigests(
  document: Record<string, unknown>,
  tools: readonly AgentToolSelection[],
  stats: DefinitionHashStats,
): string[] {
  // The whole document but `info`, hashed as text: its references are not
  // followed, because every local target is already in it.
  let whole: string | null = null;
  const wholeDigest = (): string => {
    const { info: _info, ...rest } = document;
    return (whole ??= literalDigest(rest, stats));
  };
  try {
    const paths = agentPathItems(document);
    const digester = resolvingDigester(document, stats);
    return tools.map((tool) => {
      const definition = digester(toolDefinition(document, paths, tool));
      return definition.unresolved
        ? sha256(`resolved\n${definition.text}\n${wholeDigest()}`)
        : definition.text;
    });
  } catch (error) {
    // Over budget, or not walkable at all (a Path Item that does not
    // resolve): every tool of the build is its selection and the whole
    // document, so the outcome never depends on which tool ran out.
    if (error instanceof HashBudgetExceeded) stats.overBudget = true;
    return tools.map((tool) => sha256(`document\n${selectionText(tool)}\n${wholeDigest()}`));
  }
}

/**
 * The fingerprints of what Edge publishes for each of `tools` in `document`,
 * with every local reference resolved: the name, method, path and
 * description, the operation's summary and description, its parameters,
 * request body and 2xx JSON schemas, and the document's OpenAPI version. Each
 * `$ref` contributes its own text and the digest of its target, so changing
 * either changes the hash.
 *
 * A tool falls back to the whole document but `info`, without following its
 * references, instead of guessing what they name, when:
 *
 * - a reference it reaches is external (`other.yaml#/…`), an anchor
 *   (`#name`), or a local pointer that names nothing; or a node it reaches has
 *   a `$id`, `$dynamicRef` or `$recursiveRef` member, a property of that name
 *   included. Its resolved definition is hashed with the whole document.
 * - a Path Item does not resolve, or hashing every tool of the document would
 *   pass {@link MAX_DEFINITION_HASH_WORK} or {@link MAX_DEFINITION_HASH_DEPTH}.
 *   Then every tool of the call is its selection and the whole document.
 *
 * A `$ref: "#"` names the whole document, `info` included. A fallback only
 * ever folds in more than Edge publishes, so it costs a re-approval and
 * nothing else.
 */
export function agentToolDefinitionDigests(
  document: Record<string, unknown>,
  tools: readonly AgentToolSelection[],
  stats: DefinitionHashStats = { hashed: 0, lookups: 0, overBudget: false },
): string[] {
  return definitionDigests(document, tools, stats);
}

/** {@link agentToolDefinitionDigests} for one tool. */
export function agentToolDefinitionHash(
  document: Record<string, unknown>,
  tool: AgentToolSelection,
): string {
  return agentToolDefinitionDigests(document, [tool])[0] as string;
}

/**
 * The stored `definition_hash`: a definition digest bound to the id that
 * consent was given under. A hash copied onto another id, as a release
 * without hashes does when it mints a new one, never matches again.
 */
function boundDefinitionHash(id: string, digest: string): string {
  return sha256(`${id}\n${digest}`);
}

/**
 * Ignore client-supplied IDs and hashes. A tool keeps its id only while it is
 * the same published tool: the same operation (method and path) under the
 * same name, with an unchanged definition digest
 * ({@link agentToolDefinitionDigests}). Anything else, a description edit
 * included, is a new tool with a new id, so an explicit subset never silently
 * covers a changed definition. A stored tool saved before hashes were
 * recorded is hashed against `previousDocument`, the revision it was
 * published with.
 */
export function identifyAgentTools(
  next: ApiAgents | null,
  document: Record<string, unknown>,
  previous: ApiAgents | null = null,
  previousDocument: Record<string, unknown> = document,
): ApiAgents | null {
  if (!next) return null;
  const tools = next.operations.map(({ id: _id, definition_hash: _hash, ...tool }) => tool);
  const digests = agentToolDefinitionDigests(document, tools);
  const priors = tools.map((tool) =>
    previous?.operations.find(
      (item) => item.method === tool.method && item.path === tool.path && item.name === tool.name,
    ),
  );
  const legacy = priors.filter(
    (prior): prior is AgentTool => prior !== undefined && prior.definition_hash === undefined,
  );
  const legacyDigests = agentToolDefinitionDigests(previousDocument, legacy);
  return {
    operations: tools.map((tool, index) => {
      const digest = digests[index] as string;
      const prior = priors[index];
      const priorId = prior?.id;
      const same =
        prior !== undefined &&
        priorId !== undefined &&
        (prior.definition_hash === undefined
          ? legacyDigests[legacy.indexOf(prior)] === digest
          : prior.definition_hash === boundDefinitionHash(priorId, digest));
      const id = same && priorId !== undefined ? priorId : newId();
      return { ...tool, id, definition_hash: boundDefinitionHash(id, digest) };
    }),
  };
}

/**
 * The tools of `previous` still published under the same binding (method,
 * path and name) but with a new id in `next`: their definition changed.
 */
export function rotatedAgentTools(previous: ApiAgents | null, next: ApiAgents | null): AgentTool[] {
  return (
    previous?.operations.filter((tool) => {
      const current = next?.operations.find(
        (item) => item.method === tool.method && item.path === tool.path && item.name === tool.name,
      );
      return tool.id !== undefined && current !== undefined && current.id !== tool.id;
    }) ?? []
  );
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
