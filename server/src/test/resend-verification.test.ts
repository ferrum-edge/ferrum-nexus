/**
 * Re-sending a verification link.
 *
 * Registration mails the link exactly once, so a visitor who loses it used to
 * have no way back into their own account. The resend endpoint fixes that
 * without becoming an oracle: like `forgot-password`, it answers the same thing
 * to an unknown address, a disabled account, an already-verified one and a
 * request inside the throttle window.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { type RegisterResponse, type ResendVerificationResponse } from '@ferrum-nexus/shared';

import { REGISTRATION_SETTINGS_KEY } from '../auth/service.js';
import { buildTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

/** The body every `resend-verification` call must produce. */
const OK_BODY = { ok: true };

describe('verification resend', () => {
  let harness: TestApp;

  async function resend(email: string): Promise<void> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/resend-verification',
      payload: { email },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json<ResendVerificationResponse>(), OK_BODY);
  }

  async function mailFor(email: string): Promise<string[]> {
    const rows = await harness.outbox();
    return rows.filter((row) => row.to_email === email).map((row) => row.body_text);
  }

  /** Register an account that must verify before it can sign in. */
  async function registerUnverified(email: string): Promise<RegisterResponse> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: TEST_PASSWORD, display_name: 'Unverified', role: 'client' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<RegisterResponse>();
  }

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'founder@example.test' });
    await harness.store.settings.set(
      REGISTRATION_SETTINGS_KEY,
      {
        open_registration: true,
        require_email_verification: true,
        allowed_roles: ['client', 'provider'],
      },
      false,
    );
  });

  after(async () => {
    await harness.close();
  });

  it('mails a fresh link that verifies the account, and supersedes the old one', async () => {
    const registered = await registerUnverified('lost-the-link@example.test');
    assert.equal(registered.email_verification_required, true);

    // Registration already queued one, so an immediate resend is throttled.
    assert.equal((await mailFor('lost-the-link@example.test')).length, 1);
    await resend('lost-the-link@example.test');
    assert.equal(
      (await mailFor('lost-the-link@example.test')).length,
      1,
      'the throttled resend queued nothing',
    );

    await harness.tick();
    const first = harness.mailbox.sent.find((mail) => mail.to === 'lost-the-link@example.test');
    assert.ok(first);
    const firstToken = /\/verify-email\?token=([A-Za-z0-9_-]+)/.exec(first.text)?.[1] ?? '';
    assert.ok(firstToken);

    // Age the registration token past the throttle window so the resend runs
    // for real, without making the test wait ten minutes.
    const user = await harness.store.users.findByEmail('lost-the-link@example.test');
    assert.ok(user);
    const stale = await harness.store.verificationTokens.findByTokenHash(
      harness.app.nexus.crypto.hashToken(firstToken),
      'email_verification',
    );
    assert.ok(stale);
    await harness.store.verificationTokens.deleteForUser(user.id, 'email_verification');
    await harness.store.verificationTokens.create({
      id: stale.id,
      user_id: stale.user_id,
      token_hash: stale.token_hash,
      purpose: 'email_verification',
      expires_at: stale.expires_at,
      created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    });

    await resend('lost-the-link@example.test');
    const queued = await mailFor('lost-the-link@example.test');
    assert.equal(queued.length, 2, 'a second link was queued once the window had passed');

    await harness.tick();
    const second = harness.mailbox.sent
      .filter((mail) => mail.to === 'lost-the-link@example.test')
      .at(-1);
    assert.ok(second);
    const secondToken = /\/verify-email\?token=([A-Za-z0-9_-]+)/.exec(second.text)?.[1] ?? '';
    assert.notEqual(secondToken, firstToken, 'the resend minted a new token');

    // Superseded: only one verification link for an address is ever live.
    const supersededAttempt = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token: firstToken },
    });
    assert.equal(supersededAttempt.statusCode, 400, supersededAttempt.body);

    const verified = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token: secondToken },
    });
    assert.equal(verified.statusCode, 200, verified.body);

    const signedIn = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'lost-the-link@example.test', password: TEST_PASSWORD },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);

    assert.ok(
      (await harness.auditRows('auth.verification_resend')).some(
        (row) => row.target_id === user.id,
      ),
      'the issued link is audited',
    );
  });

  it('answers an address with no account exactly as it answers a real one', async () => {
    const before = (await harness.outbox()).length;
    await resend('never-registered@example.test');
    assert.equal((await harness.outbox()).length, before);
  });

  it('queues nothing for an account that is already verified', async () => {
    await resend('founder@example.test');

    assert.equal((await mailFor('founder@example.test')).length, 0);
    const founder = await harness.store.users.findByEmail('founder@example.test');
    assert.ok(founder);
    assert.equal(
      (await harness.auditRows('auth.verification_resend')).some(
        (row) => row.target_id === founder.id,
      ),
      false,
    );
  });

  it('queues nothing for a disabled account', async () => {
    const registered = await registerUnverified('disabled-unverified@example.test');
    await harness.store.users.update(registered.user.id, { status: 'disabled' });
    const before = (await mailFor('disabled-unverified@example.test')).length;

    await resend('disabled-unverified@example.test');

    assert.equal((await mailFor('disabled-unverified@example.test')).length, before);
  });
});
