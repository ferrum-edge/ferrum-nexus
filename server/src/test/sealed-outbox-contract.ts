/**
 * Queued mail that carries a single-use link is unreadable at rest, on every
 * adapter.
 *
 * `verification_tokens` has only ever stored an HMAC of a link's token, but the
 * message that delivers the link sat in `email_outbox` as rendered text. A
 * reader of that one table could ask for a reset of any active account, lift
 * the link from the queued row and choose the account's password. So messages
 * rendered from the verification and password-reset templates are sealed
 * before they are inserted, and opened only by the outbox worker. These cases
 * check what a database reader sees, that the worker still delivers a link
 * that works, that an envelope moved to another row or altered is failed
 * rather than delivered, and that rows written before sealing are sealed in
 * place.
 *
 * Every assertion about stored content is a boolean with a fixed message: a
 * failure must never print the link or its token.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { REGISTRATION_SETTINGS_KEY } from '../auth/service.js';
import {
  OUTBOX_PRIORITY,
  OUTBOX_SEALED_SUBJECT,
  type EmailOutboxRecord,
  type NexusStore,
} from '../db/store.js';
import { OUTBOX_SEALED_UNREADABLE } from '../email/outbox-worker.js';
import { SEALED_BODY_PREFIX, sealedEnqueueInput } from '../email/sealed-outbox.js';
import { createCrypto } from '../lib/crypto.js';
import { buildTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

const RESET_TOKEN_LINK = /\/reset-password\?token=([A-Za-z0-9_-]+)/;
const VERIFY_TOKEN_LINK = /\/verify-email\?token=([A-Za-z0-9_-]+)/;

/** The password a redeemed reset link sets. */
const NEW_PASSWORD = 'sealed-outbox-new-passphrase';

/** A master key the portal is not running with — the one before a rotation. */
const PREVIOUS_SECRET_KEY = 'a-previous-nexus-secret-key-0123456789abcdef';

/** Every stored column that could carry a message's content. */
function storedText(row: EmailOutboxRecord): string {
  return [row.subject, row.body_html, row.body_text].join('\n');
}

/** The envelope with one ciphertext character changed. */
function altered(bodyText: string): string {
  // `nexus-sealed-v1:v1:<iv>:<ciphertext>:<tag>`
  const parts = bodyText.split(':');
  const ciphertext = parts[3] ?? '';
  parts[3] = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;
  return parts.join(':');
}

