/**
 * The consumer-facing revision comparison (issues #447 and #448): what it
 * reports, how it classifies it, and the bounds it keeps on any document.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_SPEC_CHANGE_TEXT,
  emptySpecChangeReport,
  type SpecChange,
  type SpecChangeReport,
} from '@ferrum-nexus/shared';

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
  return { units: 0, schemaPairs: 0, componentPairs: 0, typeEntries: 0 };
}

describe('consumer-facing revision comparison', () => {
  it('reports nothing for two identical documents', () => {
    const before = document({
      '/orders': { get: { responses: { '200': jsonResponse({ type: 'string' }) } } },
    });
    const report = compareSpecRevisions(before, structuredClone(before));
    assert.deepEqual(report, emptySpecChangeReport());
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
    assert.equal(report.complete, false);
    assert.ok(report.counts.operations_removed < 200);
    assert.ok(counters.units > 50);
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

  it('charges enum string size before comparing mixed reference and inline schemas', () => {
    const shared = 'x'.repeat(1_000);
    const before = document(
      {
        '/a': {
          get: {
            responses: {
              '200': jsonResponse({
                type: 'object',
                properties: { value: { $ref: '#/components/schemas/Shared' } },
              }),
            },
          },
        },
      },
      { schemas: { Shared: { type: 'string', enum: [shared] } } },
    );
    const after = document({
      '/a': {
        get: {
          responses: {
            '200': jsonResponse({
              type: 'object',
              properties: { value: { type: 'string', enum: ['x'] } },
            }),
          },
        },
      },
    });
    const measured = stats();

    const report = compareSpecRevisions(before, after, { unitLimit: 100, stats: measured });

    assert.equal(report.complete, false);
    assert.ok(measured.units > 100);
  });
});
