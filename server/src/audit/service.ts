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
   * The gateway revocation a disable queued has landed. Written by the teardown
   * worker as the system ({@link SYSTEM_ACTOR}), or by the administrator's own
   * request when its immediate attempt succeeded — `details.inline: true`. The
   * disable itself is recorded before either, in the transaction that queued
   * the revocation, so this row is the outcome and never the only trace.
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
  /**
   * A retained revision was redeployed as a **new** revision of the same API.
   *
   * The same action the gateway sees as an ordinary spec revision — it goes
   * through the same publishing path — named separately so the log can say
   * which of the two happened. `details` adds `restored_from_spec_id`,
   * `restored_from_version` and `restored_from_created_at` naming the revision
   * that was put back; the new revision's own id is `spec_id`, because history
   * is never rewritten.
   */
  API_SPEC_ROLLBACK: 'api.spec_rollback',
  API_RETIRE: 'api.retire',
  /**
   * An API delete is about to take the API's Edge objects down. Committed
   * before the first gateway call, so a teardown whose completion could not be
   * recorded still leaves a row naming who started it; {@link API_DELETE}
   * follows in the transaction that removes the rows.
   */
  API_DELETE_START: 'api.delete_start',
  API_DELETE: 'api.delete',
  /** A palette plugin was created or replaced on an API's proxy. */
  API_PLUGIN_SET: 'api.plugin_set',
  /**
   * A palette plugin removal is about to delete the plugin's gateway config.
   * The counterpart of {@link API_DELETE_START}: committed before the gateway
   * is touched, with {@link API_PLUGIN_REMOVE} written in the transaction that
   * drops the `api_plugins` row.
   */
  API_PLUGIN_REMOVE_START: 'api.plugin_remove_start',
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
   * portal already models. The API is also left `gateway_state:
   * 'repair_required'` until {@link AuditAction.API_GATEWAY_RESTORE} rebuilds
   * its deployment.
   */
  API_GATEWAY_REPAIR_REQUIRED: 'api.gateway_repair_required',
  /**
   * An existing API's gateway deployment was rebuilt in place: same id, slug,
   * owner, specification history, gateway URL and grants, new Edge proxy.
   *
   * `rebuilt: false` records the other way this clears — the proxy turned out
   * to be live after all (an operator rebuilt it by hand), so the flag was
   * dropped without touching the gateway.
   */
  /**
   * A provider authorized one account to **read** a private API's
   * documentation.
   *
   * `details.grants_invocation` is always `false`, spelled out on every row
   * rather than left to be inferred: this authorization confers no ACL group,
   * touches no Ferrum consumer and reaches no gateway. Somebody reading the
   * log a year from now should not have to go and check.
   */
  /**
   * An application identity was created. `details` names it; the target is the
   * application.
   */
  APPLICATION_CREATE: 'application.create',
  /**
   * An application was renamed, re-described, disabled or re-enabled.
   *
   * On a disable, `details.revoked_existing_access` is always `false`:
   * disabling refuses *new* requests, approvals and credentials and revokes
   * nothing that already exists. An integration that must stop working is
   * deleted, or has its grants revoked — and an operator reading this row
   * should not have to guess which happened.
   */
  APPLICATION_UPDATE: 'application.update',
  /**
   * An application and its gateway identity were deleted. `details` carries
   * the consumer that came down and the counts of grants and credentials the
   * cascade removed with it.
   */
  APPLICATION_DELETE: 'application.delete',
  /**
   * An application delete is about to take the application's gateway identity
   * down. The counterpart of {@link API_DELETE_START}: committed before the
   * gateway is touched, with {@link APPLICATION_DELETE} written in the
   * transaction that removes the rows.
   */
  APPLICATION_DELETE_START: 'application.delete_start',
  API_VIEWER_AUTHORIZE: 'api.viewer_authorize',
  /**
   * A read authorization was withdrawn. `details.revoked_grant` is always
   * `false` for the same reason: read access and invocation access are
   * separate, and removing one has never touched the other.
   */
  API_VIEWER_REVOKE: 'api.viewer_revoke',
  API_GATEWAY_RESTORE: 'api.gateway_restore',
  /**
   * A restore that reached the gateway and then failed. Reads like
   * {@link AuditAction.API_PUBLISH_ROLLBACK}: `withdrawn: false` means the
   * compensating `DELETE` could not confirm and `stranded_proxy_id` names a
   * proxy that may still be live on its staging path. The API stays
   * `repair_required`, so the condition is still visible and a retry is safe.
   */
  API_GATEWAY_RESTORE_FAILED: 'api.gateway_restore_failed',
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
  /**
   * A revocation is about to delete one credential entry from the gateway.
   * Committed with the row's move to `retiring`, before the delete, so a
   * revocation whose completion could not be recorded still leaves a row
   * naming who started it; {@link CREDENTIAL_REVOKE} follows in the
   * transaction that marks the row `revoked`.
   */
  CREDENTIAL_REVOKE_START: 'credential.revoke_start',
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
   * What a god-mode disable achieved after the disable itself committed — the
   * grant sweep, the immediate gateway revocation and any step that failed.
   * The {@link GOD_DISABLE_USER} row is written with the disable, before any of
   * it, so this row is the outcome rather than the record that it happened.
   */
  GOD_DISABLE_USER_COMPLETE: 'god.disable_user_complete',
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

