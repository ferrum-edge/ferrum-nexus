/**
 * Forgot-password to signed-in-again, end to end through the outbox.
 *
 * Two properties are load-bearing here and both are asserted rather than
 * assumed: the endpoint's answer is the same for every input, so it cannot be
 * used to discover which addresses have accounts; and a redeemed link burns
 * itself, changes the password and destroys every session in one step.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { type ApiErrorBody, type ForgotPasswordResponse } from '@ferrum-nexus/shared';

import { isoInSeconds } from '../lib/ids.js';
import { buildTestApp, TEST_PASSWORD, type TestApp, type TestSession } from './helpers.js';

/** The body every `forgot-password` call must produce, whatever it decided. */
const OK_BODY = { ok: true };

const NEW_PASSWORD = 'a-brand-new-passphrase-entirely';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('password reset', () => {
  let harness: TestApp;
  let owner: TestSession;

  /** Ask for a reset link and assert the invariant response. */
  async function forgotPassword(email: string): Promise<void> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json<ForgotPasswordResponse>(), OK_BODY);
  }

  /** Outbox rows addressed to `email`, oldest first. */
  async function mailFor(email: string): Promise<string[]> {
    const rows = await harness.outbox();
    return rows.filter((row) => row.to_email === email).map((row) => row.body_text);
  }

  /** Pull the reset token out of a delivered message. */
  function tokenIn(text: string): string {
    const match = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(text);
    assert.ok(match, `no reset link in message: ${text}`);
    return match[1] ?? '';
  }

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'founder@example.test' });
    owner = await harness.registerUser({ email: 'forgetful@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  it('emails a working link, then burns it, the sessions and the old password', async () => {
    await forgotPassword('forgetful@example.test');

    const queued = await mailFor('forgetful@example.test');
    assert.equal(queued.length, 1, 'exactly one reset message was queued');

    // A second ask inside the throttle window is answered identically and
    // queues nothing: the endpoint must not be usable to flood an inbox.
    await forgotPassword('forgetful@example.test');
    assert.equal(
      (await mailFor('forgetful@example.test')).length,
      1,
      'the throttled request queued no second message',
    );

    const tick = await harness.tick();
    assert.ok(tick.sent >= 1);
    const delivered = harness.mailbox.sent.find((mail) => mail.to === 'forgetful@example.test');
    assert.ok(delivered, 'the transport received the reset mail');
    assert.ok(
      delivered.html.includes(`${harness.config.publicUrl}/reset-password?token=`),
      'the html body carries the reset link',
    );
    const token = tokenIn(delivered.text);

    const reset = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: NEW_PASSWORD },
    });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.deepEqual(reset.json(), OK_BODY);

    // Whoever prompted the reset must not still be holding a live session.
    const stale = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: owner.cookieHeader },
    });
    assert.equal(stale.statusCode, 401, 'the pre-reset session is gone');

    const oldPassword = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'forgetful@example.test', password: TEST_PASSWORD },
    });
    assert.equal(oldPassword.statusCode, 401, 'the old password no longer works');

    const signedIn = await harness.loginUser('forgetful@example.test', NEW_PASSWORD);
    assert.equal(signedIn.user.email, 'forgetful@example.test');
    assert.equal(
      signedIn.user.email_verified,
      true,
      'redeeming a link mailed to the address proves the mailbox',
    );

    // Single use: the same link is refused with the same generic rejection an
    // unknown token gets, so a replay cannot tell it apart from a guess.
    const replay = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: 'yet-another-passphrase-here' },
    });
    assert.equal(replay.statusCode, 400, replay.body);
    assert.equal(errorCode(replay.body), 'VALIDATION_FAILED');

    const requested = await harness.auditRows('auth.password_reset_request');
    assert.equal(
      requested.filter((row) => row.target_id === owner.user.id).length,
      1,
      'the issued link is audited once — the throttled retry is not',
    );
    const performed = await harness.auditRows('auth.password_reset');
    assert.ok(performed.some((row) => row.target_id === owner.user.id));
  });

  it('answers an address with no account exactly as it answers a real one', async () => {
    const before = (await harness.outbox()).length;

    await forgotPassword('nobody-here@example.test');

    assert.equal(
      (await harness.outbox()).length,
      before,
      'nothing was queued for an address with no account',
    );
    assert.equal((await mailFor('nobody-here@example.test')).length, 0);
  });

  it('answers a disabled account the same way, and queues nothing', async () => {
    const session = await harness.registerUser({ email: 'suspended@example.test' });
    await harness.store.users.update(session.user.id, { status: 'disabled' });

    await forgotPassword('suspended@example.test');

    assert.equal((await mailFor('suspended@example.test')).length, 0);
    assert.equal(
      (await harness.auditRows('auth.password_reset_request')).some(
        (row) => row.target_id === session.user.id,
      ),
      false,
      'and nothing in the log claims a link was issued',
    );
  });

  it('refuses an expired link', async () => {
    const session = await harness.registerUser({ email: 'too-slow@example.test' });
    const token = 'an-expired-password-reset-token-value';
    await harness.store.verificationTokens.create({
      user_id: session.user.id,
      token_hash: harness.app.nexus.crypto.hashToken(token),
      purpose: 'password_reset',
      expires_at: isoInSeconds(-60),
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: NEW_PASSWORD },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(errorCode(response.body), 'VALIDATION_FAILED');
  });

  it('refuses a token minted for the other flow', async () => {
    const session = await harness.registerUser({ email: 'crossed-wires@example.test' });
    const token = 'a-verification-token-not-a-reset-one';
    await harness.store.verificationTokens.create({
      user_id: session.user.id,
      token_hash: harness.app.nexus.crypto.hashToken(token),
      purpose: 'email_verification',
      expires_at: isoInSeconds(3600),
    });

    // A 24-hour verification link must not be spendable as a password reset:
    // that would turn "can read this mailbox once" into "can take the account
    // over a day later".
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: NEW_PASSWORD },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(errorCode(response.body), 'VALIDATION_FAILED');
    assert.equal(
      (await harness.store.users.findById(session.user.id))?.password_hash,
      (await harness.store.users.findByEmail('crossed-wires@example.test'))?.password_hash,
    );
    const stillWorks = await harness.loginUser('crossed-wires@example.test');
    assert.ok(stillWorks.sessionToken, 'the account still has its original password');
  });

  it('rejects a new password below the minimum length before touching the token', async () => {
    const session = await harness.registerUser({ email: 'short-password@example.test' });
    const token = 'a-perfectly-valid-reset-token-value';
    await harness.store.verificationTokens.create({
      user_id: session.user.id,
      token_hash: harness.app.nexus.crypto.hashToken(token),
      purpose: 'password_reset',
      expires_at: isoInSeconds(3600),
    });

    const rejected = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: 'short' },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(errorCode(rejected.body), 'VALIDATION_FAILED');

    // The link survives the mistake — spending it on a rejected password would
    // strand the user with no way back in.
    const accepted = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: NEW_PASSWORD },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
  });
});
