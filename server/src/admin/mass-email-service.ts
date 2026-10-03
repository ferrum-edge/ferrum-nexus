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
 * **The campaign is charged and named before anything is queued.** Its
 * `admin.mass_email` row commits in a transaction of its own, before the first
 * outbox row, so a campaign whose fan-out later fails is still in the trail and
 * still counted against `NEXUS_MAX_MASS_EMAILS_PER_DAY` — the ceiling counts
 * exactly those rows, in the same transaction, under a per-administrator key.
 * A failure to write it stops the campaign before any mail exists. One row per
 * campaign: a retry of a batch this administrator already started writes no
 * second row and is not charged again. What each attempt queued is a separate,
 * best-effort `admin.mass_email_complete` row.
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
 * (campaigns per administrator per rolling 24 hours).
 */

import type {
  MassEmailAudience,
  MassEmailRequest,
  MassEmailResponse,
  Role,
  Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type { NexusStore, UserFilter, UserRecord } from '../db/store.js';
import type { EmailService } from '../email/service.js';
import { MASS_RAW_HTML_VARS, type RenderedEmail } from '../email/templates.js';
import { NexusError, isNexusError, quotaExceeded, validationFailed } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { massEmailLockKey, type KeyedSerializer } from '../lib/keyed-serializer.js';

/** Most recipients whose outbox rows one fan-out transaction inserts. */
export const MASS_EMAIL_CHUNK_RECIPIENTS = 200;

/**
 * Rendered bytes one fan-out transaction aims to stay under: a quarter of
 * MongoDB's 16 MB transaction cap, so a campaign of large messages is split
 * into smaller chunks than {@link MASS_EMAIL_CHUNK_RECIPIENTS}.
 */
export const MASS_EMAIL_CHUNK_BYTES = 4 * 1024 * 1024;

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

/** UTF-8 size of one rendered message as the outbox stores it. */
function renderedBytes(rendered: { subject: string; html: string; text: string }): number {
  return (
    Buffer.byteLength(rendered.subject, 'utf8') +
    Buffer.byteLength(rendered.html, 'utf8') +
    Buffer.byteLength(rendered.text, 'utf8')
  );
}

/**
 * The longest display name and the longest address among `recipients`, which
 * together render the largest message of the campaign: the per-recipient
 * variables are the only part of a rendered copy that differs between rows.
 */
function largestRecipient(recipients: readonly UserRecord[]): { name: string; email: string } {
  let name = '';
  let email = '';
  for (const recipient of recipients) {
    if (Buffer.byteLength(recipient.display_name, 'utf8') > Buffer.byteLength(name, 'utf8')) {
      name = recipient.display_name;
    }
    if (Buffer.byteLength(recipient.email, 'utf8') > Buffer.byteLength(email, 'utf8')) {
      email = recipient.email;
    }
  }
  return { name, email };
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

  return {
    resolveAudience,

    async send(actor, request, ip = null): Promise<MassEmailResponse> {
      const subject = request.subject.trim();
      if (subject === '') throw validationFailed('A subject is required');
      if (request.body_html.trim() === '' && request.body_text.trim() === '') {
        throw validationFailed('A message body is required');
      }

      const recipients = await resolveAudience(request.audience);
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
      // later verification and password-reset message.
      const messageBytes = renderedBytes(renderFor(largestRecipient(recipients)));
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
        Math.min(chunkRecipients, Math.floor(MASS_EMAIL_CHUNK_BYTES / Math.max(1, messageBytes))),
      );

      // The daily count reads the actor's own `admin.mass_email` rows and the
      // row charging this campaign is written in the same section, so without
      // the key two instances would each count the same history and both
      // proceed. Taken outside every transaction — the lease repository issues
      // statements of its own — and held across the fan-out.
      return locks(massEmailLockKey(actor.id), async (): Promise<MassEmailResponse> => {
        try {
          await store.transaction(async (tx) => {
            const scoped = audit.forStore(tx);
            const started = await scoped.count({
              actor_user_id: actor.id,
              action: AuditAction.ADMIN_MASS_EMAIL,
              target_type: 'mass_email',
              target_id: batch,
            });
            // A retry of a campaign this administrator already started is
            // already named and already charged.
            if (started > 0) return;
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
      });
    },
  };
}
