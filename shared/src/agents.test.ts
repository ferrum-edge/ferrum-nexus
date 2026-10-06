import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_SPEC_OPERATIONS } from './constants.js';
import { agentOperations, agentPathItems, agentToolName } from './agents.js';

describe('agent operation metadata', () => {
  it('resolves chained local Path Items with sibling overlays and descriptive defaults', () => {
    const document = {
      paths: { '/items': { $ref: '#/components/pathItems/Items', summary: 'Items' } },
      components: { pathItems: { Items: { $ref: '#/webhooks/Base' } } },
      webhooks: {
        Base: {
          get: { operationId: 'listItems', summary: 'List items' },
          post: { operationId: 'createItem', description: 'Create one item' },
          head: { operationId: 'countItems' },
        },
      },
    };
    const items = agentPathItems(document)['/items'] as Record<string, unknown>;
    assert.equal(items.$ref, undefined);
    assert.equal(items.summary, 'Items');
    const operations = agentOperations(document);
    const get = operations.find((operation) => operation.method === 'GET');
    assert.ok(get);
    assert.equal(get.description, 'List items');
    assert.equal(get.read_only, true);
    assert.equal(get.supported, true);
    assert.equal(agentToolName('items', get), 'items.listItems');
    assert.equal(operations.find((operation) => operation.method === 'POST')?.read_only, false);
    const head = operations.find((operation) => operation.method === 'HEAD');
    assert.equal(head?.read_only, true);
    assert.equal(head?.supported, false);
  });

  it('matches the pinned Edge bridge method and Path Item reference contract', () => {
    // Edge v0.9.13 docs/api_specs.md documents local Path Item resolution and
    // the MCP bridge's five supported methods.
    const document = {
      paths: { '/shared': { $ref: '#/components/pathItems/Shared', summary: 'Overlay' } },
      components: {
        pathItems: {
          Shared: {
            get: { responses: { '200': { description: 'OK' } } },
            post: { responses: { '200': { description: 'OK' } } },
            put: { responses: { '200': { description: 'OK' } } },
            patch: { responses: { '200': { description: 'OK' } } },
            delete: { responses: { '200': { description: 'OK' } } },
            head: { responses: { '200': { description: 'OK' } } },
            options: { responses: { '200': { description: 'OK' } } },
            trace: { responses: { '200': { description: 'OK' } } },
          },
        },
      },
    };
    const operations = agentOperations(document);

    // In OPENAPI_OPERATION_METHODS order, which is the OpenAPI Path Item's.
    assert.deepEqual(
      operations.map(({ method, path, supported }) => [method, path, supported]),
      [
        ['GET', '/shared', true],
        ['PUT', '/shared', true],
        ['POST', '/shared', true],
        ['DELETE', '/shared', true],
        ['OPTIONS', '/shared', false],
        ['HEAD', '/shared', false],
        ['PATCH', '/shared', true],
        ['TRACE', '/shared', false],
      ],
    );
  });

  it('reads a shared Path Item in place, and bounds a chain joined to one already read', () => {
    const chain: Record<string, unknown> = {};
    for (let index = 0; index < 31; index += 1) {
      const next = index < 30 ? `H${index + 1}` : 'Item';
      chain[`H${index}`] = { $ref: `#/components/pathItems/${next}` };
    }
    const item = { summary: 'Shared', get: { operationId: 'read' } };
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      paths[`/p${index}`] = { $ref: '#/components/pathItems/H0' };
    }
    const document = { paths, components: { pathItems: { ...chain, Item: item } } };
    // Each path is 32 hops from the item.
    assert.equal(agentOperations(document).length, 100);
    assert.equal((agentPathItems(document)['/p99'] as Record<string, unknown>).summary, 'Shared');
    // One more hop, through a path already resolved, passes the bound.
    assert.throws(
      () => agentOperations({ ...document, paths: { ...paths, '/q': { $ref: '#/paths/~1p0' } } }),
      /local Path Item reference/,
    );
  });

  it('refuses cyclic, external and out-of-bound Path Item references', () => {
    for (const reference of [
      'https://outside.test/path.json',
      '#/examples/path',
      '#/paths/~1items',
    ]) {
      assert.throws(
        () => agentOperations({ paths: { '/items': { $ref: reference } } }),
        /local Path Item reference/,
      );
    }
  });

  it('counts operations reached through Path Item references against a requested cap', () => {
    const OK = { responses: { '200': { description: 'OK' } } };
    // 1,500 paths share one Path Item of two operations: 3,000 resolved
    // operations, though no path declares a method of its own.
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < MAX_SPEC_OPERATIONS / 2; index += 1) {
      paths[`/items/${index}`] = { $ref: '#/components/pathItems/Shared' };
    }
    const document = {
      paths,
      components: { pathItems: { Shared: { get: OK, post: OK } } },
    };
    const capped = { maxOperations: MAX_SPEC_OPERATIONS };

    assert.equal(agentOperations(document, capped).length, MAX_SPEC_OPERATIONS);
    const over = { ...document, paths: { ...paths, '/one-more': { get: OK } } };
    assert.throws(
      () => agentOperations(over, capped),
      new RegExp(`more than ${MAX_SPEC_OPERATIONS} operations`),
    );
    // Without a cap, a document already on the gateway is read in full.
    assert.equal(agentOperations(over).length, MAX_SPEC_OPERATIONS + 1);
  });
});
