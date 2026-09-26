import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_OPENAPI_REF_HOPS,
  keyOpenApiParameters,
  mergeOpenApiParameters,
  openApiParameterKey,
  openApiRefSiblingsApply,
  resolveOpenApiObject,
  resolveOpenApiPointer,
} from './openapi.js';

const tenant = { name: 'tenant_id', in: 'header', required: true };

const spec = {
  components: {
    parameters: {
      Tenant: tenant,
      Alias: { $ref: '#/components/parameters/Tenant', description: 'alias' },
      'a/b~c': { name: 'escaped', in: 'query' },
      Self: { $ref: '#/components/parameters/Self' },
    },
  },
  list: [{ name: 'first', in: 'query' }],
};

const escaped = { name: 'escaped', in: 'query' };

describe('OpenAPI JSON pointers', () => {
  it('unescapes ~1 and ~0 and percent-decodes segments', () => {
    assert.deepEqual(resolveOpenApiPointer(spec, '#/components/parameters/a~1b~0c'), escaped);
    assert.deepEqual(resolveOpenApiPointer(spec, '#/components/parameters/a%2Fb~0c'), escaped);
  });

  it('indexes arrays and follows only own members', () => {
    assert.deepEqual(resolveOpenApiPointer(spec, '#/list/0'), { name: 'first', in: 'query' });
    assert.equal(resolveOpenApiPointer(spec, '#/list/1'), undefined);
    assert.equal(resolveOpenApiPointer(spec, '#/list/01'), undefined);
    assert.equal(resolveOpenApiPointer(spec, '#/__proto__'), undefined);
    assert.equal(resolveOpenApiPointer(spec, '#/components/constructor'), undefined);
    assert.equal(resolveOpenApiPointer(spec, '#/components/%E0%A4%A'), undefined);
    assert.equal(resolveOpenApiPointer(spec, 'other.yaml#/components'), undefined);
  });
});

describe('OpenAPI Reference Objects', () => {
  it('follows chains and reports each kind of failure', () => {
    const alias = resolveOpenApiObject(spec, { $ref: '#/components/parameters/Alias' });
    assert.deepEqual(alias, { ok: true, value: tenant });

    const self = resolveOpenApiObject(spec, { $ref: '#/components/parameters/Self' });
    assert.deepEqual(self, { ok: false, ref: '#/components/parameters/Self', reason: 'cycle' });

    const missing = resolveOpenApiObject(spec, { $ref: '#/nothing' });
    assert.deepEqual(missing, { ok: false, ref: '#/nothing', reason: 'missing' });

    const external = resolveOpenApiObject(spec, { $ref: 'x.yaml#/a' });
    assert.deepEqual(external, { ok: false, ref: 'x.yaml#/a', reason: 'external' });
  });

  it('stops a non-circular chain at the hop limit', () => {
    const links: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_OPENAPI_REF_HOPS; index += 1) {
      links[`L${index}`] = { $ref: `#/links/L${index + 1}` };
    }
    links[`L${MAX_OPENAPI_REF_HOPS + 1}`] = { name: 'end', in: 'query' };
    const result = resolveOpenApiObject({ links }, { $ref: '#/links/L0' });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'depth');
  });

  it('applies description siblings only from OpenAPI 3.1 on, outermost first', () => {
    assert.equal(openApiRefSiblingsApply('3.0.3'), false);
    assert.equal(openApiRefSiblingsApply('2.0'), false);
    assert.equal(openApiRefSiblingsApply('3.1.0'), true);
    assert.equal(openApiRefSiblingsApply('3.2.0'), true);
    assert.equal(openApiRefSiblingsApply(null), false);

    const outer = { $ref: '#/components/parameters/Alias', description: 'outer' };
    const legacy = resolveOpenApiObject(spec, outer);
    assert.equal(legacy.ok && legacy.value.description, undefined);
    const current = resolveOpenApiObject(spec, outer, { siblingsApply: true });
    assert.equal(current.ok && current.value.description, 'outer');

    const plain = { $ref: '#/components/parameters/Alias' };
    const inner = resolveOpenApiObject(spec, plain, { siblingsApply: true });
    assert.equal(inner.ok && inner.value.description, 'alias');
  });

  it('reuses pointer lookups through a shared cache', () => {
    const pointerCache = new Map<string, unknown>();
    const ref = { $ref: '#/components/parameters/Alias' };
    resolveOpenApiObject(spec, ref, { pointerCache });
    const visited = [...pointerCache.keys()];
    assert.deepEqual(visited, ['#/components/parameters/Alias', '#/components/parameters/Tenant']);
    const again = resolveOpenApiObject(spec, ref, { pointerCache });
    assert.deepEqual(again, { ok: true, value: tenant });
  });
});

describe('OpenAPI parameter inheritance', () => {
  it('identifies a parameter by location and name, headers case-insensitively', () => {
    assert.equal(openApiParameterKey(spec, { name: 'id', in: 'path' }), 'path\u0000id');

    const upper = openApiParameterKey(spec, { name: 'X-Trace', in: 'header' });
    const lower = openApiParameterKey(spec, { name: 'x-trace', in: 'header' });
    assert.equal(upper, lower);

    const queryUpper = openApiParameterKey(spec, { name: 'Id', in: 'query' });
    const queryLower = openApiParameterKey(spec, { name: 'id', in: 'query' });
    assert.notEqual(queryUpper, queryLower);

    const referenced = openApiParameterKey(spec, { $ref: '#/components/parameters/Tenant' });
    assert.equal(referenced, 'header\u0000tenant_id');
    assert.equal(openApiParameterKey(spec, { $ref: '#/components/parameters/Self' }), null);
    assert.equal(openApiParameterKey(spec, { name: 'id' }), null);
  });

  it('lets operation parameters replace path-level ones with the same identity', () => {
    const pathParameters = [
      { name: 'id', in: 'path', required: true },
      { name: 'limit', in: 'query', required: true },
      { $ref: '#/components/parameters/Tenant' },
      { $ref: '#/components/parameters/Self' },
    ];
    const operationParameters = [
      { name: 'limit', in: 'query', required: false },
      { name: 'id', in: 'query' },
      { name: 'TENANT_ID', in: 'header' },
    ];
    const shared = keyOpenApiParameters(spec, pathParameters, true);
    const own = keyOpenApiParameters(spec, operationParameters, false);
    const merged = mergeOpenApiParameters(shared, own);
    const effective = merged.map((entry) => [entry.parameter, entry.inherited]);
    assert.deepEqual(effective, [
      [pathParameters[0], true],
      [pathParameters[3], true],
      [operationParameters[0], false],
      [operationParameters[1], false],
      [operationParameters[2], false],
    ]);
  });
});
