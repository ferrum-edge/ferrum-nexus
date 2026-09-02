import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SESSION_COOKIE, type ApiErrorBody, type RegisterResponse } from '@ferrum-nexus/shared';

import { REGISTRATION_SETTINGS_KEY } from '../auth/service.js';
import type { UserRepo } from '../db/store.js';
import { buildTestApp, cookieValue, TEST_PASSWORD, type TestApp } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('register to verified, end to end through the outbox', () => {
  let harness: TestApp;

  before(async () => {
    harness = await buildTestApp();
    // The founder bootstraps the platform and is verified by definition.
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

  it('emails a working verification link and unblocks sign-in when it is used', async () => {
    const registered = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'newcomer@example.test',
        password: TEST_PASSWORD,
        display_name: 'New Comer',
        role: 'client',
      },
    });
    assert.equal(registered.statusCode, 201);
    const body = registered.json<RegisterResponse>();
    assert.equal(body.email_verification_required, true);
    assert.equal(body.user.email_verified, false);
    assert.equal(cookieValue(registered, SESSION_COOKIE), undefined, 'no session yet');

    // Sign-in is refused until the link is used.
    const early = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'newcomer@example.test', password: TEST_PASSWORD },
    });
    assert.equal(early.statusCode, 403);
    assert.equal(errorCode(early.body), 'EMAIL_NOT_VERIFIED');

    // The verification email is queued, keyed per user, and not yet sent.
    const queued = (await harness.outbox()).filter(
      (row) => row.to_email === 'newcomer@example.test',
    );
    assert.equal(queued.length, 1);
    const message = queued[0];
    assert.equal(message?.idempotency_key, `verify:${body.user.id}`);
    assert.equal(message?.status, 'pending');
    assert.ok(message?.subject.includes('Verify'));

    // Deliver it.
    const tick = await harness.tick();
    assert.equal(tick.sent, 1);
    const delivered = harness.mailbox.sent.find((mail) => mail.to === 'newcomer@example.test');
    assert.ok(delivered, 'the transport received the verification mail');

    const link = /\/verify-email\?token=([A-Za-z0-9_-]+)/.exec(delivered.text);
    assert.ok(link, 'the text body carries the verification link');
    assert.ok(
      delivered.html.includes(`${harness.config.publicUrl}/verify-email?token=`),
      'so does the html body',
    );
    const token = link[1] ?? '';

    const verified = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token },
    });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.json<{ verified: boolean }>().verified, true);

    const signedIn = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'newcomer@example.test', password: TEST_PASSWORD },
    });
    assert.equal(signedIn.statusCode, 200);
    assert.ok(cookieValue(signedIn, SESSION_COOKIE));

    // The token is single-use.
    const replay = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token },
    });
    assert.equal(replay.statusCode, 409);
  });

  it('does not spend the verification token when the account update fails', async () => {
    const email = 'flaky-verify@example.test';
    const registered = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: TEST_PASSWORD, display_name: 'Flaky', role: 'client' },
    });
    assert.equal(registered.statusCode, 201, registered.body);

    await harness.tick();
    const delivered = harness.mailbox.sent.find((mail) => mail.to === email);
    assert.ok(delivered, 'the verification mail was delivered');
    const token = /\/verify-email\?token=([A-Za-z0-9_-]+)/.exec(delivered.text)?.[1] ?? '';
    assert.ok(token);

    // Fail the account update exactly once, after the token has been burned.
    // There is no resend endpoint, so a burn that outlives its own purpose
    // locks the account out of the portal permanently.
    const users: UserRepo = harness.store.users;
    const realUpdate = users.update.bind(users);
    let attempts = 0;
    users.update = async (id, patch) => {
      attempts += 1;
      if (attempts === 1) throw new Error('the users table went away mid-verification');
      return realUpdate(id, patch);
    };

    try {
      const failed = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/verify-email',
        payload: { token },
      });
      assert.equal(failed.statusCode, 500, failed.body);
    } finally {
      users.update = realUpdate;
    }

    assert.equal(
      (await harness.store.users.findByEmail(email))?.email_verified,
      false,
      'the account is still unverified, as the failure implies',
    );
    const row = await harness.store.verificationTokens.findByTokenHash(
      harness.app.nexus.crypto.hashToken(token),
      'email_verification',
    );
    assert.equal(row?.used_at, null, 'the burn rolled back with the update it was protecting');
    assert.equal(
      (await harness.auditRows('auth.verify_email')).some(
        (entry) => entry.target_id === registered.json<RegisterResponse>().user.id,
      ),
      false,
      'and no audit row claims a verification that did not happen',
    );

    // The retry is the whole point: the same link still works.
    const retried = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token },
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal((await harness.store.users.findByEmail(email))?.email_verified, true);

    const signedIn = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: TEST_PASSWORD },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
  });

  it('greets the new account with a welcome notification', async () => {
    const user = await harness.store.users.findByEmail('newcomer@example.test');
    assert.ok(user);
    const page = await harness.store.notifications.list({ user_id: user.id });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.type, 'system');
  });

  it('queues no verification mail when verification is switched off', async () => {
    await harness.store.settings.set(
      REGISTRATION_SETTINGS_KEY,
      {
        open_registration: true,
        require_email_verification: false,
        allowed_roles: ['client', 'provider'],
      },
      false,
    );
    const session = await harness.registerUser({ email: 'instant@example.test' });
    assert.equal(session.user.email_verified, true);
    const queued = (await harness.outbox()).filter(
      (row) => row.to_email === 'instant@example.test',
    );
    assert.equal(queued.length, 0);
  });
});
