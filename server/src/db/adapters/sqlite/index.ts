/**
 * SQLite implementation of {@link NexusStore} (better-sqlite3).
 *
 * This is the reference adapter — the other three should mirror its
 * behaviour method for method. Two things are worth knowing before reading it:
 *
 * **Synchronous driver, async interface.** better-sqlite3 executes statements
 * synchronously. Every repository method therefore returns an already-settled
 * promise; nothing here ever yields to the event loop mid-statement.
 *
 * **Transactions are serialised by a promise queue.** Because the driver is
 * synchronous it cannot hold a `BEGIN` open across an `await`, so
 * {@link SqliteStore.transaction} funnels bodies through a per-connection
 * queue: one body at a time, `BEGIN IMMEDIATE` before it, `COMMIT` on resolve,
 * `ROLLBACK` on reject. A nested `transaction()` call from inside a body joins
 * the running transaction instead of starting a new one. The other adapters
 * must present the same contract using their native transaction primitive.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import BetterSqlite3, { type Database } from 'better-sqlite3';

import type {
  AccessRequestStatus,
  ApiPluginTrigger,
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
import { DEFAULT_SPEC_ENFORCEMENT, isSpecEnforcementLevel } from '@ferrum-nexus/shared';

import type { NexusConfig } from '../../../config/index.js';
import { newId, nowIso } from '../../../lib/ids.js';
import {
  loadMigrations,
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
  ApiPluginRecord,
  ApiPluginRepo,
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
  EnqueueEmailInput,
  GatewayTeardownJobFilter,
  GatewayTeardownJobRecord,
  GatewayTeardownJobRepo,
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
  VerificationTokenPurpose,
  VerificationTokenRecord,
  VerificationTokenRepo,
} from '../../store.js';
import {
  bool,
  encodeBool,
  encodeJson,
  execute,
  insertParts,
  int,
  json,
  mapConflict,
  page,
  queryAll,
  queryCount,
  queryOne,
  setParts,
  text,
  textOrNull,
  WhereBuilder,
  type Param,
  type Row,
} from './sql.js';

/* ── Row mappers ────────────────────────────────────────────────────────── */

/**
 * Decode the `spec_enforcement` column, falling back to `docs_only`.
 *
 * The CHECK constraint keeps the domain honest for rows this build wrote, but
 * a row a newer schema wrote with a level this binary has no generator for
 * must read back as "the gateway enforces nothing extra" rather than as an
 * enforcement mode nothing here can reconcile.
 */
function specEnforcement(value: unknown): SpecEnforcementLevel {
  const raw = text(value);
  return isSpecEnforcementLevel(raw) ? raw : DEFAULT_SPEC_ENFORCEMENT;
}

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
function userUpdateColumns(patch: UpdateInput<UserRecord>): Record<string, Param | undefined> {
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
): Record<string, Param | undefined> {
  return {
    justification: patch.justification,
    status: patch.status,
    decided_by: patch.decided_by,
    decided_at: patch.decided_at,
    decision_note: patch.decision_note,
  };
}

/** Encoded `SET` columns of a grant patch, shared by both updates. */
function grantUpdateColumns(patch: UpdateInput<GrantRecord>): Record<string, Param | undefined> {
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
    allowed_methods: json<HttpMethod[] | null>(row.allowed_methods_json, null),
    timeouts: json<ApiTimeouts | null>(row.timeouts_json, null),
    circuit_breaker: bool(row.circuit_breaker),
    spec_enforcement: specEnforcement(row.spec_enforcement),
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

function mapApiPlugin(row: Row): ApiPluginRecord {
  return {
    id: text(row.id),
    api_id: text(row.api_id),
    plugin_name: text(row.plugin_name),
    enabled: bool(row.enabled),
    config: json<Record<string, unknown>>(row.config_json, {}),
    trigger: json<ApiPluginTrigger | null>(row.trigger_json, null),
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

function mapTeardownJob(row: Row): GatewayTeardownJobRecord {
  return {
    id: text(row.id),
    user_id: text(row.user_id),
    status: text(row.status) as GatewayTeardownJobStatus,
    attempts: int(row.attempts),
    next_attempt_at: textOrNull(row.next_attempt_at),
    last_error: textOrNull(row.last_error),
    requested_by: textOrNull(row.requested_by),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
    completed_at: textOrNull(row.completed_at),
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
    purpose: text(row.purpose) as VerificationTokenPurpose,
    expires_at: text(row.expires_at),
    used_at: textOrNull(row.used_at),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

/* ── Connection ─────────────────────────────────────────────────────────── */

/** Open the database file (or an in-memory database) with Nexus's pragmas. */
export function openSqliteDatabase(path: string): Database {
  const isMemory = path === ':memory:' || path.startsWith('file::memory:');
  if (!isMemory) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
  }
  const db = new BetterSqlite3(isMemory ? ':memory:' : resolve(path));
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!isMemory) {
    // WAL only makes sense for file-backed databases.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  return db;
}

function createMigrationDriver(db: Database): MigrationDriver {
  return {
    async ensureMigrationsTable(): Promise<void> {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
           id TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL
         )`,
      );
    },
    async listApplied(): Promise<string[]> {
      return queryAll(db, `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`).map((row) => text(row.id));
    },
    async applyMigration(migration: MigrationFile): Promise<void> {
      const apply = db.transaction((file: MigrationFile) => {
        db.exec(file.sql);
        db.prepare(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`).run(
          file.id,
          nowIso(),
        );
      });
      apply(migration);
    },
  };
}

/* ── Store ──────────────────────────────────────────────────────────────── */

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

/** The SQLite {@link NexusStore}. Construct it with {@link createSqliteStore}. */
class SqliteStore implements NexusStore {
  readonly driver: DbDriver = 'sqlite';

  private readonly db: Database;

  /** Serialises `transaction` bodies; see the module docblock. */
  private queue: Promise<unknown> = Promise.resolve();

  private depth = 0;

  private closed = false;

