import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AuthPluginType } from '@ferrum-nexus/shared';

import {
  GATEWAY_SECURITY_SCHEME_NAME as GW,
  gatewaySecurityScheme,
  stampGatewaySecurity,
} from './gateway-security.js';

type Doc = Record<string, unknown>;

const PLUGINS: AuthPluginType[] = ['key_auth', 'basic_auth', 'jwt_auth'];

function base(extra: Doc = {}): Doc {
  return {
    openapi: '3.1.0',
    info: { title: 'Orders', version: '1.0.0' },
    servers: [{ url: 'https://gateway.example.test/nexus/orders' }],
    paths: { '/orders': { get: { responses: { '200': { description: 'OK' } } } } },
    ...extra,
  };
}

/** Stamp a deep copy and check the input was left exactly as it was. */
function stamp(document: Doc, plugin: AuthPluginType): Doc {
  const before = structuredClone(document);
  const stamped = stampGatewaySecurity(document, plugin);
  assert.deepEqual(document, before, 'the input document is not modified');
  return stamped;
}

function schemes(document: Doc): Record<string, unknown> {
  return (document.components as Doc).securitySchemes as Record<string, unknown>;
}

describe('gatewaySecurityScheme', () => {
  it('describes the header each auth plugin reads with the config Nexus sends', () => {
    assert.deepEqual(
      { ...gatewaySecurityScheme('key_auth'), description: undefined },
      { type: 'apiKey', in: 'header', name: 'X-API-Key', description: undefined },
    );
    assert.deepEqual(
      { ...gatewaySecurityScheme('basic_auth'), description: undefined },
      { type: 'http', scheme: 'basic', description: undefined },
    );
    assert.deepEqual(
      { ...gatewaySecurityScheme('jwt_auth'), description: undefined },
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: undefined },
    );
    for (const plugin of PLUGINS) {
      const description = String(gatewaySecurityScheme(plugin).description);
      assert.match(description, /^Ferrum Edge gateway credential: /);
      assert.doesNotMatch(description, /[0-9a-f]{8}-[0-9a-f]{4}/, 'no consumer or key is named');
    }
  });
});

