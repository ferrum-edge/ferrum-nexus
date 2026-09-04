/**
 * `NexusStore` — the complete persistence contract for Ferrum Nexus.
 *
 * **This file is the contract between the service layer and the four database
 * adapters (`sqlite`, `postgres`, `mysql`, `mongodb`).** Nothing outside
 * `db/adapters/` may import a driver package; every query lives behind one of
 * the repositories below. Adding a query means adding it here first and then
 * implementing it in all four adapters.
 *
 * ## Representation rules (identical in every adapter)
 *
 * - **Ids** are string UUIDs. `create()` generates one when the caller does not
 *   supply it, so an id can be pinned when it must match an external system
 *   (e.g. reusing the Nexus user id as the Ferrum consumer id).
 * - **Timestamps** are ISO-8601 strings (`2026-08-31T12:00:00.000Z`), never
 *   `Date` objects and never epoch numbers. `created_at`/`updated_at` are
 *   adapter-managed; `updated_at` is refreshed on every successful update.
 * - **Booleans are real booleans** at this boundary. SQL adapters store 0/1 and
 *   convert on the way in and out; Mongo stores them natively.
 * - **Structured columns are parsed values**, not JSON text: `rate_limit`,
 *   `details`, and setting `value` cross this interface as objects. SQL
 *   adapters serialise them into their `*_json` columns.
 * - **Email addresses are matched case-insensitively.** `users.create` and
 *   `users.findByEmail` lowercase before touching storage.
 * - Every `find*` returns `null` when nothing matches; `update` returns `null`
 *   when the row does not exist; `delete` returns `false` in that case.
 * - Every `list` takes filters plus `{ limit, offset }` and returns
 *   `{ items, total }` where `total` ignores pagination. Adapters clamp
 *   `limit` with `clampPageSize` and treat a negative `offset` as `0`.
 * - Uniqueness violations surface as `NexusError('CONFLICT', …)`, never as a
 *   driver-specific error.
 *
 * ## Transaction semantics
 *
 * `transaction(fn)` runs `fn` with a store scoped to a single transaction and
 * commits when the promise resolves, rolling back when it rejects. The scoped
 * store exposes the same repositories; calling `transaction` on it again joins
 * the existing transaction rather than nesting a new one.
 *
 * The sqlite adapter is synchronous under the hood (better-sqlite3), so it
 * cannot suspend a real `BEGIN`/`COMMIT` across an `await`. It instead
 * serialises transaction bodies through a **per-connection promise queue**:
 * only one `transaction(fn)` body runs at a time, it issues `BEGIN` before
 * `fn` and `COMMIT`/`ROLLBACK` after it settles, and because the process is
 * single-threaded no other statement can interleave as long as *all* writes go
 * through this store. Other adapters use their driver's native transaction
 * (a `pg` client checkout, a mysql2 connection, a Mongo session) and should
 * keep the same observable behaviour: serialised bodies, atomic commit,
 * rollback on throw.
 */

import type {
  AccessRequest,
  AccessRequestStatus,
  Api,
  ApiPlugin,
  ApiPluginTrigger,
  ApiSpec,
  ApiStatus,
  ApiVisibility,
  AuditLog,
  Consumer,
  CredentialMetadata,
  CredentialStatus,
  CredentialType,
  DbDriver,
  EmailOutboxEntry,
  EmailTemplate,
  EmailTemplateKey,
  GatewayTeardownJobStatus,
  GatewayTeardownState,
  Grant,
  GrantStatus,
  IsoTimestamp,
  Message,
  MessageThread,
  Notification,
  NotificationType,
  Organization,
  Paginated,
  Role,
  SpecEnforcementLevel,
  User,
  UserStatus,
  Uuid,
} from '@ferrum-nexus/shared';

/* ── Generic helpers ────────────────────────────────────────────────────── */

/** Pagination accepted by every `list` method. */
export interface ListOptions {
  /** Page size; clamped to `[1, MAX_PAGE_SIZE]`, defaults to `DEFAULT_PAGE_SIZE`. */
  limit?: number;
  /** Zero-based row offset; negatives are treated as `0`. */
  offset?: number;
}

/** Keys of `T` whose type admits `null` — these default to `null` on create. */
type NullableKeys<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T];

/**
 * Creation payload: everything except the adapter-managed identity/timestamp
 * columns, each of which may still be supplied to pin a value.
 *
 * Nullable columns are optional and default to `null`, so callers only spell
 * out the fields they actually set.
 */
export type CreateInput<T> = Omit<T, 'id' | 'created_at' | 'updated_at' | NullableKeys<T>> &
  Partial<Pick<T, Extract<NullableKeys<T>, keyof T>>> & {
    id?: Uuid;
    created_at?: IsoTimestamp;
    updated_at?: IsoTimestamp;
  };

/** Update payload: any subset of the mutable columns. `updated_at` is set by the adapter. */
export type UpdateInput<T> = Partial<Omit<T, 'id' | 'created_at' | 'updated_at'>>;

/* ── Stored record shapes ───────────────────────────────────────────────── */

/**
 * A `users` row. Identical to the wire {@link User} plus the password hash,
 * which never leaves the server.
 */
export interface UserRecord extends User {
  /** `scrypt:N:r:p:salt:hash` — see `lib/crypto.ts`. */
  password_hash: string;
}

/** An `organizations` row. */
export type OrganizationRecord = Organization;

