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
 *    the target so the count is about *the others*.
 *
 * Disabling an account also deletes its sessions, so the next request from an
 * open browser tab is a 401 rather than a working page — **and** strips its
 * Ferrum consumer, because an issued API key needs no portal session at all.
 */

import {
  MIN_PASSWORD_LENGTH,
  roleAtLeast,
  type Organization,
  type Paginated,
  type Role,
  type User,
  type UserStatus,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import {
  toPublicUser,
  type AuthService,
  type IssuedSession,
  type RequestContext,
} from '../auth/service.js';
import { tearDownGatewayAccess, type CredentialsService } from '../credentials/service.js';
import type { ListOptions, NexusStore, UpdateInput, UserFilter, UserRecord } from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { conflict, forbidden, lastSuperAdmin, notFound, validationFailed } from '../lib/errors.js';
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
  /** Admin update of another account, with the role and last-super-admin guards. */
  updateUser(
    actor: UserRecord,
    targetId: Uuid,
    patch: UpdateUserInput,
    ip?: string | null,
  ): Promise<User>;
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
  /** Records a gateway teardown that failed; the disable still goes through. */
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** Roles that only a `super_admin` may confer or remove. */
function isElevated(role: Role): boolean {
  return roleAtLeast(role, 'admin');
}

/** Build the users service. */
export function createUsersService(deps: UsersServiceDeps): UsersService {
  const { store, crypto, audit, notifications, auth, credentials } = deps;

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

      const updated = await store.users.update(user.id, update);
      if (!updated) throw notFound('User', user.id);

      // A password change ends every session of the account — the point of
      // changing it is usually that somebody else might hold one. The caller
      // gets a replacement so they are not signed out of the tab they did it
      // in; every other session is gone, sliding expiry and all.
      let reissued: IssuedSession | null = null;
      let terminatedSessions = 0;
      if (update.password_hash !== undefined) {
        terminatedSessions = await store.sessions.deleteForUser(user.id);
        reissued = await auth.issueSession(updated, context);
      }

      await audit.record(
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
      return { user: toPublicUser(updated), reissued };
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

    async updateUser(actor, targetId, patch, ip = null): Promise<User> {
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

      if (changed.length === 0) return toPublicUser(target);

      const updated = await store.users.update(target.id, update);
      if (!updated) throw notFound('User', targetId);

      // A disabled account must not keep a usable browser session — nor a
      // working gateway identity, which outlives the session entirely.
      let terminatedSessions = 0;
      let teardown: Record<string, unknown> = {};
      if (update.status === 'disabled') {
        terminatedSessions = await store.sessions.deleteForUser(target.id);
        teardown = await tearDownGatewayAccess(credentials, target.id, actor.id, deps.log);
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
          ...teardown,
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

      return toPublicUser(updated);
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
