/**
 * Mass email — one queued message per recipient, never a single BCC blast.
 *
 * Fanning out at enqueue time means each recipient gets their own outbox row,
 * so a bad address retries (and eventually fails) on its own instead of taking
 * the whole send with it, and the admin can see per-recipient state.
 *
 * **Idempotency.** Every row is keyed `mass:<batch>:<user_id>`. The batch id is
 * the caller's `idempotency_key` when supplied, otherwise a fresh UUID per
 * call. Re-posting the same request with the same key therefore enqueues
 * nothing new — the unique index on `email_outbox.idempotency_key` does the
 * work — which makes the composer safe to retry after a timeout or a partial
 * failure. The batch id comes back on both the success and the failure path
 * ({@link MassEmailResponse.batch_id}, `details.batch_id`) so a retry can reuse
 * it either way.
 *
 * **A key names one campaign, not one slot.** The campaign's intent row
 * records a digest of what was asked for — subject, both bodies and the
 * normalised audience selector ({@link massEmailContentDigest}). A request
 * under a key this administrator already used is a retry only when its digest
 * matches; any other subject, body or audience is refused with `409 CONFLICT`
 * before anything is queued. Without that, a reused key was an uncharged new
 * campaign: a different message to a disjoint audience, outside the daily
 * budget and with only its own share counted against the byte ceiling.
 *
 * **The campaign is charged and named before anything is queued.** Its
 * `admin.mass_email` row commits in a transaction of its own, before the first
 * outbox row, so a campaign whose fan-out later fails is still in the trail and
 * still counted against `NEXUS_MAX_MASS_EMAILS_PER_DAY` — the ceiling counts
 * exactly those rows, in the same transaction, under a per-administrator key.
 * A failure to write it stops the campaign before any mail exists. One row per
 * campaign: a retry of a batch this administrator already started, with the
 * same content and audience, writes no second row and is not charged again.
 * What each attempt queued is a separate, best-effort
 * `admin.mass_email_complete` row. An audience that resolves to nobody is
 * refused before any of this, so it costs no slot.
 *
 * **The fan-out is chunked.** Outbox rows are inserted in transactions of at
 * most {@link MASS_EMAIL_CHUNK_RECIPIENTS} recipients and about
 * {@link MASS_EMAIL_CHUNK_BYTES} of rendered content. Transaction bodies are
 * serialised per store object, so one transaction holding a whole campaign was
 * a stall for every other write on the instance — the password-reset and
 * verification enqueues included — for as long as the inserts ran, and on
 * MongoDB a hard failure past 16 MB. Between chunks, other writers get their
 * turn. A failed chunk rolls back alone; the chunks before it stay queued, the
 * failure reports how many rows this attempt queued, and a retry with the same
 * batch id queues exactly the rest.
 *
 * Template and branding reads happen **before** any transaction opens. The
 * resulting pure renderer is then used immediately before each insert, so the
 * transactions stay retryable without retaining the whole rendered fan-out.
 *
 * **And the campaign is bounded** before any of that, on three axes, each
 * refusal naming the limit and the variable that sets it:
 * `NEXUS_MAX_MASS_EMAIL_RECIPIENTS` (the audience), `NEXUS_MAX_MASS_EMAIL_BYTES`
 * (rendered bytes × recipients — the two body limits alone multiply out to
 * about a gigabyte at the default audience) and `NEXUS_MAX_MASS_EMAILS_PER_DAY`
 * (campaigns per administrator per rolling 24 hours). The per-message size is
 * an upper bound, not a sample: see {@link worstCaseRecipients}.
 */

import { createHash } from 'node:crypto';

