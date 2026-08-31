/**
 * God mode — the four emergency operations only a `super_admin` may perform.
 *
 * Nothing here is a new capability: every action is reachable through an
 * ordinary endpoint by *somebody*. What god mode adds is the ability to do it
 * **to somebody else's resources**, without being the owner, and the obligation
 * to say why:
 *
 * | Endpoint         | Ordinary route                         | What god mode adds |
 * |------------------|----------------------------------------|--------------------|
 * | `revoke-grant`   | `POST /api/grants/:id/revoke`          | no ownership needed |
 * | `delete-api`     | `DELETE /api/apis/:id`                 | no ownership needed, optional bulk revoke |
 * | `disable-user`   | `PATCH /api/users/:id`                 | optional bulk grant revocation |
 * | `broadcast`      | `POST /api/admin/mass-email`           | in-app + inbox, not only email |
 *
 * **`reason` is required on all four** and lands in the `god.*` audit row. The
 * underlying operation writes its own ordinary audit row too (`access.revoke`,
 * `api.delete`, …), so an emergency action leaves a two-row trail: what was
 * done, and the fact that it was done under god mode and why.
 *
 * The last active `super_admin` cannot be disabled — the same guard the
 * ordinary user-management route enforces, repeated here because god mode does
 * not go through it.
 */

import {
  type GodBroadcastRequest,
  type GodBroadcastResponse,
  type GodDeleteApiResponse,
  type GodDisableUserResponse,
  type Grant,
  type User,
  type Uuid,
} from '@ferrum-nexus/shared';

import type { AccessService } from '../access/service.js';
import { AuditAction, type AuditService } from '../audit/service.js';
import { tearDownGatewayAccess, type CredentialsService } from '../credentials/service.js';
import type { NexusStore, UserRecord } from '../db/store.js';
import type { EmailService } from '../email/service.js';
import { conflict, lastSuperAdmin, notFound, validationFailed } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { NotificationsService } from '../notifications/service.js';
import type { PublishingService } from '../publishing/service.js';
import { escapeHtml, MASS_RAW_HTML_VARS } from '../email/templates.js';
import type { MassEmailService } from './mass-email-service.js';

/** Public projection of a stored user (no password hash). */
function toPublicUser(record: UserRecord): User {
  const { password_hash: _hash, ...user } = record;
  return user;
}

/** God-mode operations. Every method assumes the caller is a `super_admin`. */
export interface GodService {
  /** Revoke any grant, whoever owns the API. */
  revokeGrant(actor: UserRecord, grantId: Uuid, reason: string, ip?: string | null): Promise<Grant>;
  /** Delete any API, optionally revoking its grants first. */
  deleteApi(
    actor: UserRecord,
    apiId: Uuid,
    reason: string,
    revokeGrants: boolean,
    ip?: string | null,
  ): Promise<GodDeleteApiResponse>;
  /** Disable an account, kill its sessions, optionally revoke its grants. */
  disableUser(
    actor: UserRecord,
    userId: Uuid,
    reason: string,
    revokeGrants: boolean,
    ip?: string | null,
  ): Promise<GodDisableUserResponse>;
  /** Platform message: bell notification, platform inbox thread, optional email. */
  broadcast(
    actor: UserRecord,
    input: GodBroadcastRequest,
    ip?: string | null,
  ): Promise<GodBroadcastResponse>;
}

/** Dependencies of {@link createGodService}. */
export interface GodServiceDeps {
  store: NexusStore;
  audit: AuditService;
  notifications: NotificationsService;
  email: EmailService;
  massEmail: MassEmailService;
  access: AccessService;
  publishing: PublishingService;
  /** Strips the gateway identity of an account being disabled. */
  credentials: Pick<CredentialsService, 'disableGatewayAccess'>;
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** Build the god-mode service. */
export function createGodService(deps: GodServiceDeps): GodService {
  const { store, audit, notifications, email, massEmail, access, publishing, credentials } = deps;

  function requireReason(reason: string): string {
    const trimmed = reason.trim();
    if (trimmed === '') throw validationFailed('A reason is required for a god-mode action');
    return trimmed;
  }

  return {
    async revokeGrant(actor, grantId, reason, ip = null): Promise<Grant> {
      const why = requireReason(reason);
      // `access.revoke` allows any admin, so the super_admin passes its check
      // and the gateway-side group removal + ordinary audit row happen there.
      const grant = await access.revoke(actor, grantId, why, ip);
      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.GOD_REVOKE_GRANT,
        { type: 'grant', id: grant.id },
        { reason: why, api_id: grant.api_id, user_id: grant.user_id },
        ip,
      );
      return grant;
    },

    async deleteApi(actor, apiId, reason, revokeGrants, ip = null): Promise<GodDeleteApiResponse> {
      const why = requireReason(reason);
      const api = await store.apis.findById(apiId);
      if (!api) throw notFound('API', apiId);

      // `publishing.remove` already strips every ACL group and deletes the grant
      // rows; `revoke_grants` decides whether each one is *recorded* as an
      // individual revocation first, which is what an audit reviewer wants.
      let revoked = 0;
      if (revokeGrants) {
        for (const grant of await store.grants.listActiveByApi(api.id)) {
          try {
            await access.revoke(actor, grant.id, why, ip);
            revoked += 1;
          } catch (error) {
            deps.log?.(
              {
                grant_id: grant.id,
                error: error instanceof Error ? error.message : String(error),
              },
              'Could not revoke a grant during a god-mode API deletion',
            );
          }
        }
      }

      const result = await publishing.remove(actor, api.id, ip);
      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.GOD_DELETE_API,
        { type: 'api', id: api.id },
        { reason: why, slug: api.slug, owner_user_id: api.owner_user_id, revoked_grants: revoked },
        ip,
      );

      return {
        deleted_api_id: api.id,
        revoked_grants: revokeGrants ? revoked : result.revoked_grants,
      };
    },

