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
 * not go through it, and enforced the same way: the count that decides runs
 * inside the transaction that writes the row.
 *
 * ## The broadcast's own bounds
 *
 * `broadcast` is the one god-mode operation whose cost scales with the size of
 * the portal, and its message rows are marked `broadcast` so they stay out of
 * the acting administrator's rolling daily message budget — one announcement to
 * a portal larger than that budget used to refuse every ordinary message they
 * sent for the next day, while further broadcasts, checked against nothing,
 * stayed available. Two explicit ceilings replace it, both enforced before a
 * single row is written and both naming the setting an operator would raise:
 * `NEXUS_MAX_BROADCAST_RECIPIENTS` on one announcement's audience, and
 * `NEXUS_MAX_BROADCASTS_PER_DAY` on how many an administrator may send.
 *
 * The second of those counts `god.broadcast` audit rows, which is why that row
 * is written **before** the fan-out rather than after it: a broadcast that
 * reached the whole portal and then failed to record itself was uncharged
 * against the ceiling and missing from the trail, and the `500` its caller got
 * invited a retry that announced everything twice. `god.broadcast` is therefore
 * one row per *attempt*, and `god.broadcast_complete` reports what the attempt
 * achieved — `delivered` and `failed` per recipient, not the audience size.
 */

import { createHash } from 'node:crypto';

import {
  type GodBroadcastRequest,
  type GodBroadcastResponse,
  type GodDeleteApiResponse,
  type GodDisableUserResponse,
  type Grant,
  type User,
  type Uuid,
} from '@ferrum-nexus/shared';

import type { AccessService, BulkRevocationResult } from '../access/service.js';
import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import { runGatewayTeardown, type CredentialsService } from '../credentials/service.js';
import type { GatewayTeardownJobRecord, NexusStore, UserRecord } from '../db/store.js';
import type { EmailService } from '../email/service.js';
import {
  NexusError,
  conflict,
  edgeError,
  lastSuperAdmin,
  notFound,
  quotaExceeded,
  validationFailed,
} from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import {
  broadcastLockKey,
  SUPER_ADMIN_LOCK_KEY,
  userLifecycleLockKey,
  type KeyedSerializer,
} from '../lib/keyed-serializer.js';
import type { NotificationsService } from '../notifications/service.js';
import type { PublishingService } from '../publishing/service.js';
import {
  escapeHtml,
  MASS_RAW_HTML_VARS,
  type RenderedEmail,
  type TemplateVars,
} from '../email/templates.js';
import type { MassEmailService } from './mass-email-service.js';

