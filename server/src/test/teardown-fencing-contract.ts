import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { consumerUsernameForUser } from '@ferrum-nexus/shared';

import { createTeardownWorker, TEARDOWN_STALE_AFTER_MS } from '../credentials/teardown-worker.js';
import type { GatewayTeardownJobRecord, NexusStore } from '../db/store.js';
import { buildTestApp } from './helpers.js';

function barrier(): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

/** Real endpoints and Edge operations, paused immediately before durable settlement. */
export function runTeardownFencingContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`teardown attempt fencing — ${label}`, () => {
    for (const caller of ['inline', 'worker'] as const) {
      for (const settlement of ['completion', 'failure'] as const) {
        for (const replacement of ['retry pending', 'retry done', 'reclaim', 'new ID'] as const) {
          it(`${caller} ${settlement} preserves ${replacement}`, async () => {
            const target = await makeStore();
            const harness = await buildTestApp({ store: target.store });
            const store = target.store;
            const jobs = store.gatewayTeardownJobs;
            const markDone = jobs.markDone;
            const reschedule = jobs.reschedule;
            const reached = barrier();
            const resume = barrier();
            let work: Promise<unknown> | undefined;
            try {
              const founder = await harness.registerUser();
              const user = await harness.registerUser();
              const issued = await harness.authed(user, {
                method: 'POST',
                url: '/api/credentials',
                payload: { credential_type: 'keyauth', label: 'Fencing contract' },
              });
              assert.equal(issued.statusCode, 201, issued.body);
              const username = consumerUsernameForUser(user.user.id);
              const consumer = harness.edge.consumerByUsername(username);
              assert.ok(consumer);
              const originalKeys = structuredClone(consumer.credentials.keyauth);
              assert.ok(originalKeys);
              assert.equal(originalKeys?.length, 1);

              const failEdge = (): void => {
                harness.edge.queueFailure(500, { error: 'unavailable' }, '/consumers');
              };
              const disable = () =>
                harness.authed(founder, {
                  method: 'PATCH',
                  url: `/api/users/${user.user.id}`,
                  payload: { status: 'disabled' },
                });
              const retry = () =>
                harness.authed(founder, {
                  method: 'POST',
                  url: `/api/users/${user.user.id}/gateway-teardown/retry`,
                });
              if (caller === 'worker') {
                failEdge();
                const response = await disable();
                assert.equal(response.statusCode, 200, response.body);
              }

              let stale: GatewayTeardownJobRecord | undefined;
              async function pause(job: GatewayTeardownJobRecord): Promise<void> {
                if (stale) return;
                stale = job;
                reached.release();
                await resume.reached;
              }
              if (settlement === 'completion') {
                jobs.markDone = async (job, at) => {
                  await pause(job);
                  return markDone(job, at);
                };
              } else {
                jobs.reschedule = async (job, at, error) => {
                  await pause(job);
                  return reschedule(job, at, error);
                };
                failEdge();
              }
              const worker = createTeardownWorker({
                store,
                credentials: harness.services.credentials,
                audit: harness.services.audit,
                batchSize: 1,
              });
              work =
                caller === 'inline'
                  ? disable().then((response) => {
                      assert.equal(response.statusCode, 200, response.body);
                      assert.equal(
                        response.json<{ gateway_teardown: string }>().gateway_teardown,
                        'pending',
                      );
                    })
                  : worker.tick().then((tick) => {
                      assert.equal(tick.completed, 0);
                      assert.equal(tick.rescheduled, 0);
                      assert.equal(tick.abandoned, 0);
                    });
              await Promise.race([
                reached.reached,
                work.then(() => {
                  throw new Error('Attempt missed its settlement barrier');
                }),
              ]);
              assert.ok(stale);
              assert.equal(stale.status, 'sending');
              assert.ok(stale.generation);
              assert.equal(stale.completed_at, null);

              // Model an operator restoring a key directly on Edge after the
              // old HTTP work returned. The later attempt must really delete it.
              consumer.credentials.keyauth = structuredClone(originalKeys);
              if (replacement === 'reclaim') {
                await jobs.releaseStale(new Date(Date.now() + 1_000).toISOString());
                const [claim] = await jobs.claimDue(new Date().toISOString(), 1);
                assert.ok(claim);
                assert.equal(claim.id, stale.id);
                assert.equal(claim.attempts, stale.attempts + 1);
              } else if (replacement === 'new ID') {
                const enabled = await harness.authed(founder, {
                  method: 'PATCH',
                  url: `/api/users/${user.user.id}`,
                  payload: { status: 'active' },
                });
                assert.equal(enabled.statusCode, 200, enabled.body);
                failEdge();
                assert.equal((await disable()).statusCode, 200);
              } else {
                if (replacement === 'retry pending') failEdge();
                const retried = await retry();
                assert.equal(retried.statusCode, 200, retried.body);
              }
              const next = await jobs.findByUser(user.user.id);
              assert.ok(next);
              if (replacement === 'new ID') assert.notEqual(next.id, stale.id);
              else assert.equal(next.id, stale.id);
              assert.notEqual(next.generation, stale.generation);
              assert.equal(
                next.status,
                replacement === 'retry done'
                  ? 'done'
                  : replacement === 'reclaim'
                    ? 'sending'
                    : 'pending',
              );
              if (replacement === 'retry done') {
                assert.ok(next.completed_at);
                assert.equal(next.next_attempt_at, null);
                assert.deepEqual(consumer.credentials, {});
              } else {
                assert.equal(next.completed_at, null);
                assert.equal(consumer.credentials.keyauth?.length, 1);
              }
              resume.release();
              await work;
              assert.deepEqual(
                await jobs.findByUser(user.user.id),
                next,
                'including every timestamp',
              );
              assert.equal((await store.users.findById(user.user.id))?.status, 'disabled');
              assert.equal((await harness.auditRows('user.gateway_teardown_complete')).length, 0);

              jobs.markDone = markDone;
              jobs.reschedule = reschedule;
              const recovery = createTeardownWorker({
                store,
                credentials: harness.services.credentials,
                audit: harness.services.audit,
                batchSize: 1,
                now: () => new Date(Date.now() + TEARDOWN_STALE_AFTER_MS + 1_000),
              });
              const recovered = await recovery.tick();
              assert.equal(recovered.completed, replacement === 'retry done' ? 0 : 1);
              const done = await jobs.findByUser(user.user.id);
              assert.equal(done?.id, next.id);
              assert.equal(done?.status, 'done');
              assert.ok(done?.completed_at);
              assert.equal(done.next_attempt_at, null);
              assert.equal(done.last_error, null);
              assert.deepEqual(
                consumer.credentials,
                {},
                'later recovery revoked the actual Edge key',
              );
            } finally {
              resume.release();
              await work?.catch(() => undefined);
              jobs.markDone = markDone;
              jobs.reschedule = reschedule;
              await harness.close();
              await target.teardown();
            }
          });
        }
      }
    }
  });
}