/** A `sessions` row. The plaintext token exists only in the browser cookie. */
export interface SessionRecord {
  id: Uuid;
  /** HMAC-SHA-256 of the session token (`NexusCrypto.hashToken`). Unique. */
  token_hash: string;
  user_id: Uuid;
  /** Double-submit CSRF token; the browser echoes it in `X-Nexus-CSRF`. */
  csrf_token: string;
  expires_at: IsoTimestamp;
  ip: string | null;
  user_agent: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/**
 * An `apis` row.
 *
 * `listen_path` and `invoke_url` are on the wire {@link Api} but not here:
 * both are derived at presentation time from the namespace, the slug and the
 * operator's gateway origin (see `publishing/present.ts`). Storing them would
 * leave every row stale the moment the gateway moves.
 */
export type ApiRecord = Omit<Api, 'listen_path' | 'invoke_url'>;

/** An `api_specs` row, including the raw uploaded document. */
export type ApiSpecRecord = ApiSpec;

/**
 * An `api_plugins` row — one palette plugin as the provider configured it.
 *
 * The wire {@link ApiPlugin} carries no ids because the route addresses a
 * plugin by `(api, plugin_name)`; the row needs both, plus the API it belongs
 * to. The Ferrum plugin config id is deliberately absent: like `rate_limiting`
 * and `cors`, the gateway object is found by `proxy_id` + `plugin_name`, so an
 * operator who recreates one by hand reconciles automatically.
 */
export interface ApiPluginRecord extends ApiPlugin {
  id: Uuid;
  api_id: Uuid;
}

/** An `access_requests` row (without the denormalised joins the API adds). */
export type AccessRequestRecord = Omit<AccessRequest, 'api' | 'requester'>;

/** A `grants` row (without the denormalised joins the API adds). */
export type GrantRecord = Omit<Grant, 'api' | 'user'>;

/** A `credential_metadata` row. Plaintext material is never stored. */
export type CredentialRecord = CredentialMetadata;

/** A `consumers` row — the cached Nexus-user → Edge-consumer mapping. */
export type ConsumerRecord = Consumer;

/** A `message_threads` row (without joins/previews). */
export type ThreadRecord = Omit<MessageThread, 'api' | 'participants' | 'last_message_preview'>;

/** A `messages` row (without the joined sender). */
export type MessageRecord = Omit<Message, 'sender'>;

/** A `notifications` row. */
export type NotificationRecord = Notification;

/** An `email_outbox` row, including the rendered bodies the worker sends. */
export interface EmailOutboxRecord extends EmailOutboxEntry {
  body_html: string;
  body_text: string;
}

/**
 * A `gateway_teardown_jobs` row — one outstanding credential revocation.
 *
 * At most one row exists per user (`user_id` is unique), so the table is a
 * per-account state rather than a queue of duplicate work.
 */
export interface GatewayTeardownJobRecord extends GatewayTeardownState {
  id: Uuid;
  user_id: Uuid;
  /** The admin who disabled the account, or `null` once that account is gone. */
  requested_by: Uuid | null;
  created_at: IsoTimestamp;
}

/** An `audit_logs` row (append-only; without the joined actor summary). */
export type AuditLogRecord = Omit<AuditLog, 'actor'>;

/**
 * An `app_settings` row.
 *
 * The store is deliberately crypto-unaware: when `encrypted` is `true`, `value`
 * is the opaque `v1:iv:ciphertext:tag` string produced by
 * `NexusCrypto.encryptJson`, and the settings service is responsible for
 * encrypting before `set` and decrypting after `get`.
 */
export interface SettingRecord {
  key: string;
  value: unknown;
  encrypted: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/** An `email_templates` row. */
export type EmailTemplateRecord = EmailTemplate;

/**
 * What an `email_verification_tokens` row entitles its holder to do.
 *
 * The column exists so the two flows cannot borrow each other's tokens: a
 * 24-hour verification link must not be redeemable at `reset-password`, and a
 * reset link must not silently verify a mailbox at `verify-email`. Every lookup
 * takes the purpose it expects, so there is no way to forget the check.
 */
export type VerificationTokenPurpose = 'email_verification' | 'password_reset';

/** An `email_verification_tokens` row. */
export interface VerificationTokenRecord {
  id: Uuid;
  user_id: Uuid;
  /** HMAC-SHA-256 of the emailed token. Unique. */
  token_hash: string;
  /** Which flow issued the token; a token is only ever accepted by that flow. */
  purpose: VerificationTokenPurpose;
  expires_at: IsoTimestamp;
  /** Set the first time the token is redeemed; a used token is never accepted again. */
  used_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/* ── Filters ────────────────────────────────────────────────────────────── */

/** Filters for `users.list` / `users.count` / `users.listRecipients`. */
export interface UserFilter {
  role?: Role;
  /** Match any of these roles (used by mass-email audiences). */
  roles?: Role[];
  status?: UserStatus;
  org_id?: Uuid | null;
  /** Restrict to an explicit id set (explicit mass-email audience). */
  ids?: Uuid[];
  /** Case-insensitive substring match on email or display name. */
  q?: string;
  email_verified?: boolean;
}

/** Filters for `apis.list`. */
export interface ApiFilter {
  owner_user_id?: Uuid;
  status?: ApiStatus;
  visibility?: ApiVisibility;
  requestable?: boolean;
  /** Case-insensitive substring match on name, slug or description. */
  q?: string;
  ids?: Uuid[];
}

/** Filters for `apiSpecs.list`. */
export interface ApiSpecFilter {
  api_id?: Uuid;
  is_current?: boolean;
}

/** Filters for `accessRequests.list`. */
export interface AccessRequestFilter {
  user_id?: Uuid;
  api_id?: Uuid;
  /** Restrict to APIs owned by this provider (the reviewer inbox). */
  api_ids?: Uuid[];
  status?: AccessRequestStatus;
}

/** Filters for `grants.list`. */
export interface GrantFilter {
  user_id?: Uuid;
  api_id?: Uuid;
  api_ids?: Uuid[];
  status?: GrantStatus;
}

/** Filters for `credentials.list`. */
export interface CredentialFilter {
  user_id?: Uuid;
  status?: CredentialStatus;
  credential_type?: CredentialType;
  ferrum_consumer_id?: string;
}

/** Filters for `consumers.list`. */
export interface ConsumerFilter {
  user_id?: Uuid;
  namespace?: string;
}

/** Filters for `threads.list`. */
export interface ThreadFilter {
  /**
   * Threads where this user occupies a seat — `participant_a` or
   * `participant_b`.
   *
   * `created_by` is deliberately **not** a seat. It is immutable provenance,
   * not membership: a god-mode broadcast seats only the recipient, so counting
   * the creator would hand whoever sent it a permanent key to every
   * recipient's platform thread, surviving their own demotion. Admin oversight
   * comes from the caller's *current* role, never from this column.
   */
  participant_user_id?: Uuid;
  api_id?: Uuid;
  /** Case-insensitive substring match on the subject. */
  q?: string;
}

/** Filters for `notifications.list`. */
export interface NotificationFilter {
  user_id: Uuid;
  /** Only notifications with `read_at IS NULL`. */
  unread?: boolean;
  type?: NotificationType;
}

/** Filters for `emailOutbox.list`. */
export interface EmailOutboxFilter {
  status?: EmailOutboxEntry['status'];
  to_email?: string;
}

/** Filters for `gatewayTeardownJobs.list`. */
export interface GatewayTeardownJobFilter {
  status?: GatewayTeardownJobStatus;
}

/** Filters for `auditLogs.list`. */
export interface AuditLogFilter {
  actor_user_id?: Uuid;
  /** Exact action match, e.g. `access.approve`. */
  action?: string;
  /** Match any of these actions. */
  actions?: string[];
  target_type?: string;
  target_id?: string;
  /** Inclusive lower bound on `created_at`. */
  from?: IsoTimestamp;
  /** Exclusive upper bound on `created_at`. */
  to?: IsoTimestamp;
}

/* ── Repositories ───────────────────────────────────────────────────────── */

/** Portal accounts. */
export interface UserRepo {
  /** Insert a user. The email is lowercased; a duplicate raises `CONFLICT`. */
  create(input: CreateInput<UserRecord>): Promise<UserRecord>;
  findById(id: Uuid): Promise<UserRecord | null>;
  /** Case-insensitive lookup by email address. */
  findByEmail(email: string): Promise<UserRecord | null>;
  /** Batch lookup preserving no particular order; missing ids are simply absent. */
  findManyByIds(ids: Uuid[]): Promise<UserRecord[]>;
  /** Patch mutable columns. Returns `null` when the user does not exist. */
  update(id: Uuid, patch: UpdateInput<UserRecord>): Promise<UserRecord | null>;
  /**
   * Compare-and-set update: apply `patch` **only while the row still matches
   * every field of `expected`**, in one statement.
   *
   * Returns the updated row, or `null` when the user is gone or has already
   * moved on — the caller lost the race and must not treat its earlier read as
   * still true.
   *
   * This exists for the last-super-admin invariant, which is a check on *other*
   * rows followed by a write to this one. `countActiveSuperAdmins` and this
   * call belong inside the same {@link NexusStore.transaction} body: the
   * transaction makes the check-then-write atomic against another demotion, and
   * the predicate here makes the write refuse a target that changed underneath
   * it anyway.
   */
  updateIfMatches(
    id: Uuid,
    expected: { role?: Role; status?: UserStatus },
    patch: UpdateInput<UserRecord>,
  ): Promise<UserRecord | null>;
  /** Record a successful sign-in without rewriting the rest of the row. */
  touchLastLogin(id: Uuid, at: IsoTimestamp): Promise<void>;
  list(filter: UserFilter, options?: ListOptions): Promise<Paginated<UserRecord>>;
  count(filter?: UserFilter): Promise<number>;
  /**
   * Number of `super_admin` users with `status = 'active'`, optionally
   * excluding one id. Guards the "last super admin" rule.
   */
  countActiveSuperAdmins(excludeUserId?: Uuid): Promise<number>;
  /**
   * Unpaginated recipient list for mass email and broadcasts. Returns every
   * matching user, so callers must keep audiences bounded.
   */
  listRecipients(filter: UserFilter): Promise<UserRecord[]>;
}

/** Lightweight provider groupings. */
export interface OrganizationRepo {
  create(input: CreateInput<OrganizationRecord>): Promise<OrganizationRecord>;
  findById(id: Uuid): Promise<OrganizationRecord | null>;
  /** Case-insensitive lookup by name; names are unique. */
  findByName(name: string): Promise<OrganizationRecord | null>;
  update(id: Uuid, patch: UpdateInput<OrganizationRecord>): Promise<OrganizationRecord | null>;
  list(options?: ListOptions): Promise<Paginated<OrganizationRecord>>;
  /** Members keep their `org_id` unless the caller clears it first. */
  delete(id: Uuid): Promise<boolean>;
}

/** Browser sessions. */
export interface SessionRepo {
  create(input: CreateInput<SessionRecord>): Promise<SessionRecord>;
  /** Primary auth lookup: the hashed cookie value. */
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  findById(id: Uuid): Promise<SessionRecord | null>;
  /** Sliding expiration: push `expires_at` forward on an authenticated request. */
  touch(id: Uuid, expiresAt: IsoTimestamp): Promise<void>;
  delete(id: Uuid): Promise<boolean>;
  deleteByTokenHash(tokenHash: string): Promise<boolean>;
  /** Terminate every session of a user (logout-everywhere, disable, role change). */
  deleteForUser(userId: Uuid): Promise<number>;
  /** Housekeeping: drop sessions whose `expires_at` is at or before `now`. */
  deleteExpired(now: IsoTimestamp): Promise<number>;
}

/**
 * Creation payload for an API row.
 *
 * `circuit_breaker` and `spec_enforcement` are non-nullable, so
 * {@link CreateInput} would make them mandatory; they are optional here instead
 * because both columns carry a `DEFAULT` and their default *is* the common
 * case — no breaker, and an OpenAPI document that is catalog metadata only.
 */
export type CreateApiInput = Omit<
  CreateInput<ApiRecord>,
  'circuit_breaker' | 'spec_enforcement'
> & {
  /** Defaults to `false`, matching the column default. */
  circuit_breaker?: boolean;
  /** Defaults to `'docs_only'`, matching the column default. */
  spec_enforcement?: SpecEnforcementLevel;
};

/** Published APIs and their Edge proxies. */
export interface ApiRepo {
  create(input: CreateApiInput): Promise<ApiRecord>;
  findById(id: Uuid): Promise<ApiRecord | null>;
  /** Slugs are unique across the portal and form the gateway listen path. */
  findBySlug(slug: string): Promise<ApiRecord | null>;
  /** Reverse lookup used when reconciling against Edge. */
  findByProxyId(ferrumProxyId: string): Promise<ApiRecord | null>;
  findManyByIds(ids: Uuid[]): Promise<ApiRecord[]>;
  update(id: Uuid, patch: UpdateInput<ApiRecord>): Promise<ApiRecord | null>;
  list(filter: ApiFilter, options?: ListOptions): Promise<Paginated<ApiRecord>>;
  count(filter?: ApiFilter): Promise<number>;
  /** Ids of every API owned by a provider — feeds the reviewer inbox filters. */
  listIdsByOwner(ownerUserId: Uuid): Promise<Uuid[]>;
  /** Removes the API row only; specs/requests/grants are cascaded by the caller's transaction. */
  delete(id: Uuid): Promise<boolean>;
}

/** Uploaded OpenAPI documents, one row per revision. */
export interface ApiSpecRepo {
  create(input: CreateInput<ApiSpecRecord>): Promise<ApiSpecRecord>;
  findById(id: Uuid): Promise<ApiSpecRecord | null>;
  /** The revision with `is_current = true` for an API, if any. */
  findCurrentByApi(apiId: Uuid): Promise<ApiSpecRecord | null>;
  /** Make one revision current and clear the flag on every other revision of the API. */
  setCurrent(apiId: Uuid, specId: Uuid): Promise<void>;
  list(filter: ApiSpecFilter, options?: ListOptions): Promise<Paginated<ApiSpecRecord>>;
  delete(id: Uuid): Promise<boolean>;
  /** Cascade helper for API deletion. Returns the number of revisions removed. */
  deleteByApi(apiId: Uuid): Promise<number>;
}

/**
 * Palette plugins a provider switched on for their own API.
 *
 * There is no `list`/`count` pair here on purpose: the palette is small and
 * always read whole for one API, so the repo offers `listByApi` rather than the
 * filter+pagination shape the browsable collections use.
 */
export interface ApiPluginRepo {
  /** Every configured plugin for one API, oldest first. */
  listByApi(apiId: Uuid): Promise<ApiPluginRecord[]>;
  /** One plugin by its `(api, plugin_name)` key. */
  find(apiId: Uuid, pluginName: string): Promise<ApiPluginRecord | null>;
  /**
   * Create or replace the row for `(api_id, plugin_name)` in one statement.
   *
   * Upsert rather than create+update because the pair is unique and the route
   * is a `PUT`: two tabs saving the same plugin must converge on one row rather
   * than raise `CONFLICT` at whichever of them lost the race.
   * `created_at` is preserved on a replace; `updated_at` always moves.
   */
  upsert(input: UpsertApiPluginInput): Promise<ApiPluginRecord>;
  /** Returns `false` when the API had no row for that plugin. */
  delete(apiId: Uuid, pluginName: string): Promise<boolean>;
  /** Cascade helper for API deletion. Returns the number of rows removed. */
  deleteByApi(apiId: Uuid): Promise<number>;
}

/** Payload for {@link ApiPluginRepo.upsert}. */
export interface UpsertApiPluginInput {
  api_id: Uuid;
  plugin_name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  trigger: ApiPluginTrigger | null;
}

/** Client requests for access to a requestable API. */
export interface AccessRequestRepo {
  create(input: CreateInput<AccessRequestRecord>): Promise<AccessRequestRecord>;
  findById(id: Uuid): Promise<AccessRequestRecord | null>;
  update(id: Uuid, patch: UpdateInput<AccessRequestRecord>): Promise<AccessRequestRecord | null>;
  /**
   * Atomically move a request out of one status: apply `patch` **only while the
   * row still has `expected`**, in one statement
   * (`… WHERE id = ? AND status = ?`).
   *
   * Returns the updated row when this caller won the transition, `null` when it
   * lost — the request was absent, or somebody else already decided it.
   *
   * **Every transition out of `pending` must go through here**, never through
   * {@link AccessRequestRepo.update}. Approve, deny and cancel each read a
   * pending row and write it back later; a blind write lets a cancellation
   * racing an approval succeed too, so the history says `cancelled` while the
   * approval's grant and ACL group stay live. Only the winner of this call may
   * create a grant or touch the gateway; the loser raises `CONFLICT`.
   */
  updateIfStatus(
    id: Uuid,
    expected: AccessRequestStatus,
    patch: UpdateInput<AccessRequestRecord>,
  ): Promise<AccessRequestRecord | null>;
  list(filter: AccessRequestFilter, options?: ListOptions): Promise<Paginated<AccessRequestRecord>>;
  /** Duplicate guard: an open request by this user for this API. */
  findPendingByApiAndUser(apiId: Uuid, userId: Uuid): Promise<AccessRequestRecord | null>;
  /** Newest request regardless of status — drives the catalog `access_state`. */
  findLatestByApiAndUser(apiId: Uuid, userId: Uuid): Promise<AccessRequestRecord | null>;
  /** Newest request per API for one user, for a page of catalog rows. */
  listLatestForUser(userId: Uuid, apiIds: Uuid[]): Promise<AccessRequestRecord[]>;
  count(filter: AccessRequestFilter): Promise<number>;
  /** Cascade helper for API deletion. */
  deleteByApi(apiId: Uuid): Promise<number>;
}

/** Approved authorizations, each backed by an Edge ACL group membership. */
export interface GrantRepo {
  create(input: CreateInput<GrantRecord>): Promise<GrantRecord>;
  findById(id: Uuid): Promise<GrantRecord | null>;
  update(id: Uuid, patch: UpdateInput<GrantRecord>): Promise<GrantRecord | null>;
  /**
   * Atomically move a grant out of one status: apply `patch` **only while the
   * row still has `expected`**, in one statement
   * (`… WHERE id = ? AND status = ?`).
   *
   * Returns the updated row when this caller won the transition, `null` when it
   * lost — the grant was absent, or somebody else already moved it.
   *
   * **Every transition out of `active` must go through here**, never through
   * {@link GrantRepo.update}. Revocation reads an active grant and writes it
   * back after a round trip to the gateway, so a blind write let two
   * concurrent revocations — a second click, god mode racing the API owner, an
   * account teardown racing either — both pass the `status === 'active'` guard
   * and both commit. The ACL group came off twice and the audit trail claimed
   * the same access had been withdrawn twice. Only the winner of this call may
   * touch the gateway, record the revocation or tell the grantee.
   */
  updateIfStatus(
    id: Uuid,
    expected: GrantStatus,
    patch: UpdateInput<GrantRecord>,
  ): Promise<GrantRecord | null>;
  list(filter: GrantFilter, options?: ListOptions): Promise<Paginated<GrantRecord>>;
  /**
   * The single `status = 'active'` grant for an API/user pair, if any. The
   * schema enforces at most one via a partial unique index.
   */
  findActiveByApiAndUser(apiId: Uuid, userId: Uuid): Promise<GrantRecord | null>;
  /** Every active grant held by a user — used to rebuild their ACL group list. */
  listActiveByUser(userId: Uuid): Promise<GrantRecord[]>;
  /** Every active grant on an API — used by god-mode delete and bulk revoke. */
  listActiveByApi(apiId: Uuid): Promise<GrantRecord[]>;
  count(filter: GrantFilter): Promise<number>;
  /** Cascade helper for API deletion. */
  deleteByApi(apiId: Uuid): Promise<number>;
}

/** Show-once gateway credential metadata (fingerprint + last4 only). */
export interface CredentialRepo {
  create(input: CreateInput<CredentialRecord>): Promise<CredentialRecord>;
  findById(id: Uuid): Promise<CredentialRecord | null>;
  update(id: Uuid, patch: UpdateInput<CredentialRecord>): Promise<CredentialRecord | null>;
  list(filter: CredentialFilter, options?: ListOptions): Promise<Paginated<CredentialRecord>>;
  /** All credentials of a consumer, oldest first — mirrors the Edge array order. */
  listByConsumer(ferrumConsumerId: string, type?: CredentialType): Promise<CredentialRecord[]>;
  findByFingerprint(fingerprint: string): Promise<CredentialRecord | null>;
  count(filter: CredentialFilter): Promise<number>;
  delete(id: Uuid): Promise<boolean>;
}

/** Cache of the Nexus-user → Edge-consumer mapping, one row per user per namespace. */
export interface ConsumerRepo {
  create(input: CreateInput<ConsumerRecord>): Promise<ConsumerRecord>;
  findById(id: Uuid): Promise<ConsumerRecord | null>;
  /** The mapping used on every credential and approval operation. */
  findByUserAndNamespace(userId: Uuid, namespace: string): Promise<ConsumerRecord | null>;
  findByFerrumId(ferrumConsumerId: string): Promise<ConsumerRecord | null>;
  findByUsername(namespace: string, ferrumUsername: string): Promise<ConsumerRecord | null>;
  update(id: Uuid, patch: UpdateInput<ConsumerRecord>): Promise<ConsumerRecord | null>;
  list(filter: ConsumerFilter, options?: ListOptions): Promise<Paginated<ConsumerRecord>>;
  delete(id: Uuid): Promise<boolean>;
}

/** Conversations between a client and a provider (or the platform). */
export interface ThreadRepo {
  create(input: CreateInput<ThreadRecord>): Promise<ThreadRecord>;
  findById(id: Uuid): Promise<ThreadRecord | null>;
  update(id: Uuid, patch: UpdateInput<ThreadRecord>): Promise<ThreadRecord | null>;
  list(filter: ThreadFilter, options?: ListOptions): Promise<Paginated<ThreadRecord>>;
  /** Reuse an existing conversation instead of opening a duplicate. */
  findExisting(
    participantA: Uuid,
    participantB: Uuid | null,
    apiId: Uuid | null,
  ): Promise<ThreadRecord | null>;
  /** Bump `last_message_at` after a message is posted. */
  touchLastMessage(threadId: Uuid, at: IsoTimestamp): Promise<void>;
  delete(id: Uuid): Promise<boolean>;
}

/** Messages inside a thread. */
export interface MessageRepo {
  create(input: CreateInput<MessageRecord>): Promise<MessageRecord>;
  findById(id: Uuid): Promise<MessageRecord | null>;
  /** Oldest-first page of a thread's messages. */
  listByThread(threadId: Uuid, options?: ListOptions): Promise<Paginated<MessageRecord>>;
  /** Newest message of a thread, for list previews. */
  findLatestByThread(threadId: Uuid): Promise<MessageRecord | null>;
  countByThread(threadId: Uuid): Promise<number>;
  /**
   * How many messages `senderUserId` has posted since `sinceIso`, across every
   * thread — the per-account messaging budget.
   *
   * The boundary is **inclusive**: a row whose `created_at` equals `sinceIso`
   * counts. `created_at` is an ISO-8601 UTC string in a text column, so every
   * adapter compares it lexicographically, which for this fixed format is the
   * same ordering as by instant.
   */
  countBySenderSince(senderUserId: Uuid, sinceIso: IsoTimestamp): Promise<number>;
  /** Cascade helper for thread deletion. */
  deleteByThread(threadId: Uuid): Promise<number>;
}

/** In-app notifications. */
export interface NotificationRepo {
  create(input: CreateInput<NotificationRecord>): Promise<NotificationRecord>;
  /** Bulk insert for broadcasts. Returns the created rows. */
  createMany(inputs: CreateInput<NotificationRecord>[]): Promise<NotificationRecord[]>;
  findById(id: Uuid): Promise<NotificationRecord | null>;
  list(filter: NotificationFilter, options?: ListOptions): Promise<Paginated<NotificationRecord>>;
  countUnread(userId: Uuid): Promise<number>;
  /** Mark specific notifications of a user read. Returns the number changed. */
  markRead(userId: Uuid, ids: Uuid[], at: IsoTimestamp): Promise<number>;
  /** Mark every unread notification of a user read. Returns the number changed. */
  markAllRead(userId: Uuid, at: IsoTimestamp): Promise<number>;
}

/** Payload accepted by {@link EmailOutboxRepo.enqueue}. */
export interface EnqueueEmailInput {
  to_email: string;
  subject: string;
  body_html: string;
  body_text: string;
  /** Reusing a key suppresses the duplicate send (at-most-once). */
  idempotency_key?: string | null;
  /** Earliest delivery attempt; defaults to now (send on the next poll). */
  next_attempt_at?: IsoTimestamp | null;
  /** Pin the row id, e.g. to correlate with a notification. */
  id?: Uuid;
}

/** Transactional email queue drained by the outbox worker. */
export interface EmailOutboxRepo {
  /**
   * Enqueue a message as `pending` with `attempts = 0`. When
   * `idempotency_key` is set and already present, the existing row is returned
   * with `created: false` and nothing is inserted.
   */
  enqueue(input: EnqueueEmailInput): Promise<{ entry: EmailOutboxRecord; created: boolean }>;
  findById(id: Uuid): Promise<EmailOutboxRecord | null>;
  findByIdempotencyKey(key: string): Promise<EmailOutboxRecord | null>;
  /**
   * Atomically claim up to `limit` rows that are `pending` with
   * `next_attempt_at <= now`, flipping them to `sending` and incrementing
   * `attempts`. Two concurrent workers never claim the same row.
   */
  claimDue(now: IsoTimestamp, limit: number): Promise<EmailOutboxRecord[]>;
  /** Delivery succeeded: `status = 'sent'`, `next_attempt_at = null`. */
  markSent(id: Uuid, at: IsoTimestamp): Promise<void>;
  /** Delivery failed but retries remain: back to `pending` with a backoff stamp. */
  reschedule(id: Uuid, nextAttemptAt: IsoTimestamp, lastError: string): Promise<void>;
  /** Retries exhausted: `status = 'failed'`. */
  markFailed(id: Uuid, lastError: string): Promise<void>;
  /** Return `sending` rows stuck since before `olderThan` to `pending` (crash recovery). */
  releaseStale(olderThan: IsoTimestamp): Promise<number>;
  list(filter: EmailOutboxFilter, options?: ListOptions): Promise<Paginated<EmailOutboxRecord>>;
}

/**
 * Durable gateway revocations for disabled accounts.
 *
 * The row is written in the same transaction as `users.status = 'disabled'`, so
 * an account can never be disabled without the revocation being owed. The
 * teardown worker drains it with the same claim/backoff protocol as the email
 * outbox, but with no terminal failure state: retries continue for as long as
 * the account is disabled, because a credential that still authenticates is
 * not something to give up on.
 */
export interface GatewayTeardownJobRepo {
  /**
   * Queue (or re-queue) the revocation owed for `userId`.
   *
   * `user_id` is unique, so an account already carrying a job has that row
   * reset to `pending` with `attempts = 0` and `next_attempt_at = now` instead
   * of gaining a second one. Re-disabling an account therefore re-drives the
   * outstanding work rather than duplicating it.
   */
  upsertPending(
    userId: Uuid,
    requestedBy: Uuid | null,
    now: IsoTimestamp,
  ): Promise<GatewayTeardownJobRecord>;
  findByUser(userId: Uuid): Promise<GatewayTeardownJobRecord | null>;
  list(
    filter: GatewayTeardownJobFilter,
    options?: ListOptions,
  ): Promise<Paginated<GatewayTeardownJobRecord>>;
  /**
   * Atomically claim up to `limit` rows that are `pending` with
   * `next_attempt_at <= now`, flipping them to `sending` and incrementing
   * `attempts`. Two concurrent workers never claim the same row — the same
   * contract as {@link EmailOutboxRepo.claimDue}.
   */
  claimDue(now: IsoTimestamp, limit: number): Promise<GatewayTeardownJobRecord[]>;
  /** Edge confirmed the revocation: `status = 'done'`, `completed_at = at`. */
  markDone(id: Uuid, at: IsoTimestamp): Promise<void>;
  /** The attempt failed: back to `pending` with a backoff stamp and the reason. */
  reschedule(id: Uuid, nextAttemptAt: IsoTimestamp, lastError: string): Promise<void>;
  /** Return `sending` rows stuck since before `olderThan` to `pending` (crash recovery). */
  releaseStale(olderThan: IsoTimestamp): Promise<number>;
  /**
   * Drop the job for a user — the account was re-enabled (or deleted), so the
   * revocation must not land on a live gateway identity. `false` when there was
   * nothing queued.
   */
  deleteByUser(userId: Uuid): Promise<boolean>;
}

/** Append-only audit trail. */
export interface AuditLogRepo {
  /** Append one record. There is no update or delete. */
  create(input: CreateInput<AuditLogRecord>): Promise<AuditLogRecord>;
  /** Newest-first page with actor/action/target/time filters. */
  list(filter: AuditLogFilter, options?: ListOptions): Promise<Paginated<AuditLogRecord>>;
  count(filter: AuditLogFilter): Promise<number>;
}

/** Key/value application settings, some of them encrypted at rest. */
export interface SettingRepo {
  get(key: string): Promise<SettingRecord | null>;
  getMany(keys: string[]): Promise<SettingRecord[]>;
  /** Upsert. `encrypted` records how `value` was stored, not what it means. */
  set(key: string, value: unknown, encrypted?: boolean): Promise<SettingRecord>;
  /**
   * Insert `key` **only if it does not exist yet**, returning whether this
   * caller was the one that created it. An existing row is left untouched and
   * reported as `false`; this never throws `CONFLICT`.
   *
   * This is the store's one atomic compare-and-set, and it is atomic because
   * `app_settings.key` is unique — not because of any transaction. Concurrent
   * callers on any adapter (including PostgreSQL at READ COMMITTED and
   * MongoDB, where two transactions can both observe "absent") see exactly one
   * `true`. Used to elect the bootstrap `super_admin`; use it for any other
   * "exactly one winner" decision rather than read-then-write.
   */
  insertIfAbsent(key: string, value: unknown, encrypted?: boolean): Promise<boolean>;
  /** Upsert several keys; adapters apply them in one statement batch. */
  setMany(entries: { key: string; value: unknown; encrypted?: boolean }[]): Promise<void>;
  delete(key: string): Promise<boolean>;
  all(): Promise<SettingRecord[]>;
}

/** Admin-editable transactional email templates. */
export interface EmailTemplateRepo {
  get(key: EmailTemplateKey): Promise<EmailTemplateRecord | null>;
  /** Insert or replace the template for a key. */
  upsert(
    key: EmailTemplateKey,
    value: { subject: string; body_html: string; body_text: string },
  ): Promise<EmailTemplateRecord>;
  list(): Promise<EmailTemplateRecord[]>;
  /** Reverts a key to the built-in default by removing the override. */
  delete(key: EmailTemplateKey): Promise<boolean>;
}

/** Single-use email tokens: verification links and password-reset links. */
export interface VerificationTokenRepo {
  create(input: CreateInput<VerificationTokenRecord>): Promise<VerificationTokenRecord>;
  /**
   * Atomically claim permission to issue a token for this user and purpose.
   * Returns false when another request has claimed it after `notBefore`.
   */
  claimIssue(
    userId: Uuid,
    purpose: VerificationTokenPurpose,
    issuedAt: IsoTimestamp,
    notBefore: IsoTimestamp,
  ): Promise<boolean>;
  /**
   * Lookup by the hashed token, restricted to one purpose so a token minted for
   * a different flow is simply not found. Callers must still check `used_at`
   * and `expires_at`.
   */
  findByTokenHash(
    tokenHash: string,
    purpose: VerificationTokenPurpose,
  ): Promise<VerificationTokenRecord | null>;
  /**
   * Newest token of `purpose` for a user that is still live — neither burned
   * nor expired at `now`. Backs the resend throttles, which need to know
   * whether a usable link is already sitting in the recipient's inbox.
   */
  findLatestLiveForUser(
    userId: Uuid,
    purpose: VerificationTokenPurpose,
    now: IsoTimestamp,
  ): Promise<VerificationTokenRecord | null>;
  /** Burn the token. Returns `false` when it was already used or absent. */
  markUsed(id: Uuid, at: IsoTimestamp): Promise<boolean>;
  /**
   * Invalidate outstanding tokens, e.g. when a new one is issued. Without
   * `purpose` every token of the user is dropped, whatever it was for.
   */
  deleteForUser(userId: Uuid, purpose?: VerificationTokenPurpose): Promise<number>;
  deleteExpired(now: IsoTimestamp): Promise<number>;
}

/**
 * Expiring, single-holder leases over Ferrum Edge resources.
 *
 * Edge replaces consumers and proxies whole, with no ETag or version token, so
 * every mutation is a GET-edit-PUT that must not interleave with another. The
 * in-process queue in `ferrum-admin/client.ts` orders one Node process; this
 * repository is what orders *all* of them, which is what stops a revoke on one
 * instance being overwritten by a stale approval on another.
 *
 * `key` is the canonical lock key for one Edge resource — a Ferrum consumer id,
 * or `proxy:<id>` — and `owner` a per-process random id. Expiry rather than an
 * explicit unlock is what makes a crashed holder recoverable: nothing has to
 * notice the crash, the lease simply becomes takeable.
 *
 * Every method is a single atomic statement on every adapter. Callers must not
 * read-then-write around one.
 */
export interface LeaseRepo {
  /**
   * Take the lease for `key` until `expiresAt`, as `owner`.
   *
   * Succeeds when no row exists, or when the existing row expired at or before
   * `now`; a live lease held by anyone (including `owner` itself) is refused.
   * Exactly one of any number of concurrent callers gets `true`.
   */
  acquire(key: string, owner: string, expiresAt: IsoTimestamp, now: IsoTimestamp): Promise<boolean>;
  /**
   * Drop the lease. Returns `false` when `owner` no longer holds it — the lease
   * expired and somebody else took it — in which case the row is left alone.
   */
  release(key: string, owner: string): Promise<boolean>;
  /**
   * Push the expiry out while the critical section is still running. Returns
   * `false` when `owner` has already lost the lease.
   */
  renew(key: string, owner: string, expiresAt: IsoTimestamp): Promise<boolean>;
  /** Housekeeping sweep of leases nobody can hold any more. */
  deleteExpired(now: IsoTimestamp): Promise<number>;
}

/* ── The store ──────────────────────────────────────────────────────────── */

/** Result of {@link NexusStore.healthCheck}. */
export interface StoreHealth {
  ok: boolean;
  /** Round-trip time of the probe query in milliseconds. */
  latencyMs: number;
  /** Failure detail when `ok` is false; safe to log, never echoed to browsers. */
  error: string | null;
}

/**
 * Everything the service layer is allowed to do with persistence.
 *
 * Obtain one from `createStore(config)` in `db/index.ts`; the concrete adapter
 * is selected by `config.db.driver`.
 */
export interface NexusStore {
  /** Which adapter is backing this store. */
  readonly driver: DbDriver;

