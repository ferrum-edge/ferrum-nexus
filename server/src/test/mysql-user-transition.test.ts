import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import mysql from 'mysql2/promise';

import { consumerUsernameForUser } from '@ferrum-nexus/shared';

import { loadConfig } from '../config/index.js';
import { createStore } from '../db/index.js';
import type { NexusStore, UserRecord } from '../db/store.js';
import { nowIso } from '../lib/ids.js';
import { buildTestApp, type TestApp, TEST_SECRET_KEY } from './helpers.js';

const adminUrl = process.env.NEXUS_TEST_MYSQL_URL;

/** Two independent pools and transaction queues, sharing only a disposable database. */
async function fixture(
  body: (a: NexusStore, b: NexusStore) => Promise<void>,
  disableFoundRowsInUri = false,
): Promise<void> {
  const database = `nexus_transition_${randomUUID().replace(/-/g, '')}`;
  const admin = await mysql.createConnection(adminUrl!);
  const url = new URL(adminUrl!);
  url.pathname = `/${database}`;
  if (disableFoundRowsInUri) url.searchParams.set('flags', '-FOUND_ROWS');
  const config = loadConfig({
    NEXUS_ENV: 'test',
    NEXUS_SECRET_KEY: TEST_SECRET_KEY,
    FERRUM_ADMIN_JWT_SECRET: TEST_SECRET_KEY,
    NEXUS_DB_DRIVER: 'mysql',
    NEXUS_DB_URL: url.toString(),
  });
  const a = createStore(config);
  const b = createStore(config);
  try {
    await admin.query(`CREATE DATABASE \`${database}\``);
    await a.init();
    await a.migrate();
    await b.init();
    assert.notEqual(a, b);
    await body(a, b);
  } finally {
    await a.close();
    await b.close();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
}

describe('MySQL conditional user transitions', { skip: !adminUrl, timeout: 30_000 }, () => {
  for (const existingJob of [false, true]) {
    it(`god disable: snapshot predicate loss (existing job=${existingJob})`, async (t) => {
      await fixture(async (a, b) => {
        let targetId: string | undefined;
        let reached!: () => void;
        let release!: () => void;
        const paused = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const resume = new Promise<void>((resolve) => {
          release = resolve;
        });
        let armed = false;
        let conditionalCalls = 0;
        let conditionalResult: UserRecord | null | undefined;
        // Intercept only the transaction-scoped repository. The initial
        // pre-transaction read must not trigger the barrier.
        const wrapped = new Proxy(a, {
          get(base, property, receiver) {
            if (property === 'transaction') {
              return <T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> =>
                base.transaction((tx) =>
                  fn(
                    new Proxy(tx, {
                      get(scoped, member, scopedReceiver) {
                        if (member === 'users') {
                          return {
                            ...scoped.users,
                            findById: async (id: string) => {
                              const row = await scoped.users.findById(id);
                              if (armed && id === targetId) {
                                armed = false;
                                assert.equal(row?.role, 'client');
                                assert.equal(row?.status, 'active');
                                // A has established its InnoDB snapshot. B
                                // now commits before A's conditional UPDATE.
                                reached();
                                await resume;
                                assert.deepEqual(
                                  await scoped.users.findById(id),
                                  row,
                                  'A still sees its old REPEATABLE READ snapshot after B commits',
                                );
                              }
                              return row;
                            },
                            updateIfMatches: async (
                              ...args: Parameters<NexusStore['users']['updateIfMatches']>
                            ) => {
                              conditionalCalls += 1;
                              const [id, expected, patch] = args;
                              assert.deepEqual(args, [
                                targetId,
                                { role: 'client', status: 'active' },
                                { status: 'disabled' },
                              ]);
                              // Execute the real predicate, with no injected
                              // miss or fabricated result.
                              conditionalResult = await scoped.users.updateIfMatches(
                                id,
                                expected,
                                patch,
                              );
                              return conditionalResult;
                            },
                          };
                        }
                        const value: unknown = Reflect.get(scoped, member, scopedReceiver);
                        return typeof value === 'function' ? value.bind(scoped) : value;
                      },
                    }),
                  ),
                );
            }
            const value: unknown = Reflect.get(base, property, receiver);
            return typeof value === 'function' ? value.bind(base) : value;
          },
        });
        const appA = await buildTestApp({ store: wrapped });
        let appB: TestApp | undefined;
        let work: ReturnType<TestApp['authed']> | undefined;
        try {
          appB = await buildTestApp({ store: b, edge: appA.edge });
          const founder = await appA.registerUser();
          const user = await appA.registerUser();
          targetId = user.user.id;
          const issued = await appA.authed(user, {
            method: 'POST',
            url: '/api/credentials',
            payload: { credential_type: 'keyauth', label: 'Snapshot transition' },
          });
          assert.equal(issued.statusCode, 201, issued.body);
          const consumer = appA.edge.consumerByUsername(consumerUsernameForUser(targetId));
          assert.ok(consumer);
          const beforeCredentials = structuredClone(consumer.credentials);
          if (existingJob) {
            await a.gatewayTeardownJobs.upsertPending(targetId, founder.user.id, nowIso());
          }
          const beforeJob = await a.gatewayTeardownJobs.findByUser(targetId);
          const beforeUser = await a.users.findById(targetId);
          assert.ok(beforeUser);
          // The interleaving must succeed while A's lifecycle lease is live.
          t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
          armed = true;
          work = appA.authed(founder, {
            method: 'POST',
            url: '/api/admin/god/disable-user',
            payload: { user_id: targetId, reason: 'Snapshot transition', revoke_grants: false },
          });
          await Promise.race([
            paused,
            work.then((response) => {
              throw new Error(`Transaction snapshot barrier missed: ${response.statusCode}`);
            }),
          ]);
          // This authorized role-only request uses B's independent store and
          // commits without acquiring the account lifecycle lease held by A.
          const changed = await appB.authed(founder, {
            method: 'PATCH',
            url: `/api/users/${targetId}`,
            payload: { role: 'provider' },
          });
          assert.equal(changed.statusCode, 200, changed.body);
          const committedUser = await b.users.findById(targetId);
          assert.ok(committedUser);
          assert.deepEqual(committedUser, {
            ...beforeUser,
            role: 'provider',
            updated_at: committedUser.updated_at,
          });
          assert.deepEqual(await b.gatewayTeardownJobs.findByUser(targetId), beforeJob);
          release();
          const response = await work;
          assert.equal(response.statusCode, 409, response.body);
          assert.equal(response.json().error.code, 'CONFLICT');
          assert.equal(conditionalCalls, 1);
          assert.equal(conditionalResult, null);
          assert.deepEqual(await a.users.findById(targetId), committedUser);
          assert.deepEqual(await a.gatewayTeardownJobs.findByUser(targetId), beforeJob);
          assert.deepEqual(consumer.credentials, beforeCredentials);
          assert.deepEqual(await appA.auditRows('god.disable_user'), []);

          // A fresh ordinary disable sees the committed role and succeeds.
          const ordinary = await appB.authed(founder, {
            method: 'POST',
            url: '/api/admin/god/disable-user',
            payload: { user_id: targetId, reason: 'Current transition', revoke_grants: false },
          });
          assert.equal(ordinary.statusCode, 200, ordinary.body);
          assert.equal((await b.users.findById(targetId))?.status, 'disabled');
          assert.equal((await b.gatewayTeardownJobs.findByUser(targetId))?.status, 'done');
          assert.deepEqual(consumer.credentials, {});
          assert.equal((await appB.auditRows('god.disable_user')).length, 1);
        } finally {
          release();
          await work?.catch(() => undefined);
          await appB?.close();
          await appA.close();
        }
      });
    });
  }

  it('pins matched-row semantics even when the URI disables FOUND_ROWS', async (t) => {
    await fixture(async (a, b) => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const user = await a.users.create({
        email: 'same-value@example.test',
        password_hash: 'unused',
        display_name: 'Same value',
        role: 'client',
        status: 'active',
        email_verified: false,
      });
      const expected = { role: user.role, status: user.status };
      assert.deepEqual(
        await a.users.updateIfMatches(user.id, expected, { status: user.status }),
        user,
      );
      await b.transaction(async (tx) => {
        assert.deepEqual(
          await tx.users.updateIfMatches(user.id, expected, { role: user.role }),
          user,
        );
      });
      assert.deepEqual(await b.users.findById(user.id), user);
    }, true);
  });
});
