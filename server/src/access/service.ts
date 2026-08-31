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
 * The gateway write happens **before** the grant row is committed. If Edge
 * fails, no grant exists and the request stays pending, which is recoverable by
 * retrying. The reverse order would leave Nexus claiming an access that the
 * gateway would reject.
 */

import {
  MAX_JUSTIFICATION_LENGTH,
  aclGroupForApi,
  roleAtLeast,
  type AccessRequest,
  type AccessRequestStatus,
  type ApiSummary,
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
import { conflict, forbidden, notFound, validationFailed } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { NotificationsService } from '../notifications/service.js';
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
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** Build the access service. */
export function createAccessService(deps: AccessServiceDeps): AccessService {
  const { config, store, audit, notifications, email, provisioner } = deps;
  const namespace = config.edge.namespace;

  function apiSummary(api: ApiRecord): ApiSummary {
    return {
      id: api.id,
      name: api.name,
      slug: api.slug,
      version: api.version,
      owner_user_id: api.owner_user_id,
    };
  }

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
    return rows.map((row) => {
      const api = apis.get(row.api_id);
      const requester = users.get(row.user_id);
      return {
        ...row,
        ...(api ? { api: apiSummary(api) } : {}),
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
    return rows.map((row) => {
      const api = apis.get(row.api_id);
      const user = users.get(row.user_id);
      return {
        ...row,
        ...(api ? { api: apiSummary(api) } : {}),
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
    );
    return group;
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
          '/provider/requests',
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

      const updated = await store.accessRequests.update(request.id, {
        status: 'cancelled',
        decided_by: user.id,
        decided_at: nowIso(),
      });
      if (!updated) throw notFound('Access request', requestId);

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

      // Gateway first: a grant row that the gateway would not honour is worse
      // than a pending request the provider can approve again.
      const group = await setGroupMembership(requester, api.id, true);

      const decidedAt = nowIso();
      const { grant, updated } = await store.transaction(async (tx) => {
        const createdGrant = await tx.grants.create({
          api_id: api.id,
          user_id: requester.id,
          access_request_id: request.id,
          acl_group: group,
          status: 'active',
          granted_by: actor.id,
        });
        const updatedRequest = await tx.accessRequests.update(request.id, {
          status: 'approved',
          decided_by: actor.id,
          decided_at: decidedAt,
          decision_note: note ?? null,
        });
        return { grant: createdGrant, updated: updatedRequest };
      });
      if (!updated) throw notFound('Access request', requestId);

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.ACCESS_APPROVE,
        { type: 'access_request', id: request.id },
        {
          api_id: api.id,
          api_slug: api.slug,
          user_id: requester.id,
          grant_id: grant.id,
          acl_group: group,
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

      const updated = await store.accessRequests.update(request.id, {
        status: 'denied',
        decided_by: actor.id,
        decided_at: nowIso(),
        decision_note: note ?? null,
      });
      if (!updated) throw notFound('Access request', requestId);

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
      if (grantee) await setGroupMembership(grantee, api.id, false);

      const revokedAt = nowIso();
      const updated = await store.transaction(async (tx) => {
        const result = await tx.grants.update(grant.id, {
          status: 'revoked',
          revoked_by: actor.id,
          revoked_at: revokedAt,
        });
        // Keep the originating request's status honest so the requester's
        // history reads "approved, then revoked" rather than staying approved.
        if (grant.access_request_id) {
          const request = await tx.accessRequests.findById(grant.access_request_id);
          if (request && request.status === 'approved') {
            await tx.accessRequests.update(request.id, {
              status: 'revoked',
              decided_by: actor.id,
              decided_at: revokedAt,
              decision_note: reason ?? request.decision_note,
            });
          }
        }
        return result;
      });
      if (!updated) throw notFound('Grant', grantId);

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
          const api = await store.apis.findById(grant.api_id);
          const grantee = await store.users.findById(userId);
          if (api && grantee) await setGroupMembership(grantee, api.id, false);
          await store.grants.update(grant.id, {
            status: 'revoked',
            revoked_by: actor.id,
            revoked_at: nowIso(),
          });
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
