import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { consumerUsernameForUser } from '@ferrum-nexus/shared';

import type { NexusStore } from '../db/store.js';
import { buildTestApp } from './helpers.js';

/** Follow transaction-scoped repositories, including pooled SQL and Mongo sessions. */
function interceptTransitions(
  base: NexusStore,
  hook: (store: NexusStore) => NexusStore,
): NexusStore {
  return new Proxy(hook(base), {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return <T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> =>
          base.transaction((tx) => fn(interceptTransitions(tx, hook)));
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(base) : value;
    },
  });
}

export function runTeardownTransitionContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`teardown status transactions — ${label}`, () => {
    for (const fault of [
      'lost predicate',
      'queue failure active',
      'queue failure disabled',
      'already disabled',
    ] as const) {
      it(`god disable: ${fault} preserves atomic status and queue state`, async () => {
        const target = await makeStore();
        let armed = false;
        const wrapped = interceptTransitions(
          target.store,
          (store) =>
            new Proxy(store, {
              get(base, property, receiver) {
                if (property === 'users')
                  return {
                    ...base.users,
                    updateIfMatches: async (
                      ...args: Parameters<NexusStore['users']['updateIfMatches']>
                    ) => {
                      if (armed && fault === 'lost predicate') {
                        armed = false;
                        // Execute a real conditional miss; do not merely return null.
                        return base.users.updateIfMatches(args[0], { role: 'provider' }, args[2]);
                      }
                      return base.users.updateIfMatches(...args);
                    },
                  };
                if (property === 'gatewayTeardownJobs')
                  return {
                    ...base.gatewayTeardownJobs,
                    upsertPending: async (
                      ...args: Parameters<NexusStore['gatewayTeardownJobs']['upsertPending']>
                    ) => {
                      const job = await base.gatewayTeardownJobs.upsertPending(...args);
                      if (armed && fault.startsWith('queue failure')) {
                        armed = false;
                        throw new Error('queue write failed after mutation');
                      }
                      return job;
                    },
                  };
                return Reflect.get(base, property, receiver);
              },
            }),
        );
        const harness = await buildTestApp({ store: wrapped });
        try {
          const founder = await harness.registerUser();
          const user = await harness.registerUser();
          const issued = await harness.authed(user, {
            method: 'POST',
            url: '/api/credentials',
            payload: { credential_type: 'keyauth', label: 'Transition contract' },
          });
          assert.equal(issued.statusCode, 201, issued.body);
          const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(user.user.id));
          assert.ok(consumer);
          if (fault === 'queue failure disabled' || fault === 'already disabled') {
            harness.edge.queueFailure(500, { error: 'unavailable' }, '/consumers');
            const disabled = await harness.authed(founder, {
              method: 'PATCH',
              url: `/api/users/${user.user.id}`,
              payload: { status: 'disabled' },
            });
            assert.equal(disabled.statusCode, 200, disabled.body);
          }
          const beforeUser = await target.store.users.findById(user.user.id);
          const beforeJob = await target.store.gatewayTeardownJobs.findByUser(user.user.id);
          armed = true;
          const response = await harness.authed(founder, {
            method: 'POST',
            url: '/api/admin/god/disable-user',
            payload: { user_id: user.user.id, reason: 'Transition contract', revoke_grants: false },
          });
          if (fault === 'already disabled') {
            assert.equal(response.statusCode, 200, response.body);
            const done = await target.store.gatewayTeardownJobs.findByUser(user.user.id);
            assert.equal(done?.id, beforeJob?.id);
            assert.notEqual(done?.generation, beforeJob?.generation);
            assert.equal(done?.status, 'done');
            assert.ok(done?.completed_at);
            assert.deepEqual(consumer.credentials, {});
          } else {
            assert.equal(
              response.statusCode,
              fault === 'lost predicate' ? 409 : 500,
              response.body,
            );
            assert.deepEqual(await target.store.users.findById(user.user.id), beforeUser);
            assert.deepEqual(
              await target.store.gatewayTeardownJobs.findByUser(user.user.id),
              beforeJob,
            );
            assert.equal(consumer.credentials.keyauth?.length, 1);
            assert.equal((await harness.auditRows('god.disable_user')).length, 0);
            // A normal subsequent request remains able to revoke the actual key.
            const recovered = await harness.authed(founder, {
              method: 'POST',
              url: '/api/admin/god/disable-user',
              payload: { user_id: user.user.id, reason: 'Recover', revoke_grants: false },
            });
            assert.equal(recovered.statusCode, 200, recovered.body);
            assert.deepEqual(consumer.credentials, {});
            const done = await target.store.gatewayTeardownJobs.findByUser(user.user.id);
            assert.equal(done?.status, 'done');
            assert.ok(done?.completed_at);
          }
        } finally {
          await harness.close();
          await target.teardown();
        }
      });
    }

    for (const caller of ['god active', 'god disabled', 'retry disabled'] as const) {
      it(`${caller}: rejects a stale status snapshot without queue changes`, async () => {
        const target = await makeStore();
        const harness = await buildTestApp({ store: target.store });
        const read = target.store.users.findById;
        let release!: () => void;
        let reached!: () => void;
        const resume = new Promise<void>((resolve) => {
          release = resolve;
        });
        const paused = new Promise<void>((resolve) => {
          reached = resolve;
        });
        let work: Promise<unknown> | undefined;
        try {
          const founder = await harness.registerUser();
          const user = await harness.registerUser();
          const issued = await harness.authed(user, {
            method: 'POST',
            url: '/api/credentials',
            payload: { credential_type: 'keyauth', label: 'Stale snapshot' },
          });
          assert.equal(issued.statusCode, 201, issued.body);
          const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(user.user.id));
          assert.ok(consumer);
          const patchStatus = (status: 'active' | 'disabled') =>
            harness.authed(founder, {
              method: 'PATCH',
              url: `/api/users/${user.user.id}`,
              payload: { status },
            });
          if (caller !== 'god active') {
            harness.edge.queueFailure(500, { error: 'unavailable' }, '/consumers');
            assert.equal((await patchStatus('disabled')).statusCode, 200);
          }
          let armed = true;
          target.store.users.findById = async (id) => {
            const row = await read(id);
            if (armed && id === user.user.id) {
              armed = false;
              reached();
              await resume;
            }
            return row;
          };
          work = harness
            .authed(founder, {
              method: 'POST',
              url:
                caller === 'retry disabled'
                  ? `/api/users/${user.user.id}/gateway-teardown/retry`
                  : '/api/admin/god/disable-user',
              ...(caller === 'retry disabled'
                ? {}
                : {
                    payload: {
                      user_id: user.user.id,
                      reason: 'Stale snapshot',
                      revoke_grants: false,
                    },
                  }),
            })
            .then((response) => {
              assert.equal(response.statusCode, 409, response.body);
            });
          await Promise.race([
            paused,
            work.then(() => {
              throw new Error('Snapshot barrier missed');
            }),
          ]);
          const status = caller === 'god active' ? 'disabled' : 'active';
          if (status === 'disabled') {
            harness.edge.queueFailure(500, { error: 'unavailable' }, '/consumers');
          }
          assert.equal((await patchStatus(status)).statusCode, 200);
          const next = await target.store.gatewayTeardownJobs.findByUser(user.user.id);
          release();
          await work;
          assert.deepEqual(await target.store.gatewayTeardownJobs.findByUser(user.user.id), next);
          assert.equal((await read(user.user.id))?.status, status);
          assert.equal(consumer.credentials.keyauth?.length, 1);
          if (status === 'disabled') {
            assert.equal((await harness.services.teardown.tick()).completed, 1);
            assert.deepEqual(consumer.credentials, {});
          } else {
            assert.equal(next, null);
            assert.equal((await harness.services.teardown.tick()).claimed, 0);
            assert.equal(consumer.credentials.keyauth?.length, 1);
          }
        } finally {
          release();
          await work?.catch(() => undefined);
          target.store.users.findById = read;
          await harness.close();
          await target.teardown();
        }
      });
    }
  });
}
