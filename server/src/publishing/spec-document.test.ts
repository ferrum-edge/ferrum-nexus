import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EdgePluginConfig, EdgeProxy } from '../ferrum-admin/types.js';
import { isNexusError } from '../lib/errors.js';
import {
  assertRoutesSubmittable,
  handOwnedPlugins,
  routesSpecDocument,
  submittableProxyBody,
  ROUTES_VALIDATE_EXTENSION,
} from './spec-document.js';

/** A minimal document with one path, as a provider would upload it. */
function document(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Billing API', version: '2.4.0' },
    servers: [{ url: 'https://billing.example.com:8443/v2' }],
    paths: { '/invoices': { get: { responses: { '200': { description: 'OK' } } } } },
    ...extra,
  };
}

/** Assert that `fn` throws `SPEC_INVALID`, returning the error for inspection. */
function expectSpecInvalid(fn: () => unknown): { message: string; details: unknown } {
  try {
    fn();
  } catch (error) {
    assert.ok(isNexusError(error), `expected a NexusError, got ${String(error)}`);
    assert.equal(error.code, 'SPEC_INVALID');
    assert.equal(error.statusCode, 400);
    return { message: error.message, details: error.details };
  }
  throw new assert.AssertionError({ message: 'expected the call to throw SPEC_INVALID' });
}

/** A plugin config as `GET /plugins/config` returns it. */
function config(overrides: Partial<EdgePluginConfig> = {}): EdgePluginConfig {
  return {
    id: 'cfg-1',
    namespace: 'nexus',
    plugin_name: 'key_auth',
    config: {},
    scope: 'proxy',
    proxy_id: 'proxy-1',
    enabled: true,
    ...overrides,
  };
}

