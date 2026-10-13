/**
 * The consumer-facing revision comparison (issues #447 and #448): what it
 * reports, how it classifies it, and the bounds it keeps on any document.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_SPEC_CHANGE_TEXT,
  MAX_SPEC_CHANGE_UNITS,
  MAX_SPEC_OPERATIONS,
  MAX_SPEC_RENDER_UNITS,
  emptySpecChangeReport,
  type SpecChange,
  type SpecChangeReport,
} from '@ferrum-nexus/shared';

import { assertRenderCost } from './oas.js';
import {
  MAX_TYPE_ENTRIES,
  compareSpecRevisions,
  compareSpecRevisionsSafely,
  type SpecChangeStats,
} from './spec-changes.js';

type Document = Record<string, unknown>;

/** A minimal OpenAPI document. */
function document(paths: Document, components: Document = {}, extra: Document = {}): Document {
  return {
    openapi: '3.1.0',
    info: { title: 'Orders', version: '1.0.0' },
    paths,
    components,
    ...extra,
  };
}

/** One JSON response carrying `schema`. */
function jsonResponse(schema: unknown): Document {
  return { description: 'OK', content: { 'application/json': { schema } } };
}

/** One change as a line: severity, kind, operation, section, location, schema path. */
function line(change: SpecChange): string {
  const operation = change.operation
    ? `${change.operation.method} ${change.operation.path}`
    : '(component)';
  return [
    change.severity,
    change.kind,
    operation,
    change.section,
    change.location ?? '-',
    change.schema_path ?? '-',
  ].join(' | ');
}

function lines(report: SpecChangeReport): string[] {
  return report.changes.map(line);
}

/**
 * A one-operation document parsed from JSON text, so a `__proto__` key arrives
 * as an own property exactly as it would from an upload.
 */
function hostile(properties: string, extraResponses = ''): Document {
  const text =
    '{"openapi":"3.1.0","info":{"title":"Orders","version":"1.0.0"},"paths":{"/x":{"get":' +
    '{"responses":{"200":{"content":{"application/json":{"schema":{"type":"object",' +
    `"properties":${properties}}}}}${extraResponses}}}}}}`;
  return JSON.parse(text) as Document;
}

function stats(): SpecChangeStats {
  return { units: 0, schemaPairs: 0, componentPairs: 0, typeEntries: 0, keyCodeUnits: 0 };
}

