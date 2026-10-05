import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PublishApiResponse, SpecEnforcementLevel } from '@ferrum-nexus/shared';

import { readRecoveryJournal } from '../publishing/recovery-storage.js';
import { createConversionRaceFixture } from './conversion-race-fixture.js';
import { buildTestApp, specWithServer, type TestApp } from './helpers.js';

for (const initial of ['routes', 'docs_only'] as const) {
  for (const rival of ['spec', 'runtime'] as const) {
    for (const conversionFirst of [true, false]) {
      test(
        `conversion from ${initial} vs ${rival}, conversion first: ${conversionFirst}`,
        { timeout: 20_000 },
        async (t) => {
          const one = await buildTestApp();
          const fixture = createConversionRaceFixture(t.signal);
          let two: TestApp | undefined;
          let restoreBarrier = () => {};
          try {
            two = await buildTestApp({ store: one.store, edge: one.edge });
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
            let intercepted = 0;
            const block = async () => {
              intercepted += 1;
              announce();
              await fixture.held;
            };
            if (conversionFirst) {
              const original = one.edgeClient.deployments.remove;
              const real = original.bind(one.edgeClient.deployments);
              restoreBarrier = () => {
                one.edgeClient.deployments.remove = original;
              };
              one.edgeClient.deployments.remove = async (...args) => {
                restoreBarrier();
                assert.equal(args[0], proxyId);
                assert.equal(args[1].profile, 'deployment-v1');
                assert.equal(args[1].namespace, 'nexus');
                assert.equal(args[2], provider.user.id);
                const journal = await readRecoveryJournal<{ mutations: { original: unknown }[] }>(
                  one.store,
                  one.app.nexus.crypto,
                  `gateway_recovery:nexus:${api.id}`,
                );
                assert.deepEqual(journal?.mutations[0]?.original, args[1]);
                await block();
                return real(...args);
              };
            } else if (rival === 'spec' && initial === 'routes') {
              const original = one.edgeClient.apiSpecs.replace;
              const real = original.bind(one.edgeClient.apiSpecs);
              restoreBarrier = () => {
                one.edgeClient.apiSpecs.replace = original;
              };
              one.edgeClient.apiSpecs.replace = async (...args) => {
                restoreBarrier();
                assert.equal(args[2], provider.user.id);
                await block();
                return real(...args);
              };
            } else {
              const original = one.edgeClient.proxies.replace;
              const real = original.bind(one.edgeClient.proxies);
              restoreBarrier = () => {
                one.edgeClient.proxies.replace = original;
              };
              one.edgeClient.proxies.replace = async (...args) => {
                restoreBarrier();
                assert.equal(args[0], proxyId);
                assert.equal(args[2], provider.user.id);
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
            const first = fixture.own(conversionFirst ? convert(one) : other(one));
            await fixture.waitFor(arrived, first, 'first gateway mutation');
            const second = fixture.own(conversionFirst ? other(two) : convert(two));
            await fixture.waitFor(contending, second, 'second proxy lease contention');
            fixture.release();
            const responses = await fixture.within(Promise.all([first, second]), 'race responses');
            assert.equal(intercepted, 1, 'the first request reached its actual gateway mutation');
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
            try {
              await fixture.cleanup(two, one);
            } finally {
              restoreBarrier();
            }
          }
        },
      );
    }
  }
}
