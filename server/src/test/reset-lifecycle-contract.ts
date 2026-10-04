/**
 * Recovery issuance must be ordered with account lifecycle transitions (#499).
 * These barriers pause real email preparation, not a seeded token: a disable
 * either waits for the mint or takes an expired lease and fences the old issuer.
 * The PostgreSQL case separately exercises redemption against a peer store's
 * uncommitted disable, including a late token from an older, unfenced issuer.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ApiErrorBody, ForgotPasswordResponse } from '@ferrum-nexus/shared';

import type { NexusStore, TransactionOptions } from '../db/store.js';
import { isoInSeconds, newId } from '../lib/ids.js';
import { userLifecycleLockKey } from '../lib/keyed-serializer.js';
import { heldLeaseFences } from '../lib/lease-fence.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

interface LifecycleTarget {
  store: NexusStore;
  teardown: () => Promise<void>;
  peer?: () => Promise<NexusStore>;
}

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Follow transaction-scoped repositories on pooled adapters as well as SQLite. */
function interceptStore(
  base: NexusStore,
  hook: (store: NexusStore, inTransaction: boolean) => NexusStore,
  inTransaction = false,
): NexusStore {
  return new Proxy(hook(base, inTransaction), {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return <T>(fn: (tx: NexusStore) => Promise<T>, options?: TransactionOptions): Promise<T> =>
          base.transaction((tx) => fn(interceptStore(tx, hook, true)), options);
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(base) : value;
    },
  });
}

