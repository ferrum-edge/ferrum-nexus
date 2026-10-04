import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
});