/**
 * How an audit row commits relative to the change it describes.
 *
 * - `transactional` — written through `audit.forStore(tx)` inside the
 *   `store.transaction` that makes the change, so a failed insert rolls the
 *   change back with it instead of leaving it applied and unaudited behind a
 *   `500` (and a repeat of the request then finding nothing left to do and
 *   recording nothing either). `rowOnly`, when present, says why some call
 *   site legitimately commits the row without a store write of its own.
 * - `intent` — written through `audit.forStore(tx)` in a transaction of its
 *   own, committed **before** gateway work that cannot be rolled back, so a
 *   failure to record what followed still leaves a row naming who started it,
 *   and a failure to record *this* stops the operation before anything
 *   changed.
 * - `post_commit` — written after the fact, deliberately; `reason` says why.
 */
export type AuditCommitClass =
  | { readonly kind: 'transactional'; readonly rowOnly?: string }
  | { readonly kind: 'intent' }
  | { readonly kind: 'post_commit'; readonly reason: string };

const TRANSACTIONAL: AuditCommitClass = { kind: 'transactional' };
const INTENT: AuditCommitClass = { kind: 'intent' };

function rowOnly(reason: string): AuditCommitClass {
  return { kind: 'transactional', rowOnly: reason };
}

function postCommit(reason: string): AuditCommitClass {
  return { kind: 'post_commit', reason };
}

/** Why a compensation trail is written best-effort, after the fact. */
const COMPENSATION_TRAIL =
  'A compensation trail, written while the failure it describes is already being raised: ' +
  'it is best-effort so that the original error, not an audit failure, reaches the caller.';

/** Why a revision or restore row still follows the commit. */
const LIVE_DEPLOYMENT_FOLLOW_UP =
  'Not yet moved into its transaction: the deployment is written under the proxy lease ' +
  'inside its own compensated block, and the row follows once both sides agree. A failed ' +
  'insert leaves the change live and unaudited; tracked as a follow-up to #389.';

/**
 * Every audit action, classified. Deny by default: the mapped type makes an
 * unclassified action a compile error, and `transactional-audit.test.ts` scans
 * the server source and fails when a `transactional` or `intent` action is
 * recorded any other way — outside a transaction callback, through the root
 * service, without an `await`, behind a `.catch` or a `try` that swallows the
 * failure, or (for `transactional`) in a callback that writes nothing else.
 */
