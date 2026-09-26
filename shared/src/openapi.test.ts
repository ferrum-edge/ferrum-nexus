import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_OPENAPI_POINTER_SEGMENTS,
  MAX_OPENAPI_REF_HOPS,
  createOpenApiRefResolver,
  keyOpenApiParameters,
  mergeOpenApiParameters,
  openApiParameterKey,
  openApiRefSiblingsApply,
  resolveOpenApiObject,
  resolveOpenApiPointer,
  type OpenApiResolveStats,
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

  it('refuses a pointer longer than the nesting limit without walking it', () => {
    let deep: unknown = { name: 'bottom', in: 'query' };
    for (let level = 0; level <= MAX_OPENAPI_POINTER_SEGMENTS; level += 1) deep = { a: deep };
    const within = `#/${Array(MAX_OPENAPI_POINTER_SEGMENTS).fill('a').join('/')}`;
    const beyond = `${within}/a`;
    assert.notEqual(resolveOpenApiPointer(deep, within), undefined);
    assert.equal(resolveOpenApiPointer(deep, beyond), undefined);

    const stats: OpenApiResolveStats = { pointerLookups: 0, pointerSegments: 0 };
    const resolver = createOpenApiRefResolver(deep, { stats });
    assert.deepEqual(resolver.resolve({ $ref: beyond }), {
      ok: false,
      ref: beyond,
      reason: 'missing',
    });
    assert.equal(stats.pointerSegments, 0);
  });
});

