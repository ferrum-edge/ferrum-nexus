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
  agentPathItemMember,
  agentPathItems,
  agentToolName,
  isReadOnlyAgentMethod,
  resolveAgentPathItem,
  resolveOpenApiPointer,
  type AgentPathItem,
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

/**
 * Work, in units, that one build of tool hashes (every tool of one document)
 * may cost before it falls back to the whole document: a unit for every
 * member of a document collection the build iterates (a key, an array element
 * or a reference hop), plus every character hashed and every key or pointer
 * it parses. A legitimate document reads each part of itself about once, so
 * it stays far below this; past it, references or shared objects are
 * amplifying the work.
 */
export const MAX_DEFINITION_HASH_WORK = 8 * MAX_SPEC_BYTES;

/** Nesting, through values and references together, one tool hash may descend. */
export const MAX_DEFINITION_HASH_DEPTH = 1_024;

/** Work counters a test may pass, to assert what hashing cost without timing it. */
export interface DefinitionHashStats {
  /** Units charged to the work meter, by every build these counters were passed to. */
  charged: number;
  /** Characters fed to SHA-256, the whole-document fallback included. */
  hashed: number;
  /** Local schema references looked up in the document. */
  lookups: number;
  /** Members of document collections iterated: keys, array elements and reference hops. */
  scanned: number;
  /** Whether a build ran out of budget and hashed every tool by the whole document. */
  overBudget: boolean;
}

/** Fresh counters for {@link agentToolDefinitionDigests}. */
export function definitionHashStats(): DefinitionHashStats {
  return { charged: 0, hashed: 0, lookups: 0, scanned: 0, overBudget: false };
}

/** Thrown when one build of tool hashes exceeds its work or depth budget. */
class HashBudgetExceeded extends Error {}

/**
 * The one meter a build of tool hashes charges its work to, shared by every
 * tool of the build. Each iteration over something the document controls
 * (Path Item and reference chains, Responses and Content maps, and every
 * object and array the digest walks: parameters, schemas and their
 * subschemas, examples) is charged before it runs, and every character as it
 * is hashed. Past {@link MAX_DEFINITION_HASH_WORK} the build is abandoned.
 */
interface WorkMeter {
  /** Charge `cost` units for work about to be done. */
  charge: (cost: number) => void;
  /** Charge `count` members of a collection about to be iterated, `cost` units in all. */
  members: (count: number, cost?: number) => void;
  stats: DefinitionHashStats;
}

function workMeter(stats: DefinitionHashStats): WorkMeter {
  let work = 0;
  const charge = (cost: number): void => {
    work += cost;
    stats.charged += cost;
    if (work > MAX_DEFINITION_HASH_WORK) throw new HashBudgetExceeded();
  };
  return {
    charge,
    members: (count, cost = count) => {
      stats.scanned += count;
      charge(cost);
    },
    stats,
  };
}

/**
 * What a tool definition reads of a Request Body or Response, through its
 * references, or that the chain did not resolve.
 */
type FollowedObject =
  | { resolved: true; hops: number; content: unknown; required: unknown; description: unknown }
  | { resolved: false };

const UNRESOLVED: FollowedObject = { resolved: false };

/**
 * One build's reads of the document while it assembles tool definitions. Each
 * selected Path Item, each Request Body or Response reference and each
 * Content map is read once, however many tools and statuses reach it, and
 * nothing the document holds is copied.
 */
