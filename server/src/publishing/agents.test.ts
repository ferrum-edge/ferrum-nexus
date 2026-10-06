import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NexusError } from '../lib/errors.js';
import {
  MAX_AGENT_DOCUMENT_BYTES,
  MAX_DEFINITION_HASH_WORK,
  agentDocumentStats,
  agentToolDefinitionDigests,
  agentToolDefinitionHash,
  definitionHashStats,
  identifyAgentTools,
  stampAgentDocument,
  stampedAgentDocumentBytes,
  validateAgents,
  type DefinitionHashStats,
} from './agents.js';
import { parseOpenApiSpec } from './oas.js';

const TOOL = {
  method: 'POST' as const,
  path: '/orders',
  name: 'create_order',
  description: 'Create an order',
};
const LIST = { method: 'GET' as const, path: '/orders', name: 'list', description: 'List' };

/** One tool reaching its body, output and a cycle only through references. */
const BASE = {
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1' },
  paths: {
    '/orders': {
      post: {
        summary: 'Create',
        requestBody: { $ref: '#/components/requestBodies/Order' },
        responses: {
          '201': { $ref: '#/components/responses/Created' },
          '400': {
            description: 'Bad request',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
      get: { responses: { '200': { description: 'OK' } } },
    },
  },
  components: {
    schemas: {
      Order: {
        type: 'object',
        properties: { sku: { type: 'string' }, parent: { $ref: '#/components/schemas/Order' } },
      },
      Receipt: { type: 'object', properties: { id: { type: 'string' } } },
      Unused: { type: 'string' },
    },
    requestBodies: {
      Order: {
        required: true,
        content: {
          'application/json; charset=utf-8': { schema: { $ref: '#/components/schemas/Order' } },
          'text/plain': { schema: { type: 'string' } },
        },
      },
    },
    responses: {
      Created: {
        description: 'Created',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Receipt' } } },
      },
    },
  },
};

type Document = typeof BASE;

function edit(change: (document: Document) => void): Document {
  const document = structuredClone(BASE);
  change(document);
  return document;
}

function hash(document: Record<string, unknown>, tool = TOOL): string {
  return agentToolDefinitionHash(document, tool);
}

function stats(): DefinitionHashStats {
  return definitionHashStats();
}

/** The `index`th spelling of one pointer: a different set of its letters percent-encoded. */
function spelling(pointer: string, index: number): string {
  let bit = 0;
  const encoded = [...pointer].map((char) => {
    if (char === '/') return char;
    const percent = (index >> bit) & 1;
    bit += 1;
    return percent ? `%${char.charCodeAt(0).toString(16).toUpperCase()}` : char;
  });
  return `#/${encoded.join('')}`;
}

/** `value` with the keys of every object in reverse order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== 'object' || value === null) return value;
  const entries: [string, unknown][] = Object.entries(value).reverse();
  return Object.fromEntries(entries.map(([key, child]) => [key, reversed(child)] as const));
}

/** BASE with `schema` as the only parameter of the selected operation. */
function withParameter(
  schema: unknown,
  components: Record<string, unknown> = {},
): Record<string, unknown> {
  const document = edit((d) => {
    Object.assign(d.paths['/orders'].post, { parameters: [{ name: 'q', in: 'query', schema }] });
  });
  return { ...document, components: { ...document.components, ...components } };
}

type Tool = Parameters<typeof agentToolDefinitionDigests>[1][number];

/** An object of `count` keys, `${prefix}${index}`, each holding `value`. */
function wide(count: number, prefix: string, value: unknown = 0): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) object[`${prefix}${index}`] = value;
  return object;
}

/** `${name}0` → `${name}1` → … → `target`: `hops` references in one component kind. */
function referenceChain(
  kind: string,
  name: string,
  hops: number,
  target: string,
): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (let index = 0; index < hops; index += 1) {
    const next = index + 1 < hops ? `${name}${index + 1}` : target;
    chain[`${name}${index}`] = { $ref: `#/components/${kind}/${next}` };
  }
  return chain;
}

/**
 * `paths` paths that all reference one Path Item, `#/components/pathItems/${start}`,
 * and a tool on each of the first `tools`, cycling through `methods`.
 */
