import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { NexusStore } from '../db/store.js';
import { SSO_SETTINGS_LOCK_KEY } from '../lib/keyed-serializer.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** What the contract needs from a store target. */
interface SsoSettingsTarget {
  store: NexusStore;
  teardown: () => Promise<void>;
  /** A second store and transaction queue over the same database, when available. */
  peer?: () => Promise<NexusStore>;
}

/** The real SSO settings route must take its deployment-wide lock on every adapter. */
export function runSsoSettingsLockContract(
  label: string,
  makeStore: () => Promise<SsoSettingsTarget>,
): void {
  describe(`SSO settings lock contract — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let peerStore: NexusStore | null = null;
    let harness: TestApp;
    let peerHarness: TestApp;
    let founder: TestSession;
    const acquired: string[] = [];
    let pauseNextSave = false;
    let peerAcquireResolve: (() => void) | null = null;
    const peerSave: { current: ReturnType<TestApp['authed']> | null } = { current: null };
    const peerAcquiring = new Promise<void>((resolve) => {
      peerAcquireResolve = resolve;
    });

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
                if (result && pauseNextSave && args[0] === SSO_SETTINGS_LOCK_KEY) {
                  pauseNextSave = false;
                  peerSave.current = peerHarness.authed(founder, {
                    method: 'PUT',
                    url: '/api/admin/sso',
                    payload: { allowed_email_domains: ['second.example.test'] },
                  });
                  await peerAcquiring;
                }
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
      peerStore = target.peer ? await target.peer() : target.store;
      peerHarness = await buildTestApp({
        store: peerStore,
        edge: harness.edge,
        env: { NEXUS_OIDC_PROVIDERS: '[]' },
        wrapStore(store) {
          const leases = new Proxy(store.leases, {
            get(inner, property) {
              const value: unknown = Reflect.get(inner, property);
              if (property !== 'acquire') return value;
              return async (...args: Parameters<typeof inner.acquire>): Promise<boolean> => {
                if (args[0] === SSO_SETTINGS_LOCK_KEY) peerAcquireResolve?.();
                return inner.acquire(...args);
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
    });

    after(async () => {
      await harness?.close();
      await peerHarness?.close();
      if (peerStore && peerStore !== target?.store) await peerStore.close();
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

    it('refuses one of two concurrent settings saves', async () => {
      peerSave.current = null;
      pauseNextSave = true;
      const firstSave = harness.authed(founder, {
        method: 'PUT',
        url: '/api/admin/sso',
        payload: { allowed_email_domains: ['first.example.test'] },
      });
      const first = await firstSave;
      const startedPeerSave = peerSave.current;
      assert.ok(
        startedPeerSave,
        'the second app started its save while the first held the settings key',
      );
      const second = await startedPeerSave;
      assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409]);
    });
  });
}