describe('OpenAPI Reference Objects', () => {
  it('follows chains and reports each kind of failure', () => {
    const alias = resolveOpenApiObject(spec, { $ref: '#/components/parameters/Alias' });
    assert.deepEqual(alias, { ok: true, value: tenant, overrides: {} });
    assert.equal(alias.ok && alias.value, tenant);

    const self = resolveOpenApiObject(spec, { $ref: '#/components/parameters/Self' });
    assert.deepEqual(self, { ok: false, ref: '#/components/parameters/Self', reason: 'cycle' });

    const missing = resolveOpenApiObject(spec, { $ref: '#/nothing' });
    assert.deepEqual(missing, { ok: false, ref: '#/nothing', reason: 'missing' });

    const external = resolveOpenApiObject(spec, { $ref: 'x.yaml#/a' });
    assert.deepEqual(external, { ok: false, ref: 'x.yaml#/a', reason: 'external' });
  });

  it('reports the same repeated reference wherever a cycle is entered', () => {
    const loop = {
      A: { $ref: '#/B' },
      B: { $ref: '#/C' },
      C: { $ref: '#/B' },
    };
    // Whichever order the resolver meets them in, memoised or not.
    for (const order of [
      ['#/A', '#/B', '#/C'],
      ['#/C', '#/B', '#/A'],
    ]) {
      const resolver = createOpenApiRefResolver(loop);
      const reported = Object.fromEntries(
        order.map((ref) => {
          const result = resolver.resolve({ $ref: ref });
          return [ref, result.ok ? null : `${result.reason} ${result.ref}`];
        }),
      );
      assert.deepEqual(reported, { '#/A': 'cycle #/B', '#/B': 'cycle #/B', '#/C': 'cycle #/C' });
    }
  });

  it('stops a non-circular chain at the hop limit, wherever it starts', () => {
    const links: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_OPENAPI_REF_HOPS; index += 1) {
      links[`L${index}`] = { $ref: `#/links/L${index + 1}` };
    }
    links[`L${MAX_OPENAPI_REF_HOPS + 1}`] = { name: 'end', in: 'query' };
    const resolver = createOpenApiRefResolver({ links });
    // The tail first, so the head is answered from memoised outcomes.
    const tail = resolver.resolve({ $ref: '#/links/L2' });
    assert.equal(tail.ok && tail.value.name, 'end');
    const result = resolver.resolve({ $ref: '#/links/L0' });
    assert.deepEqual(result, { ok: false, ref: '#/links/L0', reason: 'depth' });
    const fresh = resolveOpenApiObject({ links }, { $ref: '#/links/L0' });
    assert.deepEqual(fresh, result);
  });

  it('applies description siblings only from OpenAPI 3.1 on, outermost first', () => {
    assert.equal(openApiRefSiblingsApply('3.0.3'), false);
    assert.equal(openApiRefSiblingsApply('2.0'), false);
    assert.equal(openApiRefSiblingsApply('3.1.0'), true);
    assert.equal(openApiRefSiblingsApply('3.2.0'), true);
    assert.equal(openApiRefSiblingsApply(null), false);

    const outer = { $ref: '#/components/parameters/Alias', description: 'outer' };
    const legacy = resolveOpenApiObject(spec, outer);
    assert.deepEqual(legacy, { ok: true, value: tenant, overrides: {} });
    const current = resolveOpenApiObject(spec, outer, { siblingsApply: true });
    assert.deepEqual(current, { ok: true, value: tenant, overrides: { description: 'outer' } });

    const plain = { $ref: '#/components/parameters/Alias' };
    const inner = resolveOpenApiObject(spec, plain, { siblingsApply: true });
    assert.deepEqual(inner, { ok: true, value: tenant, overrides: { description: 'alias' } });
  });

  it('never copies the target of a reference with sibling overrides', () => {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < 50_000; index += 1) properties[`p${index}`] = { type: 'string' };
    const wide = { description: 'component', content: { 'application/json': { properties } } };
    const document = { components: { responses: { Wide: wide } } };
    const resolver = createOpenApiRefResolver(document, { siblingsApply: true });
    for (let index = 0; index < 1_000; index += 1) {
      const result = resolver.resolve({
        $ref: '#/components/responses/Wide',
        description: `sibling ${index}`,
      });
      assert.ok(result.ok);
      assert.equal(result.value, wide);
      assert.deepEqual(result.overrides, { description: `sibling ${index}` });
    }
    assert.equal(wide.description, 'component');
  });

  it('follows each distinct reference once, however wide the fan-out or long the chain', () => {
    // A chain buried deep in the document, so every pointer is long, and a
    // parameter list that points at its head from every entry.
    const chainLength = 30;
    const segments = Array.from({ length: 150 }, (_, index) => `n${index}`);
    const chain: Record<string, unknown> = {};
    const base = `#/${segments.join('/')}`;
    for (let index = 0; index < chainLength; index += 1) {
      chain[`L${index}`] = { $ref: `${base}/L${index + 1}` };
    }
    chain[`L${chainLength}`] = { name: 'tenant_id', in: 'header' };
    let document: Record<string, unknown> = chain;
    for (const segment of [...segments].reverse()) document = { [segment]: document };

    const fanOut = 20_000;
    const parameters = Array.from({ length: fanOut }, (_, index) => ({
      $ref: `${base}/L${index % 3}`,
    }));
    const stats: OpenApiResolveStats = { pointerLookups: 0, pointerSegments: 0 };
    const resolver = createOpenApiRefResolver(document, { stats });
    const keyed = keyOpenApiParameters(resolver, parameters, false);

    assert.equal(keyed.length, fanOut);
    assert.ok(keyed.every((entry) => entry.key === 'header\u0000tenant_id'));
    // One lookup per distinct reference string in the chain — not per
    // parameter, and not per hop of each parameter's chain.
    assert.equal(stats.pointerLookups, chainLength + 1);
    assert.equal(stats.pointerSegments, (chainLength + 1) * (segments.length + 1));
  });
});

describe('OpenAPI parameter inheritance', () => {
  it('identifies a parameter by location and name, headers case-insensitively', () => {
    const resolver = createOpenApiRefResolver(spec);
    assert.equal(openApiParameterKey(resolver, { name: 'id', in: 'path' }), 'path\u0000id');

    const upper = openApiParameterKey(resolver, { name: 'X-Trace', in: 'header' });
    const lower = openApiParameterKey(resolver, { name: 'x-trace', in: 'header' });
    assert.equal(upper, lower);

    const queryUpper = openApiParameterKey(resolver, { name: 'Id', in: 'query' });
    const queryLower = openApiParameterKey(resolver, { name: 'id', in: 'query' });
    assert.notEqual(queryUpper, queryLower);

    const referenced = openApiParameterKey(resolver, { $ref: '#/components/parameters/Tenant' });
    assert.equal(referenced, 'header\u0000tenant_id');
    assert.equal(openApiParameterKey(resolver, { $ref: '#/components/parameters/Self' }), null);
    assert.equal(openApiParameterKey(resolver, { name: 'id' }), null);
    assert.equal(openApiParameterKey(resolver, 'not a parameter'), null);
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
    const resolver = createOpenApiRefResolver(spec);
    const shared = keyOpenApiParameters(resolver, pathParameters, true);
    const own = keyOpenApiParameters(resolver, operationParameters, false);
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