export const AUDIT_COMMIT_CLASSES: { readonly [A in AuditActionName]: AuditCommitClass } = {
  [AuditAction.GATEWAY_METRICS_ENABLE]: postCommit(
    'Startup writes one namespace-global config to the gateway and nothing to the portal ' +
      'store, so there is no local change for the row to commit with; the write is logged ' +
      'before the row is attempted.',
  ),
  [AuditAction.GATEWAY_RECONCILE]: postCommit(
    'Read-only: the pass changes nothing, so there is no change to commit or roll back with.',
  ),
  [AuditAction.GATEWAY_CONSUMER_REPAIR]: TRANSACTIONAL,
  [AuditAction.AUTH_REGISTER]: TRANSACTIONAL,
  [AuditAction.AUTH_LOGIN]: postCommit(
    'An authentication event, not a change of authority: the session it opens is the ' +
      "caller's own, proven by their password, and a missing row grants nothing.",
  ),
  [AuditAction.AUTH_LOGOUT]: postCommit(
    "Ends the caller's own session, which only ever removes access.",
  ),
  [AuditAction.AUTH_VERIFY_EMAIL]: TRANSACTIONAL,
  [AuditAction.AUTH_VERIFICATION_RESEND]: TRANSACTIONAL,
  [AuditAction.AUTH_PASSWORD_RESET_REQUEST]: TRANSACTIONAL,
  [AuditAction.AUTH_PASSWORD_RESET]: TRANSACTIONAL,
  [AuditAction.USER_UPDATE]: TRANSACTIONAL,
  [AuditAction.USER_ROLE_CHANGE]: TRANSACTIONAL,
  [AuditAction.USER_DISABLE]: TRANSACTIONAL,
  [AuditAction.USER_ENABLE]: rowOnly(
    'Re-enabling an account that is already active changes no row: it only re-runs the ' +
      'gateway restore, so its row commits on its own before the gateway is touched.',
  ),
  [AuditAction.USER_GATEWAY_TEARDOWN_COMPLETE]: postCommit(
    'The outcome of gateway work that runs after a committed disable and cannot be rolled ' +
      'back; the disable itself is recorded in its transaction.',
  ),
  [AuditAction.USER_GATEWAY_TEARDOWN_RETRY]: TRANSACTIONAL,
  [AuditAction.ORG_CREATE]: TRANSACTIONAL,
  [AuditAction.ORG_UPDATE]: TRANSACTIONAL,
  [AuditAction.API_PUBLISH]: TRANSACTIONAL,
  [AuditAction.API_UPDATE]: rowOnly(
    'A patch that changed no portal field but repaired gateway drift has no row to write; ' +
      'its record commits alone inside the compensated block, so a failed insert undoes the ' +
      'repair.',
  ),
  [AuditAction.API_SPEC_UPDATE]: postCommit(LIVE_DEPLOYMENT_FOLLOW_UP),
  [AuditAction.API_SPEC_ROLLBACK]: postCommit(LIVE_DEPLOYMENT_FOLLOW_UP),
  [AuditAction.API_RETIRE]: TRANSACTIONAL,
  [AuditAction.API_DELETE_START]: INTENT,
  [AuditAction.API_DELETE]: TRANSACTIONAL,
  [AuditAction.API_PLUGIN_SET]: TRANSACTIONAL,
  [AuditAction.API_PLUGIN_REMOVE_START]: INTENT,
  [AuditAction.API_PLUGIN_REMOVE]: TRANSACTIONAL,
  [AuditAction.API_GATEWAY_REPAIR_REQUIRED]: postCommit(
    `${COMPENSATION_TRAIL} The reconciliation flag, which is a change of its own, records ` +
      'it in its transaction.',
  ),
  [AuditAction.APPLICATION_CREATE]: TRANSACTIONAL,
  [AuditAction.APPLICATION_UPDATE]: TRANSACTIONAL,
  [AuditAction.APPLICATION_DELETE]: TRANSACTIONAL,
  [AuditAction.APPLICATION_DELETE_START]: INTENT,
  [AuditAction.API_VIEWER_AUTHORIZE]: TRANSACTIONAL,
  [AuditAction.API_VIEWER_REVOKE]: TRANSACTIONAL,
  [AuditAction.API_GATEWAY_RESTORE]: postCommit(LIVE_DEPLOYMENT_FOLLOW_UP),
  [AuditAction.API_GATEWAY_RESTORE_FAILED]: postCommit(COMPENSATION_TRAIL),
  [AuditAction.API_PUBLISH_ROLLBACK]: postCommit(COMPENSATION_TRAIL),
  [AuditAction.API_AUTH_PLUGIN_CHANGED]: postCommit(
    'A summary of the best-effort revocations that follow a committed auth_plugin swap. The ' +
      'swap is recorded by api.update in its transaction, and each revocation by its own ' +
      'credential.revoke.',
  ),
  [AuditAction.TEST_CONSUMER_CREATE]: rowOnly(
    "The creation's writes are spread over the gateway and the store under one " +
      'compensation; the row commits alone at the end of that block, so a failed insert ' +
      'takes the new consumer back down.',
  ),
  [AuditAction.ACCESS_REQUEST]: TRANSACTIONAL,
  [AuditAction.ACCESS_CANCEL]: TRANSACTIONAL,
  [AuditAction.ACCESS_APPROVE]: TRANSACTIONAL,
  [AuditAction.ACCESS_APPROVE_ROLLBACK]: postCommit(COMPENSATION_TRAIL),
  [AuditAction.ACCESS_DENY]: TRANSACTIONAL,
  [AuditAction.ACCESS_REVOKE]: TRANSACTIONAL,
  [AuditAction.ACCESS_REVOKE_ROLLBACK]: postCommit(COMPENSATION_TRAIL),
  [AuditAction.CREDENTIAL_ISSUE]: TRANSACTIONAL,
  [AuditAction.CREDENTIAL_ROTATE]: TRANSACTIONAL,
  [AuditAction.CREDENTIAL_REVOKE_START]: INTENT,
  [AuditAction.CREDENTIAL_REVOKE]: TRANSACTIONAL,
  [AuditAction.CREDENTIAL_SETTLE]: TRANSACTIONAL,
  [AuditAction.CREDENTIAL_APPEND_ROLLBACK]: postCommit(COMPENSATION_TRAIL),
  [AuditAction.CREDENTIAL_RECONCILE]: TRANSACTIONAL,
  [AuditAction.MESSAGE_THREAD_CREATE]: TRANSACTIONAL,
  [AuditAction.MESSAGE_SEND]: TRANSACTIONAL,
  [AuditAction.NOTIFICATION_READ]: postCommit(
    "Marks the caller's own notifications read; no authority, access or shared state changes.",
  ),
  [AuditAction.ADMIN_SETTINGS_UPDATE]: TRANSACTIONAL,
  [AuditAction.ADMIN_TEMPLATE_UPDATE]: TRANSACTIONAL,
  [AuditAction.ADMIN_MASS_EMAIL]: TRANSACTIONAL,
  [AuditAction.ADMIN_SMTP_TEST]: postCommit(
    'Sends one test message straight through SMTP and changes no stored state.',
  ),
  [AuditAction.GOD_REVOKE_GRANT]: TRANSACTIONAL,
  [AuditAction.GOD_DELETE_API]: TRANSACTIONAL,
  [AuditAction.GOD_DISABLE_USER]: TRANSACTIONAL,
  [AuditAction.GOD_DISABLE_USER_COMPLETE]: postCommit(
    'The outcome of the steps that run after a committed god-mode disable; the disable ' +
      'itself is recorded in its transaction.',
  ),
  [AuditAction.GOD_BROADCAST]: INTENT,
  [AuditAction.GOD_BROADCAST_COMPLETE]: postCommit(
    'The outcome of a fan-out whose attempt god.broadcast already recorded; failing the ' +
      'request after delivery would invite a second broadcast.',
  ),
};

