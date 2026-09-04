import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EdgePluginConfig, EdgeProxy } from '../ferrum-admin/types.js';
import {
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
