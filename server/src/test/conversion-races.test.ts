import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PublishApiResponse, SpecEnforcementLevel } from '@ferrum-nexus/shared';

import { buildTestApp, specWithServer, type TestApp } from './helpers.js';

for (const initial of ['routes', 'docs_only'] as const) {
  for (const rival of ['spec', 'runtime'] as const) {
    for (const conversionFirst of [true, false]) {
      test(
        `conversion from ${initial} vs ${rival}, conversion first: ${conversionFirst}`,
        { timeout: 20_000 },
        async () => {
          const one = await buildTestApp();
          const two = await buildTestApp({ store: one.store, edge: one.edge });
          let release = () => {};
          try {
            await one.registerUser({ email: 'founder@example.test' });
            const provider = await one.registerUser({
              email: 'provider@example.test',
              role: 'provider',
            });
            const published = await one.authed(provider, {
              method: 'POST',
              url: '/api/apis',
              payload: {
                name: 'Conversion race',
                slug: 'conversion-race',
                spec: specWithServer('https://v1.example.com:8443/v1'),
                auth_plugin: 'key_auth',
                requestable: true,
                visibility: 'public',
                spec_enforcement: initial,
              },
            });
            assert.equal(published.statusCode, 201, published.body);
            const api = published.json<PublishApiResponse>().api;
            const proxyId = String(api.ferrum_proxy_id);
            const target: SpecEnforcementLevel = initial === 'routes' ? 'docs_only' : 'routes';
            const convert = (app: TestApp) =>
              app.authed(provider, {
                method: 'PATCH',
                url: `/api/apis/${api.id}`,
                payload: { spec_enforcement: target },
              });
            const other = (app: TestApp) =>
              rival === 'spec'
                ? app.authed(provider, {
                    method: 'PUT',
                    url: `/api/apis/${api.id}/spec`,
                    payload: { spec: specWithServer('https://v2.example.com:8443/v2', '2.0.0') },
                  })
                : app.authed(provider, {
                    method: 'PATCH',
                    url: `/api/apis/${api.id}`,
                    payload: {
                      allowed_methods: ['GET'],
                      timeouts: { connect_ms: 1001, read_ms: 2002, write_ms: 3003 },
                    },
                  });

            let announce = () => {};
            const arrived = new Promise<void>((resolve) => {
              announce = resolve;
            });
            const held = new Promise<void>((resolve) => {
              release = resolve;
            });
            const block = async () => {
              announce();
              await held;
            };
            if (conversionFirst) {
              const real = one.edgeClient.proxies.delete.bind(one.edgeClient.proxies);
              one.edgeClient.proxies.delete = async (...args) => {
                one.edgeClient.proxies.delete = real;
                await block();
                return real(...args);
              };
            } else if (rival === 'spec' && initial === 'routes') {
              const real = one.edgeClient.apiSpecs.replace.bind(one.edgeClient.apiSpecs);
              one.edgeClient.apiSpecs.replace = async (...args) => {
                one.edgeClient.apiSpecs.replace = real;
                await block();
                return real(...args);
              };
            } else {
              const real = one.edgeClient.proxies.replace.bind(one.edgeClient.proxies);
              one.edgeClient.proxies.replace = async (...args) => {
                one.edgeClient.proxies.replace = real;
                await block();
                return real(...args);
              };
            }
            let waiting = () => {};
            const contending = new Promise<void>((resolve) => {
              waiting = resolve;
            });
            const serialize = two.edgeClient.serializePerKey.bind(two.edgeClient);
            two.edgeClient.serializePerKey = (key, fn) => {
              if (key === `proxy:${proxyId}`) waiting();
              return serialize(key, fn);
            };
            const first = conversionFirst ? convert(one) : other(one);
            await arrived;
            const second = conversionFirst ? other(two) : convert(two);
            await contending;
            release();
            const responses = await Promise.all([first, second]);
            for (const response of responses) assert.equal(response.statusCode, 200, response.body);

            const row = await one.store.apis.findById(api.id);
            const proxy = await one.edgeClient.proxies.get(proxyId);
            assert.ok(proxy);
            assert.equal(row?.spec_enforcement, target);
            if (rival === 'spec') {
              assert.equal(row?.upstream_url, 'https://v2.example.com:8443/v2');
              assert.equal(proxy.backend_host, 'v2.example.com');
              const current = await one.store.apiSpecs.findCurrentByApi(api.id);
              assert.ok(current?.raw_spec.includes('v2.example.com'));
            } else {
              assert.deepEqual(row?.allowed_methods, ['GET']);
              assert.deepEqual(proxy.allowed_methods, ['GET']);
              assert.deepEqual(row?.timeouts, { connect_ms: 1001, read_ms: 2002, write_ms: 3003 });
              assert.equal(proxy.backend_connect_timeout_ms, 1001);
              assert.equal(proxy.backend_read_timeout_ms, 2002);
              assert.equal(proxy.backend_write_timeout_ms, 3003);
            }
            const plugins = one.edge
              .effectivePluginsForProxy(proxyId)
              .map((plugin) => plugin.plugin_name);
            assert.ok(plugins.includes('key_auth'));
            assert.ok(plugins.includes('access_control'));
            assert.equal(plugins.includes('openapi_validator'), target === 'routes');
          } finally {
            release();
            await two.close();
            await one.close();
          }
        },
      );
    }
  }
}
