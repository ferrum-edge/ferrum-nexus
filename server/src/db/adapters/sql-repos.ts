/**
 * The seventeen {@link NexusStore} repositories, implemented once for both
 * asynchronous SQL adapters.
 *
 * PostgreSQL and MySQL differ in placeholder syntax, identifier quoting and a
 * handful of constructs; all of that is absorbed by
 * {@link ./sql-common.js sql-common.ts}, so everything below is written against
 * a single {@link SqlExecutor} and a single SQL text. `postgres/index.ts` and
 * `mysql/index.ts` supply the executor (a pool, or a checked-out transaction
 * connection) and the lifecycle; they add no query logic of their own.
 *
 * Semantics are matched method for method against `adapters/sqlite/index.ts`,
 * which is the reference implementation: same ordering, same
 * `{ items, total }` envelopes, same `null`-on-miss, same `CONFLICT` mapping,
 * same adapter-managed `updated_at`.
 *
 * Note the deliberate deviation from the original "one repo file for all three
 * SQL adapters" sketch: the sqlite adapter is synchronous under the hood
 * (better-sqlite3), so it cannot share these `Promise`-returning bodies without
 * either wrapping every statement or making the reference adapter async. It
 * stays as it is; this file serves the two async drivers.
 */

import type {
  AccessRequestStatus,
  ApiStatus,
  ApiVisibility,
  AuthPluginType,
  CorsConfig,
  CredentialStatus,
  CredentialType,
  DbDriver,
  EmailOutboxStatus,
  EmailTemplateKey,
  GrantStatus,
  IsoTimestamp,
  NotificationType,
  RateLimitConfig,
  Role,
  UserStatus,
  Uuid,
} from '@ferrum-nexus/shared';

import { newId, nowIso } from '../../lib/ids.js';
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
  VerificationTokenRecord,
  VerificationTokenRepo,
} from '../store.js';
import {
  bool,
  encodeBool,
  encodeJson,
  execute,
  FOR_UPDATE_SKIP_LOCKED,
  insertParts,
  int,
  json,
  mapSqlConflict,
  page,
  queryAll,
  queryCount,
  queryOne,
  setParts,
  SqlWhereBuilder,
  text,
  textOrNull,
  upsertSql,
  type Row,
  type SqlDialect,
  type SqlExecutor,
  type SqlParam,
  type SqlTransactionRunner,
} from './sql-common.js';

/* ── Row mappers ────────────────────────────────────────────────────────── */

