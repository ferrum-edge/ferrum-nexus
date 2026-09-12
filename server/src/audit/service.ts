/**
 * Audit service — the only writer of `audit_logs`.
 *
 * Every state-changing endpoint must record one row per event here. Actions are
 * dot-namespaced strings drawn from {@link AuditAction}; adding a new one means
 * appending to that catalog **and** to the table in `docs/security.md`.
 */

import type { AuditLog, Paginated, Role, Uuid } from '@ferrum-nexus/shared';

import type { AuditLogFilter, AuditLogRecord, ListOptions, NexusStore } from '../db/store.js';

/**
 * Catalog of every audit action Nexus emits.
 *
 * Naming: `<domain>.<verb>`, lowercase, snake_case verbs. God-mode actions are
 * namespaced `god.*` so they can be filtered out of ordinary reporting.
 */
export const AuditAction = {
  /** Startup created the namespace-global request metrics prerequisite. */
  GATEWAY_METRICS_ENABLE: 'gateway.metrics_enable',
  /**
   * An administrator ran the gateway-reference reconciliation pass on demand.
   *
   * A read-only action, recorded because it is the entry in the trail that
   * dates a retarget: the row says when somebody last established whether the
   * gateway still holds the consumer and proxy ids the portal stored.
   */
  GATEWAY_RECONCILE: 'gateway.reconcile',
  /**
   * A super admin recreated an account's missing gateway consumer and re-linked
   * the portal row.
   *
   * The details carry the credential rows revoked with it — their show-once
   * material died with the old consumer and **nothing is minted here**, so the
   * count is the number of credentials the account holder has to re-issue.
   */
  GATEWAY_CONSUMER_REPAIR: 'gateway.consumer_repair',
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
  USER_ENABLE: 'user.enable',
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
   *
   * `phase: 'orphaned_proxy'` is the same state reached from the other
   * direction: the gateway was retargeted or rebuilt, the stored
   * `ferrum_proxy_id` answers `404`, and the reconciliation repair cleared it
   * so the API reads as having no proxy — which is the state the rest of the
   * portal already models — and can be republished through the ordinary flow.
   */
  API_GATEWAY_REPAIR_REQUIRED: 'api.gateway_repair_required',
  /**
   * A publish that reached the gateway and then failed; records whether the
   * proxy it created came back off again.
   *
   * The proxy id is minted by Nexus and recorded before the create is
   * dispatched, so the compensating `DELETE` has a target even when the
   * create's acknowledgement never arrives. `withdrawn: false` means that
   * `DELETE` did not confirm, and `stranded_proxy_id` names a proxy that may
   * still be live on its unguessable staging path with no plugin attached and
   * no `apis` row — the only record that it exists.
   */
  API_PUBLISH_ROLLBACK: 'api.publish_rollback',
  /**
   * An `auth_plugin` change went through on a live API, summarising what it
   * disrupted.
   *
   * The companion to the `api.update` row: how many grantee accounts lost
   * access to this API until they issue a credential of the new flavour (their
   * own credentials are left alone — they serve other APIs), and how many of
   * the API's **own** credentials, on its `nexus-test-<api_id>` consumer, were
   * revoked because the change really did make them useless. Each of those
   * revocations also writes its own `credential.revoke` row; `failed` names the
   * ones the gateway would not let go of.
   */
  API_AUTH_PLUGIN_CHANGED: 'api.auth_plugin_changed',
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
  /**
   * A retirement Edge applied but the portal never recorded, settled by a
   * later call on the same consumer and type.
   *
   * The row was moved to `retiring` before the gateway delete and the delete's
   * acknowledgement never landed — or the write that follows it failed — so
   * the mirror was one row longer than the array. The next operation settles
   * it instead of refusing, and this is the row that says it happened.
   */
  CREDENTIAL_SETTLE: 'credential.settle',
  /**
   * An append this portal made had to be taken back; records whether it went.
   *
   * Written whenever an issue or a rotation fails *after* Edge accepted the
   * new entry — including when the acceptance itself was never acknowledged,
   * where `suspected: true` says the orphan could not be confirmed.
   * `withdrawn: false` means the entry is still on the gateway — either the
   * compensating delete failed, or the array no longer looked the way the
   * append left it (and `basicauth` never looks like anything, so it is never
   * deleted by index) — and `stranded_credential_id` names what to clean up,
   * with `last4` and `append_index` naming the entry itself. A rotation whose
   * confirmed delete could not be recorded writes one too, carrying
   * `retired_credential_id`: the row it left `retiring` for a later call.
   */
  CREDENTIAL_APPEND_ROLLBACK: 'credential.append_rollback',
  /**
   * An admin emptied one credential type on a gateway consumer and revoked its
   * portal rows — the repair for positions that can no longer be trusted.
   */
  CREDENTIAL_RECONCILE: 'credential.reconcile',

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
  /**
   * Written **before** the first recipient is touched, which is what makes it
   * the broadcast's countable record: `NEXUS_MAX_BROADCASTS_PER_DAY` counts
   * exactly these rows, so an attempt whose fan-out or completion record later
   * fails is still charged and still named in the trail. `details.phase` is
   * `started`; what actually got delivered is {@link GOD_BROADCAST_COMPLETE}.
   */
  GOD_BROADCAST: 'god.broadcast',
  /**
   * The outcome of a broadcast whose {@link GOD_BROADCAST} row already exists —
   * `delivered`, `failed` and the notification/thread/email counts. Deliberately
   * a second action rather than a second `god.broadcast` row: the daily ceiling
   * counts `god.broadcast`, and it must be exactly one row per attempt.
   */
  GOD_BROADCAST_COMPLETE: 'god.broadcast_complete',
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
  ): Promise<AuditLogRecord>;
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

/** Compare every adapter's stored millisecond UTC timestamps with the same format. */
function normalizeFilter(filter: AuditLogFilter): AuditLogFilter {
  return {
    ...filter,
    ...(filter.from !== undefined ? { from: new Date(filter.from).toISOString() } : {}),
    ...(filter.to !== undefined ? { to: new Date(filter.to).toISOString() } : {}),
  };
}

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
      const page = await store.auditLogs.list(normalizeFilter(filter), options);
      const ids = [
        ...new Set(page.items.flatMap((row) => (row.actor_user_id ? [row.actor_user_id] : []))),
      ];
      const users = new Map(
        (await store.users.findManyByIds(ids)).map(({ id, email, display_name, role }) => [
          id,
          { id, email, display_name, role },
        ]),
      );
      return {
        ...page,
        items: page.items.map((row) => ({
          ...row,
          actor: row.actor_user_id ? (users.get(row.actor_user_id) ?? null) : null,
        })),
      };
    },

    async count(filter) {
      return store.auditLogs.count(normalizeFilter(filter));
    },

    forStore(scoped) {
      return scoped === store ? service : createAuditService(scoped);
    },
  };
  return service;
}
