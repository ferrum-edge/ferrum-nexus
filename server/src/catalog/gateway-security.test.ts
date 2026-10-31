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
    // Edge's jwt_auth requires `exp` by default (`require_exp`), and the
    // consumer is matched on `sub`.
    assert.match(String(gatewaySecurityScheme('jwt_auth').description), /sub claim .* exp claim/);
    assert.match(String(gatewaySecurityScheme('basic_auth').description), /not the portal email/);
  });
});

/** The `security` of one operation of a stamped document. */
function opSecurity(document: Doc, path = '/orders', method = 'get'): unknown {
  return ((document.paths as Record<string, Doc>)[path]![method] as Doc).security;
}

describe('stampGatewaySecurity', () => {
  for (const plugin of PLUGINS) {
    it(`requires the ${plugin} credential on a document that declares no security`, () => {
      const document = base();
      const stamped = stamp(document, plugin);
      assert.deepEqual(stamped, {
        ...document,
        components: { securitySchemes: { [GW]: gatewaySecurityScheme(plugin) } },
        paths: {
          '/orders': {
            get: { responses: { '200': { description: 'OK' } }, security: [{ [GW]: [] }] },
          },
        },
      });
      assert.ok(!('security' in stamped), 'the root security is left as uploaded');
    });
  }

  it('reads `[]`, `[{}]` and invalid values as "nothing required"', () => {
    for (const security of [[], [{}], 'none', [null, 'x']]) {
      const stamped = stamp(base({ security }), 'key_auth');
      assert.deepEqual(opSecurity(stamped), [{ [GW]: [] }], JSON.stringify(security));
      assert.deepEqual(stamped.security, security);
    }
    const optional = stamp(base({ security: [{}, { partner: [] }] }), 'key_auth');
    assert.deepEqual(opSecurity(optional), [{ [GW]: [] }, { partner: [], [GW]: [] }]);
  });

  it('adds the gateway scheme to every alternative of the root default', () => {
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
    assert.deepEqual(opSecurity(stamped), [
      { oauth: ['orders:read'], [GW]: [] },
      { partner: [], [GW]: [] },
    ]);
    assert.equal(stamped.security, document.security);
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
    assert.deepEqual(
      opSecurity(stamp(document, 'key_auth')),
      every
        .map((alternative) => ('apiKey' in alternative ? {} : alternative))
        .map((a) => ({ ...a, [GW]: [] })),
    );

    // basic_auth and jwt_auth read Authorization: every Authorization-borne
    // scheme collides, and the alternatives that leaves identical are merged.
    for (const plugin of ['basic_auth', 'jwt_auth'] as const) {
      const stamped = stamp(document, plugin);
      assert.deepEqual(opSecurity(stamped), [
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
    assert.deepEqual(opSecurity(combined), [{ partner: [], [GW]: [] }]);
  });

  it('resolves scheme references as a client would to decide whether they collide', () => {
    const document = base({
      components: {
        securitySchemes: {
          alias: { $ref: '#/components/securitySchemes/key' },
          encoded: { $ref: '#/components/securitySchemes/%6Bey' },
          key: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          dangling: { $ref: '#/components/securitySchemes/missing' },
          loop: { $ref: '#/components/securitySchemes/loop' },
          external: { $ref: 'common.yaml#/components/securitySchemes/key' },
        },
      },
      security: [{ alias: [], encoded: [], dangling: [], loop: [], external: [] }],
    });
    // A scheme that cannot be resolved is kept: dropping it could drop a
    // credential the upstream needs.
    assert.deepEqual(opSecurity(stamp(document, 'key_auth')), [
      { dangling: [], loop: [], external: [], [GW]: [] },
    ]);
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
    assert.deepEqual(opSecurity(stamped), [{ [GW]: [], [`${GW}_3`]: [] }]);
  });

  it('stamps every operation the gateway serves, and nothing it does not', () => {
    const callback = {
      '{$request.body#/url}': { post: { responses: {} } },
    };
    const document = base({
      security: [{ partner: [] }],
      paths: {
        '/public': { get: { security: [], responses: {} }, post: { responses: {} } },
        '/partner': { put: { callbacks: { done: callback } } },
        '/reusable': { $ref: '#/components/pathItems/Reusable' },
        '/hook': { $ref: '#/webhooks/linked' },
        '/alias': { $ref: '#/paths/~1public' },
        'x-note': { get: { security: [] } },
      },
      components: {
        securitySchemes: { partner: { type: 'apiKey', in: 'header', name: 'X-Partner' } },
        pathItems: {
          Reusable: { delete: { security: [{}] }, summary: 'kept' },
          Unreferenced: { delete: {} },
        },
        callbacks: { shared: callback },
      },
      webhooks: {
        linked: { patch: { security: [] } },
        event: { post: {} },
      },
    });
    const stamped = stamp(document, 'key_auth');
    const paths = stamped.paths as Record<string, Doc>;
    const gatewayOnly = [{ [GW]: [] }];
    const partnerAndGateway = [{ partner: [], [GW]: [] }];
    assert.deepEqual(paths['/public'], {
      get: { security: gatewayOnly, responses: {} },
      post: { responses: {}, security: partnerAndGateway },
    });
    assert.deepEqual((paths['/partner']!.put as Doc).security, partnerAndGateway);
    assert.equal(
      (paths['/partner']!.put as Doc).callbacks,
      ((document.paths as Record<string, Doc>)['/partner']!.put as Doc).callbacks,
      'callbacks are requests the provider makes, not ones the gateway serves',
    );
    assert.deepEqual(paths['/alias'], { $ref: '#/paths/~1public' });
    assert.deepEqual(paths['x-note'], { get: { security: [] } }, 'extensions are data');

    const components = stamped.components as Doc;
    const pathItems = components.pathItems as Record<string, Doc>;
    assert.deepEqual(pathItems.Reusable, { delete: { security: gatewayOnly }, summary: 'kept' });
    assert.equal(
      pathItems.Unreferenced,
      (document.components as Doc & { pathItems: Doc }).pathItems.Unreferenced,
    );
    assert.equal(components.callbacks, (document.components as Doc).callbacks);
    const webhooks = stamped.webhooks as Record<string, Doc>;
    assert.deepEqual(webhooks.linked, { patch: { security: gatewayOnly } });
    assert.equal(webhooks.event, (document.webhooks as Doc).event);
    // Webhooks and callbacks keep inheriting the provider's root security.
    assert.equal(stamped.security, document.security);
  });

  it('follows chains of Path Item references, bounded and cycle-safe', () => {
    const document = base({
      paths: {
        '/orders': { $ref: '#/components/pathItems/Alias' },
        '/loop': { $ref: '#/components/pathItems/A' },
      },
      components: {
        pathItems: {
          Alias: { $ref: '#/webhooks/Orders' },
          A: { $ref: '#/components/pathItems/B' },
          B: { $ref: '#/components/pathItems/A' },
        },
      },
      webhooks: { Orders: { get: { security: [] } } },
    });
    const stamped = stamp(document, 'jwt_auth');
    assert.deepEqual((stamped.webhooks as Doc).Orders, { get: { security: [{ [GW]: [] }] } });
  });

  it('follows reference chains of any length and Path Items kept under a `paths` extension', () => {
    const chain = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `A${i}`,
        i === 19 ? { get: { security: [] } } : { $ref: `#/components/pathItems/A${i + 1}` },
      ]),
    );
    const document = base({
      paths: {
        '/orders': { $ref: '#/components/pathItems/A0' },
        '/template': { $ref: '#/paths/x-template' },
        'x-template': { get: {} },
        'x-unused': { get: {} },
      },
      components: { pathItems: chain },
    });
    const stamped = stamp(document, 'key_auth');
    const pathItems = (stamped.components as Doc).pathItems as Record<string, Doc>;
    assert.deepEqual(pathItems.A19, { get: { security: [{ [GW]: [] }] } });
    const paths = stamped.paths as Record<string, Doc>;
    assert.deepEqual(paths['x-template'], { get: { security: [{ [GW]: [] }] } });
    assert.equal(paths['x-unused'], (document.paths as Doc)['x-unused']);
  });

  it('reads `%2F` in a reference as a separator too, as RFC 6901 decodes it first', () => {
    const document = base({
      paths: { '/orders': { $ref: '#/components%2FpathItems/Orders' } },
      components: {
        pathItems: { Orders: { get: { security: [{ alias: [] }] } } },
        securitySchemes: {
          alias: { $ref: '#/components%2FsecuritySchemes/key' },
          key: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
    });
    const pathItems = (stamp(document, 'key_auth').components as Doc).pathItems as Doc;
    assert.deepEqual(pathItems.Orders, { get: { security: [{ [GW]: [] }] } });
  });

  it('leaves the document unchanged when repeating the root security would outgrow the limit', () => {
    const paths = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`/p${i}`, { get: { responses: {} } }]),
    );
    const document = base({
      paths,
      security: [{ oauth: ['x'.repeat(64 * 1024)] }],
      components: { securitySchemes: { oauth: { type: 'oauth2', flows: {} } } },
    });
    assert.equal(stamp(document, 'key_auth'), document);

    const small = base({ paths, security: [{ oauth: ['orders:read'] }] });
    const stamped = stamp(small, 'key_auth');
    assert.notEqual(stamped, small);
    assert.equal(
      opSecurity(stamped, '/p0'),
      opSecurity(stamped, '/p99'),
      'one shared inherited requirement',
    );
  });

  it('computes the inherited requirement once and stops early when it fans out', () => {
    const paths = Object.fromEntries(
      Array.from({ length: 3_000 }, (_, i) => [`/p${i}`, { get: { responses: {} } }]),
    );
    const security = Array.from({ length: 10_000 }, (_, i) => ({ [`s${i}`]: [] }));
    const document = base({ paths, security });
    const started = performance.now();
    assert.equal(stamp(document, 'key_auth'), document);
    assert.ok(performance.now() - started < 5_000, 'bounded by the document, not its fan-out');
  });

  it('decodes percent-encoding and JSON Pointer escapes in path item references', () => {
    const document = base({
      paths: {
        '/a': { $ref: '#/components/pathItems/a~1b~0c' },
        '/b': { $ref: '#/components/pathItems/%4F%72ders' },
        '/c': { $ref: '#/components/pathItems/%E0%A4%A' },
      },
      components: {
        pathItems: {
          'a/b~c': { get: { security: [] } },
          Orders: { get: { security: [] } },
          '%E0%A4%A': { get: { security: [] } },
        },
      },
    });
    const pathItems = (stamp(document, 'jwt_auth').components as Doc).pathItems as Doc;
    assert.deepEqual(pathItems['a/b~c'], { get: { security: [{ [GW]: [] }] } });
    assert.deepEqual(pathItems.Orders, { get: { security: [{ [GW]: [] }] } });
    assert.deepEqual(pathItems['%E0%A4%A'], { get: { security: [] } }, 'malformed escape');

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
    const requirement = opSecurity(stamped, '/a') as Doc[];
    assert.ok(Object.hasOwn(requirement[0]!, '__proto__'));
    assert.equal(Object.getPrototypeOf(requirement[0]), Object.prototype);
    assert.ok(Object.hasOwn(schemes(stamped), '__proto__'));
    assert.ok(Object.hasOwn(schemes(stamped), GW));
  });

  it('replaces a `components` or `securitySchemes` that is not an object', () => {
    for (const components of ['text', [], null]) {
      const stamped = stamp(base({ components }), 'key_auth');
      assert.deepEqual(stamped.components, {
        securitySchemes: { [GW]: gatewaySecurityScheme('key_auth') },
      });
      assert.deepEqual(opSecurity(stamped), [{ [GW]: [] }]);
    }
    for (const securitySchemes of ['text', [], null]) {
      const stamped = stamp(base({ components: { securitySchemes, schemas: {} } }), 'key_auth');
      assert.deepEqual(stamped.components, {
        securitySchemes: { [GW]: gatewaySecurityScheme('key_auth') },
        schemas: {},
      });
    }
  });
});