/** Width of the rolling per-administrator broadcast budget, in milliseconds. */
export const BROADCAST_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Human label for {@link BROADCAST_BUDGET_WINDOW_MS}, echoed in the error details. */
export const BROADCAST_BUDGET_WINDOW_LABEL = '24h';

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
  config: NexusConfig;
  store: NexusStore;
  audit: AuditService;
  notifications: NotificationsService;
  email: EmailService;
  massEmail: MassEmailService;
  access: AccessService;
  publishing: PublishingService;
  /** Strips the gateway identity of an account being disabled. */
  credentials: Pick<CredentialsService, 'disableGatewayAccess'>;
  /**
   * The same store-level lock `users.updateUser` takes. God mode repeats the
   * last-super-admin rule, so it has to contend for the same key — otherwise an
   * ordinary demotion on one instance and a god-mode disable on another still
   * race each other.
   */
  locks?: KeyedSerializer;
  /**
   * The serializer `broadcast` takes its per-actor key from — the same one
   * messaging spends the daily budget under, so a refused send says what is
   * actually in flight. It is what makes the per-day broadcast ceiling hold
   * across instances: the count and the `god.broadcast` row that makes this
   * attempt countable are one step only inside it. Defaults to the plain
   * in-process ordering.
   */
  broadcastLocks?: KeyedSerializer;
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** Build the god-mode service. */
export function createGodService(deps: GodServiceDeps): GodService {
  const { store, audit, notifications, email, massEmail, access, publishing, credentials } = deps;
  const locks: KeyedSerializer = deps.locks ?? ((_key, fn) => fn());
  const broadcastLocks: KeyedSerializer = deps.broadcastLocks ?? ((_key, fn) => fn());

  function requireReason(reason: string): string {
    const trimmed = reason.trim();
    if (trimmed === '') throw validationFailed('A reason is required for a god-mode action');
    return trimmed;
  }

  /**
   * The broadcast path's own bounds, checked **before any row is written**.
   *
   * A broadcast is the highest-amplification operation in the portal — one
   * request writes a notification row, a platform-inbox message and optionally
   * a queued mail per active account — and its rows deliberately do not draw on
   * the acting administrator's daily message budget. These two ceilings are
   * what replaces it: one on the size of a single announcement, one on how many
   * an administrator may send in a rolling 24 hours. Both name the limit and
   * the setting an operator would raise, because a refused *emergency*
   * broadcast has to say how to send it anyway.
   *
   * The per-day count reads the actor's own `god.broadcast` audit rows rather
   * than a counter of its own: the trail already records every broadcast
   * *attempt* exactly once — that row is written before the first recipient is
   * touched, and the delivery outcome is a separate `god.broadcast_complete`
   * row — so an operator reading the number can see precisely which rows it
   * refers to.
   *
   * `auditor` is the transaction-scoped audit service of the transaction that
   * writes that row, so the count and the insert commit together — and under
   * the broadcast key's fence, which is what keeps an instance that stalled
   * past the lease TTL from counting stale history and then committing.
   */
  async function assertBroadcastWithinBounds(
    auditor: AuditService,
    actorId: Uuid,
    audience: number,
  ): Promise<void> {
    const recipientLimit = deps.config.maxBroadcastRecipients;
    if (recipientLimit > 0 && audience > recipientLimit) {
      throw quotaExceeded(
        `This broadcast addresses ${audience} recipients, more than the maximum of ` +
          `${recipientLimit}. Narrow the audience, or ask an operator to raise the limit.`,
        {
          limit: recipientLimit,
          recipients: audience,
          setting: 'NEXUS_MAX_BROADCAST_RECIPIENTS',
        },
      );
    }

    const dailyLimit = deps.config.maxBroadcastsPerDay;
    if (dailyLimit <= 0) return;
    const since = new Date(Date.now() - BROADCAST_BUDGET_WINDOW_MS).toISOString();
    const used = await auditor.count({
      actor_user_id: actorId,
      action: AuditAction.GOD_BROADCAST,
      from: since,
    });
    if (used < dailyLimit) return;
    throw quotaExceeded(
      `You have sent ${used} broadcasts in the last ${BROADCAST_BUDGET_WINDOW_LABEL}, ` +
        `the maximum of ${dailyLimit}. Wait for the oldest of them to age out, or ask an ` +
        'operator to raise the limit.',
      {
        limit: dailyLimit,
        used,
        recipients: audience,
        window: BROADCAST_BUDGET_WINDOW_LABEL,
        setting: 'NEXUS_MAX_BROADCASTS_PER_DAY',
      },
    );
  }

  return {
    async revokeGrant(actor, grantId, reason, ip = null): Promise<Grant> {
      const why = requireReason(reason);
      // `access.revoke` allows any admin, so the super_admin passes its check
      // and the gateway-side group removal + ordinary audit row happen there.
      // The god-mode row commits in the transaction that claims the grant and
      // records `access.revoke`, so the reason is never missing from a
      // revocation that happened, nor present for one that did not.
      return access.revoke(actor, grantId, why, ip, async (tx, revoked) => {
        await audit
          .forStore(tx)
          .record(
            { id: actor.id, role: actor.role },
            AuditAction.GOD_REVOKE_GRANT,
            { type: 'grant', id: revoked.id },
            { reason: why, api_id: revoked.api_id, user_id: revoked.user_id },
            ip,
          );
      });
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

      // The god-mode row commits in the transaction that removes the API and
      // records `api.delete`, so the reason is never missing from a delete that
      // happened, nor present for one that rolled back.
      const result = await publishing.remove(actor, api.id, ip, async (tx) => {
        await audit.forStore(tx).record(
          { id: actor.id, role: actor.role },
          AuditAction.GOD_DELETE_API,
          { type: 'api', id: api.id },
          {
            reason: why,
            slug: api.slug,
            owner_user_id: api.owner_user_id,
            revoked_grants: revoked,
          },
          ip,
        );
      });

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
      // Order matters, and matches `users.updateUser`: a last super admin
      // disabling *themselves* is refused because they are the last one, not
      // because it is a self-disable, so `LAST_SUPER_ADMIN` must win over
      // `CONFLICT` — that is the message that tells them how to fix it.
      if (
        target.role === 'super_admin' &&
        target.status === 'active' &&
        (await store.users.countActiveSuperAdmins(target.id)) === 0
      ) {
        throw lastSuperAdmin();
      }
      if (target.id === actor.id) throw conflict('You cannot disable your own account');

      // The count and the write share one transaction body, exactly as
      // `users.updateUser` does: the pre-check above is advisory, because two
      // concurrent disables both pass it and leave the portal with no active
      // super admin. Bodies are serialised, so the loser re-counts after the
      // winner committed; the conditional update also refuses a target whose
      // role or status changed since it was read.
      //
      // And, exactly as there, that serialisation only covers one store object.
      // Disabling an active super admin therefore also runs under the shared
      // `SUPER_ADMIN_LOCK_KEY` lease, which is what puts a god-mode disable on
      // one instance in line behind an ordinary demotion on another. The lease
      // is taken outside the transaction — see `users/service.ts`.
      const guardsLastSuperAdmin = target.role === 'super_admin' && target.status === 'active';
      // The disable, its session cut-off, its queued revocation and both of
      // its audit rows commit together. Recorded after the commit, a failed
      // insert left the account disabled with no row naming who did it or why;
      // now it leaves the account exactly as it was. What the steps after the
      // commit achieved is the separate `god.disable_user_complete` row.
      const transition = async (): Promise<{
        row: UserRecord;
        job: GatewayTeardownJobRecord;
        terminated: number;
      }> =>
        store.transaction(async (tx) => {
          const current = await tx.users.findById(target.id);
          if (!current) throw notFound('User', userId);
          if (current.role !== target.role || current.status !== target.status) {
            throw conflict(
              'That account changed while you were disabling it — reload and try again',
            );
          }
          if (guardsLastSuperAdmin && (await tx.users.countActiveSuperAdmins(target.id)) === 0) {
            throw lastSuperAdmin();
          }
          // Even an already-disabled account takes the conditional write:
          // it must serialize with a concurrent re-enable in the database.
          const row = await tx.users.updateIfMatches(
            target.id,
            { role: current.role, status: current.status },
            { status: 'disabled' },
          );
          if (!row) {
            throw conflict(
              'That account changed while you were disabling it — reload and try again',
            );
          }
          // Every write rolls back on any failure, including a lost predicate.
          const job = await tx.gatewayTeardownJobs.upsertPending(target.id, actor.id, nowIso());
          // A disabled account keeps no usable browser session.
          const terminated = await tx.sessions.deleteForUser(target.id);
          await audit.forStore(tx).record(
            { id: actor.id, role: actor.role },
            AuditAction.USER_DISABLE,
            { type: 'user', id: target.id },
            {
              changed_fields: target.status === 'disabled' ? [] : ['status'],
              from_status: target.status,
              to_status: 'disabled',
              terminated_sessions: terminated,
              gateway_teardown: 'queued',
            },
            ip,
          );
          await audit.forStore(tx).record(
            { id: actor.id, role: actor.role },
            AuditAction.GOD_DISABLE_USER,
            { type: 'user', id: target.id },
            {
              reason: why,
              previous_status: target.status,
              terminated_sessions: terminated,
              revoke_grants: revokeGrants,
              gateway_teardown: 'queued',
            },
            ip,
          );
          return { row, job, terminated };
        });

      // And, exactly as there, under the account's lifecycle key — the one a
      // gateway identity registration for this account is taken under — so the
      // teardown that follows the flip sees every identity the account got as
      // far as registering. Inside the super-admin key, never around it.
      const lifecycle = (): ReturnType<typeof transition> =>
        locks(userLifecycleLockKey(target.id), transition);
      const outcome = guardsLastSuperAdmin
        ? await locks(SUPER_ADMIN_LOCK_KEY, lifecycle)
        : await lifecycle();
      const updated = outcome.row;
      const terminated = outcome.terminated;

      // The disable has committed and is audited, so every step from here on
      // runs whatever the one before it did: a throw that skipped them left a
      // disabled account with grants or a gateway identity nobody went back
      // for. A failed step is named in the completion row, and its error is
      // raised once that row is written.
      const failedSteps: string[] = [];
      let failure: unknown = null;
      const fail = (step: string, error: unknown): void => {
        if (failedSteps.length === 0) failure = error;
        failedSteps.push(step);
        deps.log?.(
          {
            user_id: target.id,
            step,
            error: error instanceof Error ? error.message : String(error),
          },
          'A god-mode disable step failed after the disable committed',
        );
      };
      const attempt = async <T>(step: string, fallback: T, run: () => Promise<T>): Promise<T> => {
        try {
          return await run();
        } catch (error) {
          fail(step, error);
          return fallback;
        }
      };

      // Only once the disable has committed. The checks above are advisory and
      // the transaction re-decides — a concurrent demotion can make this the
      // last super admin, a concurrent edit can move the row — and revoking
      // first meant a refused disable still stripped every grant of an account
      // that stayed active (issue #337). Revoking is a per-grant claim plus an
      // ACL removal, neither of which minds the account being disabled; it runs
      // before the teardown so each group comes off a consumer that still exists.
      const none: BulkRevocationResult = { revoked: 0, failed: [] };
      const sweep = revokeGrants
        ? await attempt('revoke_grants', none, () =>
            access.revokeAllForUser(actor, target.id, why, ip),
          )
        : none;
      const revoked = sweep.revoked;
      // A sweep that could not revoke every grant is not a success, and is
      // never reported as one (issue #341): the step is named in
      // `failed_steps`, the grants in the completion row, and the request
      // answers with the error once it is written. A grant stopped after its claim
      // stays `revoked` in the portal, so neither a retry nor a later
      // re-enable replays it: the teardown below strips its group, and should
      // that fail as well, a re-enable rebuilds the account's approval groups
      // from its active grants alone, dropping this one.
      const failedGrants = sweep.failed.map((entry) => ({
        grant_id: entry.grant_id,
        api_id: entry.api_id,
        application_id: entry.application_id,
        stage: entry.stage,
      }));
      if (failedGrants.length > 0) {
        // Only a `claim` failure leaves a grant active for a repeat of the
        // disable to sweep again; every other stage already revoked it in the
        // portal, and what is left of it on the gateway is the teardown's.
        const message =
          `${failedGrants.length} of this account's grants could not be fully revoked. The ` +
          'disable is committed. A grant that could not be claimed is still active, and ' +
          'repeating the disable retries it; a revoked grant whose group may still be on the ' +
          "gateway is taken off by the account's gateway teardown, queued until it succeeds.";
        fail(
          'revoke_grants',
          failedGrants.some((entry) => entry.stage === 'gateway')
            ? edgeError(message, { failed_grants: failedGrants })
            : new NexusError('INTERNAL', message, { failed_grants: failedGrants }),
        );
      }
      const sweepDetails = failedGrants.length
        ? { failed_grant_revocations: failedGrants.length, failed_grants: failedGrants }
        : {};

      // No working gateway identity either, which a session cookie has nothing
      // to do with.
      const teardown = await runGatewayTeardown({
        credentials,
        store,
        userId: target.id,
        subject: actor.id,
        job: outcome.job,
        ...(deps.log ? { log: deps.log } : {}),
      });
      // A failure to record the teardown's own outcome is one more failed
      // step, named in the completion row below — it must not cost that row,
      // which is the only record of the sweep.
      if (teardown.outcome !== 'pending') {
        await attempt<unknown>('record_gateway_teardown', undefined, () =>
          audit.record(
            { id: actor.id, role: actor.role },
            AuditAction.USER_GATEWAY_TEARDOWN_COMPLETE,
            { type: 'user', id: target.id },
            { inline: true, ...teardown.details },
            ip,
          ),
        );
      }

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.GOD_DISABLE_USER_COMPLETE,
        { type: 'user', id: target.id },
        {
          reason: why,
          revoked_grants: revoked,
          terminated_sessions: terminated,
          ...teardown.details,
          ...sweepDetails,
          ...(failedSteps.length ? { failed_steps: failedSteps } : {}),
        },
        ip,
      );
      // Recorded above; the caller still learns the disable did not finish, and
      // repeating it re-runs every step against the already-disabled account.
      if (failedSteps.length) throw failure;

      return {
        user: toPublicUser(updated),
        revoked_grants: revoked,
        terminated_sessions: terminated,
        gateway_teardown: teardown.outcome,
      };
    },

    async broadcast(actor, input, ip = null): Promise<GodBroadcastResponse> {
      const subject = input.subject.trim();
      const body = input.body.trim();
      if (subject === '') throw validationFailed('A subject is required');
      if (body === '') throw validationFailed('A message body is required');

      // Content and actor scope prevent unrelated campaigns sharing an outbox
      // key. An explicit batch permits intentionally repeating the same text;
      // legacy callers without one still get stable email retry behavior.
      const batch = createHash('sha256')
        .update(
          JSON.stringify({
            actor: actor.id,
            key: input.idempotency_key ?? null,
            subject,
            body,
            audience: {
              scope: input.audience.scope,
              roles: [...new Set(input.audience.roles ?? [])].sort(),
              status: input.audience.status ?? null,
              org_id: input.audience.org_id ?? null,
              user_ids: [...new Set(input.audience.user_ids ?? [])].sort(),
            },
          }),
        )
        .digest('hex');

      const recipients = (await massEmail.resolveAudience(input.audience)).filter(
        (recipient) => recipient.id !== actor.id,
      );
      // An audience that resolves to nobody is a mistake, not a broadcast: it
      // would pass both ceilings, write nothing, and still burn one of the
      // administrator's twenty daily slots on a countable row describing an
      // announcement nobody received. `resolveAudience` already refuses an
      // empty explicit list; this is the same refusal for a filter or a
      // `scope: 'all'` that matched only the sender.
      if (recipients.length === 0) {
        throw validationFailed(
          'That audience matches nobody — every account it selects is inactive, or the only ' +
            'match is you, and a broadcast never reaches its own sender',
        );
      }

      // Both ceilings and the whole fan-out run under one per-actor key. The
      // per-day count reads the actor's own `god.broadcast` rows, so without
      // the key two instances would each count the same history and both
      // proceed. The key is taken outside every transaction — the lease
      // repository issues statements of its own.
      return broadcastLocks(broadcastLockKey(actor.id), async (): Promise<GodBroadcastResponse> => {
        // The countable row goes in **before** the first recipient side effect,
        // because it is what `assertBroadcastWithinBounds` counts. Written
        // afterwards, an audit failure meant the announcement had already
        // reached the whole portal while the attempt was uncharged against the
        // daily ceiling and absent from the trail — the caller's `500` then
        // invited a retry that broadcast a second time. One row per *attempt*,
        // whatever the attempt goes on to do; the outcome is a second action.
        // Counted in the same transaction, so the check and the charge are one
        // fenced step.
        await store.transaction(async (tx) => {
          const scoped = audit.forStore(tx);
          await assertBroadcastWithinBounds(scoped, actor.id, recipients.length);
          await scoped.record(
            { id: actor.id, role: actor.role },
            AuditAction.GOD_BROADCAST,
            { type: 'broadcast', id: batch },
            {
              reason: subject,
              audience_scope: input.audience.scope,
              recipients: recipients.length,
              send_email: input.send_email === true,
              phase: 'started',
            },
            ip,
          );
        });

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
        // Counted, not merely logged. `recipients.length` is the audience, and
        // reporting it as the delivery made a broadcast that reached nobody
        // indistinguishable from one that reached everybody — in the response
        // and in the audit row alike.
        let delivered = 0;
        let failed = 0;
        // The template and branding are read once for the whole broadcast, as
        // the mass-email path does, instead of once per recipient inside
        // `email.enqueue` (issue #343). Prepared on first use inside the
        // per-recipient `try`, so a failed read costs that recipient's email
        // exactly as it did before and is retried for the next one; only a
        // successful preparation is kept.
        let render: ((vars?: TemplateVars) => RenderedEmail) | null = null;
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
              // The one place this flag is ever set. It is what keeps a
              // broadcast out of the acting admin's rolling daily message
              // budget: the rows are the platform's announcement, not their
              // personal correspondence, and charging hundreds of them to one
              // account used to refuse every ordinary message it sent for the
              // next 24 hours. The ceilings above are the bound instead.
              broadcast: true,
            });
            await store.threads.touchLastMessage(thread.id, nowIso());
            if (!existing) threads += 1;
            // The inbox message is what "delivered" means: the notification is
            // dismissable and the mail is optional, but the thread row is what
            // the recipient can still read tomorrow.
            delivered += 1;

            if (input.send_email) {
              render ??= await email.prepareRenderer('mass', MASS_RAW_HTML_VARS);
              const rendered = render({
                recipient_name: recipient.display_name,
                recipient_email: recipient.email,
                subject,
                body_html: `<p>${escapeHtml(body)}</p>`,
                body_text: body,
              });
              const queued = await store.emailOutbox.enqueue({
                to_email: recipient.email,
                subject: rendered.subject,
                body_html: rendered.html,
                body_text: rendered.text,
                idempotency_key: `god-broadcast:${batch}:${recipient.id}`,
              });
              if (queued.created) emails += 1;
            }
          } catch (error) {
            failed += 1;
            deps.log?.(
              {
                recipient_id: recipient.id,
                error: error instanceof Error ? error.message : String(error),
              },
              'Could not deliver a god-mode broadcast to one recipient',
            );
          }
        }

        const outcome: GodBroadcastResponse = {
          notified,
          emails_enqueued: emails,
          threads_created: threads,
          delivered,
          failed,
        };

        // Best effort, unlike the row above. The attempt is already durable,
        // countable and named in the trail, so a failure to record what it
        // achieved must not turn a delivered announcement into a `500` the
        // administrator would answer by broadcasting again.
        try {
          await audit.record(
            { id: actor.id, role: actor.role },
            AuditAction.GOD_BROADCAST_COMPLETE,
            { type: 'broadcast', id: batch },
            {
              reason: subject,
              audience_scope: input.audience.scope,
              recipients: recipients.length,
              send_email: input.send_email === true,
              ...outcome,
            },
            ip,
          );
        } catch (error) {
          deps.log?.(
            {
              batch,
              delivered,
              failed,
              error: error instanceof Error ? error.message : String(error),
            },
            'A god-mode broadcast went out but its completion record could not be written',
          );
        }

        return outcome;
      });
    },
  };
}
