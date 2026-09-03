/**
 * MongoDB implementation of {@link NexusStore} (`mongodb` driver v6).
 *
 * The logical schema is unchanged: **one collection per logical table**, with
 * the same names the SQL migrations use. Only the physical representation
 * differs, in four documented ways:
 *
 * 1. **`_id` holds the string UUID.** Records still surface it as `id`; the
 *    mappers below are the only place the two spellings meet. `app_settings`
 *    has no surrogate id in the store contract, so its `_id` *is* the setting
 *    key.
 * 2. **Booleans and structured values are stored natively** — `true`/`false`
 *    rather than 0/1, and `rate_limit` / `details` / setting `value` as BSON
 *    documents rather than JSON text. They are normalised through
 *    {@link normalizeJson} on the way in so an `undefined` nested field becomes
 *    the same "absent" it would be after a JSON round trip in a SQL adapter.
 * 3. **Two derived lowercase fields exist for the case-insensitive uniques.**
 *    MongoDB has no expression indexes, so `organizations.name_lower` and
 *    `apis.slug_lower` carry what SQLite indexes as `lower(name)` and
 *    `lower(slug)`. They are written and re-written alongside their source
 *    field and never leave the adapter — the mappers pick fields by name.
 *    `users.email` needs no companion because the adapter lowercases it on
 *    write, exactly as the SQL adapters do.
 * 4. **Partial unique indexes use `partialFilterExpression`**, which lines up
 *    one-for-one with SQLite's `CREATE UNIQUE INDEX … WHERE …`.
 *
 * ## Transactions and the replica-set rule
 *
 * Multi-document transactions require a replica set (or a sharded cluster);
 * a standalone `mongod` cannot start a session transaction at all. {@link init}
 * therefore probes the deployment with `hello` and:
 *
 * - **replica set / mongos** — `transaction()` is a real session transaction:
 *   `startTransaction`, commit on resolve, `abortTransaction` on reject.
 * - **standalone, `NEXUS_DB_ALLOW_STANDALONE` unset** — `init()` throws
 *   `NexusError('INTERNAL', …)` so the process refuses to start rather than
 *   silently losing atomicity. This is the documented default: credential
 *   rotation and grant approval both depend on real transactions.
 * - **standalone, `NEXUS_DB_ALLOW_STANDALONE=true`** — the operator has opted
 *   in, and `transaction()` **degrades to sequential execution**: the body
 *   still runs, still serialised against other bodies, but there is no atomic
 *   commit and a throw part-way through leaves earlier writes in place. It is
 *   a development/evaluation mode, not a supported production configuration.
 */

import {
  MongoClient,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type Filter,
  type IndexSpecification,
  type Sort,
} from 'mongodb';

import type {
  AccessRequestStatus,
  ApiStatus,
  ApiTimeouts,
  ApiVisibility,
  AuthPluginType,
  CorsConfig,
  CredentialStatus,
  CredentialType,
  DbDriver,
  EmailOutboxStatus,
  EmailTemplateKey,
  GrantStatus,
  HttpMethod,
  IsoTimestamp,
  NotificationType,
  RateLimitConfig,
  Role,
  UserStatus,
  Uuid,
} from '@ferrum-nexus/shared';
import { clampPageSize } from '@ferrum-nexus/shared';

import type { NexusConfig } from '../../../config/index.js';
import { conflict, NexusError } from '../../../lib/errors.js';
import { newId, nowIso } from '../../../lib/ids.js';
import {
  runMigrations,
  SCHEMA_MIGRATIONS_TABLE,
  type MigrationDriver,
  type MigrationFile,
} from '../../migrate.js';
import type {
  AccessRequestFilter,
  AccessRequestRecord,
  AccessRequestRepo,
  ApiFilter,
  ApiRecord,
  ApiRepo,
  ApiSpecRecord,
  ApiSpecRepo,
  AuditLogFilter,
  AuditLogRecord,
  AuditLogRepo,
  ConsumerRecord,
  ConsumerRepo,
  CreateInput,
  CredentialFilter,
  CredentialRecord,
  CredentialRepo,
  EmailOutboxRecord,
  EmailOutboxRepo,
  EmailTemplateRecord,
  EmailTemplateRepo,
  GrantFilter,
  GrantRecord,
  GrantRepo,
  ListOptions,
  MessageRecord,
  MessageRepo,
  NexusStore,
  NotificationRecord,
  NotificationRepo,
  OrganizationRecord,
  OrganizationRepo,
  SessionRecord,
  SessionRepo,
  SettingRecord,
  SettingRepo,
  StoreHealth,
  ThreadRecord,
  ThreadRepo,
  UpdateInput,
  UserFilter,
  UserRecord,
  UserRepo,
  VerificationTokenPurpose,
  VerificationTokenRecord,
  VerificationTokenRepo,
} from '../../store.js';

/* ── Collection names (identical to the SQL table names) ────────────────── */

const COLLECTIONS = {
  organizations: 'organizations',
  users: 'users',
  sessions: 'sessions',
  apis: 'apis',
  apiSpecs: 'api_specs',
  accessRequests: 'access_requests',
  grants: 'grants',
  consumers: 'consumers',
  credentials: 'credential_metadata',
  threads: 'message_threads',
  messages: 'messages',
  notifications: 'notifications',
  emailOutbox: 'email_outbox',
  auditLogs: 'audit_logs',
  settings: 'app_settings',
  emailTemplates: 'email_templates',
  verificationTokens: 'email_verification_tokens',
} as const;

/* ── Small decoders (Mongo hands back native types already) ─────────────── */

/** An untyped document; every repo decodes it into a record type immediately. */
type Row = Record<string, unknown>;

/**
 * Every Nexus collection keys documents by the record's string UUID, so the
 * driver's default `ObjectId` `_id` is wrong for all of them. Declaring it once
 * here is what lets `{ _id: someUuid }` type-check as a filter.
 */
interface NexusDoc {
  _id: string;
  [field: string]: unknown;
}

