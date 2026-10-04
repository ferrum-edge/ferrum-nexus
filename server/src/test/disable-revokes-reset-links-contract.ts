/**
 * Disabling an account revokes its outstanding password-reset links in the same
 * transaction as the status flip (issue #499).
 *
 * While an account is disabled, `POST /api/auth/reset-password` refuses every
 * link it holds. But a disable used to leave the token rows in place, so an
 * administrator re-enabling the account inside the link's one-hour lifetime
 * revived a recovery capability the disable was meant to end. Both disable
 * paths — `PATCH /api/users/:id` and `POST /api/admin/god/disable-user` — now
 * delete the account's `password_reset` tokens in the transaction that writes
 * `status = 'disabled'`, and the re-enable deletes any token still present, so a
 * stale link from an older version cannot be redeemed either. Issuance races
 * are exercised through the real preparation path in reset-lifecycle-contract.
 *
 * Cross-adapter: the delete shares one transaction with the status write and
 * the session cut-off, which on Mongo is a multi-document transaction the
 * smoke suite's replica set provides. A case drives each disable path, one
 * proves the re-enable cleanup, and a final one injects a failure in the token
 * delete and proves the whole transition rolls back, which is what
 * distinguishes a same-transaction delete from one that merely runs close to
 * the flip.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { type ApiErrorBody } from '@ferrum-nexus/shared';

import type { NexusStore } from '../db/store.js';
import { isoInSeconds, newId } from '../lib/ids.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** The replacement password every redemption attempt in this suite sends. */
const NEW_PASSWORD = 'a-brand-new-passphrase-here';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

/** Exercise disable-revokes-reset-links against each smoke-suite adapter. */
export function runDisableRevokesResetLinksContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`disable revokes reset links — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let harness: TestApp;
    let faults: FaultInjectingStore;
    let founder: TestSession;
    let counter = 0;

    before(async () => {
      target = await makeStore();
      faults = faultInjectingStore(target.store);
      harness = await buildTestApp({ store: target.store, wrapStore: () => faults.store });
      founder = await harness.registerUser({ email: 'revoke-founder@example.test' });
    });

    after(async () => {
      await harness?.close();
      await target?.teardown();
    });

    /** A fresh non-admin account whose recovery state nothing else has touched. */
    async function freshTarget(): Promise<TestSession> {
      counter += 1;
      return harness.registerUser({
        email: `revoke-reset-${label}-${counter}@example.test`,
        role: 'client',
      });
    }

    /** Mint a live reset token with a plaintext the test can redeem by hand. */
    async function issueReset(user: TestSession): Promise<{ token: string; hash: string }> {
      const token = `reset-link-${newId()}`;
      const hash = harness.app.nexus.crypto.hashToken(token);
      await harness.store.verificationTokens.create({
        user_id: user.user.id,
        token_hash: hash,
        purpose: 'password_reset',
        expires_at: isoInSeconds(3600),
      });
      return { token, hash };
    }

    function patchStatus(
      session: TestSession,
      subject: TestSession,
      status: 'active' | 'disabled',
    ) {
      return harness.authed(session, {
        method: 'PATCH',
        url: `/api/users/${subject.user.id}`,
        payload: { status },
      });
    }

    function redeem(token: string) {
      return harness.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, new_password: NEW_PASSWORD },
      });
    }

    it('a PATCH disable kills a live reset link even after re-enable', async () => {
      const subject = await freshTarget();
      const { token, hash } = await issueReset(subject);

      const disabled = await patchStatus(founder, subject, 'disabled');
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal(
        await harness.store.verificationTokens.findByTokenHash(hash, 'password_reset'),
        null,
        'the disable transaction deleted the outstanding reset link',
      );

      const enabled = await patchStatus(founder, subject, 'active');
      assert.equal(enabled.statusCode, 200, enabled.body);

      const reset = await redeem(token);
      assert.equal(reset.statusCode, 400, reset.body);
      assert.equal(errorCode(reset.body), 'VALIDATION_FAILED');
    });

    it('re-enabling revokes a reset link that appeared while the account was off', async () => {
      const subject = await freshTarget();
      const disabled = await patchStatus(founder, subject, 'disabled');
      assert.equal(disabled.statusCode, 200, disabled.body);

      // A link present while the account is disabled is stale by definition: a
      // leftover from a version whose issuance did not take the lifecycle key.
      // Re-enabling must not revive it, so the re-enable deletes it too.
      const { token, hash } = await issueReset(subject);
      assert.ok(
        await harness.store.verificationTokens.findByTokenHash(hash, 'password_reset'),
        'the seed link is live on the disabled account',
      );

      const enabled = await patchStatus(founder, subject, 'active');
      assert.equal(enabled.statusCode, 200, enabled.body);
      assert.equal(
        await harness.store.verificationTokens.findByTokenHash(hash, 'password_reset'),
        null,
        'the re-enable deleted the stale reset link',
      );

      const reset = await redeem(token);
      assert.equal(reset.statusCode, 400, reset.body);
      assert.equal(errorCode(reset.body), 'VALIDATION_FAILED');
    });

    it('the god-mode disable deletes a live reset link too', async () => {
      const subject = await freshTarget();
      const { token, hash } = await issueReset(subject);

      const disabled = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/god/disable-user',
        payload: { user_id: subject.user.id, reason: 'Revoke recovery', revoke_grants: false },
      });
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal(
        await harness.store.verificationTokens.findByTokenHash(hash, 'password_reset'),
        null,
      );

      const enabled = await patchStatus(founder, subject, 'active');
      assert.equal(enabled.statusCode, 200, enabled.body);
      assert.equal((await redeem(token)).statusCode, 400);
    });

    it('a failure deleting the link rolls the whole disable back', async () => {
      const subject = await freshTarget();
      const { token, hash } = await issueReset(subject);

      faults.failNext('verificationTokens', 'deleteForUser', new Error('injected delete failure'));
      const disabled = await patchStatus(founder, subject, 'disabled');
      assert.equal(disabled.statusCode, 500, disabled.body);
      assert.deepEqual(faults.pending(), [], 'the injected fault fired');
      assert.equal(
        (await harness.store.users.findById(subject.user.id))?.status,
        'active',
        'the status flip rolled back with the link delete',
      );
      assert.ok(
        await harness.store.verificationTokens.findByTokenHash(hash, 'password_reset'),
        'the link is still live',
      );

      // Nothing else about the transition stuck: the account still has its
      // session, and a second attempt without the fault revokes the link.
      const me = await harness.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: subject.cookieHeader },
      });
      assert.equal(me.statusCode, 200, me.body);

      const retry = await patchStatus(founder, subject, 'disabled');
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(
        await harness.store.verificationTokens.findByTokenHash(hash, 'password_reset'),
        null,
      );
    });
  });
}
