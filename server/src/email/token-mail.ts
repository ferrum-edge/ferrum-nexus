/**
 * The messages that deliver a minted single-use link: a password reset, or a
 * re-sent verification.
 *
 * Composed into the auth service by `index.ts` as its `PrepareEmailToken`
 * hooks. The auth service mints and audits; this renders and queues, sealed
 * (`sealed-outbox.ts`), so the link is never readable from `email_outbox`.
 */

import type { EmailTemplateKey } from '@ferrum-nexus/shared';

import type { PrepareEmailToken } from '../auth/service.js';
import type { NexusConfig } from '../config/index.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { sealedEnqueueInput } from './sealed-outbox.js';
import type { EmailService } from './service.js';

/** How one flavour of single-use link is turned into a queued message. */
export interface EmailTokenDelivery {
  templateKey: EmailTemplateKey;
  /** Outbox idempotency keys are `<keyPrefix>:<token id>` — one message per token. */
  keyPrefix: string;
  /** SPA path the link points at, e.g. `/reset-password`. */
  path: string;
  /** Template variable carrying the full link. */
  urlVar: string;
}

/** A re-sent verification link. */
export const VERIFICATION_RESEND: EmailTokenDelivery = {
  templateKey: 'verification',
  keyPrefix: 'verify',
  path: '/verify-email',
  urlVar: 'verification_url',
};

/** A password-reset link. */
export const PASSWORD_RESET: EmailTokenDelivery = {
  templateKey: 'password_reset',
  keyPrefix: 'reset',
  path: '/reset-password',
  urlVar: 'reset_url',
};

/**
 * Build the hook that prepares a minted link's message — a password reset, or a
 * re-sent verification.
 *
 * The message is rendered here, before the auth service claims anything, and
 * the returned function queues it through the mint's own transaction. That
 * split is the point (issue #342): delivery used to run after the claim had
 * committed and swallow its own failures, so a broken template or a failed
 * outbox insert spent the recipient's throttle window on a link nobody was ever
 * sent, and every retry for the next ten minutes answered `200` and sent
 * nothing. Now a render failure happens with nothing claimed, and an insert
 * failure rolls the claim back with it. Either failure propagates to the auth
 * service, which logs it and still answers uniformly — the endpoint's contract
 * is that its answer never varies.
 *
 * The idempotency key is bound to the *token*, not the user, so a second
 * request that mints a second token can still be delivered while one minted
 * token stays at most one message.
 *
 * The row is sealed inside the transaction body. Sealing is pure computation,
 * so a body the adapter re-runs simply seals again under a fresh row id.
 */
export function emailTokenPreparer(
  config: Pick<NexusConfig, 'publicUrl'>,
  email: Pick<EmailService, 'render'>,
  crypto: NexusCrypto,
  delivery: EmailTokenDelivery,
): PrepareEmailToken {
  return async ({ user, token }) => {
    const url = `${config.publicUrl}${delivery.path}?token=${encodeURIComponent(token)}`;
    const rendered = await email.render(delivery.templateKey, {
      recipient_name: user.display_name,
      recipient_email: user.email,
      [delivery.urlVar]: url,
    });
    return async (tx, tokenId) => {
      await tx.emailOutbox.enqueue(
        sealedEnqueueInput(crypto, {
          to: user.email,
          content: rendered,
          idempotencyKey: `${delivery.keyPrefix}:${tokenId}`,
        }),
      );
    };
  };
}