/** Exercise outbox sealing against each smoke-suite adapter. */
export function runSealedOutboxContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`sealed outbox contract — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let harness: TestApp;
    let counter = 0;

    before(async () => {
      target = await makeStore();
      harness = await buildTestApp({ store: target.store });
      await harness.registerUser({ email: `sealed-founder-${label}@example.test` });
    });

    after(async () => {
      await harness?.close();
      await target?.teardown();
    });

    /** A fresh address no earlier case has used. */
    function address(tag: string): string {
      counter += 1;
      return `sealed-${label}-${tag}-${counter}@example.test`;
    }

    /** The rows addressed to `email` exactly as a database reader sees them. */
    async function storedFor(email: string): Promise<EmailOutboxRecord[]> {
      return (await harness.store.emailOutbox.list({ to_email: email })).items;
    }

    /** The stored rows for `email` whose idempotency key starts with `prefix`. */
    async function storedKeyed(email: string, prefix: string): Promise<EmailOutboxRecord[]> {
      return (await storedFor(email)).filter((row) => row.idempotency_key?.startsWith(prefix));
    }

    async function forgotPassword(email: string): Promise<void> {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { email },
      });
      assert.equal(response.statusCode, 200, response.body);
    }

    /** Tick until the queue is drained: one tick claims at most one batch. */
    async function drain(): Promise<void> {
      for (let round = 0; round < 50; round += 1) {
        if ((await harness.tick()).claimed === 0) return;
      }
      assert.fail('the outbox did not drain');
    }

    /** Text bodies the fake relay received for `email`, oldest first. */
    function deliveredTo(email: string): string[] {
      return harness.mailbox.sent.filter((mail) => mail.to === email).map((mail) => mail.text);
    }

    it('queues a password reset for an active account with no readable link', async () => {
      const email = address('reset');
      await harness.registerUser({ email });
      await forgotPassword(email);

      const queued = await storedKeyed(email, 'reset:');
      assert.equal(queued.length, 1, 'exactly one reset message was queued');
      const row = queued[0] ?? assert.fail('the reset message was queued');
      assert.equal(row.priority, OUTBOX_PRIORITY.high, 'password recovery uses the high lane');
      assert.equal(row.subject, OUTBOX_SEALED_SUBJECT, 'the stored subject is the sealed marker');
      assert.equal(row.body_html, '', 'no html body is stored');
      assert.ok(row.body_text.startsWith(SEALED_BODY_PREFIX), 'the text body is an envelope');
      assert.ok(!storedText(row).includes('reset-password'), 'no reset path is stored');
      assert.ok(!storedText(row).includes('token='), 'no token parameter is stored');

      await drain();
      const [text] = deliveredTo(email);
      const token = RESET_TOKEN_LINK.exec(text ?? '')?.[1];
      assert.ok(token, 'the delivered message carries the reset link');
      for (const stored of await storedFor(email)) {
        assert.ok(!storedText(stored).includes(token), 'the delivered token is stored nowhere');
        assert.ok(
          !storedText(stored).includes(encodeURIComponent(token)),
          'the encoded token is stored nowhere',
        );
      }

      // Positive control: the link the relay received still resets the password.
      const reset = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, new_password: NEW_PASSWORD },
      });
      assert.equal(reset.statusCode, 200, reset.body);
      const signedIn = await harness.loginUser(email, NEW_PASSWORD);
      assert.equal(signedIn.user.email, email);
    });

    it('seals the registration and re-sent verification links too', async () => {
      const previous = await harness.store.settings.get(REGISTRATION_SETTINGS_KEY);
      await harness.store.settings.set(
        REGISTRATION_SETTINGS_KEY,
        {
          open_registration: true,
          require_email_verification: true,
          allowed_roles: ['client', 'provider'],
        },
        false,
      );
      try {
        const email = address('verify');
        const registered = await harness.app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: { email, password: TEST_PASSWORD, display_name: 'Sealed', role: 'client' },
        });
        assert.equal(registered.statusCode, 201, registered.body);
        const user = await harness.store.users.findByEmail(email);
        assert.ok(user, 'the account exists');

        // Retire the registration's link so the resend mints a second one
        // instead of being throttled.
        await harness.store.verificationTokens.deleteForUser(user.id, 'email_verification');
        const resent = await harness.app.inject({
          method: 'POST',
          url: '/api/auth/resend-verification',
          payload: { email },
        });
        assert.equal(resent.statusCode, 200, resent.body);

        const queued = await storedKeyed(email, 'verify:');
        assert.equal(queued.length, 2, 'the registration and the resend each queued a link');
        for (const row of queued) {
          assert.equal(row.priority, OUTBOX_PRIORITY.high, 'registration and resend use high');
          assert.equal(row.subject, OUTBOX_SEALED_SUBJECT, 'the stored subject is the marker');
          assert.ok(!storedText(row).includes('verify-email'), 'no verification path is stored');
          assert.ok(!storedText(row).includes('token='), 'no token parameter is stored');
        }

        await drain();
        const delivered = deliveredTo(email);
        assert.equal(delivered.length, 2, 'both links were delivered');
        const token = VERIFY_TOKEN_LINK.exec(delivered.at(-1) ?? '')?.[1];
        assert.ok(token, 'the delivered resend carries the verification link');
        for (const stored of await storedFor(email)) {
          assert.ok(!storedText(stored).includes(token), 'the delivered token is stored nowhere');
        }

        // Positive control: the delivered link verifies the address.
        const verified = await harness.app.inject({
          method: 'POST',
          url: '/api/auth/verify-email',
          payload: { token },
        });
        assert.equal(verified.statusCode, 200, verified.body);
      } finally {
        if (previous) {
          await harness.store.settings.set(previous.key, previous.value, previous.encrypted);
        } else {
          await harness.store.settings.delete(REGISTRATION_SETTINGS_KEY);
        }
      }
    });

    it('fails an envelope that was copied, altered or sealed under a previous key', async () => {
      const email = address('owner');
      await harness.registerUser({ email });
      await forgotPassword(email);
      const original =
        (await storedKeyed(email, 'reset:'))[0] ?? assert.fail('the reset message was queued');
      harness.mailbox.clear();

      // Another row carrying the owner's envelope, redirected to someone else.
      const thief = address('thief');
      const copied = await harness.store.emailOutbox.enqueue({
        to_email: thief,
        subject: original.subject,
        body_html: original.body_html,
        body_text: original.body_text,
      });
      // A correctly bound envelope with one ciphertext character changed.
      const genuine = sealedEnqueueInput(harness.app.nexus.crypto, {
        to: email,
        content: { subject: 'Altered', html: '<p>altered</p>', text: 'altered' },
      });
      const tampered = await harness.store.emailOutbox.enqueue({
        ...genuine,
        body_text: altered(genuine.body_text),
      });
      // Sealed before `NEXUS_SECRET_KEY` was rotated.
      const rotated = address('rotated');
      const stale = await harness.store.emailOutbox.enqueue(
        sealedEnqueueInput(createCrypto(PREVIOUS_SECRET_KEY), {
          to: rotated,
          content: { subject: 'Stale', html: '<p>stale</p>', text: 'stale' },
        }),
      );

      await drain();
      for (const { entry } of [copied, tampered, stale]) {
        const row = await harness.store.emailOutbox.findById(entry.id);
        assert.equal(row?.status, 'failed', 'an envelope that does not open is failed');
        assert.equal(row?.attempts, 1, 'and never retried');
        assert.ok(
          row?.last_error?.startsWith(`${OUTBOX_SEALED_UNREADABLE}: `),
          'the failure names the sealed-unreadable condition',
        );
      }
      assert.deepEqual(deliveredTo(thief), [], 'nothing reached the redirected address');
      assert.deepEqual(deliveredTo(rotated), [], 'nothing sealed under the old key was sent');
      // Positive control: the untouched original was delivered, exactly once.
      const delivered = deliveredTo(email);
      assert.equal(delivered.length, 1, 'only the genuine message reached the owner');
      assert.ok(delivered[0]?.includes('/reset-password?token='), 'and it carries the link');
    });

    it('fails rows with only one sealed-content marker', async () => {
      const subjectOnly = await harness.store.emailOutbox.enqueue({
        to_email: address('subject-marker'),
        subject: OUTBOX_SEALED_SUBJECT,
        body_html: '',
        body_text: 'ciphertext without its sealed prefix',
      });
      const bodyOnly = await harness.store.emailOutbox.enqueue({
        to_email: address('body-marker'),
        subject: 'Plain subject',
        body_html: '',
        body_text: `${SEALED_BODY_PREFIX}ciphertext without its sealed subject marker`,
      });

      await drain();
      for (const { entry } of [subjectOnly, bodyOnly]) {
        const row = await harness.store.emailOutbox.findById(entry.id);
        assert.equal(row?.status, 'failed', 'a partial sealed row is failed');
        assert.equal(row?.attempts, 1, 'and never retried');
        assert.ok(
          row?.last_error?.startsWith(`${OUTBOX_SEALED_UNREADABLE}: `),
          'the failure names the sealed-unreadable condition',
        );
      }
      assert.deepEqual(deliveredTo(subjectOnly.entry.to_email), [], 'no ciphertext was sent');
      assert.deepEqual(deliveredTo(bodyOnly.entry.to_email), [], 'no ciphertext was sent');
    });

  });
}
