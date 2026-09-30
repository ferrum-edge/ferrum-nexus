/**
 * Sealed outbox content: queued mail that carries a single-use link is never
 * stored in plaintext.
 *
 * `verification_tokens` stores only an HMAC of each link's token, but the
 * message that delivers the link used to sit in `email_outbox` as rendered
 * text — pending until the worker sent it, and retained after. Anyone who
 * could read that table could lift a live password-reset link and set the
 * account's password without ever touching the mailbox. So a message rendered
 * from a {@link BEARER_TEMPLATE_KEYS bearer template} is sealed before it is
 * inserted:
 *
 * - `subject` holds {@link OUTBOX_SEALED_SUBJECT}, `body_html` is empty, and
 *   `body_text` is {@link SEALED_BODY_PREFIX} followed by one AES-256-GCM
 *   envelope of `{ subject, html, text }` under the outbox key
 *   (`NexusCrypto.sealOutbox`, HKDF-derived from `NEXUS_SECRET_KEY`).
 * - The envelope's additional authenticated data is the row id and the
 *   recipient, so a ciphertext copied onto another row — or a row whose
 *   `to_email` was rewritten — does not open.
 * - Only the outbox worker opens it, immediately before handing the message to
 *   SMTP. A row that does not open (tampered, copied, or sealed under a
 *   `NEXUS_SECRET_KEY` that has since been rotated, which invalidated its
 *   token anyway) is failed, never delivered and never retried.
 *
 * Rows written before sealing existed are sealed in place by
 * {@link sealLegacyBearerRows}, which the worker runs until none are left.
 */

import type { EmailTemplateKey } from '@ferrum-nexus/shared';

import {
  OUTBOX_SEALED_SUBJECT,
  type EmailOutboxRecord,
  type EnqueueEmailInput,
  type NexusStore,
} from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';

/** Templates whose rendered message carries a single-use link and is therefore sealed. */
export const BEARER_TEMPLATE_KEYS: readonly EmailTemplateKey[] = ['verification', 'password_reset'];

/**
 * Idempotency-key namespaces of the messages rendered from those templates:
 * the registration's verification (`verify:<user id>`), a re-sent verification
 * (`verify:<token id>`) and a password reset (`reset:<token id>`). The legacy
 * sweep only looks at these.
 */
export const BEARER_IDEMPOTENCY_PREFIXES: readonly string[] = ['reset:', 'verify:'];

/** Leads `body_text` of a sealed row; the envelope follows it. */
export const SEALED_BODY_PREFIX = 'nexus-sealed-v1:';

/** Rows the legacy sweep seals per call, so one tick never turns into a table rewrite. */
export const LEGACY_SEAL_BATCH = 200;

/** A message's real content: what the envelope holds and what SMTP is handed. */
export interface MailContent {
  subject: string;
  html: string;
  text: string;
}

/** Raised when a sealed row does not open. Carries no content. */
export class SealedOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedOutboxError';
  }
}

/** True when `templateKey` renders a message that must be sealed. */
export function isBearerTemplate(templateKey: EmailTemplateKey): boolean {
  return BEARER_TEMPLATE_KEYS.includes(templateKey);
}

/** The additional authenticated data binding an envelope to its row. */
function boundTo(id: string, toEmail: string): string {
  return JSON.stringify(['email_outbox', id, toEmail]);
}

/** The column values of `content` sealed for the row `id` addressed to `toEmail`. */
export function sealMailContent(
  crypto: NexusCrypto,
  id: string,
  toEmail: string,
  content: MailContent,
): { subject: string; body_html: string; body_text: string } {
  const envelope = crypto.sealOutbox(
    { subject: content.subject, html: content.html, text: content.text },
    boundTo(id, toEmail),
  );
  return {
    subject: OUTBOX_SEALED_SUBJECT,
    body_html: '',
    body_text: `${SEALED_BODY_PREFIX}${envelope}`,
  };
}

