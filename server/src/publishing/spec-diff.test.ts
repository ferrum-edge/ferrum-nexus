/**
 * What the change-review comparison claims, and what it refuses to claim.
 *
 * The second half matters as much as the first: an empty
 * `potentially_breaking` must never be read as "this change is safe", so these
 * tests pin the cases where the comparison is deliberately silent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffSpecDocuments } from './spec-diff.js';

/** A minimal OpenAPI document over a path/method/operation table. */
function document(
  paths: Record<string, Record<string, unknown>>,
  info: Record<string, unknown> = { title: 'Billing', version: '1.0.0' },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { openapi: '3.1.0', info, paths, ...extra };
}

function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ReturnType<typeof diffSpecDocuments> {
  return diffSpecDocuments({ document: before, summary: null }, { document: after, summary: null });
}

describe('specification change review', () => {
  it('reports nothing for two identical documents', () => {
    const doc = document({ '/invoices': { get: { responses: { '200': {} } } } });
    const result = diff(doc, structuredClone(doc));
    assert.equal(result.changed, false);
    assert.deepEqual(result.added_operations, []);
    assert.deepEqual(result.removed_operations, []);
    assert.deepEqual(result.changed_operations, []);
    assert.deepEqual(result.potentially_breaking, []);
  });

  it('names added, removed and changed operations', () => {
    const before = document({
      '/invoices': { get: { responses: { '200': {} } }, post: { responses: { '201': {} } } },
      '/legacy': { get: { responses: { '200': {} } } },
    });
    const after = document({
      '/invoices': {
        get: { responses: { '200': {}, '404': {} } },
        delete: { responses: { '204': {} } },
      },
    });
    const result = diff(before, after);
    assert.deepEqual(result.added_operations, [{ method: 'DELETE', path: '/invoices' }]);
    assert.deepEqual(result.removed_operations, [
      { method: 'POST', path: '/invoices' },
      { method: 'GET', path: '/legacy' },
    ]);
    assert.deepEqual(result.changed_operations, [
      { method: 'GET', path: '/invoices', changes: ['responses'] },
    ]);
    assert.deepEqual(result.added_paths, []);
    assert.deepEqual(result.removed_paths, ['/legacy']);
    assert.equal(result.changed, true);
  });

  it('lifts every removed operation into potentially_breaking', () => {
    const before = document({ '/invoices': { get: {}, post: {} } });
    const after = document({ '/invoices': { get: {} } });
    const result = diff(before, after);
    assert.deepEqual(result.potentially_breaking, [{ method: 'POST', path: '/invoices' }]);
  });

  it('is not fooled by a parameter moving between the path item and the operation', () => {
    const shared = { parameters: [{ name: 'id', in: 'path', required: true }] };
    const before = document({ '/invoices/{id}': { ...shared, get: { responses: { '200': {} } } } });
    const after = document({
      '/invoices/{id}': {
        get: { ...shared, responses: { '200': {} } },
      },
    });
    assert.equal(diff(before, after).changed, false);
  });

  it('ignores a path-level parameter that an operation overrides', () => {
    const operation = {
      parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
      responses: { '200': { description: 'ok' } },
    };
    const before = document({
      '/items': {
        parameters: [{ name: 'limit', in: 'query', required: true, schema: { type: 'integer' } }],
        get: operation,
      },
    });
    const after = document({ '/items': { get: structuredClone(operation) } });
    assert.equal(diff(before, after).changed, false);
  });

  it('reports a changed override, and an override that shadows a different definition', () => {
    const inherited = { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } };
    const before = document({ '/items': { parameters: [inherited], get: {} } });

    // The operation now overrides the inherited `limit` with a different default.
    const overridden = document({
      '/items': {
        parameters: [inherited],
        get: { parameters: [{ ...inherited, schema: { type: 'integer', default: 10 } }] },
      },
    });
    assert.deepEqual(diff(before, overridden).changed_operations, [
      { method: 'GET', path: '/items', changes: ['parameters'] },
    ]);

    // Overriding with an identical definition changes nothing that applies.
    const redundant = document({
      '/items': { parameters: [inherited], get: { parameters: [{ ...inherited }] } },
    });
    assert.equal(diff(before, redundant).changed, false);
  });

  it('keeps same-named parameters in different locations apart', () => {
    const before = document({
      '/items/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true }],
        get: { parameters: [{ name: 'id', in: 'query' }] },
      },
    });
    // Dropping the path-level `id` is a real change: the query `id` never
    // overrode it.
    const after = document({
      '/items/{id}': { get: { parameters: [{ name: 'id', in: 'query' }] } },
    });
    assert.deepEqual(diff(before, after).changed_operations, [
      { method: 'GET', path: '/items/{id}', changes: ['parameters'] },
    ]);
  });

  it('does not read a reordering or a move between levels as a change', () => {
    const id = { name: 'id', in: 'path', required: true };
    const limit = { name: 'limit', in: 'query' };
    const trace = { name: 'X-Trace', in: 'header' };
    const before = document({
      '/items/{id}': { parameters: [id, trace], get: { parameters: [limit] } },
    });
    const after = document({ '/items/{id}': { get: { parameters: [limit, trace, id] } } });
    assert.equal(diff(before, after).changed, false);
  });

  it('identifies a referenced parameter by the object it names', () => {
    const components = {
      components: { parameters: { Tenant: { name: 'tenant_id', in: 'header', required: true } } },
    };
    const inline = { name: 'tenant_id', in: 'header', required: false };
    const before = document(
      {
        '/items': {
          parameters: [{ $ref: '#/components/parameters/Tenant' }],
          get: { parameters: [inline] },
        },
      },
      undefined,
      components,
    );
    const after = document({ '/items': { get: { parameters: [inline] } } }, undefined, components);
    assert.equal(diff(before, after).changed, false);
  });

  it('never equates a parameter whose reference cannot be followed', () => {
    const limit = { name: 'limit', in: 'query' };
    const before = document({
      '/items': {
        parameters: [{ $ref: '#/components/parameters/Missing' }],
        get: { parameters: [limit] },
      },
    });
    const after = document({ '/items': { get: { parameters: [limit] } } });
    assert.deepEqual(diff(before, after).changed_operations, [
      { method: 'GET', path: '/items', changes: ['parameters'] },
    ]);
  });

  it('reports info and servers changes without inventing operation changes', () => {
    const before = document(
      { '/invoices': { get: {} } },
      { title: 'Billing', version: '1.0.0', description: 'Old' },
      { servers: [{ url: 'https://one.example.test' }] },
    );
    const after = document(
      { '/invoices': { get: {} } },
      { title: 'Billing', version: '2.0.0', description: null },
      { servers: [{ url: 'https://two.example.test' }] },
    );
    const result = diff(before, after);
    assert.deepEqual(result.info_changes, [
      { field: 'version', from: '1.0.0', to: '2.0.0' },
      { field: 'description', from: 'Old', to: null },
    ]);
    assert.equal(result.servers_changed, true);
    assert.deepEqual(result.changed_operations, []);
    assert.equal(result.changed, true);
  });

  it('collapses unknown differing members into one `other` label', () => {
    const before = document({ '/invoices': { get: { 'x-internal-owner': 'billing' } } });
    const after = document({ '/invoices': { get: { 'x-internal-owner': 'payments' } } });
    assert.deepEqual(diff(before, after).changed_operations, [
      { method: 'GET', path: '/invoices', changes: ['other'] },
    ]);
  });

  it('ignores path items that declare no operation at all', () => {
    const before = document({ '/invoices': { get: {} }, '/notes': { description: 'prose' } });
    const after = document({ '/invoices': { get: {} } });
    const result = diff(before, after);
    assert.equal(result.changed, false, 'a path item with no method was never an operation');
    assert.deepEqual(result.removed_paths, []);
  });

  it('treats a missing current document as "everything is new"', () => {
    const after = document({ '/invoices': { get: {} } });
    const result = diffSpecDocuments(
      { document: {}, summary: null },
      { document: after, summary: null },
    );
    assert.deepEqual(result.added_operations, [{ method: 'GET', path: '/invoices' }]);
    assert.deepEqual(result.potentially_breaking, []);
    assert.equal(result.changed, true);
  });

  /**
   * The honesty test. A response schema that drops a required field breaks
   * every caller reading it, and this comparison cannot see that — so it must
   * report the change without implying anything about compatibility.
   */
  it('reports a narrowed schema as a change, and never as safe', () => {
    const before = document({
      '/invoices': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { type: 'object', required: ['id', 'total'] },
                },
              },
            },
          },
        },
      },
    });
    const after = structuredClone(before);
    const paths = after.paths as Record<string, Record<string, Record<string, never>>>;
    const responses = paths['/invoices']?.get as unknown as {
      responses: Record<string, { content: Record<string, { schema: { required: string[] } }> }>;
    };
    const schema = responses.responses['200']?.content['application/json']?.schema;
    assert.ok(schema);
    schema.required = ['id'];

    const result = diff(before, after);
    assert.deepEqual(result.changed_operations, [
      { method: 'GET', path: '/invoices', changes: ['responses'] },
    ]);
    // Reported as a change, absent from the breaking list — the comparison
    // does not read schemas, and the UI carries that caveat in words.
    assert.deepEqual(result.potentially_breaking, []);
  });
});
