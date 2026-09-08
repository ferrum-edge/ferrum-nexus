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
 * work — which makes the composer safe to retry after a timeout.
 *
 * **The fan-out is one transaction.** Every outbox row and the
 * `admin.mass_email` audit row commit together or not at all. Enqueueing one
 * recipient at a time and auditing afterwards meant a failure partway left the
 * rows it had already committed delivered, nothing in the audit log naming the
 * campaign, and a bare `500` — and because the batch id was generated inside
 * the call and never surfaced, the natural retry minted a *new* one and mailed
 * the already-delivered recipients a second time. Now a failed campaign has
 * queued nothing, and its {@link MassEmailResponse.batch_id} comes back on both
 * the success and the failure path so a retry can reuse it either way.
 *
 * Rendering happens **before** the transaction opens: it reads the template and
 * the branding per recipient and does the string work, none of which needs to
 * be inside the atomic section. What the transaction holds is the inserts.
 *
 * **And the audience is bounded**, by `NEXUS_MAX_MASS_EMAIL_RECIPIENTS`,
 * checked before any of that. Atomicity is not free: the inserts are what one
 * transaction holds, and transaction bodies are serialised per store object, so
 * an unbounded fan-out is also an unbounded stall for every other write on the
 * instance. On MongoDB it is a hard wall rather than a stall — 16 MB per
 * transaction, counted against each row's whole rendered HTML and text. The
 * ceiling names itself in the refusal, exactly as the broadcast ceilings do.
 */

import type { MassEmailAudience, MassEmailRequest, MassEmailResponse } from '@ferrum-nexus/shared';

import { AuditAction, type AuditActor, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type { EnqueueEmailInput, NexusStore, UserFilter, UserRecord } from '../db/store.js';
import type { EmailService } from '../email/service.js';
import { MASS_RAW_HTML_VARS } from '../email/templates.js';
import { NexusError, isNexusError, quotaExceeded, validationFailed } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

/** Mass-email operations. */
export interface MassEmailService {
  /** Resolve the audience and enqueue one message per recipient. */
  send(
    actor: AuditActor,
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
}

/** Build the mass-email service. */
export function createMassEmailService(deps: MassEmailServiceDeps): MassEmailService {
  const { config, store, email, audit } = deps;

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

  return {
    resolveAudience,

    async send(actor, request, ip = null): Promise<MassEmailResponse> {
      const subject = request.subject.trim();
      if (subject === '') throw validationFailed('A subject is required');
      if (request.body_html.trim() === '' && request.body_text.trim() === '') {
        throw validationFailed('A message body is required');
      }

      const recipients = await resolveAudience(request.audience);
      // Before the rendering and before the transaction: an audience too large
      // to queue atomically must cost nothing at all, not a full render pass
      // and a rolled-back fan-out. Same refusal shape as the broadcast
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

      // Rendered outside the transaction: one template read, one branding read
      // and the interpolation per recipient, none of which the atomic section
      // needs to hold open.
      const queue: EnqueueEmailInput[] = [];
      for (const recipient of recipients) {
        const rendered = await email.render(
          'mass',
          {
            recipient_name: recipient.display_name,
            recipient_email: recipient.email,
            subject,
            body_html: request.body_html,
            body_text: request.body_text,
          },
          MASS_RAW_HTML_VARS,
        );
        queue.push({
          to_email: recipient.email,
          subject: rendered.subject,
          body_html: rendered.html,
          body_text: rendered.text,
          idempotency_key: `mass:${batch}:${recipient.id}`,
        });
      }

      try {
        const enqueued = await store.transaction(async (tx) => {
          let created = 0;
          for (const entry of queue) {
            const result = await tx.emailOutbox.enqueue(entry);
            if (result.created) created += 1;
          }
          const scoped = audit.forStore(tx);
          await scoped.record(
            actor,
            AuditAction.ADMIN_MASS_EMAIL,
            { type: 'mass_email', id: batch },
            {
              subject,
              audience_scope: request.audience.scope,
              recipients: recipients.length,
              enqueued: created,
            },
            ip,
          );
          return created;
        });
        return { enqueued, recipients: recipients.length, batch_id: batch };
      } catch (cause) {
        // Contention that outlived the pooled adapters' retry budget is a
        // `CONFLICT`, not an outbox failure: the campaign is still queueable and
        // the caller should retry it, which is a different instruction from
        // "this send is broken". Keep the code — and therefore the `409` — and
        // only add the batch id the retry needs.
        if (isNexusError(cause) && cause.code === 'CONFLICT') {
          throw new NexusError(
            cause.code,
            cause.message,
            {
              ...(typeof cause.details === 'object' && cause.details !== null ? cause.details : {}),
              batch_id: batch,
            },
            { cause },
          );
        }
        // Nothing was queued and nothing was audited — but the admin still
        // needs the batch id, because a *lost response* to a campaign that did
        // commit is indistinguishable from this one at the browser, and reusing
        // the key is what makes the retry safe in both cases.
        throw new NexusError(
          'OUTBOX_FAILURE',
          'The campaign could not be queued; nothing was sent. Retry with the same ' +
            'idempotency_key to avoid mailing anyone twice.',
          { batch_id: batch, recipients: recipients.length, enqueued: 0 },
          { cause },
        );
      }
    },
  };
}
