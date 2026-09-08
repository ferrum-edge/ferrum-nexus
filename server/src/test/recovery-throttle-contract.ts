/**
 * A failed recovery-link mint must leave the throttle window unspent, and must
 * be indistinguishable from every other outcome (issue #137).
 *
 * The claim on `email_token_issue_claims` used to commit before, and outside,
 * the transaction that mints the token, so any failure between the two spent
 * the user's ten-minute window on an issuance that never happened: the retry
 * took the throttle's early-return path, answered the documented uniform `200`,
 * and sent nothing. The escaping `500` was also an existence oracle — only an
 * address with an account reaches the mint, so a partially failing store
 * answered `500` for a real address and `200` for an unknown one.
 *
 * Cross-adapter because the fix moves a write into a transaction that now spans
 * two tables — two *collections* on Mongo, where covering both needs the replica
 * set's multi-document transaction. A standalone Mongo degrades to serialised,
 * non-atomic execution by design (`NEXUS_DB_ALLOW_STANDALONE`), and there the
 * claim cannot roll back with the mint; the smoke suite runs Mongo as a replica
 * set, which is the configuration this contract describes.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ForgotPasswordResponse } from '@ferrum-nexus/shared';

import type { NexusStore } from '../db/store.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** The body both endpoints must produce, whatever they decided. */
const OK_BODY = { ok: true };

/** Exercise the recovery endpoints against each smoke-suite adapter. */
export function runRecoveryThrottleContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`recovery throttle contract — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let harness: TestApp;
    let faults: FaultInjectingStore;
    let counter = 0;

    before(async () => {
      target = await makeStore();
      faults = faultInjectingStore(target.store);
      harness = await buildTestApp({ store: target.store, wrapStore: () => faults.store });
      await harness.registerUser({ email: 'recovery-founder@example.test' });
    });

    after(async () => {
      await harness?.close();
      await target?.teardown();
    });

    /** A fresh account whose windows nothing else has spent. */
    async function freshUser(): Promise<TestSession> {
      counter += 1;
      return harness.registerUser({
        email: `recovery-${label}-${counter}@example.test`,
        role: 'client',
      });
    }

    /** Ask for a link and assert the one answer the endpoint is allowed to give. */
    async function ask(url: string, email: string): Promise<string> {
      const response = await harness.app.inject({ method: 'POST', url, payload: { email } });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json<ForgotPasswordResponse>(), OK_BODY);
      return response.body;
    }

    /**
     * Recovery links queued for `email`, by outbox idempotency key.
     *
     * Keyed rather than counted by address because registration queues a
     * `verify:<user_id>` message of its own; a re-sent link is
     * `verify:<token_id>`, and a reset link is `reset:<token_id>`. Filtering on
     * the prefix — and, for a resend, excluding the registration's own key —
     * counts only what the endpoint under test issued.
     */
    async function mailFor(email: string, prefix: string, exclude?: string): Promise<number> {
      return (await harness.outbox()).filter(
        (row) =>
          row.to_email === email &&
          row.idempotency_key !== null &&
          row.idempotency_key.startsWith(prefix) &&
          row.idempotency_key !== exclude,
      ).length;
    }

    /** Reset links queued for `email`. */
    async function resetMailFor(email: string): Promise<number> {
      return mailFor(email, 'reset:');
    }

    /** Re-sent verification links for `user`, never its registration message. */
    async function resendMailFor(user: TestSession): Promise<number> {
      return mailFor(user.user.email, 'verify:', `verify:${user.user.id}`);
    }

    async function resetRows(userId: string): Promise<number> {
      return (await harness.auditRows('auth.password_reset_request')).filter(
        (row) => row.actor_user_id === userId,
      ).length;
    }

    it('does not spend the reset window on a mint that failed', async () => {
      const user = await freshUser();

      // The mint write inside the transaction. Everything before it — the
      // lookup, the throttle read — succeeds, so the claim is reached.
      faults.failNext('verificationTokens', 'create', new Error('injected mint failure'));
      const answer = await ask('/api/auth/forgot-password', user.user.email);
      assert.deepEqual(faults.pending(), [], 'the injected fault fired');
      assert.equal(await resetMailFor(user.user.email), 0, 'the failed attempt sent nothing');
      assert.equal(await resetRows(user.user.id), 0, 'and audited nothing');

      // The retry is the whole point: the window was never spent, so this one
      // mints and delivers.
      const retried = await ask('/api/auth/forgot-password', user.user.email);
      assert.equal(retried, answer, 'byte-identical to the failed attempt');
      assert.equal(await resetMailFor(user.user.email), 1, 'the retry delivered a link');
      assert.equal(await resetRows(user.user.id), 1);
    });

    it('answers a store fault exactly as it answers an address it has never seen', async () => {
      const user = await freshUser();

      faults.failNext('verificationTokens', 'create', new Error('injected mint failure'));
      const underFault = await ask('/api/auth/forgot-password', user.user.email);
      const unknown = await ask('/api/auth/forgot-password', `nobody-${counter}@example.test`);
      const disabled = await freshUser();
      await harness.store.users.update(disabled.user.id, { status: 'disabled' });
      const inactive = await ask('/api/auth/forgot-password', disabled.user.email);

      assert.equal(underFault, unknown, 'a real address under fault reads as an unknown one');
      assert.equal(underFault, inactive, 'and as a disabled one');

      // A genuine throttle is the fourth outcome and reads the same.
      await ask('/api/auth/forgot-password', user.user.email);
      const throttled = await ask('/api/auth/forgot-password', user.user.email);
      assert.equal(throttled, underFault);
      assert.equal(
        await resetMailFor(user.user.email),
        1,
        'the throttle still issues exactly one link',
      );
    });

    it('keeps the resend window unspent when its mint fails', async () => {
      const user = await freshUser();
      // Registration may already have queued a link of its own, and a live one
      // is itself a reason to send nothing. Clear it so the resend is reached,
      // and make sure the account still counts as unverified.
      await harness.store.verificationTokens.deleteForUser(user.user.id, 'email_verification');
      await harness.store.users.update(user.user.id, { email_verified: false });
      const before = await resendMailFor(user);

      faults.failNext('verificationTokens', 'create', new Error('injected mint failure'));
      await ask('/api/auth/resend-verification', user.user.email);
      assert.deepEqual(faults.pending(), [], 'the injected fault fired');
      assert.equal(await resendMailFor(user), before, 'the failed attempt sent nothing');

      await ask('/api/auth/resend-verification', user.user.email);
      assert.equal(await resendMailFor(user), before + 1, 'the retry delivered a link');
    });

    it('still issues exactly one link for concurrent requests', async () => {
      const user = await freshUser();
      const answers = await Promise.all([
        harness.app.inject({
          method: 'POST',
          url: '/api/auth/forgot-password',
          payload: { email: user.user.email },
        }),
        harness.app.inject({
          method: 'POST',
          url: '/api/auth/forgot-password',
          payload: { email: user.user.email },
        }),
      ]);
      for (const answer of answers) assert.equal(answer.statusCode, 200, answer.body);
      assert.equal(await resetMailFor(user.user.email), 1, 'the claim still elects one winner');
      assert.equal(await resetRows(user.user.id), 1);
    });
  });
}