function fanIn(options: {
  pathItems: Record<string, unknown>;
  start?: string;
  paths?: number;
  tools?: number;
  methods?: Tool['method'][];
  components?: Record<string, unknown>;
}): { document: Record<string, unknown>; tools: Tool[] } {
  const { pathItems, start = 'Shared', paths: count = 256, methods = ['POST'] } = options;
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    paths[`/p${index}`] = { $ref: `#/components/pathItems/${start}` };
  }
  const tools = Array.from({ length: options.tools ?? count }, (_, index): Tool => ({
    method: methods[index % methods.length] ?? 'POST',
    path: `/p${index}`,
    name: `tool_${index}`,
    description: 'Shared',
  }));
  return {
    document: {
      openapi: '3.1.0',
      info: { title: 'Fan-in', version: '1' },
      paths,
      components: { ...options.components, pathItems },
    },
    tools,
  };
}

/** Thrown by {@link metered} once the document has been read more than hashing paid for. */
class UnpaidReads extends Error {}

/**
 * `document` behind proxies that count every member read, key listing,
 * descriptor lookup and membership test, so a test bounds the work hashing
 * does on the document itself, not the time it takes. One proxy per object,
 * so identity, and every memo keyed by it, is kept. Once the count passes
 * `allowed()` it throws, so code that copies or rescans a large object fails
 * at once instead of running long.
 */
function metered<T extends object>(
  document: T,
  allowed: () => number,
): { document: T; reads: () => number } {
  let reads = 0;
  const count = (amount: number): void => {
    reads += amount;
    if (reads > allowed()) throw new UnpaidReads(`${reads} reads of the document`);
  };
  const proxies = new WeakMap<object, object>();
  const wrap = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) return value;
    let proxy = proxies.get(value);
    if (!proxy) {
      proxy = new Proxy(value, {
        get: (target, key, receiver) => {
          count(1);
          return wrap(Reflect.get(target, key, receiver));
        },
        has: (target, key) => {
          count(1);
          return Reflect.has(target, key);
        },
        ownKeys: (target) => {
          const keys = Reflect.ownKeys(target);
          count(keys.length + 1);
          return keys;
        },
        getOwnPropertyDescriptor: (target, key) => {
          count(1);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      proxies.set(value, proxy);
    }
    return proxy;
  };
  return { document: wrap(document) as T, reads: () => reads };
}

/** Containers, members, and characters of keys and strings, with every alias expanded. */
function documentSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (typeof value !== 'object' || value === null) return 1;
  let size = 1;
  for (const [key, child] of Object.entries(value)) size += 1 + key.length + documentSize(child);
  return size;
}

/**
 * Hash `tools` over `document`, read through {@link metered}, and require that
 * every read of the document was paid for: at most four reads per unit charged
 * to the build's work meter, plus one canonical pass over the whole document
 * and a few reads per tool to find its operation. The check runs on every
 * read, so a build that reads more than it charges fails as soon as it does.
 */
function hashPaidFor(
  document: Record<string, unknown>,
  tools: Tool[],
): { digests: string[]; counters: DefinitionHashStats; reads: number } {
  const counters = stats();
  const allowance = 3 * documentSize(document) + 64 * tools.length;
  const view = metered(document, () => 4 * counters.charged + allowance);
  const digests = agentToolDefinitionDigests(view.document, tools, counters);
  return { digests, counters, reads: view.reads() };
}

/** `document` with its unreferenced `Unused` schema changed. */
function unusedChanged(document: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(document) as {
    components: { schemas: { Unused: { type: string } } };
  };
  copy.components.schemas.Unused.type = 'integer';
  return copy;
}

