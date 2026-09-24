/**
 * A sign-in whose password stops being the account's password while it is
 * being checked must not come away with a session (issue #325).
 *
 * `login` verifies the password with nothing held — scrypt takes ~100 ms —
 * and a reset or self-service change that commits in that window deletes every
 * session of the account. The sign-in used to issue its session afterwards
 * regardless, leaving a live session minted from the old password: exactly the
 * thing a reset is for getting rid of. Each case here commits the competing
 * change from inside the stubbed `verifyPassword`, i.e. after the old password
 * matched and before the session was issued.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';

import type { ApiErrorBody } from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { isoInSeconds } from '../lib/ids.js';
import { buildTestApp, TEST_PASSWORD, type TestApp, type TestSession } from './helpers.js';

const NEW_PASSWORD = 'a-password-set-mid-sign-in';
const CONTEXT = { ip: null, userAgent: null };

describe('sign-in racing a password change', () => {
  let harness: TestApp;

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser();
  });

  after(async () => {
    await harness?.close();
  });

  /**
   * Run `during` once, right after the next successful check of
   * {@link TEST_PASSWORD} — the gap between verification and issuance.
   */
  function interleave(t: TestContext, during: () => Promise<void>): void {
    const crypto = harness.app.nexus.crypto;
    const verify = crypto.verifyPassword.bind(crypto);
    let pending = true;
    t.mock.method(crypto, 'verifyPassword', async (password: string, hash: string) => {
      const ok = await verify(password, hash);
      if (ok && pending && password === TEST_PASSWORD) {
        pending = false;
        await during();
      }
      return ok;
    });
  }

  async function signIn(session: TestSession): Promise<{ status: number; code?: string }> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: session.user.email, password: TEST_PASSWORD },
    });
    return response.statusCode === 200
      ? { status: 200 }
      : { status: response.statusCode, code: response.json<ApiErrorBody>().error.code };
  }

  it('refuses the sign-in when a reset commits between verification and issuance', async (t) => {
    const session = await harness.registerUser();
    const token = harness.app.nexus.crypto.newSessionToken();
    await harness.store.verificationTokens.create({
      user_id: session.user.id,
      token_hash: harness.app.nexus.crypto.hashToken(token),
      purpose: 'password_reset',
      expires_at: isoInSeconds(3600),
    });
    interleave(t, () => harness.services.auth.resetPassword(token, NEW_PASSWORD, CONTEXT));

    assert.deepEqual(await signIn(session), { status: 401, code: 'UNAUTHORIZED' });
    // The reset ended every session; nothing may have been minted after it.
    assert.equal(await harness.store.sessions.deleteForUser(session.user.id), 0);
    assert.equal(
      (await harness.auditRows(AuditAction.AUTH_LOGIN)).filter(
        (row) => row.target_id === session.user.id,
      ).length,
      0,
      'a refused sign-in is not audited as one',
    );
  });

  it('refuses the sign-in when a self-service change commits in the same gap', async (t) => {
    const session = await harness.registerUser();
    const user = await harness.store.users.findById(session.user.id);
    assert.ok(user);
    let reissued = 0;
    interleave(t, async () => {
      const result = await harness.services.users.updateMe(user, {
        current_password: TEST_PASSWORD,
        new_password: NEW_PASSWORD,
      });
      if (result.reissued) reissued += 1;
    });

    assert.deepEqual(await signIn(session), { status: 401, code: 'UNAUTHORIZED' });
    // Only the changer's own replacement session survives.
    assert.equal(reissued, 1);
    assert.equal(await harness.store.sessions.deleteForUser(session.user.id), 1);
    await harness.loginUser(session.user.email, NEW_PASSWORD);
  });

  it('refuses the sign-in when the account is disabled in the same gap', async (t) => {
    const session = await harness.registerUser();
    interleave(t, async () => {
      await harness.store.users.update(session.user.id, { status: 'disabled' });
      await harness.store.sessions.deleteForUser(session.user.id);
    });

    assert.deepEqual(await signIn(session), { status: 403, code: 'USER_DISABLED' });
    assert.equal(await harness.store.sessions.deleteForUser(session.user.id), 0);
  });

  it('still signs in when nothing changed underneath it', async () => {
    const session = await harness.registerUser();
    await harness.loginUser(session.user.email);
  });
});