/**
 * Actions that must be written through `audit.forStore(tx)` inside a
 * `store.transaction` — every `transactional` and `intent` entry of
 * {@link AUDIT_COMMIT_CLASSES}.
 */
export const TRANSACTIONAL_AUDIT_ACTIONS: readonly AuditActionName[] = ALL_AUDIT_ACTIONS.filter(
  (action) => AUDIT_COMMIT_CLASSES[action].kind !== 'post_commit',
);

/**
 * The details of the earliest earlier attempt of an operation that commits an
 * `intent` row per attempt, among those that recorded `key` — `rows` being that
 * action's rows for one target, newest first, as the store lists them, and
 * `currentId` this attempt's own row.
 *
 * A deletion whose gateway teardown landed but whose completion could not be
 * recorded is repeated, and the repeat finds the gateway identity already gone.
 * This is what lets its completion row still say what was collected: the
 * earliest attempt saw the identity before any teardown touched it.
 */
export function earliestPriorAttempt(
  rows: readonly AuditLogRecord[],
  currentId: string,
  key: string,
): Record<string, unknown> | null {
  let earliest: Record<string, unknown> | null = null;
  for (const row of rows) {
    const value = row.details[key];
    if (row.id !== currentId && value !== null && value !== undefined) earliest = row.details;
  }
  return earliest;
}

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
