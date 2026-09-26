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
 * - **replica set / mongos** — `transaction()` is a real session transaction,
 *   driven by the driver's own `session.withTransaction()`: commit on resolve,
 *   abort on reject, and — the reason it is the driver's loop rather than a
 *   hand-rolled one — the body is **run again** when the server labels the
 *   failure `TransientTransactionError`, and the commit is retried on
 *   `UnknownTransactionCommitResult`. A write conflict is MongoDB asking for
 *   exactly that; not retrying it lost the body's work behind a raw
 *   `MongoServerError`. The driver re-runs with no pause between runs, so the
 *   adapter puts the shared backoff in front of each one and bounds the loop by
 *   wall clock — {@link MONGO_CONTENTION_BUDGET_MS} of contention, inside
 *   {@link MONGO_TRANSACTION_BUDGET_MS} for the transaction as a whole — after
 *   which the caller gets a `CONFLICT`, never a driver error. Bodies must be
 *   re-runnable, which is the contract `adapters/transaction-retry.ts` states.
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
  type UpdateFilter,
} from 'mongodb';

import type {
  AccessRequestStatus,
  ApiPluginTrigger,
  ApiStatus,
  ApiTimeouts,
  ApiGatewayState,
  ApplicationStatus,
  ApiVisibility,
  AuthPluginType,
  CorsConfig,
  CredentialStatus,
  CredentialType,
  DbDriver,
  EmailOutboxStatus,
  EmailTemplateKey,
  GatewayTeardownJobStatus,
  GrantStatus,
  HttpMethod,
  IsoTimestamp,
  NotificationType,
  RateLimitConfig,
  Role,
  SpecEnforcementLevel,
  UserStatus,
  Uuid,
} from '@ferrum-nexus/shared';
import {
  clampPageSize,
  DEFAULT_SPEC_ENFORCEMENT,
  isSpecEnforcementLevel,
} from '@ferrum-nexus/shared';

import type { NexusConfig } from '../../../config/index.js';
import { conflict, NexusError } from '../../../lib/errors.js';
import { newId, nowIso } from '../../../lib/ids.js';
import { fenceTransactionBody } from '../../../lib/lease-fence.js';
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
  ApiGatewayPluginRecord,
  ApiGatewayPluginRepo,
  ApiGatewayPluginRole,
  ApiPluginRecord,
  ApiViewerRecord,
  ApiViewerRepo,
  ApplicationFilter,
  ApplicationRecord,
  ApplicationRepo,
  ApiPluginRepo,
  ApiRecord,
  ApiRepo,
  ApiSpecRecord,
  ApiSpecRepo,
  ApiViewerFilter,
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
  GatewayIdentityRecord,
  GatewayIdentityRepo,
  GatewayTeardownJobFilter,
  GatewayTeardownJobRecord,
  GatewayTeardownJobRepo,
  GrantFilter,
  GrantRecord,
  GrantRepo,
  LeaseRepo,
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
  TransactionOptions,
  UpdateInput,
  UserFilter,
  UserRecord,
  UserRepo,
  VerificationTokenPurpose,
  VerificationTokenRecord,
  VerificationTokenRepo,
} from '../../store.js';
import {
  API_GATEWAY_PLUGIN_ROLES,
  assertLeaseKeyLength,
  SPEC_HISTORY_PRUNE_BATCH,
} from '../../store.js';
import {
  createMongoContentionGate,
  isMongoTransactionContentionError,
  isUnknownTransactionCommitResult,
  MONGO_TRANSACTION_BUDGET_MS,
  transactionContentionError,
} from '../transaction-retry.js';

/* ── Collection names (identical to the SQL table names) ────────────────── */