export function runResetLifecycleContract(
  label: string,
  makeStore: () => Promise<LifecycleTarget>,
): void {
  describe(`reset lifecycle races — ${label}`, () => {
    let target: LifecycleTarget;
    let peerStore: NexusStore;
    let harness: TestApp;
    let other: TestApp;
    let founder: TestSession;

    before(async () => {
      target = await makeStore();
      peerStore = target.peer ? await target.peer() : target.store;
      harness = await buildTestApp({ store: target.store });
      other = await buildTestApp({ store: peerStore, edge: harness.edge });
      founder = await harness.registerUser();
    });

    after(async () => {
      await other?.close();
      await harness?.close();
      if (peerStore && peerStore !== target.store) await peerStore.close();
      await target?.teardown();
    });

    async function resetMail(email: string): Promise<string[]> {
      return (await harness.outbox())
        .filter((row) => row.to_email === email && row.idempotency_key?.startsWith('reset:'))
        .map((row) => row.body_text);
    }

    function setStatus(subject: TestSession, status: 'active' | 'disabled') {
      return other.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${subject.user.id}`,
        payload: { status },
      });
    }

    function redeem(token: string) {
      return harness.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, new_password: 'replacement-password-for-race' },
      });
    }

    for (const path of ['PATCH', 'god'] as const) {
      for (const expired of [false, true]) {
        it(
          `${path}: ${expired ? 'expired issuer' : 'waiting disable'} cannot revive a reset link`,
          { timeout: 10_000 },
          async (t) => {
            const subject = await harness.registerUser();
            const verification = await target.store.verificationTokens.create({
              user_id: subject.user.id,
              token_hash: `verification-${newId()}`,
              purpose: 'email_verification',
              expires_at: isoInSeconds(3600),
            });
            const key = userLifecycleLockKey(subject.user.id);
            const prepared = barrier();
            const resume = barrier();
            const refused = barrier();
            const render = harness.services.email.render.bind(harness.services.email);
            const acquire = peerStore.leases.acquire.bind(peerStore.leases);
            const crypto = harness.app.nexus.crypto;
            const generate = crypto.newSessionToken.bind(crypto);
            let token = '';
            let owner = '';
            let paused = false;
            t.mock.method(crypto, 'newSessionToken', () => {
              assert.ok(
                heldLeaseFences().some((fence) => fence.key === key),
                'the lifecycle lease precedes capability generation',
              );
              return generate();
            });
            t.mock.method(
              harness.services.email,
              'render',
              async (...args: Parameters<typeof render>) => {
                if (args[0] === 'password_reset' && !paused) {
                  paused = true;
                  const fence = heldLeaseFences().find((held) => held.key === key);
                  assert.ok(fence, 'email preparation still holds the lifecycle lease');
                  owner = fence.token;
                  const url = String(args[1]?.reset_url);
                  token = new URL(url).searchParams.get('token') ?? '';
                  assert.ok(token);
                  prepared.resolve();
                  await resume.promise;
                }
                return render(...args);
              },
            );
            t.mock.method(
              peerStore.leases,
              'acquire',
              async (...args: Parameters<typeof acquire>) => {
                const acquired = await acquire(...args);
                if (args[0] === key && !acquired) refused.resolve();
                return acquired;
              },
            );

            const issuing = harness.app
              .inject({
                method: 'POST',
                url: '/api/auth/forgot-password',
                payload: { email: subject.user.email },
              })
              .then((response) => {
                assert.equal(response.statusCode, 200, response.body);
                assert.deepEqual(response.json<ForgotPasswordResponse>(), { ok: true });
              });
            let disabling: Promise<unknown> | undefined;
            try {
              await Promise.race([
                prepared.promise,
                issuing.then(() => {
                  throw new Error('email preparation barrier missed');
                }),
              ]);
              if (expired) {
                // Model a process pause past TTL by expiring only this owner's
                // row. The real acquisition predicate decides the takeover;
                // never delete a live lease or use a future acquisition clock.
                assert.equal(
                  await target.store.leases.renew(key, owner, '2020-01-01T00:00:00.000Z'),
                  true,
                );
              }
              const disableResponse =
                path === 'PATCH'
                  ? setStatus(subject, 'disabled')
                  : other.authed(founder, {
                      method: 'POST',
                      url: '/api/admin/god/disable-user',
                      payload: {
                        user_id: subject.user.id,
                        reason: 'Recovery lifecycle race',
                        revoke_grants: false,
                      },
                    });
              disabling = disableResponse.then((response) => {
                assert.equal(response.statusCode, 200, response.body);
              });
              if (expired) {
                await disabling;
                const enabled = await setStatus(subject, 'active');
                assert.equal(enabled.statusCode, 200, enabled.body);
                // Both deletes are finished while the old issuer is paused.
                resume.resolve();
                await issuing;
                assert.deepEqual(await resetMail(subject.user.email), []);
                assert.equal(
                  (await harness.auditRows('auth.password_reset_request')).filter(
                    (row) => row.actor_user_id === subject.user.id,
                  ).length,
                  0,
                  'the stale mint and outbox transaction rolled back with its audit',
                );
              } else {
                await Promise.race([
                  refused.promise,
                  disabling.then(() => {
                    throw new Error('disable bypassed the issuer lifecycle lease');
                  }),
                ]);
                assert.equal(
                  (await target.store.users.findById(subject.user.id))?.status,
                  'active',
                );
                assert.deepEqual(await resetMail(subject.user.email), []);
                resume.resolve();
                await issuing;
                await disabling;
                const enabled = await setStatus(subject, 'active');
                assert.equal(enabled.statusCode, 200, enabled.body);
                assert.equal((await resetMail(subject.user.email)).length, 1);
              }
              assert.equal(
                await target.store.verificationTokens.findByTokenHash(
                  harness.app.nexus.crypto.hashToken(token),
                  'password_reset',
                ),
                null,
              );
              assert.equal((await redeem(token)).statusCode, 400);
              if (expired) {
                // The refused mint did not spend the throttle claim either.
                await harness.services.auth.requestPasswordReset(subject.user.email, {
                  ip: null,
                  userAgent: null,
                });
                const messages = await resetMail(subject.user.email);
                assert.equal(messages.length, 1, 'a fresh request still queues a usable link');
                const fresh = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(messages[0] ?? '');
                assert.ok(fresh?.[1]);
                assert.notEqual(fresh[1], token);
                assert.equal((await redeem(fresh[1])).statusCode, 200);
              }
              assert.deepEqual(
                await target.store.verificationTokens.findByTokenHash(
                  verification.token_hash,
                  'email_verification',
                ),
                verification,
                'lifecycle and recovery revocations preserve verification links',
              );
            } finally {
              resume.resolve();
              await Promise.allSettled([issuing, ...(disabling ? [disabling] : [])]);
            }
          },
        );
      }
    }

    it('PostgreSQL: refuses a stale active read', { timeout: 10_000 }, async (t) => {
      if (target.store.driver !== 'postgres' || !target.peer) {
        return t.skip('requires PostgreSQL READ COMMITTED and an independent peer store');
      }
      const subject = await harness.registerUser();
      const beforeUser = await target.store.users.findById(subject.user.id);
      assert.ok(beforeUser);
      const deleted = barrier();
      const commitDisable = barrier();
      const readActive = barrier();
      const resumeReset = barrier();
      let paused = false;
      const resettingStore = interceptStore(
        target.store,
        (store, inTransaction) =>
          new Proxy(store, {
            get(base, property, receiver) {
              if (property === 'users') {
                return {
                  ...base.users,
                  findById: async (id: string) => {
                    const user = await base.users.findById(id);
                    if (inTransaction && id === subject.user.id && !paused) {
                      paused = true;
                      assert.equal(user?.status, 'active', 'the peer disable is uncommitted');
                      readActive.resolve();
                      await resumeReset.promise;
                    }
                    return user;
                  },
                };
              }
              return Reflect.get(base, property, receiver);
            },
          }),
      );
      const disablingStore = interceptStore(
        peerStore,
        (store, inTransaction) =>
          new Proxy(store, {
            get(base, property, receiver) {
              if (property === 'verificationTokens') {
                return {
                  ...base.verificationTokens,
                  deleteForUser: async (
                    ...args: Parameters<NexusStore['verificationTokens']['deleteForUser']>
                  ) => {
                    const count = await base.verificationTokens.deleteForUser(...args);
                    if (
                      inTransaction &&
                      args[0] === subject.user.id &&
                      args[1] === 'password_reset'
                    ) {
                      deleted.resolve();
                      await commitDisable.promise;
                    }
                    return count;
                  },
                };
              }
              return Reflect.get(base, property, receiver);
            },
          }),
      );
      const resetApp = await buildTestApp({ store: resettingStore, edge: harness.edge });
      const disableApp = await buildTestApp({ store: disablingStore, edge: harness.edge });
      const disabling = disableApp
        .authed(founder, {
          method: 'PATCH',
          url: `/api/users/${subject.user.id}`,
          payload: { status: 'disabled' },
        })
        .then((response) => {
          assert.equal(response.statusCode, 200, response.body);
        });
      let resetting: Promise<unknown> | undefined;
      try {
        await Promise.race([
          deleted.promise,
          disabling.then(() => {
            throw new Error('disable deletion barrier missed');
          }),
        ]);
        // Reproduce an older unfenced issuer inserting after the disable's
        // delete. PostgreSQL's FK key-share lock permits this while a status
        // update holds a non-key row lock. The issuance cases above prevent
        // this with current code; redemption must also defend against it.
        const token = `late-reset-${newId()}`;
        const hash = harness.app.nexus.crypto.hashToken(token);
        await target.store.verificationTokens.create({
          user_id: subject.user.id,
          token_hash: hash,
          purpose: 'password_reset',
          expires_at: isoInSeconds(3600),
        });
        resetting = resetApp.app
          .inject({
            method: 'POST',
            url: '/api/auth/reset-password',
            payload: { token, new_password: 'replacement-password-for-race' },
          })
          .then((response) => {
            assert.equal(response.statusCode, 400, response.body);
            assert.equal(response.json<ApiErrorBody>().error.code, 'VALIDATION_FAILED');
          });
        await Promise.race([
          readActive.promise,
          resetting.then(() => {
            throw new Error('redemption active-read barrier missed');
          }),
        ]);
        commitDisable.resolve();
        await disabling;
        assert.equal((await peerStore.users.findById(subject.user.id))?.status, 'disabled');
        resumeReset.resolve();
        await resetting;
        const user = await target.store.users.findById(subject.user.id);
        assert.equal(user?.password_hash, beforeUser.password_hash);
        assert.equal(user?.email_verified, beforeUser.email_verified);
        assert.equal(await target.store.emailProofs.findByUser(subject.user.id), null);
        assert.equal(
          (await target.store.verificationTokens.findByTokenHash(hash, 'password_reset'))?.used_at,
          null,
          'the failed password predicate rolled back the token burn',
        );
        assert.equal(
          (await harness.auditRows('auth.password_reset')).filter(
            (row) => row.actor_user_id === subject.user.id,
          ).length,
          0,
        );
        const enabled = await setStatus(subject, 'active');
        assert.equal(enabled.statusCode, 200, enabled.body);
        assert.equal((await redeem(token)).statusCode, 400);
      } finally {
        commitDisable.resolve();
        resumeReset.resolve();
        await Promise.allSettled([disabling, ...(resetting ? [resetting] : [])]);
        await disableApp.close();
        await resetApp.close();
      }
    });
  });
}