import {
  escapeHtml,
  type MassEmailAudience,
  type MassEmailRequest,
  type MassEmailResponse,
  type Role,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import { OUTBOX_PRIORITY, type NexusStore, type UserFilter, type UserRecord } from '../db/store.js';
import type { EmailService } from '../email/service.js';
import { MASS_RAW_HTML_VARS, type RenderedEmail } from '../email/templates.js';
import { NexusError, isNexusError, quotaExceeded, validationFailed } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { massEmailLockKey, type KeyedSerializer } from '../lib/keyed-serializer.js';

/** Most recipients whose outbox rows one fan-out transaction inserts. */
export const MASS_EMAIL_CHUNK_RECIPIENTS = 200;

/**
 * Bytes one fan-out transaction stays under: a quarter of MongoDB's 16 MB
 * transaction cap, so a campaign of large messages is split into smaller
 * chunks than {@link MASS_EMAIL_CHUNK_RECIPIENTS}. Each row is counted at the
 * campaign's worst-case rendered size plus {@link MASS_EMAIL_ROW_OVERHEAD_BYTES},
 * and a message that could not fit in a chunk on its own is refused, so no
 * chunk exceeds it.
 */
export const MASS_EMAIL_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Allowance per outbox row for what is stored besides the rendered message:
 * the address, the idempotency key, the ids, the status and the timestamps,
 * plus the document or row framing around them. Generous on purpose — it only
 * sizes chunks.
 */
export const MASS_EMAIL_ROW_OVERHEAD_BYTES = 1024;

/** The rolling window `NEXUS_MAX_MASS_EMAILS_PER_DAY` is counted over. */
export const MASS_EMAIL_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Human label for {@link MASS_EMAIL_BUDGET_WINDOW_MS}, echoed in the error details. */
export const MASS_EMAIL_BUDGET_WINDOW_LABEL = '24h';

/**
 * Who is sending a campaign: always a signed-in administrator, whose id keys
 * the daily campaign budget.
 */
export interface MassEmailActor {
  id: Uuid;
  role: Role;
}

/** Mass-email operations. */
export interface MassEmailService {
  /** Resolve the audience and enqueue one message per recipient. */
  send(
    actor: MassEmailActor,
    request: MassEmailRequest,
    ip?: string | null,
  ): Promise<MassEmailResponse>;
  /** Resolve an audience selector to its recipients, without sending. */
  resolveAudience(audience: MassEmailAudience): Promise<UserRecord[]>;
}

/** Dependencies of {@link createMassEmailService}. */
export interface MassEmailServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  email: EmailService;
  audit: AuditService;
  /**
   * Cross-instance per-key lock the daily campaign count and the fan-out run
   * under. Defaults to running the section directly — correct for a single
   * instance only.
   */
  locks?: KeyedSerializer;
  /**
   * Most recipients per fan-out transaction. Defaults to
   * {@link MASS_EMAIL_CHUNK_RECIPIENTS}; a seam for the tests that drive a
   * failure between chunks, which would otherwise need hundreds of accounts.
   * Nothing in production sets it.
   */
  chunkRecipients?: number;
  /** Structured logger for the best-effort outcome row. */
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** The per-recipient variables a rendered copy is built from. */
interface RecipientVars {
  name: string;
  email: string;
}

/** UTF-8 size of `value`. */
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * An upper bound on the UTF-8 size of any one rendered copy of the campaign,
 * given the two renders of {@link worstCaseRecipients}: each part (subject,
 * HTML, text) at the larger of its two sizes.
 */
function worstCaseBytes(plain: RenderedEmail, escaped: RenderedEmail): number {
  return (
    Math.max(utf8Bytes(plain.subject), utf8Bytes(escaped.subject)) +
    Math.max(utf8Bytes(plain.html), utf8Bytes(escaped.html)) +
    Math.max(utf8Bytes(plain.text), utf8Bytes(escaped.text))
  );
}

/**
 * The recipient variables that render the largest copy of each part of the
 * campaign, for an upper bound on its per-message size.
 *
 * The per-recipient variables are the only part of a rendered copy that
 * differs between rows, and each part substitutes them independently and
 * linearly — however many times the template repeats them, because the real
 * renderer does the repeating. But not at the same size: the subject and text
 * take them verbatim, while `body_html` HTML-escapes them, which multiplies a
 * `"` by six and an `&` or `'` by five. The longest raw name is therefore not
 * the longest escaped one. So there are two worst cases — `plain`, the longest
 * name and address by raw bytes, and `escaped`, the longest by escaped bytes —
 * each part is rendered from both, and {@link worstCaseBytes} takes the larger.
 * The name and the address are maximised separately: no recipient has to
 * carry both.
 */
function worstCaseRecipients(recipients: readonly UserRecord[]): {
  plain: RecipientVars;
  escaped: RecipientVars;
} {
  const plain: RecipientVars = { name: '', email: '' };
  const escaped: RecipientVars = { name: '', email: '' };
  const most = { plainName: 0, plainEmail: 0, escapedName: 0, escapedEmail: 0 };
  for (const recipient of recipients) {
    const name = recipient.display_name;
    const address = recipient.email;
    if (utf8Bytes(name) > most.plainName) {
      most.plainName = utf8Bytes(name);
      plain.name = name;
    }
    if (utf8Bytes(address) > most.plainEmail) {
      most.plainEmail = utf8Bytes(address);
      plain.email = address;
    }
    if (utf8Bytes(escapeHtml(name)) > most.escapedName) {
      most.escapedName = utf8Bytes(escapeHtml(name));
      escaped.name = name;
    }
    if (utf8Bytes(escapeHtml(address)) > most.escapedEmail) {
      most.escapedEmail = utf8Bytes(escapeHtml(address));
      escaped.email = address;
    }
  }
  return { plain, escaped };
}

/**
 * The audience as {@link MassEmailService.resolveAudience} reads it: only the
 * fields its scope uses, with lists deduplicated and sorted and the defaults
 * filled in, so two spellings of one selector compare equal.
 */
function normalizedAudience(audience: MassEmailAudience): Record<string, unknown> {
  switch (audience.scope) {
    case 'all':
      return { scope: 'all' };
    case 'explicit':
      return { scope: 'explicit', user_ids: [...new Set(audience.user_ids ?? [])].sort() };
    case 'filtered':
    default:
      return {
        scope: 'filtered',
        status: audience.status ?? 'active',
        roles: [...new Set(audience.roles ?? [])].sort(),
        org_id: audience.org_id ?? null,
      };
  }
}

/**
 * What one campaign asked for, as a SHA-256 hex digest: its subject, both
 * bodies and its normalised audience selector. Stored on the campaign's
 * `admin.mass_email` row (`details.content_sha256`); a later request under the
 * same `idempotency_key` is a retry only when its digest is the same.
 *
 * The selector, not the resolved recipients: an account that joins or leaves
 * the audience between two attempts must not turn a genuine retry into a
 * refusal that can only be answered by mailing everyone again under a new key.
 * The template and branding are not part of it either, for the same reason;
 * neither can widen the audience, and every attempt is checked against the
 * recipient and byte ceilings on its own.
 */
export function massEmailContentDigest(request: MassEmailRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        subject: request.subject.trim(),
        body_html: request.body_html,
        body_text: request.body_text,
        audience: normalizedAudience(request.audience),
      }),
    )
    .digest('hex');
}

