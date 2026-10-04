/** Account recovery and manual privilege increases, exercised on every adapter. */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  consumerUsernameForUser,
  isReleasedEmail,
  type IssueCredentialResponse,
  type ReleaseUserAddressResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import type { NexusStore } from '../db/store.js';
import { isoInSeconds, newId, nowIso } from '../lib/ids.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function runAccountRecoveryContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`account recovery — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let h: TestApp;
    let faults: FaultInjectingStore;
    let founder: TestSession;
    let admin: TestSession;
    let counter = 0;

    before(async () => {
      target = await makeStore();
      faults = faultInjectingStore(target.store);
      h = await buildTestApp({ store: target.store, wrapStore: () => faults.store });
      founder = await h.registerUser({ email: 'recovery-founder@example.test' });
      const ordinary = await h.registerUser({ email: 'recovery-admin@example.test' });
      const promoted = await h.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${ordinary.user.id}`,
        payload: { role: 'admin' },
      });
      assert.equal(promoted.statusCode, 200, promoted.body);
      admin = await h.loginUser(ordinary.user.email);
    });

    after(async () => {
      await h?.close();
      await target?.teardown();
    });

    async function fresh(): Promise<TestSession> {
      counter += 1;
      return h.registerUser({ email: `recovery-${counter}@example.test` });
    }

    function release(subject: TestSession, actor = founder, email = subject.user.email) {
      return h.authed(actor, {
        method: 'POST',
        url: `/api/users/${subject.user.id}/release-address`,
        payload: { email },
      });
    }

    async function disable(subject: TestSession): Promise<void> {
      const response = await h.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${subject.user.id}`,
        payload: { status: 'disabled' },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await h.store.gatewayTeardownJobs.findByUser(subject.user.id))?.status, 'done');
    }

    async function token(subject: TestSession, purpose: 'password_reset' | 'email_verification') {
      const plaintext = newId();
      const hash = h.app.nexus.crypto.hashToken(plaintext);
      await h.store.verificationTokens.create({
        user_id: subject.user.id,
        token_hash: hash,
        purpose,
        expires_at: isoInSeconds(3600),
      });
      return { plaintext, hash };
    }

    function mail(subject: TestSession, bound = true) {
      return h.store.emailOutbox.enqueue({
        to_email: subject.user.email,
        recipient_user_id: bound ? subject.user.id : null,
        subject: 'Old account message',
        body_html: '<p>Old account message</p>',
        body_text: 'Old account message',
      });
    }

    it('requires super admin authorization, session, CSRF and bounded input', async () => {
      const subject = await fresh();
      const url = `/api/users/${subject.user.id}/release-address`;
      const anonymous = await h.app.inject({
        method: 'POST',
        url,
        payload: { email: subject.user.email },
      });
      assert.equal(anonymous.statusCode, 401, anonymous.body);
      for (const actor of [admin, subject]) {
        const denied = await release(subject, actor);
        assert.equal(denied.statusCode, 403, denied.body);
      }
      const noCsrf = await h.app.inject({
        method: 'POST',
        url,
        cookies: { [SESSION_COOKIE]: founder.sessionToken, [CSRF_COOKIE]: founder.csrfToken },
        payload: { email: subject.user.email },
      });
      assert.equal(noCsrf.statusCode, 403, noCsrf.body);
      for (const payload of [
        { email: 'x'.repeat(321) },
        { email: subject.user.email, role: 'admin' },
      ]) {
        const invalid = await h.authed(founder, { method: 'POST', url, payload });
        assert.equal(invalid.statusCode, 400, invalid.body);
      }
      const oversizedId = await h.authed(founder, {
        method: 'POST',
        url: `/api/users/${'x'.repeat(65)}/release-address`,
        payload: { email: subject.user.email },
      });
      assert.equal(oversizedId.statusCode, 400, oversizedId.body);
      const missing = await h.authed(founder, {
        method: 'POST',
        url: `/api/users/${newId()}/release-address`,
        payload: { email: subject.user.email },
      });
      assert.equal(missing.statusCode, 404, missing.body);
      assert.equal((await release(founder)).statusCode, 403);
    });

    it('refuses active, linked, incomplete teardown and stale-address targets', async () => {
      const subject = await fresh();
      assert.equal((await release(subject)).statusCode, 409);
      await disable(subject);
      const identity = await h.store.userIdentities.create({
        user_id: subject.user.id,
        provider_id: 'lower-trust',
        issuer: 'https://lower-trust.example.test',
        subject: newId(),
        email: subject.user.email,
        provisioned: true,
      });
      assert.equal((await release(subject)).statusCode, 409);
      await h.store.userIdentities.delete(identity.id);
      assert.equal((await release(subject, founder, 'someone-else@example.test')).statusCode, 409);
      await h.store.gatewayTeardownJobs.deleteByUser(subject.user.id);
      assert.equal(
        (await release(subject)).statusCode,
        409,
        'missing teardown is not proof of completion',
      );
      const pending = await h.store.gatewayTeardownJobs.upsertPending(
        subject.user.id,
        founder.user.id,
        nowIso(),
      );
      assert.equal((await release(subject)).statusCode, 409);
      const sending = await h.store.gatewayTeardownJobs.claimPending(pending);
      assert.ok(sending);
      assert.equal((await release(subject)).statusCode, 409);
      assert.equal(await h.store.gatewayTeardownJobs.markDone(sending, nowIso()), true);
      assert.equal((await release(subject)).statusCode, 200);
    });

    it('refuses disabled super admins and live credentials despite a completed job', async () => {
      const privileged = await fresh();
      const promoted = await h.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${privileged.user.id}`,
        payload: { role: 'super_admin' },
      });
      assert.equal(promoted.statusCode, 200, promoted.body);
      await disable(privileged);
      assert.equal((await release(privileged)).statusCode, 403);

      const subject = await fresh();
      const issued = await h.authed(subject, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const credentialId = issued.json<IssueCredentialResponse>().credential.id;
      await disable(subject);
      for (const status of ['active', 'retiring'] as const) {
        await h.store.credentials.update(credentialId, { status });
        const refused = await release(subject);
        assert.equal(refused.statusCode, 409, refused.body);
        assert.equal((await h.store.users.findById(subject.user.id))?.email, subject.user.email);
      }
      const retry = await h.authed(founder, {
        method: 'POST',
        url: `/api/users/${subject.user.id}/gateway-teardown/retry`,
      });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal((await release(subject)).statusCode, 200);
    });

    it('revokes capabilities and queued mail while retaining account history', async () => {
      const subject = await fresh();
      const issued = await h.authed(subject, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const credentialId = issued.json<IssueCredentialResponse>().credential.id;
      await disable(subject);
      const reset = await token(subject, 'password_reset');
      const verification = await token(subject, 'email_verification');
      const oldSession = await h.store.sessions.create({
        user_id: subject.user.id,
        token_hash: h.app.nexus.crypto.hashToken(subject.sessionToken),
        csrf_token: subject.csrfToken,
        expires_at: isoInSeconds(3600),
      });
      const bound = await mail(subject);
      const legacy = await mail(subject, false);
      const response = await release(subject);
      assert.equal(response.statusCode, 200, response.body);
      const retained = response.json<ReleaseUserAddressResponse>().user;
      assert.equal(retained.id, subject.user.id);
      assert.equal(retained.status, 'disabled');
      assert.equal(retained.email_verified, false);
      assert.ok(isReleasedEmail(retained.email));
      assert.equal(await h.store.users.findByEmail(subject.user.email), null);
      assert.equal(await h.store.sessions.findById(oldSession.id), null);
      assert.equal(
        await h.store.verificationTokens.findByTokenHash(reset.hash, 'password_reset'),
        null,
      );
      assert.equal(
        await h.store.verificationTokens.findByTokenHash(verification.hash, 'email_verification'),
        null,
      );
      for (const queued of [bound, legacy]) {
        assert.equal(
          (await h.store.emailOutbox.findById(queued.entry.id))?.last_error,
          'address-released',
        );
        assert.equal((await h.store.emailOutbox.findById(queued.entry.id))?.status, 'failed');
      }
      assert.equal((await h.store.credentials.findById(credentialId))?.status, 'revoked');
      assert.equal(
        (await h.authed(subject, { method: 'GET', url: '/api/users/me' })).statusCode,
        401,
      );
      const resetResponse = await h.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: reset.plaintext, new_password: 'replacement-passphrase' },
      });
      assert.equal(resetResponse.statusCode, 400);
      const verified = await h.app.inject({
        method: 'POST',
        url: '/api/auth/verify-email',
        payload: { token: verification.plaintext },
      });
      assert.equal(verified.statusCode, 400);
      const reenabled = await h.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${subject.user.id}`,
        payload: { status: 'active' },
      });
      assert.equal(reenabled.statusCode, 409, reenabled.body);
      const reservation = await h.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: retained.email,
          password: 'replacement-passphrase',
          display_name: 'Impostor',
          role: 'client',
        },
      });
      assert.equal(reservation.statusCode, 400, reservation.body);
      const rows = (await h.auditRows(AuditAction.USER_ADDRESS_RELEASE)).filter(
        (row) => row.target_id === retained.id,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.actor_user_id, founder.user.id);
      assert.equal(rows[0]?.details.from_email, subject.user.email);
      assert.equal(rows[0]?.details.terminated_sessions, 1);
      assert.equal(rows[0]?.details.revoked_reset_links, 1);
      assert.equal(rows[0]?.details.revoked_verification_links, 1);
      assert.equal(rows[0]?.details.cancelled_emails, 2);
    });

    it('rolls address, tokens, sessions and mail back when the audit insert fails', async () => {
      const subject = await fresh();
      await disable(subject);
      const reset = await token(subject, 'password_reset');
      const verification = await token(subject, 'email_verification');
      const session = await h.store.sessions.create({
        user_id: subject.user.id,
        token_hash: h.app.nexus.crypto.hashToken(subject.sessionToken),
        csrf_token: subject.csrfToken,
        expires_at: isoInSeconds(3600),
      });
      const queued = await mail(subject);
      faults.failNext('auditLogs', 'create');
      const failed = await release(subject);
      assert.equal(failed.statusCode, 500, failed.body);
      assert.equal((await h.store.users.findById(subject.user.id))?.email, subject.user.email);
      assert.ok(await h.store.sessions.findById(session.id));
      assert.ok(await h.store.verificationTokens.findByTokenHash(reset.hash, 'password_reset'));
      assert.ok(
        await h.store.verificationTokens.findByTokenHash(verification.hash, 'email_verification'),
      );
      assert.equal((await h.store.emailOutbox.findById(queued.entry.id))?.status, 'pending');
      assert.equal(
        (await h.auditRows(AuditAction.USER_ADDRESS_RELEASE)).some(
          (row) => row.target_id === subject.user.id,
        ),
        false,
      );
      assert.equal((await release(subject)).statusCode, 200);
    });

    it(
      'refuses a verification mint prepared before address release',
      { timeout: 10_000 },
      async (t) => {
        const subject = await fresh();
        await h.store.users.update(subject.user.id, { email_verified: false });
        const prepared = barrier();
        const resume = barrier();
        const render = h.services.email.render.bind(h.services.email);
        t.mock.method(h.services.email, 'render', async (...args: Parameters<typeof render>) => {
          if (args[0] === 'verification') {
            prepared.resolve();
            await resume.promise;
          }
          return render(...args);
        });
        const request = h.app
          .inject({
            method: 'POST',
            url: '/api/auth/resend-verification',
            payload: { email: subject.user.email },
          })
          .then((response) => response);
        try {
          await Promise.race([
            prepared.promise,
            request.then(() => {
              throw new Error('verification preparation barrier missed');
            }),
          ]);
          await disable(subject);
          const released = await release(subject);
          assert.equal(released.statusCode, 200, released.body);
          resume.resolve();
          const response = await request;
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(
            await h.store.verificationTokens.findLatestLiveForUser(
              subject.user.id,
              'email_verification',
              nowIso(),
            ),
            null,
          );
          assert.equal((await h.store.emailOutbox.list({ to_email: subject.user.email })).total, 0);
        } finally {
          resume.resolve();
          await request;
        }
      },
    );

    it(
      'does not send a cancelled generation paused at recipient lookup',
      { timeout: 10_000 },
      async (t) => {
        const subject = await fresh();
        await disable(subject);
        const queued = await mail(subject);
        const prepared = barrier();
        const resume = barrier();
        const find = target.store.users.findById.bind(target.store.users);
        let paused = false;
        t.mock.method(target.store.users, 'findById', async (id: string) => {
          const record = await find(id);
          if (id === subject.user.id && !paused) {
            paused = true;
            prepared.resolve();
            await resume.promise;
          }
          return record;
        });
        h.mailbox.clear();
        const tick = h.tick();
        try {
          await Promise.race([
            prepared.promise,
            tick.then(() => {
              throw new Error('recipient lookup barrier missed');
            }),
          ]);
          // Model a claimant paused beyond the stale horizon, before SMTP.
          await h.store.emailOutbox.releaseStale(isoInSeconds(60));
          const released = await release(subject);
          assert.equal(released.statusCode, 200, released.body);
          const rightful = await h.registerUser({ email: subject.user.email });
          assert.notEqual(rightful.user.id, subject.user.id);
          resume.resolve();
          const result = await tick;
          assert.equal(result.lost, 1);
          assert.equal(
            h.mailbox.sent.filter((entry) => entry.to === rightful.user.email).length,
            0,
          );
          assert.equal((await h.store.emailOutbox.findById(queued.entry.id))?.status, 'failed');
        } finally {
          resume.resolve();
          await tick;
        }
      },
    );

    it('fences in-flight sending, stale mail and teardown from the replacement', async () => {
      const subject = await fresh();
      await disable(subject);
      const queued = await mail(subject);
      const [sending] = await h.store.emailOutbox.claimDue(nowIso(), 1);
      assert.ok(sending);
      assert.equal(sending.id, queued.entry.id);
      assert.equal((await release(subject)).statusCode, 409);
      assert.equal((await h.store.users.findById(subject.user.id))?.email, subject.user.email);
      assert.equal(await h.store.emailOutbox.markSent(sending, nowIso()), true);
      assert.equal((await release(subject)).statusCode, 200);
      const rightful = await h.registerUser({ email: subject.user.email });
      assert.notEqual(rightful.user.id, subject.user.id);
      const issued = await h.authed(rightful, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const stale = await mail(subject);
      const current = await mail(rightful);
      assert.equal(stale.entry.recipient_user_id, subject.user.id);
      assert.equal(current.entry.recipient_user_id, rightful.user.id);
      h.mailbox.clear();
      await h.tick();
      assert.equal(
        (await h.store.emailOutbox.findById(stale.entry.id))?.last_error,
        'recipient-address-changed',
      );
      assert.equal((await h.store.emailOutbox.findById(current.entry.id))?.status, 'sent');
      assert.equal(h.mailbox.sent.filter((entry) => entry.to === rightful.user.email).length, 1);
      const replay = await h.authed(founder, {
        method: 'POST',
        url: `/api/users/${subject.user.id}/gateway-teardown/retry`,
      });
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(
        h.edge.consumerByUsername(consumerUsernameForUser(rightful.user.id))?.credentials.keyauth
          ?.length,
        1,
      );
      assert.equal(
        (await h.authed(rightful, { method: 'GET', url: '/api/users/me' })).statusCode,
        200,
      );
    });

    for (const [from, to] of [
      ['client', 'provider'],
      ['provider', 'admin'],
      ['admin', 'super_admin'],
    ] as const) {
      it(`a manual ${from} → ${to} increase ends all sessions and audits the count`, async () => {
        const subject = await fresh();
        await h.store.users.update(subject.user.id, { role: from });
        const second = await h.loginUser(subject.user.email);
        const promoted = await h.authed(founder, {
          method: 'PATCH',
          url: `/api/users/${subject.user.id}`,
          payload: { role: to },
        });
        assert.equal(promoted.statusCode, 200, promoted.body);
        for (const session of [subject, second]) {
          assert.equal(
            (await h.authed(session, { method: 'GET', url: '/api/users/me' })).statusCode,
            401,
          );
        }
        const row = (await h.auditRows(AuditAction.USER_ROLE_CHANGE)).find(
          (entry) => entry.target_id === subject.user.id,
        );
        assert.equal(row?.details.terminated_sessions, 2);
        assert.equal((await h.loginUser(subject.user.email)).user.role, to);
      });
    }

    it('audits zero terminated sessions and retains a session on demotion', async () => {
      const subject = await fresh();
      await h.store.sessions.deleteForUser(subject.user.id);
      const promoted = await h.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${subject.user.id}`,
        payload: { role: 'provider' },
      });
      assert.equal(promoted.statusCode, 200, promoted.body);
      const row = (await h.auditRows(AuditAction.USER_ROLE_CHANGE)).find(
        (entry) => entry.target_id === subject.user.id,
      );
      assert.equal(row?.details.terminated_sessions, 0);
      const freshSession = await h.loginUser(subject.user.email);
      const demoted = await h.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${subject.user.id}`,
        payload: { role: 'client' },
      });
      assert.equal(demoted.statusCode, 200, demoted.body);
      assert.equal(
        (await h.authed(freshSession, { method: 'GET', url: '/api/users/me' })).statusCode,
        200,
      );
    });

    it('rolls promotion and session deletion back when its audit fails', async () => {
      const subject = await fresh();
      faults.failNext('auditLogs', 'create');
      const failed = await h.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${subject.user.id}`,
        payload: { role: 'provider' },
      });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.equal((await h.store.users.findById(subject.user.id))?.role, 'client');
      assert.equal(
        (await h.authed(subject, { method: 'GET', url: '/api/users/me' })).statusCode,
        200,
      );
    });
  });
}
