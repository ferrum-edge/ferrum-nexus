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
 */

import type { MassEmailAudience, MassEmailRequest, MassEmailResponse } from '@ferrum-nexus/shared';

import { AuditAction, type AuditActor, type AuditService } from '../audit/service.js';
import type { NexusStore, UserFilter, UserRecord } from '../db/store.js';
import type { EmailService } from '../email/service.js';
import { MASS_RAW_HTML_VARS } from '../email/templates.js';
import { validationFailed } from '../lib/errors.js';
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
  store: NexusStore;
  email: EmailService;
  audit: AuditService;
}

/** Build the mass-email service. */
export function createMassEmailService(deps: MassEmailServiceDeps): MassEmailService {
  const { store, email, audit } = deps;

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
      const batch = request.idempotency_key ?? newId();

      let enqueued = 0;
      for (const recipient of recipients) {
        const result = await email.enqueue({
          to: recipient.email,
          templateKey: 'mass',
          idempotencyKey: `mass:${batch}:${recipient.id}`,
          rawHtmlVars: MASS_RAW_HTML_VARS,
          vars: {
            recipient_name: recipient.display_name,
            recipient_email: recipient.email,
            subject,
            body_html: request.body_html,
            body_text: request.body_text,
          },
        });
        if (result.created) enqueued += 1;
      }

      await audit.record(
        actor,
        AuditAction.ADMIN_MASS_EMAIL,
        { type: 'mass_email', id: batch },
        {
          subject,
          audience_scope: request.audience.scope,
          recipients: recipients.length,
          enqueued,
        },
        ip,
      );

      return { enqueued, recipients: recipients.length };
    },
  };
}