/** Build the mass-email service. */
export function createMassEmailService(deps: MassEmailServiceDeps): MassEmailService {
  const { config, store, email, audit } = deps;
  const locks: KeyedSerializer = deps.locks ?? ((_key, fn) => fn());
  const chunkRecipients = Math.max(1, deps.chunkRecipients ?? MASS_EMAIL_CHUNK_RECIPIENTS);

  async function resolveAudience(audience: MassEmailAudience): Promise<UserRecord[]> {
    switch (audience.scope) {
      case 'all':
        // "all" ignores the other filters, but never mails disabled accounts.
        return store.users.listRecipients({ status: 'active' });
      case 'explicit': {
        const ids = audience.user_ids ?? [];
        if (ids.length === 0) throw validationFailed('Select at least one recipient');
        return store.users.listRecipients({ ids, status: 'active' });
      }
      case 'filtered':
      default: {
        const filter: UserFilter = {
          status: audience.status ?? 'active',
          ...(audience.roles && audience.roles.length > 0 ? { roles: audience.roles } : {}),
          ...(audience.org_id !== undefined ? { org_id: audience.org_id } : {}),
        };
        return store.users.listRecipients(filter);
      }
    }
  }

  /**
   * Add the batch id — and what this attempt queued — to a `CONFLICT`, keeping
   * its code and so its `409`: contention that outlived the pooled adapters'
   * retry budget means "retry this campaign", not "this send is broken".
   */
  function conflictWithBatch(cause: NexusError, extra: Record<string, unknown>): NexusError {
    return new NexusError(
      cause.code,
      cause.message,
      {
        ...(typeof cause.details === 'object' && cause.details !== null ? cause.details : {}),
        ...extra,
      },
      { cause },
    );
  }

  /** Whether `error` already names a batch in its details. */
  function carriesBatch(error: NexusError): boolean {
    const details = error.details;
    return typeof details === 'object' && details !== null && 'batch_id' in details;
  }

  return {
    resolveAudience,

    async send(actor, request, ip = null): Promise<MassEmailResponse> {
      const subject = request.subject.trim();
      if (subject === '') throw validationFailed('A subject is required');
      if (request.body_html.trim() === '' && request.body_text.trim() === '') {
        throw validationFailed('A message body is required');
      }

      const recipients = await resolveAudience(request.audience);
      // An audience that resolves to nobody is a mistake, not a campaign: it
      // would pass every ceiling, queue nothing, and still spend one of the
      // administrator's daily slots on a row describing mail nobody received.
      // `resolveAudience` already refuses an empty explicit list; this is the
      // same refusal for a filter, or an explicit list of inactive accounts.
      if (recipients.length === 0) {
        throw validationFailed(
          'That audience matches nobody: every account it selects is inactive or missing',
        );
      }
      // Before the rendering and before any transaction: an audience too large
      // to queue must cost nothing at all. Same refusal shape as the broadcast
      // ceilings — the limit, what was asked for, and the variable to raise.
      const recipientLimit = config.maxMassEmailRecipients;
      if (recipientLimit > 0 && recipients.length > recipientLimit) {
        throw quotaExceeded(
          `This campaign addresses ${recipients.length} recipients, more than the maximum ` +
            `of ${recipientLimit}. Narrow the audience, or ask an operator to raise the limit.`,
          {
            limit: recipientLimit,
            recipients: recipients.length,
            setting: 'NEXUS_MAX_MASS_EMAIL_RECIPIENTS',
          },
        );
      }
      const batch = request.idempotency_key ?? newId();
      const digest = massEmailContentDigest(request);

      // Resolve store-backed template state once, outside every retryable
      // transaction. The returned renderer is pure, so it is safe to call on a
      // transaction retry and lets each large rendered body become collectible
      // immediately after its insert instead of retaining the entire fan-out.
      const render = await email.prepareRenderer('mass', MASS_RAW_HTML_VARS);
      function renderFor(recipient: { name: string; email: string }): RenderedEmail {
        return render({
          recipient_name: recipient.name,
          recipient_email: recipient.email,
          subject,
          body_html: request.body_html,
          body_text: request.body_text,
        });
      }

      // The aggregate: what the campaign as a whole would put in the outbox.
      // The body limits and the audience ceiling are each fine on their own;
      // their product is what has to be stored and drained ahead of every
      // later verification and password-reset message. `messageBytes` bounds
      // every copy from above, escaping and template repetition included.
      const worst = worstCaseRecipients(recipients);
      const messageBytes = worstCaseBytes(renderFor(worst.plain), renderFor(worst.escaped));
      const rowBytes = messageBytes + MASS_EMAIL_ROW_OVERHEAD_BYTES;
      // One row has to fit in a fan-out transaction of its own, whatever the
      // aggregate ceiling says: only an overridden template that repeats the
      // body can get here, and its rows would fail every chunk on MongoDB.
      if (rowBytes > MASS_EMAIL_CHUNK_BYTES) {
        throw validationFailed(
          `One copy of this campaign renders to about ${messageBytes} bytes, more than the ` +
            `${MASS_EMAIL_CHUNK_BYTES - MASS_EMAIL_ROW_OVERHEAD_BYTES} a single message may ` +
            'take. Shorten the message, or the mass template if it repeats the body.',
          {
            limit: MASS_EMAIL_CHUNK_BYTES - MASS_EMAIL_ROW_OVERHEAD_BYTES,
            message_bytes: messageBytes,
          },
        );
      }
      const totalBytes = messageBytes * recipients.length;
      const byteLimit = config.maxMassEmailBytes;
      if (byteLimit > 0 && totalBytes > byteLimit) {
        throw quotaExceeded(
          `This campaign would queue about ${totalBytes} bytes of mail (${messageBytes} per ` +
            `message × ${recipients.length} recipients), more than the maximum of ` +
            `${byteLimit}. Shorten the message or narrow the audience, or ask an operator to ` +
            'raise the limit.',
          {
            limit: byteLimit,
            bytes: totalBytes,
            message_bytes: messageBytes,
            recipients: recipients.length,
            setting: 'NEXUS_MAX_MASS_EMAIL_BYTES',
          },
        );
      }
      const perChunk = Math.max(
        1,
        Math.min(chunkRecipients, Math.floor(MASS_EMAIL_CHUNK_BYTES / rowBytes)),
      );

      /** Charge (or recognise) the campaign, then queue it chunk by chunk. */
      async function fanOut(): Promise<MassEmailResponse> {
        try {
          await store.transaction(async (tx) => {
            const scoped = audit.forStore(tx);
            const started = await scoped.count({
              actor_user_id: actor.id,
              action: AuditAction.ADMIN_MASS_EMAIL,
              target_type: 'mass_email',
              target_id: batch,
            });
            if (started > 0) {
              // A retry of a campaign this administrator already started is
              // already named and already charged — but only if it is that
              // campaign. Any other content or audience under the same key
              // would be a new campaign that skipped the daily budget.
              const same = await scoped.count({
                actor_user_id: actor.id,
                action: AuditAction.ADMIN_MASS_EMAIL,
                target_type: 'mass_email',
                target_id: batch,
                details: { content_sha256: digest },
              });
              if (same === 0) {
                throw new NexusError(
                  'CONFLICT',
                  'This idempotency_key already names a campaign with a different subject, ' +
                    'body or audience. Retry that campaign unchanged, or start a new one ' +
                    'without the key.',
                  { batch_id: batch, reason: 'idempotency_key_reused' },
                );
              }
              return;
            }
            const dailyLimit = config.maxMassEmailsPerDay;
            if (dailyLimit > 0) {
              const since = new Date(Date.now() - MASS_EMAIL_BUDGET_WINDOW_MS).toISOString();
              const used = await scoped.count({
                actor_user_id: actor.id,
                action: AuditAction.ADMIN_MASS_EMAIL,
                from: since,
              });
              if (used >= dailyLimit) {
                throw quotaExceeded(
                  `You have started ${used} mass-email campaigns in the last ` +
                    `${MASS_EMAIL_BUDGET_WINDOW_LABEL}, the maximum of ${dailyLimit}. Wait for ` +
                    'the oldest of them to age out, or ask an operator to raise the limit.',
                  {
                    limit: dailyLimit,
                    used,
                    recipients: recipients.length,
                    window: MASS_EMAIL_BUDGET_WINDOW_LABEL,
                    setting: 'NEXUS_MAX_MASS_EMAILS_PER_DAY',
                  },
                );
              }
            }
            await scoped.record(
              actor,
              AuditAction.ADMIN_MASS_EMAIL,
              { type: 'mass_email', id: batch },
              {
                subject,
                audience_scope: request.audience.scope,
                recipients: recipients.length,
                bytes: totalBytes,
                content_sha256: digest,
                phase: 'started',
              },
              ip,
            );
          });
        } catch (cause) {
          if (isNexusError(cause) && cause.code === 'QUOTA_EXCEEDED') throw cause;
          if (isNexusError(cause) && cause.code === 'CONFLICT') {
            throw conflictWithBatch(cause, { batch_id: batch });
          }
          // Nothing was queued and nothing was charged — but the admin still
          // needs the batch id, because a *lost response* to a campaign that
          // did go out is indistinguishable from this one at the browser, and
          // reusing the key is what makes the retry safe in both cases.
          throw new NexusError(
            'OUTBOX_FAILURE',
            'The campaign could not be queued; nothing was sent. Retry with the same ' +
              'idempotency_key to avoid mailing anyone twice.',
            { batch_id: batch, recipients: recipients.length, enqueued: 0 },
            { cause },
          );
        }

        let enqueued = 0;
        let chunks = 0;
        let failure: unknown = null;
        for (let start = 0; start < recipients.length; start += perChunk) {
          const chunk = recipients.slice(start, start + perChunk);
          try {
            enqueued += await store.transaction(async (tx) => {
              let created = 0;
              for (const recipient of chunk) {
                const rendered = renderFor({
                  name: recipient.display_name,
                  email: recipient.email,
                });
                const result = await tx.emailOutbox.enqueue({
                  to_email: recipient.email,
                  priority: OUTBOX_PRIORITY.low,
                  recipient_user_id: recipient.id,
                  subject: rendered.subject,
                  body_html: rendered.html,
                  body_text: rendered.text,
                  idempotency_key: `mass:${batch}:${recipient.id}`,
                });
                if (result.created) created += 1;
              }
              return created;
            });
            chunks += 1;
          } catch (cause) {
            failure = cause;
            break;
          }
        }

        // Best effort, unlike the row above. The campaign is already durable,
        // countable and named in the trail, so a failure to record what this
        // attempt queued must not turn queued mail into a `500` the
        // administrator would answer by sending again under a fresh key.
        try {
          await audit.record(
            actor,
            AuditAction.ADMIN_MASS_EMAIL_COMPLETE,
            { type: 'mass_email', id: batch },
            {
              subject,
              audience_scope: request.audience.scope,
              recipients: recipients.length,
              enqueued,
              chunks,
              failed: failure !== null,
            },
            ip,
          );
        } catch (error) {
          deps.log?.(
            {
              batch,
              enqueued,
              error: error instanceof Error ? error.message : String(error),
            },
            'A mass-email campaign was queued but its completion record could not be written',
          );
        }

        if (failure === null) {
          return { enqueued, recipients: recipients.length, batch_id: batch };
        }
        if (isNexusError(failure) && failure.code === 'CONFLICT') {
          throw conflictWithBatch(failure, { batch_id: batch, enqueued });
        }
        let message =
          'The campaign could not be queued; nothing was sent. Retry with the same ' +
          'idempotency_key to avoid mailing anyone twice.';
        if (enqueued > 0) {
          message =
            `The campaign was only partly queued (${enqueued} of ${recipients.length} ` +
            'recipients). Retry with the same idempotency_key to queue the rest without ' +
            'mailing anyone twice.';
        }
        throw new NexusError(
          'OUTBOX_FAILURE',
          message,
          { batch_id: batch, recipients: recipients.length, enqueued },
          { cause: failure },
        );
      }

      // The daily count reads the actor's own `admin.mass_email` rows and the
      // row charging this campaign is written in the same section, so without
      // the key two instances would each count the same history and both
      // proceed. Taken outside every transaction — the lease repository issues
      // statements of its own — and held across the fan-out.
      try {
        return await locks(massEmailLockKey(actor.id), fanOut);
      } catch (cause) {
        // The key itself can refuse — another campaign from this administrator
        // still held it when the wait ran out. Nothing was written or charged,
        // but the 409 carries the batch id like every other, so the retry the
        // refusal asks for reaches the same campaign.
        if (isNexusError(cause) && cause.code === 'CONFLICT' && !carriesBatch(cause)) {
          throw conflictWithBatch(cause, { batch_id: batch });
        }
        throw cause;
      }
    },
  };
}
