/**
 * Profile self-service, administrative user management and organizations.
 *
 * Three rules are enforced here rather than in the routes, so no future caller
 * can route around them:
 *
 * 1. **Self-service cannot escalate.** `updateMe` touches display name, company
 *    and phone (plus the password, with the current one). Role, status, email
 *    and org membership are not reachable from that path at all.
 * 2. **Only a `super_admin` confers or removes admin power.** A plain `admin`
 *    can move accounts between `client` and `provider`, and nothing more —
 *    neither promoting someone to `admin` nor demoting an existing one.
 * 3. **The last active `super_admin` is untouchable.** Demoting or disabling it
 *    raises `LAST_SUPER_ADMIN`, checked with `countActiveSuperAdmins` excluding
 *    the target so the count is about *the others*. The check that decides is
 *    the one **inside the transaction that performs the update** — a count made
 *    outside one is advisory, because two administrators demoting each other
 *    simultaneously each pass it and the portal is left with no super admin at
 *    all. And because a transaction only serialises the count against writes
 *    made through *that* store, every transition that can shrink the set runs
 *    inside the `SUPER_ADMIN_LOCK_KEY` section of the store-level lock — a
 *    database lease, so two Nexus instances against one PostgreSQL take turns
 *    the same way two requests in one process do. The lock is taken **outside**
 *    the transaction: the lease repository runs statements of its own, and on
 *    SQLite (one connection, bodies drained by a queue) waiting for a lease from
 *    inside a body blocks the very transaction that would release it.
 *
 * Disabling an account also deletes its sessions, so the next request from an
 * open browser tab is a 401 rather than a working page — **and** strips its
 * Ferrum consumer, because an issued API key needs no portal session at all.
 *
 * That last step is **durable work, not a side effect**. A
 * `gateway_teardown_jobs` row is written in the same transaction as
 * `status = 'disabled'`, the revocation runs immediately, and a failure leaves
 * the job `pending` for the teardown worker rather than being reported as a
 * finished disable (`GHSA-8vxw-j3wc-w6vm`). Re-enabling an account deletes the
 * job, so a retry can never strip a live account's credentials.
 */

