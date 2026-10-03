/**
 * The admin SMTP probe — `POST /api/admin/settings/smtp-test`.
 *
 * The probe goes straight to the relay rather than through the outbox, so the
 * settings page can report a configuration error immediately. That makes it an
 * irreversible external side effect, and it is bounded and recorded like one:
 *
 * - **Recipient policy.** An `admin` may only probe their own account address.
 *   Only a `super_admin` — who can change the SMTP settings themselves — may
 *   name another address. Before this, any administrator could use the probe as
 *   a direct relay to any address, outside the outbox and its budgets.
 * - **Budget.** At most {@link SMTP_TEST_LIMIT} probes per administrator per
 *   rolling {@link SMTP_TEST_WINDOW_LABEL}, counted from their own
 *   `admin.smtp_test` rows under a per-administrator key, so the count is exact
 *   across instances. The route also carries a per-minute limiter.
 * - **Intent before effect.** The `admin.smtp_test` row commits — together with
 *   the count that admits it — **before** the relay is contacted. A failure to
 *   write it stops the probe, so a delivered message is never missing from the
 *   trail. The result is a separate, best-effort `admin.smtp_test_complete` row
 *   naming the intent row's id: failing the request after the relay accepted the
 *   message would only invite a second send.
 */

import type { Role, SmtpTestResponse, Uuid } from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusStore } from '../db/store.js';
import type { EmailService } from '../email/service.js';
import { forbidden, quotaExceeded } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { smtpTestLockKey, type KeyedSerializer } from '../lib/keyed-serializer.js';

/** Most SMTP probes one administrator may send per {@link SMTP_TEST_WINDOW_MS}. */
export const SMTP_TEST_LIMIT = 10;

/** The rolling window {@link SMTP_TEST_LIMIT} is counted over. */
export const SMTP_TEST_WINDOW_MS = 60 * 60 * 1000;

/** Human label for {@link SMTP_TEST_WINDOW_MS}, echoed in the error details. */
export const SMTP_TEST_WINDOW_LABEL = '1h';

/** Who is sending the probe: the signed-in administrator. */
export interface SmtpTestActor {
  id: Uuid;
  role: Role;
  /** The account's own address — the default, and for an `admin` the only, recipient. */
  email: string;
}

/** The SMTP probe. */
export interface SmtpTestService {
  /**
   * Send one probe message to `toEmail`, or to the actor's own address when
   * it is omitted. Throws `FORBIDDEN` when an `admin` names another address,
   * and `QUOTA_EXCEEDED` past the hourly budget; reports a relay failure as
   * `{ ok: false }` rather than throwing.
   */
  send(actor: SmtpTestActor, toEmail?: string, ip?: string | null): Promise<SmtpTestResponse>;
}

/** Dependencies of {@link createSmtpTestService}. */
export interface SmtpTestServiceDeps {
  store: NexusStore;
  email: EmailService;
  audit: AuditService;
  /**
   * Cross-instance per-key lock the budget count runs under. Defaults to
   * running the section directly — correct for a single instance only.
   */
  locks?: KeyedSerializer;
  /** Structured logger for the best-effort outcome row. */
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** Case-insensitive address comparison; registration stores addresses lowercased. */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Build the SMTP probe service. */
export function createSmtpTestService(deps: SmtpTestServiceDeps): SmtpTestService {
  const { store, email, audit } = deps;
  const locks: KeyedSerializer = deps.locks ?? ((_key, fn) => fn());

  return {
    async send(actor, toEmail, ip = null): Promise<SmtpTestResponse> {
      const to = toEmail ?? actor.email;
      if (actor.role !== 'super_admin' && !sameAddress(to, actor.email)) {
        throw forbidden(
          'Only a super admin may send the SMTP test to an address other than their own',
        );
      }
      const auditActor = { id: actor.id, role: actor.role };

      return locks(smtpTestLockKey(actor.id), async (): Promise<SmtpTestResponse> => {
        // Minted here so the outcome row can name the intent row it completes.
        const intentId = newId();
        await store.transaction(async (tx) => {
          const scoped = audit.forStore(tx);
          const since = new Date(Date.now() - SMTP_TEST_WINDOW_MS).toISOString();
          const used = await scoped.count({
            actor_user_id: actor.id,
            action: AuditAction.ADMIN_SMTP_TEST,
            from: since,
          });
          if (used >= SMTP_TEST_LIMIT) {
            throw quotaExceeded(
              `You have sent ${used} SMTP tests in the last ${SMTP_TEST_WINDOW_LABEL}, the ` +
                `maximum of ${SMTP_TEST_LIMIT}. Wait for the oldest of them to age out.`,
              { limit: SMTP_TEST_LIMIT, used, window: SMTP_TEST_WINDOW_LABEL },
            );
          }
          await scoped.record(
            auditActor,
            AuditAction.ADMIN_SMTP_TEST,
            { type: 'settings', id: 'smtp' },
            { to_email: to, phase: 'started' },
            ip,
            { id: intentId },
          );
        });

        const result = await email.sendTest(to);

        // Best effort, unlike the row above: the attempt is already durable and
        // countable, and a `500` after the relay accepted the message would
        // only be answered by sending it again.
        try {
          await audit.record(
            auditActor,
            AuditAction.ADMIN_SMTP_TEST_COMPLETE,
            { type: 'settings', id: 'smtp' },
            { to_email: to, ok: result.ok, intent_id: intentId },
            ip,
          );
        } catch (error) {
          deps.log?.(
            {
              intent_id: intentId,
              ok: result.ok,
              error: error instanceof Error ? error.message : String(error),
            },
            'An SMTP test ran but its completion record could not be written',
          );
        }
        return result;
      });
    },
  };
}
