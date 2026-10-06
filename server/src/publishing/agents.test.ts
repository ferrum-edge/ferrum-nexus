import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_DEFINITION_HASH_WORK,
  agentToolDefinitionDigests,
  agentToolDefinitionHash,
  identifyAgentTools,
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
  return { hashed: 0, lookups: 0, overBudget: false };
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
    // Every reference is still looked up: Big's, then Order, its cycle and
    // Receipt, per tool.
    assert.equal(counters.lookups, 2 * (refs.length + 3));
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