interface DefinitionReader {
  document: Record<string, unknown>;
  meter: WorkMeter;
  pathItems: WeakMap<object, AgentPathItem>;
  followed: WeakMap<object, FollowedObject>;
  contents: WeakMap<object, Record<string, unknown>>;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/** The selected Path Item at `path`, resolved in place, or undefined when there is none. */
function selectedPathItem(reader: DefinitionReader, path: string): AgentPathItem | undefined {
  const { document, meter } = reader;
  const paths = document.paths;
  if (!record(paths) || !path.startsWith('/') || !Object.hasOwn(paths, path)) return undefined;
  const value = paths[path];
  if (!record(value)) return undefined;
  // Throws for a chain Edge would not follow, which abandons the build.
  return resolveAgentPathItem(document, path, value, {
    memo: reader.pathItems,
    charge: (cost) => meter.members(1, cost),
  });
}

/** The schemas of every JSON media type in a Content map, keyed by media type. */
function jsonMediaSchemas(
  reader: DefinitionReader,
  content: unknown,
): Record<string, unknown> | null {
  if (!record(content)) return null;
  const known = reader.contents.get(content);
  if (known) return known;
  const mediaTypes = Object.keys(content);
  reader.meter.members(mediaTypes.length);
  const schemas: Record<string, unknown> = {};
  for (const mediaType of mediaTypes) {
    // Charged before it is parsed, however long it is.
    reader.meter.charge(mediaType.length);
    const media = content[mediaType];
    if (isJsonMediaType(mediaType)) schemas[mediaType] = record(media) ? media.schema : media;
  }
  reader.contents.set(content, schemas);
  return schemas;
}

/**
 * A Request Body or Response through its chain of local Reference Objects, as
 * the members a tool definition reads: `content`, `required` and
 * `description`, each from the outermost reference that sets it, else from
 * the target. Nothing is copied, and every node's outcome is kept for the
 * build, so each reference is followed once however many statuses and tools
 * reach it. A chain that leaves the document (external, anchor, dangling),
 * cycles, passes {@link MAX_OPENAPI_REF_HOPS} hops or ends at something other
 * than an object does not resolve.
 */
function followReference(reader: DefinitionReader, value: Record<string, unknown>): FollowedObject {
  const chain: Record<string, unknown>[] = [];
  const onChain = new Set<object>();
  let current = value;
  let end = reader.followed.get(current);
  while (!end) {
    const ref = current.$ref;
    // The node, its pointer and the three members read from it.
    reader.meter.members(1, typeof ref === 'string' ? ref.length + 3 : 3);
    if (typeof ref !== 'string') {
      end = {
        resolved: true,
        hops: 0,
        content: own(current, 'content'),
        required: own(current, 'required'),
        description: own(current, 'description'),
      };
      reader.followed.set(current, end);
      break;
    }
    chain.push(current);
    onChain.add(current);
    const target = ref.startsWith('#/') ? resolveOpenApiPointer(reader.document, ref) : undefined;
    if (!record(target) || onChain.has(target)) {
      end = UNRESOLVED;
      break;
    }
    current = target;
    end = reader.followed.get(current);
  }
  // Each reference's own members over what it names, innermost first.
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const node = chain[index] as Record<string, unknown>;
    if (end.resolved && end.hops < MAX_OPENAPI_REF_HOPS) {
      const inner = end;
      const member = (key: 'content' | 'required' | 'description'): unknown =>
        Object.hasOwn(node, key) ? node[key] : inner[key];
      end = {
        resolved: true,
        hops: inner.hops + 1,
        content: member('content'),
        required: member('required'),
        description: member('description'),
      };
    } else {
      end = UNRESOLVED;
    }
    reader.followed.set(node, end);
  }
  return end;
}

/** A tool's definition, and whether a Request Body or Response it reads did not resolve. */
interface ToolDefinition {
  definition: Record<string, unknown>;
  unresolved: boolean;
}

/**
 * What Edge's MCP bridge publishes for one selected operation, before its
 * schema references are resolved. It mirrors the pinned extractor's
 * `generate_mcp_bridge_operation`, over-including where that is simpler: an
 * extra field only costs a re-approval, a missing one would let an explicit
 * subset follow a changed tool.
 */
function toolDefinition(reader: DefinitionReader, tool: AgentToolSelection): ToolDefinition {
  const { document, meter } = reader;
  const item = selectedPathItem(reader, tool.path);
  /** A Path Item member, read through the item's reference chain. */
  const member = (key: string): unknown => {
    if (!item) return undefined;
    meter.members(item.chain.length + 1);
    return agentPathItemMember(item, key);
  };
  const operation = member(tool.method.toLowerCase());
  const definition: Record<string, unknown> = {
    // Edge normalizes schemas by the document's OpenAPI version.
    openapi: document.openapi ?? null,
    method: tool.method,
    path: tool.path,
    name: tool.name,
    description: tool.description,
  };
  // validateAgents refuses a selection with no operation; this stays total.
  if (!item || !record(operation)) {
    return { definition: { ...definition, operation: null }, unresolved: false };
  }
  let unresolved = false;
  // A Request Body or Response that does not resolve is named by its own
  // reference, and the tool folds in the whole document.
  const follow = (value: Record<string, unknown>): FollowedObject => {
    const followed = followReference(reader, value);
    if (!followed.resolved) unresolved = true;
    return followed;
  };
  const unresolvedRef = (value: Record<string, unknown>): Record<string, unknown> => ({
    unresolved_ref: value.$ref ?? null,
  });
  const body = operation.requestBody ?? null;
  let requestBody: unknown = body;
  if (record(body)) {
    const followed = follow(body);
    requestBody = followed.resolved
      ? {
          required: followed.required ?? null,
          description: followed.description ?? null,
          content: jsonMediaSchemas(reader, followed.content),
        }
      : unresolvedRef(body);
  }
  const responses = record(operation.responses) ? operation.responses : {};
  const statuses = Object.keys(responses);
  meter.members(statuses.length);
  const outputs: Record<string, unknown> = {};
  for (const status of statuses) {
    // Charged before it is matched, however long it is.
    meter.charge(status.length);
    if (!/^2([0-9]{2}|XX)$/.test(status)) continue;
    const response = responses[status];
    if (!record(response)) {
      outputs[status] = response;
      continue;
    }
    const followed = follow(response);
    outputs[status] = followed.resolved
      ? jsonMediaSchemas(reader, followed.content)
      : unresolvedRef(response);
  }
  return {
    definition: {
      ...definition,
      // Edge's tool title.
      summary: operation.summary ?? null,
      operation_description: operation.description ?? null,
      // Path Item parameters, then the operation's own, which override them.
      parameters: [member('parameters') ?? null, operation.parameters ?? null],
      request_body: requestBody,
      // Edge publishes the first 2xx JSON object schema as the output schema.
      responses: outputs,
    },
    unresolved,
  };
}

