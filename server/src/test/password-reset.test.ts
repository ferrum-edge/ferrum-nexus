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

import {
  consumerUsernameForApplication,
  consumerUsernameForUser,
  type ApiErrorBody,
  type ForgotPasswordResponse,
  type IssueCredentialResponse,
} from '@ferrum-nexus/shared';

import {
  ACCOUNT_RECOVERY_BLOCKING_ATTEMPTS,
  runAccountRecovery,
} from '../credentials/account-recovery.js';
import { isoInSeconds, newId } from '../lib/ids.js';
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

  /** Reset `userId`'s password through a fresh link, as a trusted reset does. */
  async function trustedReset(userId: string): Promise<void> {
    const token = newId();
    await harness.store.verificationTokens.create({
      user_id: userId,
      token_hash: harness.app.nexus.crypto.hashToken(token),
      purpose: 'password_reset',
      expires_at: isoInSeconds(3600),
    });
    const reset = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: NEW_PASSWORD },
    });
    assert.equal(reset.statusCode, 200, reset.body);
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

  it('revokes existing account and application credentials when reset proves the address', async () => {
    const account = await harness.registerUser({ email: 'reclaimed@example.test' });
    const applicationResponse = await harness.authed(account, {
      method: 'POST',
      url: '/api/applications',
      payload: { name: 'Old application' },
    });
    assert.equal(applicationResponse.statusCode, 201, applicationResponse.body);
    const applicationId = applicationResponse.json<{ application: { id: string } }>().application
      .id;

    const accountCredential = await harness.authed(account, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(accountCredential.statusCode, 201, accountCredential.body);
    const accountId = accountCredential.json<IssueCredentialResponse>().credential.id;
    const appCredential = await harness.authed(account, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', application_id: applicationId },
    });
    assert.equal(appCredential.statusCode, 201, appCredential.body);
    const appCredentialId = appCredential.json<IssueCredentialResponse>().credential.id;

    const token = newId();
    await harness.store.verificationTokens.create({
      user_id: account.user.id,
      token_hash: harness.app.nexus.crypto.hashToken(token),
      purpose: 'password_reset',
      expires_at: isoInSeconds(3600),
    });
    const reset = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: NEW_PASSWORD },
    });
    assert.equal(reset.statusCode, 200, reset.body);

    assert.equal((await harness.store.credentials.findById(accountId))?.status, 'revoked');
    assert.equal((await harness.store.credentials.findById(appCredentialId))?.status, 'revoked');
    assert.equal(
      harness.edge.consumerByUsername(`nexus-user-${account.user.id}`)?.credentials.keyauth
        ?.length,
      0,
    );
    assert.equal(
      harness.edge.consumerByUsername(consumerUsernameForApplication(applicationId))?.credentials
        .keyauth?.length,
      0,
    );
  });

  it('retries the recovery revocation when Edge fails, then revokes once it recovers', async () => {
    const account = await harness.registerUser({ email: 'delayed-recovery@example.test' });
    const credential = await harness.authed(account, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(credential.statusCode, 201, credential.body);
    const credentialId = credential.json<IssueCredentialResponse>().credential.id;

    const token = newId();
    await harness.store.verificationTokens.create({
      user_id: account.user.id,
      token_hash: harness.app.nexus.crypto.hashToken(token),
      purpose: 'password_reset',
      expires_at: isoInSeconds(3600),
    });
    // The gateway refuses the delete the recovery owes.
    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth/', 'DELETE');
    const reset = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: NEW_PASSWORD },
    });
    assert.equal(reset.statusCode, 200, reset.body);

    // The reset committed, the revocation did not: it is owed, and issuance is
    // blocked until it lands.
    assert.notEqual((await harness.store.credentials.findById(credentialId))?.status, 'revoked');
    assert.notEqual(await harness.store.accountRecoveryJobs.findByUser(account.user.id), null);
    const resignedIn = await harness.loginUser('delayed-recovery@example.test', NEW_PASSWORD);
    const blocked = await harness.authed(resignedIn, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'basicauth' },
    });
    assert.equal(blocked.statusCode, 409, blocked.body);

    // The worker retries against a recovered gateway and settles the debt.
    const tick = await harness.services.recovery.tick();
    assert.equal(tick.completed, 1);
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');
    assert.equal(await harness.store.accountRecoveryJobs.findByUser(account.user.id), null);
  });

  it('stops blocking issuance after repeated recovery failures, and audits it', async () => {
    const email = 'stuck-recovery@example.test';
    const account = await harness.registerUser({ email });
    const credential = await harness.authed(account, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(credential.statusCode, 201, credential.body);
    const credentialId = credential.json<IssueCredentialResponse>().credential.id;

    // The inline attempt fails: the gateway refuses the delete.
    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth/', 'DELETE');
    await trustedReset(account.user.id);
    const session = await harness.loginUser(email, NEW_PASSWORD);
    const issue = () =>
      harness.authed(session, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
    const stalledRows = async () =>
      (await harness.auditRows('credential.recovery_stalled')).filter(
        (row) => row.target_id === account.user.id,
      );

    // Every later attempt fails the same way, as a refusal that no retry can
    // change would.
    const failing = {
      revokeForAccountRecovery: async (): Promise<number> => {
        throw new Error('refused deterministically');
      },
    };
    const attempt = async () =>
      runAccountRecovery({
        credentials: failing,
        store: harness.store,
        audit: harness.services.audit,
        userId: account.user.id,
        job: await harness.store.accountRecoveryJobs.findByUser(account.user.id),
      });
    for (let attempts = 2; attempts <= ACCOUNT_RECOVERY_BLOCKING_ATTEMPTS; attempts += 1) {
      if (attempts === ACCOUNT_RECOVERY_BLOCKING_ATTEMPTS) {
        // One failure short of the threshold, issuance is still refused.
        const blocked = await issue();
        assert.equal(blocked.statusCode, 409, blocked.body);
      }
      assert.equal((await attempt()).outcome, 'pending');
      const expected = attempts === ACCOUNT_RECOVERY_BLOCKING_ATTEMPTS ? 1 : 0;
      assert.equal((await stalledRows()).length, expected);
    }

    const job = await harness.store.accountRecoveryJobs.findByUser(account.user.id);
    assert.equal(job?.attempts, ACCOUNT_RECOVERY_BLOCKING_ATTEMPTS);
    assert.ok(job?.unblocked_at, 'the unblock is stamped with the stalled row');
    const [stalled] = await stalledRows();
    assert.ok(stalled);
    assert.equal(stalled.actor_user_id, null);
    assert.equal(stalled.target_type, 'user');
    assert.equal(stalled.details.attempts, ACCOUNT_RECOVERY_BLOCKING_ATTEMPTS);
    assert.equal(stalled.details.last_error, 'refused deterministically');

    // Past the threshold the account may issue again, while the job is still
    // owed and a further failure writes no second row.
    const issued = await issue();
    assert.equal(issued.statusCode, 201, issued.body);
    const issuedId = issued.json<IssueCredentialResponse>().credential.id;
    assert.equal((await attempt()).outcome, 'pending');
    assert.equal((await stalledRows()).length, 1);
    assert.notEqual(await harness.store.accountRecoveryJobs.findByUser(account.user.id), null);

    // The worker keeps retrying, and lands it once the refusal clears. It
    // revokes what predates the unblock, and spares the key the owner issued
    // after it.
    await harness.services.recovery.tick();
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');
    assert.equal((await harness.store.credentials.findById(issuedId))?.status, 'active');
    assert.equal(await harness.store.accountRecoveryJobs.findByUser(account.user.id), null);
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(account.user.id));
    assert.equal(consumer?.credentials.keyauth?.length, 1);
  });

  it('never revokes another account’s live credential on a shared consumer', async () => {
    const account = await harness.registerUser({ email: 'shared-drift@example.test' });
    const other = await harness.registerUser({ email: 'shared-drift-other@example.test' });
    const issued = await harness.authed(account, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(issued.statusCode, 201, issued.body);
    const own = issued.json<IssueCredentialResponse>().credential;
    // A live key on this consumer the portal attributes to somebody else, and
    // an entry added by hand, so no positional delete can be placed. Emptying
    // the type would take the other account's key with it.
    const foreign = await harness.store.credentials.create({
      user_id: other.user.id,
      application_id: null,
      ferrum_consumer_id: own.ferrum_consumer_id,
      credential_type: 'keyauth',
      ferrum_credential_id: `${own.ferrum_consumer_id}/credentials/keyauth`,
      fingerprint: 'test-foreign-active-recovery-row',
      last4: 'frgn',
      label: null,
      status: 'active',
      rotated_from_id: null,
    });
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(account.user.id));
    assert.ok(consumer);
    consumer.credentials.keyauth = [
      ...(consumer.credentials.keyauth ?? []),
      { key: 'foreign-key' },
      { key: 'hand-added' },
    ];

    await trustedReset(account.user.id);
    // The worker retries, and the refusal stands every time.
    await harness.services.recovery.tick();

    assert.equal((await harness.store.credentials.findById(foreign.id))?.status, 'active');
    assert.equal((await harness.store.credentials.findById(own.id))?.status, 'active');
    assert.notEqual(await harness.store.accountRecoveryJobs.findByUser(account.user.id), null);
    const untouched = harness.edge.consumerByUsername(consumerUsernameForUser(account.user.id));
    assert.equal(untouched?.credentials.keyauth?.length, 3);
    const revoked = (await harness.auditRows('credential.revoke')).filter(
      (row) => row.target_id === own.id || row.target_id === foreign.id,
    );
    assert.deepEqual(revoked, []);
    // Left for an administrator in production; dropped so later tests start clean.
    await harness.store.accountRecoveryJobs.deleteByUser(account.user.id);
  });

  it('sweeps another account’s retiring basicauth row with the recovered one', async () => {
    const account = await harness.registerUser({ email: 'shared-basic@example.test' });
    const other = await harness.registerUser({ email: 'shared-basic-other@example.test' });
    const issued = await harness.authed(account, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'basicauth' },
    });
    assert.equal(issued.statusCode, 201, issued.body);
    const own = issued.json<IssueCredentialResponse>().credential;
    // A row on this consumer the portal attributes to somebody else, whose
    // gateway outcome was never confirmed. The account's own revoke refuses to
    // sweep it; the recovery must not, or it would fail the same way forever.
    const foreign = await harness.store.credentials.create({
      user_id: other.user.id,
      application_id: null,
      ferrum_consumer_id: own.ferrum_consumer_id,
      credential_type: 'basicauth',
      ferrum_credential_id: `${own.ferrum_consumer_id}/credentials/basicauth`,
      fingerprint: 'test-foreign-retiring-recovery-row',
      last4: 'frgn',
      label: null,
      status: 'retiring',
      rotated_from_id: null,
    });

    await trustedReset(account.user.id);

    assert.equal(await harness.store.accountRecoveryJobs.findByUser(account.user.id), null);
    assert.equal((await harness.store.credentials.findById(own.id))?.status, 'revoked');
    assert.equal((await harness.store.credentials.findById(foreign.id))?.status, 'revoked');
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(account.user.id));
    assert.equal(consumer?.credentials.basicauth?.length ?? 0, 0);
    const revoked = (await harness.auditRows('credential.revoke')).find(
      (row) => row.target_id === own.id,
    );
    assert.equal(revoked?.details.reason, 'account_recovery');
    assert.deepEqual(revoked?.details.swept_credential_ids, [foreign.id]);
  });

  it('empties a drifted credential type rather than failing the recovery', async () => {
    const account = await harness.registerUser({ email: 'drifted-recovery@example.test' });
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const issued = await harness.authed(account, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      ids.push(issued.json<IssueCredentialResponse>().credential.id);
    }
    // An entry added to the consumer by hand: the portal's rows no longer say
    // where either key sits, so no positional delete can be placed.
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(account.user.id));
    assert.ok(consumer);
    consumer.credentials.keyauth = [...(consumer.credentials.keyauth ?? []), { key: 'hand-added' }];

    await trustedReset(account.user.id);

    assert.equal(await harness.store.accountRecoveryJobs.findByUser(account.user.id), null);
    for (const id of ids) {
      assert.equal((await harness.store.credentials.findById(id))?.status, 'revoked');
    }
    const drained = harness.edge.consumerByUsername(consumerUsernameForUser(account.user.id));
    assert.equal(drained?.credentials.keyauth?.length ?? 0, 0);
    const revoked = (await harness.auditRows('credential.revoke')).filter((row) =>
      ids.includes(String(row.target_id)),
    );
    assert.ok(revoked.some((row) => row.details.placement === 'whole-type-fallback'));
  });

  it('revokes an earlier link when a newer one is issued', async (t) => {
    // Fake only Date: advancing past the issuance throttle needs no sleep and
    // ages both the stored token and the claim with it.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    await harness.registerUser({ email: 'superseded@example.test' });

    await forgotPassword('superseded@example.test');
    await harness.tick();
    const firstMail = harness.mailbox.sent.find((mail) => mail.to === 'superseded@example.test');
    assert.ok(firstMail, 'the first reset mail was delivered');
    const firstToken = tokenIn(firstMail.text);

    // Past the 10-minute throttle the next ask issues a genuinely new link.
    t.mock.timers.tick(11 * 60 * 1000);
    await forgotPassword('superseded@example.test');
    assert.equal(
      (await mailFor('superseded@example.test')).length,
      2,
      'a second link was issued once the window had passed',
    );
    await harness.tick();
    const secondMail = harness.mailbox.sent
      .filter((mail) => mail.to === 'superseded@example.test')
      .at(-1);
    assert.ok(secondMail, 'the second reset mail was delivered');
    const secondToken = tokenIn(secondMail.text);
    assert.notEqual(secondToken, firstToken, 'the second ask minted a new token');

    // Issuing the newer link revoked the older one: a leaked or suspected link
    // must not survive its replacement.
    const superseded = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: firstToken, new_password: NEW_PASSWORD },
    });
    assert.equal(superseded.statusCode, 400, superseded.body);
    assert.equal(errorCode(superseded.body), 'VALIDATION_FAILED');

    const accepted = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: secondToken, new_password: NEW_PASSWORD },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
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

  it('queues only one message for concurrent requests to one account', async () => {
    await harness.registerUser({ email: 'parallel-reset@example.test' });

    await Promise.all(
      Array.from({ length: 8 }, () => forgotPassword('parallel-reset@example.test')),
    );

    assert.equal((await mailFor('parallel-reset@example.test')).length, 1);
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