describe('routesSpecDocument', () => {
  it('replaces servers with the listen path', () => {
    // The load-bearing rewrite: Edge builds each generated operation matcher
    // from the Paths key prefixed by this pathname, so a document left with its
    // upstream here generates `^/invoices$` and nothing arriving at
    // `/nexus/billing/invoices` can ever match it.
    const submitted = routesSpecDocument(document(), {
      listenPath: '/nexus/billing',
      proxy: { id: 'proxy-1' },
    });

    assert.deepEqual(submitted.servers, [{ url: '/nexus/billing' }]);
  });

  it('stamps the routes-only validate extension', () => {
    const submitted = routesSpecDocument(document(), {
      listenPath: '/nexus/billing',
      proxy: { id: 'proxy-1' },
    });

    assert.deepEqual(submitted['x-ferrum-validate'], {
      mode: 'block',
      request: { enabled: false },
      response: { enabled: false },
      fail_on_unknown_operation: true,
    });
  });

  it('hands the extension a copy, so one document cannot mutate the next', () => {
    const submitted = routesSpecDocument(document(), {
      listenPath: '/nexus/billing',
      proxy: { id: 'proxy-1' },
    });
    (submitted['x-ferrum-validate'] as Record<string, unknown>).fail_on_unknown_operation = false;

    assert.equal(ROUTES_VALIDATE_EXTENSION.fail_on_unknown_operation, true);
  });

  it('carries the proxy body through as x-ferrum-proxy', () => {
    const proxy = { id: 'proxy-1', listen_path: '/nexus/billing', backend_port: 8443 };

    const submitted = routesSpecDocument(document(), { listenPath: '/nexus/billing', proxy });

    assert.deepEqual(submitted['x-ferrum-proxy'], proxy);
  });

  it('strips every x-ferrum extension the provider wrote themselves', () => {
    // A document is input, not configuration. `x-ferrum-proxy` would repoint
    // the backend, `x-ferrum-upstream` would introduce a load-balancer group,
    // and `x-ferrum-consumers` is refused by Edge outright — which would fail
    // the upload for a reason no provider could act on.
    const submitted = routesSpecDocument(
      document({
        'x-ferrum-proxy': { id: 'attacker', backend_host: 'evil.example.com' },
        'x-ferrum-upstream': { name: 'attacker-pool' },
        'x-ferrum-consumers': [{ username: 'attacker' }],
        'x-ferrum-validate': { fail_on_unknown_operation: false },
        'x-ferrum-external-refs': true,
      }),
      { listenPath: '/nexus/billing', proxy: { id: 'proxy-1' } },
    );

    assert.equal(submitted['x-ferrum-upstream'], undefined);
    assert.equal(submitted['x-ferrum-consumers'], undefined);
    assert.equal(submitted['x-ferrum-external-refs'], undefined);
    assert.deepEqual(submitted['x-ferrum-proxy'], { id: 'proxy-1' });
    assert.equal(
      (submitted['x-ferrum-validate'] as Record<string, unknown>).fail_on_unknown_operation,
      true,
    );
  });

  it('leaves every other key of the provider document alone', () => {
    const source = document({
      components: { schemas: { Invoice: { type: 'object' } } },
      'x-internal-team': 'billing',
      tags: [{ name: 'invoices' }],
    });

    const submitted = routesSpecDocument(source, {
      listenPath: '/nexus/billing',
      proxy: { id: 'proxy-1' },
    });

    assert.deepEqual(submitted.paths, source.paths);
    assert.deepEqual(submitted.components, source.components);
    assert.deepEqual(submitted.tags, source.tags);
    // Only the `x-ferrum-` prefix is Edge's; other vendor extensions are not.
    assert.equal(submitted['x-internal-team'], 'billing');
    assert.equal(submitted.openapi, '3.1.0');
  });

  it('does not mutate the document it was given', () => {
    const source = document();

    routesSpecDocument(source, { listenPath: '/nexus/billing', proxy: { id: 'proxy-1' } });

    assert.deepEqual(source.servers, [{ url: 'https://billing.example.com:8443/v2' }]);
    assert.equal(source['x-ferrum-proxy'], undefined);
  });

  it('strips servers from path items and operations', () => {
    // OpenAPI resolves `servers` at three levels and the nearest wins, so a
    // path-level or operation-level entry survives the root rewrite and Edge
    // builds the matcher from it — `^/other/invoices$` for an API published at
    // `/nexus/billing`. With `fail_on_unknown_operation` that is a `400` on
    // every declared operation of an API the publish just reported as live.
    const submitted = routesSpecDocument(
      document({
        paths: {
          '/invoices': {
            servers: [{ url: '/other' }],
            get: { responses: { '200': { description: 'OK' } } },
            post: {
              servers: [{ url: 'https://writes.example.com/v9' }],
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      }),
      { listenPath: '/nexus/billing', proxy: { id: 'proxy-1' } },
    );

    const paths = submitted.paths as Record<string, Record<string, unknown>>;
    const item = paths['/invoices'] as Record<string, unknown>;
    assert.deepEqual(submitted.servers, [{ url: '/nexus/billing' }]);
    assert.equal('servers' in item, false);
    assert.equal('servers' in (item.post as Record<string, unknown>), false);
    // Everything else about the operations is the provider's, untouched.
    assert.deepEqual(item.get, { responses: { '200': { description: 'OK' } } });
    assert.deepEqual(item.post, { responses: { '201': { description: 'Created' } } });
  });

  it('strips servers from a $ref-able component path item', () => {
    // A path template that is a `$ref` to one of these produces exactly the
    // same operation-table entry, so it has exactly the same exposure.
    const submitted = routesSpecDocument(
      document({
        paths: { '/invoices': { $ref: '#/components/pathItems/Invoices' } },
        components: {
          schemas: { Invoice: { type: 'object' } },
          pathItems: {
            Invoices: {
              servers: [{ url: '/other' }],
              get: {
                servers: [{ url: '/elsewhere' }],
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        },
      }),
      { listenPath: '/nexus/billing', proxy: { id: 'proxy-1' } },
    );

    const components = submitted.components as Record<string, Record<string, unknown>>;
    const item = components.pathItems?.Invoices as Record<string, unknown>;
    assert.equal('servers' in item, false);
    assert.equal('servers' in (item.get as Record<string, unknown>), false);
    // The rest of `components` rides through on the same object.
    assert.deepEqual(components.schemas, { Invoice: { type: 'object' } });
  });

  it('leaves callbacks and non-path-item keys alone', () => {
    // A callback describes a request the provider's own service makes to the
    // client's URL. This proxy never serves it and Edge builds no listen-path
    // matcher from it, so its `servers` is genuinely the provider's.
    const callbacks = {
      onPaid: {
        '{$request.body#/callbackUrl}': {
          servers: [{ url: 'https://client.example.com' }],
          post: { responses: { '200': { description: 'OK' } } },
        },
      },
    };
    const source = document({
      paths: {
        '/invoices': { get: { callbacks, responses: { '200': { description: 'OK' } } } },
        'x-path-notes': { servers: [{ url: '/not-a-path-item' }] },
      },
    });

    const submitted = routesSpecDocument(source, {
      listenPath: '/nexus/billing',
      proxy: { id: 'proxy-1' },
    });

    assert.deepEqual(submitted.paths, source.paths);
  });

  it('hands an untouched document through by identity', () => {
    // The strip only copies nodes that carried a `servers` key, so a document
    // with none is submitted exactly as it was uploaded — the property the old
    // shallow copy relied on, kept.
    const source = document({ components: { schemas: { Invoice: { type: 'object' } } } });

    const submitted = routesSpecDocument(source, {
      listenPath: '/nexus/billing',
      proxy: { id: 'proxy-1' },
    });

    assert.equal(submitted.paths, source.paths);
    assert.equal(submitted.components, source.components);
  });

  it('does not mutate a document that carries nested servers', () => {
    const source = document({
      paths: {
        '/invoices': {
          servers: [{ url: '/other' }],
          get: { servers: [{ url: '/elsewhere' }], responses: { '200': { description: 'OK' } } },
        },
      },
    });

    routesSpecDocument(source, { listenPath: '/nexus/billing', proxy: { id: 'proxy-1' } });

    const item = (source.paths as Record<string, Record<string, unknown>>)['/invoices'];
    assert.deepEqual(item?.servers, [{ url: '/other' }]);
    assert.deepEqual((item?.get as Record<string, unknown>).servers, [{ url: '/elsewhere' }]);
  });

  it('strips servers from a $ref-able webhook path item', () => {
    // Edge indexes `webhooks` as a resolution target, so a path that is a
    // `$ref` to one produces an ordinary operation-table entry — built from
    // that webhook's `servers`. `^/other/invoices$` for an API published at
    // `/nexus/billing`, and a `400` on the only operation it declares.
    const submitted = routesSpecDocument(
      document({
        paths: { '/invoices': { $ref: '#/webhooks/Invoices' } },
        webhooks: {
          Invoices: {
            servers: [{ url: '/other' }],
            post: {
              servers: [{ url: '/elsewhere' }],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      }),
      { listenPath: '/nexus/billing', proxy: { id: 'proxy-1' } },
    );

    const webhooks = submitted.webhooks as Record<string, Record<string, unknown>>;
    const item = webhooks.Invoices as Record<string, unknown>;
    assert.deepEqual(submitted.servers, [{ url: '/nexus/billing' }]);
    assert.equal('servers' in item, false);
    assert.equal('servers' in (item.post as Record<string, unknown>), false);
  });

  it('strips servers from a component callback path item', () => {
    // The `callbacks` of an operation are left alone — see the module docblock
    // — but a `components.callbacks` entry is a named container of Path Items
    // addressable by pointer, so it is stripped like `components.pathItems`.
    const submitted = routesSpecDocument(
      document({
        components: {
          schemas: { Invoice: { type: 'object' } },
          callbacks: {
            onPaid: {
              '{$request.body#/callbackUrl}': {
                servers: [{ url: '/other' }],
                post: { responses: { '200': { description: 'OK' } } },
              },
            },
          },
        },
      }),
      { listenPath: '/nexus/billing', proxy: { id: 'proxy-1' } },
    );

    const components = submitted.components as Record<string, Record<string, unknown>>;
    const callback = components.callbacks?.onPaid as Record<string, Record<string, unknown>>;
    assert.equal('servers' in (callback['{$request.body#/callbackUrl}'] ?? {}), false);
    // The rest of `components` rides through on the same object.
    assert.deepEqual(components.schemas, { Invoice: { type: 'object' } });
  });

  it('refuses a path that references a Path Item it cannot rewrite', () => {
    // The general case the strip walk cannot cover: Edge resolves a Path Item
    // `$ref` as an unrestricted same-document pointer, so a pointer into any
    // other container would put a server base back that no walk over the three
    // Path Item containers has been over. Chasing an arbitrary pointer means
    // re-implementing Edge's resolver; refusing is the honest alternative.
    const failure = expectSpecInvalid(() =>
      routesSpecDocument(
        document({
          paths: { '/invoices': { $ref: '#/components/callbacks/onPaid/expression' } },
        }),
        { listenPath: '/nexus/billing', proxy: { id: 'proxy-1' } },
      ),
    );

    assert.match(failure.message, /The path '\/invoices' is a \$ref/);
    assert.deepEqual(failure.details, {
      field: 'spec',
      path: '/invoices',
      reason: 'unresolvable_path_item_ref',
    });
  });
});

describe('assertRoutesSubmittable', () => {
  it('accepts the three containers the strip walk covers', () => {
    for (const reference of [
      '#/paths/~1payments',
      '#/components/pathItems/Invoices',
      '#/webhooks/Invoices',
    ]) {
      assertRoutesSubmittable('routes', document({ paths: { '/invoices': { $ref: reference } } }));
    }
  });

  it('refuses a reference to another document', () => {
    // An external reference is refused for the same reason and one more: the
    // portal never sees the document it points at, so there is nothing it could
    // rewrite even in principle.
    const failure = expectSpecInvalid(() =>
      assertRoutesSubmittable(
        'routes',
        document({ paths: { '/invoices': { $ref: 'shared.yaml#/components/pathItems/X' } } }),
      ),
    );

    assert.match(failure.message, /is a \$ref the gateway would resolve outside/);
  });

  it('leaves a docs_only document alone', () => {
    // Edge generates no operation matchers from a `docs_only` document, so
    // there is nothing a reference could make unreachable.
    assertRoutesSubmittable(
      'docs_only',
      document({ paths: { '/invoices': { $ref: 'shared.yaml#/components/pathItems/X' } } }),
    );
  });

  it('ignores specification extensions among the path templates', () => {
    // A Paths Object mixes path templates with `^x-` extensions, and only the
    // templates are Path Items — an extension holding a `$ref` is data.
    assertRoutesSubmittable(
      'routes',
      document({ paths: { 'x-path-notes': { $ref: 'notes.yaml#/anything' } } }),
    );
  });
});

describe('submittableProxyBody', () => {
  /** A proxy document as `GET /proxies/{id}` returns it. */
  const proxy = {
    id: 'proxy-1',
    namespace: 'nexus',
    name: 'nexus-billing',
    listen_path: '/nexus/billing',
    backend_host: 'billing.example.com',
    backend_port: 8443,
    hosts: ['api.example.com'],
    upstream_id: 'pool-7',
    api_spec_id: 'spec-1',
    plugins: [{ plugin_config_id: 'cfg-1' }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  } as unknown as EdgeProxy;

  it('drops the fields Edge owns', () => {
    const body = submittableProxyBody(proxy);

    // `namespace` comes from the header and the timestamps from the server;
    // `api_spec_id` is a copied ownership tag, which Edge answers with a 422;
    // `plugins` is rebuilt by the importer, so a stale list could only fight it.
    assert.equal('namespace' in body, false);
    assert.equal('created_at' in body, false);
    assert.equal('updated_at' in body, false);
    assert.equal('api_spec_id' in body, false);
    assert.equal('plugins' in body, false);
  });

  it('keeps every field an operator may have set', () => {
    // A replace re-inserts the proxy rather than merging, so anything missing
    // from the body reverts to its serde default.
    const body = submittableProxyBody(proxy);

    assert.equal(body.id, 'proxy-1');
    assert.equal(body.name, 'nexus-billing');
    assert.equal(body.listen_path, '/nexus/billing');
    assert.deepEqual(body.hosts, ['api.example.com']);
    assert.equal(body.upstream_id, 'pool-7');
  });

  it('does not mutate the proxy it was given', () => {
    submittableProxyBody(proxy);

    assert.equal(proxy.namespace, 'nexus');
    assert.deepEqual(proxy.plugins, [{ plugin_config_id: 'cfg-1' }]);
  });
});

describe('handOwnedPlugins', () => {
  it('keeps the configs Nexus and operators own', () => {
    const kept = [config({ id: 'a' }), config({ id: 'b', plugin_name: 'rate_limiting' })];

    assert.deepEqual(handOwnedPlugins(kept), kept);
  });

  it('drops anything the spec importer generated', () => {
    const generated = config({ id: 'gen', plugin_name: 'cors', api_spec_id: 'spec-1' });

    assert.deepEqual(handOwnedPlugins([config(), generated]), [config()]);
  });

  it('drops an openapi_validator whatever its ownership tag says', () => {
    // In `routes` mode the new spec brings its own, and in `docs_only` mode
    // there must not be one at all — which is the point of the conversion.
    const orphan = config({ id: 'v', plugin_name: 'openapi_validator', api_spec_id: null });

    assert.deepEqual(handOwnedPlugins([config(), orphan]), [config()]);
  });
});
