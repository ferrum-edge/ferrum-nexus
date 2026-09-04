/**
 * The access workflow: request → decide → grant → revoke.
 *
 * This is where a portal decision becomes gateway state. The mechanism is one
 * ACL group per API, held on the requester's consumer:
 *
 * ```
 * approve  GET /consumers/{id} → acl_groups += nexus:api:<api_id>:approved → PUT
 * revoke   GET /consumers/{id} → acl_groups -= nexus:api:<api_id>:approved → PUT
 * ```
 *
 * The `access_control` plugin attached to the API's proxy is written **once**,
 * at publish time, and never touched again — approvals contend on one consumer
 * row rather than on a plugin config shared by every approved user
 * (`ref-edge-admin.md` §7.5).
 *
 * ## Ordering matters, and so does serialisation
 *
 * `PUT /consumers/{id}` is a whole-resource replace with no concurrency token.
 * Two approvals for the same user landing at the same instant would each read
 * the pre-change group list and one would overwrite the other, silently losing
 * a grant that the portal believes it made. Every consumer mutation therefore
 * goes through the Edge client's per-consumer promise queue (via
 * {@link ConsumerProvisioner.mutateAclGroups}).
 *
 * Three steps, in this order, and the order is the whole design:
 *
 * 1. **Claim the decision.** Every transition out of `pending` is an atomic
 *    compare-and-set (`accessRequests.updateIfStatus`). Approve, deny and
 *    cancel all read a pending row and write it back later, so a blind update
 *    let a cancellation racing an approval succeed *too* — the history read
 *    `cancelled` while the approval's grant and ACL group stayed live. The
 *    loser of the claim raises `CONFLICT` and, crucially, stops **before**
 *    anything reaches the gateway.
 * 2. **Write the gateway.** A grant row the gateway would not honour is worse
 *    than a decided request an operator can see: the reverse order would leave
 *    Nexus claiming an access the gateway rejects.
 * 3. **Commit the grant row.**
 *
 * Step 2 preceding step 3 means a failure in step 3 would strand the ACL group
 * with no grant to find it by — access the portal cannot see and nobody can
 * revoke. `unwindApproval` closes that window: it takes the group back off
 * (re-checking first that no concurrent approval legitimately won it), hands
 * the request back to `pending`, and audits what it undid.
 *
 * ## Revocation is the same shape, mirrored
 *
 * `revoke` and `revokeAllForUser` read a grant, check it is `active`, and write
 * it back around a round trip to the gateway — so they had the same race, and
 * they get the same claim-first fix (`grants.updateIfStatus`). Two revocations
 * of one grant, or a revocation racing the disable-account sweep, used to both
 * pass the guard: the group came off twice and two `access.revoke` rows claimed
 * the same withdrawal.
 *
 * The order flips, because the danger flips with it. An approval writes the
 * gateway first so Nexus never claims access the gateway would reject; a
 * revocation must never claim the *reverse* — access withdrawn in the portal
 * while the group still opens the door — so it claims the row first and
 * `unwindRevocation` puts it back when the gateway will not follow.
 *
 * `revoke` answers one caller about one grant, so its loser raises `CONFLICT`
 * like any other lost decision. `revokeAllForUser` is a sweep, so its loser
 * skips that grant and carries on: the grant ends up revoked either way, and
 * aborting over somebody else's success would leave the rest of the account's
 * access standing.
 */