describe('agentToolDefinitionHash', () => {
  it('is a stable function of the definition, not of key order or document syntax', () => {
    assert.equal(hash(BASE), hash(structuredClone(BASE)));
    assert.equal(hash(reversed(BASE) as Record<string, unknown>), hash(BASE));
    const yaml = [
      'openapi: 3.1.0',
      'info: { title: Orders, version: "1" }',
      'paths:',
      '  /orders:',
      '    post:',
      '      summary: Create',
      '      responses:',
      "        '200': { description: OK }",
    ].join('\n');
    const json = JSON.stringify({
      paths: {
        '/orders': { post: { responses: { '200': { description: 'OK' } }, summary: 'Create' } },
      },
      info: { version: '1', title: 'Orders' },
      openapi: '3.1.0',
    });
    assert.equal(hash(parseOpenApiSpec(yaml).document), hash(parseOpenApiSpec(json).document));
  });

  it('changes when a change reaches the tool only through a reference', () => {
    const base = hash(BASE);
    const changes: Record<string, (d: Document) => void> = {
      'a referenced schema': (d) => {
        d.components.schemas.Order.properties.sku.type = 'integer';
      },
      'the referenced request body': (d) => {
        d.components.requestBodies.Order.required = false;
      },
      'the output schema': (d) => {
        d.components.schemas.Receipt.properties.id.type = 'integer';
      },
      'the referenced response': (d) => {
        Object.assign(d.components.responses.Created.content, {
          'application/problem+json': { schema: { type: 'object' } },
        });
      },
      'a JSON media type with parameters': (d) => {
        d.components.requestBodies.Order.content['application/json; charset=utf-8'].schema = {
          $ref: '#/components/schemas/Receipt',
        };
      },
    };
    for (const [what, change] of Object.entries(changes)) {
      assert.notEqual(hash(edit(change)), base, what);
    }
    const unchanged: Record<string, (d: Document) => void> = {
      info: (d) => {
        d.info.version = '2';
      },
      'an unreferenced schema': (d) => {
        d.components.schemas.Unused.type = 'integer';
      },
      'another operation': (d) => {
        d.paths['/orders'].get.responses['200'].description = 'Listed';
      },
      'a non-JSON media type': (d) => {
        d.components.requestBodies.Order.content['text/plain'].schema.type = 'number';
      },
      'a non-2xx response': (d) => {
        d.paths['/orders'].post.responses['400'].description = 'Refused';
      },
    };
    for (const [what, change] of Object.entries(unchanged)) {
      assert.equal(hash(edit(change)), base, what);
    }
  });

  it('hashes a reference by its text as well as its target', () => {
    const literal = (ref: string): Record<string, unknown> =>
      withParameter({ type: 'object', default: { $ref: ref } }, { 'x-a': 1, 'x-b': 1 });
    assert.notEqual(hash(literal('#/components/x-a')), hash(literal('#/components/x-b')));
    assert.equal(hash(literal('#/components/x-a')), hash(literal('#/components/x-a')));
  });

  it('terminates on cycles, and hashes a tool alike whichever other tools share the build', () => {
    const mutual = (type: string): Record<string, unknown> =>
      edit((d) => {
        Object.assign(d.components.schemas, {
          A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
          B: { type, properties: { a: { $ref: '#/components/schemas/A' } } },
        });
        Object.assign(d.paths['/orders'].post, {
          parameters: [{ name: 'q', in: 'query', schema: { $ref: '#/components/schemas/A' } }],
        });
        Object.assign(d.paths['/orders'].get, {
          parameters: [{ name: 'q', in: 'query', schema: { $ref: '#/components/schemas/B' } }],
        });
      });
    const document = mutual('object');
    const [alone] = agentToolDefinitionDigests(document, [TOOL]);
    const [, shared] = agentToolDefinitionDigests(document, [LIST, TOOL]);
    assert.equal(shared, alone);
    assert.equal(hash(mutual('object')), alone);
    assert.notEqual(hash(mutual('array')), alone, 'a change inside the cycle is a change');
  });

  it('lays the members of each reference over the Request Body it names, outermost first', () => {
    const content = { 'application/json': { schema: { type: 'object' } } };
    const chained = edit((d) => {
      Object.assign(d.paths['/orders'].post, {
        requestBody: { $ref: '#/components/requestBodies/Outer', description: 'outer' },
      });
      Object.assign(d.components.requestBodies, {
        Outer: { $ref: '#/components/requestBodies/Inner', description: 'inner', required: true },
        Inner: { description: 'target', content },
      });
    });
    const inline = edit((d) => {
      Object.assign(d.paths['/orders'].post, {
        requestBody: { description: 'outer', required: true, content },
      });
    });
    assert.equal(hash(chained), hash(inline));
    assert.equal(hash(unusedChanged(chained)), hash(chained), 'a resolved chain folds in nothing');
  });

  it('folds in the whole document for a Request Body or Response that does not resolve', () => {
    const unresolvable = [
      'other.yaml#/components/responses/Target',
      '#/components/responses/Missing',
      '#/components/responses/Loop',
      // 33 hops, one past the bound.
      '#/components/responses/Long0',
      // A string, not an object.
      '#/openapi',
    ];
    const at = (ref: string, where: 'body' | 'response'): Record<string, unknown> =>
      edit((d) => {
        Object.assign(d.components.responses, {
          ...referenceChain('responses', 'Long', 32, 'Target'),
          ...referenceChain('responses', 'Short', 31, 'Target'),
          Target: { description: 'Target' },
          Loop: { $ref: '#/components/responses/Loop' },
        });
        Object.assign(
          d.paths['/orders'].post,
          where === 'body'
            ? { requestBody: { $ref: ref } }
            : { responses: { '200': { $ref: ref } } },
        );
      });
    for (const ref of unresolvable) {
      for (const where of ['body', 'response'] as const) {
        const document = at(ref, where);
        assert.notEqual(hash(unusedChanged(document)), hash(document), `${where} ${ref}`);
      }
    }
    // 32 hops resolve: the tool hashes only what it names.
    const short = at('#/components/responses/Short0', 'response');
    assert.equal(hash(unusedChanged(short)), hash(short));
  });

  it('folds in the whole document but info for a reference it cannot resolve', () => {
    for (const ref of ['other.yaml#/Order', '#/components/schemas/Missing', '#anchor']) {
      const external = withParameter({ $ref: ref });
      const base = hash(external);
      assert.equal(hash({ ...external, info: { title: 'Renamed', version: '9' } }), base, ref);
      assert.notEqual(hash(unusedChanged(external)), base, `${ref}: unreferenced schemas count`);
    }
    const rebased = withParameter({ type: 'object', properties: { $id: { type: 'string' } } });
    assert.notEqual(hash(unusedChanged(rebased)), hash(rebased), 'a property named $id falls back');
  });

  it('collapses every spelling of one target, so a reference bomb costs its size once', () => {
    const big = 'x'.repeat(1_000_000);
    const pointer = 'components/schemas/Big';
    const refs = Array.from({ length: 4_000 }, (_, index) => spelling(pointer, index));
    assert.equal(new Set(refs).size, refs.length);
    const document = withParameter(
      { allOf: refs.map(($ref) => ({ $ref })) },
      { schemas: { ...BASE.components.schemas, Big: big } },
    );
    const second = { ...TOOL, name: 'again' };
    const counters = stats();
    const [one, two] = agentToolDefinitionDigests(document, [TOOL, second], counters);
    assert.equal(counters.overBudget, false);
    // Every spelling is still looked up, per tool: the memo is by node, not
    // by text. Order, its cycle and Receipt add a few more; the Request Body
    // and Response references a definition is assembled through are not
    // counted.
    assert.ok(
      counters.lookups >= 2 * refs.length && counters.lookups <= 2 * (refs.length + 3),
      `lookups ${counters.lookups}`,
    );
    // Once for the string, then each reference's text and digest, per tool.
    assert.ok(counters.hashed < big.length + 1_500_000, `hashed ${counters.hashed}`);
    assert.notEqual(one, two);

    // A tool that also needs the whole document never follows its references.
    const unresolved = withParameter(
      { allOf: [...refs.map(($ref) => ({ $ref })), { $ref: 'other.yaml#/X' }] },
      { schemas: { ...BASE.components.schemas, Big: big } },
    );
    const folded = stats();
    agentToolDefinitionDigests(unresolved, [TOOL], folded);
    assert.equal(folded.overBudget, false);
    assert.ok(folded.hashed < 2 * big.length + 1_500_000, `hashed ${folded.hashed}`);
  });

  it('falls back to the whole document once resolving would pass its budget', () => {
    // Pointers into every level of one deep schema each name a new node, and
    // each node holds the large leaf beneath it.
    const levels = 120;
    let deep: Record<string, unknown> = { leaf: 'y'.repeat(200_000) };
    for (let level = 0; level < levels; level += 1) deep = { a: deep };
    const refs: string[] = [];
    for (let level = 0; level < levels; level += 1) {
      refs.push(`#/components/schemas/Deep${'/a'.repeat(level)}`);
    }
    const document = withParameter(
      { allOf: refs.map(($ref) => ({ $ref })) },
      { schemas: { ...BASE.components.schemas, Deep: deep } },
    );
    const counters = stats();
    const [digest] = agentToolDefinitionDigests(document, [TOOL], counters);
    assert.equal(counters.overBudget, true);
    assert.ok(counters.hashed < MAX_DEFINITION_HASH_WORK + 1_000_000, `hashed ${counters.hashed}`);
    assert.equal(hash({ ...document, info: { title: 'Other', version: '2' } }), digest);
    assert.notEqual(hash(unusedChanged(document)), digest);

    // So does a reference chain nested past the depth budget.
    const chain: Record<string, unknown> = {};
    for (let index = 0; index < 600; index += 1) {
      chain[`S${index}`] = { items: { $ref: `#/components/schemas/S${index + 1}` } };
    }
    const nested = stats();
    agentToolDefinitionDigests(
      withParameter({ $ref: '#/components/schemas/S0' }, { schemas: chain }),
      [TOOL],
      nested,
    );
    assert.equal(nested.overBudget, true);
  });

  it('scans a Content map once however many statuses and selections reach it', () => {
    const mediaTypes = 20_000;
    const content: Record<string, unknown> = {};
    for (let index = 0; index < mediaTypes; index += 1) content[`x/${index}`] = 0;
    const statuses = [...Array.from({ length: 100 }, (_, index) => `${200 + index}`), '2XX'];
    const responses = Object.fromEntries(
      statuses.map((status) => [status, { $ref: '#/components/responses/Many' }]),
    );
    const document = {
      ...BASE,
      paths: { '/orders': { post: { ...BASE.paths['/orders'].post, responses } } },
      components: { ...BASE.components, responses: { Many: { description: 'Many', content } } },
    };
    const counters = stats();
    const [one, two] = agentToolDefinitionDigests(document, [TOOL, TOOL], counters);
    assert.equal(counters.overBudget, false);
    assert.equal(one, two);
    // The shared map once, then a few members per status for each selection:
    // its key, its reference, and its entry in the digested definition.
    // Re-scanning the map per status would be millions.
    assert.ok(counters.scanned <= mediaTypes + 10 * statuses.length, `scanned ${counters.scanned}`);
  });

  it('charges the keys it examines, so a shared operation cannot amplify them', () => {
    const responses: Record<string, unknown> = { '200': { description: 'OK' } };
    for (let index = 0; index < 80_000; index += 1) {
      responses[`x-${index}`] = { description: 'Never published' };
    }
    const paths: Record<string, unknown> = {};
    const tools = Array.from({ length: 256 }, (_, index) => {
      paths[`/p${index}`] = { $ref: '#/components/pathItems/Shared' };
      return { ...TOOL, path: `/p${index}`, name: `tool_${index}` };
    });
    const document = {
      openapi: '3.1.0',
      info: { title: 'Shared', version: '1' },
      paths,
      components: { pathItems: { Shared: { post: { responses } } } },
    };
    const counters = stats();
    agentToolDefinitionDigests(document, tools, counters);
    assert.equal(counters.overBudget, true);
    // Every member is charged before it is read, and the charge that crossed
    // the budget was at most one listing of the map.
    assert.ok(counters.scanned <= counters.charged, `scanned ${counters.scanned}`);
    assert.ok(
      counters.charged <= MAX_DEFINITION_HASH_WORK + Object.keys(responses).length,
      `charged ${counters.charged}`,
    );
  });
});