import {
  MIN_PASSWORD_LENGTH,
  roleAtLeast,
  type GatewayTeardownOutcome,
  type GatewayTeardownState,
  type Organization,
  type Paginated,
  type Role,
  type User,
  type UserStatus,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import { createPasswordChangeSerializer } from '../auth/password-change.js';
import {
  toPublicUser,
  type AuthService,
  type IssuedSession,
  type RequestContext,
} from '../auth/service.js';
import {
  runGatewayTeardown,
  type CredentialsService,
  type GatewayTeardownAttempt,
} from '../credentials/service.js';
import type {
  GatewayTeardownJobRecord,
  ListOptions,
  NexusStore,
  UpdateInput,
  UserFilter,
  UserRecord,
} from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { conflict, forbidden, lastSuperAdmin, notFound, validationFailed } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import { SUPER_ADMIN_LOCK_KEY, type KeyedSerializer } from '../lib/keyed-serializer.js';
import type { NotificationsService } from '../notifications/service.js';

/** Result of {@link UsersService.updateMe}. */
export interface UpdateMeResult {
  user: User;
  /**
   * Present only when the password changed: every session of the account was
   * deleted, and this one was issued to keep the caller signed in. The route
   * must write it to the reply's cookies.
   */
  reissued: IssuedSession | null;
}

/** Patch accepted by {@link UsersService.updateMe}. */
export interface UpdateMeInput {
  display_name?: string;
  company?: string | null;
  phone?: string | null;
  /** Required when `new_password` is supplied. */
  current_password?: string;
  new_password?: string;
}

/** Patch accepted by {@link UsersService.updateUser}. */
export interface UpdateUserInput {
  role?: Role;
  status?: UserStatus;
  org_id?: Uuid | null;
  display_name?: string;
}

/** Result of {@link UsersService.updateUser}. */
export interface UpdateUserResult {
  user: User;
  /**
   * Present only when this call disabled the account. `pending` means the
   * gateway credentials are still live and the teardown worker is retrying.
   */
  gateway_teardown?: GatewayTeardownOutcome;
}

/** Result of {@link UsersService.getUser} — the admin account detail. */
export interface UserDetail {
  user: User;
  gateway_teardown: GatewayTeardownState | null;
}

/** Result of {@link UsersService.retryGatewayTeardown}. */
export interface RetryGatewayTeardownResult {
  gateway_teardown: GatewayTeardownOutcome;
  job: GatewayTeardownJobRecord | null;
}

/** Filters accepted by {@link UsersService.listUsers}. */
export interface UserListFilter {
  role?: Role;
  status?: UserStatus;
  org_id?: Uuid;
  q?: string;
}

/** Profile, user administration and organization operations. */
export interface UsersService {
  /** The caller's own account. */
  getMe(user: UserRecord): User;
  /**
   * Self-service profile update. Never touches role, status or email.
   *
   * A password change also ends every session of the account and hands back a
   * replacement for the caller — see {@link UpdateMeResult.reissued}.
   */
  updateMe(
    user: UserRecord,
    patch: UpdateMeInput,
    context?: RequestContext,
  ): Promise<UpdateMeResult>;
  listUsers(filter?: UserListFilter, options?: ListOptions): Promise<Paginated<User>>;
  /** Portal-wide count of disabled accounts still owing a gateway revocation. */
  countPendingGatewayTeardowns(): Promise<number>;
  /** Admin account detail, including any outstanding gateway revocation. */
  getUser(targetId: Uuid): Promise<UserDetail>;
  /** Admin update of another account, with the role and last-super-admin guards. */
  updateUser(
    actor: UserRecord,
    targetId: Uuid,
    patch: UpdateUserInput,
    ip?: string | null,
  ): Promise<UpdateUserResult>;
  /**
   * Re-run a disabled account's gateway revocation immediately.
   *
   * The explicit operator handle on the pending state: it re-queues the job and
   * attempts it once, so a recovered Edge does not have to be waited out.
   */
  retryGatewayTeardown(
    actor: UserRecord,
    targetId: Uuid,
    ip?: string | null,
  ): Promise<RetryGatewayTeardownResult>;
  listOrganizations(options?: ListOptions): Promise<Paginated<Organization>>;
  createOrganization(
    actor: UserRecord,
    input: { name: string; description?: string | null },
    ip?: string | null,
  ): Promise<Organization>;
  updateOrganization(
    actor: UserRecord,
    id: Uuid,
    patch: { name?: string; description?: string | null },
    ip?: string | null,
  ): Promise<Organization>;
}

/** Dependencies of {@link createUsersService}. */
export interface UsersServiceDeps {
  store: NexusStore;
  crypto: NexusCrypto;
  audit: AuditService;
  /** Used to tell a user their role or account status changed. */
  notifications: NotificationsService;
  /** Issues the replacement session a password change needs. */
  auth: AuthService;
  /** Strips the gateway identity of an account being disabled. */
  credentials: Pick<CredentialsService, 'disableGatewayAccess'>;
  /**
   * Store-level cross-instance lock, built in the composition root from
   * `store.leases`. Every transition that can shrink the active `super_admin`
   * set runs under {@link SUPER_ADMIN_LOCK_KEY}.
   *
   * Optional so a unit test can construct the service without one; a process
   * that omits it is back to relying on its own transaction queue, which is
   * correct only for a single instance.
   */
  locks?: KeyedSerializer;
  /** Records a gateway teardown that failed; the disable still goes through. */
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** Roles that only a `super_admin` may confer or remove. */
function isElevated(role: Role): boolean {
  return roleAtLeast(role, 'admin');
}

/** Project a job row onto the wire shape (dropping the ids admins do not need). */
export function toTeardownState(job: GatewayTeardownJobRecord): GatewayTeardownState {
  return {
    status: job.status,
    attempts: job.attempts,
    last_error: job.last_error,
    next_attempt_at: job.next_attempt_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  };
}

/** Build the users service. */
export function createUsersService(deps: UsersServiceDeps): UsersService {
  const { store, crypto, audit, notifications, auth, credentials } = deps;
  const serializePasswordChange = createPasswordChangeSerializer(store);
  // Without a lock the service is exactly as safe as it was: the store's own
  // transaction serialisation, which is enough for one instance.
  const locks: KeyedSerializer = deps.locks ?? ((_key, fn) => fn());

  return {
    getMe: (user) => toPublicUser(user),

    async updateMe(user, patch, context = { ip: null, userAgent: null }): Promise<UpdateMeResult> {
      const ip = context.ip;
      const update: UpdateInput<UserRecord> = {};
      const changed: string[] = [];

      if (patch.display_name !== undefined) {
        const name = patch.display_name.trim();
        if (name === '') throw validationFailed('Display name cannot be empty');
        update.display_name = name;
        changed.push('display_name');
      }
      if (patch.company !== undefined) {
        update.company = patch.company;
        changed.push('company');
      }
      if (patch.phone !== undefined) {
        update.phone = patch.phone;
        changed.push('phone');
      }
      if (patch.new_password !== undefined) {
        if (patch.new_password.length < MIN_PASSWORD_LENGTH) {
          throw validationFailed(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
        }
        if (!patch.current_password) {
          throw validationFailed('Your current password is required to set a new one');
        }
        const ok = await crypto.verifyPassword(patch.current_password, user.password_hash);
        if (!ok) throw forbidden('Your current password is incorrect');
        update.password_hash = await crypto.hashPassword(patch.new_password);
        changed.push('password');
      }

      if (changed.length === 0) return { user: toPublicUser(user), reissued: null };

      const change = async (): Promise<UpdateMeResult> => {
        const updated = await store.transaction(async (tx) => {
          if (update.password_hash !== undefined) {
            const current = await tx.users.findById(user.id);
            if (!current) throw notFound('User', user.id);
            // Verification and hashing ran outside the lock. A reset that won
            // meanwhile must not be overwritten using the old password proof.
            if (current.password_hash !== user.password_hash) {
              throw forbidden('Your current password is incorrect');
            }
          }
          const row = await tx.users.update(user.id, update);
          if (!row) throw notFound('User', user.id);

          let terminatedSessions = 0;
          if (update.password_hash !== undefined) {
            await tx.verificationTokens.deleteForUser(user.id, 'password_reset');
            terminatedSessions = await tx.sessions.deleteForUser(user.id);
          }
          await audit.forStore(tx).record(
            { id: user.id, role: user.role },
            AuditAction.USER_UPDATE,
            { type: 'user', id: user.id },
            {
              self: true,
              changed_fields: changed,
              ...(terminatedSessions > 0 ? { terminated_sessions: terminatedSessions } : {}),
            },
            ip,
          );
          return row;
        });

        // Commit before issuing the caller's replacement. Keep the password
        // lease until issuance finishes so a concurrent reset cannot leave a
        // session issued by the earlier password change alive after its reset.
        const reissued =
          update.password_hash !== undefined ? await auth.issueSession(updated, context) : null;
        return { user: toPublicUser(updated), reissued };
      };
      return update.password_hash !== undefined
        ? serializePasswordChange(user.id, change)
        : change();
    },

    async listUsers(filter = {}, options): Promise<Paginated<User>> {
      const storeFilter: UserFilter = {
        ...(filter.role !== undefined ? { role: filter.role } : {}),
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        ...(filter.org_id !== undefined ? { org_id: filter.org_id } : {}),
        ...(filter.q !== undefined ? { q: filter.q } : {}),
      };
      const page = await store.users.list(storeFilter, options);
      return { items: page.items.map(toPublicUser), total: page.total };
    },

    async countPendingGatewayTeardowns(): Promise<number> {
      // Only the total matters here, so the smallest page the store will serve
      // is enough — `total` ignores pagination.
      const page = await store.gatewayTeardownJobs.list({ status: 'pending' }, { limit: 1 });
      return page.total;
    },

    async getUser(targetId): Promise<UserDetail> {
      const target = await store.users.findById(targetId);
      if (!target) throw notFound('User', targetId);
      const job = await store.gatewayTeardownJobs.findByUser(targetId);
      return {
        user: toPublicUser(target),
        gateway_teardown: job ? toTeardownState(job) : null,
      };
    },

    async retryGatewayTeardown(actor, targetId, ip = null): Promise<RetryGatewayTeardownResult> {
      const target = await store.users.findById(targetId);
      if (!target) throw notFound('User', targetId);
      // An active account's consumer is supposed to work; re-running the
      // teardown against it would revoke credentials nobody asked to revoke.
      if (target.status !== 'disabled') {
        throw conflict('Only a disabled account has a gateway revocation to retry');
      }

      // Re-queue first, so a job that had somehow gone missing (or already
      // completed against a gateway that has since drifted) is re-driven rather
      // than silently skipped.
      const job = await store.gatewayTeardownJobs.upsertPending(target.id, actor.id, nowIso());
      const attempt = await runGatewayTeardown({
        credentials,
        store,
        userId: target.id,
        subject: actor.id,
        jobId: job.id,
        ...(deps.log ? { log: deps.log } : {}),
      });

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.USER_GATEWAY_TEARDOWN_RETRY,
        { type: 'user', id: target.id },
        { attempts: job.attempts, ...attempt.details },
        ip,
      );

      return {
        gateway_teardown: attempt.outcome,
        job: await store.gatewayTeardownJobs.findByUser(target.id),
      };
    },

    async updateUser(actor, targetId, patch, ip = null): Promise<UpdateUserResult> {
      const target = await store.users.findById(targetId);
      if (!target) throw notFound('User', targetId);

      const update: UpdateInput<UserRecord> = {};
      const changed: string[] = [];

      if (patch.display_name !== undefined) {
        const name = patch.display_name.trim();
        if (name === '') throw validationFailed('Display name cannot be empty');
        update.display_name = name;
        changed.push('display_name');
      }
      if (patch.org_id !== undefined) {
        if (patch.org_id !== null && !(await store.organizations.findById(patch.org_id))) {
          throw notFound('Organization', patch.org_id);
        }
        update.org_id = patch.org_id;
        changed.push('org_id');
      }

      const roleChanged = patch.role !== undefined && patch.role !== target.role;
      if (roleChanged && patch.role) {
        // Conferring *or* removing admin power is a super_admin-only act.
        if (
          (isElevated(patch.role) || isElevated(target.role)) &&
          !roleAtLeast(actor.role, 'super_admin')
        ) {
          throw forbidden('Only a super admin can grant or revoke administrator roles');
        }
        if (target.role === 'super_admin' && target.status === 'active') {
          if ((await store.users.countActiveSuperAdmins(target.id)) === 0) throw lastSuperAdmin();
        }
        update.role = patch.role;
        changed.push('role');
      }

      const statusChanged = patch.status !== undefined && patch.status !== target.status;
      if (statusChanged && patch.status) {
        if (patch.status === 'disabled') {
          if (isElevated(target.role) && !roleAtLeast(actor.role, 'super_admin')) {
            throw forbidden('Only a super admin can disable an administrator');
          }
          // Checked before the self-disable rule so the *reason* a lone founder
          // cannot switch themselves off is the one the UI should explain.
          if (
            target.role === 'super_admin' &&
            (await store.users.countActiveSuperAdmins(target.id)) === 0
          ) {
            throw lastSuperAdmin();
          }
          if (target.id === actor.id) throw conflict('You cannot disable your own account');
        }
        update.status = patch.status;
        changed.push('status');
      }

      if (changed.length === 0) return { user: toPublicUser(target) };

      // The last-super-admin rule is a count of *other* rows followed by a
      // write to this one, and the checks above ran long before the write. Two
      // administrators demoting each other's account at the same moment both
      // passed them and the portal ended with zero active super admins.
      //
      // Both halves now happen inside one transaction body. Bodies are
      // serialised (see `db/store.ts`), so the losing demotion re-counts after
      // the winner committed and sees the invariant it would break; the
      // conditional update is the second line of defence, refusing a target
      // whose role or status moved underneath this call at all.
      //
      // That serialisation is per store object, though, and a multi-instance
      // deployment has one per process: two Nexus instances against one
      // PostgreSQL each opened their own transaction, each counted the *other*
      // super admin, and both committed. So the whole count-then-write also runs
      // inside `SUPER_ADMIN_LOCK_KEY`, a lease every instance contends for —
      // taken outside the transaction, because the lease repository issues
      // statements of its own.
      const guardsLastSuperAdmin =
        target.role === 'super_admin' &&
        ((roleChanged && target.status === 'active') || update.status === 'disabled');

      const transition = async (): Promise<{ row: UserRecord | null; jobId: Uuid | null }> =>
        store.transaction(async (tx) => {
          if (guardsLastSuperAdmin && (await tx.users.countActiveSuperAdmins(target.id)) === 0) {
            throw lastSuperAdmin();
          }
          const row = await tx.users.updateIfMatches(
            target.id,
            { role: target.role, status: target.status },
            update,
          );
          if (!row) return { row: null, jobId: null };
          // The revocation the disable owes is committed *with* the disable, so
          // the two can never disagree: there is no window in which the account
          // is off and nothing remembers that its gateway credentials are live.
          if (update.status === 'disabled') {
            const job = await tx.gatewayTeardownJobs.upsertPending(target.id, actor.id, nowIso());
            return { row, jobId: job.id };
          }
          // Re-enabling cancels any queued revocation — a retry must never strip
          // the credentials of an account that is live again.
          if (update.status === 'active') await tx.gatewayTeardownJobs.deleteByUser(target.id);
          return { row, jobId: null };
        });

      const result = guardsLastSuperAdmin
        ? await locks(SUPER_ADMIN_LOCK_KEY, transition)
        : await transition();
      const updated = result.row;
      if (!updated) {
        if (!(await store.users.findById(target.id))) throw notFound('User', targetId);
        throw conflict('That account changed while you were editing it — reload and try again');
      }

      // A disabled account must not keep a usable browser session — nor a
      // working gateway identity, which outlives the session entirely.
      let terminatedSessions = 0;
      let teardown: GatewayTeardownAttempt | null = null;
      if (update.status === 'disabled') {
        terminatedSessions = await store.sessions.deleteForUser(target.id);
        teardown = await runGatewayTeardown({
          credentials,
          store,
          userId: target.id,
          subject: actor.id,
          jobId: result.jobId,
          ...(deps.log ? { log: deps.log } : {}),
        });
      }

      const action = statusChanged
        ? update.status === 'disabled'
          ? AuditAction.USER_DISABLE
          : AuditAction.USER_UPDATE
        : roleChanged
          ? AuditAction.USER_ROLE_CHANGE
          : AuditAction.USER_UPDATE;

      await audit.record(
        { id: actor.id, role: actor.role },
        action,
        { type: 'user', id: target.id },
        {
          changed_fields: changed,
          ...(roleChanged ? { from_role: target.role, to_role: update.role } : {}),
          ...(statusChanged ? { from_status: target.status, to_status: update.status } : {}),
          ...(terminatedSessions > 0 ? { terminated_sessions: terminatedSessions } : {}),
          ...(teardown?.details ?? {}),
        },
        ip,
      );

      if (roleChanged) {
        await notifications.notify(
          target.id,
          'system',
          'Your role changed',
          `An administrator changed your role to ${update.role}.`,
          '/profile',
        );
      }

      return {
        user: toPublicUser(updated),
        ...(teardown ? { gateway_teardown: teardown.outcome } : {}),
      };
    },

    async listOrganizations(options): Promise<Paginated<Organization>> {
      return store.organizations.list(options);
    },

    async createOrganization(actor, input, ip = null): Promise<Organization> {
      const name = input.name.trim();
      if (name === '') throw validationFailed('An organization name is required');
      const organization = await store.organizations.create({
        name,
        description: input.description ?? null,
      });
      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.ORG_CREATE,
        { type: 'organization', id: organization.id },
        { name },
        ip,
      );
      return organization;
    },

    async updateOrganization(actor, id, patch, ip = null): Promise<Organization> {
      const existing = await store.organizations.findById(id);
      if (!existing) throw notFound('Organization', id);

      const update: UpdateInput<Organization> = {};
      const changed: string[] = [];
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (name === '') throw validationFailed('An organization name is required');
        update.name = name;
        changed.push('name');
      }
      if (patch.description !== undefined) {
        update.description = patch.description;
        changed.push('description');
      }
      if (changed.length === 0) return existing;

      const updated = await store.organizations.update(id, update);
      if (!updated) throw notFound('Organization', id);
      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.ORG_UPDATE,
        { type: 'organization', id },
        { changed_fields: changed },
        ip,
      );
      return updated;
    },
  };
}