    async disableUser(
      actor,
      userId,
      reason,
      revokeGrants,
      ip = null,
    ): Promise<GodDisableUserResponse> {
      const why = requireReason(reason);
      const target = await store.users.findById(userId);
      if (!target) throw notFound('User', userId);
      if (target.id === actor.id) throw conflict('You cannot disable your own account');
      if (
        target.role === 'super_admin' &&
        target.status === 'active' &&
        (await store.users.countActiveSuperAdmins(target.id)) === 0
      ) {
        throw lastSuperAdmin();
      }

      const revoked = revokeGrants ? await access.revokeAllForUser(actor, target.id, why, ip) : 0;

      const updated =
        target.status === 'disabled'
          ? target
          : ((await store.users.update(target.id, { status: 'disabled' })) ?? target);
      // A disabled account keeps no usable browser session — and no working
      // gateway identity, which a session cookie has nothing to do with.
      const terminated = await store.sessions.deleteForUser(target.id);
      const teardown = await tearDownGatewayAccess(credentials, target.id, actor.id, deps.log);

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.GOD_DISABLE_USER,
        { type: 'user', id: target.id },
        {
          reason: why,
          revoked_grants: revoked,
          terminated_sessions: terminated,
          previous_status: target.status,
          ...teardown,
        },
        ip,
      );

      return {
        user: toPublicUser(updated),
        revoked_grants: revoked,
        terminated_sessions: terminated,
      };
    },

    async broadcast(actor, input, ip = null): Promise<GodBroadcastResponse> {
      const subject = input.subject.trim();
      const body = input.body.trim();
      if (subject === '') throw validationFailed('A subject is required');
      if (body === '') throw validationFailed('A message body is required');

      const recipients = (await massEmail.resolveAudience(input.audience)).filter(
        (recipient) => recipient.id !== actor.id,
      );

      const notified = (
        await notifications.notifyMany(
          recipients.map((recipient) => recipient.id),
          'system',
          subject,
          body,
          '/messages',
        )
      ).length;

      // The message also lands in each recipient's platform inbox
      // (`participant_b = null`), so it survives being dismissed from the bell
      // and any admin can follow up in the same thread.
      let threads = 0;
      let emails = 0;
      for (const recipient of recipients) {
        try {
          const existing = await store.threads.findExisting(recipient.id, null, null);
          const thread =
            existing ??
            (await store.threads.create({
              subject,
              api_id: null,
              created_by: actor.id,
              participant_a: recipient.id,
              participant_b: null,
            }));
          await store.messages.create({
            thread_id: thread.id,
            sender_user_id: actor.id,
            body,
          });
          await store.threads.touchLastMessage(thread.id, nowIso());
          if (!existing) threads += 1;

          if (input.send_email) {
            const queued = await email.enqueue({
              to: recipient.email,
              templateKey: 'mass',
              rawHtmlVars: MASS_RAW_HTML_VARS,
              vars: {
                recipient_name: recipient.display_name,
                recipient_email: recipient.email,
                subject,
                body_html: `<p>${escapeHtml(body)}</p>`,
                body_text: body,
              },
            });
            if (queued.created) emails += 1;
          }
        } catch (error) {
          deps.log?.(
            {
              recipient_id: recipient.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'Could not deliver a god-mode broadcast to one recipient',
          );
        }
      }

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.GOD_BROADCAST,
        { type: 'broadcast', id: null },
        {
          reason: subject,
          audience_scope: input.audience.scope,
          recipients: recipients.length,
          notified,
          threads_created: threads,
          emails_enqueued: emails,
          send_email: input.send_email === true,
        },
        ip,
      );

      return { notified, emails_enqueued: emails, threads_created: threads };
    },
  };
}