function mapUser(row: Row): UserRecord {
  return {
    id: text(row.id),
    email: text(row.email),
    password_hash: text(row.password_hash),
    display_name: text(row.display_name),
    role: text(row.role) as Role,
    org_id: textOrNull(row.org_id),
    company: textOrNull(row.company),
    phone: textOrNull(row.phone),
    status: text(row.status) as UserStatus,
    email_verified: bool(row.email_verified),
    last_login_at: textOrNull(row.last_login_at),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

/** Encoded `SET` columns of a user patch, shared by `update` and `updateIfMatches`. */
function userUpdateColumns(patch: UpdateInput<UserRecord>): Record<string, SqlParam | undefined> {
  return {
    email: patch.email === undefined ? undefined : patch.email.trim().toLowerCase(),
    password_hash: patch.password_hash,
    display_name: patch.display_name,
    role: patch.role,
    org_id: patch.org_id === undefined ? undefined : patch.org_id,
    company: patch.company === undefined ? undefined : patch.company,
    phone: patch.phone === undefined ? undefined : patch.phone,
    status: patch.status,
    email_verified:
      patch.email_verified === undefined ? undefined : encodeBool(patch.email_verified),
    last_login_at: patch.last_login_at === undefined ? undefined : patch.last_login_at,
  };
}

/** Encoded `SET` columns of an access-request patch, shared by both updates. */
function accessRequestUpdateColumns(
  patch: UpdateInput<AccessRequestRecord>,
): Record<string, SqlParam | undefined> {
  return {
    justification: patch.justification,
    status: patch.status,
    decided_by: patch.decided_by,
    decided_at: patch.decided_at,
    decision_note: patch.decision_note,
  };
}

/** Encoded `SET` columns of a grant patch, shared by both updates. */
function grantUpdateColumns(patch: UpdateInput<GrantRecord>): Record<string, SqlParam | undefined> {
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
    id: text(row.id),
    name: text(row.name),
    description: textOrNull(row.description),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapSession(row: Row): SessionRecord {
  return {
    id: text(row.id),
    token_hash: text(row.token_hash),
    user_id: text(row.user_id),
    csrf_token: text(row.csrf_token),
    expires_at: text(row.expires_at),
    ip: textOrNull(row.ip),
    user_agent: textOrNull(row.user_agent),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapApi(row: Row): ApiRecord {
  return {
    id: text(row.id),
    name: text(row.name),
    slug: text(row.slug),
    description: textOrNull(row.description),
    owner_user_id: text(row.owner_user_id),
    ferrum_proxy_id: textOrNull(row.ferrum_proxy_id),
    upstream_url: textOrNull(row.upstream_url),
    namespace: text(row.namespace),
    version: text(row.version),
    spec_format: 'openapi',
    requestable: bool(row.requestable),
    auth_plugin: text(row.auth_plugin) as AuthPluginType,
    rate_limit: json<RateLimitConfig | null>(row.rate_limit_json, null),
    cors: json<CorsConfig | null>(row.cors_json, null),
    status: text(row.status) as ApiStatus,
    visibility: text(row.visibility) as ApiVisibility,
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapApiSpec(row: Row): ApiSpecRecord {
  return {
    id: text(row.id),
    api_id: text(row.api_id),
    version: text(row.version),
    raw_spec: text(row.raw_spec),
    parsed_title: textOrNull(row.parsed_title),
    parsed_version: textOrNull(row.parsed_version),
    is_current: bool(row.is_current),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapAccessRequest(row: Row): AccessRequestRecord {
  return {
    id: text(row.id),
    api_id: text(row.api_id),
    user_id: text(row.user_id),
    justification: text(row.justification),
    status: text(row.status) as AccessRequestStatus,
    decided_by: textOrNull(row.decided_by),
    decided_at: textOrNull(row.decided_at),
    decision_note: textOrNull(row.decision_note),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapGrant(row: Row): GrantRecord {
  return {
    id: text(row.id),
    api_id: text(row.api_id),
    user_id: text(row.user_id),
    access_request_id: textOrNull(row.access_request_id),
    acl_group: text(row.acl_group),
    status: text(row.status) as GrantStatus,
    granted_by: text(row.granted_by),
    revoked_by: textOrNull(row.revoked_by),
    revoked_at: textOrNull(row.revoked_at),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapCredential(row: Row): CredentialRecord {
  return {
    id: text(row.id),
    user_id: text(row.user_id),
    ferrum_consumer_id: text(row.ferrum_consumer_id),
    credential_type: text(row.credential_type) as CredentialType,
    ferrum_credential_id: text(row.ferrum_credential_id),
    fingerprint: text(row.fingerprint),
    last4: text(row.last4),
    label: textOrNull(row.label),
    status: text(row.status) as CredentialStatus,
    rotated_from_id: textOrNull(row.rotated_from_id),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapConsumer(row: Row): ConsumerRecord {
  return {
    id: text(row.id),
    user_id: text(row.user_id),
    namespace: text(row.namespace),
    ferrum_consumer_id: text(row.ferrum_consumer_id),
    ferrum_username: text(row.ferrum_username),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapThread(row: Row): ThreadRecord {
  return {
    id: text(row.id),
    subject: text(row.subject),
    api_id: textOrNull(row.api_id),
    created_by: text(row.created_by),
    participant_a: text(row.participant_a),
    participant_b: textOrNull(row.participant_b),
    last_message_at: textOrNull(row.last_message_at),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapMessage(row: Row): MessageRecord {
  return {
    id: text(row.id),
    thread_id: text(row.thread_id),
    sender_user_id: text(row.sender_user_id),
    body: text(row.body),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapNotification(row: Row): NotificationRecord {
  return {
    id: text(row.id),
    user_id: text(row.user_id),
    type: text(row.type) as NotificationType,
    title: text(row.title),
    body: text(row.body),
    link: textOrNull(row.link),
    read_at: textOrNull(row.read_at),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapOutbox(row: Row): EmailOutboxRecord {
  return {
    id: text(row.id),
    to_email: text(row.to_email),
    subject: text(row.subject),
    body_html: text(row.body_html),
    body_text: text(row.body_text),
    status: text(row.status) as EmailOutboxStatus,
    attempts: int(row.attempts),
    next_attempt_at: textOrNull(row.next_attempt_at),
    last_error: textOrNull(row.last_error),
    idempotency_key: textOrNull(row.idempotency_key),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapAuditLog(row: Row): AuditLogRecord {
  return {
    id: text(row.id),
    actor_user_id: textOrNull(row.actor_user_id),
    actor_role: textOrNull(row.actor_role) as Role | null,
    action: text(row.action),
    target_type: text(row.target_type),
    target_id: textOrNull(row.target_id),
    details: json<Record<string, unknown>>(row.details_json, {}),
    ip: textOrNull(row.ip),
    created_at: text(row.created_at),
  };
}

function mapSetting(row: Row): SettingRecord {
  return {
    key: text(row.key),
    value: json<unknown>(row.value_json, null),
    encrypted: bool(row.encrypted),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapEmailTemplate(row: Row): EmailTemplateRecord {
  return {
    id: text(row.id),
    key: text(row.key) as EmailTemplateKey,
    subject: text(row.subject),
    body_html: text(row.body_html),
    body_text: text(row.body_text),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function mapVerificationToken(row: Row): VerificationTokenRecord {
  return {
    id: text(row.id),
    user_id: text(row.user_id),
    token_hash: text(row.token_hash),
    expires_at: text(row.expires_at),
    used_at: textOrNull(row.used_at),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

/* ── Filter builders (shared by list/count) ─────────────────────────────── */

function userWhere(filter: UserFilter): SqlWhereBuilder {
  const builder = new SqlWhereBuilder()
    .add(filter.role, 'role = ?', filter.role ?? null)
    .add(filter.status, 'status = ?', filter.status ?? null)
    .addSearch(filter.q, ['email', 'display_name']);
  if (filter.roles !== undefined) builder.addIn('role', filter.roles);
  if (filter.ids !== undefined) builder.addIn('id', filter.ids);
  if (filter.org_id !== undefined) {
    if (filter.org_id === null) builder.always('org_id IS NULL');
    else builder.always('org_id = ?', filter.org_id);
  }
  if (filter.email_verified !== undefined) {
    builder.always('email_verified = ?', encodeBool(filter.email_verified));
  }
  return builder;
}

function apiWhere(filter: ApiFilter): SqlWhereBuilder {
  const builder = new SqlWhereBuilder()
    .add(filter.owner_user_id, 'owner_user_id = ?', filter.owner_user_id ?? null)
    .add(filter.status, 'status = ?', filter.status ?? null)
    .add(filter.visibility, 'visibility = ?', filter.visibility ?? null)
    .addSearch(filter.q, ['name', 'slug', 'description']);
  if (filter.requestable !== undefined) {
    builder.always('requestable = ?', encodeBool(filter.requestable));
  }
  if (filter.ids !== undefined) builder.addIn('id', filter.ids);
  return builder;
}

function accessRequestWhere(filter: AccessRequestFilter): SqlWhereBuilder {
  const builder = new SqlWhereBuilder()
    .add(filter.user_id, 'user_id = ?', filter.user_id ?? null)
    .add(filter.api_id, 'api_id = ?', filter.api_id ?? null)
    .add(filter.status, 'status = ?', filter.status ?? null);
  if (filter.api_ids !== undefined) builder.addIn('api_id', filter.api_ids);
  return builder;
}

function grantWhere(filter: GrantFilter): SqlWhereBuilder {
  const builder = new SqlWhereBuilder()
    .add(filter.user_id, 'user_id = ?', filter.user_id ?? null)
    .add(filter.api_id, 'api_id = ?', filter.api_id ?? null)
    .add(filter.status, 'status = ?', filter.status ?? null);
  if (filter.api_ids !== undefined) builder.addIn('api_id', filter.api_ids);
  return builder;
}

function credentialWhere(filter: CredentialFilter): SqlWhereBuilder {
  return new SqlWhereBuilder()
    .add(filter.user_id, 'user_id = ?', filter.user_id ?? null)
    .add(filter.status, 'status = ?', filter.status ?? null)
    .add(filter.credential_type, 'credential_type = ?', filter.credential_type ?? null)
    .add(filter.ferrum_consumer_id, 'ferrum_consumer_id = ?', filter.ferrum_consumer_id ?? null);
}

function auditWhere(filter: AuditLogFilter): SqlWhereBuilder {
  const builder = new SqlWhereBuilder()
    .add(filter.actor_user_id, 'actor_user_id = ?', filter.actor_user_id ?? null)
    .add(filter.action, 'action = ?', filter.action ?? null)
    .add(filter.target_type, 'target_type = ?', filter.target_type ?? null)
    .add(filter.target_id, 'target_id = ?', filter.target_id ?? null)
    .add(filter.from, 'created_at >= ?', filter.from ?? null)
    .add(filter.to, 'created_at < ?', filter.to ?? null);
  if (filter.actions !== undefined) builder.addIn('action', filter.actions);
  return builder;
}

/* ── Small dialect shims ────────────────────────────────────────────────── */

/**
 * `column <=> ?` — an equality test where `NULL = NULL` is true.
 *
 * SQLite spells it `column IS ?`; neither PostgreSQL nor MySQL accepts that
 * form, and they disagree with each other too.
 */
function nullSafeEq(dialect: SqlDialect, column: string): string {
  return dialect === 'mysql' ? `${column} <=> ?` : `${column} IS NOT DISTINCT FROM ?`;
}

/**
 * `ORDER BY` fragment placing NULLs first, portably.
 *
 * SQLite and MySQL sort NULLs first on `ASC`; PostgreSQL sorts them last, and
 * its `NULLS FIRST` modifier is not MySQL syntax. Sorting on the nullness test
 * itself works everywhere.
 */
function nullsFirstAsc(column: string): string {
  return `(${column} IS NULL) DESC, ${column} ASC`;
}

/** Comma-separated `?` placeholders for an `IN (...)` list. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/* ── Timestamps ─────────────────────────────────────────────────────────── */

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

/* ── The repositories ───────────────────────────────────────────────────── */

/** Every repository of {@link NexusStore}, bound to one executor. */
export interface SqlRepos {
  users: UserRepo;
  organizations: OrganizationRepo;
  sessions: SessionRepo;
  apis: ApiRepo;
  apiSpecs: ApiSpecRepo;
  accessRequests: AccessRequestRepo;
  grants: GrantRepo;
  credentials: CredentialRepo;
  consumers: ConsumerRepo;
  threads: ThreadRepo;
  messages: MessageRepo;
  notifications: NotificationRepo;
  emailOutbox: EmailOutboxRepo;
  auditLogs: AuditLogRepo;
  settings: SettingRepo;
  emailTemplates: EmailTemplateRepo;
  verificationTokens: VerificationTokenRepo;
}

/**
 * Build every repository over `exec`.
 *
 * @param exec          Pool or transaction connection every statement runs on.
 * @param inTransaction Used by the few operations that must be atomic even when
 *                      the caller did not open a transaction. When `exec` is
 *                      already transaction-scoped this must simply invoke the
 *                      callback with `exec`, so the operations join rather than
 *                      nest.
 */
export function createSqlRepos(exec: SqlExecutor, inTransaction: SqlTransactionRunner): SqlRepos {
  const dialect = exec.dialect;

  /* ── users ──────────────────────────────────────────────────────────── */

  const users: UserRepo = {
    create: async (input: CreateInput<UserRecord>): Promise<UserRecord> => {
      const meta = stamps(input);
      const columns: Record<string, SqlParam | undefined> = {
        id: meta.id,
        email: input.email.trim().toLowerCase(),
        password_hash: input.password_hash,
        display_name: input.display_name,
        role: input.role,
        org_id: input.org_id ?? null,
        company: input.company ?? null,
        phone: input.phone ?? null,
        status: input.status,
        email_verified: encodeBool(input.email_verified),
        last_login_at: input.last_login_at ?? null,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
      };
      const parts = insertParts(columns);
      await mapSqlConflict('An account with that email address already exists', () =>
        execute(
          exec,
          `INSERT INTO users (${parts.names}) VALUES (${parts.placeholders})`,
          parts.params,
        ),
      );
      const created = await users.findById(meta.id);
      if (!created) throw new Error('users.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM users WHERE id = ?', [id]);
      return row ? mapUser(row) : null;
    },

    findByEmail: async (email) => {
      const row = await queryOne(exec, 'SELECT * FROM users WHERE lower(email) = ?', [
        email.trim().toLowerCase(),
      ]);
      return row ? mapUser(row) : null;
    },

    findManyByIds: async (ids) => {
      if (ids.length === 0) return [];
      const rows = await queryAll(
        exec,
        `SELECT * FROM users WHERE id IN (${placeholders(ids.length)})`,
        ids,
      );
      return rows.map(mapUser);
    },

    update: async (id, patch) => {
      const set = setParts(userUpdateColumns(patch));
      if (set) {
        await mapSqlConflict('An account with that email address already exists', () =>
          execute(exec, `UPDATE users SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return users.findById(id);
    },

    updateIfMatches: async (id, expected, patch) => {
      const guard = new SqlWhereBuilder()
        .always('id = ?', id)
        .add(expected.role, 'role = ?', expected.role ?? null)
        .add(expected.status, 'status = ?', expected.status ?? null)
        .build();
      /**
       * Did the row survive the predicate?
       *
       * Reached when the `UPDATE` reported no change, which is not the same as
       * "somebody else got here first": MySQL counts *changed* rows, not
       * matched ones, so a patch that wrote identical values inside the same
       * millisecond looks like a loss. Re-reading the predicate separates the
       * two — a genuine loser no longer satisfies it.
       */
      const stillMatches = async (): Promise<UserRecord | null> => {
        const row = await queryOne(exec, `SELECT id FROM users${guard.sql}`, guard.params);
        return row ? users.findById(id) : null;
      };

      const set = setParts(userUpdateColumns(patch));
      if (!set) return stillMatches();

      const changed = await mapSqlConflict(
        'An account with that email address already exists',
        () =>
          execute(exec, `UPDATE users SET ${set.sql}, updated_at = ?${guard.sql}`, [
            ...set.params,
            nowIso(),
            ...guard.params,
          ]),
      );
      return changed > 0 ? users.findById(id) : stillMatches();
    },

    touchLastLogin: async (id, at) => {
      await execute(exec, 'UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [
        at,
        nowIso(),
        id,
      ]);
    },

    list: async (filter, options) => {
      const where = userWhere(filter).build();
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM users${where.sql}`,
        where.params,
      );
      const rows = await queryAll(
        exec,
        `SELECT * FROM users${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapUser), total };
    },

    count: async (filter = {}) => {
      const where = userWhere(filter).build();
      return queryCount(exec, `SELECT COUNT(*) AS cnt FROM users${where.sql}`, where.params);
    },

    countActiveSuperAdmins: async (excludeUserId) => {
      const where = new SqlWhereBuilder()
        .always("role = 'super_admin'")
        .always("status = 'active'")
        .add(excludeUserId, 'id <> ?', excludeUserId ?? null)
        .build();
      return queryCount(exec, `SELECT COUNT(*) AS cnt FROM users${where.sql}`, where.params);
    },

    listRecipients: async (filter) => {
      const where = userWhere(filter).build();
      const rows = await queryAll(
        exec,
        `SELECT * FROM users${where.sql} ORDER BY created_at ASC, id ASC`,
        where.params,
      );
      return rows.map(mapUser);
    },
  };

  /* ── organizations ──────────────────────────────────────────────────── */

  const organizations: OrganizationRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapSqlConflict('An organization with that name already exists', () =>
        execute(
          exec,
          'INSERT INTO organizations (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [meta.id, input.name, input.description ?? null, meta.created_at, meta.updated_at],
        ),
      );
      const created = await organizations.findById(meta.id);
      if (!created) throw new Error('organizations.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM organizations WHERE id = ?', [id]);
      return row ? mapOrganization(row) : null;
    },

    findByName: async (name) => {
      const row = await queryOne(exec, 'SELECT * FROM organizations WHERE lower(name) = ?', [
        name.trim().toLowerCase(),
      ]);
      return row ? mapOrganization(row) : null;
    },

    update: async (id, patch) => {
      const set = setParts({ name: patch.name, description: patch.description });
      if (set) {
        await mapSqlConflict('An organization with that name already exists', () =>
          execute(exec, `UPDATE organizations SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return organizations.findById(id);
    },

    list: async (options) => {
      const { limit, offset } = page(options);
      const total = await queryCount(exec, 'SELECT COUNT(*) AS cnt FROM organizations');
      const rows = await queryAll(
        exec,
        'SELECT * FROM organizations ORDER BY lower(name) ASC LIMIT ? OFFSET ?',
        [limit, offset],
      );
      return { items: rows.map(mapOrganization), total };
    },

    delete: async (id) => (await execute(exec, 'DELETE FROM organizations WHERE id = ?', [id])) > 0,
  };

  /* ── sessions ───────────────────────────────────────────────────────── */

  const sessions: SessionRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapSqlConflict('Session token collision', () =>
        execute(
          exec,
          `INSERT INTO sessions
             (id, token_hash, user_id, csrf_token, expires_at, ip, user_agent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            meta.id,
            input.token_hash,
            input.user_id,
            input.csrf_token,
            input.expires_at,
            input.ip ?? null,
            input.user_agent ?? null,
            meta.created_at,
            meta.updated_at,
          ],
        ),
      );
      const created = await sessions.findById(meta.id);
      if (!created) throw new Error('sessions.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM sessions WHERE id = ?', [id]);
      return row ? mapSession(row) : null;
    },

    findByTokenHash: async (tokenHash) => {
      const row = await queryOne(exec, 'SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
      return row ? mapSession(row) : null;
    },

    touch: async (id, expiresAt) => {
      await execute(exec, 'UPDATE sessions SET expires_at = ?, updated_at = ? WHERE id = ?', [
        expiresAt,
        nowIso(),
        id,
      ]);
    },

    delete: async (id) => (await execute(exec, 'DELETE FROM sessions WHERE id = ?', [id])) > 0,

    deleteByTokenHash: async (tokenHash) =>
      (await execute(exec, 'DELETE FROM sessions WHERE token_hash = ?', [tokenHash])) > 0,

    deleteForUser: async (userId) =>
      execute(exec, 'DELETE FROM sessions WHERE user_id = ?', [userId]),

    deleteExpired: async (now) =>
      execute(exec, 'DELETE FROM sessions WHERE expires_at <= ?', [now]),
  };

  /* ── apis ───────────────────────────────────────────────────────────── */

  const apis: ApiRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapSqlConflict('An API with that slug already exists', () =>
        execute(
          exec,
          `INSERT INTO apis
             (id, name, slug, description, owner_user_id, ferrum_proxy_id, upstream_url,
              namespace, version, spec_format, requestable, auth_plugin, rate_limit_json,
              cors_json, status, visibility, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            meta.id,
            input.name,
            input.slug,
            input.description ?? null,
            input.owner_user_id,
            input.ferrum_proxy_id ?? null,
            input.upstream_url ?? null,
            input.namespace,
            input.version,
            input.spec_format,
            encodeBool(input.requestable),
            input.auth_plugin,
            encodeJson(input.rate_limit ?? null),
            encodeJson(input.cors ?? null),
            input.status,
            input.visibility,
            meta.created_at,
            meta.updated_at,
          ],
        ),
      );
      const created = await apis.findById(meta.id);
      if (!created) throw new Error('apis.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM apis WHERE id = ?', [id]);
      return row ? mapApi(row) : null;
    },

    findBySlug: async (slug) => {
      const row = await queryOne(exec, 'SELECT * FROM apis WHERE lower(slug) = ?', [
        slug.trim().toLowerCase(),
      ]);
      return row ? mapApi(row) : null;
    },

    findByProxyId: async (ferrumProxyId) => {
      const row = await queryOne(exec, 'SELECT * FROM apis WHERE ferrum_proxy_id = ?', [
        ferrumProxyId,
      ]);
      return row ? mapApi(row) : null;
    },

    findManyByIds: async (ids) => {
      if (ids.length === 0) return [];
      const rows = await queryAll(
        exec,
        `SELECT * FROM apis WHERE id IN (${placeholders(ids.length)})`,
        ids,
      );
      return rows.map(mapApi);
    },

    update: async (id, patch) => {
      const set = setParts({
        name: patch.name,
        slug: patch.slug,
        description: patch.description,
        owner_user_id: patch.owner_user_id,
        ferrum_proxy_id: patch.ferrum_proxy_id,
        upstream_url: patch.upstream_url,
        namespace: patch.namespace,
        version: patch.version,
        requestable: patch.requestable === undefined ? undefined : encodeBool(patch.requestable),
        auth_plugin: patch.auth_plugin,
        rate_limit_json: patch.rate_limit === undefined ? undefined : encodeJson(patch.rate_limit),
        cors_json: patch.cors === undefined ? undefined : encodeJson(patch.cors),
        status: patch.status,
        visibility: patch.visibility,
      });
      if (set) {
        await mapSqlConflict('An API with that slug already exists', () =>
          execute(exec, `UPDATE apis SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return apis.findById(id);
    },

    list: async (filter, options) => {
      const where = apiWhere(filter).build();
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM apis${where.sql}`,
        where.params,
      );
      const rows = await queryAll(
        exec,
        `SELECT * FROM apis${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapApi), total };
    },

    count: async (filter = {}) => {
      const where = apiWhere(filter).build();
      return queryCount(exec, `SELECT COUNT(*) AS cnt FROM apis${where.sql}`, where.params);
    },

    listIdsByOwner: async (ownerUserId) =>
      (await queryAll(exec, 'SELECT id FROM apis WHERE owner_user_id = ?', [ownerUserId])).map(
        (row) => text(row.id),
      ),

    delete: async (id) => (await execute(exec, 'DELETE FROM apis WHERE id = ?', [id])) > 0,
  };

  /* ── apiSpecs ───────────────────────────────────────────────────────── */

  const apiSpecs: ApiSpecRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapSqlConflict('That spec revision already exists', () =>
        inTransaction(async (tx) => {
          if (input.is_current) {
            await execute(
              tx,
              'UPDATE api_specs SET is_current = 0, updated_at = ? WHERE api_id = ? AND is_current = 1',
              [meta.updated_at, input.api_id],
            );
          }
          await execute(
            tx,
            `INSERT INTO api_specs
               (id, api_id, version, raw_spec, parsed_title, parsed_version, is_current, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              meta.id,
              input.api_id,
              input.version,
              input.raw_spec,
              input.parsed_title ?? null,
              input.parsed_version ?? null,
              encodeBool(input.is_current),
              meta.created_at,
              meta.updated_at,
            ],
          );
        }),
      );
      const created = await apiSpecs.findById(meta.id);
      if (!created) throw new Error('apiSpecs.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM api_specs WHERE id = ?', [id]);
      return row ? mapApiSpec(row) : null;
    },

    findCurrentByApi: async (apiId) => {
      const row = await queryOne(
        exec,
        'SELECT * FROM api_specs WHERE api_id = ? AND is_current = 1',
        [apiId],
      );
      return row ? mapApiSpec(row) : null;
    },

    setCurrent: async (apiId, specId) => {
      await inTransaction(async (tx) => {
        const at = nowIso();
        await execute(
          tx,
          'UPDATE api_specs SET is_current = 0, updated_at = ? WHERE api_id = ? AND id <> ?',
          [at, apiId, specId],
        );
        await execute(
          tx,
          'UPDATE api_specs SET is_current = 1, updated_at = ? WHERE api_id = ? AND id = ?',
          [at, apiId, specId],
        );
      });
    },

    list: async (filter, options) => {
      const where = new SqlWhereBuilder()
        .add(filter.api_id, 'api_id = ?', filter.api_id ?? null)
        .add(
          filter.is_current,
          'is_current = ?',
          filter.is_current === undefined ? null : encodeBool(filter.is_current),
        )
        .build();
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM api_specs${where.sql}`,
        where.params,
      );
      const rows = await queryAll(
        exec,
        `SELECT * FROM api_specs${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapApiSpec), total };
    },

    delete: async (id) => (await execute(exec, 'DELETE FROM api_specs WHERE id = ?', [id])) > 0,

    deleteByApi: async (apiId) => execute(exec, 'DELETE FROM api_specs WHERE api_id = ?', [apiId]),
  };

  /* ── accessRequests ─────────────────────────────────────────────────── */

  const accessRequests: AccessRequestRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapSqlConflict('You already have a pending request for this API', () =>
        execute(
          exec,
          `INSERT INTO access_requests
             (id, api_id, user_id, justification, status, decided_by, decided_at, decision_note,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            meta.id,
            input.api_id,
            input.user_id,
            input.justification,
            input.status,
            input.decided_by ?? null,
            input.decided_at ?? null,
            input.decision_note ?? null,
            meta.created_at,
            meta.updated_at,
          ],
        ),
      );
      const created = await accessRequests.findById(meta.id);
      if (!created) throw new Error('accessRequests.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM access_requests WHERE id = ?', [id]);
      return row ? mapAccessRequest(row) : null;
    },

    update: async (id, patch) => {
      const set = setParts(accessRequestUpdateColumns(patch));
      if (set) {
        await mapSqlConflict('You already have a pending request for this API', () =>
          execute(exec, `UPDATE access_requests SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return accessRequests.findById(id);
    },

    updateIfStatus: async (id, expected, patch) => {
      // See `users.updateIfMatches` for why "no rows changed" is re-read
      // rather than reported as a lost race outright.
      const stillMatches = async (): Promise<AccessRequestRecord | null> => {
        const row = await queryOne(
          exec,
          'SELECT id FROM access_requests WHERE id = ? AND status = ?',
          [id, expected],
        );
        return row ? accessRequests.findById(id) : null;
      };

      const set = setParts(accessRequestUpdateColumns(patch));
      if (!set) return stillMatches();

      const changed = await mapSqlConflict('You already have a pending request for this API', () =>
        execute(
          exec,
          `UPDATE access_requests SET ${set.sql}, updated_at = ? WHERE id = ? AND status = ?`,
          [...set.params, nowIso(), id, expected],
        ),
      );
      return changed > 0 ? accessRequests.findById(id) : stillMatches();
    },

    list: async (filter, options) => {
      const where = accessRequestWhere(filter).build();
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM access_requests${where.sql}`,
        where.params,
      );
      const rows = await queryAll(
        exec,
        `SELECT * FROM access_requests${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapAccessRequest), total };
    },

    findPendingByApiAndUser: async (apiId, userId) => {
      const row = await queryOne(
        exec,
        "SELECT * FROM access_requests WHERE api_id = ? AND user_id = ? AND status = 'pending'",
        [apiId, userId],
      );
      return row ? mapAccessRequest(row) : null;
    },

    findLatestByApiAndUser: async (apiId, userId) => {
      const row = await queryOne(
        exec,
        `SELECT * FROM access_requests WHERE api_id = ? AND user_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [apiId, userId],
      );
      return row ? mapAccessRequest(row) : null;
    },

    listLatestForUser: async (userId, apiIds) => {
      if (apiIds.length === 0) return [];
      // One row per API — the newest request the user made for it. SQLite gets
      // there with `GROUP BY r.api_id`; the portable spelling is a window
      // function, supported by PostgreSQL and MySQL 8.
      const rows = await queryAll(
        exec,
        `SELECT id, api_id, user_id, justification, status, decided_by, decided_at,
                decision_note, created_at, updated_at
         FROM (
           SELECT r.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY r.api_id ORDER BY r.created_at DESC, r.id DESC
                  ) AS rn
           FROM access_requests r
           WHERE r.user_id = ? AND r.api_id IN (${placeholders(apiIds.length)})
         ) ranked
         WHERE rn = 1`,
        [userId, ...apiIds],
      );
      return rows.map(mapAccessRequest);
    },

    count: async (filter) => {
      const where = accessRequestWhere(filter).build();
      return queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM access_requests${where.sql}`,
        where.params,
      );
    },

    deleteByApi: async (apiId) =>
      execute(exec, 'DELETE FROM access_requests WHERE api_id = ?', [apiId]),
  };

  /* ── grants ─────────────────────────────────────────────────────────── */

  const grants: GrantRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapSqlConflict('An active grant already exists for this API and user', () =>
        execute(
          exec,
          `INSERT INTO grants
             (id, api_id, user_id, access_request_id, acl_group, status, granted_by, revoked_by,
              revoked_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            meta.id,
            input.api_id,
            input.user_id,
            input.access_request_id ?? null,
            input.acl_group,
            input.status,
            input.granted_by,
            input.revoked_by ?? null,
            input.revoked_at ?? null,
            meta.created_at,
            meta.updated_at,
          ],
        ),
      );
      const created = await grants.findById(meta.id);
      if (!created) throw new Error('grants.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM grants WHERE id = ?', [id]);
      return row ? mapGrant(row) : null;
    },

    update: async (id, patch) => {
      const set = setParts(grantUpdateColumns(patch));
      if (set) {
        await mapSqlConflict('An active grant already exists for this API and user', () =>
          execute(exec, `UPDATE grants SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return grants.findById(id);
    },

    updateIfStatus: async (id, expected, patch) => {
      // See `users.updateIfMatches` for why "no rows changed" is re-read
      // rather than reported as a lost race outright.
      const stillMatches = async (): Promise<GrantRecord | null> => {
        const row = await queryOne(exec, 'SELECT id FROM grants WHERE id = ? AND status = ?', [
          id,
          expected,
        ]);
        return row ? grants.findById(id) : null;
      };

      const set = setParts(grantUpdateColumns(patch));
      if (!set) return stillMatches();

      const changed = await mapSqlConflict(
        'An active grant already exists for this API and user',
        () =>
          execute(
            exec,
            `UPDATE grants SET ${set.sql}, updated_at = ? WHERE id = ? AND status = ?`,
            [...set.params, nowIso(), id, expected],
          ),
      );
      return changed > 0 ? grants.findById(id) : stillMatches();
    },

    list: async (filter, options) => {
      const where = grantWhere(filter).build();
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM grants${where.sql}`,
        where.params,
      );
      const rows = await queryAll(
        exec,
        `SELECT * FROM grants${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapGrant), total };
    },

    findActiveByApiAndUser: async (apiId, userId) => {
      const row = await queryOne(
        exec,
        "SELECT * FROM grants WHERE api_id = ? AND user_id = ? AND status = 'active'",
        [apiId, userId],
      );
      return row ? mapGrant(row) : null;
    },

    listActiveByUser: async (userId) =>
      (
        await queryAll(exec, "SELECT * FROM grants WHERE user_id = ? AND status = 'active'", [
          userId,
        ])
      ).map(mapGrant),

    listActiveByApi: async (apiId) =>
      (
        await queryAll(exec, "SELECT * FROM grants WHERE api_id = ? AND status = 'active'", [apiId])
      ).map(mapGrant),

    count: async (filter) => {
      const where = grantWhere(filter).build();
      return queryCount(exec, `SELECT COUNT(*) AS cnt FROM grants${where.sql}`, where.params);
    },

    deleteByApi: async (apiId) => execute(exec, 'DELETE FROM grants WHERE api_id = ?', [apiId]),
  };

  /* ── credentials ────────────────────────────────────────────────────── */

  const credentials: CredentialRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapSqlConflict('That credential is already registered', () =>
        execute(
          exec,
          `INSERT INTO credential_metadata
             (id, user_id, ferrum_consumer_id, credential_type, ferrum_credential_id, fingerprint,
              last4, label, status, rotated_from_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            meta.id,
            input.user_id,
            input.ferrum_consumer_id,
            input.credential_type,
            input.ferrum_credential_id,
            input.fingerprint,
            input.last4,
            input.label ?? null,
            input.status,
            input.rotated_from_id ?? null,
            meta.created_at,
            meta.updated_at,
          ],
        ),
      );
      const created = await credentials.findById(meta.id);
      if (!created) throw new Error('credentials.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM credential_metadata WHERE id = ?', [id]);
      return row ? mapCredential(row) : null;
    },

    update: async (id, patch) => {
      const set = setParts({
        label: patch.label,
        status: patch.status,
        ferrum_credential_id: patch.ferrum_credential_id,
        rotated_from_id: patch.rotated_from_id,
      });
      if (set) {
        await execute(
          exec,
          `UPDATE credential_metadata SET ${set.sql}, updated_at = ? WHERE id = ?`,
          [...set.params, nowIso(), id],
        );
      }
      return credentials.findById(id);
    },

    list: async (filter, options) => {
      const where = credentialWhere(filter).build();
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM credential_metadata${where.sql}`,
        where.params,
      );
      const rows = await queryAll(
        exec,
        `SELECT * FROM credential_metadata${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapCredential), total };
    },

    listByConsumer: async (ferrumConsumerId, type) => {
      const where = new SqlWhereBuilder()
        .always('ferrum_consumer_id = ?', ferrumConsumerId)
        .add(type, 'credential_type = ?', type ?? null)
        .build();
      const rows = await queryAll(
        exec,
        `SELECT * FROM credential_metadata${where.sql} ORDER BY created_at ASC, id ASC`,
        where.params,
      );
      return rows.map(mapCredential);
    },

    findByFingerprint: async (fingerprint) => {
      const row = await queryOne(exec, 'SELECT * FROM credential_metadata WHERE fingerprint = ?', [
        fingerprint,
      ]);
      return row ? mapCredential(row) : null;
    },

    count: async (filter) => {
      const where = credentialWhere(filter).build();
      return queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM credential_metadata${where.sql}`,
        where.params,
      );
    },

    delete: async (id) =>
      (await execute(exec, 'DELETE FROM credential_metadata WHERE id = ?', [id])) > 0,
  };

  /* ── consumers ──────────────────────────────────────────────────────── */

  const consumers: ConsumerRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapSqlConflict('A gateway consumer already exists for this user', () =>
        execute(
          exec,
          `INSERT INTO consumers
             (id, user_id, namespace, ferrum_consumer_id, ferrum_username, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            meta.id,
            input.user_id,
            input.namespace,
            input.ferrum_consumer_id,
            input.ferrum_username,
            meta.created_at,
            meta.updated_at,
          ],
        ),
      );
      const created = await consumers.findById(meta.id);
      if (!created) throw new Error('consumers.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM consumers WHERE id = ?', [id]);
      return row ? mapConsumer(row) : null;
    },

    findByUserAndNamespace: async (userId, namespace) => {
      const row = await queryOne(
        exec,
        'SELECT * FROM consumers WHERE user_id = ? AND namespace = ?',
        [userId, namespace],
      );
      return row ? mapConsumer(row) : null;
    },

    findByFerrumId: async (ferrumConsumerId) => {
      const row = await queryOne(exec, 'SELECT * FROM consumers WHERE ferrum_consumer_id = ?', [
        ferrumConsumerId,
      ]);
      return row ? mapConsumer(row) : null;
    },

    findByUsername: async (namespace, ferrumUsername) => {
      const row = await queryOne(
        exec,
        'SELECT * FROM consumers WHERE namespace = ? AND ferrum_username = ?',
        [namespace, ferrumUsername],
      );
      return row ? mapConsumer(row) : null;
    },

    update: async (id, patch) => {
      const set = setParts({
        ferrum_consumer_id: patch.ferrum_consumer_id,
        ferrum_username: patch.ferrum_username,
        namespace: patch.namespace,
      });
      if (set) {
        await mapSqlConflict('A gateway consumer already exists for this user', () =>
          execute(exec, `UPDATE consumers SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return consumers.findById(id);
    },

    list: async (filter, options) => {
      const where = new SqlWhereBuilder()
        .add(filter.user_id, 'user_id = ?', filter.user_id ?? null)
        .add(filter.namespace, 'namespace = ?', filter.namespace ?? null)
        .build();
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM consumers${where.sql}`,
        where.params,
      );
      const rows = await queryAll(
        exec,
        `SELECT * FROM consumers${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapConsumer), total };
    },

    delete: async (id) => (await execute(exec, 'DELETE FROM consumers WHERE id = ?', [id])) > 0,
  };

  /* ── threads ────────────────────────────────────────────────────────── */

  const threads: ThreadRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await execute(
        exec,
        `INSERT INTO message_threads
           (id, subject, api_id, created_by, participant_a, participant_b, last_message_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meta.id,
          input.subject,
          input.api_id ?? null,
          input.created_by,
          input.participant_a,
          input.participant_b ?? null,
          input.last_message_at ?? null,
          meta.created_at,
          meta.updated_at,
        ],
      );
      const created = await threads.findById(meta.id);
      if (!created) throw new Error('threads.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM message_threads WHERE id = ?', [id]);
      return row ? mapThread(row) : null;
    },

    update: async (id, patch) => {
      const set = setParts({
        subject: patch.subject,
        api_id: patch.api_id,
        participant_b: patch.participant_b,
        last_message_at: patch.last_message_at,
      });
      if (set) {
        await execute(exec, `UPDATE message_threads SET ${set.sql}, updated_at = ? WHERE id = ?`, [
          ...set.params,
          nowIso(),
          id,
        ]);
      }
      return threads.findById(id);
    },

    list: async (filter, options) => {
      const builder = new SqlWhereBuilder();
      if (filter.participant_user_id !== undefined) {
        // Seats only — `created_by` is provenance, not membership. See
        // `ThreadFilter.participant_user_id`.
        builder.always(
          '(participant_a = ? OR participant_b = ?)',
          filter.participant_user_id,
          filter.participant_user_id,
        );
      }
      builder.add(filter.api_id, 'api_id = ?', filter.api_id ?? null);
      builder.addSearch(filter.q, ['subject']);
      const where = builder.build();
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM message_threads${where.sql}`,
        where.params,
      );
      const rows = await queryAll(
        exec,
        `SELECT * FROM message_threads${where.sql}
         ORDER BY coalesce(last_message_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapThread), total };
    },

    findExisting: async (participantA, participantB, apiId) => {
      const row = await queryOne(
        exec,
        `SELECT * FROM message_threads
         WHERE ${nullSafeEq(dialect, 'api_id')}
           AND ((participant_a = ? AND ${nullSafeEq(dialect, 'participant_b')})
             OR (${nullSafeEq(dialect, 'participant_a')} AND participant_b = ?))
         ORDER BY created_at DESC LIMIT 1`,
        [apiId, participantA, participantB, participantB, participantA],
      );
      return row ? mapThread(row) : null;
    },

    touchLastMessage: async (threadId, at) => {
      await execute(
        exec,
        'UPDATE message_threads SET last_message_at = ?, updated_at = ? WHERE id = ?',
        [at, nowIso(), threadId],
      );
    },

    delete: async (id) =>
      (await execute(exec, 'DELETE FROM message_threads WHERE id = ?', [id])) > 0,
  };

  /* ── messages ───────────────────────────────────────────────────────── */

  const messages: MessageRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await execute(
        exec,
        `INSERT INTO messages (id, thread_id, sender_user_id, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          meta.id,
          input.thread_id,
          input.sender_user_id,
          input.body,
          meta.created_at,
          meta.updated_at,
        ],
      );
      const created = await messages.findById(meta.id);
      if (!created) throw new Error('messages.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM messages WHERE id = ?', [id]);
      return row ? mapMessage(row) : null;
    },

    listByThread: async (threadId, options) => {
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        'SELECT COUNT(*) AS cnt FROM messages WHERE thread_id = ?',
        [threadId],
      );
      const rows = await queryAll(
        exec,
        'SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?',
        [threadId, limit, offset],
      );
      return { items: rows.map(mapMessage), total };
    },

    findLatestByThread: async (threadId) => {
      const row = await queryOne(
        exec,
        'SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        [threadId],
      );
      return row ? mapMessage(row) : null;
    },

    countByThread: async (threadId) =>
      queryCount(exec, 'SELECT COUNT(*) AS cnt FROM messages WHERE thread_id = ?', [threadId]),

    deleteByThread: async (threadId) =>
      execute(exec, 'DELETE FROM messages WHERE thread_id = ?', [threadId]),
  };

  /* ── notifications ──────────────────────────────────────────────────── */

  const notifications: NotificationRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await execute(
        exec,
        `INSERT INTO notifications
           (id, user_id, type, title, body, link, read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meta.id,
          input.user_id,
          input.type,
          input.title,
          input.body,
          input.link ?? null,
          input.read_at ?? null,
          meta.created_at,
          meta.updated_at,
        ],
      );
      const created = await notifications.findById(meta.id);
      if (!created) throw new Error('notifications.create: row vanished immediately after insert');
      return created;
    },

    createMany: async (inputs) => {
      if (inputs.length === 0) return [];
      return inTransaction(async (tx) => {
        const created: NotificationRecord[] = [];
        for (const input of inputs) {
          const meta = stamps(input);
          await execute(
            tx,
            `INSERT INTO notifications
               (id, user_id, type, title, body, link, read_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              meta.id,
              input.user_id,
              input.type,
              input.title,
              input.body,
              input.link ?? null,
              input.read_at ?? null,
              meta.created_at,
              meta.updated_at,
            ],
          );
          const row = await queryOne(tx, 'SELECT * FROM notifications WHERE id = ?', [meta.id]);
          if (row) created.push(mapNotification(row));
        }
        return created;
      });
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM notifications WHERE id = ?', [id]);
      return row ? mapNotification(row) : null;
    },

    list: async (filter, options) => {
      const builder = new SqlWhereBuilder().always('user_id = ?', filter.user_id);
      if (filter.unread === true) builder.always('read_at IS NULL');
      if (filter.unread === false) builder.always('read_at IS NOT NULL');
      builder.add(filter.type, 'type = ?', filter.type ?? null);
      const where = builder.build();
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM notifications${where.sql}`,
        where.params,
      );
      const rows = await queryAll(
        exec,
        `SELECT * FROM notifications${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapNotification), total };
    },

    countUnread: async (userId) =>
      queryCount(
        exec,
        'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND read_at IS NULL',
        [userId],
      ),

    markRead: async (userId, ids, at) => {
      if (ids.length === 0) return 0;
      return execute(
        exec,
        `UPDATE notifications SET read_at = ?, updated_at = ?
         WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders(ids.length)})`,
        [at, nowIso(), userId, ...ids],
      );
    },

    markAllRead: async (userId, at) =>
      execute(
        exec,
        'UPDATE notifications SET read_at = ?, updated_at = ? WHERE user_id = ? AND read_at IS NULL',
        [at, nowIso(), userId],
      ),
  };

  /* ── emailOutbox ────────────────────────────────────────────────────── */

  const emailOutbox: EmailOutboxRepo = {
    enqueue: async (input) => {
      const key = input.idempotency_key ?? null;
      if (key !== null) {
        const existing = await emailOutbox.findByIdempotencyKey(key);
        if (existing) return { entry: existing, created: false };
      }
      const meta = stamps({ id: input.id });
      try {
        await execute(
          exec,
          `INSERT INTO email_outbox
             (id, to_email, subject, body_html, body_text, status, attempts, next_attempt_at,
              last_error, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?, ?)`,
          [
            meta.id,
            input.to_email,
            input.subject,
            input.body_html,
            input.body_text,
            input.next_attempt_at ?? meta.created_at,
            key,
            meta.created_at,
            meta.updated_at,
          ],
        );
      } catch (error) {
        // Lost a race on the idempotency key — return the winner.
        if (key !== null) {
          const existing = await emailOutbox.findByIdempotencyKey(key);
          if (existing) return { entry: existing, created: false };
        }
        throw error;
      }
      const entry = await emailOutbox.findById(meta.id);
      if (!entry) throw new Error('emailOutbox.enqueue: row vanished immediately after insert');
      return { entry, created: true };
    },

    findById: async (id) => {
      const row = await queryOne(exec, 'SELECT * FROM email_outbox WHERE id = ?', [id]);
      return row ? mapOutbox(row) : null;
    },

    findByIdempotencyKey: async (key) => {
      const row = await queryOne(exec, 'SELECT * FROM email_outbox WHERE idempotency_key = ?', [
        key,
      ]);
      return row ? mapOutbox(row) : null;
    },

    claimDue: async (now, limit) =>
      inTransaction(async (tx) => {
        // `FOR UPDATE SKIP LOCKED` is what makes two workers claim disjoint
        // batches: rows another transaction already holds are passed over
        // instead of blocking.
        const ids = (
          await queryAll(
            tx,
            `SELECT id FROM email_outbox
             WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY ${nullsFirstAsc('next_attempt_at')}, created_at ASC
             LIMIT ?${FOR_UPDATE_SKIP_LOCKED}`,
            [now, Math.max(1, Math.floor(limit))],
          )
        ).map((row) => text(row.id));
        if (ids.length === 0) return [];
        await execute(
          tx,
          `UPDATE email_outbox
           SET status = 'sending', attempts = attempts + 1, updated_at = ?
           WHERE id IN (${placeholders(ids.length)}) AND status = 'pending'`,
          [nowIso(), ...ids],
        );
        const rows = await queryAll(
          tx,
          `SELECT * FROM email_outbox WHERE id IN (${placeholders(ids.length)})`,
          ids,
        );
        return rows.map(mapOutbox);
      }),

    markSent: async (id, at) => {
      await execute(
        exec,
        `UPDATE email_outbox SET status = 'sent', next_attempt_at = NULL, last_error = NULL,
           updated_at = ? WHERE id = ?`,
        [at, id],
      );
    },

    reschedule: async (id, nextAttemptAt, lastError) => {
      await execute(
        exec,
        `UPDATE email_outbox SET status = 'pending', next_attempt_at = ?, last_error = ?,
           updated_at = ? WHERE id = ?`,
        [nextAttemptAt, lastError, nowIso(), id],
      );
    },

    markFailed: async (id, lastError) => {
      await execute(
        exec,
        `UPDATE email_outbox SET status = 'failed', next_attempt_at = NULL, last_error = ?,
           updated_at = ? WHERE id = ?`,
        [lastError, nowIso(), id],
      );
    },

    releaseStale: async (olderThan) =>
      execute(
        exec,
        `UPDATE email_outbox SET status = 'pending', next_attempt_at = ?, updated_at = ?
         WHERE status = 'sending' AND updated_at <= ?`,
        [nowIso(), nowIso(), olderThan],
      ),

    list: async (filter, options) => {
      const where = new SqlWhereBuilder()
        .add(filter.status, 'status = ?', filter.status ?? null)
        .add(filter.to_email, 'lower(to_email) = ?', (filter.to_email ?? '').toLowerCase())
        .build();
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM email_outbox${where.sql}`,
        where.params,
      );
      const rows = await queryAll(
        exec,
        `SELECT * FROM email_outbox${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapOutbox), total };
    },
  };

  /* ── auditLogs ──────────────────────────────────────────────────────── */

  const auditLogs: AuditLogRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await execute(
        exec,
        `INSERT INTO audit_logs
           (id, actor_user_id, actor_role, action, target_type, target_id, details_json, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meta.id,
          input.actor_user_id ?? null,
          input.actor_role ?? null,
          input.action,
          input.target_type,
          input.target_id ?? null,
          encodeJson(input.details ?? {}) ?? '{}',
          input.ip ?? null,
          meta.created_at,
        ],
      );
      const row = await queryOne(exec, 'SELECT * FROM audit_logs WHERE id = ?', [meta.id]);
      if (!row) throw new Error('auditLogs.create: row vanished immediately after insert');
      return mapAuditLog(row);
    },

    list: async (filter, options) => {
      const where = auditWhere(filter).build();
      const { limit, offset } = page(options);
      const total = await queryCount(
        exec,
        `SELECT COUNT(*) AS cnt FROM audit_logs${where.sql}`,
        where.params,
      );
      const rows = await queryAll(
        exec,
        `SELECT * FROM audit_logs${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapAuditLog), total };
    },

    count: async (filter) => {
      const where = auditWhere(filter).build();
      return queryCount(exec, `SELECT COUNT(*) AS cnt FROM audit_logs${where.sql}`, where.params);
    },
  };

  /* ── settings ───────────────────────────────────────────────────────── */

  // `key` is a reserved word in MySQL and not in PostgreSQL; the double quotes
  // are rewritten to backticks by formatSql for the MySQL driver.
  const SETTINGS_UPSERT = upsertSql(
    dialect,
    'app_settings',
    ['"key"', 'value_json', 'encrypted', 'created_at', 'updated_at'],
    '"key"',
    ['value_json', 'encrypted', 'updated_at'],
  );

  // "Insert unless the key is taken", spelled for each server. Both report 0
  // affected rows when the row already existed, which is the return value.
  const SETTINGS_INSERT_IF_ABSENT =
    dialect === 'pg'
      ? `INSERT INTO app_settings ("key", value_json, encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT ("key") DO NOTHING`
      : `INSERT IGNORE INTO app_settings ("key", value_json, encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`;

  const settings: SettingRepo = {
    get: async (key) => {
      const row = await queryOne(exec, 'SELECT * FROM app_settings WHERE "key" = ?', [key]);
      return row ? mapSetting(row) : null;
    },

    getMany: async (keys) => {
      if (keys.length === 0) return [];
      const rows = await queryAll(
        exec,
        `SELECT * FROM app_settings WHERE "key" IN (${placeholders(keys.length)})`,
        keys,
      );
      return rows.map(mapSetting);
    },

    set: async (key, value, encrypted = false) => {
      const at = nowIso();
      await execute(exec, SETTINGS_UPSERT, [
        key,
        JSON.stringify(value ?? null),
        encodeBool(encrypted),
        at,
        at,
      ]);
      const stored = await settings.get(key);
      if (!stored) throw new Error('settings.set: row vanished immediately after upsert');
      return stored;
    },

    insertIfAbsent: async (key, value, encrypted = false) => {
      const at = nowIso();
      const affected = await execute(exec, SETTINGS_INSERT_IF_ABSENT, [
        key,
        JSON.stringify(value ?? null),
        encodeBool(encrypted),
        at,
        at,
      ]);
      return affected > 0;
    },

    setMany: async (entries) => {
      if (entries.length === 0) return;
      await inTransaction(async (tx) => {
        const at = nowIso();
        for (const entry of entries) {
          await execute(tx, SETTINGS_UPSERT, [
            entry.key,
            JSON.stringify(entry.value ?? null),
            encodeBool(entry.encrypted),
            at,
            at,
          ]);
        }
      });
    },

    delete: async (key) =>
      (await execute(exec, 'DELETE FROM app_settings WHERE "key" = ?', [key])) > 0,

    all: async () =>
      (await queryAll(exec, 'SELECT * FROM app_settings ORDER BY "key" ASC')).map(mapSetting),
  };

  /* ── emailTemplates ─────────────────────────────────────────────────── */

  const TEMPLATE_UPSERT = upsertSql(
    dialect,
    'email_templates',
    ['id', '"key"', 'subject', 'body_html', 'body_text', 'created_at', 'updated_at'],
    '"key"',
    ['subject', 'body_html', 'body_text', 'updated_at'],
  );

  const emailTemplates: EmailTemplateRepo = {
    get: async (key) => {
      const row = await queryOne(exec, 'SELECT * FROM email_templates WHERE "key" = ?', [key]);
      return row ? mapEmailTemplate(row) : null;
    },

    upsert: async (key, value) => {
      const at = nowIso();
      await execute(exec, TEMPLATE_UPSERT, [
        newId(),
        key,
        value.subject,
        value.body_html,
        value.body_text,
        at,
        at,
      ]);
      const stored = await emailTemplates.get(key);
      if (!stored) throw new Error('emailTemplates.upsert: row vanished immediately after upsert');
      return stored;
    },

    list: async () =>
      (await queryAll(exec, 'SELECT * FROM email_templates ORDER BY "key" ASC')).map(
        mapEmailTemplate,
      ),

    delete: async (key) =>
      (await execute(exec, 'DELETE FROM email_templates WHERE "key" = ?', [key])) > 0,
  };

  /* ── verificationTokens ─────────────────────────────────────────────── */

  const verificationTokens: VerificationTokenRepo = {
    create: async (input) => {
      const meta = stamps(input);
      await mapSqlConflict('Verification token collision', () =>
        execute(
          exec,
          `INSERT INTO email_verification_tokens
             (id, user_id, token_hash, expires_at, used_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            meta.id,
            input.user_id,
            input.token_hash,
            input.expires_at,
            input.used_at ?? null,
            meta.created_at,
            meta.updated_at,
          ],
        ),
      );
      const row = await queryOne(exec, 'SELECT * FROM email_verification_tokens WHERE id = ?', [
        meta.id,
      ]);
      if (!row) throw new Error('verificationTokens.create: row vanished immediately after insert');
      return mapVerificationToken(row);
    },

    findByTokenHash: async (tokenHash) => {
      const row = await queryOne(
        exec,
        'SELECT * FROM email_verification_tokens WHERE token_hash = ?',
        [tokenHash],
      );
      return row ? mapVerificationToken(row) : null;
    },

    markUsed: async (id, at) =>
      (await execute(
        exec,
        'UPDATE email_verification_tokens SET used_at = ?, updated_at = ? WHERE id = ? AND used_at IS NULL',
        [at, nowIso(), id],
      )) > 0,

    deleteForUser: async (userId) =>
      execute(exec, 'DELETE FROM email_verification_tokens WHERE user_id = ?', [userId]),

    deleteExpired: async (now) =>
      execute(exec, 'DELETE FROM email_verification_tokens WHERE expires_at <= ?', [now]),
  };

  return {
    users,
    organizations,
    sessions,
    apis,
    apiSpecs,
    accessRequests,
    grants,
    credentials,
    consumers,
    threads,
    messages,
    notifications,
    emailOutbox,
    auditLogs,
    settings,
    emailTemplates,
    verificationTokens,
  };
}

/* ── The store shell ────────────────────────────────────────────────────── */

/**
 * Everything a concrete SQL adapter must supply. `postgres/index.ts` and
 * `mysql/index.ts` implement exactly this and nothing else — connection setup,
 * migration application, and the driver's native transaction primitive.
 */
export interface SqlStoreBackend {
  /** Reported as {@link NexusStore.driver}. */
  readonly driver: DbDriver;
  /** Executor bound to the connection pool, used outside transactions. */
  readonly pool: SqlExecutor;
  init(): Promise<void>;
  migrate(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<StoreHealth>;
  /**
   * Check out a dedicated connection, `BEGIN`, run `fn` on it, then `COMMIT`
   * on resolve or `ROLLBACK` on reject, releasing the connection either way.
   */
  withTransaction<T>(fn: (exec: SqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * A {@link NexusStore} over a {@link SqlStoreBackend}.
 *
 * Two behaviours are worth calling out, both of them deliberate fidelity to the
 * contract documented at the top of `db/store.ts`:
 *
 * **Transaction bodies are serialised.** A pool could happily run several
 * transactions at once, but the store contract promises the sqlite adapter's
 * observable behaviour — one body at a time — and services are entitled to rely
 * on it. A promise queue, the same shape the sqlite adapter uses, provides it;
 * it also makes it impossible for a burst of transactions to exhaust the pool.
 *
 * **A nested `transaction()` joins the outer one.** The store handed to a
 * transaction body is scoped to that connection, and calling `transaction()` on
 * *it* simply invokes the callback with itself rather than opening a second
 * transaction (which the drivers would either reject or silently flatten).
 */
class SqlStore implements NexusStore {
  readonly driver: DbDriver;

  readonly users: UserRepo;
  readonly organizations: OrganizationRepo;
  readonly sessions: SessionRepo;
  readonly apis: ApiRepo;
  readonly apiSpecs: ApiSpecRepo;
  readonly accessRequests: AccessRequestRepo;
  readonly grants: GrantRepo;
  readonly credentials: CredentialRepo;
  readonly consumers: ConsumerRepo;
  readonly threads: ThreadRepo;
  readonly messages: MessageRepo;
  readonly notifications: NotificationRepo;
  readonly emailOutbox: EmailOutboxRepo;
  readonly auditLogs: AuditLogRepo;
  readonly settings: SettingRepo;
  readonly emailTemplates: EmailTemplateRepo;
  readonly verificationTokens: VerificationTokenRepo;

  private readonly backend: SqlStoreBackend;

  /** Non-null only for a store scoped to an open transaction. */
  private readonly scoped: SqlExecutor | null;

  /** Serialises `transaction` bodies; see the class docblock. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(backend: SqlStoreBackend, scoped: SqlExecutor | null) {
    this.backend = backend;
    this.scoped = scoped;
    this.driver = backend.driver;

    const exec = scoped ?? backend.pool;
    const runner: SqlTransactionRunner = scoped
      ? (fn) => fn(scoped)
      : (fn) => this.runInTransaction(fn);
    const repos = createSqlRepos(exec, runner);

    this.users = repos.users;
    this.organizations = repos.organizations;
    this.sessions = repos.sessions;
    this.apis = repos.apis;
    this.apiSpecs = repos.apiSpecs;
    this.accessRequests = repos.accessRequests;
    this.grants = repos.grants;
    this.credentials = repos.credentials;
    this.consumers = repos.consumers;
    this.threads = repos.threads;
    this.messages = repos.messages;
    this.notifications = repos.notifications;
    this.emailOutbox = repos.emailOutbox;
    this.auditLogs = repos.auditLogs;
    this.settings = repos.settings;
    this.emailTemplates = repos.emailTemplates;
    this.verificationTokens = repos.verificationTokens;
  }

  init(): Promise<void> {
    return this.backend.init();
  }

  migrate(): Promise<void> {
    return this.backend.migrate();
  }

  close(): Promise<void> {
    return this.backend.close();
  }

  healthCheck(): Promise<StoreHealth> {
    return this.backend.healthCheck();
  }

  transaction<T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> {
    if (this.scoped) return fn(this);
    return this.runInTransaction((exec) => fn(new SqlStore(this.backend, exec)));
  }

  private runInTransaction<T>(fn: (exec: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.scoped) return fn(this.scoped);
    const run = (): Promise<T> => this.backend.withTransaction(fn);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Wrap a backend into the {@link NexusStore} the service layer consumes. */
export function createSqlStore(backend: SqlStoreBackend): NexusStore {
  return new SqlStore(backend, null);
}
