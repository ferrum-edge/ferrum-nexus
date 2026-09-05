import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ApiErrorBody } from '@ferrum-nexus/shared';

import type { IssuedSession, RequestContext } from '../auth/service.js';
import type {
  NexusStore,
  UserRecord,
  VerificationTokenPurpose,
  VerificationTokenRecord,
} from '../db/store.js';
import { isNexusError } from '../lib/errors.js';
import { isoInSeconds } from '../lib/ids.js';
import { buildTestApp, TEST_PASSWORD, type TestApp, type TestSession } from './helpers.js';

const CHANGED_PASSWORD = 'changed-password-for-the-owner';
const RESET_PASSWORD = 'password-from-the-reset-link';
const CONTEXT = { ip: null, userAgent: null };

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Exercise the actual services and routes against each smoke-suite adapter. */
export function runPasswordChangeContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`password change contract — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let harness: TestApp;
    let other: TestApp;

    before(async () => {
      target = await makeStore();
      harness = await buildTestApp({ store: target.store });
      other = await buildTestApp({ store: target.store, edge: harness.edge });
      await harness.registerUser();
    });

    after(async () => {
      await other?.close();
      await harness?.close();
      await target?.teardown();
    });

    async function seedToken(
      session: TestSession,
      purpose: VerificationTokenPurpose = 'password_reset',
    ): Promise<string> {
      const token = harness.app.nexus.crypto.newSessionToken();
      await harness.store.verificationTokens.create({
        user_id: session.user.id,
        token_hash: harness.app.nexus.crypto.hashToken(token),
        purpose,
        expires_at: isoInSeconds(3600),
      });
      return token;
    }

    async function findToken(
      token: string,
      purpose: VerificationTokenPurpose,
    ): Promise<VerificationTokenRecord | null> {
      return harness.store.verificationTokens.findByTokenHash(
        harness.app.nexus.crypto.hashToken(token),
        purpose,
      );
    }

    async function assertPassword(session: TestSession, password: string): Promise<void> {
      const user = await harness.store.users.findById(session.user.id);
      assert.ok(user);
      const matches = await harness.app.nexus.crypto.verifyPassword(password, user.password_hash);
      assert.equal(matches, true);
    }

    async function requestedToken(session: TestSession): Promise<string> {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { email: session.user.email },
      });
      assert.equal(response.statusCode, 200);
      const rows = (await harness.outbox()).filter((row) => row.to_email === session.user.email);
      const match = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(rows.at(-1)?.body_text ?? '');
      assert.ok(match?.[1], 'a reset message was queued');
      return match[1];
    }

    it('rejects an old mailed link after a change and accepts a newly requested one', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const session = await harness.registerUser();
      const token = await requestedToken(session);
      const extra = await seedToken(session);
      const verification = await seedToken(session, 'email_verification');
      const verificationBefore = await findToken(verification, 'email_verification');
      const changed = await harness.authed(session, {
        method: 'PATCH',
        url: '/api/users/me',
        payload: { current_password: TEST_PASSWORD, new_password: CHANGED_PASSWORD },
      });
      assert.equal(changed.statusCode, 200);
      const replacement = changed.cookies.find((cookie) => cookie.name === 'nexus_session');
      assert.ok(replacement);
      assert.ok(
        await harness.store.sessions.findByTokenHash(
          harness.app.nexus.crypto.hashToken(replacement.value),
        ),
      );
      const rejected = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, new_password: RESET_PASSWORD },
      });
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.json<ApiErrorBody>().error.code, 'VALIDATION_FAILED');
      await assertPassword(session, CHANGED_PASSWORD);
      await harness.loginUser(session.user.email, CHANGED_PASSWORD);
      assert.equal(await findToken(extra, 'password_reset'), null);
      assert.deepEqual(await findToken(verification, 'email_verification'), verificationBefore);
      assert.equal(
        await harness.store.sessions.findByTokenHash(
          harness.app.nexus.crypto.hashToken(session.sessionToken),
        ),
        null,
      );

      // Respect the existing issuance throttle; advancing Date needs no sleep.
      t.mock.timers.tick(11 * 60 * 1000);
      const fresh = await requestedToken(session);
      assert.ok(fresh !== token, 'the new request issued a different link');
      const another = await seedToken(session);
      const accepted = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: fresh, new_password: RESET_PASSWORD },
      });
      assert.equal(accepted.statusCode, 200);
      await harness.loginUser(session.user.email, RESET_PASSWORD);
      assert.equal(await findToken(fresh, 'password_reset'), null);
      assert.equal(await findToken(another, 'password_reset'), null);
      assert.deepEqual(await findToken(verification, 'email_verification'), verificationBefore);
      assert.equal(
        await harness.store.sessions.findByTokenHash(
          harness.app.nexus.crypto.hashToken(replacement.value),
        ),
        null,
      );
    });

    for (const changeFirst of [true, false]) {
      const winner = changeFirst ? 'change' : 'reset';
      it(`orders concurrent change/reset when ${winner} wins`, { timeout: 10_000 }, async (t) => {
        const session = await harness.registerUser();
        const user = await harness.store.users.findById(session.user.id);
        assert.ok(user);
        const token = await seedToken(session);
        const verification = await seedToken(session, 'email_verification');
        const changeReady = barrier();
        const resetReady = barrier();
        const allowChange = barrier();
        const allowReset = barrier();
        const changeCrypto = harness.app.nexus.crypto;
        const resetCrypto = other.app.nexus.crypto;
        const hashChange = changeCrypto.hashPassword.bind(changeCrypto);
        const hashReset = resetCrypto.hashPassword.bind(resetCrypto);
        t.mock.method(changeCrypto, 'hashPassword', async (password: string) => {
          const hash = await hashChange(password);
          changeReady.resolve();
          await allowChange.promise;
          return hash;
        });
        t.mock.method(resetCrypto, 'hashPassword', async (password: string) => {
          const hash = await hashReset(password);
          resetReady.resolve();
          await allowReset.promise;
          return hash;
        });

        // Both callers read the old state before either commits. The barriers
        // are outside transactions and never await another context's store call.
        const changing = harness.services.users.updateMe(user, {
          current_password: TEST_PASSWORD,
          new_password: CHANGED_PASSWORD,
        });
        const resetting = other.services.auth.resetPassword(token, RESET_PASSWORD, CONTEXT);
        const outcomes = Promise.allSettled([changing, resetting]);
        try {
          await Promise.all([changeReady.promise, resetReady.promise]);
          if (changeFirst) {
            allowChange.resolve();
            await changing;
            allowReset.resolve();
          } else {
            allowReset.resolve();
            await resetting;
            allowChange.resolve();
          }
          const [change, reset] = await outcomes;
          assert.equal(change.status, changeFirst ? 'fulfilled' : 'rejected');
          assert.equal(reset.status, changeFirst ? 'rejected' : 'fulfilled');
          if (change.status === 'fulfilled') {
            assert.ok(change.value.reissued);
            assert.ok(
              await harness.store.sessions.findByTokenHash(
                change.value.reissued.session.token_hash,
              ),
            );
          } else {
            assert.ok(isNexusError(change.reason));
            assert.equal(change.reason.code, 'FORBIDDEN');
          }
          if (reset.status === 'rejected') {
            assert.ok(isNexusError(reset.reason));
            assert.equal(reset.reason.code, 'VALIDATION_FAILED');
          }
          await assertPassword(session, changeFirst ? CHANGED_PASSWORD : RESET_PASSWORD);
          assert.equal(await findToken(token, 'password_reset'), null);
          assert.equal((await findToken(verification, 'email_verification'))?.used_at, null);
        } finally {
          allowChange.resolve();
          allowReset.resolve();
          await outcomes;
        }
      });
    }

    it('commits before issuing the replacement and holds the lease through issuance', async (t) => {
      const session = await harness.registerUser();
      const user = await harness.store.users.findById(session.user.id);
      assert.ok(user);
      const token = await seedToken(session);
      const originalTransaction = harness.store.transaction.bind(harness.store);
      let committed = false;
      t.mock.method(
        harness.store,
        'transaction',
        async <T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> => {
          const result = await originalTransaction(fn);
          committed = true;
          return result;
        },
      );
      const issue = harness.services.auth.issueSession.bind(harness.services.auth);
      t.mock.method(
        harness.services.auth,
        'issueSession',
        async (updated: UserRecord, context: RequestContext): Promise<IssuedSession> => {
          assert.equal(committed, true, 'issuance must follow the committed transaction');
          assert.equal(await findToken(token, 'password_reset'), null);
          const now = new Date().toISOString();
          assert.equal(
            await harness.store.leases.acquire(
              `users:password:${user.id}`,
              'competing-password-change',
              isoInSeconds(60),
              now,
            ),
            false,
            'another password change cannot acquire the lease before issuance finishes',
          );
          return issue(updated, context);
        },
      );
      const result = await harness.services.users.updateMe(user, {
        current_password: TEST_PASSWORD,
        new_password: CHANGED_PASSWORD,
      });
      assert.ok(result.reissued);
    });

    for (const reset of [false, true]) {
      const operationName = reset ? 'reset' : 'change';
      it(`rolls back password, tokens and sessions on failed ${operationName}`, async (t) => {
        const session = await harness.registerUser();
        const user = await harness.store.users.findById(session.user.id);
        assert.ok(user);
        const token = await seedToken(session);
        const extra = await seedToken(session);
        const verification = await seedToken(session, 'email_verification');
        const before = await findToken(token, 'password_reset');
        const originalTransaction = harness.store.transaction.bind(harness.store);
        const failure = new Error('injected session persistence failure');
        const transaction = t.mock.method(
          harness.store,
          'transaction',
          async <T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> =>
            originalTransaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(target, property, receiver) {
                    if (property === 'sessions') {
                      return {
                        ...target.sessions,
                        deleteForUser: async (userId: string): Promise<number> => {
                          await target.sessions.deleteForUser(userId);
                          throw failure;
                        },
                      };
                    }
                    return Reflect.get(target, property, receiver);
                  },
                }),
              ),
            ),
        );
        const issueSession = t.mock.method(harness.services.auth, 'issueSession');
        const operation = reset
          ? harness.services.auth.resetPassword(token, RESET_PASSWORD, CONTEXT)
          : harness.services.users.updateMe(user, {
              current_password: TEST_PASSWORD,
              new_password: CHANGED_PASSWORD,
            });
        await assert.rejects(operation, (error) => error === failure);
        transaction.mock.restore();
        assert.equal(issueSession.mock.callCount(), 0, 'no replacement on a failed change');
        assert.deepEqual(await harness.store.users.findById(user.id), user);
        assert.deepEqual(await findToken(token, 'password_reset'), before);
        assert.equal((await findToken(extra, 'password_reset'))?.used_at, null);
        assert.equal((await findToken(verification, 'email_verification'))?.used_at, null);
        assert.ok(
          await harness.store.sessions.findByTokenHash(
            harness.app.nexus.crypto.hashToken(session.sessionToken),
          ),
        );
        await assertPassword(session, TEST_PASSWORD);
        await harness.services.auth.resetPassword(token, RESET_PASSWORD, CONTEXT);
        await assertPassword(session, RESET_PASSWORD);
      });
    }
  });
}