describe('consumer-facing revision comparison', () => {
  it('reports nothing for two identical documents', () => {
    const before = document({
      '/orders': { get: { responses: { '200': jsonResponse({ type: 'string' }) } } },
    });
    const report = compareSpecRevisions(before, structuredClone(before));
    assert.deepEqual(report, emptySpecChangeReport());
  });

  it('compares operations behind a referenced Path Item', () => {
    // The referenced item changes GET -> POST while an inline operation and
    // `info` stay identical: the change must surface, not read as no change.
    const before = document(
      {
        '/inline': { get: { responses: { '200': {} } } },
        '/shared': { $ref: '#/components/pathItems/Shared' },
      },
      { pathItems: { Shared: { get: { responses: { '200': {} } } } } },
    );
    const after = document(
      {
        '/inline': { get: { responses: { '200': {} } } },
        '/shared': { $ref: '#/components/pathItems/Shared' },
      },
      { pathItems: { Shared: { post: { responses: { '201': {} } } } } },
    );
    const report = compareSpecRevisions(before, after);
    assert.equal(report.complete, true);
    assert.equal(report.changed, true);
    assert.deepEqual(lines(report), [
      'breaking | operation_removed | GET /shared | operation | - | -',
      'non_breaking | operation_added | POST /shared | operation | - | -',
    ]);
  });

  it('keeps methods written beside a Path Item reference', () => {
    // `/shared` references a component with POST and adds a sibling GET.
    // Removing only the sibling GET is a breaking change the comparison
    // must see, not lose to the reference target.
    const shared = { $ref: '#/components/pathItems/Shared', get: { responses: { '200': {} } } };
    const components = { pathItems: { Shared: { post: { responses: { '201': {} } } } } };
    const before = document(
      { '/inline': { get: { responses: { '200': {} } } }, '/shared': shared },
      components,
    );
    const after = document(
      {
        '/inline': { get: { responses: { '200': {} } } },
        '/shared': { $ref: '#/components/pathItems/Shared' },
      },
      components,
    );
    const report = compareSpecRevisions(before, after);
    assert.equal(report.complete, true);
    assert.equal(report.changed, true);
    assert.deepEqual(lines(report), [
      'breaking | operation_removed | GET /shared | operation | - | -',
    ]);
  });

  it('keeps shared parameters written beside a Path Item reference', () => {
    const components = { pathItems: { Shared: { get: { responses: { '200': {} } } } } };
    const before = document(
      {
        '/shared': {
          $ref: '#/components/pathItems/Shared',
          parameters: [
            { name: 'tenant', in: 'header', required: true, schema: { type: 'string' } },
          ],
        },
      },
      components,
    );
    const after = document({ '/shared': { $ref: '#/components/pathItems/Shared' } }, components);
    const report = compareSpecRevisions(before, after);
    assert.equal(report.complete, true);
    assert.equal(report.changed, true);
    assert.ok(
      lines(report).some((entry) => entry.includes('parameter_removed | GET /shared')),
      lines(report).join('\n'),
    );
  });

  it('reads a large Path Item shared by many paths without copying it', () => {
    // One referenced item with many extension fields behind every path: each
    // path must cost its reference, not the item's size, on both sides.
    const fields: Document = { get: { responses: { '200': {} } } };
    for (let index = 0; index < 20_000; index += 1) fields[`x-field-${index}`] = index;
    let enumerations = 0;
    const shared = new Proxy(fields, {
      ownKeys(target) {
        enumerations += 1;
        return Reflect.ownKeys(target);
      },
    });
    const paths = (): Document => {
      const result: Document = {};
      for (let index = 0; index < 1_900; index += 1) {
        result[`/p${index}`] = { $ref: '#/components/pathItems/Shared' };
      }
      return result;
    };
    const counters = stats();
    const report = compareSpecRevisions(
      document(paths(), { pathItems: { Shared: shared } }),
      document(paths(), { pathItems: { Shared: shared } }),
      { stats: counters },
    );
    assert.equal(report.complete, true);
    assert.equal(report.changed, false);
    assert.equal(enumerations, 0, 'the shared item is never copied or enumerated');
    assert.ok(counters.units < 20 * 1_900, `spent ${counters.units}`);
  });

  it('charges every shared parameter, even ones an operation overrides', () => {
    // A shared item repeats one parameter identity 20,000 times and every
    // operation overrides it down to one survivor: the comparison must pay
    // for the raw list each time it reads it, and stop at its budget.
    const repeated = Array.from({ length: 20_000 }, () => ({ name: 'id', in: 'query' }));
    const operation = {
      parameters: [{ name: 'id', in: 'query', required: true }],
      responses: { '200': {} },
    };
    const components = { pathItems: { Shared: { parameters: repeated, get: operation } } };
    const paths: Document = {};
    for (let index = 0; index < 4; index += 1) {
      paths[`/p${index}`] = { $ref: '#/components/pathItems/Shared' };
    }
    const counters = stats();
    const report = compareSpecRevisions(
      document(paths, components),
      document(structuredClone(paths), components, { 'x-revision': 2 }),
      { unitLimit: 50_000, stats: counters },
    );
    assert.equal(report.complete, false);
    assert.ok(counters.units > 50_000);
  });

  it('walks a broken reference chain shared by many paths once', () => {
    // Every path points into one chain that ends at a missing item: the chain
    // is walked once per document, not once per path.
    const chain: Document = {};
    for (let index = 0; index < 20; index += 1) {
      chain[`H${index}`] = { $ref: `#/components/pathItems/H${index + 1}` };
    }
    let reads = 0;
    const counted = new Proxy(chain, {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        reads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const paths: Document = { '/inline': { get: { responses: { '200': {} } } } };
    for (let index = 0; index < 1_000; index += 1) {
      paths[`/p${index}`] = { $ref: '#/components/pathItems/H0' };
    }
    const report = compareSpecRevisions(
      document(paths, { pathItems: counted }),
      document(structuredClone(paths), { pathItems: counted }),
    );
    assert.equal(report.complete, false);
    assert.ok(reads < 1_000, `read the chain ${reads} times`);
  });

  it('walks a broken tail shared through distinct entries once', () => {
    // 1,000 distinct entries share one hub whose long chain ends at a
    // missing item: the tail is walked once per document, so the comparison
    // stays well inside its budget and still names the inline removal.
    const name = (index: number): string => `T${index}-${'x'.repeat(500)}`;
    const pathItems: Document = { Hub: { $ref: `#/components/pathItems/${name(1)}` } };
    for (let index = 1; index < 30; index += 1) {
      pathItems[name(index)] = { $ref: `#/components/pathItems/${name(index + 1)}` };
    }
    const paths = (withGone: boolean): Document => {
      const result: Document = { '/kept': { get: { responses: { '200': {} } } } };
      if (withGone) result['/gone'] = { get: { responses: { '200': {} } } };
      for (let index = 0; index < 1_000; index += 1) {
        pathItems[`Entry${index}`] = { $ref: '#/components/pathItems/Hub' };
        result[`/e${index}`] = { $ref: `#/components/pathItems/Entry${index}` };
      }
      return result;
    };
    const counters = stats();
    const report = compareSpecRevisions(
      document(paths(true), { pathItems }),
      document(paths(false), { pathItems }),
      { stats: counters },
    );
    assert.equal(report.complete, false, 'the broken references are unreadable');
    assert.equal(report.changed, true);
    assert.deepEqual(lines(report), [
      'breaking | operation_removed | GET /gone | operation | - | -',
    ]);
    // Two pointers per entry and one walk of the tail, not 1,000.
    assert.ok(counters.units < 20_000, `spent ${counters.units}`);
  });

  it('marks the comparison incomplete when a Path Item reference cannot be followed', () => {
    const before = document({ '/shared': { $ref: '#/components/pathItems/Missing' } });
    const report = compareSpecRevisions(before, structuredClone(before));
    assert.equal(report.complete, false);
    assert.equal(report.changed, false);
  });

  it('names operations added, removed and deprecated, removals as breaking', () => {
    const before = document({
      '/orders': { get: { responses: { '200': {} } }, post: { responses: { '201': {} } } },
      '/legacy': { get: { responses: { '200': {} } } },
    });
    const after = document({
      '/orders': {
        get: { deprecated: true, responses: { '200': {} } },
        delete: { responses: { '204': {} } },
      },
    });
    const report = compareSpecRevisions(before, after);
    assert.deepEqual(lines(report), [
      'breaking | operation_removed | POST /orders | operation | - | -',
      'breaking | operation_removed | GET /legacy | operation | - | -',
      'non_breaking | operation_deprecated | GET /orders | operation | - | -',
      'non_breaking | operation_added | DELETE /orders | operation | - | -',
    ]);
    assert.deepEqual(report.counts, {
      breaking: 2,
      non_breaking: 2,
      operations_added: 1,
      operations_removed: 2,
      operations_deprecated: 1,
      operations_changed: 1,
    });
    assert.equal(report.changed, true);
    assert.equal(report.complete, true);
    assert.equal(report.truncated, false);
  });

  it('classifies parameters added, removed and changing requiredness', () => {
    const before = document({
      '/orders/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
            { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
            { name: 'sort', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': {} },
        },
      },
    });
    const after = document({
      '/orders/{id}': {
        get: {
          parameters: [
            // Moved from the path item onto the operation: not a change.
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
            { name: 'sort', in: 'query', schema: { type: 'string' } },
            { name: 'expand', in: 'query', schema: { type: 'string' } },
            { name: 'tenant', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': {} },
        },
      },
    });
    assert.deepEqual(lines(compareSpecRevisions(before, after)), [
      'breaking | parameter_required | GET /orders/{id} | parameter | query limit | -',
      'breaking | parameter_added | GET /orders/{id} | parameter | header tenant | -',
      'breaking | parameter_removed | GET /orders/{id} | parameter | header X-Trace | -',
      'non_breaking | parameter_optional | GET /orders/{id} | parameter | query sort | -',
      'non_breaking | parameter_added | GET /orders/{id} | parameter | query expand | -',
    ]);
  });

  it('classifies request bodies from the side of the caller sending them', () => {
    const before = document({
      '/orders': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['item'],
                  properties: {
                    item: { type: 'string' },
                    note: { type: 'string' },
                    amount: { type: 'integer' },
                    mode: { type: 'string', enum: ['a', 'b'] },
                  },
                },
              },
              'application/xml': { schema: { type: 'object' } },
            },
          },
          responses: { '201': {} },
        },
      },
    });
    const after = document({
      '/orders': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['item', 'quantity'],
                  properties: {
                    item: { type: 'string' },
                    amount: { type: 'number' },
                    mode: { type: 'string', enum: ['a', 'c'] },
                    quantity: { type: 'integer' },
                    coupon: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '201': {} },
        },
      },
    });
    const report = compareSpecRevisions(before, after);
    assert.deepEqual(lines(report), [
      'breaking | request_body_required | POST /orders | request | - | -',
      'breaking | schema_enum_values_removed | POST /orders | request | application/json | mode',
      'breaking | schema_property_added | POST /orders | request | application/json | quantity',
      'breaking | media_type_removed | POST /orders | request | application/xml | -',
      // A caller may now send a number where it sent an integer: wider.
      'non_breaking | schema_type_changed | POST /orders | request | application/json | amount',
      'non_breaking | schema_enum_values_added | POST /orders | request | application/json | mode',
      'non_breaking | schema_property_added | POST /orders | request | application/json | coupon',
      'non_breaking | schema_property_removed | POST /orders | request | application/json | note',
    ]);
    const removed = report.changes.find((change) => change.kind === 'schema_enum_values_removed');
    assert.equal(removed?.from, '"b"');
    const added = report.changes.find((change) => change.schema_path === 'quantity');
    assert.equal(added?.to, 'required');
  });

  it('classifies responses and their schemas from the side of the caller reading them', () => {
    const before = document({
      '/orders/{id}': {
        get: {
          responses: {
            '200': jsonResponse({
              type: 'object',
              required: ['id', 'status'],
              properties: {
                id: { type: 'string' },
                status: { type: 'string', enum: ['open', 'closed'] },
                total: { type: 'integer' },
                lines: {
                  type: 'array',
                  items: { type: 'object', properties: { sku: { type: 'string' } } },
                },
              },
            }),
            '404': { description: 'Missing' },
          },
        },
      },
    });
    const after = document({
      '/orders/{id}': {
        get: {
          responses: {
            '200': jsonResponse({
              type: 'object',
              required: ['id'],
              properties: {
                id: { type: 'string' },
                status: { type: 'string', enum: ['open', 'closed', 'held'] },
                total: { type: 'number' },
                lines: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { sku: { type: 'string' }, price: { type: 'number' } },
                  },
                },
                currency: { type: 'string' },
              },
            }),
            '429': { description: 'Slow down' },
          },
        },
      },
    });
    const report = compareSpecRevisions(before, after);
    const at = 'GET /orders/{id} | response | 200 application/json';
    assert.deepEqual(lines(report), [
      `breaking | schema_property_optional | ${at} | status`,
      `breaking | schema_enum_values_added | ${at} | status`,
      `breaking | schema_type_changed | ${at} | total`,
      `non_breaking | schema_property_added | ${at} | lines[].price`,
      `non_breaking | schema_property_added | ${at} | currency`,
      'non_breaking | response_added | GET /orders/{id} | response | 429 | -',
      // An error the caller will no longer get does not break it.
      'non_breaking | response_removed | GET /orders/{id} | response | 404 | -',
    ]);
    const typeChange = report.changes.find((change) => change.kind === 'schema_type_changed');
    assert.equal(typeChange?.from, 'integer');
    assert.equal(typeChange?.to, 'number');
    assert.equal(report.counts.operations_changed, 1);
  });

  it('treats a removed success response as breaking', () => {
    const before = document({ '/orders': { get: { responses: { '200': {}, '500': {} } } } });
    const after = document({ '/orders': { get: { responses: { '202': {} } } } });
    assert.deepEqual(lines(compareSpecRevisions(before, after)), [
      'breaking | response_removed | GET /orders | response | 200 | -',
      'non_breaking | response_added | GET /orders | response | 202 | -',
      'non_breaking | response_removed | GET /orders | response | 500 | -',
    ]);
  });

  it('compares a shared component once, however many operations reference it', () => {
    const paths: Document = {};
    for (let index = 0; index < 300; index += 1) {
      paths[`/orders/${index}`] = {
        get: { responses: { '200': jsonResponse({ $ref: '#/components/schemas/Order' }) } },
        post: {
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          responses: { '201': {} },
        },
      };
    }
    const order = (properties: Document): Document => ({
      schemas: { Order: { type: 'object', properties } },
    });
    const before = document(paths, order({ id: { type: 'string' }, status: { type: 'string' } }));
    const after = document(structuredClone(paths), order({ id: { type: 'string' } }));
    const counters = stats();
    const report = compareSpecRevisions(before, after, { stats: counters });

    // Once per direction, never once per operation.
    assert.deepEqual(lines(report), [
      'breaking | schema_property_removed | (component) | response | #/components/schemas/Order | status',
      'non_breaking | schema_property_removed | (component) | request | #/components/schemas/Order | status',
    ]);
    assert.equal(counters.componentPairs, 2);
    // Each direction compares `Order` and its `id` property: four pairs in all.
    assert.equal(counters.schemaPairs, 4);
    assert.equal(report.counts.operations_changed, 0);
  });

  it('terminates on a component that references itself', () => {
    const node = (properties: Document): Document => ({
      schemas: {
        Node: {
          type: 'object',
          properties: { child: { $ref: '#/components/schemas/Node' }, ...properties },
        },
      },
    });
    const paths = {
      '/tree': {
        get: { responses: { '200': jsonResponse({ $ref: '#/components/schemas/Node' }) } },
      },
    };
    const counters = stats();
    const report = compareSpecRevisions(
      document(paths, node({ name: { type: 'string' } })),
      document(paths, node({ name: { type: 'string' }, value: { type: 'integer' } })),
      { stats: counters },
    );
    assert.deepEqual(lines(report), [
      'non_breaking | schema_property_added | (component) | response | #/components/schemas/Node | value',
    ]);
    assert.equal(counters.componentPairs, 1);
  });

  it('stops at its budget and says the result is incomplete', () => {
    const paths = (count: number): Document => {
      const result: Document = {};
      for (let index = 0; index < count; index += 1) {
        result[`/p${index}`] = { get: { responses: { '200': {} } } };
      }
      return result;
    };
    const counters = stats();
    const report = compareSpecRevisions(document(paths(200)), document({}), {
      unitLimit: 50,
      stats: counters,
    });
    // Spending stops at the budget, and the result says it is incomplete;
    // the notifier sends an incomplete comparison as possibly breaking.
    assert.equal(report.complete, false);
    assert.ok(report.counts.operations_removed < 200);
    assert.ok(counters.units > 50 && counters.units <= 51, `spent ${counters.units}`);
  });

  it('lists breaking changes first and counts past the list cap', () => {
    const operations = (names: string[]): Document =>
      Object.fromEntries(names.map((name) => [`/${name}`, { get: { responses: { '200': {} } } }]));
    const report = compareSpecRevisions(
      document(operations(['a', 'b', 'c', 'd', 'e'])),
      document(operations(['f', 'g', 'h', 'i', 'j'])),
      { listLimit: 3 },
    );
    assert.deepEqual(
      report.changes.map((change) => `${change.kind} ${change.operation?.path}`),
      ['operation_removed /a', 'operation_removed /b', 'operation_removed /c'],
    );
    assert.equal(report.truncated, true);
    assert.equal(report.counts.breaking, 5);
    assert.equal(report.counts.non_breaking, 5);
  });

  it('reads hostile keys as names, without touching any prototype', () => {
    const before = hostile('{"__proto__":{"type":"string"},"constructor":{"type":"string"}}');
    const after = hostile(
      '{"__proto__":{"type":"integer"},"hasOwnProperty":{"type":"string"}}',
      ',"__proto__":{"description":"odd"}',
    );
    const report = compareSpecRevisions(before, after);
    const at = 'GET /x | response | 200 application/json';
    assert.deepEqual(lines(report), [
      `breaking | schema_type_changed | ${at} | __proto__`,
      `breaking | schema_property_removed | ${at} | constructor`,
      `non_breaking | schema_property_added | ${at} | hasOwnProperty`,
      'non_breaking | response_added | GET /x | response | __proto__ | -',
    ]);
    assert.equal(({} as { type?: unknown }).type, undefined);
    assert.equal(({} as { description?: unknown }).description, undefined);
  });

  it('cuts long provider-written names', () => {
    const name = 'p'.repeat(500);
    const before = document({
      '/x': { get: { responses: { '200': jsonResponse({ type: 'object' }) } } },
    });
    const after = document({
      '/x': {
        get: {
          responses: {
            '200': jsonResponse({ type: 'object', properties: { [name]: { type: 'string' } } }),
          },
        },
      },
    });
    const [change] = compareSpecRevisions(before, after).changes;
    assert.equal(change?.schema_path?.length, MAX_SPEC_CHANGE_TEXT);
    assert.ok(change?.schema_path?.endsWith('…'));
  });

  it('never carries descriptions, examples, servers or extensions', () => {
    const shared = {
      servers: [{ url: 'https://backend.internal.example:8443/v1' }],
      'x-internal': 'SECRET-EXTENSION',
    };
    const operation = (properties: Document): Document => ({
      description: 'SECRET-OPERATION-DESCRIPTION',
      'x-owner': 'SECRET-OWNER',
      responses: {
        '200': jsonResponse({
          type: 'object',
          description: 'SECRET-SCHEMA-DESCRIPTION',
          example: { token: 'SECRET-EXAMPLE' },
          properties,
        }),
      },
    });
    const before = document(
      { '/x': { get: operation({ a: { type: 'string', description: 'SECRET-A' } }) } },
      {},
      { ...shared, info: { title: 'Orders', version: '1', description: 'SECRET-INFO-1' } },
    );
    const after = document(
      { '/x': { get: operation({ b: { type: 'string', description: 'SECRET-B' } }) } },
      {},
      {
        ...shared,
        servers: [{ url: 'https://other.internal.example' }],
        info: { title: 'Orders', version: '2', description: 'SECRET-INFO-2' },
      },
    );
    const report = compareSpecRevisions(before, after);
    assert.deepEqual(report.info_changes, ['version', 'description']);
    assert.equal(report.counts.breaking, 1);
    const text = JSON.stringify(report);
    assert.doesNotMatch(text, /SECRET|internal\.example/);
  });

  // A regression here would hang rather than fail, so it is given a deadline.
  it('reads at most a bounded prefix of a `type` list, however long', { timeout: 10_000 }, () => {
    // Junk names are not types, so the only ones that count are the seven
    // JSON Schema ones, and a list is read no further than a type list can be.
    const junk = Array.from({ length: 100_000 }, (_, index) => `t${index}`);
    const paths = (types: string[]): Document => {
      const result: Document = {};
      for (let index = 0; index < 200; index += 1) {
        result[`/p${index}`] = {
          get: { responses: { '200': jsonResponse({ type: types }) } },
        };
      }
      return result;
    };
    const counters = stats();
    const report = compareSpecRevisions(
      document(paths(junk)),
      document(paths([...junk, 'string'])),
      { stats: counters },
    );
    assert.equal(report.complete, true);
    assert.equal(report.counts.breaking + report.counts.non_breaking, 0);
    assert.ok(counters.units < 2_000, `spent ${counters.units}`);
    // Two lists per schema pair, each read no further than the bound.
    assert.equal(counters.schemaPairs, 200);
    assert.ok(
      counters.typeEntries <= counters.schemaPairs * 2 * MAX_TYPE_ENTRIES,
      `read ${counters.typeEntries} type entries`,
    );

    // A real list still compares.
    const widened = compareSpecRevisions(
      document({ '/x': { get: { responses: { '200': jsonResponse({ type: ['string'] }) } } } }),
      document({
        '/x': { get: { responses: { '200': jsonResponse({ type: ['string', 'null'] }) } } },
      }),
    );
    assert.deepEqual(lines(widened), [
      // The schema itself: its path is the empty string.
      'breaking | schema_type_changed | GET /x | response | 200 application/json | ',
    ]);
  });

  it('compares `required` even where the schema declares no properties', () => {
    const body = (required: string[]): Document => ({
      '/orders': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: { allOf: [{ $ref: '#/components/schemas/Base' }, { required }] },
              },
            },
          },
          responses: { '201': {} },
        },
      },
    });
    const components = {
      schemas: { Base: { type: 'object', properties: { id: { type: 'string' } } } },
    };
    const report = compareSpecRevisions(
      document(body([]), components),
      document(body(['id']), components),
    );
    assert.deepEqual(lines(report), [
      'breaking | schema_property_required | POST /orders | request | application/json | allOf[1].id',
    ]);
  });

  it('never throws out of the safe comparison', () => {
    const failing = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      },
    ) as Document;
    const errors: unknown[] = [];
    const report = compareSpecRevisionsSafely(failing, document({}), (error) => errors.push(error));
    assert.deepEqual(report, emptySpecChangeReport(false));
    assert.equal(errors.length, 1);
  });

  it('is deterministic', () => {
    const before = document({
      '/a': { get: { responses: { '200': jsonResponse({ type: 'string', enum: ['x', 'y'] }) } } },
      '/b': { post: { responses: { '201': {} } } },
    });
    const after = document({
      '/a': { get: { responses: { '200': jsonResponse({ type: 'string', enum: ['y', 'z'] }) } } },
      '/c': { get: { responses: { '200': {} } } },
    });
    assert.deepEqual(compareSpecRevisions(before, after), compareSpecRevisions(before, after));
  });

  it('still names a small enum change between a reference and an inline schema', () => {
    const before = document(
      {
        '/orders': {
          get: {
            responses: {
              '200': jsonResponse({
                type: 'object',
                properties: { status: { $ref: '#/components/schemas/Status' } },
              }),
            },
          },
        },
      },
      { schemas: { Status: { type: 'string', enum: ['open', 'closed'] } } },
    );
    const after = document({
      '/orders': {
        get: {
          responses: {
            '200': jsonResponse({
              type: 'object',
              properties: { status: { type: 'string', enum: ['open', 'void'] } },
            }),
          },
        },
      },
    });
    const report = compareSpecRevisions(before, after);
    const at = 'GET /orders | response | 200 application/json';
    assert.deepEqual(lines(report), [
      `breaking | schema_enum_values_added | ${at} | status`,
      `non_breaking | schema_enum_values_removed | ${at} | status`,
    ]);
    assert.equal(report.changes[0]?.to, '"void"');
    assert.equal(report.changes[1]?.from, '"closed"');
    assert.equal(report.complete, true);
  });

  it('keys a shared enum once, however many inline enums it is compared with', () => {
    const operations = 50;
    const run = (length: number): { report: SpecChangeReport; counters: SpecChangeStats } => {
      const values = Array.from({ length: 64 }, (_, index) => String(index).padStart(length, 'v'));
      const beforePaths: Document = {};
      const afterPaths: Document = {};
      for (let index = 0; index < operations; index += 1) {
        beforePaths[`/p${index}`] = {
          get: { responses: { '200': jsonResponse({ $ref: '#/components/schemas/Shared' }) } },
        };
        afterPaths[`/p${index}`] = {
          get: { responses: { '200': jsonResponse({ type: 'string', enum: ['x'] }) } },
        };
      }
      const before = document(beforePaths, {
        schemas: { Shared: { type: 'string', enum: values } },
      });
      const counters = stats();
      const report = compareSpecRevisions(before, document(afterPaths), { stats: counters });
      return { report, counters };
    };
    const short = run(2);
    const long = run(16_000);

    // Every pair is compared, and finds the same thing whatever the length.
    assert.equal(long.report.complete, true);
    assert.deepEqual(long.report.counts, short.report.counts);
    assert.equal(long.report.counts.operations_changed, operations);
    // The shared array's strings are read once, each inline `x` once.
    assert.equal(long.counters.keyCodeUnits, 64 * 16_000 + operations);
    // And charged once, on the comparison's running total of keyed text.
    assert.equal(
      long.counters.units - short.counters.units,
      Math.ceil((64 * 16_000 + operations) / 256) - Math.ceil((64 * 2 + operations) / 256),
    );
  });

  it('tells long enum values of one length apart', () => {
    const values = (changed: string | null): string[] =>
      Array.from({ length: 40 }, (_, index) =>
        (index === 7 && changed !== null ? changed : String(index)).padStart(20_000, 'w'),
      );
    const component = (enumValues: string[]): Document => ({
      schemas: { Shared: { type: 'string', enum: enumValues } },
    });
    const paths: Document = {
      '/x': {
        get: {
          responses: {
            '200': jsonResponse({
              type: 'object',
              properties: { value: { $ref: '#/components/schemas/Shared' } },
            }),
          },
        },
      },
    };
    const counters = stats();
    const report = compareSpecRevisions(
      document(paths, component(values(null))),
      document(structuredClone(paths), component(values('z'))),
      { stats: counters },
    );
    assert.deepEqual(
      report.changes.map((change) => `${change.severity} ${change.kind}`),
      ['breaking schema_enum_values_added', 'non_breaking schema_enum_values_removed'],
    );
    assert.equal(report.complete, true);
    // Each document's array once, plus the `value` property names.
    assert.equal(counters.keyCodeUnits, 2 * 40 * 20_000 + 2 * 'value'.length);
  });

  it('keeps a realistic inlined enum within the budget', () => {
    // About the size of the IANA time zone list, inlined in every operation.
    const zones = (): string[] =>
      Array.from({ length: 600 }, (_, index) => `Zone/City_Name_${String(index).padStart(3, '0')}`);
    assert.equal(zones().join('').length, 10_800);
    const paths: Document = {};
    for (let index = 0; index < 75; index += 1) {
      paths[`/p${index}`] = {
        get: { responses: { '200': jsonResponse({ type: 'string', enum: zones() }) } },
      };
    }
    const before = document(paths);
    const counters = stats();
    const report = compareSpecRevisions(before, structuredClone(before), { stats: counters });

    assert.deepEqual(report, emptySpecChangeReport());
    // Each of the 150 arrays is keyed once.
    assert.equal(counters.keyCodeUnits, 150 * 10_800);
  });

  it('keys the long property and required names of a shared schema once', () => {
    const operations = 40;
    const run = (name: string): { report: SpecChangeReport; counters: SpecChangeStats } => {
      const beforePaths: Document = {};
      const afterPaths: Document = {};
      for (let index = 0; index < operations; index += 1) {
        beforePaths[`/p${index}`] = {
          get: { responses: { '200': jsonResponse({ $ref: '#/components/schemas/Shared' }) } },
        };
        afterPaths[`/p${index}`] = {
          get: {
            responses: {
              '200': jsonResponse({
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
              }),
            },
          },
        };
      }
      const before = document(beforePaths, {
        schemas: {
          Shared: { type: 'object', properties: { [name]: { type: 'string' } }, required: [name] },
        },
      });
      const counters = stats();
      const report = compareSpecRevisions(before, document(afterPaths), { stats: counters });
      return { report, counters };
    };
    const short = run('n');
    const long = run('n'.repeat(20_000));

    assert.equal(long.report.complete, true);
    assert.deepEqual(long.report.counts, short.report.counts);
    // The shared names once, each inline `id` twice (property and required).
    assert.equal(long.counters.keyCodeUnits, 2 * 20_000 + operations * 4);
    assert.equal(
      long.counters.units - short.counters.units,
      Math.ceil((2 * 20_000 + operations * 4) / 256) - Math.ceil((2 + operations * 4) / 256),
    );
  });

  it('keys a shared parameter once, however many operations reference it', () => {
    const run = (name: string): { report: SpecChangeReport; counters: SpecChangeStats } => {
      const paths: Document = {};
      for (let index = 0; index < 100; index += 1) {
        paths[`/p${index}`] = {
          get: {
            parameters: [{ $ref: '#/components/parameters/Trace' }],
            responses: { '200': {} },
          },
        };
      }
      const components: Document = {
        parameters: { Trace: { name, in: 'header', schema: { type: 'string' } } },
      };
      const counters = stats();
      const report = compareSpecRevisions(
        document(paths, components),
        document(structuredClone(paths), structuredClone(components)),
        { stats: counters },
      );
      return { report, counters };
    };
    const short = run('X-Trace');
    const long = run('X-'.padEnd(20_000, 'a'));

    assert.deepEqual(long.report, emptySpecChangeReport());
    // `in` and `name`, once per document.
    assert.equal(long.counters.keyCodeUnits, 2 * ('header'.length + 20_000));
    assert.equal(
      long.counters.units - short.counters.units,
      Math.ceil((2 * 20_006) / 256) - Math.ceil((2 * 13) / 256),
    );
  });

  it('fits a pair of the largest accepted documents of small inline parameters', () => {
    // As many parameter rows as the render limit allows, over as many
    // operations as a document may declare, each its own small inline object.
    const operations = MAX_SPEC_OPERATIONS;
    const methods = ['get', 'put', 'post'] as const;
    const paths: Document = {};
    let rows = 0;
    for (let index = 0; index < operations; index += 1) {
      const count = Math.floor(MAX_SPEC_RENDER_UNITS / operations) + (index < 1_000 ? 1 : 0);
      const parameters = Array.from({ length: count }, (_, position) => ({
        name: `p${position}`,
        in: 'query',
      }));
      rows += count;
      const path = `/p${Math.floor(index / methods.length)}`;
      const item = (paths[path] ??= {}) as Document;
      item[methods[index % methods.length]!] = { parameters };
    }
    assert.equal(rows, MAX_SPEC_RENDER_UNITS);
    const before = document(paths);
    // Accepted: exactly at the render limit.
    assertRenderCost(before, paths);

    const counters = stats();
    const report = compareSpecRevisions(before, structuredClone(before), { stats: counters });

    assert.deepEqual(report, emptySpecChangeReport());
    // One unit per operation and per parameter of each document, and the
    // keyed text by its total length rather than a unit per parameter.
    assert.equal(counters.units, operations + 2 * rows + Math.ceil(counters.keyCodeUnits / 256));
    assert.ok(counters.units <= MAX_SPEC_CHANGE_UNITS);
  });
});