const COLLECTIONS = {
  organizations: 'organizations',
  users: 'users',
  sessions: 'sessions',
  applications: 'applications',
  apis: 'apis',
  apiSpecs: 'api_specs',
  apiPlugins: 'api_plugins',
  apiGatewayPlugins: 'api_gateway_plugins',
  apiViewers: 'api_viewers',
  accessRequests: 'access_requests',
  grants: 'grants',
  consumers: 'consumers',
  gatewayIdentities: 'gateway_identities',
  credentials: 'credential_metadata',
  threads: 'message_threads',
  messages: 'messages',
  notifications: 'notifications',
  emailOutbox: 'email_outbox',
  gatewayTeardownJobs: 'gateway_teardown_jobs',
  auditLogs: 'audit_logs',
  settings: 'app_settings',
  emailTemplates: 'email_templates',
  verificationTokens: 'email_verification_tokens',
  tokenIssueClaims: 'email_token_issue_claims',
  leases: 'edge_leases',
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

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
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

/**
 * Fold a singular equality and its plural `$in` form onto one field as an
 * `$and` when both are supplied, so a document must satisfy both — exactly like
 * the SQL adapters' `col = ? AND col IN (...)`. Assigning one after the other
 * overwrote the first and silently dropped the singular condition.
 */
function combineEqualityAndIn(
  query: Record<string, unknown>,
  singular: string | undefined,
  plural: readonly string[] | undefined,
  field: string,
): void {
  if (singular !== undefined && plural !== undefined) {
    const existing = Array.isArray(query.$and) ? (query.$and as Record<string, unknown>[]) : [];
    query.$and = [...existing, { [field]: singular }, { [field]: { $in: plural } }];
  } else if (singular !== undefined) {
    query[field] = singular;
  } else if (plural !== undefined) {
    query[field] = { $in: plural };
  }
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
 * Spec revisions as the SQL adapters list them: the current revision first,
 * then history newest-first by publication order. BSON sorts `false` before
 * `true`, so a descending `is_current` puts the current revision at the head
 * exactly as `ORDER BY is_current DESC` does.
 */
const SPEC_REVISIONS_ORDER: Sort = { is_current: -1, revision_seq: -1 };

/** Spec history newest-first; the order retention deletes from the tail of. */
const SPEC_HISTORY_ORDER: Sort = { revision_seq: -1 };

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

/**
 * Decode the `spec_enforcement` field, falling back to `docs_only`.
 *
 * Missing or invalid values must not enable enforcement this binary cannot
 * generate a plugin config for.
 */
function specEnforcement(value: unknown): SpecEnforcementLevel {
  return isSpecEnforcementLevel(value) ? value : DEFAULT_SPEC_ENFORCEMENT;
}

function mapApplication(row: Row): ApplicationRecord {
  return {
    id: str(row._id),
    owner_user_id: str(row.owner_user_id),
    name: str(row.name),
    description: strOrNull(row.description),
    status: str(row.status) as ApplicationStatus,
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
    spec_enforcement: specEnforcement(row.spec_enforcement),
    status: str(row.status) as ApiStatus,
    visibility: str(row.visibility) as ApiVisibility,
    gateway_state: (str(row.gateway_state) || 'deployed') as ApiGatewayState,
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
    revision_seq: num(row.revision_seq),
    created_by: strOrNull(row.created_by),
    rolled_back_from_id: strOrNull(row.rolled_back_from_id),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapApiViewer(row: Row): ApiViewerRecord {
  return {
    id: str(row._id),
    api_id: str(row.api_id),
    user_id: str(row.user_id),
    granted_by: strOrNull(row.granted_by),
    note: strOrNull(row.note),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapApiPlugin(row: Row): ApiPluginRecord {
  return {
    id: str(row._id),
    api_id: str(row.api_id),
    plugin_name: str(row.plugin_name),
    enabled: flag(row.enabled),
    // Mongo stores the config and the trigger as native subdocuments rather
    // than as the JSON text the SQL adapters keep in their `*_json` columns;
    // both sides of the store contract see the same parsed objects.
    config: (row.config ?? {}) as Record<string, unknown>,
    trigger: (row.trigger ?? null) as ApiPluginTrigger | null,
    // Absent on every document written before 015, which is exactly the `null`
    // the SQL dialects get from the new column.
    ferrum_plugin_config_id: strOrNull(row.ferrum_plugin_config_id),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapApiGatewayPlugin(row: Row): ApiGatewayPluginRecord {
  return {
    api_id: str(row.api_id),
    role: str(row.role) as ApiGatewayPluginRole,
    ferrum_plugin_config_id: strOrNull(row.ferrum_plugin_config_id),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapAccessRequest(row: Row): AccessRequestRecord {
  return {
    id: str(row._id),
    api_id: str(row.api_id),
    user_id: str(row.user_id),
    application_id: strOrNull(row.application_id),
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
    application_id: strOrNull(row.application_id),
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
    application_id: strOrNull(row.application_id),
    ferrum_consumer_id: str(row.ferrum_consumer_id),
    credential_type: str(row.credential_type) as CredentialType,
    ferrum_credential_id: str(row.ferrum_credential_id),
    fingerprint: str(row.fingerprint),
    last4: str(row.last4),
    label: strOrNull(row.label),
    status: str(row.status) as CredentialStatus,
    rotated_from_id: strOrNull(row.rotated_from_id),
    // Missing positions read back exactly like an unresolved SQL NULL.
    edge_ordinal: numOrNull(row.edge_ordinal),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapConsumer(row: Row): ConsumerRecord {
  return {
    id: str(row._id),
    user_id: str(row.user_id),
    application_id: strOrNull(row.application_id),
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
    // Only an explicit true marks a broadcast; the default is ordinary mail.
    broadcast: row.broadcast === true,
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
    generation: str(row.generation ?? ''),
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

function mapGatewayIdentity(row: Row): GatewayIdentityRecord {
  return {
    id: str(row._id),
    user_id: str(row.user_id),
    namespace: str(row.namespace),
    ferrum_username: str(row.ferrum_username),
    ferrum_consumer_id: strOrNull(row.ferrum_consumer_id),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

function mapTeardownJob(row: Row): GatewayTeardownJobRecord {
  return {
    id: str(row._id),
    generation: str(row.generation ?? ''),
    user_id: str(row.user_id),
    status: str(row.status) as GatewayTeardownJobStatus,
    attempts: num(row.attempts),
    next_attempt_at: strOrNull(row.next_attempt_at),
    last_error: strOrNull(row.last_error),
    requested_by: strOrNull(row.requested_by),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    completed_at: strOrNull(row.completed_at),
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
  combineEqualityAndIn(query, filter.role, filter.roles, 'role');
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

/**
 * `owner OR granted OR openly listed` — {@link ApiViewerFilter} as one `$or`.
 *
 * It is nested under `$and` by the caller rather than assigned to `query.$or`,
 * because the `q` search already claims that key and a document must satisfy
 * both.
 */
function apiViewerCondition(viewer: ApiViewerFilter): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [{ owner_user_id: viewer.owner_user_id }];
  const granted = [...new Set(viewer.granted_api_ids)];
  if (granted.length > 0) parts.push({ _id: { $in: granted } });
  const authorized = [...new Set(viewer.authorized_api_ids)];
  if (authorized.length > 0) parts.push({ _id: { $in: authorized } });
  const visibilities = [...new Set(viewer.open_visibilities)];
  if (visibilities.length > 0) {
    parts.push({ status: viewer.open_status, visibility: { $in: visibilities } });
  }
  return { $or: parts };
}

function applicationFilter(filter: ApplicationFilter): Filter<NexusDoc> {
  const query: Record<string, unknown> = {};
  if (filter.owner_user_id !== undefined) query.owner_user_id = filter.owner_user_id;
  if (filter.status !== undefined) query.status = filter.status;
  if (filter.q !== undefined && filter.q.trim() !== '') {
    const match = containsInsensitive(filter.q.trim());
    query.$or = [{ name: match }, { description: match }];
  }
  return query as Filter<NexusDoc>;
}

function apiFilter(filter: ApiFilter): Filter<NexusDoc> {
  const conditions: Record<string, unknown>[] = [];
  const query: Record<string, unknown> = {};
  if (filter.owner_user_id !== undefined) query.owner_user_id = filter.owner_user_id;
  if (filter.status !== undefined) query.status = filter.status;
  if (filter.visibility !== undefined) query.visibility = filter.visibility;
  if (filter.namespace !== undefined) query.namespace = filter.namespace;
  if (filter.gateway_state !== undefined) query.gateway_state = filter.gateway_state;
  if (filter.requestable !== undefined) query.requestable = filter.requestable;
  if (filter.ids !== undefined) query._id = { $in: filter.ids };
  if (filter.q !== undefined && filter.q.trim() !== '') {
    const match = containsInsensitive(filter.q.trim());
    conditions.push({ $or: [{ name: match }, { slug: match }, { description: match }] });
  }
  if (filter.visible_to !== undefined) conditions.push(apiViewerCondition(filter.visible_to));
  if (conditions.length > 0) query.$and = conditions;
  return query as Filter<NexusDoc>;
}

/**
 * `application_id` as a Mongo predicate, where `null` is a **value**.
 *
 * The SQL adapters compile it to `IS NULL`; here it has to be an explicit
 * `null` match, because a document written before applications existed has no
 * `application_id` field at all and `{ application_id: null }` matches both
 * that and an explicit null — which is exactly the behaviour the SQL side has.
 */
function scopeQuery(
  query: Record<string, unknown>,
  applicationId: string | null | undefined,
): void {
  if (applicationId === undefined) return;
  query.application_id = applicationId;
}

function accessRequestFilter(filter: AccessRequestFilter): Filter<NexusDoc> {
  const query: Record<string, unknown> = {};
  if (filter.user_id !== undefined) query.user_id = filter.user_id;
  combineEqualityAndIn(query, filter.api_id, filter.api_ids, 'api_id');
  if (filter.status !== undefined) query.status = filter.status;
  scopeQuery(query, filter.application_id);
  return query as Filter<NexusDoc>;
}

function grantFilter(filter: GrantFilter): Filter<NexusDoc> {
  const query: Record<string, unknown> = {};
  if (filter.user_id !== undefined) query.user_id = filter.user_id;
  combineEqualityAndIn(query, filter.api_id, filter.api_ids, 'api_id');
  if (filter.status !== undefined) query.status = filter.status;
  scopeQuery(query, filter.application_id);
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
  scopeQuery(query, filter.application_id);
  return query as Filter<NexusDoc>;
}

function auditFilter(filter: AuditLogFilter): Filter<NexusDoc> {
  const query: Record<string, unknown> = {};
  if (filter.actor_user_id !== undefined) query.actor_user_id = filter.actor_user_id;
  combineEqualityAndIn(query, filter.action, filter.actions, 'action');
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

/** One MongoDB index, declared as data so a released step's definition can be frozen. */
export interface IndexDefinition {
  collection: string;
  name: string;
  key: IndexSpecification;
  unique?: boolean;
  partialFilterExpression?: Document;
}

/**
 * Every index of `001_initial`, translated.
 *
 * Frozen once the baseline ships: `db/released/001_initial.mongodb.json` is the
 * committed snapshot and `db/released-migrations.test.ts` fails when this list
 * drifts from it. After the release an index change is a new step in
 * {@link MONGO_MIGRATIONS}, never an edit here.
 *
 * Partial *unique* indexes map directly onto `partialFilterExpression`. The one
 * non-unique partial index — SQLite's `ix_notifications_unread ... WHERE
 * read_at IS NULL` — becomes the composite `(user_id, read_at)` instead: it is
 * a lookup index rather than a uniqueness rule, so equivalent coverage is all
 * that is required (the MySQL migration makes the same trade for the same
 * reason).
 */
export const BASELINE_INDEXES: readonly IndexDefinition[] = [
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
  {
    collection: 'applications',
    name: 'ux_applications_owner_name',
    key: { owner_user_id: 1, name_lower: 1 },
    unique: true,
  },
  {
    collection: 'applications',
    name: 'ix_applications_owner',
    key: { owner_user_id: 1, created_at: 1 },
  },

  { collection: 'apis', name: 'ix_apis_owner', key: { owner_user_id: 1 } },
  { collection: 'apis', name: 'ix_apis_status_visibility', key: { status: 1, visibility: 1 } },
  { collection: 'apis', name: 'ix_apis_created_at', key: { created_at: 1 } },
  {
    collection: 'apis',
    name: 'ix_apis_gateway_state',
    key: { namespace: 1, gateway_state: 1 },
  },

  {
    collection: 'api_specs',
    name: 'ux_api_specs_current',
    key: { api_id: 1 },
    unique: true,
    partialFilterExpression: { is_current: true },
  },
  // Publication order, and the index every `api_id` lookup uses; see the SQLite
  // schema for why the timestamp is not it.
  {
    collection: 'api_specs',
    name: 'ux_api_specs_seq',
    key: { api_id: 1, revision_seq: 1 },
    unique: true,
  },

  {
    collection: 'api_plugins',
    name: 'ux_api_plugins_api_name',
    key: { api_id: 1, plugin_name: 1 },
    unique: true,
  },
  { collection: 'api_plugins', name: 'ix_api_plugins_api', key: { api_id: 1, created_at: 1 } },

  {
    collection: 'api_viewers',
    name: 'ux_api_viewers_api_user',
    key: { api_id: 1, user_id: 1 },
    unique: true,
  },
  { collection: 'api_viewers', name: 'ix_api_viewers_user', key: { user_id: 1 } },
  { collection: 'api_viewers', name: 'ix_api_viewers_api', key: { api_id: 1, created_at: 1 } },

  {
    collection: 'access_requests',
    name: 'ux_access_requests_pending',
    // A missing field indexes as `null` in MongoDB, so this behaves exactly
    // like the SQL `COALESCE(application_id, '')` key: one open request per API
    // and identity, with the account-scoped rows sharing one slot.
    key: { api_id: 1, user_id: 1, application_id: 1 },
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
    collection: 'access_requests',
    name: 'ix_access_requests_application',
    key: { application_id: 1, status: 1 },
  },

  {
    collection: 'grants',
    name: 'ux_grants_active',
    key: { api_id: 1, user_id: 1, application_id: 1 },
    unique: true,
    partialFilterExpression: { status: 'active' },
  },
  { collection: 'grants', name: 'ix_grants_user_status', key: { user_id: 1, status: 1 } },
  { collection: 'grants', name: 'ix_grants_api_status', key: { api_id: 1, status: 1 } },
  {
    collection: 'grants',
    name: 'ix_grants_application',
    key: { application_id: 1, status: 1 },
  },

  {
    collection: 'consumers',
    name: 'ux_consumers_user_namespace',
    key: { user_id: 1, namespace: 1, application_id: 1 },
    unique: true,
  },
  { collection: 'consumers', name: 'ix_consumers_application', key: { application_id: 1 } },
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
    name: 'ix_credentials_application',
    key: { application_id: 1, status: 1 },
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

  {
    collection: 'messages',
    name: 'ix_messages_sender',
    key: { sender_user_id: 1, created_at: 1 },
  },

  {
    collection: 'email_verification_tokens',
    name: 'ix_verification_tokens_user_purpose',
    key: { user_id: 1, purpose: 1 },
  },

  {
    collection: 'gateway_teardown_jobs',
    name: 'ux_gateway_teardown_jobs_user',
    key: { user_id: 1 },
    unique: true,
  },
  {
    collection: 'gateway_teardown_jobs',
    name: 'ix_gateway_teardown_jobs_due',
    key: { status: 1, next_attempt_at: 1 },
  },

  // `_id` already carries the key, so this is the redundant-but-explicit
  // counterpart of the SQL primary key; the expiry index backs the
  // housekeeping sweep.
  { collection: 'edge_leases', name: 'ux_edge_leases_key', key: { key: 1 }, unique: true },
  { collection: 'edge_leases', name: 'ix_edge_leases_expires', key: { expires_at: 1 } },

  // One registration per identity name: `claim` upserts on this key, which is
  // what moves a recreated test consumer to its new owner instead of
  // recording two.
  {
    collection: 'gateway_identities',
    name: 'ux_gateway_identities_username',
    key: { namespace: 1, ferrum_username: 1 },
    unique: true,
  },
  {
    collection: 'gateway_identities',
    name: 'ix_gateway_identities_user',
    key: { user_id: 1, namespace: 1 },
  },

  // Partial, so documents with an unknown ordinal can coexist
  // — the SQL dialects get that from NULLs being distinct in a unique index.
  // Two *assigned* ordinals can never collide within a consumer and type.
  {
    collection: 'credential_metadata',
    name: 'ux_credentials_ordinal',
    key: { ferrum_consumer_id: 1, credential_type: 1, edge_ordinal: 1 },
    unique: true,
    partialFilterExpression: { edge_ordinal: { $type: 'number' } },
  },
];

/** Create one batch of {@link IndexDefinition}s. */
async function createIndexes(db: Db, indexes: readonly IndexDefinition[]): Promise<void> {
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
 * One MongoDB migration step. Mongo migrations are code rather than `.sql`
 * files, so each step also declares the indexes it creates as data: that
 * declaration is what the released-migration guard compares with the step's
 * frozen snapshot.
 */
export interface MongoMigrationStep {
  id: string;
  indexes: readonly IndexDefinition[];
  apply: (db: Db) => Promise<void>;
}

/**
 * `002_api_gateway_plugins`: the `(api_id, role)` key of the first-class
 * plugin ownership record, which the SQL dialects declare as a primary key.
 * The collection itself needs no creation step; the first insert makes it.
 */
export const API_GATEWAY_PLUGIN_INDEXES: readonly IndexDefinition[] = [
  {
    collection: 'api_gateway_plugins',
    name: 'ux_api_gateway_plugins_api_role',
    key: { api_id: 1, role: 1 },
    unique: true,
  },
];

/** The baseline creates every index; document fields are written by repositories. */
export const MONGO_MIGRATIONS: readonly MongoMigrationStep[] = [
  {
    id: '001_initial',
    indexes: BASELINE_INDEXES,
    apply: (db: Db): Promise<void> => createIndexes(db, BASELINE_INDEXES),
  },
  {
    id: '002_api_gateway_plugins',
    indexes: API_GATEWAY_PLUGIN_INDEXES,
    apply: (db: Db): Promise<void> => createIndexes(db, API_GATEWAY_PLUGIN_INDEXES),
  },
];

/**
 * Apply every step of `steps` not yet recorded in `schema_migrations`, in id
 * order, under the same protocol as the SQL adapters. `steps` defaults to the
 * full list; the upgrade tests pass the released prefix to build a database as
 * an earlier release left it.
 */
export async function runMongoMigrations(
  db: Db,
  steps: readonly MongoMigrationStep[] = MONGO_MIGRATIONS,
): Promise<void> {
  const collection = db.collection<NexusDoc>(SCHEMA_MIGRATIONS_TABLE);
  const byId = new Map(steps.map((step) => [step.id, step.apply]));
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
      const apply = byId.get(migration.id);
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
  const files: MigrationFile[] = steps.map((step) => ({
    id: step.id,
    filename: `${step.id}.mongodb`,
    sql: '',
  }));
  await runMigrations(driver, files);
}

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

  /**
   * One more than the largest `edge_ordinal` recorded for a consumer and type.
   *
   * Two operations rather than the SQL adapters' single `INSERT … SELECT`. The
   * caller's consumer lease is what keeps two appends from reading the same
   * maximum, and the partial unique index turns a breach of that into a
   * `CONFLICT` instead of two rows claiming one gateway slot.
   */
  private async nextCredentialOrdinal(consumerId: string, type: CredentialType): Promise<number> {
    const query: Record<string, unknown> = {
      ferrum_consumer_id: consumerId,
      credential_type: type,
      edge_ordinal: { $type: 'number' },
    };
    const top = await this.col(COLLECTIONS.credentials)
      .find(query as Filter<NexusDoc>, this.opts)
      .sort({ edge_ordinal: -1 })
      .limit(1)
      .project<Row>({ edge_ordinal: 1 })
      .toArray();
    return num(top[0]?.edge_ordinal ?? 0) + 1;
  }

  /**
   * Documents in `status` per application for a set of application ids, as
   * one `$group` — the grouped count behind `countByApplications` on both the
   * grants and the credential repositories. Every id asked for is a key.
   */
  private async countByApplication(
    collection: string,
    applicationIds: readonly Uuid[],
    status: string,
  ): Promise<Map<Uuid, number>> {
    const counts = new Map<Uuid, number>(applicationIds.map((id) => [id, 0]));
    if (counts.size === 0) return counts;
    const rows = await this.col(collection)
      .aggregate<Row>(
        [
          { $match: { status, application_id: { $in: [...counts.keys()] } } },
          { $group: { _id: '$application_id', count: { $sum: 1 } } },
        ],
        this.opts,
      )
      .toArray();
    for (const row of rows) counts.set(String(row._id), num(row.count));
    return counts;
  }

  /**
   * One more than the largest `revision_seq` recorded for an API.
   *
   * Called only from inside the create transaction, exactly as the SQL
   * adapters read the next position inside theirs; the unique index on
   * `(api_id, revision_seq)` is what catches two revisions that read one
   * position anyway.
   */
  private async nextSpecRevisionSeq(apiId: string): Promise<number> {
    const top = await this.col(COLLECTIONS.apiSpecs)
      .find({ api_id: apiId } as Filter<NexusDoc>, this.opts)
      .sort(SPEC_HISTORY_ORDER)
      .limit(1)
      .project<Row>({ revision_seq: 1 })
      .toArray();
    return num(top[0]?.revision_seq ?? 0) + 1;
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
    await runMongoMigrations(this.ctx.db);
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

  transaction<T>(fn: (tx: NexusStore) => Promise<T>, options?: TransactionOptions): Promise<T> {
    // A nested call joins the open transaction, which was fenced when it opened.
    if (this.session) return fn(this);
    // Captured here, in the caller's context and before the queue: the leases
    // the caller holds fence the transaction, re-checked on every re-run. A
    // standalone deployment has no atomic commit to protect, so there a stale
    // holder is refused before its body writes anything instead.
    const body = fenceTransactionBody<NexusStore, T>(
      fn,
      this.ctx.supportsTransactions ? 'commit' : 'begin',
    );
    return this.inTransaction(body, options);
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
   *
   * The body runs under `session.withTransaction()`, which is the driver's own
   * retry envelope: it re-runs the callback on a `TransientTransactionError`
   * (a write conflict, above all) and re-commits on an
   * `UnknownTransactionCommitResult`. Two bounds are put on it — the contention
   * gate enforced here, and `timeoutMS`, which the driver applies to every
   * operation the session runs — because the envelope otherwise keeps trying
   * for two minutes, far longer than an HTTP request should wait. The gate is
   * also what makes those re-runs wait for the transaction that won: MongoDB
   * fails the loser of a contended document immediately instead of blocking it
   * on a lock, so without a backoff the envelope would spin through its whole
   * budget while the winner was still committing.
   */
  private inTransaction<T>(
    fn: (tx: MongoStore) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    // Already inside a transaction body — join it rather than nesting.
    if (this.session) return fn(this);

    const run = async (): Promise<T> => {
      if (!this.ctx.supportsTransactions) {
        // Standalone deployment with NEXUS_DB_ALLOW_STANDALONE=true: run the
        // body sequentially. It is still serialised against other bodies, but
        // there is no atomic commit, no rollback on throw, and nothing to
        // retry — a body that fails here has already left writes behind.
        return fn(new MongoStore(this.ctx, null));
      }
      // `retry: false` still gets the envelope, bounded to a single attempt:
      // the body runs exactly once and the driver's error is still translated.
      const gate = createMongoContentionGate({ retry: options?.retry });
      const session = this.ctx.client.startSession();
      let lastError: unknown;
      try {
        return await session.withTransaction(
          async () => {
            // Backs off before a re-run, and throws the terminal `CONFLICT`
            // once the contention budget is spent. That is not a `MongoError`,
            // so `withTransaction` stops retrying and rethrows it rather than
            // looping until `timeoutMS` expires.
            await gate.beforeAttempt(lastError);
            try {
              return await fn(new MongoStore(this.ctx, session));
            } catch (error) {
              lastError = error;
              throw error;
            }
          },
          { timeoutMS: MONGO_TRANSACTION_BUDGET_MS },
        );
      } catch (error) {
        // A body's own `NexusError` — including the one the gate throws —
        // reaches the caller unchanged; a driver error that the envelope gave
        // up on becomes the same `CONFLICT` the SQL adapters raise.
        if (error instanceof NexusError) throw error;
        if (isMongoTransactionContentionError(error)) {
          throw transactionContentionError('mongodb', gate.attempts, error, {
            commitOutcome: isUnknownTransactionCommitResult(error) ? 'unknown' : 'not_applied',
          });
        }
        throw error;
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
      this.paginate(
        COLLECTIONS.organizations,
        options?.q?.trim() ? { name_lower: containsInsensitive(options.q.trim()) } : {},
        { name_lower: 1 },
        options,
        mapOrganization,
      ),

    delete: async (id) => {
      // Stand in for `users.org_id … REFERENCES organizations (id) ON DELETE
      // SET NULL`: without it a member kept pointing at an organization that no
      // longer existed on Mongo while the same row on PostgreSQL read `null`.
      // Through the same session as the delete, so a transaction covers both.
      await this.col(COLLECTIONS.users).updateMany(
        { org_id: id } as Filter<NexusDoc>,
        { $set: { org_id: null } } as UpdateFilter<NexusDoc>,
        this.opts,
      );
      return (
        (await this.col(COLLECTIONS.organizations).deleteOne({ _id: id }, this.opts)).deletedCount >
        0
      );
    },
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

  /* ── applications ─────────────────────────────────────────────────────── */

  readonly applications: ApplicationRepo = {
    create: async (input) => {
      const meta = stamps(input);
      // `name_lower` is the derived companion of SQL's `lower(name)` index:
      // MongoDB has no expression indexes, so the value is stored.
      await mapConflict('You already have an application with that name', () =>
        this.col(COLLECTIONS.applications).insertOne(
          {
            _id: meta.id,
            owner_user_id: input.owner_user_id,
            name: input.name,
            name_lower: input.name.trim().toLowerCase(),
            description: input.description ?? null,
            status: input.status,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
          } as NexusDoc,
          this.opts,
        ),
      );
      const created = await this.applications.findById(meta.id);
      if (!created) throw new Error('applications.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = asRow(await this.col(COLLECTIONS.applications).findOne({ _id: id }, this.opts));
      return row ? mapApplication(row) : null;
    },

    findByOwnerAndName: async (ownerUserId, name) => {
      const row = asRow(
        await this.col(COLLECTIONS.applications).findOne(
          { owner_user_id: ownerUserId, name_lower: name.trim().toLowerCase() },
          this.opts,
        ),
      );
      return row ? mapApplication(row) : null;
    },

    findManyByIds: async (ids) => {
      if (ids.length === 0) return [];
      const docs = await this.col(COLLECTIONS.applications)
        .find({ _id: { $in: ids } } as Filter<NexusDoc>, this.opts)
        .toArray();
      return docs.map((doc) => mapApplication(doc as Row));
    },

    update: async (id, patch) => {
      const set = setDoc({
        name: patch.name,
        name_lower: patch.name === undefined ? undefined : patch.name.trim().toLowerCase(),
        description: patch.description,
        status: patch.status,
      });
      if (set) {
        await mapConflict('You already have an application with that name', () =>
          this.col(COLLECTIONS.applications).updateOne(
            { _id: id },
            { $set: { ...set, updated_at: nowIso() } },
            this.opts,
          ),
        );
      }
      return this.applications.findById(id);
    },

    list: async (filter, options) =>
      this.paginate(
        COLLECTIONS.applications,
        applicationFilter(filter),
        NEWEST_FIRST,
        options,
        mapApplication,
      ),

    count: async (filter = {}) =>
      this.col(COLLECTIONS.applications).countDocuments(applicationFilter(filter), this.opts),

    delete: async (id) => {
      // Stand in for `… REFERENCES applications (id) ON DELETE CASCADE`, which
      // the three SQL schemas declare on every scoped table. MongoDB has no
      // foreign keys, so without this an application's grants, requests,
      // credentials and consumer mapping outlived the application on Mongo and
      // not on PostgreSQL — the kind of divergence the cross-adapter suite
      // exists to catch, and it caught this one.
      //
      // One transaction, joining the caller's when there is one: SQL's cascade
      // is atomic with the parent delete, and five loose writes were not — a
      // failure part-way left some collections emptied and the application
      // still standing (issue #364). A standalone deployment that opted in
      // with `NEXUS_DB_ALLOW_STANDALONE` runs them in order without that
      // guarantee, which is why the children still go before the row.
      return this.inTransaction(async (tx) => {
        for (const collection of [
          COLLECTIONS.grants,
          COLLECTIONS.accessRequests,
          COLLECTIONS.credentials,
          COLLECTIONS.consumers,
        ]) {
          await tx.col(collection).deleteMany({ application_id: id } as Filter<NexusDoc>, tx.opts);
        }
        const deleted = await tx.col(COLLECTIONS.applications).deleteOne({ _id: id }, tx.opts);
        return deleted.deletedCount > 0;
      });
    },
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
            spec_enforcement: input.spec_enforcement ?? DEFAULT_SPEC_ENFORCEMENT,
            status: input.status,
            visibility: input.visibility,
            gateway_state: input.gateway_state ?? 'deployed',
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
        spec_enforcement: patch.spec_enforcement,
        status: patch.status,
        visibility: patch.visibility,
        gateway_state: patch.gateway_state,
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

    delete: async (id) => {
      // Stand in for `message_threads.api_id … REFERENCES apis (id) ON DELETE
      // SET NULL`: a conversation about an API outlives it, but must not keep
      // a dangling id the SQL backends would have cleared. Through the same
      // session as the delete, so a transaction covers both.
      await this.col(COLLECTIONS.threads).updateMany(
        { api_id: id } as Filter<NexusDoc>,
        { $set: { api_id: null } } as UpdateFilter<NexusDoc>,
        this.opts,
      );
      return (await this.col(COLLECTIONS.apis).deleteOne({ _id: id }, this.opts)).deletedCount > 0;
    },
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
              revision_seq: await tx.nextSpecRevisionSeq(input.api_id),
              created_by: input.created_by ?? null,
              rolled_back_from_id: input.rolled_back_from_id ?? null,
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
        SPEC_REVISIONS_ORDER,
        options,
        mapApiSpec,
      );
    },

    delete: async (id) => {
      await this.clearRollbackLinks([id]);
      return (
        (await this.col(COLLECTIONS.apiSpecs).deleteOne({ _id: id }, this.opts)).deletedCount > 0
      );
    },

    // No link-clearing here: every `rolled_back_from_id` points at a revision
    // of the *same* API, and this removes all of them.
    deleteByApi: async (apiId) =>
      (await this.col(COLLECTIONS.apiSpecs).deleteMany({ api_id: apiId }, this.opts)).deletedCount,

    pruneHistory: async (apiId, keep) => {
      const doomed = await this.col(COLLECTIONS.apiSpecs)
        .find({ api_id: apiId, is_current: false } as Filter<NexusDoc>, this.opts)
        .sort(SPEC_HISTORY_ORDER)
        .skip(Math.max(0, keep))
        .limit(SPEC_HISTORY_PRUNE_BATCH)
        .project({ _id: 1 })
        .toArray();
      if (doomed.length === 0) return 0;
      const ids = doomed.map((row) => String(row._id));
      await this.clearRollbackLinks(ids);
      return (
        await this.col(COLLECTIONS.apiSpecs).deleteMany(
          { _id: { $in: ids } } as Filter<NexusDoc>,
          this.opts,
        )
      ).deletedCount;
    },
  };

  /**
   * Stand in for `api_specs.rolled_back_from_id … ON DELETE SET NULL`.
   *
   * The SQL schemas declare that constraint so a rollback's provenance goes to
   * `null` once retention drops the revision it restored — the link is
   * provenance, not a dependency, and it must never keep a revision alive or
   * outlive it as a dangling id. MongoDB has no foreign keys, so the adapter
   * has to do it: without this, a rollback on Mongo kept pointing at a
   * revision that no longer existed while the same row on PostgreSQL read
   * `null`, which is exactly the kind of divergence the cross-adapter suite
   * exists to catch.
   */
  private async clearRollbackLinks(specIds: readonly string[]): Promise<void> {
    if (specIds.length === 0) return;
    await this.col(COLLECTIONS.apiSpecs).updateMany(
      { rolled_back_from_id: { $in: [...specIds] } } as Filter<NexusDoc>,
      { $set: { rolled_back_from_id: null } } as UpdateFilter<NexusDoc>,
      this.opts,
    );
  }

  /* ── apiPlugins ───────────────────────────────────────────────────────── */

  readonly apiPlugins: ApiPluginRepo = {
    listByApi: async (apiId) =>
      (
        await this.col(COLLECTIONS.apiPlugins)
          .find({ api_id: apiId } as Filter<NexusDoc>, this.opts)
          .sort({ created_at: 1, plugin_name: 1 })
          .toArray()
      ).map((doc) => mapApiPlugin(doc as Row)),

    find: async (apiId, pluginName) => {
      const row = asRow(
        await this.col(COLLECTIONS.apiPlugins).findOne(
          { api_id: apiId, plugin_name: pluginName },
          this.opts,
        ),
      );
      return row ? mapApiPlugin(row) : null;
    },

    upsert: async (input) => {
      const meta = stamps({});
      // One `updateOne(..., { upsert: true })` against the unique
      // `(api_id, plugin_name)` index, so two concurrent saves converge on one
      // document. `$setOnInsert` keeps the id and the moment the provider
      // first switched this plugin on across a replace.
      await mapConflict('That plugin is already configured for this API', () =>
        this.col(COLLECTIONS.apiPlugins).updateOne(
          { api_id: input.api_id, plugin_name: input.plugin_name } as Filter<NexusDoc>,
          {
            $set: {
              enabled: input.enabled,
              config: input.config,
              trigger: input.trigger,
              ferrum_plugin_config_id: input.ferrum_plugin_config_id,
              updated_at: meta.updated_at,
            },
            $setOnInsert: {
              _id: meta.id,
              api_id: input.api_id,
              plugin_name: input.plugin_name,
              created_at: meta.created_at,
            },
          } as UpdateFilter<NexusDoc>,
          { ...this.opts, upsert: true },
        ),
      );
      const saved = await this.apiPlugins.find(input.api_id, input.plugin_name);
      if (!saved) throw new Error('apiPlugins.upsert: row vanished immediately after write');
      return saved;
    },

    delete: async (apiId, pluginName) =>
      (
        await this.col(COLLECTIONS.apiPlugins).deleteOne(
          { api_id: apiId, plugin_name: pluginName } as Filter<NexusDoc>,
          this.opts,
        )
      ).deletedCount > 0,

    deleteByApi: async (apiId) =>
      (
        await this.col(COLLECTIONS.apiPlugins).deleteMany(
          { api_id: apiId } as Filter<NexusDoc>,
          this.opts,
        )
      ).deletedCount,
  };

  /* ── apiGatewayPlugins ────────────────────────────────────────────────── */

  readonly apiGatewayPlugins: ApiGatewayPluginRepo = {
    listByApi: async (apiId) => {
      const rows = (
        await this.col(COLLECTIONS.apiGatewayPlugins)
          .find({ api_id: apiId } as Filter<NexusDoc>, this.opts)
          .toArray()
      ).map((doc) => mapApiGatewayPlugin(doc as Row));
      return API_GATEWAY_PLUGIN_ROLES.flatMap((role) => rows.filter((row) => row.role === role));
    },

    replace: async (apiId, ids) => {
      const at = nowIso();
      const roles = API_GATEWAY_PLUGIN_ROLES.filter((role) => ids[role] !== undefined);
      // One transaction, so a reader never sees half of an API's record — the
      // half that would read as "not the portal's".
      await this.inTransaction(async (tx) => {
        await tx
          .col(COLLECTIONS.apiGatewayPlugins)
          .deleteMany({ api_id: apiId, role: { $nin: roles } } as Filter<NexusDoc>, tx.opts);
        for (const role of roles) {
          await tx.col(COLLECTIONS.apiGatewayPlugins).updateOne(
            { api_id: apiId, role } as Filter<NexusDoc>,
            {
              $set: { ferrum_plugin_config_id: ids[role], updated_at: at },
              $setOnInsert: { _id: newId(), api_id: apiId, role, created_at: at },
            } as UpdateFilter<NexusDoc>,
            { ...tx.opts, upsert: true },
          );
        }
      });
    },

    deleteByApi: async (apiId) =>
      (
        await this.col(COLLECTIONS.apiGatewayPlugins).deleteMany(
          { api_id: apiId } as Filter<NexusDoc>,
          this.opts,
        )
      ).deletedCount,
  };

  /* ── apiViewers ───────────────────────────────────────────────────────── */

  readonly apiViewers: ApiViewerRepo = {
    upsert: async (input) => {
      const meta = stamps(input);
      // One upsert against the unique `(api_id, user_id)` index, so two
      // concurrent invitations converge on one document. `$setOnInsert` keeps
      // the moment this account was first authorized across a replace.
      await mapConflict('That account is already authorized for this API', () =>
        this.col(COLLECTIONS.apiViewers).updateOne(
          { api_id: input.api_id, user_id: input.user_id } as Filter<NexusDoc>,
          {
            $set: {
              granted_by: input.granted_by ?? null,
              note: input.note ?? null,
              updated_at: meta.updated_at,
            },
            $setOnInsert: {
              _id: meta.id,
              api_id: input.api_id,
              user_id: input.user_id,
              created_at: meta.created_at,
            },
          } as UpdateFilter<NexusDoc>,
          { ...this.opts, upsert: true },
        ),
      );
      const saved = await this.apiViewers.find(input.api_id, input.user_id);
      if (!saved) throw new Error('apiViewers.upsert: row vanished immediately after write');
      return saved;
    },

    find: async (apiId, userId) => {
      const row = asRow(
        await this.col(COLLECTIONS.apiViewers).findOne(
          { api_id: apiId, user_id: userId },
          this.opts,
        ),
      );
      return row ? mapApiViewer(row) : null;
    },

    list: async (filter, options) => {
      const query: Record<string, unknown> = {};
      if (filter.api_id !== undefined) query.api_id = filter.api_id;
      if (filter.user_id !== undefined) query.user_id = filter.user_id;
      return this.paginate(
        COLLECTIONS.apiViewers,
        query as Filter<NexusDoc>,
        NEWEST_FIRST,
        options,
        mapApiViewer,
      );
    },

    listApiIdsByUser: async (userId) =>
      (
        await this.col(COLLECTIONS.apiViewers)
          .find({ user_id: userId } as Filter<NexusDoc>, this.opts)
          .project({ api_id: 1 })
          .toArray()
      ).map((doc) => str((doc as Row).api_id)),

    delete: async (apiId, userId) =>
      (
        await this.col(COLLECTIONS.apiViewers).deleteOne(
          { api_id: apiId, user_id: userId } as Filter<NexusDoc>,
          this.opts,
        )
      ).deletedCount > 0,

    deleteByApi: async (apiId) =>
      (
        await this.col(COLLECTIONS.apiViewers).deleteMany(
          { api_id: apiId } as Filter<NexusDoc>,
          this.opts,
        )
      ).deletedCount,
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
            application_id: input.application_id ?? null,
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

    findPendingByApiAndUser: async (apiId, userId, applicationId = null) => {
      const query: Record<string, unknown> = { api_id: apiId, user_id: userId, status: 'pending' };
      scopeQuery(query, applicationId);
      const row = asRow(
        await this.col(COLLECTIONS.accessRequests).findOne(query as Filter<NexusDoc>, this.opts),
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
            application_id: input.application_id ?? null,
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

    findActiveByApiAndUser: async (apiId, userId, applicationId = null) => {
      const query: Record<string, unknown> = { api_id: apiId, user_id: userId, status: 'active' };
      scopeQuery(query, applicationId);
      const row = asRow(
        await this.col(COLLECTIONS.grants).findOne(query as Filter<NexusDoc>, this.opts),
      );
      return row ? mapGrant(row) : null;
    },

    listActiveByUser: async (userId, applicationId) => {
      const query: Record<string, unknown> = { user_id: userId, status: 'active' };
      scopeQuery(query, applicationId);
      const docs = await this.col(COLLECTIONS.grants)
        .find(query as Filter<NexusDoc>, this.opts)
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

    countByApplications: async (applicationIds, status) =>
      this.countByApplication(COLLECTIONS.grants, applicationIds, status),

    deleteByApi: async (apiId) =>
      (await this.col(COLLECTIONS.grants).deleteMany({ api_id: apiId }, this.opts)).deletedCount,
  };

  /* ── credentials ──────────────────────────────────────────────────────── */

  readonly credentials: CredentialRepo = {
    create: async (input) => {
      const meta = stamps(input);
      const edgeOrdinal =
        input.edge_ordinal === undefined
          ? await this.nextCredentialOrdinal(input.ferrum_consumer_id, input.credential_type)
          : input.edge_ordinal;
      await mapConflict('That credential is already registered', () =>
        this.col(COLLECTIONS.credentials).insertOne(
          {
            _id: meta.id,
            user_id: input.user_id,
            application_id: input.application_id ?? null,
            ferrum_consumer_id: input.ferrum_consumer_id,
            credential_type: input.credential_type,
            ferrum_credential_id: input.ferrum_credential_id,
            fingerprint: input.fingerprint,
            last4: input.last4,
            label: input.label ?? null,
            status: input.status,
            rotated_from_id: input.rotated_from_id ?? null,
            edge_ordinal: edgeOrdinal,
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

    listByConsumer: async (ferrumConsumerId, type, statuses) => {
      const query: Record<string, unknown> = { ferrum_consumer_id: ferrumConsumerId };
      if (type !== undefined) query.credential_type = type;
      if (statuses !== undefined) query.status = { $in: [...statuses] };
      // Ascending BSON order puts null and missing before every number, so
      // unresolved documents lead, then append order.
      const docs = await this.col(COLLECTIONS.credentials)
        .find(query as Filter<NexusDoc>, this.opts)
        .sort({ edge_ordinal: 1, created_at: 1, _id: 1 })
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

    countByApplications: async (applicationIds, status) =>
      this.countByApplication(COLLECTIONS.credentials, applicationIds, status),

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
            application_id: input.application_id ?? null,
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

    findByUserAndNamespace: async (userId, namespace, applicationId = null) => {
      const query: Record<string, unknown> = { user_id: userId, namespace };
      scopeQuery(query, applicationId);
      const row = asRow(
        await this.col(COLLECTIONS.consumers).findOne(query as Filter<NexusDoc>, this.opts),
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
      scopeQuery(query, filter.application_id);
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

  /* ── gatewayIdentities ────────────────────────────────────────────────── */

  readonly gatewayIdentities: GatewayIdentityRepo = {
    claim: async (input) => {
      // Keyed on the identity's name (unique), so a second claim moves the
      // registration to its new owner and keeps the row. `_id` and
      // `created_at` only land on the insert.
      const now = nowIso();
      const doc = await this.col(COLLECTIONS.gatewayIdentities).findOneAndUpdate(
        { namespace: input.namespace, ferrum_username: input.ferrum_username } as Filter<NexusDoc>,
        {
          $set: {
            user_id: input.user_id,
            ferrum_consumer_id: input.ferrum_consumer_id,
            updated_at: now,
          },
          $setOnInsert: {
            _id: newId(),
            namespace: input.namespace,
            ferrum_username: input.ferrum_username,
            created_at: now,
          },
        } as UpdateFilter<NexusDoc>,
        { ...this.opts, upsert: true, returnDocument: 'after' },
      );
      const row = asRow(doc);
      if (!row) throw new Error('gatewayIdentities.claim: row vanished immediately after upsert');
      return mapGatewayIdentity(row);
    },

    findById: async (id) => {
      const row = asRow(
        await this.col(COLLECTIONS.gatewayIdentities).findOne({ _id: id }, this.opts),
      );
      return row ? mapGatewayIdentity(row) : null;
    },

    findByUsername: async (namespace, ferrumUsername) => {
      const row = asRow(
        await this.col(COLLECTIONS.gatewayIdentities).findOne(
          { namespace, ferrum_username: ferrumUsername },
          this.opts,
        ),
      );
      return row ? mapGatewayIdentity(row) : null;
    },

    listByUser: async (userId, namespace) => {
      const docs = await this.col(COLLECTIONS.gatewayIdentities)
        .find({ user_id: userId, namespace } as Filter<NexusDoc>, this.opts)
        .sort({ created_at: 1, _id: 1 })
        .toArray();
      return docs.map((doc) => mapGatewayIdentity(doc as Row));
    },

    bindConsumer: async (id, ferrumConsumerId) => {
      await this.col(COLLECTIONS.gatewayIdentities).updateOne(
        { _id: id },
        { $set: { ferrum_consumer_id: ferrumConsumerId, updated_at: nowIso() } },
        this.opts,
      );
      return this.gatewayIdentities.findById(id);
    },

    delete: async (id) =>
      (await this.col(COLLECTIONS.gatewayIdentities).deleteOne({ _id: id }, this.opts))
        .deletedCount > 0,
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
      if (filter.platform_or_participant_user_id !== undefined) {
        conditions.push({
          $or: [
            { participant_b: null },
            { participant_a: filter.platform_or_participant_user_id },
            { participant_b: filter.platform_or_participant_user_id },
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
          broadcast: input.broadcast ?? false,
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

    listByThread: async (threadId, options) => {
      const conditions: Record<string, unknown>[] = [{ thread_id: threadId }];
      const cursor = options?.before;
      if (cursor) {
        // Strictly before `(created_at, _id)` — the id half is what keeps the
        // cursor total across messages sharing a millisecond.
        conditions.push({
          $or: [
            { created_at: { $lt: cursor.created_at } },
            { created_at: cursor.created_at, _id: { $lt: cursor.id } },
          ],
        });
      }
      const direction = options?.newest_first === true ? -1 : 1;
      return this.paginate(
        COLLECTIONS.messages,
        { $and: conditions } as Filter<NexusDoc>,
        { created_at: direction, _id: direction },
        options,
        mapMessage,
      );
    },

    findLatestByThread: async (threadId) => {
      const docs = await this.col(COLLECTIONS.messages)
        .find({ thread_id: threadId }, this.opts)
        .sort(NEWEST_FIRST)
        .limit(1)
        .toArray();
      const row = asRow(docs[0]);
      return row ? mapMessage(row) : null;
    },

    findLatestByThreads: async (threadIds) => {
      if (threadIds.length === 0) return [];
      const docs = await this.col(COLLECTIONS.messages)
        .aggregate(
          [
            { $match: { thread_id: { $in: threadIds } } },
            { $sort: { thread_id: 1, created_at: -1, _id: -1 } },
            { $group: { _id: '$thread_id', latest: { $first: '$$ROOT' } } },
            { $replaceRoot: { newRoot: '$latest' } },
          ],
          this.opts,
        )
        .toArray();
      return docs.map((doc) => mapMessage(doc as Row));
    },

    countByThread: async (threadId) =>
      this.col(COLLECTIONS.messages).countDocuments({ thread_id: threadId }, this.opts),

    countBySenderSince: async (senderUserId, sinceIso) =>
      this.col(COLLECTIONS.messages).countDocuments(
        // Match mapMessage: only explicitly marked broadcasts are exempt.
        { sender_user_id: senderUserId, created_at: { $gte: sinceIso }, broadcast: { $ne: true } },
        this.opts,
      ),

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
      // One session transaction around the whole batch: `insertMany` alone is
      // ordered but not atomic, so a failing row elsewhere left the rows that
      // preceded it committed — unlike the SQL adapters, whose `createMany`
      // runs inside one transaction. A caller already inside a transaction
      // joins it here instead of opening a second one.
      await this.inTransaction(async (tx) => {
        await tx.col(COLLECTIONS.notifications).insertMany(docs, tx.opts);
      });
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
            generation: '',
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
                generation: newId(),
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

    // Settling matches the claimed generation while it is still `sending`, so a
    // worker whose claim was reclaimed mid-delivery cannot overwrite the new
    // owner's outcome.
    markSent: async (entry, at) => {
      const result = await this.col(COLLECTIONS.emailOutbox).updateOne(
        { _id: entry.id, generation: entry.generation, status: 'sending' } as Filter<NexusDoc>,
        { $set: { status: 'sent', next_attempt_at: null, last_error: null, updated_at: at } },
        this.opts,
      );
      return result.modifiedCount > 0;
    },

    reschedule: async (entry, nextAttemptAt, lastError) => {
      const result = await this.col(COLLECTIONS.emailOutbox).updateOne(
        { _id: entry.id, generation: entry.generation, status: 'sending' } as Filter<NexusDoc>,
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
      return result.modifiedCount > 0;
    },

    markFailed: async (entry, lastError) => {
      const result = await this.col(COLLECTIONS.emailOutbox).updateOne(
        { _id: entry.id, generation: entry.generation, status: 'sending' } as Filter<NexusDoc>,
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
      return result.modifiedCount > 0;
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

  /* ── gatewayTeardownJobs ──────────────────────────────────────────────── */

  readonly gatewayTeardownJobs: GatewayTeardownJobRepo = {
    upsertPending: async (userId, requestedBy, now) => {
      // Keyed on `user_id` (unique), so a second disable resets the account's
      // outstanding revocation instead of queueing another one. `_id` and
      // `created_at` only land on the insert.
      const doc = await this.col(COLLECTIONS.gatewayTeardownJobs).findOneAndUpdate(
        { user_id: userId } as Filter<NexusDoc>,
        {
          $set: {
            generation: newId(),
            status: 'pending',
            attempts: 0,
            next_attempt_at: now,
            last_error: null,
            requested_by: requestedBy,
            updated_at: now,
            completed_at: null,
          },
          $setOnInsert: { _id: newId(), user_id: userId, created_at: now },
        } as UpdateFilter<NexusDoc>,
        { ...this.opts, upsert: true, returnDocument: 'after' },
      );
      const row = asRow(doc);
      if (!row) {
        throw new Error('gatewayTeardownJobs.upsertPending: row vanished immediately after upsert');
      }
      return mapTeardownJob(row);
    },

    findByUser: async (userId) => {
      const row = asRow(
        await this.col(COLLECTIONS.gatewayTeardownJobs).findOne({ user_id: userId }, this.opts),
      );
      return row ? mapTeardownJob(row) : null;
    },

    list: async (filter, options) => {
      const query: Record<string, unknown> = {};
      if (filter.status !== undefined) query.status = filter.status;
      if (filter.statuses !== undefined) {
        query.status = {
          $in: filter.statuses,
          ...(filter.status !== undefined ? { $eq: filter.status } : {}),
        };
      }
      return this.paginate(
        COLLECTIONS.gatewayTeardownJobs,
        query as Filter<NexusDoc>,
        NEWEST_FIRST,
        options,
        mapTeardownJob,
      );
    },

    claimDue: async (now, limit) => {
      // `findOneAndUpdate` is atomic on its own, so the claim needs no
      // transaction — the same argument as the outbox claim.
      const wanted = Math.max(1, Math.floor(limit));
      const claimed: GatewayTeardownJobRecord[] = [];
      for (let i = 0; i < wanted; i += 1) {
        const doc = await this.col(COLLECTIONS.gatewayTeardownJobs).findOneAndUpdate(
          {
            status: 'pending',
            $or: [{ next_attempt_at: null }, { next_attempt_at: { $lte: now } }],
          } as Filter<NexusDoc>,
          [
            {
              $set: {
                status: 'sending',
                generation: newId(),
                completed_at: null,
                updated_at: nowIso(),
                attempts: { $add: [{ $ifNull: ['$attempts', 0] }, 1] },
              },
            },
          ],
          { ...this.opts, sort: OUTBOX_CLAIM_ORDER, returnDocument: 'after' },
        );
        const row = asRow(doc);
        if (!row) break;
        claimed.push(mapTeardownJob(row));
      }
      return claimed;
    },

    claimPending: async (job) => {
      const doc = await this.col(COLLECTIONS.gatewayTeardownJobs).findOneAndUpdate(
        { _id: job.id, generation: job.generation, status: 'pending' } as Filter<NexusDoc>,
        [
          {
            $set: {
              status: 'sending',
              generation: newId(),
              updated_at: nowIso(),
              completed_at: null,
              attempts: { $add: [{ $ifNull: ['$attempts', 0] }, 1] },
            },
          },
        ],
        { ...this.opts, returnDocument: 'after' },
      );
      const row = asRow(doc);
      return row ? mapTeardownJob(row) : null;
    },

    markDone: async (job, at) => {
      const result = await this.col(COLLECTIONS.gatewayTeardownJobs).updateOne(
        { _id: job.id, generation: job.generation, status: 'sending' } as Filter<NexusDoc>,
        {
          $set: {
            status: 'done',
            next_attempt_at: null,
            last_error: null,
            completed_at: at,
            updated_at: at,
          },
        },
        this.opts,
      );
      return result.modifiedCount > 0;
    },

    reschedule: async (job, nextAttemptAt, lastError) => {
      const result = await this.col(COLLECTIONS.gatewayTeardownJobs).updateOne(
        { _id: job.id, generation: job.generation, status: 'sending' } as Filter<NexusDoc>,
        {
          $set: {
            status: 'pending',
            next_attempt_at: nextAttemptAt,
            last_error: lastError,
            updated_at: nowIso(),
            completed_at: null,
          },
        },
        this.opts,
      );
      return result.modifiedCount > 0;
    },

    releaseStale: async (olderThan) => {
      const at = nowIso();
      const result = await this.col(COLLECTIONS.gatewayTeardownJobs).updateMany(
        { status: 'sending', updated_at: { $lte: olderThan } } as Filter<NexusDoc>,
        { $set: { status: 'pending', next_attempt_at: at, updated_at: at } },
        this.opts,
      );
      return result.modifiedCount;
    },

    deleteByUser: async (userId) => {
      const result = await this.col(COLLECTIONS.gatewayTeardownJobs).deleteOne(
        { user_id: userId } as Filter<NexusDoc>,
        this.opts,
      );
      return result.deletedCount > 0;
    },

    deleteClaimed: async (job) => {
      const result = await this.col(COLLECTIONS.gatewayTeardownJobs).deleteOne(
        { _id: job.id, generation: job.generation, status: 'sending' } as Filter<NexusDoc>,
        this.opts,
      );
      return result.deletedCount > 0;
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
      await this.upsertSetting(this, key, value, encrypted);
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
      // One session transaction around the whole batch, matching the SQL
      // adapters' `setMany` and the `one statement batch` contract on
      // `SettingRepo`: a failing entry must not leave the entries before it
      // committed. A caller already inside a transaction joins it here.
      await this.inTransaction(async (tx) => {
        for (const entry of entries) {
          await this.upsertSetting(tx, entry.key, entry.value, entry.encrypted ?? false);
        }
      });
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

  private async upsertSetting(
    store: MongoStore,
    key: string,
    value: unknown,
    encrypted: boolean,
  ): Promise<void> {
    const at = nowIso();
    await store.col(COLLECTIONS.settings).updateOne(
      { _id: key },
      {
        $set: { value: normalizeJson(value ?? null), encrypted, updated_at: at },
        $setOnInsert: { created_at: at },
      },
      { ...store.opts, upsert: true },
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
    claimIssue: async (userId, purpose, issuedAt, notBefore) => {
      // Two statements that cannot collide, mirroring the SQL adapters' insert
      // and conditional update. A single conditional upsert would try to insert
      // a second `_id` whenever the existing claim is still inside the window,
      // and inside a multi-document transaction that duplicate-key error aborts
      // the transaction server-side: `withTransaction` re-runs the body, which
      // collides again until the retry budget turns a throttled request into
      // CONFLICT (issue #326).
      const claims = this.col(COLLECTIONS.tokenIssueClaims);
      const _id = `${userId}:${purpose}`;
      const fields = { user_id: userId, purpose, issued_at: issuedAt };
      const renewed = await claims.updateOne(
        {
          _id,
          $or: [{ issued_at: { $lte: notBefore } }, { issued_at: { $exists: false } }],
        } as Filter<NexusDoc>,
        { $set: fields },
        this.opts,
      );
      if (renewed.matchedCount > 0) return true;
      try {
        // Matches any existing claim by `_id` alone, so an in-window claim is a
        // no-op rather than an insert that collides with it.
        const created = await claims.updateOne(
          { _id },
          { $setOnInsert: fields },
          { ...this.opts, upsert: true },
        );
        return created.upsertedCount > 0;
      } catch (error) {
        // Outside a transaction, a concurrent upsert that won the unique `_id`
        // race owns this throttle window. (The server already retries an
        // equality-on-`_id` upsert that loses that race, so this is a backstop.)
        if ((error as { code?: unknown }).code === 11000) return false;
        throw error;
      }
    },

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

  /* ── leases ───────────────────────────────────────────────────────────── */

  readonly leases: LeaseRepo = {
    acquire: async (key, owner, expiresAt, now) => {
      assertLeaseKeyLength(key);
      const stamp = nowIso();
      try {
        // The filter is the free-or-expired test and the upsert is the claim,
        // in one atomic command. When the lease is live the filter matches
        // nothing, so Mongo tries to *insert* — and collides with the `_id` of
        // the row already there, which is the refusal.
        const result = await this.col(COLLECTIONS.leases).updateOne(
          { _id: key, expires_at: { $lte: now } } as Filter<NexusDoc>,
          {
            $set: { key, owner, expires_at: expiresAt, updated_at: stamp },
            $setOnInsert: { created_at: stamp },
          },
          { ...this.opts, upsert: true },
        );
        return result.matchedCount > 0 || result.upsertedCount > 0;
      } catch (error) {
        // A live lease, or a concurrent upsert that won the `_id` race: either
        // way somebody else holds it.
        if ((error as { code?: unknown }).code === 11000) return false;
        throw error;
      }
    },

    release: async (key, owner) =>
      (
        await this.col(COLLECTIONS.leases).deleteOne(
          { _id: key, owner } as Filter<NexusDoc>,
          this.opts,
        )
      ).deletedCount > 0,

    renew: async (key, owner, expiresAt) =>
      (
        await this.col(COLLECTIONS.leases).updateOne(
          { _id: key, owner } as Filter<NexusDoc>,
          { $set: { expires_at: expiresAt, updated_at: nowIso() } },
          this.opts,
        )
      ).matchedCount > 0,

    // A write, not a read: a transaction's snapshot read takes no lock, so only
    // a modification makes a takeover conflict with — and wait for — this
    // holder's commit, and makes a takeover that landed after the snapshot
    // abort the transaction instead of passing unseen. A fresh nonce is always
    // a modification, where re-setting an unchanged value is a no-op that
    // locks nothing.
    verify: async (key, owner) =>
      (
        await this.col(COLLECTIONS.leases).updateOne(
          { _id: key, owner } as Filter<NexusDoc>,
          { $set: { fence_nonce: newId(), updated_at: nowIso() } },
          this.opts,
        )
      ).matchedCount > 0,

    deleteExpired: async (now) =>
      (
        await this.col(COLLECTIONS.leases).deleteMany(
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