/**
 * One adversarial document per collection the document controls, each
 * reached by many tools at once. Each test counts reads of the document
 * ({@link hashPaidFor}), never time.
 */
describe('agent tool hashing work, per document dimension', () => {
  /** A Path Item whose POST is `operation`. */
  const shared = (operation: Record<string, unknown>): Record<string, unknown> => ({
    Shared: { post: operation },
  });
  const OK = { '200': { description: 'OK' } };

  it('paths: resolves only the selected Path Items, and never copies one', () => {
    // 2,000 paths reach one Path Item of 150,000 members through 32 hops.
    const item = { ...wide(150_000, 'x-'), post: { responses: OK } };
    const { document, tools } = fanIn({
      pathItems: { ...referenceChain('pathItems', 'H', 31, 'Item'), Item: item },
      start: 'H0',
      paths: 2_000,
      tools: 256,
    });
    const { counters, reads } = hashPaidFor(document, tools);
    assert.equal(counters.overBudget, false);
    assert.ok(reads < 100_000, `reads ${reads}`);
  });

  it('operations: reads only the members an operation publishes', () => {
    const operation = { ...wide(150_000, 'x-'), responses: OK };
    const { document, tools } = fanIn({
      pathItems: {
        Shared: { get: operation, put: operation, post: operation, delete: operation },
      },
      methods: ['GET', 'PUT', 'POST', 'DELETE'],
    });
    const { counters, reads } = hashPaidFor(document, tools);
    assert.equal(counters.overBudget, false);
    assert.ok(reads < 100_000, `reads ${reads}`);
  });

  it('parameters: pays for every parameter each tool digests', () => {
    const parameters = Array.from({ length: 5_000 }, (_, index) => ({
      name: `${'p'.repeat(80)}${index}`,
      in: 'query',
    }));
    const { document, tools } = fanIn({
      pathItems: { Shared: { parameters, post: { parameters, responses: OK } } },
    });
    const { counters } = hashPaidFor(document, tools);
    assert.equal(counters.overBudget, true);
  });

  it('response status codes: pays for every key of a shared Responses map', () => {
    const responses = { ...wide(80_000, `x-${'k'.repeat(100)}`, { description: 'Never' }), ...OK };
    const { document, tools } = fanIn({ pathItems: shared({ responses }) });
    const { counters } = hashPaidFor(document, tools);
    assert.equal(counters.overBudget, true);
  });

  it('content maps: scans a shared Content map once', () => {
    const statuses = [...Array.from({ length: 100 }, (_, index) => `${200 + index}`), '2XX'];
    const responses = Object.fromEntries(
      statuses.map((status) => [status, { $ref: '#/components/responses/Many' }]),
    );
    const { document, tools } = fanIn({
      pathItems: shared({ responses }),
      components: {
        responses: { Many: { description: 'Many', content: wide(20_000, 'x/') } },
      },
    });
    const { counters, reads } = hashPaidFor(document, tools);
    assert.equal(counters.overBudget, false);
    assert.ok(counters.scanned < 20_000 + tools.length * 1_000, `scanned ${counters.scanned}`);
    assert.ok(reads < 200_000, `reads ${reads}`);
  });

  it('media types: pays for every JSON media type each status publishes', () => {
    const content = wide(2_000, 'application/x-', {
      schema: { $ref: '#/components/schemas/Leaf' },
      examples: wide(100, 'e'),
    });
    const json = Object.fromEntries(
      Object.entries(content).map(([key, value]) => [`${key}+json`, value]),
    );
    const responses = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `${200 + index}`,
        { $ref: '#/components/responses/Json' },
      ]),
    );
    const { document, tools } = fanIn({
      pathItems: shared({ responses }),
      components: {
        schemas: { Leaf: { type: 'integer' } },
        responses: { Json: { description: 'Json', content: json } },
      },
    });
    const { counters } = hashPaidFor(document, tools);
    assert.equal(counters.overBudget, true);
  });

  it('schemas: digests properties, items and every composition once per build', () => {
    const leaves = Array.from({ length: 2_000 }, () => ({ $ref: '#/components/schemas/Leaf' }));
    const schema = {
      type: 'object',
      properties: wide(20_000, 'p', { type: 'string' }),
      items: { type: 'string' },
      allOf: leaves,
      oneOf: leaves,
      anyOf: leaves,
    };
    const ref = { $ref: '#/components/schemas/Wide' };
    const { document, tools } = fanIn({
      pathItems: shared({
        parameters: [{ name: 'q', in: 'query', schema: ref }],
        responses: { '200': { content: { 'application/json': { schema: ref } } } },
      }),
      components: { schemas: { Wide: schema, Leaf: { type: 'integer' } } },
    });
    const { counters, reads } = hashPaidFor(document, tools);
    assert.equal(counters.overBudget, false);
    // The schema once, then each tool's two references to it.
    assert.ok(counters.hashed < 2_000_000, `hashed ${counters.hashed}`);
    assert.ok(reads < 500_000, `reads ${reads}`);
  });

  it('reference hops: follows a long chain to a wide target once, and never copies it', () => {
    // The round-4 shape: a Response of 150,000 non-content members behind a
    // 31-hop chain, referenced by 101 statuses; a Request Body likewise.
    const target = (description: string): Record<string, unknown> => ({
      ...wide(150_000, 'x'),
      description,
      content: { 'application/json': { schema: { type: 'object' } } },
    });
    const responses = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `${200 + index}`,
        { $ref: '#/components/responses/R0' },
      ]),
    );
    const { document, tools } = fanIn({
      pathItems: shared({ requestBody: { $ref: '#/components/requestBodies/B0' }, responses }),
      tools: 16,
      components: {
        responses: { ...referenceChain('responses', 'R', 31, 'Wide'), Wide: target('Wide') },
        requestBodies: {
          ...referenceChain('requestBodies', 'B', 31, 'Wide'),
          Wide: target('Body'),
        },
      },
    });
    const { counters, reads } = hashPaidFor(document, tools);
    assert.equal(counters.overBudget, false);
    // Resolved, so the whole document was never hashed.
    assert.ok(counters.hashed < 1_000_000, `hashed ${counters.hashed}`);
    assert.ok(reads < 100_000, `reads ${reads}`);
  });

  it('examples: pays for every example each tool digests', () => {
    const parameter = {
      name: 'q',
      in: 'query',
      examples: wide(20_000, 'e', { value: 'x'.repeat(20) }),
      schema: { type: 'string', examples: Array.from({ length: 20_000 }, () => 'example') },
    };
    const { document, tools } = fanIn({
      pathItems: shared({
        parameters: [parameter],
        // Edge publishes a media type's schema, never its examples.
        requestBody: {
          content: {
            'application/json': { schema: { type: 'object' }, examples: wide(150_000, 'e') },
          },
        },
        responses: OK,
      }),
    });
    const { counters } = hashPaidFor(document, tools);
    assert.equal(counters.overBudget, true);
  });
});