function asRow(doc: Document | null | undefined): Row | null {
  return doc === null || doc === undefined ? null : (doc as Row);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/**
 * Normalise a structured value the way `JSON.stringify`/`JSON.parse` would in a
 * SQL adapter, so `undefined` members disappear instead of being rejected by
 * BSON and the two representations stay observationally identical.
 */
function normalizeJson<T>(value: T): T {
  if (value === undefined) return null as unknown as T;
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/** Escape a user-supplied term for use inside a regular expression. */
function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive substring match — the Mongo spelling of the SQL `q` filters. */
function containsInsensitive(term: string): Filter<NexusDoc> {
  return { $regex: escapeRegex(term), $options: 'i' } as unknown as Filter<NexusDoc>;
}

/** Case-insensitive whole-value match — the Mongo spelling of `lower(col) = ?`. */
function equalsInsensitive(value: string): Filter<NexusDoc> {
  return { $regex: `^${escapeRegex(value)}$`, $options: 'i' } as unknown as Filter<NexusDoc>;
}

/** Drop `undefined` entries; returns `null` when nothing would be written. */
function setDoc(fields: Record<string, unknown>): Record<string, unknown> | null {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

/** Normalised pagination: a clamped limit and a non-negative offset. */
function page(options: ListOptions | undefined): { limit: number; offset: number } {
  const limit = clampPageSize(options?.limit);
  const rawOffset = options?.offset ?? 0;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

interface Timestamps {
  id: Uuid;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

function stamps(input: {
  id?: Uuid;
  created_at?: IsoTimestamp;
  updated_at?: IsoTimestamp;
}): Timestamps {
  const now = nowIso();
  return {
    id: input.id ?? newId(),
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? input.created_at ?? now,
  };
}

/** Newest-first, the ordering every SQL `list` uses. */
const NEWEST_FIRST: Sort = { created_at: -1, _id: -1 };

/**
 * Outbox claim order: earliest scheduled attempt first.
 *
 * BSON sorts `null` before every string, so rows with no `next_attempt_at` come
 * first — the same ordering the SQL adapters spell out explicitly.
 */
const OUTBOX_CLAIM_ORDER: Sort = { next_attempt_at: 1, created_at: 1 };

/**
 * Run `fn`, translating a duplicate-key error into `NexusError('CONFLICT', …)`
 * so no driver-specific error escapes the adapter.
 */
async function mapConflict<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if ((error as { code?: unknown }).code === 11000) throw conflict(message);
    throw error;
  }
}

/* ── Row mappers ────────────────────────────────────────────────────────── */

function mapUser(row: Row): UserRecord {
  return {
    id: str(row._id),
    email: str(row.email),
    password_hash: str(row.password_hash),
    display_name: str(row.display_name),
    role: str(row.role) as Role,
    org_id: strOrNull(row.org_id),
    company: strOrNull(row.company),
    phone: strOrNull(row.phone),
    status: str(row.status) as UserStatus,
    email_verified: flag(row.email_verified),
    last_login_at: strOrNull(row.last_login_at),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

/** Settable fields of a user patch, shared by `update` and `updateIfMatches`. */
function userUpdateFields(patch: UpdateInput<UserRecord>): Record<string, unknown> {
  return {
    email: patch.email === undefined ? undefined : patch.email.trim().toLowerCase(),
    password_hash: patch.password_hash,
    display_name: patch.display_name,
    role: patch.role,
    org_id: patch.org_id,
    company: patch.company,
    phone: patch.phone,
    status: patch.status,
    email_verified: patch.email_verified,
    last_login_at: patch.last_login_at,
  };
}

/** Settable fields of an access-request patch, shared by both updates. */
function accessRequestUpdateFields(
  patch: UpdateInput<AccessRequestRecord>,
): Record<string, unknown> {
  return {
    justification: patch.justification,
    status: patch.status,
    decided_by: patch.decided_by,
    decided_at: patch.decided_at,
    decision_note: patch.decision_note,
  };
}

/** Settable fields of a grant patch, shared by both updates. */
function grantUpdateFields(patch: UpdateInput<GrantRecord>): Record<string, unknown> {
  return {
    status: patch.status,
    acl_group: patch.acl_group,
    access_request_id: patch.access_request_id,
    revoked_by: patch.revoked_by,
    revoked_at: patch.revoked_at,
  };
}

function mapOrganization(row: Row): OrganizationRecord {
  return {
    id: str(row._id),
    name: str(row.name),
    description: strOrNull(row.description),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapSession(row: Row): SessionRecord {
  return {
    id: str(row._id),
    token_hash: str(row.token_hash),
    user_id: str(row.user_id),
    csrf_token: str(row.csrf_token),
    expires_at: str(row.expires_at),
    ip: strOrNull(row.ip),
    user_agent: strOrNull(row.user_agent),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapApi(row: Row): ApiRecord {
  return {
    id: str(row._id),
    name: str(row.name),
    slug: str(row.slug),
    description: strOrNull(row.description),
    owner_user_id: str(row.owner_user_id),
    ferrum_proxy_id: strOrNull(row.ferrum_proxy_id),
    upstream_url: strOrNull(row.upstream_url),
    namespace: str(row.namespace),
    version: str(row.version),
    spec_format: 'openapi',
    requestable: flag(row.requestable),
    auth_plugin: str(row.auth_plugin) as AuthPluginType,
    rate_limit: (row.rate_limit ?? null) as RateLimitConfig | null,
    cors: (row.cors ?? null) as CorsConfig | null,
    allowed_methods: (row.allowed_methods ?? null) as HttpMethod[] | null,
    timeouts: (row.timeouts ?? null) as ApiTimeouts | null,
    circuit_breaker: flag(row.circuit_breaker),
    status: str(row.status) as ApiStatus,
    visibility: str(row.visibility) as ApiVisibility,
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapApiSpec(row: Row): ApiSpecRecord {
  return {
    id: str(row._id),
    api_id: str(row.api_id),
    version: str(row.version),
    raw_spec: str(row.raw_spec),
    parsed_title: strOrNull(row.parsed_title),
    parsed_version: strOrNull(row.parsed_version),
    is_current: flag(row.is_current),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapAccessRequest(row: Row): AccessRequestRecord {
  return {
    id: str(row._id),
    api_id: str(row.api_id),
    user_id: str(row.user_id),
    justification: str(row.justification),
    status: str(row.status) as AccessRequestStatus,
    decided_by: strOrNull(row.decided_by),
    decided_at: strOrNull(row.decided_at),
    decision_note: strOrNull(row.decision_note),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapGrant(row: Row): GrantRecord {
  return {
    id: str(row._id),
    api_id: str(row.api_id),
    user_id: str(row.user_id),
    access_request_id: strOrNull(row.access_request_id),
    acl_group: str(row.acl_group),
    status: str(row.status) as GrantStatus,
    granted_by: str(row.granted_by),
    revoked_by: strOrNull(row.revoked_by),
    revoked_at: strOrNull(row.revoked_at),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapCredential(row: Row): CredentialRecord {
  return {
    id: str(row._id),
    user_id: str(row.user_id),
    ferrum_consumer_id: str(row.ferrum_consumer_id),
    credential_type: str(row.credential_type) as CredentialType,
    ferrum_credential_id: str(row.ferrum_credential_id),
    fingerprint: str(row.fingerprint),
    last4: str(row.last4),
    label: strOrNull(row.label),
    status: str(row.status) as CredentialStatus,
    rotated_from_id: strOrNull(row.rotated_from_id),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapConsumer(row: Row): ConsumerRecord {
  return {
    id: str(row._id),
    user_id: str(row.user_id),
    namespace: str(row.namespace),
    ferrum_consumer_id: str(row.ferrum_consumer_id),
    ferrum_username: str(row.ferrum_username),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapThread(row: Row): ThreadRecord {
  return {
    id: str(row._id),
    subject: str(row.subject),
    api_id: strOrNull(row.api_id),
    created_by: str(row.created_by),
    participant_a: str(row.participant_a),
    participant_b: strOrNull(row.participant_b),
    last_message_at: strOrNull(row.last_message_at),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapMessage(row: Row): MessageRecord {
  return {
    id: str(row._id),
    thread_id: str(row.thread_id),
    sender_user_id: str(row.sender_user_id),
    body: str(row.body),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapNotification(row: Row): NotificationRecord {
  return {
    id: str(row._id),
    user_id: str(row.user_id),
    type: str(row.type) as NotificationType,
    title: str(row.title),
    body: str(row.body),
    link: strOrNull(row.link),
    read_at: strOrNull(row.read_at),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapOutbox(row: Row): EmailOutboxRecord {
  return {
    id: str(row._id),
    to_email: str(row.to_email),
    subject: str(row.subject),
    body_html: str(row.body_html),
    body_text: str(row.body_text),
    status: str(row.status) as EmailOutboxStatus,
    attempts: num(row.attempts),
    next_attempt_at: strOrNull(row.next_attempt_at),
    last_error: strOrNull(row.last_error),
    idempotency_key: strOrNull(row.idempotency_key),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapAuditLog(row: Row): AuditLogRecord {
  return {
    id: str(row._id),
    actor_user_id: strOrNull(row.actor_user_id),
    actor_role: strOrNull(row.actor_role) as Role | null,
    action: str(row.action),
    target_type: str(row.target_type),
    target_id: strOrNull(row.target_id),
    details: (row.details ?? {}) as Record<string, unknown>,
    ip: strOrNull(row.ip),
    created_at: str(row.created_at),
  };
}

function mapSetting(row: Row): SettingRecord {
  return {
    key: str(row._id),
    value: row.value ?? null,
    encrypted: flag(row.encrypted),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapEmailTemplate(row: Row): EmailTemplateRecord {
  return {
    id: str(row._id),
    key: str(row.key) as EmailTemplateKey,
    subject: str(row.subject),
    body_html: str(row.body_html),
    body_text: str(row.body_text),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapVerificationToken(row: Row): VerificationTokenRecord {
  return {
    id: str(row._id),
    user_id: str(row.user_id),
    token_hash: str(row.token_hash),
    purpose: str(row.purpose) as VerificationTokenPurpose,
    expires_at: str(row.expires_at),
    used_at: strOrNull(row.used_at),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

/* ── Filter builders ────────────────────────────────────────────────────── */

function userFilter(filter: UserFilter): Filter<NexusDoc> {
  const query: Record<string, unknown> = {};
  if (filter.role !== undefined) query.role = filter.role;
  if (filter.roles !== undefined) query.role = { $in: filter.roles };
  if (filter.status !== undefined) query.status = filter.status;
  if (filter.org_id !== undefined) query.org_id = filter.org_id;
  if (filter.ids !== undefined) query._id = { $in: filter.ids };
  if (filter.email_verified !== undefined) query.email_verified = filter.email_verified;
  if (filter.q !== undefined && filter.q.trim() !== '') {
    const match = containsInsensitive(filter.q.trim());
    query.$or = [{ email: match }, { display_name: match }];
  }
  return query as Filter<NexusDoc>;
}

function apiFilter(filter: ApiFilter): Filter<NexusDoc> {
  const query: Record<string, unknown> = {};
  if (filter.owner_user_id !== undefined) query.owner_user_id = filter.owner_user_id;
  if (filter.status !== undefined) query.status = filter.status;
  if (filter.visibility !== undefined) query.visibility = filter.visibility;
  if (filter.requestable !== undefined) query.requestable = filter.requestable;
  if (filter.ids !== undefined) query._id = { $in: filter.ids };
  if (filter.q !== undefined && filter.q.trim() !== '') {
    const match = containsInsensitive(filter.q.trim());
    query.$or = [{ name: match }, { slug: match }, { description: match }];
  }
  return query as Filter<NexusDoc>;
}

function accessRequestFilter(filter: AccessRequestFilter): Filter<NexusDoc> {
  const query: Record<string, unknown> = {};
  if (filter.user_id !== undefined) query.user_id = filter.user_id;
  if (filter.api_id !== undefined) query.api_id = filter.api_id;
  if (filter.api_ids !== undefined) query.api_id = { $in: filter.api_ids };
  if (filter.status !== undefined) query.status = filter.status;
  return query as Filter<NexusDoc>;
}

function grantFilter(filter: GrantFilter): Filter<NexusDoc> {
  const query: Record<string, unknown> = {};
  if (filter.user_id !== undefined) query.user_id = filter.user_id;
  if (filter.api_id !== undefined) query.api_id = filter.api_id;
  if (filter.api_ids !== undefined) query.api_id = { $in: filter.api_ids };
  if (filter.status !== undefined) query.status = filter.status;
  return query as Filter<NexusDoc>;
}

function credentialFilter(filter: CredentialFilter): Filter<NexusDoc> {
  const query: Record<string, unknown> = {};
  if (filter.user_id !== undefined) query.user_id = filter.user_id;
  if (filter.status !== undefined) query.status = filter.status;
  if (filter.credential_type !== undefined) query.credential_type = filter.credential_type;
  if (filter.ferrum_consumer_id !== undefined) {
    query.ferrum_consumer_id = filter.ferrum_consumer_id;
  }
  return query as Filter<NexusDoc>;
}

function auditFilter(filter: AuditLogFilter): Filter<NexusDoc> {
  const query: Record<string, unknown> = {};
  if (filter.actor_user_id !== undefined) query.actor_user_id = filter.actor_user_id;
  if (filter.action !== undefined) query.action = filter.action;
  if (filter.actions !== undefined) query.action = { $in: filter.actions };
  if (filter.target_type !== undefined) query.target_type = filter.target_type;
  if (filter.target_id !== undefined) query.target_id = filter.target_id;
  if (filter.from !== undefined || filter.to !== undefined) {
    const range: Record<string, unknown> = {};
    if (filter.from !== undefined) range.$gte = filter.from;
    if (filter.to !== undefined) range.$lt = filter.to;
    query.created_at = range;
  }
  return query as Filter<NexusDoc>;
}

/* ── Index definitions ──────────────────────────────────────────────────── */

interface IndexDefinition {
  collection: string;
  name: string;
  key: IndexSpecification;
  unique?: boolean;
  partialFilterExpression?: Document;
}

/**
 * Every index of `001_initial`, translated.
 *
 * Partial *unique* indexes map directly onto `partialFilterExpression`. The one
 * non-unique partial index — SQLite's `ix_notifications_unread ... WHERE
 * read_at IS NULL` — becomes the composite `(user_id, read_at)` instead: it is
 * a lookup index rather than a uniqueness rule, so equivalent coverage is all
 * that is required (the MySQL migration makes the same trade for the same
 * reason).
 */
const INDEXES: IndexDefinition[] = [
  // organizations — `name_lower` is the derived companion of `lower(name)`.
  {
    collection: 'organizations',
    name: 'ux_organizations_name',
    key: { name_lower: 1 },
    unique: true,
  },

  // users — the adapter lowercases `email` on write, so a plain unique works.
  { collection: 'users', name: 'ux_users_email', key: { email: 1 }, unique: true },
  { collection: 'users', name: 'ix_users_role_status', key: { role: 1, status: 1 } },
  { collection: 'users', name: 'ix_users_org', key: { org_id: 1 } },
  { collection: 'users', name: 'ix_users_created_at', key: { created_at: 1 } },

  { collection: 'sessions', name: 'ux_sessions_token_hash', key: { token_hash: 1 }, unique: true },
  { collection: 'sessions', name: 'ix_sessions_user', key: { user_id: 1 } },
  { collection: 'sessions', name: 'ix_sessions_expires_at', key: { expires_at: 1 } },

  { collection: 'apis', name: 'ux_apis_slug', key: { slug_lower: 1 }, unique: true },
  {
    collection: 'apis',
    name: 'ux_apis_proxy_id',
    key: { ferrum_proxy_id: 1 },
    unique: true,
    partialFilterExpression: { ferrum_proxy_id: { $type: 'string' } },
  },
  { collection: 'apis', name: 'ix_apis_owner', key: { owner_user_id: 1 } },
  { collection: 'apis', name: 'ix_apis_status_visibility', key: { status: 1, visibility: 1 } },
  { collection: 'apis', name: 'ix_apis_created_at', key: { created_at: 1 } },

  {
    collection: 'api_specs',
    name: 'ux_api_specs_current',
    key: { api_id: 1 },
    unique: true,
    partialFilterExpression: { is_current: true },
  },
  { collection: 'api_specs', name: 'ix_api_specs_api', key: { api_id: 1, created_at: 1 } },

  {
    collection: 'access_requests',
    name: 'ux_access_requests_pending',
    key: { api_id: 1, user_id: 1 },
    unique: true,
    partialFilterExpression: { status: 'pending' },
  },
  {
    collection: 'access_requests',
    name: 'ix_access_requests_api_status',
    key: { api_id: 1, status: 1 },
  },
  {
    collection: 'access_requests',
    name: 'ix_access_requests_user',
    key: { user_id: 1, created_at: 1 },
  },

  {
    collection: 'grants',
    name: 'ux_grants_active',
    key: { api_id: 1, user_id: 1 },
    unique: true,
    partialFilterExpression: { status: 'active' },
  },
  { collection: 'grants', name: 'ix_grants_user_status', key: { user_id: 1, status: 1 } },
  { collection: 'grants', name: 'ix_grants_api_status', key: { api_id: 1, status: 1 } },

  {
    collection: 'consumers',
    name: 'ux_consumers_user_namespace',
    key: { user_id: 1, namespace: 1 },
    unique: true,
  },
  {
    collection: 'consumers',
    name: 'ux_consumers_ferrum_id',
    key: { namespace: 1, ferrum_consumer_id: 1 },
    unique: true,
  },
  {
    collection: 'consumers',
    name: 'ux_consumers_username',
    key: { namespace: 1, ferrum_username: 1 },
    unique: true,
  },

  {
    collection: 'credential_metadata',
    name: 'ux_credentials_fingerprint',
    key: { fingerprint: 1 },
    unique: true,
  },
  {
    collection: 'credential_metadata',
    name: 'ix_credentials_user_status',
    key: { user_id: 1, status: 1 },
  },
  {
    collection: 'credential_metadata',
    name: 'ix_credentials_consumer',
    key: { ferrum_consumer_id: 1, credential_type: 1, created_at: 1 },
  },

  {
    collection: 'message_threads',
    name: 'ix_threads_participant_a',
    key: { participant_a: 1, last_message_at: 1 },
  },
  {
    collection: 'message_threads',
    name: 'ix_threads_participant_b',
    key: { participant_b: 1, last_message_at: 1 },
  },
  { collection: 'message_threads', name: 'ix_threads_api', key: { api_id: 1 } },

  { collection: 'messages', name: 'ix_messages_thread', key: { thread_id: 1, created_at: 1 } },

  {
    collection: 'notifications',
    name: 'ix_notifications_user',
    key: { user_id: 1, created_at: 1 },
  },
  { collection: 'notifications', name: 'ix_notifications_unread', key: { user_id: 1, read_at: 1 } },

  {
    collection: 'email_outbox',
    name: 'ux_email_outbox_idempotency',
    key: { idempotency_key: 1 },
    unique: true,
    partialFilterExpression: { idempotency_key: { $type: 'string' } },
  },
  {
    collection: 'email_outbox',
    name: 'ix_email_outbox_due',
    key: { status: 1, next_attempt_at: 1 },
  },

  { collection: 'audit_logs', name: 'ix_audit_created_at', key: { created_at: 1 } },
  { collection: 'audit_logs', name: 'ix_audit_actor', key: { actor_user_id: 1, created_at: 1 } },
  { collection: 'audit_logs', name: 'ix_audit_action', key: { action: 1, created_at: 1 } },
  { collection: 'audit_logs', name: 'ix_audit_target', key: { target_type: 1, target_id: 1 } },

  // app_settings needs no index: the setting key *is* `_id`.

  { collection: 'email_templates', name: 'ux_email_templates_key', key: { key: 1 }, unique: true },

  {
    collection: 'email_verification_tokens',
    name: 'ux_verification_tokens_hash',
    key: { token_hash: 1 },
    unique: true,
  },
  {
    collection: 'email_verification_tokens',
    name: 'ix_verification_tokens_user',
    key: { user_id: 1 },
  },
  {
    collection: 'email_verification_tokens',
    name: 'ix_verification_tokens_expires',
    key: { expires_at: 1 },
  },
];

/** Indexes added by `003_verification_token_purpose`. */
const PURPOSE_INDEXES: IndexDefinition[] = [
  {
    collection: 'email_verification_tokens',
    name: 'ix_verification_tokens_user_purpose',
    key: { user_id: 1, purpose: 1 },
  },
];

/** Create one batch of {@link IndexDefinition}s. */
async function createIndexes(db: Db, indexes: IndexDefinition[]): Promise<void> {
  for (const index of indexes) {
    await db.collection(index.collection).createIndex(index.key, {
      name: index.name,
      ...(index.unique === true ? { unique: true } : {}),
      ...(index.partialFilterExpression
        ? { partialFilterExpression: index.partialFilterExpression }
        : {}),
    });
  }
}

/**
 * Mongo's "migrations".
 *
 * Mostly index creation rather than DDL, but the ids stay in lockstep with the
 * SQL variants so `schema_migrations` means the same thing on every driver and
 * each step lands exactly once here too.
 */
const MONGO_MIGRATIONS: { id: string; apply: (db: Db) => Promise<void> }[] = [
  {
    id: '001_initial',
    apply: (db: Db): Promise<void> => createIndexes(db, INDEXES),
  },
  {
    id: '003_verification_token_purpose',
    apply: async (db: Db): Promise<void> => {
      // The SQL dialects backfill through a column default; Mongo has to write
      // the field. Every document that predates the column is a verification
      // token, since that was the only kind the table held.
      await db
        .collection('email_verification_tokens')
        .updateMany({ purpose: { $exists: false } }, { $set: { purpose: 'email_verification' } });
      await createIndexes(db, PURPOSE_INDEXES);
    },
  },
];

/* ── Shared connection state ────────────────────────────────────────────── */

interface MongoContext {
  client: MongoClient;
  db: Db;
  allowStandalone: boolean;
  /** Set by `init()`: false for a standalone deployment. */
  supportsTransactions: boolean;
  closed: boolean;
}

/* ── The store ──────────────────────────────────────────────────────────── */

/** The MongoDB {@link NexusStore}. Construct it with {@link createMongoStore}. */
class MongoStore implements NexusStore {
  readonly driver: DbDriver = 'mongodb';

  private readonly ctx: MongoContext;

  /** Non-null only for a store scoped to an open transaction. */
  private readonly session: ClientSession | null;

  /** Serialises `transaction` bodies, matching the sqlite adapter's contract. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: MongoContext, session: ClientSession | null) {
    this.ctx = ctx;
    this.session = session;
  }

  /** The collection handle for a logical table. */
  private col(name: string): Collection<NexusDoc> {
    return this.ctx.db.collection<NexusDoc>(name);
  }

  /** Session option threaded through every operation of a scoped store. */
  private get opts(): { session?: ClientSession } {
    return this.session ? { session: this.session } : {};
  }

  /** Shared `{ items, total }` list implementation. */
  private async paginate<T>(
    name: string,
    filter: Filter<NexusDoc>,
    sort: Sort,
    options: ListOptions | undefined,
    map: (row: Row) => T,
  ): Promise<{ items: T[]; total: number }> {
    const { limit, offset } = page(options);
    const collection = this.col(name);
    const total = await collection.countDocuments(filter, this.opts);
    const docs = await collection
      .find(filter, this.opts)
      .sort(sort)
      .skip(offset)
      .limit(limit)
      .toArray();
    return { items: docs.map((doc) => map(doc as Row)), total };
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  async init(): Promise<void> {
    await this.ctx.client.connect();
    const hello = (await this.ctx.db.admin().command({ hello: 1 })) as {
      setName?: string;
      msg?: string;
    };
    // A replica set reports its name; a mongos reports `isdbgrid`. Anything
    // else is a standalone `mongod`, which cannot run multi-document
    // transactions at all.
    const replicated = typeof hello.setName === 'string' || hello.msg === 'isdbgrid';
    this.ctx.supportsTransactions = replicated;
    if (!replicated && !this.ctx.allowStandalone) {
      throw new NexusError(
        'INTERNAL',
        'MongoDB is running as a standalone server, which cannot execute the multi-document ' +
          'transactions credential rotation and grant approval depend on. Deploy a replica set ' +
          '(even a single-node one) or set NEXUS_DB_ALLOW_STANDALONE=true to accept ' +
          'non-atomic transactions.',
      );
    }
  }

  async migrate(): Promise<void> {
    const db = this.ctx.db;
    const collection = db.collection<NexusDoc>(SCHEMA_MIGRATIONS_TABLE);
    const steps = new Map(MONGO_MIGRATIONS.map((step) => [step.id, step.apply]));
    const driver: MigrationDriver = {
      ensureMigrationsTable: async (): Promise<void> => {
        // `_id` is the migration id, so the implicit unique index is all the
        // bookkeeping this needs; the collection is created on first insert.
      },
      listApplied: async (): Promise<string[]> => {
        const docs = await collection.find({}).toArray();
        return docs.map((doc) => str((doc as Row)._id));
      },
      applyMigration: async (migration: MigrationFile): Promise<void> => {
        const apply = steps.get(migration.id);
        if (!apply) {
          throw new NexusError(
            'INTERNAL',
            `No MongoDB implementation for migration '${migration.id}'`,
          );
        }
        await apply(db);
        await collection.insertOne({ _id: migration.id, applied_at: nowIso() });
      },
    };
    const files: MigrationFile[] = MONGO_MIGRATIONS.map((step) => ({
      id: step.id,
      filename: `${step.id}.mongodb`,
      sql: '',
    }));
    await runMigrations(driver, files);
  }

  async close(): Promise<void> {
    if (this.ctx.closed) return;
    this.ctx.closed = true;
    await this.ctx.client.close();
  }

  async healthCheck(): Promise<StoreHealth> {
    const started = Date.now();
    try {
      await this.ctx.db.command({ ping: 1 });
      return { ok: true, latencyMs: Date.now() - started, error: null };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }

  transaction<T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> {
    return this.inTransaction(fn);
  }

  /**
   * {@link transaction}, typed as the concrete store.
   *
   * The repository methods that must be atomic even when the caller opened no
   * transaction of their own use this to reach the session-scoped collections,
   * mirroring the `inTransaction` runner the SQL adapters are built on. All the
   * documented behaviour is unchanged: bodies are serialised, a nested call
   * joins the open transaction, and a standalone deployment that opted in with
   * `NEXUS_DB_ALLOW_STANDALONE` degrades to sequential execution.
   */
  private inTransaction<T>(fn: (tx: MongoStore) => Promise<T>): Promise<T> {
    // Already inside a transaction body — join it rather than nesting.
    if (this.session) return fn(this);

    const run = async (): Promise<T> => {
      if (!this.ctx.supportsTransactions) {
        // Standalone deployment with NEXUS_DB_ALLOW_STANDALONE=true: run the
        // body sequentially. It is still serialised against other bodies, but
        // there is no atomic commit and no rollback on throw.
        return fn(new MongoStore(this.ctx, null));
      }
      const session = this.ctx.client.startSession();
      try {
        session.startTransaction();
        try {
          const result = await fn(new MongoStore(this.ctx, session));
          await session.commitTransaction();
          return result;
        } catch (error) {
          await session.abortTransaction().catch(() => undefined);
          throw error;
        }
      } finally {
        await session.endSession();
      }
    };

    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /* ── users ────────────────────────────────────────────────────────────── */

  readonly users: UserRepo = {
    create: async (input: CreateInput<UserRecord>): Promise<UserRecord> => {
      const meta = stamps(input);
      await mapConflict('An account with that email address already exists', () =>
        this.col(COLLECTIONS.users).insertOne(
          {
            _id: meta.id,
            email: input.email.trim().toLowerCase(),
            password_hash: input.password_hash,
            display_name: input.display_name,
            role: input.role,
            org_id: input.org_id ?? null,
            company: input.company ?? null,
            phone: input.phone ?? null,
            status: input.status,
            email_verified: input.email_verified,
            last_login_at: input.last_login_at ?? null,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
          } as NexusDoc,
          this.opts,
        ),
      );
      const created = await this.users.findById(meta.id);
      if (!created) throw new Error('users.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.users).findOne({ _id: id }, this.opts));
      return row ? mapUser(row) : null;
    },

    findByEmail: async (email) => {
      const row = asRow(
        await this.col(COLLECTIONS.users).findOne({ email: email.trim().toLowerCase() }, this.opts),
      );
      return row ? mapUser(row) : null;
    },

    findManyByIds: async (ids) => {
      if (ids.length === 0) return [];
      const docs = await this.col(COLLECTIONS.users)
        .find({ _id: { $in: ids } } as Filter<NexusDoc>, this.opts)
        .toArray();
      return docs.map((doc) => mapUser(doc as Row));
    },

    update: async (id, patch) => {
      const set = setDoc(userUpdateFields(patch));
      if (set) {
        await mapConflict('An account with that email address already exists', () =>
          this.col(COLLECTIONS.users).updateOne(
            { _id: id },
            { $set: { ...set, updated_at: nowIso() } },
            this.opts,
          ),
        );
      }
      return this.users.findById(id);
    },

    updateIfMatches: async (id, expected, patch) => {
      const guard: Record<string, unknown> = { _id: id };
      if (expected.role !== undefined) guard.role = expected.role;
      if (expected.status !== undefined) guard.status = expected.status;
      const query = guard as Filter<NexusDoc>;

      const set = setDoc(userUpdateFields(patch));
      if (!set) {
        // Nothing to write: report whether the row still matches, so an empty
        // patch cannot look like a lost race.
        const still = await this.col(COLLECTIONS.users).findOne(query, this.opts);
        return still ? this.users.findById(id) : null;
      }
      const result = await mapConflict('An account with that email address already exists', () =>
        this.col(COLLECTIONS.users).updateOne(
          query,
          { $set: { ...set, updated_at: nowIso() } },
          this.opts,
        ),
      );
      return result.matchedCount > 0 ? this.users.findById(id) : null;
    },

    touchLastLogin: async (id, at) => {
      await this.col(COLLECTIONS.users).updateOne(
        { _id: id },
        { $set: { last_login_at: at, updated_at: nowIso() } },
        this.opts,
      );
    },

    list: async (filter, options) =>
      this.paginate(COLLECTIONS.users, userFilter(filter), NEWEST_FIRST, options, mapUser),

    count: async (filter = {}) =>
      this.col(COLLECTIONS.users).countDocuments(userFilter(filter), this.opts),

    countActiveSuperAdmins: async (excludeUserId) => {
      const query: Record<string, unknown> = { role: 'super_admin', status: 'active' };
      if (excludeUserId !== undefined) query._id = { $ne: excludeUserId };
      return this.col(COLLECTIONS.users).countDocuments(query as Filter<NexusDoc>, this.opts);
    },

    listRecipients: async (filter) => {
      const docs = await this.col(COLLECTIONS.users)
        .find(userFilter(filter), this.opts)
        .sort({ created_at: 1, _id: 1 })
        .toArray();
      return docs.map((doc) => mapUser(doc as Row));
    },
  };

  /* ── organizations ────────────────────────────────────────────────────── */

  readonly organizations: OrganizationRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapConflict('An organization with that name already exists', () =>
        this.col(COLLECTIONS.organizations).insertOne(
          {
            _id: meta.id,
            name: input.name,
            name_lower: input.name.trim().toLowerCase(),
            description: input.description ?? null,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
          } as NexusDoc,
          this.opts,
        ),
      );
      const created = await this.organizations.findById(meta.id);
      if (!created) throw new Error('organizations.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.organizations).findOne({ _id: id }, this.opts));
      return row ? mapOrganization(row) : null;
    },

    findByName: async (name) => {
      const row = asRow(
        await this.col(COLLECTIONS.organizations).findOne(
          { name_lower: name.trim().toLowerCase() },
          this.opts,
        ),
      );
      return row ? mapOrganization(row) : null;
    },

    update: async (id, patch) => {
      const set = setDoc({
        name: patch.name,
        name_lower: patch.name === undefined ? undefined : patch.name.trim().toLowerCase(),
        description: patch.description,
      });
      if (set) {
        await mapConflict('An organization with that name already exists', () =>
          this.col(COLLECTIONS.organizations).updateOne(
            { _id: id },
            { $set: { ...set, updated_at: nowIso() } },
            this.opts,
          ),
        );
      }
      return this.organizations.findById(id);
    },

    list: async (options) =>
      this.paginate(COLLECTIONS.organizations, {}, { name_lower: 1 }, options, mapOrganization),

    delete: async (id) =>
      (await this.col(COLLECTIONS.organizations).deleteOne({ _id: id }, this.opts)).deletedCount >
      0,
  };

  /* ── sessions ─────────────────────────────────────────────────────────── */

  readonly sessions: SessionRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapConflict('Session token collision', () =>
        this.col(COLLECTIONS.sessions).insertOne(
          {
            _id: meta.id,
            token_hash: input.token_hash,
            user_id: input.user_id,
            csrf_token: input.csrf_token,
            expires_at: input.expires_at,
            ip: input.ip ?? null,
            user_agent: input.user_agent ?? null,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
          } as NexusDoc,
          this.opts,
        ),
      );
      const created = await this.sessions.findById(meta.id);
      if (!created) throw new Error('sessions.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.sessions).findOne({ _id: id }, this.opts));
      return row ? mapSession(row) : null;
    },

    findByTokenHash: async (tokenHash) => {
      const row = asRow(
        await this.col(COLLECTIONS.sessions).findOne({ token_hash: tokenHash }, this.opts),
      );
      return row ? mapSession(row) : null;
    },

    touch: async (id, expiresAt) => {
      await this.col(COLLECTIONS.sessions).updateOne(
        { _id: id },
        { $set: { expires_at: expiresAt, updated_at: nowIso() } },
        this.opts,
      );
    },

    delete: async (id) =>
      (await this.col(COLLECTIONS.sessions).deleteOne({ _id: id }, this.opts)).deletedCount > 0,

    deleteByTokenHash: async (tokenHash) =>
      (await this.col(COLLECTIONS.sessions).deleteOne({ token_hash: tokenHash }, this.opts))
        .deletedCount > 0,

    deleteForUser: async (userId) =>
      (await this.col(COLLECTIONS.sessions).deleteMany({ user_id: userId }, this.opts))
        .deletedCount,

    deleteExpired: async (now) =>
      (
        await this.col(COLLECTIONS.sessions).deleteMany(
          { expires_at: { $lte: now } } as Filter<NexusDoc>,
          this.opts,
        )
      ).deletedCount,
  };

  /* ── apis ─────────────────────────────────────────────────────────────── */

  readonly apis: ApiRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapConflict('An API with that slug already exists', () =>
        this.col(COLLECTIONS.apis).insertOne(
          {
            _id: meta.id,
            name: input.name,
            slug: input.slug,
            slug_lower: input.slug.trim().toLowerCase(),
            description: input.description ?? null,
            owner_user_id: input.owner_user_id,
            ferrum_proxy_id: input.ferrum_proxy_id ?? null,
            upstream_url: input.upstream_url ?? null,
            namespace: input.namespace,
            version: input.version,
            spec_format: input.spec_format,
            requestable: input.requestable,
            auth_plugin: input.auth_plugin,
            rate_limit: normalizeJson(input.rate_limit ?? null),
            cors: normalizeJson(input.cors ?? null),
            allowed_methods: normalizeJson(input.allowed_methods ?? null),
            timeouts: normalizeJson(input.timeouts ?? null),
            circuit_breaker: input.circuit_breaker ?? false,
            status: input.status,
            visibility: input.visibility,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
          } as NexusDoc,
          this.opts,
        ),
      );
      const created = await this.apis.findById(meta.id);
      if (!created) throw new Error('apis.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.apis).findOne({ _id: id }, this.opts));
      return row ? mapApi(row) : null;
    },

    findBySlug: async (slug) => {
      const row = asRow(
        await this.col(COLLECTIONS.apis).findOne(
          { slug_lower: slug.trim().toLowerCase() },
          this.opts,
        ),
      );
      return row ? mapApi(row) : null;
    },

    findByProxyId: async (ferrumProxyId) => {
      const row = asRow(
        await this.col(COLLECTIONS.apis).findOne({ ferrum_proxy_id: ferrumProxyId }, this.opts),
      );
      return row ? mapApi(row) : null;
    },

    findManyByIds: async (ids) => {
      if (ids.length === 0) return [];
      const docs = await this.col(COLLECTIONS.apis)
        .find({ _id: { $in: ids } } as Filter<NexusDoc>, this.opts)
        .toArray();
      return docs.map((doc) => mapApi(doc as Row));
    },

    update: async (id, patch) => {
      const set = setDoc({
        name: patch.name,
        slug: patch.slug,
        slug_lower: patch.slug === undefined ? undefined : patch.slug.trim().toLowerCase(),
        description: patch.description,
        owner_user_id: patch.owner_user_id,
        ferrum_proxy_id: patch.ferrum_proxy_id,
        upstream_url: patch.upstream_url,
        namespace: patch.namespace,
        version: patch.version,
        requestable: patch.requestable,
        auth_plugin: patch.auth_plugin,
        rate_limit: patch.rate_limit === undefined ? undefined : normalizeJson(patch.rate_limit),
        cors: patch.cors === undefined ? undefined : normalizeJson(patch.cors),
        allowed_methods:
          patch.allowed_methods === undefined ? undefined : normalizeJson(patch.allowed_methods),
        timeouts: patch.timeouts === undefined ? undefined : normalizeJson(patch.timeouts),
        circuit_breaker: patch.circuit_breaker,
        status: patch.status,
        visibility: patch.visibility,
      });
      if (set) {
        await mapConflict('An API with that slug already exists', () =>
          this.col(COLLECTIONS.apis).updateOne(
            { _id: id },
            { $set: { ...set, updated_at: nowIso() } },
            this.opts,
          ),
        );
      }
      return this.apis.findById(id);
    },

    list: async (filter, options) =>
      this.paginate(COLLECTIONS.apis, apiFilter(filter), NEWEST_FIRST, options, mapApi),

    count: async (filter = {}) =>
      this.col(COLLECTIONS.apis).countDocuments(apiFilter(filter), this.opts),

    listIdsByOwner: async (ownerUserId) => {
      const docs = await this.col(COLLECTIONS.apis)
        .find({ owner_user_id: ownerUserId }, this.opts)
        .project({ _id: 1 })
        .toArray();
      return docs.map((doc) => str((doc as Row)._id));
    },

    delete: async (id) =>
      (await this.col(COLLECTIONS.apis).deleteOne({ _id: id }, this.opts)).deletedCount > 0,
  };

  /* ── apiSpecs ─────────────────────────────────────────────────────────── */

  readonly apiSpecs: ApiSpecRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapConflict('That spec revision already exists', () =>
        // Clear the previous current revision first so the partial unique index
        // never sees two, exactly as the SQL adapters do — and, like them, do
        // both halves in **one** transaction. Two loose writes leave the API
        // with no current spec at all when the process dies between them.
        this.inTransaction(async (tx) => {
          if (input.is_current) {
            await tx
              .col(COLLECTIONS.apiSpecs)
              .updateMany(
                { api_id: input.api_id, is_current: true },
                { $set: { is_current: false, updated_at: meta.updated_at } },
                tx.opts,
              );
          }
          await tx.col(COLLECTIONS.apiSpecs).insertOne(
            {
              _id: meta.id,
              api_id: input.api_id,
              version: input.version,
              raw_spec: input.raw_spec,
              parsed_title: input.parsed_title ?? null,
              parsed_version: input.parsed_version ?? null,
              is_current: input.is_current,
              created_at: meta.created_at,
              updated_at: meta.updated_at,
            } as NexusDoc,
            tx.opts,
          );
        }),
      );
      const created = await this.apiSpecs.findById(meta.id);
      if (!created) throw new Error('apiSpecs.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.apiSpecs).findOne({ _id: id }, this.opts));
      return row ? mapApiSpec(row) : null;
    },

    findCurrentByApi: async (apiId) => {
      const row = asRow(
        await this.col(COLLECTIONS.apiSpecs).findOne(
          { api_id: apiId, is_current: true },
          this.opts,
        ),
      );
      return row ? mapApiSpec(row) : null;
    },

    setCurrent: async (apiId, specId) => {
      const at = nowIso();
      // One transaction around the whole swap; see `create` above.
      await this.inTransaction(async (tx) => {
        await tx
          .col(COLLECTIONS.apiSpecs)
          .updateMany(
            { api_id: apiId, _id: { $ne: specId } } as Filter<NexusDoc>,
            { $set: { is_current: false, updated_at: at } },
            tx.opts,
          );
        await tx
          .col(COLLECTIONS.apiSpecs)
          .updateOne(
            { api_id: apiId, _id: specId } as Filter<NexusDoc>,
            { $set: { is_current: true, updated_at: at } },
            tx.opts,
          );
      });
    },

    list: async (filter, options) => {
      const query: Record<string, unknown> = {};
      if (filter.api_id !== undefined) query.api_id = filter.api_id;
      if (filter.is_current !== undefined) query.is_current = filter.is_current;
      return this.paginate(
        COLLECTIONS.apiSpecs,
        query as Filter<NexusDoc>,
        NEWEST_FIRST,
        options,
        mapApiSpec,
      );
    },

    delete: async (id) =>
      (await this.col(COLLECTIONS.apiSpecs).deleteOne({ _id: id }, this.opts)).deletedCount > 0,

    deleteByApi: async (apiId) =>
      (await this.col(COLLECTIONS.apiSpecs).deleteMany({ api_id: apiId }, this.opts)).deletedCount,
  };

  /* ── accessRequests ───────────────────────────────────────────────────── */

  readonly accessRequests: AccessRequestRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapConflict('You already have a pending request for this API', () =>
        this.col(COLLECTIONS.accessRequests).insertOne(
          {
            _id: meta.id,
            api_id: input.api_id,
            user_id: input.user_id,
            justification: input.justification,
            status: input.status,
            decided_by: input.decided_by ?? null,
            decided_at: input.decided_at ?? null,
            decision_note: input.decision_note ?? null,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
          } as NexusDoc,
          this.opts,
        ),
      );
      const created = await this.accessRequests.findById(meta.id);
      if (!created) throw new Error('accessRequests.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.accessRequests).findOne({ _id: id }, this.opts));
      return row ? mapAccessRequest(row) : null;
    },

    update: async (id, patch) => {
      const set = setDoc(accessRequestUpdateFields(patch));
      if (set) {
        await mapConflict('You already have a pending request for this API', () =>
          this.col(COLLECTIONS.accessRequests).updateOne(
            { _id: id },
            { $set: { ...set, updated_at: nowIso() } },
            this.opts,
          ),
        );
      }
      return this.accessRequests.findById(id);
    },

    updateIfStatus: async (id, expected, patch) => {
      // A single-document `updateOne` is atomic in MongoDB, so the status in
      // the filter is the compare half of the compare-and-set exactly as the
      // SQL adapters' `AND status = ?` is.
      const query = { _id: id, status: expected } as Filter<NexusDoc>;
      const set = setDoc(accessRequestUpdateFields(patch));
      if (!set) {
        const still = await this.col(COLLECTIONS.accessRequests).findOne(query, this.opts);
        return still ? this.accessRequests.findById(id) : null;
      }
      const result = await mapConflict('You already have a pending request for this API', () =>
        this.col(COLLECTIONS.accessRequests).updateOne(
          query,
          { $set: { ...set, updated_at: nowIso() } },
          this.opts,
        ),
      );
      return result.matchedCount > 0 ? this.accessRequests.findById(id) : null;
    },

    list: async (filter, options) =>
      this.paginate(
        COLLECTIONS.accessRequests,
        accessRequestFilter(filter),
        NEWEST_FIRST,
        options,
        mapAccessRequest,
      ),

    findPendingByApiAndUser: async (apiId, userId) => {
      const row = asRow(
        await this.col(COLLECTIONS.accessRequests).findOne(
          { api_id: apiId, user_id: userId, status: 'pending' },
          this.opts,
        ),
      );
      return row ? mapAccessRequest(row) : null;
    },

    findLatestByApiAndUser: async (apiId, userId) => {
      const docs = await this.col(COLLECTIONS.accessRequests)
        .find({ api_id: apiId, user_id: userId }, this.opts)
        .sort(NEWEST_FIRST)
        .limit(1)
        .toArray();
      const row = asRow(docs[0]);
      return row ? mapAccessRequest(row) : null;
    },

    listLatestForUser: async (userId, apiIds) => {
      if (apiIds.length === 0) return [];
      const docs = await this.col(COLLECTIONS.accessRequests)
        .aggregate(
          [
            { $match: { user_id: userId, api_id: { $in: apiIds } } },
            { $sort: { created_at: -1, _id: -1 } },
            { $group: { _id: '$api_id', doc: { $first: '$$ROOT' } } },
            { $replaceRoot: { newRoot: '$doc' } },
          ],
          this.opts,
        )
        .toArray();
      return docs.map((doc) => mapAccessRequest(doc as Row));
    },

    count: async (filter) =>
      this.col(COLLECTIONS.accessRequests).countDocuments(accessRequestFilter(filter), this.opts),

    deleteByApi: async (apiId) =>
      (await this.col(COLLECTIONS.accessRequests).deleteMany({ api_id: apiId }, this.opts))
        .deletedCount,
  };

  /* ── grants ───────────────────────────────────────────────────────────── */

  readonly grants: GrantRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapConflict('An active grant already exists for this API and user', () =>
        this.col(COLLECTIONS.grants).insertOne(
          {
            _id: meta.id,
            api_id: input.api_id,
            user_id: input.user_id,
            access_request_id: input.access_request_id ?? null,
            acl_group: input.acl_group,
            status: input.status,
            granted_by: input.granted_by,
            revoked_by: input.revoked_by ?? null,
            revoked_at: input.revoked_at ?? null,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
          } as NexusDoc,
          this.opts,
        ),
      );
      const created = await this.grants.findById(meta.id);
      if (!created) throw new Error('grants.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.grants).findOne({ _id: id }, this.opts));
      return row ? mapGrant(row) : null;
    },

    update: async (id, patch) => {
      const set = setDoc(grantUpdateFields(patch));
      if (set) {
        await mapConflict('An active grant already exists for this API and user', () =>
          this.col(COLLECTIONS.grants).updateOne(
            { _id: id },
            { $set: { ...set, updated_at: nowIso() } },
            this.opts,
          ),
        );
      }
      return this.grants.findById(id);
    },

    updateIfStatus: async (id, expected, patch) => {
      // A single-document `updateOne` is atomic in MongoDB, so the status in
      // the filter is the compare half of the compare-and-set exactly as the
      // SQL adapters' `AND status = ?` is.
      const query = { _id: id, status: expected } as Filter<NexusDoc>;
      const set = setDoc(grantUpdateFields(patch));
      if (!set) {
        const still = await this.col(COLLECTIONS.grants).findOne(query, this.opts);
        return still ? this.grants.findById(id) : null;
      }
      const result = await mapConflict('An active grant already exists for this API and user', () =>
        this.col(COLLECTIONS.grants).updateOne(
          query,
          { $set: { ...set, updated_at: nowIso() } },
          this.opts,
        ),
      );
      return result.matchedCount > 0 ? this.grants.findById(id) : null;
    },

    list: async (filter, options) =>
      this.paginate(COLLECTIONS.grants, grantFilter(filter), NEWEST_FIRST, options, mapGrant),

    findActiveByApiAndUser: async (apiId, userId) => {
      const row = asRow(
        await this.col(COLLECTIONS.grants).findOne(
          { api_id: apiId, user_id: userId, status: 'active' },
          this.opts,
        ),
      );
      return row ? mapGrant(row) : null;
    },

    listActiveByUser: async (userId) => {
      const docs = await this.col(COLLECTIONS.grants)
        .find({ user_id: userId, status: 'active' }, this.opts)
        .toArray();
      return docs.map((doc) => mapGrant(doc as Row));
    },

    listActiveByApi: async (apiId) => {
      const docs = await this.col(COLLECTIONS.grants)
        .find({ api_id: apiId, status: 'active' }, this.opts)
        .toArray();
      return docs.map((doc) => mapGrant(doc as Row));
    },

    count: async (filter) =>
      this.col(COLLECTIONS.grants).countDocuments(grantFilter(filter), this.opts),

    deleteByApi: async (apiId) =>
      (await this.col(COLLECTIONS.grants).deleteMany({ api_id: apiId }, this.opts)).deletedCount,
  };

  /* ── credentials ──────────────────────────────────────────────────────── */

  readonly credentials: CredentialRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapConflict('That credential is already registered', () =>
        this.col(COLLECTIONS.credentials).insertOne(
          {
            _id: meta.id,
            user_id: input.user_id,
            ferrum_consumer_id: input.ferrum_consumer_id,
            credential_type: input.credential_type,
            ferrum_credential_id: input.ferrum_credential_id,
            fingerprint: input.fingerprint,
            last4: input.last4,
            label: input.label ?? null,
            status: input.status,
            rotated_from_id: input.rotated_from_id ?? null,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
          } as NexusDoc,
          this.opts,
        ),
      );
      const created = await this.credentials.findById(meta.id);
      if (!created) throw new Error('credentials.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.credentials).findOne({ _id: id }, this.opts));
      return row ? mapCredential(row) : null;
    },

    update: async (id, patch) => {
      const set = setDoc({
        label: patch.label,
        status: patch.status,
        ferrum_credential_id: patch.ferrum_credential_id,
        rotated_from_id: patch.rotated_from_id,
      });
      if (set) {
        await this.col(COLLECTIONS.credentials).updateOne(
          { _id: id },
          { $set: { ...set, updated_at: nowIso() } },
          this.opts,
        );
      }
      return this.credentials.findById(id);
    },

    list: async (filter, options) =>
      this.paginate(
        COLLECTIONS.credentials,
        credentialFilter(filter),
        NEWEST_FIRST,
        options,
        mapCredential,
      ),

    listByConsumer: async (ferrumConsumerId, type) => {
      const query: Record<string, unknown> = { ferrum_consumer_id: ferrumConsumerId };
      if (type !== undefined) query.credential_type = type;
      const docs = await this.col(COLLECTIONS.credentials)
        .find(query as Filter<NexusDoc>, this.opts)
        .sort({ created_at: 1, _id: 1 })
        .toArray();
      return docs.map((doc) => mapCredential(doc as Row));
    },

    findByFingerprint: async (fingerprint) => {
      const row = asRow(
        await this.col(COLLECTIONS.credentials).findOne({ fingerprint }, this.opts),
      );
      return row ? mapCredential(row) : null;
    },

    count: async (filter) =>
      this.col(COLLECTIONS.credentials).countDocuments(credentialFilter(filter), this.opts),

    delete: async (id) =>
      (await this.col(COLLECTIONS.credentials).deleteOne({ _id: id }, this.opts)).deletedCount > 0,
  };

  /* ── consumers ────────────────────────────────────────────────────────── */

  readonly consumers: ConsumerRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapConflict('A gateway consumer already exists for this user', () =>
        this.col(COLLECTIONS.consumers).insertOne(
          {
            _id: meta.id,
            user_id: input.user_id,
            namespace: input.namespace,
            ferrum_consumer_id: input.ferrum_consumer_id,
            ferrum_username: input.ferrum_username,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
          } as NexusDoc,
          this.opts,
        ),
      );
      const created = await this.consumers.findById(meta.id);
      if (!created) throw new Error('consumers.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.consumers).findOne({ _id: id }, this.opts));
      return row ? mapConsumer(row) : null;
    },

    findByUserAndNamespace: async (userId, namespace) => {
      const row = asRow(
        await this.col(COLLECTIONS.consumers).findOne({ user_id: userId, namespace }, this.opts),
      );
      return row ? mapConsumer(row) : null;
    },

    findByFerrumId: async (ferrumConsumerId) => {
      const row = asRow(
        await this.col(COLLECTIONS.consumers).findOne(
          { ferrum_consumer_id: ferrumConsumerId },
          this.opts,
        ),
      );
      return row ? mapConsumer(row) : null;
    },

    findByUsername: async (namespace, ferrumUsername) => {
      const row = asRow(
        await this.col(COLLECTIONS.consumers).findOne(
          { namespace, ferrum_username: ferrumUsername },
          this.opts,
        ),
      );
      return row ? mapConsumer(row) : null;
    },

    update: async (id, patch) => {
      const set = setDoc({
        ferrum_consumer_id: patch.ferrum_consumer_id,
        ferrum_username: patch.ferrum_username,
        namespace: patch.namespace,
      });
      if (set) {
        await mapConflict('A gateway consumer already exists for this user', () =>
          this.col(COLLECTIONS.consumers).updateOne(
            { _id: id },
            { $set: { ...set, updated_at: nowIso() } },
            this.opts,
          ),
        );
      }
      return this.consumers.findById(id);
    },

    list: async (filter, options) => {
      const query: Record<string, unknown> = {};
      if (filter.user_id !== undefined) query.user_id = filter.user_id;
      if (filter.namespace !== undefined) query.namespace = filter.namespace;
      return this.paginate(
        COLLECTIONS.consumers,
        query as Filter<NexusDoc>,
        NEWEST_FIRST,
        options,
        mapConsumer,
      );
    },

    delete: async (id) =>
      (await this.col(COLLECTIONS.consumers).deleteOne({ _id: id }, this.opts)).deletedCount > 0,
  };

  /* ── threads ──────────────────────────────────────────────────────────── */

  readonly threads: ThreadRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await this.col(COLLECTIONS.threads).insertOne(
        {
          _id: meta.id,
          subject: input.subject,
          api_id: input.api_id ?? null,
          created_by: input.created_by,
          participant_a: input.participant_a,
          participant_b: input.participant_b ?? null,
          last_message_at: input.last_message_at ?? null,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
        } as NexusDoc,
        this.opts,
      );
      const created = await this.threads.findById(meta.id);
      if (!created) throw new Error('threads.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.threads).findOne({ _id: id }, this.opts));
      return row ? mapThread(row) : null;
    },

    update: async (id, patch) => {
      const set = setDoc({
        subject: patch.subject,
        api_id: patch.api_id,
        participant_b: patch.participant_b,
        last_message_at: patch.last_message_at,
      });
      if (set) {
        await this.col(COLLECTIONS.threads).updateOne(
          { _id: id },
          { $set: { ...set, updated_at: nowIso() } },
          this.opts,
        );
      }
      return this.threads.findById(id);
    },

    list: async (filter, options) => {
      const conditions: Record<string, unknown>[] = [];
      if (filter.participant_user_id !== undefined) {
        // Seats only — `created_by` is provenance, not membership. See
        // `ThreadFilter.participant_user_id`.
        conditions.push({
          $or: [
            { participant_a: filter.participant_user_id },
            { participant_b: filter.participant_user_id },
          ],
        });
      }
      if (filter.api_id !== undefined) conditions.push({ api_id: filter.api_id });
      if (filter.q !== undefined && filter.q.trim() !== '') {
        conditions.push({ subject: containsInsensitive(filter.q.trim()) });
      }
      const query = (conditions.length === 0 ? {} : { $and: conditions }) as Filter<NexusDoc>;

      const { limit, offset } = page(options);
      const collection = this.col(COLLECTIONS.threads);
      const total = await collection.countDocuments(query, this.opts);
      // `ORDER BY coalesce(last_message_at, created_at) DESC` is an expression
      // sort, which `find()` cannot express — hence the pipeline.
      const docs = await collection
        .aggregate(
          [
            { $match: query },
            { $addFields: { _sort_key: { $ifNull: ['$last_message_at', '$created_at'] } } },
            { $sort: { _sort_key: -1, _id: -1 } },
            { $skip: offset },
            { $limit: limit },
          ],
          this.opts,
        )
        .toArray();
      return { items: docs.map((doc) => mapThread(doc as Row)), total };
    },

    findExisting: async (participantA, participantB, apiId) => {
      const docs = await this.col(COLLECTIONS.threads)
        .find(
          {
            api_id: apiId,
            $or: [
              { participant_a: participantA, participant_b: participantB },
              { participant_a: participantB, participant_b: participantA },
            ],
          } as Filter<NexusDoc>,
          this.opts,
        )
        .sort({ created_at: -1 })
        .limit(1)
        .toArray();
      const row = asRow(docs[0]);
      return row ? mapThread(row) : null;
    },

    touchLastMessage: async (threadId, at) => {
      await this.col(COLLECTIONS.threads).updateOne(
        { _id: threadId },
        { $set: { last_message_at: at, updated_at: nowIso() } },
        this.opts,
      );
    },

    delete: async (id) =>
      (await this.col(COLLECTIONS.threads).deleteOne({ _id: id }, this.opts)).deletedCount > 0,
  };

  /* ── messages ─────────────────────────────────────────────────────────── */

  readonly messages: MessageRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await this.col(COLLECTIONS.messages).insertOne(
        {
          _id: meta.id,
          thread_id: input.thread_id,
          sender_user_id: input.sender_user_id,
          body: input.body,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
        } as NexusDoc,
        this.opts,
      );
      const created = await this.messages.findById(meta.id);
      if (!created) throw new Error('messages.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.messages).findOne({ _id: id }, this.opts));
      return row ? mapMessage(row) : null;
    },

    listByThread: async (threadId, options) =>
      this.paginate(
        COLLECTIONS.messages,
        { thread_id: threadId },
        { created_at: 1, _id: 1 },
        options,
        mapMessage,
      ),

    findLatestByThread: async (threadId) => {
      const docs = await this.col(COLLECTIONS.messages)
        .find({ thread_id: threadId }, this.opts)
        .sort(NEWEST_FIRST)
        .limit(1)
        .toArray();
      const row = asRow(docs[0]);
      return row ? mapMessage(row) : null;
    },

    countByThread: async (threadId) =>
      this.col(COLLECTIONS.messages).countDocuments({ thread_id: threadId }, this.opts),

    deleteByThread: async (threadId) =>
      (await this.col(COLLECTIONS.messages).deleteMany({ thread_id: threadId }, this.opts))
        .deletedCount,
  };

  /* ── notifications ────────────────────────────────────────────────────── */

  readonly notifications: NotificationRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await this.col(COLLECTIONS.notifications).insertOne(
        {
          _id: meta.id,
          user_id: input.user_id,
          type: input.type,
          title: input.title,
          body: input.body,
          link: input.link ?? null,
          read_at: input.read_at ?? null,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
        } as NexusDoc,
        this.opts,
      );
      const created = await this.notifications.findById(meta.id);
      if (!created) throw new Error('notifications.create: row vanished immediately after insert');
      return created;
    },

    createMany: async (inputs) => {
      if (inputs.length === 0) return [];
      const docs = inputs.map((input) => {
        const meta = stamps(input);
        return {
          _id: meta.id,
          user_id: input.user_id,
          type: input.type,
          title: input.title,
          body: input.body,
          link: input.link ?? null,
          read_at: input.read_at ?? null,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
        } as NexusDoc;
      });
      await this.col(COLLECTIONS.notifications).insertMany(docs, this.opts);
      return docs.map((doc) => mapNotification(doc as Row));
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.notifications).findOne({ _id: id }, this.opts));
      return row ? mapNotification(row) : null;
    },

    list: async (filter, options) => {
      const query: Record<string, unknown> = { user_id: filter.user_id };
      if (filter.unread === true) query.read_at = null;
      if (filter.unread === false) query.read_at = { $ne: null };
      if (filter.type !== undefined) query.type = filter.type;
      return this.paginate(
        COLLECTIONS.notifications,
        query as Filter<NexusDoc>,
        NEWEST_FIRST,
        options,
        mapNotification,
      );
    },

    countUnread: async (userId) =>
      this.col(COLLECTIONS.notifications).countDocuments(
        { user_id: userId, read_at: null },
        this.opts,
      ),

    markRead: async (userId, ids, at) => {
      if (ids.length === 0) return 0;
      const result = await this.col(COLLECTIONS.notifications).updateMany(
        { user_id: userId, read_at: null, _id: { $in: ids } } as Filter<NexusDoc>,
        { $set: { read_at: at, updated_at: nowIso() } },
        this.opts,
      );
      return result.modifiedCount;
    },

    markAllRead: async (userId, at) => {
      const result = await this.col(COLLECTIONS.notifications).updateMany(
        { user_id: userId, read_at: null },
        { $set: { read_at: at, updated_at: nowIso() } },
        this.opts,
      );
      return result.modifiedCount;
    },
  };

  /* ── emailOutbox ──────────────────────────────────────────────────────── */

  readonly emailOutbox: EmailOutboxRepo = {
    enqueue: async (input) => {
      const key = input.idempotency_key ?? null;
      if (key !== null) {
        const existing = await this.emailOutbox.findByIdempotencyKey(key);
        if (existing) return { entry: existing, created: false };
      }
      const meta = stamps({ id: input.id });
      try {
        await this.col(COLLECTIONS.emailOutbox).insertOne(
          {
            _id: meta.id,
            to_email: input.to_email,
            subject: input.subject,
            body_html: input.body_html,
            body_text: input.body_text,
            status: 'pending',
            attempts: 0,
            next_attempt_at: input.next_attempt_at ?? meta.created_at,
            last_error: null,
            idempotency_key: key,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
          } as NexusDoc,
          this.opts,
        );
      } catch (error) {
        // Lost a race on the idempotency key — return the winner.
        if (key !== null) {
          const existing = await this.emailOutbox.findByIdempotencyKey(key);
          if (existing) return { entry: existing, created: false };
        }
        throw error;
      }
      const entry = await this.emailOutbox.findById(meta.id);
      if (!entry) throw new Error('emailOutbox.enqueue: row vanished immediately after insert');
      return { entry, created: true };
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.emailOutbox).findOne({ _id: id }, this.opts));
      return row ? mapOutbox(row) : null;
    },

    findByIdempotencyKey: async (key) => {
      const row = asRow(
        await this.col(COLLECTIONS.emailOutbox).findOne({ idempotency_key: key }, this.opts),
      );
      return row ? mapOutbox(row) : null;
    },

    claimDue: async (now, limit) => {
      // `findOneAndUpdate` is atomic on its own, so the claim needs no
      // transaction: a row can only be flipped out of `pending` once, and two
      // workers therefore never claim the same one.
      const wanted = Math.max(1, Math.floor(limit));
      const claimed: EmailOutboxRecord[] = [];
      for (let i = 0; i < wanted; i += 1) {
        const doc = await this.col(COLLECTIONS.emailOutbox).findOneAndUpdate(
          {
            status: 'pending',
            $or: [{ next_attempt_at: null }, { next_attempt_at: { $lte: now } }],
          } as Filter<NexusDoc>,
          // An aggregation-pipeline update: `$inc` would be equivalent, but
          // `NexusDoc`'s `unknown` index signature hides `attempts` from the
          // driver's numeric-field inference, and this form stays typed.
          [
            {
              $set: {
                status: 'sending',
                updated_at: nowIso(),
                attempts: { $add: [{ $ifNull: ['$attempts', 0] }, 1] },
              },
            },
          ],
          {
            ...this.opts,
            sort: OUTBOX_CLAIM_ORDER,
            returnDocument: 'after',
          },
        );
        const row = asRow(doc);
        if (!row) break;
        claimed.push(mapOutbox(row));
      }
      return claimed;
    },

    markSent: async (id, at) => {
      await this.col(COLLECTIONS.emailOutbox).updateOne(
        { _id: id },
        { $set: { status: 'sent', next_attempt_at: null, last_error: null, updated_at: at } },
        this.opts,
      );
    },

    reschedule: async (id, nextAttemptAt, lastError) => {
      await this.col(COLLECTIONS.emailOutbox).updateOne(
        { _id: id },
        {
          $set: {
            status: 'pending',
            next_attempt_at: nextAttemptAt,
            last_error: lastError,
            updated_at: nowIso(),
          },
        },
        this.opts,
      );
    },

    markFailed: async (id, lastError) => {
      await this.col(COLLECTIONS.emailOutbox).updateOne(
        { _id: id },
        {
          $set: {
            status: 'failed',
            next_attempt_at: null,
            last_error: lastError,
            updated_at: nowIso(),
          },
        },
        this.opts,
      );
    },

    releaseStale: async (olderThan) => {
      const at = nowIso();
      const result = await this.col(COLLECTIONS.emailOutbox).updateMany(
        { status: 'sending', updated_at: { $lte: olderThan } } as Filter<NexusDoc>,
        { $set: { status: 'pending', next_attempt_at: at, updated_at: at } },
        this.opts,
      );
      return result.modifiedCount;
    },

    list: async (filter, options) => {
      const query: Record<string, unknown> = {};
      if (filter.status !== undefined) query.status = filter.status;
      if (filter.to_email !== undefined) query.to_email = equalsInsensitive(filter.to_email);
      return this.paginate(
        COLLECTIONS.emailOutbox,
        query as Filter<NexusDoc>,
        NEWEST_FIRST,
        options,
        mapOutbox,
      );
    },
  };

  /* ── auditLogs ────────────────────────────────────────────────────────── */

  readonly auditLogs: AuditLogRepo = {
    create: async (input) => {
      const meta = stamps(input);
      const doc: NexusDoc = {
        _id: meta.id,
        actor_user_id: input.actor_user_id ?? null,
        actor_role: input.actor_role ?? null,
        action: input.action,
        target_type: input.target_type,
        target_id: input.target_id ?? null,
        details: normalizeJson(input.details ?? {}),
        ip: input.ip ?? null,
        created_at: meta.created_at,
      };
      await this.col(COLLECTIONS.auditLogs).insertOne(doc, this.opts);
      return mapAuditLog(doc as Row);
    },

    list: async (filter, options) =>
      this.paginate(COLLECTIONS.auditLogs, auditFilter(filter), NEWEST_FIRST, options, mapAuditLog),

    count: async (filter) =>
      this.col(COLLECTIONS.auditLogs).countDocuments(auditFilter(filter), this.opts),
  };

  /* ── settings ─────────────────────────────────────────────────────────── */

  readonly settings: SettingRepo = {
    get: async (key) => {
      const row = asRow(await this.col(COLLECTIONS.settings).findOne({ _id: key }, this.opts));
      return row ? mapSetting(row) : null;
    },

    getMany: async (keys) => {
      if (keys.length === 0) return [];
      const docs = await this.col(COLLECTIONS.settings)
        .find({ _id: { $in: keys } } as Filter<NexusDoc>, this.opts)
        .toArray();
      return docs.map((doc) => mapSetting(doc as Row));
    },

    set: async (key, value, encrypted = false) => {
      await this.upsertSetting(key, value, encrypted);
      const stored = await this.settings.get(key);
      if (!stored) throw new Error('settings.set: row vanished immediately after upsert');
      return stored;
    },

    insertIfAbsent: async (key, value, encrypted = false) => {
      const at = nowIso();
      try {
        // The setting key *is* `_id`, so a plain insert is the atomic claim:
        // the server rejects the second one with a duplicate-key error even
        // when both callers looked and saw nothing.
        await this.col(COLLECTIONS.settings).insertOne(
          {
            _id: key,
            value: normalizeJson(value ?? null),
            encrypted,
            created_at: at,
            updated_at: at,
          } as NexusDoc,
          this.opts,
        );
        return true;
      } catch (error) {
        if ((error as { code?: unknown }).code === 11000) return false;
        throw error;
      }
    },

    setMany: async (entries) => {
      if (entries.length === 0) return;
      for (const entry of entries) {
        await this.upsertSetting(entry.key, entry.value, entry.encrypted ?? false);
      }
    },

    delete: async (key) =>
      (await this.col(COLLECTIONS.settings).deleteOne({ _id: key }, this.opts)).deletedCount > 0,

    all: async () => {
      const docs = await this.col(COLLECTIONS.settings)
        .find({}, this.opts)
        .sort({ _id: 1 })
        .toArray();
      return docs.map((doc) => mapSetting(doc as Row));
    },
  };

  private async upsertSetting(key: string, value: unknown, encrypted: boolean): Promise<void> {
    const at = nowIso();
    await this.col(COLLECTIONS.settings).updateOne(
      { _id: key },
      {
        $set: { value: normalizeJson(value ?? null), encrypted, updated_at: at },
        $setOnInsert: { created_at: at },
      },
      { ...this.opts, upsert: true },
    );
  }

  /* ── emailTemplates ───────────────────────────────────────────────────── */

  readonly emailTemplates: EmailTemplateRepo = {
    get: async (key) => {
      const row = asRow(await this.col(COLLECTIONS.emailTemplates).findOne({ key }, this.opts));
      return row ? mapEmailTemplate(row) : null;
    },

    upsert: async (key, value) => {
      const at = nowIso();
      await this.col(COLLECTIONS.emailTemplates).updateOne(
        { key },
        {
          $set: {
            subject: value.subject,
            body_html: value.body_html,
            body_text: value.body_text,
            updated_at: at,
          },
          $setOnInsert: { _id: newId(), key, created_at: at },
        },
        { ...this.opts, upsert: true },
      );
      const stored = await this.emailTemplates.get(key);
      if (!stored) throw new Error('emailTemplates.upsert: row vanished immediately after upsert');
      return stored;
    },

    list: async () => {
      const docs = await this.col(COLLECTIONS.emailTemplates)
        .find({}, this.opts)
        .sort({ key: 1 })
        .toArray();
      return docs.map((doc) => mapEmailTemplate(doc as Row));
    },

    delete: async (key) =>
      (await this.col(COLLECTIONS.emailTemplates).deleteOne({ key }, this.opts)).deletedCount > 0,
  };

  /* ── verificationTokens ───────────────────────────────────────────────── */

  readonly verificationTokens: VerificationTokenRepo = {
    create: async (input) => {
      const meta = stamps(input);
      const doc: NexusDoc = {
        _id: meta.id,
        user_id: input.user_id,
        token_hash: input.token_hash,
        purpose: input.purpose,
        expires_at: input.expires_at,
        used_at: input.used_at ?? null,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
      };
      await mapConflict('Verification token collision', () =>
        this.col(COLLECTIONS.verificationTokens).insertOne(doc, this.opts),
      );
      return mapVerificationToken(doc as Row);
    },

    findByTokenHash: async (tokenHash, purpose) => {
      const row = asRow(
        await this.col(COLLECTIONS.verificationTokens).findOne(
          { token_hash: tokenHash, purpose },
          this.opts,
        ),
      );
      return row ? mapVerificationToken(row) : null;
    },

    findLatestLiveForUser: async (userId, purpose, now) => {
      const row = asRow(
        await this.col(COLLECTIONS.verificationTokens).findOne(
          {
            user_id: userId,
            purpose,
            used_at: null,
            expires_at: { $gt: now },
          } as Filter<NexusDoc>,
          { ...this.opts, sort: { created_at: -1, _id: -1 } },
        ),
      );
      return row ? mapVerificationToken(row) : null;
    },

    markUsed: async (id, at) => {
      const result = await this.col(COLLECTIONS.verificationTokens).updateOne(
        { _id: id, used_at: null } as Filter<NexusDoc>,
        { $set: { used_at: at, updated_at: nowIso() } },
        this.opts,
      );
      return result.modifiedCount > 0;
    },

    deleteForUser: async (userId, purpose) =>
      (
        await this.col(COLLECTIONS.verificationTokens).deleteMany(
          purpose === undefined ? { user_id: userId } : { user_id: userId, purpose },
          this.opts,
        )
      ).deletedCount,

    deleteExpired: async (now) =>
      (
        await this.col(COLLECTIONS.verificationTokens).deleteMany(
          { expires_at: { $lte: now } } as Filter<NexusDoc>,
          this.opts,
        )
      ).deletedCount,
  };
}

/* ── Factory ────────────────────────────────────────────────────────────── */

/**
 * Build the MongoDB store from `config.db.url`.
 *
 * The database name comes from the URL path; when it is absent the driver's
 * default (`test`) applies, so deployments should always spell it out. The
 * caller still owns `init()` — which is where the replica-set check lives — and
 * `migrate()`.
 */
export function createMongoStore(config: NexusConfig): NexusStore {
  const client = new MongoClient(config.db.url, {
    ignoreUndefined: true,
  });
  const ctx: MongoContext = {
    client,
    db: client.db(),
    allowStandalone: config.db.allowStandalone,
    // Assume no transaction support until init() has probed the deployment.
    supportsTransactions: false,
    closed: false,
  };
  return new MongoStore(ctx, null);
}
