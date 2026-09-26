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
 * row rather than on a plugin config shared by every approved user, and a
 * consumer an `access_control` config names cannot be deleted (Edge
 * `docs/admin_api.md`, "Consumers").
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
 *
 * `revoke` also holds the API's `proxy:<id>` lease — the one `approve` holds —
 * from its claim through the ACL removal and its notice, so a re-request
 * approved while a revocation is in flight can never have its fresh group
 * stripped by the older revocation's delayed removal, nor have "approved"
 * delivered before "revoked" (issue #341). `approve` writes its grant row
 * inside the consumer key, straight after the group lands, so an application
 * delete or a re-enable holding that key sees the pair whole or not at all.
 *
 * The sweep differs in one more way. It runs only after an account disable
 * has committed, on access a super admin asked to remove, so a gateway failure
 * is **not** unwound back to `active` — that would let a later re-enable
 * replay the group. The grant stays `revoked`, the failure is returned to the
 * caller grant by grant, and the account teardown that follows strips every
 * group the account's identities hold. A re-enable that cancels that teardown
 * before it has run rebuilds the approval groups from active grants alone, so
 * the group cannot outlive both.
 */

import {
  MAX_JUSTIFICATION_LENGTH,
  aclGroupForApi,
  consumerUsernameForApplication,
  roleAtLeast,
  type AccessRequest,
  type ApplicationSummary,
  type AccessRequestStatus,
  type Grant,
  type GrantStatus,
  type Paginated,
  type UserSummary,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, auditRowCommitted, type AuditService } from '../audit/service.js';
import { canViewApi, resolveReadAccess } from '../catalog/read-access.js';
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
import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import {
  NexusError,
  conflict,
  forbidden,
  isNexusError,
  notFound,
  validationFailed,
} from '../lib/errors.js';
import { accessRequestBudgetLockKey, type KeyedSerializer } from '../lib/keyed-serializer.js';
import { newId, nowIso } from '../lib/ids.js';
import type { NotificationsService } from '../notifications/service.js';
import { presentApiSummary, type GatewayUrlSource } from '../publishing/present.js';
import {
  canonicalConsumerLockKey,
  withGroup,
  withoutGroup,
  type ConsumerProvisioner,
  type MutateAclGroupsOptions,
} from '../credentials/consumers.js';

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
  /**
   * Client asks for access to a requestable API.
   *
   * `applicationId` is the identity the access is for: `null` (the default) is
   * the account itself, an id is one of the account's applications. The caller
   * must already have resolved it — the route does, through
   * `ApplicationsService.resolveForActor`, which is what checks ownership and
   * that the application is active. That answer is only a snapshot, so an
   * application-scoped request re-reads the application under its
   * provisioning name key — the key `ApplicationsService.remove` holds for the
   * whole deletion — and keeps the key until the request has committed
   * (issue #365).
   */
  request(
    user: UserRecord,
    apiId: Uuid,
    justification: string,
    applicationId?: Uuid | null,
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
  /**
   * Withdraw a live grant: the ACL group is removed from the consumer.
   *
   * `recordWithRevoke` writes further audit rows — god mode's own — in the
   * transaction that claims the grant and records `access.revoke`, so they
   * commit or roll back with the revocation.
   */
  revoke(
    actor: UserRecord,
    grantId: Uuid,
    reason?: string | null,
    ip?: string | null,
    recordWithRevoke?: (tx: NexusStore, grant: GrantRecord) => Promise<void>,
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
  /**
   * Revoke every active grant held by one user. Used by god-mode disable,
   * **after** the account's disable has committed.
   *
   * Never swallows a failure: every grant that could not be fully revoked is
   * named in `failed`, with the stage it stopped at, and is not counted in
   * `revoked`. A `lookup` or `gateway` failure leaves the grant `revoked` in
   * the portal — it is not put back to `active`, so a later re-enable cannot
   * replay the access a super admin asked to remove — and relies on the
   * account's gateway teardown, which strips every group, to take the group
   * off; failing that, on a re-enable, which rebuilds the approval groups from
   * active grants only. A consumer already gone from the gateway counts as
   * removed.
   */
  revokeAllForUser(
    actor: UserRecord,
    userId: Uuid,
    reason: string,
    ip?: string | null,
  ): Promise<BulkRevocationResult>;
}

/** One grant {@link AccessService.revokeAllForUser} could not fully revoke. */
export interface BulkRevocationFailure {
  grant_id: Uuid;
  api_id: Uuid;
  application_id: Uuid | null;
  /**
   * Where it stopped. `claim`: nothing changed and the grant is still active.
   * `lookup`: the grant is `revoked` in the portal, but reading which consumer
   * to take its group off failed in the store, so the group may still be on
   * it. `gateway`: the grant is `revoked` in the portal but the gateway
   * refused the ACL removal, so its group may still be on the consumer. The
   * `access.revoke` row commits with the claim, so a grant whose row could
   * not be written was never claimed and stops at `claim`.
   */
  stage: 'claim' | 'lookup' | 'gateway';
  error: string;
}

/** What {@link AccessService.revokeAllForUser} did. */
export interface BulkRevocationResult {
  /** Grants this call claimed, took off the gateway and recorded. */
  revoked: number;
  failed: BulkRevocationFailure[];
}

/** Rolling window for the per-account access-request budget. */
export const ACCESS_REQUEST_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Human label for {@link ACCESS_REQUEST_BUDGET_WINDOW_MS}, echoed in error details. */
export const ACCESS_REQUEST_BUDGET_WINDOW_LABEL = '24h';

/** Dependencies of {@link createAccessService}. */
export interface AccessServiceDeps {
  edge: FerrumAdminClient;
  config: NexusConfig;
  store: NexusStore;
  audit: AuditService;
  notifications: NotificationsService;
  email: EmailService;
  provisioner: ConsumerProvisioner;
  /** Resolves the gateway origin the embedded API summaries' `invoke_url` uses. */
  settings: GatewayUrlSource;
  /** Serialises the rolling daily access-request budget per requester. */
  locks: KeyedSerializer;
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** Build the access service. */
export function createAccessService(deps: AccessServiceDeps): AccessService {
  const { config, store, edge, audit, notifications, email, provisioner, settings, locks } = deps;
  const namespace = config.edge.namespace;

  function userSummary(user: UserRecord): UserSummary {
    return { id: user.id, email: user.email, display_name: user.display_name, role: user.role };
  }

  function catalogUrl(slug: string): string {
    return `${config.publicUrl}/catalog/${slug}`;
  }

  /** Reviewer check: the API's owner with the provider role, or any admin. */
  function assertCanReview(actor: UserRecord, api: ApiRecord): void {
    if (api.owner_user_id === actor.id && roleAtLeast(actor.role, 'provider')) return;
    if (roleAtLeast(actor.role, 'admin')) return;
    throw forbidden('Only an API owner with the provider role or an admin can decide this request');
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
  /**
   * The applications named by a page of rows, keyed by id.
   *
   * Attached to every request and grant that has one so a provider reviewing
   * an inbox can see **which integration** is asking, not just which account —
   * which is most of the point of application identities (issue #289). Rows
   * with no `application_id` are account-scoped and get no summary, which is
   * how the UI tells the two apart.
   */
  async function applicationsFor(
    rows: readonly { application_id: Uuid | null }[],
  ): Promise<Map<Uuid, ApplicationSummary>> {
    const ids = [...new Set(rows.map((row) => row.application_id).filter((id) => id !== null))];
    if (ids.length === 0) return new Map();
    const found = await store.applications.findManyByIds(ids);
    return new Map(
      found.map((application) => [
        application.id,
        {
          id: application.id,
          name: application.name,
          owner_user_id: application.owner_user_id,
          status: application.status,
        },
      ]),
    );
  }

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
    const [gatewayUrl, applications] = await Promise.all([
      settings.getGatewayPublicUrl(),
      applicationsFor(rows),
    ]);
    return rows.map((row) => {
      const api = apis.get(row.api_id);
      const requester = users.get(row.user_id);
      const application = row.application_id ? applications.get(row.application_id) : undefined;
      return {
        ...row,
        ...(api ? { api: presentApiSummary(api, gatewayUrl) } : {}),
        ...(requester ? { requester: userSummary(requester) } : {}),
        ...(application ? { application } : {}),
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
    const [gatewayUrl, applications] = await Promise.all([
      settings.getGatewayPublicUrl(),
      applicationsFor(rows),
    ]);
    return rows.map((row) => {
      const api = apis.get(row.api_id);
      const user = users.get(row.user_id);
      const application = row.application_id ? applications.get(row.application_id) : undefined;
      return {
        ...row,
        ...(api ? { api: presentApiSummary(api, gatewayUrl) } : {}),
        ...(user ? { user: userSummary(user) } : {}),
        ...(application ? { application } : {}),
      };
    });
  }

  /**
   * Put the ACL group on (or take it off) one identity's consumer.
   *
   * Serialised per consumer by the provisioner, so concurrent decisions for the
   * same user compose instead of overwriting each other.
   *
   * `options.afterWrite` runs inside the consumer key once the write landed —
   * how an approval commits its grant before anything else can act on the
   * consumer. `options.absentIsDone` lets a removal treat a consumer that is
   * already gone as done.
   */
  async function setGroupMembership(
    user: UserRecord,
    apiId: Uuid,
    present: boolean,
    applicationId: Uuid | null,
    options: Pick<MutateAclGroupsOptions, 'afterWrite' | 'absentIsDone'> = {},
  ): Promise<string> {
    const group = aclGroupForApi(apiId);
    // The identity, not the account. An application's grant belongs on its own
    // `nexus-app-<id>` consumer — putting it on the account's would hand every
    // one of that account's credentials the access, which is the whole thing
    // applications exist to prevent (issue #289).
    const consumer = present
      ? await provisioner.ensureConsumer(user, applicationId)
      : await store.consumers.findByUserAndNamespace(user.id, namespace, applicationId);
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
      present ? { ...options, requireActiveUser: user.id } : options,
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
   * Move a just-claimed grant's originating request from `approved` to
   * `revoked`, inside the caller's transaction, so the requester's history
   * reads "approved, then revoked" whichever path withdrew the grant.
   *
   * Compare-and-set like every other request transition. Returns the request
   * as it was **before** the move — what {@link unwindRevocation} restores —
   * or `null` when there was none, or it had already moved on.
   */
  async function moveRequestToRevoked(
    tx: NexusStore,
    grant: GrantRecord,
    actorId: Uuid,
    at: string,
    note: string | null,
  ): Promise<AccessRequestRecord | null> {
    if (!grant.access_request_id) return null;
    const request = await tx.accessRequests.findById(grant.access_request_id);
    if (!request || request.status !== 'approved') return null;
    const moved = await tx.accessRequests.updateIfStatus(request.id, 'approved', {
      status: 'revoked',
      decided_by: actorId,
      decided_at: at,
      decision_note: note ?? request.decision_note,
    });
    return moved ? request : null;
  }

  /**
   * Put a claimed grant — and the request the claim moved with it — back the
   * way it was before the revocation, each under compare-and-set. Returns
   * whether the grant went back. Re-runnable: a re-run finds nothing left in
   * `revoked` to move.
   */
  async function restoreRevoked(
    db: NexusStore,
    grant: GrantRecord,
    request: AccessRequestRecord | null,
  ): Promise<boolean> {
    const back = await db.grants.updateIfStatus(grant.id, 'revoked', {
      status: 'active',
      revoked_by: null,
      revoked_at: null,
    });
    if (back && request) {
      await db.accessRequests.updateIfStatus(request.id, 'revoked', {
        status: request.status,
        decided_by: request.decided_by,
        decided_at: request.decided_at,
        decision_note: request.decision_note,
      });
    }
    return back !== null;
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

    // The `access.revoke` row committed with the claim, so the grant going
    // back and the row that says so commit together: a restored grant is
    // never left reading as revoked in the trail. The row's id is minted here
    // so that a failure below can tell whether it committed after all.
    const rollbackId = newId();
    try {
      await store.transaction(async (tx) => {
        details.grant_restored = await restoreRevoked(tx, grant, request);
        await audit
          .forStore(tx)
          .record(
            { id: actor.id, role: actor.role },
            AuditAction.ACCESS_REVOKE_ROLLBACK,
            { type: 'grant', id: grant.id },
            details,
            ip,
            { id: rollbackId },
          );
      });
    } catch (error) {
      // Read back by the id minted above; unreadable, it answers `false` and
      // the restore is retried, which is safe because it is a compare-and-set.
      if (await auditRowCommitted(store, { type: 'grant', id: grant.id }, rollbackId)) {
        // The transaction committed and only its acknowledgement was lost:
        // the grant is back and its row says so. Restoring again would act
        // on whatever has happened to the grant since — a new revocation's
        // claim — and a second row would record one rollback twice.
        deps.log?.(
          {
            grant_id: grant.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'A failed revocation was returned to active, though its acknowledgement was lost',
        );
      } else {
        // Nothing went back with it. Whatever failed — the rollback row's
        // insert, or the lease fence refusing a revocation that stalled past its
        // TTL — the restore must not go down with it: a grant left `revoked`
        // while its group is still on the consumer is working access the portal
        // shows as withdrawn, with nothing to repair it, whereas a missing
        // rollback row is only a gap in the trail. So the restore is retried on
        // its own, as bare compare-and-sets outside any transaction and so
        // outside the fence: the grant goes back only from `revoked`, and never
        // over an active grant a newer approval committed for the same identity
        // (the partial unique index refuses that).
        deps.log?.(
          {
            grant_id: grant.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Could not return a failed revocation to active with its rollback row; retrying alone',
        );
        try {
          details.grant_restored = await restoreRevoked(store, grant, request);
        } catch (retryError) {
          details.grant_restored = false;
          deps.log?.(
            {
              grant_id: grant.id,
              error: retryError instanceof Error ? retryError.message : String(retryError),
            },
            'Could not return a failed revocation to active',
          );
        }
        // Had the lookup above failed, a combined write whose acknowledgement
        // was lost may have committed after all, in which case the retry finds
        // the grant already back.
        if (details.grant_restored === false) {
          const current = await store.grants.findById(grant.id).catch(() => null);
          details.grant_restored = current?.status === 'active';
        }
        // Best-effort from here: the caller re-throws the gateway failure, and
        // this row is the trail of whichever way the restore went.
        await audit
          .record(
            { id: actor.id, role: actor.role },
            AuditAction.ACCESS_REVOKE_ROLLBACK,
            { type: 'grant', id: grant.id },
            details,
            ip,
          )
          .catch(() => undefined);
      }
    }

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
    /** The group that may have landed, or `null` for a proven pre-write rejection. */
    groupAdded: string | null;
    groupPossiblyApplied: boolean;
    /** The identity the approval was for; scopes both the re-check and the undo. */
    applicationId: Uuid | null;
    cause: unknown;
    ip: string | null;
  }): Promise<void> {
    const { actor, api, requester, requestId, groupAdded, cause, ip } = input;
    const details: Record<string, unknown> = {
      api_id: api.id,
      api_slug: api.slug,
      user_id: requester.id,
      application_id: input.applicationId,
      acl_group_possibly_applied: input.groupPossiblyApplied,
      cause: cause instanceof Error ? cause.message : String(cause),
    };

    const live = await store.grants
      .findActiveByApiAndUser(api.id, requester.id, input.applicationId)
      .catch(() => null);
    if (live) {
      // Somebody's approval owns this group after all. Undoing anything here
      // would revoke *their* access, so leave both the group and the decision
      // exactly as they are and let the audit row say so.
      details.acl_group_kept = groupAdded;
      details.kept_for_grant_id = live.id;
    } else {
      if (groupAdded !== null) {
        try {
          await setGroupMembership(requester, api.id, false, input.applicationId);
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
            'Could not take back the ACL group of a failed approval — the consumer may still have it',
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
    } catch (error) {
      deps.log?.(
        { user_id: recipient.id, error: error instanceof Error ? error.message : String(error) },
        'Could not write an in-app notification',
      );
    }
    try {
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

  /**
   * Refuse the request when the account has spent its rolling daily budget.
   *
   * The charge is the requester's own `access.request` audit rows, not the
   * `access_requests` rows. A request row does not outlive its identity:
   * deleting an application cascades its requests away, so a budget counted
   * from them was refunded by create application → request → delete →
   * repeat (issue #363). Audit rows are append-only and nothing cascades
   * them, so a cancelled request, and one whose application is gone, stay
   * charged until their timestamp leaves the window — and the charge carries
   * no more of the request than the audit trail already records. `request`
   * writes that row in the same transaction as the request itself, so a
   * creation that rolls back charges nothing.
   */
  async function assertWithinBudget(tx: NexusStore, requesterUserId: Uuid): Promise<void> {
    const limit = config.maxAccessRequestsPerUserPerDay;
    if (limit <= 0) return;
    const since = new Date(Date.now() - ACCESS_REQUEST_BUDGET_WINDOW_MS).toISOString();
    const used = await audit.forStore(tx).count({
      actor_user_id: requesterUserId,
      action: AuditAction.ACCESS_REQUEST,
      from: since,
    });
    if (used < limit) return;
    throw new NexusError(
      'QUOTA_EXCEEDED',
      `You have reached the limit of ${limit} access requests per ${ACCESS_REQUEST_BUDGET_WINDOW_LABEL}. ` +
        'Wait for the oldest of them to age out, or ask an administrator to raise the limit.',
      {
        limit,
        window: ACCESS_REQUEST_BUDGET_WINDOW_LABEL,
        setting: 'NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY',
      },
    );
  }

  async function spendBudget<T>(requesterUserId: Uuid, write: () => Promise<T>): Promise<T> {
    if (config.maxAccessRequestsPerUserPerDay <= 0) return write();
    return locks(accessRequestBudgetLockKey(requesterUserId), write);
  }

  return {
    async request(
      user,
      apiId,
      justification,
      applicationId = null,
      ip = null,
    ): Promise<AccessRequest> {
      const trimmed = justification.trim();
      if (trimmed === '') throw validationFailed('A justification is required');
      if (trimmed.length > MAX_JUSTIFICATION_LENGTH) {
        throw validationFailed(
          `A justification may be at most ${MAX_JUSTIFICATION_LENGTH} characters`,
        );
      }

      const api = await store.apis.findById(apiId);
      if (!api) throw notFound('API', apiId);
      // `private` is gated, and gated **first**. An account that cannot see the
      // API cannot ask for it, and every check below answers differently —
      // "retired", "does not accept requests" — so running any of them before
      // this one would turn a guessed id into an existence oracle. The rule is
      // the catalog's (`read-access.ts`): an authorized viewer, or an account
      // already holding a grant through any of its identities, may request
      // access like any other client (issue #288).
      //
      // `internal` is deliberately *not* gated. It means unlisted, not private:
      // a provider hands out the link and the recipient requests access through
      // the normal flow.
      if (
        api.visibility === 'private' &&
        !canViewApi(user, api, await resolveReadAccess(store, user, api))
      ) {
        throw notFound('API', apiId);
      }
      if (api.owner_user_id === user.id) {
        throw conflict('You already own this API');
      }
      if (api.status !== 'published') {
        throw conflict('This API is retired and is no longer accepting access requests');
      }
      if (!api.requestable) {
        throw conflict('This API does not accept access requests');
      }
      if (await store.grants.findActiveByApiAndUser(api.id, user.id, applicationId)) {
        throw conflict(
          applicationId === null
            ? 'You already have access to this API'
            : 'This application already has access to this API',
        );
      }

      const admit = async (): Promise<AccessRequestRecord> => {
        // Re-read under the application's key. The route resolved it before
        // this section was entered, and a delete that finished in between
        // left MongoDB — which has no foreign key — holding a pending request
        // for an application that no longer existed (issue #365). Refused
        // here, before the budget or the audit trail is touched.
        if (applicationId !== null) {
          const application = await store.applications.findById(applicationId);
          if (!application || application.owner_user_id !== user.id) {
            throw notFound('Application', applicationId);
          }
          if (application.status !== 'active') {
            throw conflict('This application is disabled', { application_id: applicationId });
          }
        }

        const row = await spendBudget(user.id, () =>
          store.transaction(async (tx) => {
            await assertWithinBudget(tx, user.id);
            if (await tx.accessRequests.findPendingByApiAndUser(api.id, user.id, applicationId)) {
              throw conflict('You already have a pending request for this API');
            }
            const inserted = await tx.accessRequests.create({
              api_id: api.id,
              user_id: user.id,
              application_id: applicationId,
              justification: trimmed,
              status: 'pending',
            });
            // In the transaction: this row is the budget's charge, so it must
            // commit exactly when the request does (issue #363).
            await audit
              .forStore(tx)
              .record(
                { id: user.id, role: user.role },
                AuditAction.ACCESS_REQUEST,
                { type: 'access_request', id: inserted.id },
                { api_id: api.id, api_slug: api.slug },
                ip,
              );
            return inserted;
          }),
        );

        // Still inside the key, so a provider is never told about a request
        // for an identity whose deletion had already begun.
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
        return row;
      };

      // An application-scoped request holds the identity's provisioning name
      // key — the one `ApplicationsService.remove` holds for the whole of a
      // deletion — from the re-read above until the request has committed.
      // Whichever goes second sees the other's work: a delete that follows
      // cascades the request away, and a request that follows finds no
      // application. The budget key is taken inside it, never the reverse.
      // The account's own identity cannot be deleted, so it needs no key.
      const created =
        applicationId === null
          ? await admit()
          : await edge.serializePerKey(
              canonicalConsumerLockKey(namespace, consumerUsernameForApplication(applicationId)),
              admit,
            );

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
      // The loser records nothing; the winner records the cancellation in the
      // same transaction.
      const decidedAt = nowIso();
      const updated = await store.transaction(async (tx) => {
        const moved = await tx.accessRequests.updateIfStatus(request.id, 'pending', {
          status: 'cancelled',
          decided_by: user.id,
          decided_at: decidedAt,
        });
        if (!moved) return null;
        await audit
          .forStore(tx)
          .record(
            { id: user.id, role: user.role },
            AuditAction.ACCESS_CANCEL,
            { type: 'access_request', id: request.id },
            { api_id: request.api_id },
            ip,
          );
        return moved;
      });
      if (!updated) throw await decisionConflict(request.id);

      const [decorated] = await decorateRequests([updated]);
      return decorated ?? updated;
    },

    async approve(actor, requestId, note = null, ip = null) {
      const initial = await loadRequest(requestId);
      assertCanReview(actor, initial.api);
      // Publishing holds the same proxy lease through catalog policy changes.
      // Reload admission inside it and retain it through grant/ACL commit (or
      // compensation), so retirement cannot finish before a new grant lands.
      const decide = async () => {
        const { request, api, requester } = await loadRequest(requestId);
        assertCanReview(actor, api);
        if (api.ferrum_proxy_id !== initial.api.ferrum_proxy_id) {
          throw conflict('The gateway proxy changed while approval was waiting; reload and retry');
        }
        if (api.status !== 'published') {
          throw conflict('This API is retired and is no longer accepting access approvals');
        }
        if (!api.requestable) {
          throw conflict('This API does not accept access approvals');
        }
        if (request.status !== 'pending') {
          throw conflict(`This request is already ${request.status}`);
        }
        // A request filed for an application while it was active is still
        // pending after the application is disabled, and "disabled acquires no
        // new access" has to hold here too — a check at request time alone
        // does not cover it. Checked inside the lease, before the decision is
        // claimed, so the request is left pending for when it is re-enabled.
        if (request.application_id !== null) {
          const application = await store.applications.findById(request.application_id);
          if (!application || application.status !== 'active') {
            throw conflict('The application this request is for is disabled', {
              application_id: request.application_id,
            });
          }
        }
        // Scoped to the requesting identity: an account holding an
        // account-scoped grant may still request one for an application of
        // theirs, and two applications of one owner are independent.
        if (
          await store.grants.findActiveByApiAndUser(api.id, requester.id, request.application_id)
        ) {
          throw conflict('This identity already has an active grant for this API');
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
        const group = aclGroupForApi(api.id);
        let addedGroup: string | null = group;
        let groupPossiblyApplied = true;
        const committed: { grant?: GrantRecord } = {};
        try {
          try {
            // A rejected write may still have landed. Register compensation
            // before attempting it, even if the gateway never acknowledges it.
            //
            // The grant row is written *inside* the consumer key, straight
            // after the group lands (issue #341). Released in between, an
            // application delete — which removes the consumer and cascades
            // the rows under this key — could run first, and the grant then
            // landed for an application that no longer exists: the SQL
            // foreign key refuses it, but MongoDB has none. A re-enable, which
            // rebuilds the groups from active grants under the same key, is
            // likewise ordered wholly before or after the pair.
            await setGroupMembership(requester, api.id, true, request.application_id, {
              afterWrite: async () => {
                groupPossiblyApplied = false;
                committed.grant = await store.transaction(async (tx) => {
                  // Re-read under the key the delete holds: an application
                  // gone or disabled since the admission check above gets no
                  // grant, and the catch below takes the group back off.
                  if (request.application_id !== null) {
                    const application = await tx.applications.findById(request.application_id);
                    if (!application || application.owner_user_id !== requester.id) {
                      throw notFound('Application', request.application_id);
                    }
                    if (application.status !== 'active') {
                      throw conflict('The application this request is for is disabled', {
                        application_id: request.application_id,
                      });
                    }
                  }
                  const created = await tx.grants.create({
                    api_id: api.id,
                    application_id: request.application_id,
                    user_id: requester.id,
                    access_request_id: request.id,
                    acl_group: group,
                    status: 'active',
                    granted_by: actor.id,
                  });
                  // The grant and its audit row commit together. Recorded
                  // after the commit, a failed insert left working access
                  // granted and unaudited behind a `500`; now it rolls the
                  // grant back and the catch below takes the group back off
                  // and returns the request to pending for a retry.
                  await audit.forStore(tx).record(
                    { id: actor.id, role: actor.role },
                    AuditAction.ACCESS_APPROVE,
                    { type: 'access_request', id: request.id },
                    {
                      api_id: api.id,
                      api_slug: api.slug,
                      user_id: requester.id,
                      grant_id: created.id,
                      acl_group: created.acl_group,
                    },
                    ip,
                  );
                  return created;
                });
              },
            });
          } catch (error) {
            // The provisioner's active-user guard runs before the ACL write.
            if (isNexusError(error) && error.code === 'USER_DISABLED') {
              addedGroup = null;
              groupPossiblyApplied = false;
            }
            throw error;
          }
        } catch (error) {
          await unwindApproval({
            actor,
            api,
            requester,
            requestId: request.id,
            groupAdded: addedGroup,
            groupPossiblyApplied,
            applicationId: request.application_id,
            cause: error,
            ip,
          });
          throw error;
        }
        const grant = committed.grant;
        if (!grant) throw new NexusError('INTERNAL', 'The approval recorded no grant');

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
      };
      return initial.api.ferrum_proxy_id
        ? edge.serializePerKey(`proxy:${initial.api.ferrum_proxy_id}`, decide)
        : decide();
    },

    async deny(actor, requestId, note = null, ip = null): Promise<AccessRequest> {
      const { request, api, requester } = await loadRequest(requestId);
      assertCanReview(actor, api);
      if (request.status !== 'pending') {
        throw conflict(`This request is already ${request.status}`);
      }

      // Compare-and-set, for the same reason `cancel` uses one: the requester
      // may have withdrawn the request since it was read. The decision and its
      // audit row commit together.
      const decidedAt = nowIso();
      const updated = await store.transaction(async (tx) => {
        const moved = await tx.accessRequests.updateIfStatus(request.id, 'pending', {
          status: 'denied',
          decided_by: actor.id,
          decided_at: decidedAt,
          decision_note: note ?? null,
        });
        if (!moved) return null;
        await audit
          .forStore(tx)
          .record(
            { id: actor.id, role: actor.role },
            AuditAction.ACCESS_DENY,
            { type: 'access_request', id: request.id },
            { api_id: api.id, api_slug: api.slug, user_id: requester.id, has_note: note !== null },
            ip,
          );
        return moved;
      });
      if (!updated) throw await decisionConflict(request.id);

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

    async revoke(actor, grantId, reason = null, ip = null, recordWithRevoke): Promise<Grant> {
      const initial = await store.grants.findById(grantId);
      if (!initial) throw notFound('Grant', grantId);
      const initialApi = await store.apis.findById(initial.api_id);
      if (!initialApi) throw notFound('API', initial.api_id);
      assertCanReview(actor, initialApi);
      if (initial.status !== 'active') throw conflict('This grant is already revoked');

      // The claim, the ACL removal and its compensation all hold the same
      // `proxy:<id>` lease an approval holds through its claim and ACL add
      // (issue #341). Without it a revocation that had claimed the grant but
      // not yet reached the gateway could be overtaken by a re-request and
      // approval of the same API: the approval added the group and committed
      // a new active grant, and the delayed removal then stripped it — a
      // portal showing access the gateway denies. Under one lease the two are
      // ordered: an approval that goes second adds the group back after this
      // removal, and one that went first holds a grant this claim never
      // touches.
      const withdraw = async (): Promise<GrantRecord> => {
        // Re-read under the lease: whatever held it may have revoked this
        // grant or moved the API, and the snapshot above is from before.
        const grant = await store.grants.findById(grantId);
        if (!grant) throw notFound('Grant', grantId);
        const api = await store.apis.findById(grant.api_id);
        if (!api) throw notFound('API', grant.api_id);
        assertCanReview(actor, api);
        if (api.ferrum_proxy_id !== initialApi.ferrum_proxy_id) {
          throw conflict(
            'The gateway proxy changed while this revocation was waiting; reload and retry',
          );
        }

        const grantee = await store.users.findById(grant.user_id);

        // Step 1 — claim the transition before anything reaches the gateway,
        // for the same reason an approval claims its decision first. The read
        // above is stale the instant it returns: a second click, god mode
        // racing the API owner, or the disable-account sweep can all be
        // revoking this same grant, and a blind write by id let every one of
        // them past the `status !== 'active'` guard. They each stripped the ACL
        // group and each wrote an `access.revoke` row, so the trail claimed
        // one access had been withdrawn several times over. The loser stops
        // here with a CONFLICT.
        const revokedAt = nowIso();
        let movedRequest: AccessRequestRecord | null = null;
        const updated = await store.transaction(async (tx) => {
          // The body may be run again if the adapter retries it, so the only
          // thing it writes outside the store starts each attempt cleared:
          // a request moved by an attempt that rolled back was not moved.
          movedRequest = null;
          const result = await tx.grants.updateIfStatus(grant.id, 'active', {
            status: 'revoked',
            revoked_by: actor.id,
            revoked_at: revokedAt,
          });
          if (!result) return null;
          // Keep the originating request's status honest so the requester's
          // history reads "approved, then revoked" rather than staying
          // approved.
          movedRequest = await moveRequestToRevoked(tx, grant, actor.id, revokedAt, reason);
          // The revocation is recorded with the claim that makes it. Written
          // after the gateway step, a failed insert left the grant revoked and
          // unaudited behind a `500`, and a repeat found it already revoked
          // and recorded nothing. Should the gateway then refuse the removal,
          // `unwindRevocation` puts the grant back and records that too.
          await audit.forStore(tx).record(
            { id: actor.id, role: actor.role },
            AuditAction.ACCESS_REVOKE,
            { type: 'grant', id: grant.id },
            {
              api_id: api.id,
              api_slug: api.slug,
              user_id: grant.user_id,
              application_id: grant.application_id,
              acl_group: grant.acl_group,
              reason: reason ?? null,
            },
            ip,
          );
          await recordWithRevoke?.(tx, result);
          return result;
        });
        if (!updated) throw await revocationConflict(grant.id);

        // Step 2 — the gateway, now that exactly one caller is entitled to
        // touch it. `unwindRevocation` puts the rows back if the group will
        // not come off: a revocation the gateway did not accept must not stand
        // as one.
        try {
          if (grantee) await setGroupMembership(grantee, api.id, false, grant.application_id);
        } catch (error) {
          await unwindRevocation({ actor, grant, request: movedRequest, cause: error, ip });
          throw error;
        }

        // Inside the lease, as an approval announces inside it: a revocation
        // and a quick re-approval of the same API are ordered by the lease,
        // and their notices have to be too, or "approved" could reach the
        // grantee before the "revoked" it followed. `announce` never throws.
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
        return updated;
      };

      const updated = initialApi.ferrum_proxy_id
        ? await edge.serializePerKey(`proxy:${initialApi.ferrum_proxy_id}`, withdraw)
        : await withdraw();

      const [decorated] = await decorateGrants([updated]);
      return decorated ?? updated;
    },

    async revokeAllForUser(actor, userId, reason, ip = null): Promise<BulkRevocationResult> {
      const grants = await store.grants.listActiveByUser(userId);
      let revoked = 0;
      const failed: BulkRevocationFailure[] = [];
      const fail = (
        grant: GrantRecord,
        stage: BulkRevocationFailure['stage'],
        error: unknown,
      ): string => {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({
          grant_id: grant.id,
          api_id: grant.api_id,
          application_id: grant.application_id,
          stage,
          error: message,
        });
        deps.log?.(
          { grant_id: grant.id, stage, error: message },
          'Could not revoke a grant during a bulk revocation',
        );
        return message;
      };

      for (const grant of grants) {
        // Bypasses the ownership check on purpose: this is only reachable from
        // god mode, which has already proven super_admin.
        //
        // Claim each grant before touching the gateway, exactly as `revoke`
        // does — `listActiveByUser` above is a snapshot, and a targeted
        // revocation or a second disable may have taken any row in it since —
        // and move its originating request to `revoked` in the same
        // transaction, so the requester's history reads "approved, then
        // revoked" whichever path withdrew it (issue #341).
        //
        // A loser here *skips* rather than raising: unlike `revoke`, which
        // answers one caller about one grant, this is a sweep, and the grant
        // it lost is revoked either way. Aborting the loop over somebody
        // else's success would leave the rest of the account's access up.
        // It is not counted, because this call did not revoke it.
        //
        // The `access.revoke` row commits with the claim, as a targeted
        // revocation's does: a grant whose row cannot be written is not
        // claimed, and stays active for a repeat of the sweep. What the
        // gateway then did with it is reported in `failed`, which god mode's
        // completion row carries grant by grant.
        const revokedAt = nowIso();
        let claimed: GrantRecord | null;
        try {
          claimed = await store.transaction(async (tx) => {
            const result = await tx.grants.updateIfStatus(grant.id, 'active', {
              status: 'revoked',
              revoked_by: actor.id,
              revoked_at: revokedAt,
            });
            if (!result) return null;
            await moveRequestToRevoked(tx, grant, actor.id, revokedAt, reason);
            await audit.forStore(tx).record(
              { id: actor.id, role: actor.role },
              AuditAction.ACCESS_REVOKE,
              { type: 'grant', id: grant.id },
              {
                api_id: grant.api_id,
                user_id: userId,
                application_id: grant.application_id,
                acl_group: grant.acl_group,
                reason,
                bulk: true,
              },
              ip,
            );
            return result;
          });
        } catch (error) {
          // Nothing moved: the grant is still active, and a repeat of the
          // sweep picks it up.
          fail(grant, 'claim', error);
          continue;
        }
        if (!claimed) continue;

        // The gateway. Unlike `revoke`, a failure here is **not** unwound:
        // this sweep withdraws access a super admin asked to remove, and
        // putting the grant back to `active` meant a later re-enable replayed
        // its group onto the consumer — restoring exactly that access. The
        // portal row stays `revoked` (fail closed), the failure is reported to
        // the caller, and the account's gateway teardown — which runs after
        // this sweep and strips every group off every identity the account
        // holds — is what takes the group off. Should that fail too and the
        // account be re-enabled before its retry, the re-enable rebuilds the
        // approval groups from active grants only, so the group goes then.
        // Also why the sweep takes no proxy lease: the account is already
        // disabled, and an approval's active-owner check inside the consumer
        // key refuses to add a group back for it.
        //
        // What to take off is read first, and a store failure there is
        // reported as one (`lookup`), not as a gateway failure.
        let cause: string | null = null;
        let consumerId: string | null = null;
        try {
          const api = await store.apis.findById(grant.api_id);
          const grantee = await store.users.findById(userId);
          if (api && grantee) {
            const consumer = await store.consumers.findByUserAndNamespace(
              userId,
              namespace,
              grant.application_id,
            );
            // No consumer, no group: the identity never reached the gateway.
            consumerId = consumer?.ferrum_consumer_id ?? null;
          }
        } catch (error) {
          cause = fail(grant, 'lookup', error);
        }
        if (consumerId !== null) {
          const group = aclGroupForApi(grant.api_id);
          try {
            // A consumer already gone from the gateway took its groups with
            // it: the access is gone, which is all this removal is for.
            await provisioner.mutateAclGroups(
              consumerId,
              (groups) => withoutGroup(groups, group),
              userId,
              { absentIsDone: true },
            );
          } catch (error) {
            cause = fail(grant, 'gateway', error);
          }
        }

        if (cause === null) revoked += 1;
      }
      return { revoked, failed };
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
