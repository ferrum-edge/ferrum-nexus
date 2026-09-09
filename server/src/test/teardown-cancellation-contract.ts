import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { consumerUsernameForUser, type ListUsersResponse } from '@ferrum-nexus/shared';

import {
  createTeardownWorker,
  TEARDOWN_STALE_AFTER_MS,
  type TeardownTickResult,
} from '../credentials/teardown-worker.js';
import type { GatewayTeardownJobRecord, NexusStore, TransactionOptions } from '../db/store.js';
import { userLifecycleLockKey } from '../lib/keyed-serializer.js';
import { buildTestApp } from './helpers.js';

function barrier(): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

/** Exercise both worker cancellation decisions against the real lifecycle endpoints. */
export function runTeardownCancellationContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`teardown cancellation contract — ${label}`, () => {
    for (const phase of ['before attempt', 'after refusal'] as const) {
      for (const replacement of ['new ID', 'reused ID', 'reclaimed ID', 'none'] as const) {
        it(`${phase}: retains ${replacement} work after an active status read`, async () => {
          const target = await makeStore();
          const harness = await buildTestApp({ store: target.store });
          const store = target.store;
          const read = store.users.findById;
          const claim = store.gatewayTeardownJobs.claimDue;
          const statusRead = barrier();
          const resume = barrier();
          let tick: Promise<TeardownTickResult> | undefined;
          try {
            const founder = await harness.registerUser();
            const user = await harness.registerUser();
            const issued = await harness.authed(user, {
              method: 'POST',
              url: '/api/credentials',
              payload: { credential_type: 'keyauth', label: 'Cancellation contract' },
            });
            assert.equal(issued.statusCode, 201, issued.body);
            const username = consumerUsernameForUser(user.user.id);
            const consumer = harness.edge.consumerByUsername(username);
            assert.ok(consumer);
            consumer.acl_groups = ['nexus:api:contract:approved'];

            async function disable(): Promise<void> {
              harness.edge.queueFailure(500, { error: 'temporarily unavailable' }, '/consumers');
              const response = await harness.authed(founder, {
                method: 'PATCH',
                url: `/api/users/${user.user.id}`,
                payload: { status: 'disabled' },
              });
              assert.equal(response.statusCode, 200, response.body);
              assert.equal(
                response.json<{ gateway_teardown: string }>().gateway_teardown,
                'pending',
              );
            }

            async function backlog(): Promise<number> {
              const response = await harness.authed(founder, { method: 'GET', url: '/api/users' });
              assert.equal(response.statusCode, 200, response.body);
              return response.json<ListUsersResponse>().pending_gateway_teardowns;
            }

            await disable();
            const original = await store.gatewayTeardownJobs.findByUser(user.user.id);
            assert.ok(original);
            assert.equal(await backlog(), 1);
            let armed = false;
            const claimedJobs: GatewayTeardownJobRecord[] = [];

            async function reenable(): Promise<void> {
              if (replacement === 'reused ID' || replacement === 'reclaimed ID') {
                // Model a status writer leaving the row behind. The following
                // real disable upsert must reuse this ID on every adapter.
                await store.users.update(user.user.id, { status: 'active' });
              } else {
                const response = await harness.authed(founder, {
                  method: 'PATCH',
                  url: `/api/users/${user.user.id}`,
                  payload: { status: 'active' },
                });
                assert.equal(response.statusCode, 200, response.body);
              }
              armed = true;
            }

            store.users.findById = async (id) => {
              const result = await read.call(store.users, id);
              if (armed && id === user.user.id && result?.status === 'active') {
                armed = false;
                statusRead.release();
                await resume.reached;
              }
              return result;
            };
            store.gatewayTeardownJobs.claimDue = async (at, limit) => {
              const jobs = await claim.call(store.gatewayTeardownJobs, at, limit);
              claimedJobs.push(...jobs);
              const claimed = jobs.find((job) => job.user_id === user.user.id);
              assert.equal(claimed?.id, original.id);
              assert.equal(claimed?.status, 'sending');
              assert.equal(await backlog(), 1, 'sending work remains in the admin count');
              if (phase === 'before attempt') await reenable();
              return jobs;
            };
            const workerStore = new Proxy(store, {
              get(base, property, receiver) {
                if (property === 'transaction') {
                  return async <T>(
                    fn: (tx: NexusStore) => Promise<T>,
                    options?: TransactionOptions,
                  ): Promise<T> => {
                    // A second owner must be excluded before the cancellation
                    // transaction opens, including on the single-connection adapter.
                    const acquired = await base.leases.acquire(
                      userLifecycleLockKey(user.user.id),
                      'cancellation-contract-probe',
                      new Date(Date.now() + 60_000).toISOString(),
                      new Date().toISOString(),
                    );
                    assert.equal(acquired, false, 'cancellation holds the account lifecycle lease');
                    return base.transaction(fn, options);
                  };
                }
                const value: unknown = Reflect.get(base, property, receiver);
                return typeof value === 'function' ? value.bind(base) : value;
              },
            });
            const worker = createTeardownWorker({
              store: workerStore,
              audit: harness.services.audit,
              batchSize: 1,
              credentials: {
                async disableGatewayAccess(id, subject) {
                  assert.equal(phase, 'after refusal', 'the initial cancel never revokes');
                  await reenable();
                  // Do not pause the credential service's own active check:
                  // the barrier belongs to the worker's post-refusal read.
                  armed = false;
                  try {
                    return await harness.services.credentials.disableGatewayAccess(id, subject);
                  } finally {
                    armed = true;
                  }
                },
              },
            });
            tick = worker.tick();
            await Promise.race([
              statusRead.reached,
              tick.then(() => {
                throw new Error('Worker finished without reaching the cancellation barrier');
              }),
            ]);
            const claimed = claimedJobs.find((job) => job.user_id === user.user.id);
            assert.ok(claimed);
            assert.equal(claimed.id, original.id);
            let next: GatewayTeardownJobRecord | null = null;
            if (replacement !== 'none') {
              await disable();
              next = await store.gatewayTeardownJobs.findByUser(user.user.id);
              assert.ok(next);
              assert.equal(next.status, 'pending');
              if (replacement === 'new ID') assert.notEqual(next.id, claimed.id);
              else assert.equal(next.id, claimed.id, 'the adapter really reuses the ID');
              if (replacement === 'reclaimed ID') {
                await claim.call(store.gatewayTeardownJobs, new Date().toISOString(), 1);
                next = await store.gatewayTeardownJobs.findByUser(user.user.id);
                assert.equal(next?.status, 'sending');
              }
            }
            resume.release();
            const result = await tick;
            assert.equal(result.abandoned, 0);
            assert.equal(result.completed, 0);
            assert.equal(result.cancelled, replacement === 'none' ? 1 : 0);
            assert.equal(harness.edge.consumerByUsername(username)?.credentials.keyauth?.length, 1);
            assert.deepEqual(await store.gatewayTeardownJobs.findByUser(user.user.id), next);
            assert.equal(await backlog(), replacement === 'none' ? 0 : 1);

            store.users.findById = read;
            store.gatewayTeardownJobs.claimDue = claim;
            if (replacement !== 'none') {
              assert.equal((await read.call(store.users, user.user.id))?.status, 'disabled');
              // A replacement claimed by another process is recovered exactly
              // as a crashed worker's claim, without a timer or sleep.
              const recovered = createTeardownWorker({
                store,
                audit: harness.services.audit,
                credentials: harness.services.credentials,
                batchSize: 1,
                now: () => new Date(Date.now() + TEARDOWN_STALE_AFTER_MS + 1_000),
              });
              assert.equal((await recovered.tick()).completed, 1);
              const done = await store.gatewayTeardownJobs.findByUser(user.user.id);
              assert.equal(done?.id, next?.id);
              assert.equal(done?.status, 'done');
              assert.deepEqual(harness.edge.consumerByUsername(username)?.credentials, {});
              assert.deepEqual(harness.edge.consumerByUsername(username)?.acl_groups, []);
              assert.equal(await backlog(), 0, 'done work and accounts without jobs are excluded');
            }
          } finally {
            resume.release();
            await tick;
            store.users.findById = read;
            store.gatewayTeardownJobs.claimDue = claim;
            await harness.close();
            await target.teardown();
          }
        });
      }
    }
  });
}
