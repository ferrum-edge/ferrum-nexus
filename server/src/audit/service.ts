/**
 * Audit service — the only writer of `audit_logs`.
 *
 * Every state-changing endpoint must record exactly one row here. Actions are
 * dot-namespaced strings drawn from {@link AuditAction}; adding a new one means
 * appending to that catalog **and** to the table in `docs/security.md`.
 */

import type { AuditLog, Paginated, Role, Uuid } from '@ferrum-nexus/shared';

import type { AuditLogFilter, ListOptions, NexusStore } from '../db/store.js';

/**
 * Catalog of every audit action Nexus emits.
 *
 * Naming: `<domain>.<verb>`, lowercase, snake_case verbs. God-mode actions are
 * namespaced `god.*` so they can be filtered out of ordinary reporting.
 */
export const AuditAction = {
  /* auth */
  AUTH_REGISTER: 'auth.register',
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_VERIFY_EMAIL: 'auth.verify_email',
  /** A fresh verification link was minted and queued for an unverified account. */
  AUTH_VERIFICATION_RESEND: 'auth.verification_resend',
  /**
   * A password-reset link was minted and queued. Absent for an address with no
   * account, a disabled one, or a request inside the resend throttle — the
   * endpoint answers all four identically, and the log is what tells them
   * apart afterwards.
   */
  AUTH_PASSWORD_RESET_REQUEST: 'auth.password_reset_request',
  /** A reset link was redeemed: new password set, every session terminated. */
  AUTH_PASSWORD_RESET: 'auth.password_reset',

  /* users & organizations */
  USER_UPDATE: 'user.update',
  USER_ROLE_CHANGE: 'user.role_change',
  USER_DISABLE: 'user.disable',
  /**
   * The teardown worker finished the gateway revocation a disable had left
   * pending. Written by the system, so the actor is {@link SYSTEM_ACTOR}.
   */
  USER_GATEWAY_TEARDOWN_COMPLETE: 'user.gateway_teardown_complete',
  /** An admin re-ran a pending gateway revocation by hand. */
  USER_GATEWAY_TEARDOWN_RETRY: 'user.gateway_teardown_retry',
  ORG_CREATE: 'org.create',
  ORG_UPDATE: 'org.update',

  /* publishing */
  API_PUBLISH: 'api.publish',
  API_UPDATE: 'api.update',
  API_SPEC_UPDATE: 'api.spec_update',
  API_RETIRE: 'api.retire',
  API_DELETE: 'api.delete',
  /** A palette plugin was created or replaced on an API's proxy. */
  API_PLUGIN_SET: 'api.plugin_set',
  /** A palette plugin was detached from an API's proxy and deleted. */
  API_PLUGIN_REMOVE: 'api.plugin_remove',
  /**
   * A `spec_enforcement` conversion could neither finish nor put the original
   * proxy back, so the API has no gateway object at all.
   *
   * The details carry the proxy document and the hand-owned plugin configs as
   * they were before the conversion — the only surviving copy — so an
   * administrator can rebuild the API from this row.
   */
  API_GATEWAY_REPAIR_REQUIRED: 'api.gateway_repair_required',
  TEST_CONSUMER_CREATE: 'test_consumer.create',

  /* access workflow */
  ACCESS_REQUEST: 'access.request',
  ACCESS_CANCEL: 'access.cancel',
  ACCESS_APPROVE: 'access.approve',
  /** An approval that failed after the gateway write; records what was undone. */
  ACCESS_APPROVE_ROLLBACK: 'access.approve_rollback',
  ACCESS_DENY: 'access.deny',
  ACCESS_REVOKE: 'access.revoke',
  /** A revocation the gateway refused; records whether the grant went back. */
  ACCESS_REVOKE_ROLLBACK: 'access.revoke_rollback',

  /* credentials */
  CREDENTIAL_ISSUE: 'credential.issue',
  CREDENTIAL_ROTATE: 'credential.rotate',
  CREDENTIAL_REVOKE: 'credential.revoke',

  /* messaging & notifications */
  MESSAGE_THREAD_CREATE: 'message.thread_create',
  MESSAGE_SEND: 'message.send',
  NOTIFICATION_READ: 'notification.read',

  /* admin */
  ADMIN_SETTINGS_UPDATE: 'admin.settings_update',
  ADMIN_TEMPLATE_UPDATE: 'admin.template_update',
  ADMIN_MASS_EMAIL: 'admin.mass_email',
  ADMIN_SMTP_TEST: 'admin.smtp_test',

  /* god mode (super_admin only) */
  GOD_REVOKE_GRANT: 'god.revoke_grant',
  GOD_DELETE_API: 'god.delete_api',
  GOD_DISABLE_USER: 'god.disable_user',
  GOD_BROADCAST: 'god.broadcast',
} as const;

/** Union of every audit action string. */
export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

/** Every action as an array — useful for filter validation and docs generation. */
export const ALL_AUDIT_ACTIONS = Object.values(AuditAction) as readonly AuditActionName[];

/** Who performed the action. `null` for anonymous events (failed logins, registration). */
export interface AuditActor {
  id: Uuid | null;
  role: Role | null;
}

/** The thing the action happened to. */
export interface AuditTarget {
  type: string;
  id: string | null;
}

/** Audit recording and querying. */
export interface AuditService {
  /**
   * Append one audit row. Never throws for a caller-supplied detail problem —
   * `details` is JSON-serialised as given, so keep secrets out of it.
   */
  record(
    actor: AuditActor,
    action: AuditActionName | string,
    target: AuditTarget,
    details?: Record<string, unknown>,
    ip?: string | null,
  ): Promise<AuditLog>;
  /** Newest-first page with actor/action/target/time filters. */
  list(filter: AuditLogFilter, options?: ListOptions): Promise<Paginated<AuditLog>>;
  /** Count matching rows without fetching a page. */
  count(filter: AuditLogFilter): Promise<number>;
  /**
   * The same service bound to another store — in practice the
   * transaction-scoped one handed to a `store.transaction` body.
   *
   * Use it whenever the audit row must commit or roll back with the mutation it
   * describes, so a half-applied change cannot leave a trail claiming it
   * happened (or, worse, leave no trail at all). Outside a transaction body
   * there is no reason to call this.
   */
  forStore(store: NexusStore): AuditService;
}

/** Anonymous actor, for events that happen before a session exists. */
export const ANONYMOUS_ACTOR: AuditActor = { id: null, role: null };

/**
 * Actor for rows a background worker writes with no request behind them.
 *
 * Shaped like {@link ANONYMOUS_ACTOR} because the columns are the same — the
 * audit trail has no third party to name — but spelled separately so a reader
 * of the call site can tell "nobody was signed in yet" apart from "Nexus itself
 * did this".
 */
export const SYSTEM_ACTOR: AuditActor = { id: null, role: null };

/** Build the audit service. */
export function createAuditService(store: NexusStore): AuditService {
  const service: AuditService = {
    async record(actor, action, target, details = {}, ip = null) {
      return store.auditLogs.create({
        actor_user_id: actor.id,
        actor_role: actor.role,
        action,
        target_type: target.type,
        target_id: target.id,
        details,
        ip,
      });
    },

    async list(filter, options) {
      return store.auditLogs.list(filter, options);
    },

    async count(filter) {
      return store.auditLogs.count(filter);
    },

    forStore(scoped) {
      return scoped === store ? service : createAuditService(scoped);
    },
  };
  return service;
}