describe('the stamped agent document', () => {
  const OK = { '200': { description: 'OK' } };
  const LISTEN_PATH = '/nexus/fan-in';
  const LISTEN_PATHS = [LISTEN_PATH, `/nexus/.staging/${'0'.repeat(32)}`];

  /** Whether `error` is the stamped document's size refusal. */
  const tooLarge = (error: unknown): boolean =>
    error instanceof NexusError &&
    error.code === 'SPEC_INVALID' &&
    (error.details as { reason?: unknown } | undefined)?.reason === 'agent_document_too_large';

  it('refuses a fan-in past its budget before building, reading the document about once', () => {
    // 2,000 paths reach one Path Item of 150,000 members through 32 hops.
    // Stamped, every path would hold its own copy: about 3 GiB.
    const item = { ...wide(150_000, 'x-'), post: { responses: OK } };
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    const { document, tools } = fanIn({
      pathItems: { ...referenceChain('pathItems', 'H', 31, 'Item'), Item: item },
      start: 'H0',
      paths: 2_000,
      tools: 1,
    });
    assert.ok(2_000 * itemBytes > 100 * MAX_AGENT_DOCUMENT_BYTES);
    const agents = { operations: tools };
    // Reading the document about once is paid for; reading the Path Item
    // once per path, as copying it would, throws UnpaidReads at once.
    const budget = 3 * documentSize(document);
    const allowed = (): number => budget;

    const counters = agentDocumentStats();
    const estimate = metered(document, allowed);
    assert.throws(
      () => stampedAgentDocumentBytes(estimate.document, LISTEN_PATHS, agents, counters),
      tooLarge,
    );
    // Abandoned at the first charge past the budget, which is at most one
    // copy of the Path Item.
    assert.ok(counters.charged > MAX_AGENT_DOCUMENT_BYTES, `charged ${counters.charged}`);
    assert.ok(counters.charged <= MAX_AGENT_DOCUMENT_BYTES + itemBytes, `${counters.charged}`);
    // Each object measured once, the Path Item included, however many paths reach it.
    assert.ok(counters.measured < 200, `measured ${counters.measured}`);
    assert.ok(estimate.reads() < 1_000_000, `reads ${estimate.reads()}`);

    // validateAgents, which every publishing request runs before it builds
    // anything, refuses it the same way within the same reads.
    const validation = metered(document, allowed);
    assert.throws(
      () => validateAgents(agents, validation.document, 'routes', true, null, LISTEN_PATHS),
      tooLarge,
    );
    assert.ok(validation.reads() < 2_000_000, `reads ${validation.reads()}`);
    // Nothing was built: every path is still its reference.
    const paths = document.paths as Record<string, Record<string, unknown>>;
    assert.deepEqual(paths['/p1999'], { $ref: '#/components/pathItems/H0' });
  });

  it('charges at least what the stamped document holds, but its fixed scaffolding', () => {
    const operation = { summary: 'Shared', 'x-ferrum-internal': true, responses: OK };
    const { document, tools } = fanIn({
      pathItems: {
        Shared: {
          summary: 'Shared',
          servers: [{ url: '/elsewhere' }],
          parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
          get: operation,
          post: operation,
        },
      },
      paths: 64,
      tools: 8,
      methods: ['GET', 'POST'],
    });
    const agents = { operations: tools };
    const charged = stampedAgentDocumentBytes(document, [LISTEN_PATH], agents);
    assert.ok(charged < MAX_AGENT_DOCUMENT_BYTES);
    const stamped = structuredClone(document);
    stampAgentDocument(
      stamped,
      { id: 'fan-in-proxy', listen_path: LISTEN_PATH },
      {
        apiId: 'fan-in-api',
        slug: 'fan-in',
        agents,
        sync: { syncMode: 'local', redisUrl: undefined, redisTls: false },
      },
    );
    const bytes = Buffer.byteLength(JSON.stringify(stamped));
    assert.ok(bytes > 64 * Buffer.byteLength(JSON.stringify(operation)), `bytes ${bytes}`);
    assert.ok(bytes <= charged + 8_192, `${bytes} bytes, ${charged} charged`);
    // Every route is charged at the longest path the proxy may hold.
    assert.ok(stampedAgentDocumentBytes(document, LISTEN_PATHS, agents) > charged);
  });
});