import {
  MAX_JUSTIFICATION_LENGTH,
  aclGroupForApi,
  roleAtLeast,
  type AccessRequest,
  type AccessRequestStatus,
  type Grant,
  type GrantStatus,
  type Paginated,
  type UserSummary,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type {
  AccessRequestFilter,
  AccessRequestRecord,
  ApiRecord,
  GrantFilter,
  GrantRecord,
  ListOptions,
  NexusStore,
  UserRecord,
} from '../db/store.js';
import type { EmailService } from '../email/service.js';
import { conflict, forbidden, notFound, validationFailed, type NexusError } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { NotificationsService } from '../notifications/service.js';
import { presentApiSummary, type GatewayUrlSource } from '../publishing/present.js';
import { withGroup, withoutGroup, type ConsumerProvisioner } from '../credentials/consumers.js';

/** Filters accepted by {@link AccessService.listRequests}. */
export interface AccessRequestListFilter {
  mine?: boolean;
  api_id?: Uuid;
  status?: AccessRequestStatus;
}

/** Filters accepted by {@link AccessService.listGrants}. */
export interface GrantListFilter {
  mine?: boolean;
  api_id?: Uuid;
  user_id?: Uuid;
  status?: GrantStatus;
}

/** Access-workflow operations. */
export interface AccessService {
  /** Client asks for access to a requestable API. */
  request(
    user: UserRecord,
    apiId: Uuid,
    justification: string,
    ip?: string | null,
  ): Promise<AccessRequest>;
  /** Requester withdraws their own pending request. */
  cancel(user: UserRecord, requestId: Uuid, ip?: string | null): Promise<AccessRequest>;
  /** Provider (or admin) approves: the ACL group lands on the consumer. */
  approve(
    actor: UserRecord,
    requestId: Uuid,
    note?: string | null,
    ip?: string | null,
  ): Promise<{ access_request: AccessRequest; grant: Grant }>;
  /** Provider (or admin) declines. Nothing changes on the gateway. */
  deny(
    actor: UserRecord,
    requestId: Uuid,
    note?: string | null,
    ip?: string | null,
  ): Promise<AccessRequest>;
  /** Withdraw a live grant: the ACL group is removed from the consumer. */
  revoke(
    actor: UserRecord,
    grantId: Uuid,
    reason?: string | null,
    ip?: string | null,
  ): Promise<Grant>;
  /** Requests the caller may see: their own, their APIs', or all for an admin. */
  listRequests(
    actor: UserRecord,
    filter?: AccessRequestListFilter,
    options?: ListOptions,
  ): Promise<Paginated<AccessRequest>>;
  /** Grants the caller may see, under the same scoping rules. */
  listGrants(
    actor: UserRecord,
    filter?: GrantListFilter,
    options?: ListOptions,
  ): Promise<Paginated<Grant>>;
  /** Revoke every active grant held by one user. Used by god-mode disable. */
  revokeAllForUser(
    actor: UserRecord,
    userId: Uuid,
    reason: string,
    ip?: string | null,
  ): Promise<number>;
}

/** Dependencies of {@link createAccessService}. */
export interface AccessServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  audit: AuditService;
  notifications: NotificationsService;
  email: EmailService;
  provisioner: ConsumerProvisioner;
  /** Resolves the gateway origin the embedded API summaries' `invoke_url` uses. */
  settings: GatewayUrlSource;
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** Build the access service. */
export function createAccessService(deps: AccessServiceDeps): AccessService {
  const { config, store, audit, notifications, email, provisioner, settings } = deps;
  const namespace = config.edge.namespace;

  function userSummary(user: UserRecord): UserSummary {
    return { id: user.id, email: user.email, display_name: user.display_name, role: user.role };
  }

  function catalogUrl(slug: string): string {
    return `${config.publicUrl}/catalog/${slug}`;
  }

  /** Reviewer check: the API's owner, or any admin. */
  function assertCanReview(actor: UserRecord, api: ApiRecord): void {
    if (api.owner_user_id === actor.id) return;
    if (roleAtLeast(actor.role, 'admin')) return;
    throw forbidden('Only the API owner or an administrator can decide this request');
  }

  async function loadRequest(requestId: Uuid): Promise<{
    request: AccessRequestRecord;
    api: ApiRecord;
    requester: UserRecord;
  }> {
    const request = await store.accessRequests.findById(requestId);
    if (!request) throw notFound('Access request', requestId);
    const api = await store.apis.findById(request.api_id);
    if (!api) throw notFound('API', request.api_id);
    const requester = await store.users.findById(request.user_id);
    if (!requester) throw notFound('Requester', request.user_id);
    return { request, api, requester };
  }

  /** Attach the API and user joins list/detail payloads carry. */
  async function decorateRequests(rows: AccessRequestRecord[]): Promise<AccessRequest[]> {
    if (rows.length === 0) return [];
    const apis = new Map(
      (await store.apis.findManyByIds([...new Set(rows.map((row) => row.api_id))])).map((api) => [
        api.id,
        api,
      ]),
    );
    const users = new Map(
      (await store.users.findManyByIds([...new Set(rows.map((row) => row.user_id))])).map(
        (user) => [user.id, user],
      ),
    );
    const gatewayUrl = await settings.getGatewayPublicUrl();
    return rows.map((row) => {
      const api = apis.get(row.api_id);
      const requester = users.get(row.user_id);
      return {
        ...row,
        ...(api ? { api: presentApiSummary(api, gatewayUrl) } : {}),
        ...(requester ? { requester: userSummary(requester) } : {}),
      };
    });
  }

  async function decorateGrants(rows: GrantRecord[]): Promise<Grant[]> {
    if (rows.length === 0) return [];
    const apis = new Map(
      (await store.apis.findManyByIds([...new Set(rows.map((row) => row.api_id))])).map((api) => [
        api.id,
        api,
      ]),
    );
    const users = new Map(
      (await store.users.findManyByIds([...new Set(rows.map((row) => row.user_id))])).map(
        (user) => [user.id, user],
      ),
    );
    const gatewayUrl = await settings.getGatewayPublicUrl();
    return rows.map((row) => {
      const api = apis.get(row.api_id);
      const user = users.get(row.user_id);
      return {
        ...row,
        ...(api ? { api: presentApiSummary(api, gatewayUrl) } : {}),
        ...(user ? { user: userSummary(user) } : {}),
      };
    });
  }

  /**
   * Put the ACL group on (or take it off) the user's consumer.
   *
   * Serialised per consumer by the provisioner, so concurrent decisions for the
   * same user compose instead of overwriting each other.
   */
  async function setGroupMembership(
    user: UserRecord,
    apiId: Uuid,
    present: boolean,
  ): Promise<string> {
    const group = aclGroupForApi(apiId);
    const consumer = present
      ? await provisioner.ensureConsumer(user)
      : await store.consumers.findByUserAndNamespace(user.id, namespace);
    if (!consumer) {
      // Nothing to remove: the user never had a consumer, so they never had the
      // group either. Revocation is idempotent by design.
      return group;
    }
    await provisioner.mutateAclGroups(
      consumer.ferrum_consumer_id,
      (groups) => (present ? withGroup(groups, group) : withoutGroup(groups, group)),
      user.id,
      // Only the *grant* re-checks the account: an approval that passed its
      // authorisation before the grantee was disabled would otherwise hand a
      // stripped consumer its group back. Removing one is always safe.
      present ? { requireActiveUser: user.id } : {},
    );
    return group;
  }

  /**
   * The error a lost status transition raises.
   *
   * Re-reads the row so the message names the decision that actually won,
   * rather than the status this caller happened to read a moment ago.
   */
  async function decisionConflict(requestId: Uuid): Promise<NexusError> {
    const current = await store.accessRequests.findById(requestId);
    if (!current) return notFound('Access request', requestId);
    return conflict(`This request is already ${current.status}`);
  }

  /**
   * The error a lost grant transition raises.
   *
   * A grant that vanished under the caller — `publishing.remove` deletes the
   * rows of an API it takes off the gateway — is a 404, not a conflict.
   */
  async function revocationConflict(grantId: Uuid): Promise<NexusError> {
    const current = await store.grants.findById(grantId);
    if (!current) return notFound('Grant', grantId);
    return conflict(`This grant is already ${current.status}`);
  }

  /**
   * Undo a revocation the gateway would not accept.
   *
   * The mirror of {@link unwindApproval}, and it exists for the mirror reason.
   * A revocation claims the grant row **before** it touches the gateway, so
   * that only one of several concurrent revocations gets that far; if the
   * group removal then fails, the portal would be reporting access as
   * withdrawn while the group still opens the door — the one direction of
   * inconsistency that is a security problem rather than a reporting one.
   *
   * Both halves go back under compare-and-set, so a revocation that lost a
   * later race — somebody re-approved the API in the meantime, and a new
   * active grant now owns the partial unique index — is recorded as unrestored
   * rather than forced. Every step is best-effort: the caller re-throws the
   * original gateway failure and an operator needs the trail either way.
   */
  async function unwindRevocation(input: {
    actor: UserRecord;
    grant: GrantRecord;
    /** The originating request this revocation moved, or `null` if it moved none. */
    request: AccessRequestRecord | null;
    cause: unknown;
    ip: string | null;
  }): Promise<void> {
    const { actor, grant, request, cause, ip } = input;
    const details: Record<string, unknown> = {
      api_id: grant.api_id,
      user_id: grant.user_id,
      acl_group: grant.acl_group,
      cause: cause instanceof Error ? cause.message : String(cause),
    };

    try {
      const restored = await store.transaction(async (tx) => {
        const back = await tx.grants.updateIfStatus(grant.id, 'revoked', {
          status: 'active',
          revoked_by: null,
          revoked_at: null,
        });
        if (back && request) {
          await tx.accessRequests.updateIfStatus(request.id, 'revoked', {
            status: request.status,
            decided_by: request.decided_by,
            decided_at: request.decided_at,
            decision_note: request.decision_note,
          });
        }
        return back;
      });
      details.grant_restored = restored !== null;
    } catch (error) {
      details.grant_restored = false;
      deps.log?.(
        {
          grant_id: grant.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not return a failed revocation to active',
      );
    }

    await audit
      .record(
        { id: actor.id, role: actor.role },
        AuditAction.ACCESS_REVOKE_ROLLBACK,
        { type: 'grant', id: grant.id },
        details,
        ip,
      )
      .catch(() => undefined);

    deps.log?.(details, 'Rolled back a revocation the gateway would not accept');
  }

  /**
   * Undo a half-finished approval.
   *
   * Reached when the gateway write succeeded (or may have) but the grant row
   * did not land. Without this the consumer keeps `nexus:api:<api_id>:approved`
   * while Nexus holds no grant for anyone to find or revoke — working access
   * with no portal record of it.
   *
   * It starts by **re-reading whether an active grant for this API/user pair
   * exists**. If one does, a concurrent approval legitimately owns the group
   * and nothing is undone — stripping it would revoke *their* access. Only when
   * nothing needs it do both halves go back:
   *
   * - the ACL group comes off through the same per-consumer queue every other
   *   mutation uses; and
   * - the request returns to `pending`, again with a compare-and-set, so the
   *   provider can simply approve again. If somebody has already reused the
   *   slot, the release loses and is recorded as such rather than forced.
   *
   * Every step is best-effort: the caller re-throws the original failure, and
   * an operator needs the trail whichever way the compensation went.
   */
  async function unwindApproval(input: {
    actor: UserRecord;
    api: ApiRecord;
    requester: UserRecord;
    requestId: Uuid;
    /** The group put on the consumer, or `null` when the gateway write itself failed. */
    groupAdded: string | null;
    cause: unknown;
    ip: string | null;
  }): Promise<void> {
    const { actor, api, requester, requestId, groupAdded, cause, ip } = input;
    const details: Record<string, unknown> = {
      api_id: api.id,
      api_slug: api.slug,
      user_id: requester.id,
      cause: cause instanceof Error ? cause.message : String(cause),
    };

    const live = await store.grants.findActiveByApiAndUser(api.id, requester.id).catch(() => null);
    if (live) {
      // Somebody's approval owns this group after all. Undoing anything here
      // would revoke *their* access, so leave both the group and the decision
      // exactly as they are and let the audit row say so.
      details.acl_group_kept = groupAdded;
      details.kept_for_grant_id = live.id;
    } else {
      if (groupAdded !== null) {
        try {
          await setGroupMembership(requester, api.id, false);
          details.acl_group_removed = groupAdded;
        } catch (error) {
          details.acl_group_orphaned = groupAdded;
          deps.log?.(
            {
              api_id: api.id,
              user_id: requester.id,
              acl_group: groupAdded,
              error: error instanceof Error ? error.message : String(error),
            },
            'Could not take back the ACL group of a failed approval — the consumer still has it',
          );
        }
      }

      try {
        const released = await store.accessRequests.updateIfStatus(requestId, 'approved', {
          status: 'pending',
          decided_by: null,
          decided_at: null,
          decision_note: null,
        });
        details.request_released = released !== null;
      } catch (error) {
        details.request_released = false;
        deps.log?.(
          {
            request_id: requestId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Could not return a failed approval to pending',
        );
      }
    }

    await audit
      .record(
        { id: actor.id, role: actor.role },
        AuditAction.ACCESS_APPROVE_ROLLBACK,
        { type: 'access_request', id: requestId },
        details,
        ip,
      )
      .catch(() => undefined);

    deps.log?.(details, 'Rolled back an approval that could not be committed');
  }

  /** Best-effort notify + email; never allowed to undo a committed decision. */
  async function announce(
    recipient: UserRecord,
    notification: {
      type: Parameters<NotificationsService['notify']>[1];
      title: string;
      body: string;
      link: string;
    },
    mail: {
      templateKey: 'access_approved' | 'access_denied' | 'access_revoked';
      vars: Record<string, string>;
    },
  ): Promise<void> {
    try {
      await notifications.notify(
        recipient.id,
        notification.type,
        notification.title,
        notification.body,
        notification.link,
      );
      await email.enqueue({
        to: recipient.email,
        templateKey: mail.templateKey,
        vars: {
          recipient_name: recipient.display_name,
          recipient_email: recipient.email,
          ...mail.vars,
        },
      });
    } catch (error) {
      deps.log?.(
        {
          user_id: recipient.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not announce an access decision',
      );
    }
  }

  return {
    async request(user, apiId, justification, ip = null): Promise<AccessRequest> {
      const trimmed = justification.trim();
      if (trimmed === '') throw validationFailed('A justification is required');
      if (trimmed.length > MAX_JUSTIFICATION_LENGTH) {
        throw validationFailed(
          `A justification may be at most ${MAX_JUSTIFICATION_LENGTH} characters`,
        );
      }

      const api = await store.apis.findById(apiId);
      if (!api) throw notFound('API', apiId);
      if (api.owner_user_id === user.id) {
        throw conflict('You already own this API');
      }
      if (api.status !== 'published') {
        throw conflict('This API is retired and is no longer accepting access requests');
      }
      if (!api.requestable) {
        throw conflict('This API does not accept access requests');
      }
      // Visibility is deliberately *not* checked here. `internal` means
      // unlisted, not private (see `catalog/service.ts`): a provider hands out
      // the link and the recipient requests access through the normal flow.
      // Gating requests on visibility would make `internal` + `requestable` a
      // combination nobody could ever act on, since there is no
      // provider-initiated grant path.

      if (await store.grants.findActiveByApiAndUser(api.id, user.id)) {
        throw conflict('You already have access to this API');
      }
      if (await store.accessRequests.findPendingByApiAndUser(api.id, user.id)) {
        throw conflict('You already have a pending request for this API');
      }

      const created = await store.accessRequests.create({
        api_id: api.id,
        user_id: user.id,
        justification: trimmed,
        status: 'pending',
      });

      await audit.record(
        { id: user.id, role: user.role },
        AuditAction.ACCESS_REQUEST,
        { type: 'access_request', id: created.id },
        { api_id: api.id, api_slug: api.slug },
        ip,
      );

      await notifications
        .notify(
          api.owner_user_id,
          'access_request_created',
          `Access requested: ${api.name}`,
          `${user.display_name} requested access to ${api.name}.`,
          // The provider's review inbox is a tab on the API's own page; there
          // is no `/provider/*` route in the SPA and the old link 404'd.
          `/apis/${api.id}`,
        )
        .catch(() => undefined);

      const [decorated] = await decorateRequests([created]);
      return decorated ?? created;
    },

    async cancel(user, requestId, ip = null): Promise<AccessRequest> {
      const { request } = await loadRequest(requestId);
      if (request.user_id !== user.id) {
        throw forbidden('Only the requester can cancel this request');
      }
      if (request.status !== 'pending') {
        throw conflict(`This request is already ${request.status}`);
      }

      // Compare-and-set: an approval may have decided this request between the
      // read above and here, and it will already have provisioned the gateway.
      // The loser records nothing.
      const updated = await store.accessRequests.updateIfStatus(request.id, 'pending', {
        status: 'cancelled',
        decided_by: user.id,
        decided_at: nowIso(),
      });
      if (!updated) throw await decisionConflict(request.id);

      await audit.record(
        { id: user.id, role: user.role },
        AuditAction.ACCESS_CANCEL,
        { type: 'access_request', id: request.id },
        { api_id: request.api_id },
        ip,
      );

      const [decorated] = await decorateRequests([updated]);
      return decorated ?? updated;
    },

    async approve(actor, requestId, note = null, ip = null) {
      const { request, api, requester } = await loadRequest(requestId);
      assertCanReview(actor, api);
      if (request.status !== 'pending') {
        throw conflict(`This request is already ${request.status}`);
      }
      if (await store.grants.findActiveByApiAndUser(api.id, requester.id)) {
        throw conflict('This user already has an active grant for this API');
      }

      // Step 1 — claim the decision before anything reaches the gateway. A
      // cancellation or a denial racing this approval either loses here, or
      // wins and leaves this call with a CONFLICT and no gateway side effect
      // to explain away.
      const decidedAt = nowIso();
      const updated = await store.accessRequests.updateIfStatus(request.id, 'pending', {
        status: 'approved',
        decided_by: actor.id,
        decided_at: decidedAt,
        decision_note: note ?? null,
      });
      if (!updated) throw await decisionConflict(request.id);

      // Steps 2 and 3 — see the module docblock for why the gateway goes
      // first, and `unwindApproval` for what happens when the grant does not
      // follow it.
      let addedGroup: string | null = null;
      let grant: GrantRecord;
      try {
        addedGroup = await setGroupMembership(requester, api.id, true);
        const group = addedGroup;
        grant = await store.transaction(async (tx) =>
          tx.grants.create({
            api_id: api.id,
            user_id: requester.id,
            access_request_id: request.id,
            acl_group: group,
            status: 'active',
            granted_by: actor.id,
          }),
        );
      } catch (error) {
        await unwindApproval({
          actor,
          api,
          requester,
          requestId: request.id,
          groupAdded: addedGroup,
          cause: error,
          ip,
        });
        throw error;
      }

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.ACCESS_APPROVE,
        { type: 'access_request', id: request.id },
        {
          api_id: api.id,
          api_slug: api.slug,
          user_id: requester.id,
          grant_id: grant.id,
          acl_group: grant.acl_group,
        },
        ip,
      );

      await announce(
        requester,
        {
          type: 'access_request_approved',
          title: `Access approved: ${api.name}`,
          body: `${actor.display_name} approved your request for ${api.name}.`,
          link: `/catalog/${api.slug}`,
        },
        {
          templateKey: 'access_approved',
          vars: {
            api_name: api.name,
            api_slug: api.slug,
            api_url: catalogUrl(api.slug),
            decided_by_name: actor.display_name,
            decision_note: note ?? '',
          },
        },
      );

      const [decoratedRequest] = await decorateRequests([updated]);
      const [decoratedGrant] = await decorateGrants([grant]);
      return {
        access_request: decoratedRequest ?? updated,
        grant: decoratedGrant ?? grant,
      };
    },

    async deny(actor, requestId, note = null, ip = null): Promise<AccessRequest> {
      const { request, api, requester } = await loadRequest(requestId);
      assertCanReview(actor, api);
      if (request.status !== 'pending') {
        throw conflict(`This request is already ${request.status}`);
      }

      // Compare-and-set, for the same reason `cancel` uses one: the requester
      // may have withdrawn the request since it was read.
      const updated = await store.accessRequests.updateIfStatus(request.id, 'pending', {
        status: 'denied',
        decided_by: actor.id,
        decided_at: nowIso(),
        decision_note: note ?? null,
      });
      if (!updated) throw await decisionConflict(request.id);

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.ACCESS_DENY,
        { type: 'access_request', id: request.id },
        { api_id: api.id, api_slug: api.slug, user_id: requester.id, has_note: note !== null },
        ip,
      );

      await announce(
        requester,
        {
          type: 'access_request_denied',
          title: `Access declined: ${api.name}`,
          body: `${actor.display_name} declined your request for ${api.name}.`,
          link: `/catalog/${api.slug}`,
        },
        {
          templateKey: 'access_denied',
          vars: {
            api_name: api.name,
            api_slug: api.slug,
            decided_by_name: actor.display_name,
            decision_note: note ?? '',
          },
        },
      );

      const [decorated] = await decorateRequests([updated]);
      return decorated ?? updated;
    },

    async revoke(actor, grantId, reason = null, ip = null): Promise<Grant> {
      const grant = await store.grants.findById(grantId);
      if (!grant) throw notFound('Grant', grantId);
      const api = await store.apis.findById(grant.api_id);
      if (!api) throw notFound('API', grant.api_id);
      assertCanReview(actor, api);
      if (grant.status !== 'active') throw conflict('This grant is already revoked');

      const grantee = await store.users.findById(grant.user_id);

      // Step 1 — claim the transition before anything reaches the gateway, for
      // the same reason an approval claims its decision first. The read above
      // is stale the instant it returns: a second click, god mode racing the
      // API owner, or the disable-account sweep can all be revoking this same
      // grant, and a blind write by id let every one of them past the
      // `status !== 'active'` guard. They each stripped the ACL group and each
      // wrote an `access.revoke` row, so the trail claimed one access had been
      // withdrawn several times over. The loser stops here with a CONFLICT.
      const revokedAt = nowIso();
      let movedRequest: AccessRequestRecord | null = null;
      const updated = await store.transaction(async (tx) => {
        const result = await tx.grants.updateIfStatus(grant.id, 'active', {
          status: 'revoked',
          revoked_by: actor.id,
          revoked_at: revokedAt,
        });
        if (!result) return null;
        // Keep the originating request's status honest so the requester's
        // history reads "approved, then revoked" rather than staying approved.
        if (grant.access_request_id) {
          const request = await tx.accessRequests.findById(grant.access_request_id);
          if (request && request.status === 'approved') {
            const moved = await tx.accessRequests.updateIfStatus(request.id, 'approved', {
              status: 'revoked',
              decided_by: actor.id,
              decided_at: revokedAt,
              decision_note: reason ?? request.decision_note,
            });
            if (moved) movedRequest = request;
          }
        }
        return result;
      });
      if (!updated) throw await revocationConflict(grant.id);

      // Step 2 — the gateway, now that exactly one caller is entitled to touch
      // it. `unwindRevocation` puts the rows back if the group will not come
      // off: a revocation the gateway did not accept must not stand as one.
      try {
        if (grantee) await setGroupMembership(grantee, api.id, false);
      } catch (error) {
        await unwindRevocation({ actor, grant, request: movedRequest, cause: error, ip });
        throw error;
      }

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.ACCESS_REVOKE,
        { type: 'grant', id: grant.id },
        {
          api_id: api.id,
          api_slug: api.slug,
          user_id: grant.user_id,
          acl_group: grant.acl_group,
          reason: reason ?? null,
        },
        ip,
      );

      if (grantee) {
        await announce(
          grantee,
          {
            type: 'access_revoked',
            title: `Access revoked: ${api.name}`,
            body: `${actor.display_name} revoked your access to ${api.name}.`,
            link: `/catalog/${api.slug}`,
          },
          {
            templateKey: 'access_revoked',
            vars: {
              api_name: api.name,
              api_slug: api.slug,
              revoked_by_name: actor.display_name,
              reason: reason ?? '',
            },
          },
        );
      }

      const [decorated] = await decorateGrants([updated]);
      return decorated ?? updated;
    },

    async revokeAllForUser(actor, userId, reason, ip = null): Promise<number> {
      const grants = await store.grants.listActiveByUser(userId);
      let revoked = 0;
      for (const grant of grants) {
        // Bypasses the ownership check on purpose: this is only reachable from
        // god mode, which has already proven super_admin.
        try {
          // Claim each grant before touching the gateway, exactly as `revoke`
          // does — `listActiveByUser` above is a snapshot, and a targeted
          // revocation or a second disable may have taken any row in it since.
          //
          // A loser here *skips* rather than raising: unlike `revoke`, which
          // answers one caller about one grant, this is a sweep, and the grant
          // it lost is revoked either way. Aborting the loop over somebody
          // else's success would leave the rest of the account's access up.
          // It is not counted, because this call did not revoke it.
          const claimed = await store.grants.updateIfStatus(grant.id, 'active', {
            status: 'revoked',
            revoked_by: actor.id,
            revoked_at: nowIso(),
          });
          if (!claimed) continue;

          const api = await store.apis.findById(grant.api_id);
          const grantee = await store.users.findById(userId);
          if (api && grantee) {
            try {
              await setGroupMembership(grantee, api.id, false);
            } catch (error) {
              await unwindRevocation({ actor, grant, request: null, cause: error, ip });
              throw error;
            }
          }
          await audit.record(
            { id: actor.id, role: actor.role },
            AuditAction.ACCESS_REVOKE,
            { type: 'grant', id: grant.id },
            { api_id: grant.api_id, user_id: userId, reason, bulk: true },
            ip,
          );
          revoked += 1;
        } catch (error) {
          deps.log?.(
            {
              grant_id: grant.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'Could not revoke a grant during a bulk revocation',
          );
        }
      }
      return revoked;
    },

    async listRequests(actor, filter = {}, options): Promise<Paginated<AccessRequest>> {
      const base: AccessRequestFilter = {
        ...(filter.api_id !== undefined ? { api_id: filter.api_id } : {}),
        ...(filter.status !== undefined ? { status: filter.status } : {}),
      };

      if (filter.mine || !roleAtLeast(actor.role, 'provider')) {
        const page = await store.accessRequests.list({ ...base, user_id: actor.id }, options);
        return { items: await decorateRequests(page.items), total: page.total };
      }
      if (roleAtLeast(actor.role, 'admin')) {
        const page = await store.accessRequests.list(base, options);
        return { items: await decorateRequests(page.items), total: page.total };
      }

      // A provider's inbox is scoped to the APIs they own.
      const owned = await store.apis.listIdsByOwner(actor.id);
      if (owned.length === 0) return { items: [], total: 0 };
      if (base.api_id !== undefined && !owned.includes(base.api_id)) {
        throw forbidden('You do not own that API');
      }
      const page = await store.accessRequests.list(
        { ...base, ...(base.api_id === undefined ? { api_ids: owned } : {}) },
        options,
      );
      return { items: await decorateRequests(page.items), total: page.total };
    },

    async listGrants(actor, filter = {}, options): Promise<Paginated<Grant>> {
      const base: GrantFilter = {
        ...(filter.api_id !== undefined ? { api_id: filter.api_id } : {}),
        ...(filter.status !== undefined ? { status: filter.status } : {}),
      };

      if (filter.mine || !roleAtLeast(actor.role, 'provider')) {
        const page = await store.grants.list({ ...base, user_id: actor.id }, options);
        return { items: await decorateGrants(page.items), total: page.total };
      }
      if (roleAtLeast(actor.role, 'admin')) {
        const page = await store.grants.list(
          { ...base, ...(filter.user_id !== undefined ? { user_id: filter.user_id } : {}) },
          options,
        );
        return { items: await decorateGrants(page.items), total: page.total };
      }

      const owned = await store.apis.listIdsByOwner(actor.id);
      if (owned.length === 0) return { items: [], total: 0 };
      if (base.api_id !== undefined && !owned.includes(base.api_id)) {
        throw forbidden('You do not own that API');
      }
      const page = await store.grants.list(
        {
          ...base,
          ...(base.api_id === undefined ? { api_ids: owned } : {}),
          ...(filter.user_id !== undefined ? { user_id: filter.user_id } : {}),
        },
        options,
      );
      return { items: await decorateGrants(page.items), total: page.total };
    },
  };
}