/**
 * An {@link EnqueueEmailInput} whose content is sealed.
 *
 * The row id is minted here because the envelope is bound to it. When the
 * idempotency key already names a row, the store returns that row and this id
 * is simply never used.
 */
export function sealedEnqueueInput(
  crypto: NexusCrypto,
  input: { to: string; content: MailContent; idempotencyKey?: string | null },
): EnqueueEmailInput {
  const id = newId();
  return {
    id,
    to_email: input.to,
    ...sealMailContent(crypto, id, input.to, input.content),
    idempotency_key: input.idempotencyKey ?? null,
  };
}

/** True when the row's content is a sealed envelope rather than rendered text. */
export function isSealedOutboxRecord(entry: EmailOutboxRecord): boolean {
  return entry.subject === OUTBOX_SEALED_SUBJECT && entry.body_text.startsWith(SEALED_BODY_PREFIX);
}

/**
 * The content to deliver for `entry`: opened when it is sealed, as stored when
 * it is not.
 *
 * @throws SealedOutboxError when a sealed envelope does not open, or opens to
 *   something that is not mail content. The message says which, never what.
 */
export function openOutboxRecord(crypto: NexusCrypto, entry: EmailOutboxRecord): MailContent {
  const hasSealedSubject = entry.subject === OUTBOX_SEALED_SUBJECT;
  const hasSealedBody = entry.body_text.startsWith(SEALED_BODY_PREFIX);
  if (hasSealedSubject !== hasSealedBody) {
    throw new SealedOutboxError('sealed message has only one of its required markers');
  }
  if (!hasSealedSubject) {
    return { subject: entry.subject, html: entry.body_html, text: entry.body_text };
  }
  let opened: unknown;
  try {
    opened = crypto.openOutbox<unknown>(
      entry.body_text.slice(SEALED_BODY_PREFIX.length),
      boundTo(entry.id, entry.to_email),
    );
  } catch {
    throw new SealedOutboxError(
      'sealed message could not be opened: it was altered, copied from another row, or ' +
        'sealed under a previous NEXUS_SECRET_KEY',
    );
  }
  const content = opened as Partial<Record<keyof MailContent, unknown>> | null;
  if (
    content === null ||
    typeof content !== 'object' ||
    typeof content.subject !== 'string' ||
    typeof content.html !== 'string' ||
    typeof content.text !== 'string'
  ) {
    throw new SealedOutboxError('sealed message opened to something that is not mail content');
  }
  return { subject: content.subject, html: content.html, text: content.text };
}

/**
 * Seal, in place, bearer-template rows written before sealing existed.
 *
 * Every status is covered: a `sent` row's link stays redeemable until it is
 * used or expires, so leaving it readable would keep exactly the exposure this
 * module removes. Newest rows first, since those are the ones whose links can
 * still be live, and at most `limit` rows per call. Each write is a
 * compare-and-swap on "not sealed yet", so two instances sweeping at once
 * cannot seal one row twice.
 *
 * @returns the number of rows sealed, and whether rows may remain.
 */
export async function sealLegacyBearerRows(
  store: NexusStore,
  crypto: NexusCrypto,
  limit: number = LEGACY_SEAL_BATCH,
): Promise<{ sealed: number; more: boolean }> {
  let sealed = 0;
  let budget = limit;
  for (const prefix of BEARER_IDEMPOTENCY_PREFIXES) {
    if (budget <= 0) return { sealed, more: true };
    const page = await store.emailOutbox.list(
      { idempotency_key_prefix: prefix, sealed: false },
      { limit: budget },
    );
    budget -= page.items.length;
    for (const entry of page.items) {
      const next = sealMailContent(crypto, entry.id, entry.to_email, {
        subject: entry.subject,
        html: entry.body_html,
        text: entry.body_text,
      });
      if (await store.emailOutbox.sealContent(entry.id, next)) sealed += 1;
    }
    if (page.total > page.items.length) return { sealed, more: true };
  }
  return { sealed, more: false };
}