describe('stampGatewaySecurity', () => {
  for (const plugin of PLUGINS) {
    it(`requires the ${plugin} credential on a document that declares no security`, () => {
      const document = base();
      const stamped = stamp(document, plugin);
      assert.deepEqual(stamped, {
        ...document,
        components: { securitySchemes: { [GW]: gatewaySecurityScheme(plugin) } },
        security: [{ [GW]: [] }],
      });
      assert.equal(
        (stamped.paths as Doc)['/orders'],
        (document.paths as Doc)['/orders'],
        'path items without an overriding operation are shared',
      );
    });
  }

  it('reads `[]`, `[{}]` and invalid values as "nothing required"', () => {
    for (const security of [[], [{}], 'none', [null, 'x']]) {
      const stamped = stamp(base({ security }), 'key_auth');
      assert.deepEqual(stamped.security, [{ [GW]: [] }], JSON.stringify(security));
    }
    const optional = stamp(base({ security: [{}, { partner: [] }] }), 'key_auth');
    assert.deepEqual(optional.security, [{ [GW]: [] }, { partner: [], [GW]: [] }]);
  });

  it('adds the gateway scheme to every alternative and keeps the rest of components', () => {
    const document = base({
      components: {
        schemas: { Order: { type: 'object' } },
        securitySchemes: {
          oauth: { type: 'oauth2', flows: {} },
          partner: { type: 'apiKey', in: 'header', name: 'X-Partner' },
        },
      },
      security: [{ oauth: ['orders:read'] }, { partner: [] }],
    });
    const stamped = stamp(document, 'key_auth');
    assert.deepEqual(stamped.security, [
      { oauth: ['orders:read'], [GW]: [] },
      { partner: [], [GW]: [] },
    ]);
    const components = stamped.components as Doc;
    assert.equal(components.schemas, (document.components as Doc).schemas);
    assert.deepEqual(Object.keys(schemes(stamped)), ['oauth', 'partner', GW]);
  });

  it('drops provider schemes sent in the header the gateway reads', () => {
    const securitySchemes = {
      bearer: { type: 'http', scheme: 'bearer' },
      basic: { type: 'http', scheme: 'basic' },
      oauth: { type: 'oauth2', flows: {} },
      oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://id.example.test' },
      rawAuthorization: { type: 'apiKey', in: 'header', name: 'authorization' },
      apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      queryKey: { type: 'apiKey', in: 'query', name: 'X-API-Key' },
      cookie: { type: 'apiKey', in: 'cookie', name: 'session' },
      partner: { type: 'apiKey', in: 'header', name: 'X-Partner' },
      tls: { type: 'mutualTLS' },
    };
    const every = Object.keys(securitySchemes).map((name) => ({ [name]: [] }));
    const document = base({ components: { securitySchemes }, security: every });

    // key_auth reads X-API-Key: only the header-borne `apiKey` collides.
    const keyAuth = stamp(document, 'key_auth');
    assert.deepEqual(
      keyAuth.security,
      every
        .map((alternative) => ('apiKey' in alternative ? {} : alternative))
        .map((a) => ({
          ...a,
          [GW]: [],
        })),
    );

    // basic_auth and jwt_auth read Authorization: every Authorization-borne
    // scheme collides, and the alternatives that leaves identical are merged.
    for (const plugin of ['basic_auth', 'jwt_auth'] as const) {
      const stamped = stamp(document, plugin);
      assert.deepEqual(stamped.security, [
        { [GW]: [] },
        { apiKey: [], [GW]: [] },
        { queryKey: [], [GW]: [] },
        { cookie: [], [GW]: [] },
        { partner: [], [GW]: [] },
        { tls: [], [GW]: [] },
      ]);
      // The provider's definitions are documentation and stay.
      assert.deepEqual(Object.keys(schemes(stamped)), [...Object.keys(securitySchemes), GW]);
    }

    const combined = stamp(
      base({ components: { securitySchemes }, security: [{ bearer: [], partner: [] }] }),
      'jwt_auth',
    );
    assert.deepEqual(combined.security, [{ partner: [], [GW]: [] }]);
  });

  it('follows a scheme reference to decide whether it collides', () => {
    const document = base({
      components: {
        securitySchemes: {
          alias: { $ref: '#/components/securitySchemes/key' },
          key: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          dangling: { $ref: '#/components/securitySchemes/missing' },
          loop: { $ref: '#/components/securitySchemes/loop' },
        },
      },
      security: [{ alias: [], dangling: [], loop: [] }],
    });
    assert.deepEqual(stamp(document, 'key_auth').security, [{ dangling: [], loop: [], [GW]: [] }]);
  });

  it('picks a free scheme name when the provider already uses the default one', () => {
    const own = { type: 'apiKey', in: 'query', name: 'gateway' };
    const document = base({
      components: { securitySchemes: { [GW]: own, [`${GW}_2`]: own } },
      security: [{ [GW]: [] }],
    });
    const stamped = stamp(document, 'basic_auth');
    assert.equal(schemes(stamped)[GW], own);
    assert.deepEqual(schemes(stamped)[`${GW}_3`], gatewaySecurityScheme('basic_auth'));
    assert.deepEqual(stamped.security, [{ [GW]: [], [`${GW}_3`]: [] }]);
  });

  it('rewrites operations that override security, and nothing that does not', () => {
    const callback = {
      '{$request.body#/url}': { post: { security: [], responses: {} } },
    };
    const untouched = { get: { responses: {} } };
    const document = base({
      paths: {
        '/public': { get: { security: [], responses: {} }, post: { responses: {} } },
        '/partner': { put: { security: [{ partner: [] }], callbacks: { done: callback } } },
        '/plain': untouched,
        '/reusable': { $ref: '#/components/pathItems/Reusable' },
        '/hook': { $ref: '#/webhooks/linked' },
        'x-note': { get: { security: [] } },
      },
      components: {
        securitySchemes: { partner: { type: 'apiKey', in: 'header', name: 'X-Partner' } },
        pathItems: {
          Reusable: { delete: { security: [{}] } },
          Unreferenced: { delete: { security: [] } },
        },
      },
      webhooks: {
        linked: { patch: { security: [] } },
        event: { post: { security: [] } },
      },
    });
    const stamped = stamp(document, 'key_auth');
    const paths = stamped.paths as Record<string, Doc>;
    const gatewayOnly = [{ [GW]: [] }];
    assert.deepEqual(paths['/public'], {
      get: { security: gatewayOnly, responses: {} },
      post: { responses: {} },
    });
    assert.deepEqual((paths['/partner']!.put as Doc).security, [{ partner: [], [GW]: [] }]);
    assert.equal(
      (paths['/partner']!.put as Doc).callbacks,
      ((document.paths as Record<string, Doc>)['/partner']!.put as Doc).callbacks,
      'callbacks are requests the provider makes, not ones the gateway serves',
    );
    assert.equal(paths['/plain'], untouched);
    assert.deepEqual(paths['x-note'], { get: { security: [] } }, 'extensions are data');

    const pathItems = (stamped.components as Doc).pathItems as Record<string, Doc>;
    assert.deepEqual(pathItems.Reusable, { delete: { security: gatewayOnly } });
    assert.deepEqual(pathItems.Unreferenced, { delete: { security: [] } });
    const webhooks = stamped.webhooks as Record<string, Doc>;
    assert.deepEqual(webhooks.linked, { patch: { security: gatewayOnly } });
    assert.deepEqual(webhooks.event, { post: { security: [] } });
  });

  it('decodes JSON Pointer escapes in path item references', () => {
    const document = base({
      paths: { '/a': { $ref: '#/components/pathItems/a~1b~0c' } },
      components: { pathItems: { 'a/b~c': { get: { security: [] } } } },
    });
    const stamped = stamp(document, 'jwt_auth');
    assert.deepEqual(((stamped.components as Doc).pathItems as Doc)['a/b~c'], {
      get: { security: [{ [GW]: [] }] },
    });

    const nested = base({
      paths: { '/a': { $ref: '#/components/pathItems/a/b' } },
      components: { pathItems: { 'a/b': { get: { security: [] } } } },
    });
    assert.deepEqual(
      ((stamp(nested, 'jwt_auth').components as Doc).pathItems as Doc)['a/b'],
      { get: { security: [] } },
      'an unescaped `/` names a member of entry `a`, not entry `a/b`',
    );
  });

  it('keeps `__proto__` keys as data', () => {
    const document = JSON.parse(
      '{"openapi":"3.1.0","info":{"title":"t","version":"1"},' +
        '"paths":{"__proto__":{"get":{}},"/a":{"get":{"security":[{"__proto__":[]}]}}},' +
        '"components":{"securitySchemes":{"__proto__":{"type":"apiKey","in":"query","name":"k"}},' +
        '"pathItems":{"__proto__":{"get":{}}}}}',
    ) as Doc;
    const stamped = stamp(document, 'key_auth');
    const paths = stamped.paths as Doc;
    assert.ok(Object.hasOwn(paths, '__proto__'));
    assert.equal(Object.getPrototypeOf(paths), Object.prototype);
    const requirement = ((paths['/a'] as Doc).get as Doc).security as Doc[];
    assert.ok(Object.hasOwn(requirement[0]!, '__proto__'));
    assert.equal(Object.getPrototypeOf(requirement[0]), Object.prototype);
    assert.ok(Object.hasOwn(schemes(stamped), '__proto__'));
    assert.ok(Object.hasOwn(schemes(stamped), GW));
  });

  it('leaves a document with nowhere to define the scheme as uploaded', () => {
    for (const components of ['text', [], null]) {
      const document = base({ components });
      assert.equal(stamp(document, 'key_auth'), document);
    }
    for (const securitySchemes of ['text', [], null]) {
      const document = base({ components: { securitySchemes } });
      assert.equal(stamp(document, 'key_auth'), document);
    }
  });
});
