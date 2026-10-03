import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { NexusStore } from '../db/store.js';
import { SSO_SETTINGS_LOCK_KEY } from '../lib/keyed-serializer.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** The real SSO settings route must take its deployment-wide lock on every adapter. */
export function runSsoSettingsLockContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`SSO settings lock contract — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let harness: TestApp;
    let founder: TestSession;
    const acquired: string[] = [];

    before(async () => {
      target = await makeStore();
      harness = await buildTestApp({
        store: target.store,
        env: { NEXUS_OIDC_PROVIDERS: '[]' },
        wrapStore(store) {
          const leases = new Proxy(store.leases, {
            get(inner, property) {
              const value: unknown = Reflect.get(inner, property);
              if (property !== 'acquire') return value;
              return async (...args: Parameters<typeof inner.acquire>): Promise<boolean> => {
                const result = await inner.acquire(...args);
                if (result) acquired.push(args[0]);
                return result;
              };
            },
          });
          return new Proxy(store, {
            get(inner, property) {
              if (property === 'leases') return leases;
              const value: unknown = Reflect.get(inner, property);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        },
      });
      founder = await harness.registerUser();
    });

    after(async () => {
      await harness?.close();
      await target?.teardown();
    });

    it('serializes a save even when no providers are configured', async () => {
      acquired.length = 0;
      const response = await harness.authed(founder, {
        method: 'PUT',
        url: '/api/admin/sso',
        payload: { allowed_email_domains: ['example.test'] },
      });

      assert.equal(response.statusCode, 200, response.body);
      assert.ok(
        acquired.includes(SSO_SETTINGS_LOCK_KEY),
        `expected the settings save to acquire ${SSO_SETTINGS_LOCK_KEY}`,
      );
    });
  });
}