/**
 * JSON Schema keywords that make a reference mean something other than a
 * pointer from the document root: a resource identifier rebases the
 * references beneath it, and dynamic references resolve at evaluation time.
 */
const REBASING_KEYWORDS = ['$id', '$dynamicRef', '$recursiveRef'];

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
 * - **Budget.** Every object's keys and array's elements are charged to the
 *   build's {@link WorkMeter} before they are walked, each reference before
 *   it is looked up, and every character as it is hashed; nesting is held to
 *   {@link MAX_DEFINITION_HASH_DEPTH}. Past either, {@link HashBudgetExceeded}
 *   abandons the build.
 * - Anything Nexus cannot resolve from the document root (an external or
 *   anchor reference, a dangling pointer, a rebased or dynamic reference) is
 *   reported as `unresolved`.
 */
function resolvingDigester(
  document: Record<string, unknown>,
  meter: WorkMeter,
): (definition: Record<string, unknown>) => TargetDigest {
  const { stats } = meter;
  const shared = new Map<unknown, TargetDigest>();
  const spend = (count: number): void => {
    stats.hashed += count;
    meter.charge(count);
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
      // A hop, charged with its pointer before the pointer is parsed.
      meter.members(1, ref.length + 1);
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
        meter.members(value.length);
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
        // Listing the keys is the only work done before they are charged.
        const keys = Object.keys(value);
        meter.members(keys.length);
        keys.sort();
        write('{');
        keys.forEach((key, index) => {
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
    const meter = workMeter(stats);
    const reader: DefinitionReader = {
      document,
      meter,
      pathItems: new WeakMap(),
      followed: new WeakMap(),
      contents: new WeakMap(),
    };
    const digester = resolvingDigester(document, meter);
    return tools.map((tool) => {
      const { definition, unresolved } = toolDefinition(reader, tool);
      const digest = digester(definition);
      return unresolved || digest.unresolved
        ? sha256(`resolved\n${digest.text}\n${wholeDigest()}`)
        : digest.text;
    });
  } catch (error) {
    // Over budget, or not walkable at all (a selected Path Item that does
    // not resolve): every tool of the build is its selection and the whole
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
 *   (`#name`), or a local pointer that names nothing; its Request Body or a
 *   2xx Response is a reference chain that does not resolve to an object
 *   within {@link MAX_OPENAPI_REF_HOPS} acyclic local hops; or a node it
 *   reaches has a `$id`, `$dynamicRef` or `$recursiveRef` member, a property
 *   of that name included. Its definition, as far as it resolved, is hashed
 *   with the whole document.
 * - a selected Path Item does not resolve, or reading and hashing every tool
 *   of the call would pass {@link MAX_DEFINITION_HASH_WORK} or
 *   {@link MAX_DEFINITION_HASH_DEPTH}.
 *   Then every tool of the call is its selection and the whole document.
 *
 * Cost: at most the work budget, plus the one charge that crosses it, plus
 * one canonical pass over the whole document when a tool or the build falls
 * back. Nothing the document holds is copied.
 *
 * A `$ref: "#"` names the whole document, `info` included. A fallback only
 * ever folds in more than Edge publishes, so it costs a re-approval and
 * nothing else.
 */
export function agentToolDefinitionDigests(
  document: Record<string, unknown>,
  tools: readonly AgentToolSelection[],
  stats: DefinitionHashStats = definitionHashStats(),
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
 *
 * Run {@link validateAgents} on `next` first: hashing reads every selection,
 * and a duplicate or missing one should be refused before it costs anything.
 * `stats` reports, among other things, whether either build fell back to the
 * whole document.
 */
export function identifyAgentTools(
  next: ApiAgents | null,
  document: Record<string, unknown>,
  previous: ApiAgents | null = null,
  previousDocument: Record<string, unknown> = document,
  stats: DefinitionHashStats = definitionHashStats(),
): ApiAgents | null {
  if (!next) return null;
  const tools = next.operations.map(({ id: _id, definition_hash: _hash, ...tool }) => tool);
  const digests = agentToolDefinitionDigests(document, tools, stats);
  const priors = tools.map((tool) =>
    previous?.operations.find(
      (item) => item.method === tool.method && item.path === tool.path && item.name === tool.name,
    ),
  );
  const legacy = priors.filter(
    (prior): prior is AgentTool => prior !== undefined && prior.definition_hash === undefined,
  );
  const legacyDigests = agentToolDefinitionDigests(previousDocument, legacy, stats);
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
  const byKey = new Map(operations.map((item) => [`${item.method} ${item.path}`, item]));
  const names = new Set<string>();
  const selected = new Set<string>();
  for (const tool of agents.operations) {
    const key = `${tool.method} ${tool.path}`;
    const operation = byKey.get(key);
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