  constructor(db: Database) {
    this.db = db;
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  async init(): Promise<void> {
    // Opening the handle is all the initialisation SQLite needs; the pragmas
    // were applied in openSqliteDatabase.
    this.db.pragma('foreign_keys = ON');
  }

  async migrate(): Promise<void> {
    await runMigrations(createMigrationDriver(this.db), loadMigrations('sqlite'));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async healthCheck(): Promise<StoreHealth> {
    const started = Date.now();
    try {
      queryOne(this.db, 'SELECT 1 AS ok');
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
    if (this.depth > 0) {
      // Already inside a transaction body — join it rather than nesting.
      return fn(this);
    }
    const run = async (): Promise<T> => {
      this.db.exec('BEGIN IMMEDIATE');
      this.depth += 1;
      try {
        const result = await fn(this);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // The transaction was already rolled back by SQLite; nothing to do.
        }
        throw error;
      } finally {
        this.depth -= 1;
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
      const columns: Record<string, Param | undefined> = {
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
      mapConflict('An account with that email address already exists', () =>
        execute(
          this.db,
          `INSERT INTO users (${parts.names}) VALUES (${parts.placeholders})`,
          parts.params,
        ),
      );
      const created = await this.users.findById(meta.id);
      if (!created) throw new Error('users.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM users WHERE id = ?', [id]);
      return row ? mapUser(row) : null;
    },

    findByEmail: async (email) => {
      const row = queryOne(this.db, 'SELECT * FROM users WHERE lower(email) = ?', [
        email.trim().toLowerCase(),
      ]);
      return row ? mapUser(row) : null;
    },

    findManyByIds: async (ids) => {
      if (ids.length === 0) return [];
      const rows = queryAll(
        this.db,
        `SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`,
        ids,
      );
      return rows.map(mapUser);
    },

    update: async (id, patch: UpdateInput<UserRecord>) => {
      const set = setParts(userUpdateColumns(patch));
      if (set) {
        mapConflict('An account with that email address already exists', () =>
          execute(this.db, `UPDATE users SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return this.users.findById(id);
    },

    updateIfMatches: async (id, expected, patch) => {
      const guard = new WhereBuilder()
        .always('id = ?', id)
        .add(expected.role, 'role = ?', expected.role ?? null)
        .add(expected.status, 'status = ?', expected.status ?? null)
        .build();
      const set = setParts(userUpdateColumns(patch));
      if (!set) {
        // Nothing to write: report whether the row still matches, so an empty
        // patch cannot look like a lost race.
        return queryOne(this.db, `SELECT * FROM users${guard.sql}`, guard.params)
          ? this.users.findById(id)
          : null;
      }
      const changed = mapConflict('An account with that email address already exists', () =>
        execute(this.db, `UPDATE users SET ${set.sql}, updated_at = ?${guard.sql}`, [
          ...set.params,
          nowIso(),
          ...guard.params,
        ]),
      );
      return changed > 0 ? this.users.findById(id) : null;
    },

    touchLastLogin: async (id, at) => {
      execute(this.db, 'UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [
        at,
        nowIso(),
        id,
      ]);
    },

    list: async (filter, options) => {
      const where = userWhere(filter).build();
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM users${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM users${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapUser), total };
    },

    count: async (filter = {}) => {
      const where = userWhere(filter).build();
      return queryCount(this.db, `SELECT COUNT(*) AS count FROM users${where.sql}`, where.params);
    },

    countActiveSuperAdmins: async (excludeUserId) => {
      const builder = new WhereBuilder()
        .always("role = 'super_admin'")
        .always("status = 'active'")
        .add(excludeUserId, 'id <> ?', excludeUserId ?? null);
      const where = builder.build();
      return queryCount(this.db, `SELECT COUNT(*) AS count FROM users${where.sql}`, where.params);
    },

    listRecipients: async (filter) => {
      const where = userWhere(filter).build();
      const rows = queryAll(
        this.db,
        `SELECT * FROM users${where.sql} ORDER BY created_at ASC, id ASC`,
        where.params,
      );
      return rows.map(mapUser);
    },
  };

  /* ── organizations ────────────────────────────────────────────────────── */

  readonly organizations: OrganizationRepo = {
    create: async (input) => {
      const meta = stamps(input);
      mapConflict('An organization with that name already exists', () =>
        execute(
          this.db,
          'INSERT INTO organizations (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [meta.id, input.name, input.description ?? null, meta.created_at, meta.updated_at],
        ),
      );
      const created = await this.organizations.findById(meta.id);
      if (!created) throw new Error('organizations.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM organizations WHERE id = ?', [id]);
      return row ? mapOrganization(row) : null;
    },

    findByName: async (name) => {
      const row = queryOne(this.db, 'SELECT * FROM organizations WHERE lower(name) = ?', [
        name.trim().toLowerCase(),
      ]);
      return row ? mapOrganization(row) : null;
    },

    update: async (id, patch) => {
      const set = setParts({ name: patch.name, description: patch.description });
      if (set) {
        mapConflict('An organization with that name already exists', () =>
          execute(this.db, `UPDATE organizations SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return this.organizations.findById(id);
    },

    list: async (options) => {
      const { limit, offset } = page(options);
      const total = queryCount(this.db, 'SELECT COUNT(*) AS count FROM organizations');
      const rows = queryAll(
        this.db,
        'SELECT * FROM organizations ORDER BY lower(name) ASC LIMIT ? OFFSET ?',
        [limit, offset],
      );
      return { items: rows.map(mapOrganization), total };
    },

    delete: async (id) => execute(this.db, 'DELETE FROM organizations WHERE id = ?', [id]) > 0,
  };

  /* ── sessions ─────────────────────────────────────────────────────────── */

  readonly sessions: SessionRepo = {
    create: async (input) => {
      const meta = stamps(input);
      mapConflict('Session token collision', () =>
        execute(
          this.db,
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
      const created = await this.sessions.findById(meta.id);
      if (!created) throw new Error('sessions.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM sessions WHERE id = ?', [id]);
      return row ? mapSession(row) : null;
    },

    findByTokenHash: async (tokenHash) => {
      const row = queryOne(this.db, 'SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
      return row ? mapSession(row) : null;
    },

    touch: async (id, expiresAt) => {
      execute(this.db, 'UPDATE sessions SET expires_at = ?, updated_at = ? WHERE id = ?', [
        expiresAt,
        nowIso(),
        id,
      ]);
    },

    delete: async (id) => execute(this.db, 'DELETE FROM sessions WHERE id = ?', [id]) > 0,

    deleteByTokenHash: async (tokenHash) =>
      execute(this.db, 'DELETE FROM sessions WHERE token_hash = ?', [tokenHash]) > 0,

    deleteForUser: async (userId) =>
      execute(this.db, 'DELETE FROM sessions WHERE user_id = ?', [userId]),

    deleteExpired: async (now) =>
      execute(this.db, 'DELETE FROM sessions WHERE expires_at <= ?', [now]),
  };

  /* ── apis ─────────────────────────────────────────────────────────────── */

  readonly apis: ApiRepo = {
    create: async (input) => {
      const meta = stamps(input);
      mapConflict('An API with that slug already exists', () =>
        execute(
          this.db,
          `INSERT INTO apis
             (id, name, slug, description, owner_user_id, ferrum_proxy_id, upstream_url,
              namespace, version, spec_format, requestable, auth_plugin, rate_limit_json,
              cors_json, allowed_methods_json, timeouts_json, circuit_breaker,
              spec_enforcement, status, visibility, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            encodeJson(input.allowed_methods ?? null),
            encodeJson(input.timeouts ?? null),
            encodeBool(input.circuit_breaker ?? false),
            input.spec_enforcement ?? DEFAULT_SPEC_ENFORCEMENT,
            input.status,
            input.visibility,
            meta.created_at,
            meta.updated_at,
          ],
        ),
      );
      const created = await this.apis.findById(meta.id);
      if (!created) throw new Error('apis.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM apis WHERE id = ?', [id]);
      return row ? mapApi(row) : null;
    },

    findBySlug: async (slug) => {
      const row = queryOne(this.db, 'SELECT * FROM apis WHERE lower(slug) = ?', [
        slug.trim().toLowerCase(),
      ]);
      return row ? mapApi(row) : null;
    },

    findByProxyId: async (ferrumProxyId) => {
      const row = queryOne(this.db, 'SELECT * FROM apis WHERE ferrum_proxy_id = ?', [
        ferrumProxyId,
      ]);
      return row ? mapApi(row) : null;
    },

    findManyByIds: async (ids) => {
      if (ids.length === 0) return [];
      const rows = queryAll(
        this.db,
        `SELECT * FROM apis WHERE id IN (${ids.map(() => '?').join(', ')})`,
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
        allowed_methods_json:
          patch.allowed_methods === undefined ? undefined : encodeJson(patch.allowed_methods),
        timeouts_json: patch.timeouts === undefined ? undefined : encodeJson(patch.timeouts),
        circuit_breaker:
          patch.circuit_breaker === undefined ? undefined : encodeBool(patch.circuit_breaker),
        spec_enforcement: patch.spec_enforcement,
        status: patch.status,
        visibility: patch.visibility,
      });
      if (set) {
        mapConflict('An API with that slug already exists', () =>
          execute(this.db, `UPDATE apis SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return this.apis.findById(id);
    },

    list: async (filter, options) => {
      const where = apiWhere(filter).build();
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM apis${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM apis${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapApi), total };
    },

    count: async (filter = {}) => {
      const where = apiWhere(filter).build();
      return queryCount(this.db, `SELECT COUNT(*) AS count FROM apis${where.sql}`, where.params);
    },

    listIdsByOwner: async (ownerUserId) =>
      queryAll(this.db, 'SELECT id FROM apis WHERE owner_user_id = ?', [ownerUserId]).map((row) =>
        text(row.id),
      ),

    delete: async (id) => execute(this.db, 'DELETE FROM apis WHERE id = ?', [id]) > 0,
  };

  /* ── apiSpecs ─────────────────────────────────────────────────────────── */

  readonly apiSpecs: ApiSpecRepo = {
    create: async (input) => {
      const meta = stamps(input);
      const insert = this.db.transaction(() => {
        if (input.is_current) {
          execute(
            this.db,
            'UPDATE api_specs SET is_current = 0, updated_at = ? WHERE api_id = ? AND is_current = 1',
            [meta.updated_at, input.api_id],
          );
        }
        execute(
          this.db,
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
      });
      mapConflict('That spec revision already exists', () => insert());
      const created = await this.apiSpecs.findById(meta.id);
      if (!created) throw new Error('apiSpecs.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM api_specs WHERE id = ?', [id]);
      return row ? mapApiSpec(row) : null;
    },

    findCurrentByApi: async (apiId) => {
      const row = queryOne(this.db, 'SELECT * FROM api_specs WHERE api_id = ? AND is_current = 1', [
        apiId,
      ]);
      return row ? mapApiSpec(row) : null;
    },

    setCurrent: async (apiId, specId) => {
      const swap = this.db.transaction(() => {
        const at = nowIso();
        execute(
          this.db,
          'UPDATE api_specs SET is_current = 0, updated_at = ? WHERE api_id = ? AND id <> ?',
          [at, apiId, specId],
        );
        execute(
          this.db,
          'UPDATE api_specs SET is_current = 1, updated_at = ? WHERE api_id = ? AND id = ?',
          [at, apiId, specId],
        );
      });
      swap();
    },

    list: async (filter, options) => {
      const where = new WhereBuilder()
        .add(filter.api_id, 'api_id = ?', filter.api_id ?? null)
        .add(
          filter.is_current,
          'is_current = ?',
          filter.is_current === undefined ? null : encodeBool(filter.is_current),
        )
        .build();
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM api_specs${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM api_specs${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapApiSpec), total };
    },

    delete: async (id) => execute(this.db, 'DELETE FROM api_specs WHERE id = ?', [id]) > 0,

    deleteByApi: async (apiId) =>
      execute(this.db, 'DELETE FROM api_specs WHERE api_id = ?', [apiId]),
  };

  /* ── apiPlugins ───────────────────────────────────────────────────────── */

  readonly apiPlugins: ApiPluginRepo = {
    listByApi: async (apiId) =>
      queryAll(
        this.db,
        'SELECT * FROM api_plugins WHERE api_id = ? ORDER BY created_at ASC, plugin_name ASC',
        [apiId],
      ).map(mapApiPlugin),

    find: async (apiId, pluginName) => {
      const row = queryOne(
        this.db,
        'SELECT * FROM api_plugins WHERE api_id = ? AND plugin_name = ?',
        [apiId, pluginName],
      );
      return row ? mapApiPlugin(row) : null;
    },

    upsert: async (input) => {
      const meta = stamps({});
      // `ON CONFLICT … DO UPDATE` keeps the original `created_at` — the row is
      // the plugin's history on this API, not this particular save's.
      mapConflict('That plugin is already configured for this API', () =>
        execute(
          this.db,
          `INSERT INTO api_plugins
             (id, api_id, plugin_name, enabled, config_json, trigger_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (api_id, plugin_name) DO UPDATE SET
             enabled = excluded.enabled,
             config_json = excluded.config_json,
             trigger_json = excluded.trigger_json,
             updated_at = excluded.updated_at`,
          [
            meta.id,
            input.api_id,
            input.plugin_name,
            encodeBool(input.enabled),
            encodeJson(input.config) ?? '{}',
            encodeJson(input.trigger),
            meta.created_at,
            meta.updated_at,
          ],
        ),
      );
      const saved = await this.apiPlugins.find(input.api_id, input.plugin_name);
      if (!saved) throw new Error('apiPlugins.upsert: row vanished immediately after write');
      return saved;
    },

    delete: async (apiId, pluginName) =>
      execute(this.db, 'DELETE FROM api_plugins WHERE api_id = ? AND plugin_name = ?', [
        apiId,
        pluginName,
      ]) > 0,

    deleteByApi: async (apiId) =>
      execute(this.db, 'DELETE FROM api_plugins WHERE api_id = ?', [apiId]),
  };

  /* ── accessRequests ───────────────────────────────────────────────────── */

  readonly accessRequests: AccessRequestRepo = {
    create: async (input) => {
      const meta = stamps(input);
      mapConflict('You already have a pending request for this API', () =>
        execute(
          this.db,
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
      const created = await this.accessRequests.findById(meta.id);
      if (!created) throw new Error('accessRequests.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM access_requests WHERE id = ?', [id]);
      return row ? mapAccessRequest(row) : null;
    },

    update: async (id, patch) => {
      const set = setParts(accessRequestUpdateColumns(patch));
      if (set) {
        mapConflict('You already have a pending request for this API', () =>
          execute(this.db, `UPDATE access_requests SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return this.accessRequests.findById(id);
    },

    updateIfStatus: async (id, expected, patch) => {
      const set = setParts(accessRequestUpdateColumns(patch));
      if (!set) {
        return queryOne(this.db, 'SELECT * FROM access_requests WHERE id = ? AND status = ?', [
          id,
          expected,
        ])
          ? this.accessRequests.findById(id)
          : null;
      }
      const changed = mapConflict('You already have a pending request for this API', () =>
        execute(
          this.db,
          `UPDATE access_requests SET ${set.sql}, updated_at = ? WHERE id = ? AND status = ?`,
          [...set.params, nowIso(), id, expected],
        ),
      );
      return changed > 0 ? this.accessRequests.findById(id) : null;
    },

    list: async (filter, options) => {
      const where = accessRequestWhere(filter).build();
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM access_requests${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM access_requests${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapAccessRequest), total };
    },

    findPendingByApiAndUser: async (apiId, userId) => {
      const row = queryOne(
        this.db,
        "SELECT * FROM access_requests WHERE api_id = ? AND user_id = ? AND status = 'pending'",
        [apiId, userId],
      );
      return row ? mapAccessRequest(row) : null;
    },

    findLatestByApiAndUser: async (apiId, userId) => {
      const row = queryOne(
        this.db,
        `SELECT * FROM access_requests WHERE api_id = ? AND user_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [apiId, userId],
      );
      return row ? mapAccessRequest(row) : null;
    },

    listLatestForUser: async (userId, apiIds) => {
      if (apiIds.length === 0) return [];
      const rows = queryAll(
        this.db,
        `SELECT r.* FROM access_requests r
         WHERE r.user_id = ?
           AND r.api_id IN (${apiIds.map(() => '?').join(', ')})
           AND r.created_at = (
             SELECT MAX(r2.created_at) FROM access_requests r2
             WHERE r2.api_id = r.api_id AND r2.user_id = r.user_id
           )
         GROUP BY r.api_id`,
        [userId, ...apiIds],
      );
      return rows.map(mapAccessRequest);
    },

    count: async (filter) => {
      const where = accessRequestWhere(filter).build();
      return queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM access_requests${where.sql}`,
        where.params,
      );
    },

    deleteByApi: async (apiId) =>
      execute(this.db, 'DELETE FROM access_requests WHERE api_id = ?', [apiId]),
  };

  /* ── grants ───────────────────────────────────────────────────────────── */

  readonly grants: GrantRepo = {
    create: async (input) => {
      const meta = stamps(input);
      mapConflict('An active grant already exists for this API and user', () =>
        execute(
          this.db,
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
      const created = await this.grants.findById(meta.id);
      if (!created) throw new Error('grants.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM grants WHERE id = ?', [id]);
      return row ? mapGrant(row) : null;
    },

    update: async (id, patch) => {
      const set = setParts(grantUpdateColumns(patch));
      if (set) {
        mapConflict('An active grant already exists for this API and user', () =>
          execute(this.db, `UPDATE grants SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return this.grants.findById(id);
    },

    updateIfStatus: async (id, expected, patch) => {
      const set = setParts(grantUpdateColumns(patch));
      if (!set) {
        return queryOne(this.db, 'SELECT * FROM grants WHERE id = ? AND status = ?', [id, expected])
          ? this.grants.findById(id)
          : null;
      }
      const changed = mapConflict('An active grant already exists for this API and user', () =>
        execute(
          this.db,
          `UPDATE grants SET ${set.sql}, updated_at = ? WHERE id = ? AND status = ?`,
          [...set.params, nowIso(), id, expected],
        ),
      );
      return changed > 0 ? this.grants.findById(id) : null;
    },

    list: async (filter, options) => {
      const where = grantWhere(filter).build();
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM grants${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM grants${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapGrant), total };
    },

    findActiveByApiAndUser: async (apiId, userId) => {
      const row = queryOne(
        this.db,
        "SELECT * FROM grants WHERE api_id = ? AND user_id = ? AND status = 'active'",
        [apiId, userId],
      );
      return row ? mapGrant(row) : null;
    },

    listActiveByUser: async (userId) =>
      queryAll(this.db, "SELECT * FROM grants WHERE user_id = ? AND status = 'active'", [
        userId,
      ]).map(mapGrant),

    listActiveByApi: async (apiId) =>
      queryAll(this.db, "SELECT * FROM grants WHERE api_id = ? AND status = 'active'", [apiId]).map(
        mapGrant,
      ),

    count: async (filter) => {
      const where = grantWhere(filter).build();
      return queryCount(this.db, `SELECT COUNT(*) AS count FROM grants${where.sql}`, where.params);
    },

    deleteByApi: async (apiId) => execute(this.db, 'DELETE FROM grants WHERE api_id = ?', [apiId]),
  };

  /* ── credentials ──────────────────────────────────────────────────────── */

  readonly credentials: CredentialRepo = {
    create: async (input) => {
      const meta = stamps(input);
      mapConflict('That credential is already registered', () =>
        execute(
          this.db,
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
      const created = await this.credentials.findById(meta.id);
      if (!created) throw new Error('credentials.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM credential_metadata WHERE id = ?', [id]);
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
        execute(this.db, `UPDATE credential_metadata SET ${set.sql}, updated_at = ? WHERE id = ?`, [
          ...set.params,
          nowIso(),
          id,
        ]);
      }
      return this.credentials.findById(id);
    },

    list: async (filter, options) => {
      const where = credentialWhere(filter).build();
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM credential_metadata${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM credential_metadata${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapCredential), total };
    },

    listByConsumer: async (ferrumConsumerId, type) => {
      const where = new WhereBuilder()
        .always('ferrum_consumer_id = ?', ferrumConsumerId)
        .add(type, 'credential_type = ?', type ?? null)
        .build();
      return queryAll(
        this.db,
        `SELECT * FROM credential_metadata${where.sql} ORDER BY created_at ASC, id ASC`,
        where.params,
      ).map(mapCredential);
    },

    findByFingerprint: async (fingerprint) => {
      const row = queryOne(this.db, 'SELECT * FROM credential_metadata WHERE fingerprint = ?', [
        fingerprint,
      ]);
      return row ? mapCredential(row) : null;
    },

    count: async (filter) => {
      const where = credentialWhere(filter).build();
      return queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM credential_metadata${where.sql}`,
        where.params,
      );
    },

    delete: async (id) =>
      execute(this.db, 'DELETE FROM credential_metadata WHERE id = ?', [id]) > 0,
  };

  /* ── consumers ────────────────────────────────────────────────────────── */

  readonly consumers: ConsumerRepo = {
    create: async (input) => {
      const meta = stamps(input);
      mapConflict('A gateway consumer already exists for this user', () =>
        execute(
          this.db,
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
      const created = await this.consumers.findById(meta.id);
      if (!created) throw new Error('consumers.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM consumers WHERE id = ?', [id]);
      return row ? mapConsumer(row) : null;
    },

    findByUserAndNamespace: async (userId, namespace) => {
      const row = queryOne(this.db, 'SELECT * FROM consumers WHERE user_id = ? AND namespace = ?', [
        userId,
        namespace,
      ]);
      return row ? mapConsumer(row) : null;
    },

    findByFerrumId: async (ferrumConsumerId) => {
      const row = queryOne(this.db, 'SELECT * FROM consumers WHERE ferrum_consumer_id = ?', [
        ferrumConsumerId,
      ]);
      return row ? mapConsumer(row) : null;
    },

    findByUsername: async (namespace, ferrumUsername) => {
      const row = queryOne(
        this.db,
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
        mapConflict('A gateway consumer already exists for this user', () =>
          execute(this.db, `UPDATE consumers SET ${set.sql}, updated_at = ? WHERE id = ?`, [
            ...set.params,
            nowIso(),
            id,
          ]),
        );
      }
      return this.consumers.findById(id);
    },

    list: async (filter, options) => {
      const where = new WhereBuilder()
        .add(filter.user_id, 'user_id = ?', filter.user_id ?? null)
        .add(filter.namespace, 'namespace = ?', filter.namespace ?? null)
        .build();
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM consumers${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM consumers${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapConsumer), total };
    },

    delete: async (id) => execute(this.db, 'DELETE FROM consumers WHERE id = ?', [id]) > 0,
  };

  /* ── threads ──────────────────────────────────────────────────────────── */

  readonly threads: ThreadRepo = {
    create: async (input) => {
      const meta = stamps(input);
      execute(
        this.db,
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
      const created = await this.threads.findById(meta.id);
      if (!created) throw new Error('threads.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM message_threads WHERE id = ?', [id]);
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
        execute(this.db, `UPDATE message_threads SET ${set.sql}, updated_at = ? WHERE id = ?`, [
          ...set.params,
          nowIso(),
          id,
        ]);
      }
      return this.threads.findById(id);
    },

    list: async (filter, options) => {
      const builder = new WhereBuilder();
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
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM message_threads${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM message_threads${where.sql}
         ORDER BY coalesce(last_message_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapThread), total };
    },

    findExisting: async (participantA, participantB, apiId) => {
      const row = queryOne(
        this.db,
        `SELECT * FROM message_threads
         WHERE api_id IS ?
           AND ((participant_a = ? AND participant_b IS ?) OR (participant_a IS ? AND participant_b = ?))
         ORDER BY created_at DESC LIMIT 1`,
        [apiId, participantA, participantB, participantB, participantA],
      );
      return row ? mapThread(row) : null;
    },

    touchLastMessage: async (threadId, at) => {
      execute(
        this.db,
        'UPDATE message_threads SET last_message_at = ?, updated_at = ? WHERE id = ?',
        [at, nowIso(), threadId],
      );
    },

    delete: async (id) => execute(this.db, 'DELETE FROM message_threads WHERE id = ?', [id]) > 0,
  };

  /* ── messages ─────────────────────────────────────────────────────────── */

  readonly messages: MessageRepo = {
    create: async (input) => {
      const meta = stamps(input);
      execute(
        this.db,
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
      const created = await this.messages.findById(meta.id);
      if (!created) throw new Error('messages.create: row vanished immediately after insert');
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM messages WHERE id = ?', [id]);
      return row ? mapMessage(row) : null;
    },

    listByThread: async (threadId, options) => {
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        'SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?',
        [threadId],
      );
      const rows = queryAll(
        this.db,
        'SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?',
        [threadId, limit, offset],
      );
      return { items: rows.map(mapMessage), total };
    },

    findLatestByThread: async (threadId) => {
      const row = queryOne(
        this.db,
        'SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        [threadId],
      );
      return row ? mapMessage(row) : null;
    },

    countByThread: async (threadId) =>
      queryCount(this.db, 'SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?', [threadId]),

    countBySenderSince: async (senderUserId, sinceIso) =>
      queryCount(
        this.db,
        'SELECT COUNT(*) AS count FROM messages WHERE sender_user_id = ? AND created_at >= ?',
        [senderUserId, sinceIso],
      ),

    deleteByThread: async (threadId) =>
      execute(this.db, 'DELETE FROM messages WHERE thread_id = ?', [threadId]),
  };

  /* ── notifications ────────────────────────────────────────────────────── */

  readonly notifications: NotificationRepo = {
    create: async (input) => {
      const meta = stamps(input);
      execute(
        this.db,
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
      const created = await this.notifications.findById(meta.id);
      if (!created) throw new Error('notifications.create: row vanished immediately after insert');
      return created;
    },

    createMany: async (inputs) => {
      if (inputs.length === 0) return [];
      const created: NotificationRecord[] = [];
      const insertAll = this.db.transaction(() => {
        for (const input of inputs) {
          const meta = stamps(input);
          execute(
            this.db,
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
          const row = queryOne(this.db, 'SELECT * FROM notifications WHERE id = ?', [meta.id]);
          if (row) created.push(mapNotification(row));
        }
      });
      insertAll();
      return created;
    },

    findById: async (id) => {
      const row = queryOne(this.db, 'SELECT * FROM notifications WHERE id = ?', [id]);
      return row ? mapNotification(row) : null;
    },

    list: async (filter, options) => {
      const builder = new WhereBuilder().always('user_id = ?', filter.user_id);
      if (filter.unread === true) builder.always('read_at IS NULL');
      if (filter.unread === false) builder.always('read_at IS NOT NULL');
      builder.add(filter.type, 'type = ?', filter.type ?? null);
      const where = builder.build();
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM notifications${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM notifications${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapNotification), total };
    },

    countUnread: async (userId) =>
      queryCount(
        this.db,
        'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL',
        [userId],
      ),

    markRead: async (userId, ids, at) => {
      if (ids.length === 0) return 0;
      return execute(
        this.db,
        `UPDATE notifications SET read_at = ?, updated_at = ?
         WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`,
        [at, nowIso(), userId, ...ids],
      );
    },

    markAllRead: async (userId, at) =>
      execute(
        this.db,
        'UPDATE notifications SET read_at = ?, updated_at = ? WHERE user_id = ? AND read_at IS NULL',
        [at, nowIso(), userId],
      ),
  };

  /* ── emailOutbox ──────────────────────────────────────────────────────── */

  readonly emailOutbox: EmailOutboxRepo = {
    enqueue: async (input: EnqueueEmailInput) => {
      const key = input.idempotency_key ?? null;
      if (key !== null) {
        const existing = await this.emailOutbox.findByIdempotencyKey(key);
        if (existing) return { entry: existing, created: false };
      }
      const meta = stamps({ id: input.id });
      try {
        execute(
          this.db,
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
      const row = queryOne(this.db, 'SELECT * FROM email_outbox WHERE id = ?', [id]);
      return row ? mapOutbox(row) : null;
    },

    findByIdempotencyKey: async (key) => {
      const row = queryOne(this.db, 'SELECT * FROM email_outbox WHERE idempotency_key = ?', [key]);
      return row ? mapOutbox(row) : null;
    },

    claimDue: async (now, limit) => {
      const claim = this.db.transaction((): EmailOutboxRecord[] => {
        const ids = queryAll(
          this.db,
          `SELECT id FROM email_outbox
           WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY next_attempt_at ASC, created_at ASC LIMIT ?`,
          [now, Math.max(1, Math.floor(limit))],
        ).map((row) => text(row.id));
        if (ids.length === 0) return [];
        execute(
          this.db,
          `UPDATE email_outbox
           SET status = 'sending', attempts = attempts + 1, updated_at = ?
           WHERE id IN (${ids.map(() => '?').join(', ')}) AND status = 'pending'`,
          [nowIso(), ...ids],
        );
        return queryAll(
          this.db,
          `SELECT * FROM email_outbox WHERE id IN (${ids.map(() => '?').join(', ')})`,
          ids,
        ).map(mapOutbox);
      });
      return claim();
    },

    markSent: async (id, at) => {
      execute(
        this.db,
        `UPDATE email_outbox SET status = 'sent', next_attempt_at = NULL, last_error = NULL,
           updated_at = ? WHERE id = ?`,
        [at, id],
      );
    },

    reschedule: async (id, nextAttemptAt, lastError) => {
      execute(
        this.db,
        `UPDATE email_outbox SET status = 'pending', next_attempt_at = ?, last_error = ?,
           updated_at = ? WHERE id = ?`,
        [nextAttemptAt, lastError, nowIso(), id],
      );
    },

    markFailed: async (id, lastError) => {
      execute(
        this.db,
        `UPDATE email_outbox SET status = 'failed', next_attempt_at = NULL, last_error = ?,
           updated_at = ? WHERE id = ?`,
        [lastError, nowIso(), id],
      );
    },

    releaseStale: async (olderThan) =>
      execute(
        this.db,
        `UPDATE email_outbox SET status = 'pending', next_attempt_at = ?, updated_at = ?
         WHERE status = 'sending' AND updated_at <= ?`,
        [nowIso(), nowIso(), olderThan],
      ),

    list: async (filter, options) => {
      const where = new WhereBuilder()
        .add(filter.status, 'status = ?', filter.status ?? null)
        .add(filter.to_email, 'lower(to_email) = ?', (filter.to_email ?? '').toLowerCase())
        .build();
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM email_outbox${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM email_outbox${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapOutbox), total };
    },
  };

  /* ── gatewayTeardownJobs ──────────────────────────────────────────────── */

  readonly gatewayTeardownJobs: GatewayTeardownJobRepo = {
    upsertPending: async (userId, requestedBy, now) => {
      // `user_id` is unique, so the conflict target is the account rather than
      // the row id: a second disable resets the outstanding job instead of
      // queueing a duplicate revocation.
      execute(
        this.db,
        `INSERT INTO gateway_teardown_jobs
           (id, user_id, status, attempts, next_attempt_at, last_error, requested_by,
            created_at, updated_at, completed_at)
         VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?, ?, NULL)
         ON CONFLICT (user_id) DO UPDATE SET
           status = 'pending',
           attempts = 0,
           next_attempt_at = excluded.next_attempt_at,
           last_error = NULL,
           requested_by = excluded.requested_by,
           updated_at = excluded.updated_at,
           completed_at = NULL`,
        [newId(), userId, now, requestedBy, now, now],
      );
      const job = await this.gatewayTeardownJobs.findByUser(userId);
      if (!job) {
        throw new Error('gatewayTeardownJobs.upsertPending: row vanished immediately after upsert');
      }
      return job;
    },

    findByUser: async (userId) => {
      const row = queryOne(this.db, 'SELECT * FROM gateway_teardown_jobs WHERE user_id = ?', [
        userId,
      ]);
      return row ? mapTeardownJob(row) : null;
    },

    list: async (filter, options) => {
      const where = new WhereBuilder()
        .add(filter.status, 'status = ?', filter.status ?? null)
        .build();
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM gateway_teardown_jobs${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM gateway_teardown_jobs${where.sql}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapTeardownJob), total };
    },

    claimDue: async (now, limit) => {
      const claim = this.db.transaction((): GatewayTeardownJobRecord[] => {
        const ids = queryAll(
          this.db,
          `SELECT id FROM gateway_teardown_jobs
           WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY next_attempt_at ASC, created_at ASC LIMIT ?`,
          [now, Math.max(1, Math.floor(limit))],
        ).map((row) => text(row.id));
        if (ids.length === 0) return [];
        execute(
          this.db,
          `UPDATE gateway_teardown_jobs
           SET status = 'sending', attempts = attempts + 1, updated_at = ?
           WHERE id IN (${ids.map(() => '?').join(', ')}) AND status = 'pending'`,
          [nowIso(), ...ids],
        );
        return queryAll(
          this.db,
          `SELECT * FROM gateway_teardown_jobs WHERE id IN (${ids.map(() => '?').join(', ')})`,
          ids,
        ).map(mapTeardownJob);
      });
      return claim();
    },

    markDone: async (id, at) => {
      execute(
        this.db,
        `UPDATE gateway_teardown_jobs
         SET status = 'done', next_attempt_at = NULL, last_error = NULL, completed_at = ?,
             updated_at = ? WHERE id = ?`,
        [at, at, id],
      );
    },

    reschedule: async (id, nextAttemptAt, lastError) => {
      execute(
        this.db,
        `UPDATE gateway_teardown_jobs
         SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        [nextAttemptAt, lastError, nowIso(), id],
      );
    },

    releaseStale: async (olderThan) =>
      execute(
        this.db,
        `UPDATE gateway_teardown_jobs SET status = 'pending', next_attempt_at = ?, updated_at = ?
         WHERE status = 'sending' AND updated_at <= ?`,
        [nowIso(), nowIso(), olderThan],
      ),

    deleteByUser: async (userId) =>
      execute(this.db, 'DELETE FROM gateway_teardown_jobs WHERE user_id = ?', [userId]) > 0,
  };

  /* ── auditLogs ────────────────────────────────────────────────────────── */

  readonly auditLogs: AuditLogRepo = {
    create: async (input: CreateInput<AuditLogRecord>) => {
      const meta = stamps(input);
      execute(
        this.db,
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
      const row = queryOne(this.db, 'SELECT * FROM audit_logs WHERE id = ?', [meta.id]);
      if (!row) throw new Error('auditLogs.create: row vanished immediately after insert');
      return mapAuditLog(row);
    },

    list: async (filter, options) => {
      const where = auditWhere(filter).build();
      const { limit, offset } = page(options);
      const total = queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM audit_logs${where.sql}`,
        where.params,
      );
      const rows = queryAll(
        this.db,
        `SELECT * FROM audit_logs${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return { items: rows.map(mapAuditLog), total };
    },

    count: async (filter) => {
      const where = auditWhere(filter).build();
      return queryCount(
        this.db,
        `SELECT COUNT(*) AS count FROM audit_logs${where.sql}`,
        where.params,
      );
    },
  };

  /* ── settings ─────────────────────────────────────────────────────────── */

  readonly settings: SettingRepo = {
    get: async (key) => {
      const row = queryOne(this.db, 'SELECT * FROM app_settings WHERE key = ?', [key]);
      return row ? mapSetting(row) : null;
    },

    getMany: async (keys) => {
      if (keys.length === 0) return [];
      return queryAll(
        this.db,
        `SELECT * FROM app_settings WHERE key IN (${keys.map(() => '?').join(', ')})`,
        keys,
      ).map(mapSetting);
    },

    set: async (key, value, encrypted = false) => {
      const at = nowIso();
      execute(
        this.db,
        `INSERT INTO app_settings (key, value_json, encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
           encrypted = excluded.encrypted, updated_at = excluded.updated_at`,
        [key, JSON.stringify(value ?? null), encodeBool(encrypted), at, at],
      );
      const created = await this.settings.get(key);
      if (!created) throw new Error('settings.set: row vanished immediately after upsert');
      return created;
    },

    insertIfAbsent: async (key, value, encrypted = false) => {
      const at = nowIso();
      // `ON CONFLICT DO NOTHING` reports 0 changed rows when the key is taken,
      // which is the whole answer — no read, no transaction.
      return (
        execute(
          this.db,
          `INSERT INTO app_settings (key, value_json, encrypted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (key) DO NOTHING`,
          [key, JSON.stringify(value ?? null), encodeBool(encrypted), at, at],
        ) > 0
      );
    },

    setMany: async (entries) => {
      if (entries.length === 0) return;
      const apply = this.db.transaction(() => {
        const at = nowIso();
        for (const entry of entries) {
          execute(
            this.db,
            `INSERT INTO app_settings (key, value_json, encrypted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
               encrypted = excluded.encrypted, updated_at = excluded.updated_at`,
            [entry.key, JSON.stringify(entry.value ?? null), encodeBool(entry.encrypted), at, at],
          );
        }
      });
      apply();
    },

    delete: async (key) => execute(this.db, 'DELETE FROM app_settings WHERE key = ?', [key]) > 0,

    all: async () =>
      queryAll(this.db, 'SELECT * FROM app_settings ORDER BY key ASC').map(mapSetting),
  };

  /* ── emailTemplates ───────────────────────────────────────────────────── */

  readonly emailTemplates: EmailTemplateRepo = {
    get: async (key) => {
      const row = queryOne(this.db, 'SELECT * FROM email_templates WHERE key = ?', [key]);
      return row ? mapEmailTemplate(row) : null;
    },

    upsert: async (key, value) => {
      const at = nowIso();
      execute(
        this.db,
        `INSERT INTO email_templates (id, key, subject, body_html, body_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET subject = excluded.subject,
           body_html = excluded.body_html, body_text = excluded.body_text,
           updated_at = excluded.updated_at`,
        [newId(), key, value.subject, value.body_html, value.body_text, at, at],
      );
      const stored = await this.emailTemplates.get(key);
      if (!stored) throw new Error('emailTemplates.upsert: row vanished immediately after upsert');
      return stored;
    },

    list: async () =>
      queryAll(this.db, 'SELECT * FROM email_templates ORDER BY key ASC').map(mapEmailTemplate),

    delete: async (key) => execute(this.db, 'DELETE FROM email_templates WHERE key = ?', [key]) > 0,
  };

  /* ── verificationTokens ───────────────────────────────────────────────── */

  readonly verificationTokens: VerificationTokenRepo = {
    claimIssue: async (userId, purpose, issuedAt, notBefore) => {
      const inserted = execute(
        this.db,
        `INSERT OR IGNORE INTO email_token_issue_claims (user_id, purpose, issued_at)
         VALUES (?, ?, ?)`,
        [userId, purpose, issuedAt],
      );
      if (inserted > 0) return true;
      return (
        execute(
          this.db,
          `UPDATE email_token_issue_claims SET issued_at = ?
           WHERE user_id = ? AND purpose = ? AND issued_at <= ?`,
          [issuedAt, userId, purpose, notBefore],
        ) > 0
      );
    },

    create: async (input) => {
      const meta = stamps(input);
      mapConflict('Verification token collision', () =>
        execute(
          this.db,
          `INSERT INTO email_verification_tokens
             (id, user_id, token_hash, purpose, expires_at, used_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            meta.id,
            input.user_id,
            input.token_hash,
            input.purpose,
            input.expires_at,
            input.used_at ?? null,
            meta.created_at,
            meta.updated_at,
          ],
        ),
      );
      const row = queryOne(this.db, 'SELECT * FROM email_verification_tokens WHERE id = ?', [
        meta.id,
      ]);
      if (!row) throw new Error('verificationTokens.create: row vanished immediately after insert');
      return mapVerificationToken(row);
    },

    findByTokenHash: async (tokenHash, purpose) => {
      const row = queryOne(
        this.db,
        'SELECT * FROM email_verification_tokens WHERE token_hash = ? AND purpose = ?',
        [tokenHash, purpose],
      );
      return row ? mapVerificationToken(row) : null;
    },

    findLatestLiveForUser: async (userId, purpose, now) => {
      const row = queryOne(
        this.db,
        `SELECT * FROM email_verification_tokens
          WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [userId, purpose, now],
      );
      return row ? mapVerificationToken(row) : null;
    },

    markUsed: async (id, at) =>
      execute(
        this.db,
        'UPDATE email_verification_tokens SET used_at = ?, updated_at = ? WHERE id = ? AND used_at IS NULL',
        [at, nowIso(), id],
      ) > 0,

    deleteForUser: async (userId, purpose) =>
      purpose === undefined
        ? execute(this.db, 'DELETE FROM email_verification_tokens WHERE user_id = ?', [userId])
        : execute(
            this.db,
            'DELETE FROM email_verification_tokens WHERE user_id = ? AND purpose = ?',
            [userId, purpose],
          ),

    deleteExpired: async (now) =>
      execute(this.db, 'DELETE FROM email_verification_tokens WHERE expires_at <= ?', [now]),
  };
}

/* ── Filter builders (shared by list/count) ─────────────────────────────── */

function userWhere(filter: UserFilter): WhereBuilder {
  const builder = new WhereBuilder()
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

function apiWhere(filter: ApiFilter): WhereBuilder {
  const builder = new WhereBuilder()
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

function accessRequestWhere(filter: AccessRequestFilter): WhereBuilder {
  const builder = new WhereBuilder()
    .add(filter.user_id, 'user_id = ?', filter.user_id ?? null)
    .add(filter.api_id, 'api_id = ?', filter.api_id ?? null)
    .add(filter.status, 'status = ?', filter.status ?? null);
  if (filter.api_ids !== undefined) builder.addIn('api_id', filter.api_ids);
  return builder;
}

function grantWhere(filter: GrantFilter): WhereBuilder {
  const builder = new WhereBuilder()
    .add(filter.user_id, 'user_id = ?', filter.user_id ?? null)
    .add(filter.api_id, 'api_id = ?', filter.api_id ?? null)
    .add(filter.status, 'status = ?', filter.status ?? null);
  if (filter.api_ids !== undefined) builder.addIn('api_id', filter.api_ids);
  return builder;
}

function credentialWhere(filter: CredentialFilter): WhereBuilder {
  return new WhereBuilder()
    .add(filter.user_id, 'user_id = ?', filter.user_id ?? null)
    .add(filter.status, 'status = ?', filter.status ?? null)
    .add(filter.credential_type, 'credential_type = ?', filter.credential_type ?? null)
    .add(filter.ferrum_consumer_id, 'ferrum_consumer_id = ?', filter.ferrum_consumer_id ?? null);
}

function auditWhere(filter: AuditLogFilter): WhereBuilder {
  const builder = new WhereBuilder()
    .add(filter.actor_user_id, 'actor_user_id = ?', filter.actor_user_id ?? null)
    .add(filter.action, 'action = ?', filter.action ?? null)
    .add(filter.target_type, 'target_type = ?', filter.target_type ?? null)
    .add(filter.target_id, 'target_id = ?', filter.target_id ?? null)
    .add(filter.from, 'created_at >= ?', filter.from ?? null)
    .add(filter.to, 'created_at < ?', filter.to ?? null);
  if (filter.actions !== undefined) builder.addIn('action', filter.actions);
  return builder;
}

/* ── Factory ────────────────────────────────────────────────────────────── */

/**
 * Build the SQLite store. Pass `':memory:'` (the default for
 * `NEXUS_ENV=test`) for an ephemeral database; file paths get their parent
 * directory created and WAL enabled.
 */
export function createSqliteStore(config: NexusConfig): NexusStore {
  return new SqliteStore(openSqliteDatabase(config.db.sqlitePath));
}