  /** Open connections and validate the deployment (e.g. Mongo replica-set check). */
  init(): Promise<void>;
  /** Apply every pending migration; idempotent, safe to call on every boot. */
  migrate(): Promise<void>;
  /** Close pools/handles. Safe to call more than once. */
  close(): Promise<void>;
  /** Cheap probe for `GET /api/health`. Never throws. */
  healthCheck(): Promise<StoreHealth>;

  /**
   * Run `fn` inside one transaction. Commits on resolve, rolls back on reject.
   * The store handed to `fn` is scoped to the transaction — use it, not the
   * outer store, for every statement inside the body.
   *
   * A `transaction()` call made *from inside* a body joins that transaction
   * rather than starting a second one. An independent call made while a body is
   * merely suspended on an `await` is not nested: it waits for the running
   * transaction and then gets one of its own. Statements issued through the
   * *outer* store while a body is open are undefined behaviour and adapter
   * specific — on SQLite they run inside the open transaction and share its
   * fate, because there is one connection.
   */
  transaction<T>(fn: (tx: NexusStore) => Promise<T>): Promise<T>;

  readonly users: UserRepo;
  readonly organizations: OrganizationRepo;
  readonly sessions: SessionRepo;
  readonly apis: ApiRepo;
  readonly apiSpecs: ApiSpecRepo;
  readonly apiPlugins: ApiPluginRepo;
  readonly accessRequests: AccessRequestRepo;
  readonly grants: GrantRepo;
  readonly credentials: CredentialRepo;
  readonly consumers: ConsumerRepo;
  readonly threads: ThreadRepo;
  readonly messages: MessageRepo;
  readonly notifications: NotificationRepo;
  readonly emailOutbox: EmailOutboxRepo;
  readonly gatewayTeardownJobs: GatewayTeardownJobRepo;
  readonly auditLogs: AuditLogRepo;
  readonly settings: SettingRepo;
  readonly emailTemplates: EmailTemplateRepo;
  readonly verificationTokens: VerificationTokenRepo;
  readonly leases: LeaseRepo;
}