describe('identifyAgentTools', () => {
  const changed = edit((d) => {
    d.components.schemas.Receipt.properties.id.type = 'integer';
  });
  const renamed = edit((d) => {
    d.info.version = '2';
  });

  it('keeps an id across an unchanged definition and binds the hash to it', () => {
    const first = identifyAgentTools({ operations: [TOOL] }, BASE);
    const tool = first?.operations[0];
    assert.ok(tool?.id && tool.definition_hash);
    const again = identifyAgentTools({ operations: [TOOL] }, renamed, first);
    assert.deepEqual(again?.operations[0], tool);
    const redefined = identifyAgentTools({ operations: [TOOL] }, changed, first);
    assert.notEqual(redefined?.operations[0]?.id, tool.id);
    // A hash copied onto another id, as a release without hashes does when it
    // mints one, never matches again.
    const copied = { operations: [{ ...tool, id: 'minted-elsewhere' }] };
    const rebound = identifyAgentTools({ operations: [TOOL] }, BASE, copied);
    assert.notEqual(rebound?.operations[0]?.id, 'minted-elsewhere');
  });

  it('compares a tool stored without a hash against the revision it was published with', () => {
    const legacy = { operations: [{ ...TOOL, id: 'legacy-id' }] };
    const kept = identifyAgentTools({ operations: [TOOL] }, renamed, legacy, BASE);
    assert.equal(kept?.operations[0]?.id, 'legacy-id');
    assert.ok(kept?.operations[0]?.definition_hash);
    const rotated = identifyAgentTools({ operations: [TOOL] }, changed, legacy, BASE);
    assert.notEqual(rotated?.operations[0]?.id, 'legacy-id');
  });
});
