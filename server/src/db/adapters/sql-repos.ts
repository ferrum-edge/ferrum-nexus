/**
 * Shared SQL repository implementation used by both the PostgreSQL and MySQL
 * adapters. Dialect-specific differences (placeholder syntax, JSON encoding,
 * boolean handling) are normalized by helpers in `./sql-common.ts`.
 *
 * For brevity this implementation reuses the same parameterized statements
 * across drivers and rewrites `$N` to `?` for MySQL via a small helper.
 */

import type {
  AccessGrantRow,
  AccessRequestRow,
  ApiAssetRow,
  ApiSpecVersionRow,
  AppSettingRow,
  AuditLogRow,
  ConversationRow,
  CredentialMetadataRow,
  EmailOutboxRow,
  EmailTemplateRow,
  EmailVerificationRow,
  FerrumConsumerRow,
  ListOptions,
  MassEmailCampaignRow,
  MessageRow,
  NexusStore,
  NotificationRow,
  OrganizationMemberRow,
  OrganizationRow,
  PasswordResetRow,
  PendingPublishRow,
  PolicyExceptionRequestRow,
  SessionRow,
  UserRow,
} from '../store.js';
import type {
  AccessRequestStatus,
  ApiVisibility,
  UserRole,
} from '@ferrum-nexus/shared';
import {
  asBool,
  asJson,
  buildInsertIgnore,
  buildUpsert,
  caseInsensitiveLike,
  ident,
  toIsoString,
  type SqlClient,
  type SqlDialect,
} from './sql-common.js';

/**
 * Minimal placeholder/identifier rewriter. We deliberately do NOT rewrite
 * dialect-specific operators (ILIKE, ON CONFLICT) any more — those are
 * generated per-dialect by helpers in `sql-common.ts`. The only thing we
 * still need is the $N → ? swap for MySQL and the COUNT(*)::text → COUNT(*)
 * cast strip.
 */
const renderSql = (dialect: SqlDialect, sql: string): string => {
  if (dialect === 'postgres') return sql;
  return sql.replace(/COUNT\(\*\)::text/g, 'COUNT(*)').replace(/\$(\d+)/g, '?');
};

/** Lower-case search parameter for use with `caseInsensitiveLike`. */
const lowerSearch = (dialect: SqlDialect, value: string | null): string | null => {
  if (value == null) return null;
  return dialect === 'postgres' ? value : value.toLowerCase();
};

const J = (value: unknown): string => JSON.stringify(value ?? null);

function hydrateUser(row: Record<string, unknown>): UserRow {
  return {
    id: row.id as string,
    email: row.email as string,
    email_normalized: row.email_normalized as string,
    name: (row.name as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    status: row.status as UserRow['status'],
    email_verified_at: toIsoString(row.email_verified_at),
    password_hash: row.password_hash as string,
    last_login_at: toIsoString(row.last_login_at),
    failed_login_count: Number(row.failed_login_count ?? 0),
    organization_id: (row.organization_id as string | null) ?? null,
    created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
    updated_at: toIsoString(row.updated_at) ?? new Date().toISOString(),
  };
}

function hydrateAsset(row: Record<string, unknown>): ApiAssetRow {
  return {
    id: row.id as string,
    api_spec_id: row.api_spec_id as string,
    proxy_id: row.proxy_id as string,
    namespace: row.namespace as string,
    provider_id: row.provider_id as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    slug: row.slug as string,
    version: row.version as string,
    visibility: row.visibility as ApiAssetRow['visibility'],
    requestable: asBool(row.requestable) ? 1 : 0,
    lifecycle: row.lifecycle as ApiAssetRow['lifecycle'],
    tags: asJson<string[]>(row.tags, []),
    contact_name: (row.contact_name as string | null) ?? null,
    contact_email: (row.contact_email as string | null) ?? null,
    contact_url: (row.contact_url as string | null) ?? null,
    support_notes: (row.support_notes as string | null) ?? null,
    operation_count: Number(row.operation_count ?? 0),
    content_hash: (row.content_hash as string | null) ?? null,
    proxy_hosts: asJson<string[]>(row.proxy_hosts, []),
    proxy_paths: asJson<string[]>(row.proxy_paths, []),
    proxy_upstream_url: (row.proxy_upstream_url as string | null) ?? null,
    timeout_connect_ms: nullableNumber(row.timeout_connect_ms),
    timeout_read_ms: nullableNumber(row.timeout_read_ms),
    timeout_write_ms: nullableNumber(row.timeout_write_ms),
    body_size_limit_bytes: nullableNumber(row.body_size_limit_bytes),
    rate_limit_per_minute: nullableNumber(row.rate_limit_per_minute),
    operation_paths: asJson<string[]>(row.operation_paths, []),
    operation_summaries: asJson<string[]>(row.operation_summaries, []),
    source_format:
      row.source_format === 'swagger2' || row.source_format === 'openapi3'
        ? row.source_format
        : 'openapi3',
    policy_exception_id: (row.policy_exception_id as string | null) ?? null,
    created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
    updated_at: toIsoString(row.updated_at) ?? new Date().toISOString(),
  };
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hydratePolicyException(row: Record<string, unknown>): PolicyExceptionRequestRow {
  return {
    id: row.id as string,
    api_asset_id: (row.api_asset_id as string | null) ?? null,
    provider_id: row.provider_id as string,
    pending_publish_id: (row.pending_publish_id as string | null) ?? null,
    violations: asJson<PolicyExceptionRequestRow['violations']>(row.violations, []),
    justification: row.justification as string,
    status: row.status as PolicyExceptionRequestRow['status'],
    reviewed_by: (row.reviewed_by as string | null) ?? null,
    reviewed_at: toIsoString(row.reviewed_at),
    reviewer_notes: (row.reviewer_notes as string | null) ?? null,
    expires_at: toIsoString(row.expires_at),
    created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
  };
}

function hydratePendingPublish(row: Record<string, unknown>): PendingPublishRow {
  return {
    id: row.id as string,
    provider_id: row.provider_id as string,
    raw_spec: row.raw_spec as string,
    publish_input: asJson<Record<string, unknown>>(row.publish_input, {}),
    exception_request_id: (row.exception_request_id as string | null) ?? null,
    created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
  };
}

function hydrateAccessRequest(row: Record<string, unknown>): AccessRequestRow {
  return {
    id: row.id as string,
    api_asset_id: row.api_asset_id as string,
    client_user_id: row.client_user_id as string,
    client_consumer_id: (row.client_consumer_id as string | null) ?? null,
    justification: row.justification as string,
    status: row.status as AccessRequestRow['status'],
    provider_reason: (row.provider_reason as string | null) ?? null,
    reviewed_by: (row.reviewed_by as string | null) ?? null,
    created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
    reviewed_at: toIsoString(row.reviewed_at),
  };
}

function hydrateAccessGrant(row: Record<string, unknown>): AccessGrantRow {
  return {
    id: row.id as string,
    api_asset_id: row.api_asset_id as string,
    client_user_id: row.client_user_id as string,
    client_consumer_id: row.client_consumer_id as string,
    acl_group: row.acl_group as string,
    status: row.status as AccessGrantRow['status'],
    approved_by: row.approved_by as string,
    approved_at: toIsoString(row.approved_at) ?? new Date().toISOString(),
    revoked_by: (row.revoked_by as string | null) ?? null,
    revoked_at: toIsoString(row.revoked_at),
    revoked_reason: (row.revoked_reason as string | null) ?? null,
  };
}

function hydrateConsumer(row: Record<string, unknown>): FerrumConsumerRow {
  return {
    id: row.id as string,
    user_id: (row.user_id as string | null) ?? null,
    organization_id: (row.organization_id as string | null) ?? null,
    namespace: row.namespace as string,
    ferrum_consumer_id: row.ferrum_consumer_id as string,
    username: row.username as string,
    status: row.status as FerrumConsumerRow['status'],
    acl_groups: asJson<string[]>(row.acl_groups, []),
    created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
  };
}

export function buildSqlRepos(
  client: SqlClient,
  dialect: SqlDialect,
): Omit<NexusStore, 'driver' | 'transaction' | 'migrate' | 'close'> {
  const sql = (q: string): string => renderSql(dialect, q);
  const boolValue = (v: boolean): boolean | number => (dialect === 'postgres' ? v : v ? 1 : 0);

  return {
    users: {
      async insert(row) {
        const now = new Date().toISOString();
        const full: UserRow = { ...row, created_at: now, updated_at: now };
        await client.exec(
          sql(`INSERT INTO users (id, email, email_normalized, name, phone, status,
                                  email_verified_at, password_hash, last_login_at,
                                  failed_login_count, organization_id, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`),
          [
            full.id,
            full.email,
            full.email_normalized,
            full.name,
            full.phone,
            full.status,
            full.email_verified_at,
            full.password_hash,
            full.last_login_at,
            full.failed_login_count,
            full.organization_id,
            full.created_at,
            full.updated_at,
          ],
        );
        return full;
      },
      async findById(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM users WHERE id = $1'),
          [id],
        );
        return row ? hydrateUser(row) : null;
      },
      async findByEmail(emailNormalized) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM users WHERE email_normalized = $1'),
          [emailNormalized],
        );
        return row ? hydrateUser(row) : null;
      },
      async updateContact(id, fields) {
        await client.exec(
          sql(`UPDATE users SET name = COALESCE($1, name), phone = COALESCE($2, phone),
               updated_at = $3 WHERE id = $4`),
          [fields.name ?? null, fields.phone ?? null, new Date().toISOString(), id],
        );
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM users WHERE id = $1'),
          [id],
        );
        return hydrateUser(row!);
      },
      async updatePassword(id, hash) {
        await client.exec(
          sql('UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3'),
          [hash, new Date().toISOString(), id],
        );
      },
      async updateStatus(id, status) {
        await client.exec(
          sql('UPDATE users SET status = $1, updated_at = $2 WHERE id = $3'),
          [status, new Date().toISOString(), id],
        );
      },
      async markEmailVerified(id, at) {
        await client.exec(
          sql(`UPDATE users SET email_verified_at = $1, status = 'active', updated_at = $2
               WHERE id = $3`),
          [at, new Date().toISOString(), id],
        );
      },
      async recordLogin(id, at) {
        await client.exec(
          sql(`UPDATE users SET last_login_at = $1, failed_login_count = 0,
               updated_at = $2 WHERE id = $3`),
          [at, new Date().toISOString(), id],
        );
      },
      async recordFailedLogin(id) {
        await client.exec(
          sql(`UPDATE users SET failed_login_count = failed_login_count + 1,
               updated_at = $1 WHERE id = $2`),
          [new Date().toISOString(), id],
        );
        const row = await client.one<{ failed_login_count: number }>(
          sql('SELECT failed_login_count FROM users WHERE id = $1'),
          [id],
        );
        return Number(row?.failed_login_count ?? 0);
      },
      async resetFailedLogins(id) {
        await client.exec(
          sql('UPDATE users SET failed_login_count = 0, updated_at = $1 WHERE id = $2'),
          [new Date().toISOString(), id],
        );
      },
      async list(opts: ListOptions) {
        const limit = opts.limit ?? 25;
        const offset = opts.offset ?? 0;
        const search = lowerSearch(dialect, opts.search ? `%${opts.search}%` : null);
        const emailMatch = caseInsensitiveLike(dialect, 'email_normalized', '$2');
        const nameMatch = caseInsensitiveLike(dialect, 'name', '$3');
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM users
               WHERE ($1::text IS NULL OR ${emailMatch} OR ${nameMatch})
               ORDER BY created_at DESC LIMIT $4 OFFSET $5`),
          [search, search, search, limit, offset],
        );
        const total = (
          await client.one<{ c: string }>(
            sql(`SELECT COUNT(*)::text as c FROM users
                 WHERE ($1::text IS NULL OR ${emailMatch} OR ${nameMatch})`),
            [search, search, search],
          )
        )?.c;
        return { rows: rows.map(hydrateUser), total: Number(total ?? 0) };
      },
      async listFiltered(opts) {
        const limit = opts.limit ?? 25;
        const offset = opts.offset ?? 0;
        const role = opts.role ?? null;
        const status = opts.status ?? null;
        // JOIN against user_roles inline; let the DB do filter + paginate.
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT u.* FROM users u
               WHERE ($1::text IS NULL OR u.status = $2)
                 AND ($3::text IS NULL OR EXISTS (
                   SELECT 1 FROM user_roles ur
                   WHERE ur.user_id = u.id AND ur.role = $4
                 ))
               ORDER BY u.created_at DESC LIMIT $5 OFFSET $6`),
          [status, status, role, role, limit, offset],
        );
        const totalRow = await client.one<{ c: string }>(
          sql(`SELECT COUNT(*)::text as c FROM users u
               WHERE ($1::text IS NULL OR u.status = $2)
                 AND ($3::text IS NULL OR EXISTS (
                   SELECT 1 FROM user_roles ur
                   WHERE ur.user_id = u.id AND ur.role = $4
                 ))`),
          [status, status, role, role],
        );
        return { rows: rows.map(hydrateUser), total: Number(totalRow?.c ?? 0) };
      },
      async count() {
        const row = await client.one<{ c: string }>(
          sql('SELECT COUNT(*) as c FROM users'),
          [],
        );
        return Number(row?.c ?? 0);
      },
    },
    userRoles: {
      async add(userId, role) {
        await client.exec(
          sql(buildInsertIgnore(dialect, 'user_roles', ['user_id', 'role', 'created_at'])),
          [userId, role, new Date().toISOString()],
        );
      },
      async remove(userId, role) {
        await client.exec(
          sql('DELETE FROM user_roles WHERE user_id = $1 AND role = $2'),
          [userId, role],
        );
      },
      async forUser(userId) {
        const rows = await client.query<{ role: UserRole }>(
          sql('SELECT role FROM user_roles WHERE user_id = $1'),
          [userId],
        );
        return rows.map((r) => r.role);
      },
      async setRoles(userId, roles) {
        await client.exec(sql('DELETE FROM user_roles WHERE user_id = $1'), [userId]);
        const now = new Date().toISOString();
        const insertSql = sql(
          buildInsertIgnore(dialect, 'user_roles', ['user_id', 'role', 'created_at']),
        );
        for (const role of roles) {
          await client.exec(insertSql, [userId, role, now]);
        }
      },
    },
    sessions: {
      async create(row) {
        await client.exec(
          sql(`INSERT INTO sessions (id, user_id, csrf_token, user_agent, ip, created_at,
                                     expires_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`),
          [row.id, row.user_id, row.csrf_token, row.user_agent, row.ip, row.created_at, row.expires_at],
        );
      },
      async find(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM sessions WHERE id = $1'),
          [id],
        );
        if (!row) return null;
        return {
          id: row.id as string,
          user_id: row.user_id as string,
          csrf_token: row.csrf_token as string,
          user_agent: (row.user_agent as string | null) ?? null,
          ip: (row.ip as string | null) ?? null,
          created_at: toIsoString(row.created_at) ?? '',
          expires_at: toIsoString(row.expires_at) ?? '',
        };
      },
      async delete(id) {
        await client.exec(sql('DELETE FROM sessions WHERE id = $1'), [id]);
      },
      async deleteForUser(userId) {
        await client.exec(sql('DELETE FROM sessions WHERE user_id = $1'), [userId]);
      },
      async cleanupExpired(now) {
        return client.exec(sql('DELETE FROM sessions WHERE expires_at < $1'), [now]);
      },
    },
    verifications: {
      async createEmailToken(row: EmailVerificationRow) {
        await client.exec(
          sql(`INSERT INTO email_verifications (token, user_id, expires_at, consumed_at)
               VALUES ($1,$2,$3,$4)`),
          [row.token, row.user_id, row.expires_at, row.consumed_at],
        );
      },
      async findEmailToken(token) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM email_verifications WHERE token = $1'),
          [token],
        );
        if (!row) return null;
        return {
          token: row.token as string,
          user_id: row.user_id as string,
          expires_at: toIsoString(row.expires_at) ?? '',
          consumed_at: toIsoString(row.consumed_at),
        };
      },
      async consumeEmailToken(token, at) {
        await client.exec(
          sql('UPDATE email_verifications SET consumed_at = $1 WHERE token = $2'),
          [at, token],
        );
      },
      async createPasswordReset(row: PasswordResetRow) {
        await client.exec(
          sql(`INSERT INTO password_resets (token, user_id, expires_at, consumed_at)
               VALUES ($1,$2,$3,$4)`),
          [row.token, row.user_id, row.expires_at, row.consumed_at],
        );
      },
      async findPasswordReset(token) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM password_resets WHERE token = $1'),
          [token],
        );
        if (!row) return null;
        return {
          token: row.token as string,
          user_id: row.user_id as string,
          expires_at: toIsoString(row.expires_at) ?? '',
          consumed_at: toIsoString(row.consumed_at),
        };
      },
      async consumePasswordReset(token, at) {
        await client.exec(
          sql('UPDATE password_resets SET consumed_at = $1 WHERE token = $2'),
          [at, token],
        );
      },
      async countRecentPasswordResets(userId, since) {
        // expires_at is reset_created_at + 1h, so this approximates "issued in
        // the throttle window" without requiring a schema migration.
        const row = await client.one<{ c: string }>(
          sql('SELECT COUNT(*) as c FROM password_resets WHERE user_id = $1 AND expires_at >= $2'),
          [userId, since],
        );
        return Number(row?.c ?? 0);
      },
    },
    organizations: {
      async insert(row: OrganizationRow) {
        await client.exec(
          sql(`INSERT INTO organizations (id, name, domain, status, created_at)
               VALUES ($1,$2,$3,$4,$5)`),
          [row.id, row.name, row.domain, row.status, row.created_at],
        );
        return row;
      },
      async findById(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM organizations WHERE id = $1'),
          [id],
        );
        if (!row) return null;
        return {
          id: row.id as string,
          name: row.name as string,
          domain: (row.domain as string | null) ?? null,
          status: row.status as OrganizationRow['status'],
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
        };
      },
      async list() {
        const rows = await client.query<Record<string, unknown>>(
          sql('SELECT * FROM organizations ORDER BY created_at DESC'),
          [],
        );
        return rows.map((row) => ({
          id: row.id as string,
          name: row.name as string,
          domain: (row.domain as string | null) ?? null,
          status: row.status as OrganizationRow['status'],
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
        }));
      },
      async addMember(row: OrganizationMemberRow) {
        await client.exec(
          sql(
            buildInsertIgnore(dialect, 'organization_members', [
              'organization_id',
              'user_id',
              'role',
              'created_at',
            ]),
          ),
          [row.organization_id, row.user_id, row.role, row.created_at],
        );
      },
      async membersOf(orgId) {
        const rows = await client.query<Record<string, unknown>>(
          sql('SELECT * FROM organization_members WHERE organization_id = $1'),
          [orgId],
        );
        return rows.map((row) => ({
          organization_id: row.organization_id as string,
          user_id: row.user_id as string,
          role: row.role as OrganizationMemberRow['role'],
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
        }));
      },
    },
    consumers: {
      async insert(row: FerrumConsumerRow) {
        await client.exec(
          sql(`INSERT INTO ferrum_consumers (id, user_id, organization_id, namespace,
                  ferrum_consumer_id, username, status, acl_groups, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`),
          [
            row.id,
            row.user_id,
            row.organization_id,
            row.namespace,
            row.ferrum_consumer_id,
            row.username,
            row.status,
            dialect === 'postgres' ? row.acl_groups : J(row.acl_groups),
            row.created_at,
          ],
        );
        return row;
      },
      async findById(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM ferrum_consumers WHERE id = $1'),
          [id],
        );
        return row ? hydrateConsumer(row) : null;
      },
      async findByUserNamespace(userId, namespace) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM ferrum_consumers WHERE user_id = $1 AND namespace = $2'),
          [userId, namespace],
        );
        return row ? hydrateConsumer(row) : null;
      },
      async updateAclGroups(id, groups) {
        await client.exec(
          sql('UPDATE ferrum_consumers SET acl_groups = $1 WHERE id = $2'),
          [dialect === 'postgres' ? groups : J(groups), id],
        );
      },
      async updateStatus(id, status) {
        await client.exec(
          sql('UPDATE ferrum_consumers SET status = $1 WHERE id = $2'),
          [status, id],
        );
      },
      async listForUser(userId) {
        const rows = await client.query<Record<string, unknown>>(
          sql('SELECT * FROM ferrum_consumers WHERE user_id = $1'),
          [userId],
        );
        return rows.map(hydrateConsumer);
      },
    },
    credentials: {
      async insert(row: CredentialMetadataRow) {
        await client.exec(
          sql(`INSERT INTO credential_metadata (id, consumer_id, type, label, fingerprint,
                  last4, ferrum_credential_index, status, created_at, rotated_at, expires_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`),
          [
            row.id,
            row.consumer_id,
            row.type,
            row.label,
            row.fingerprint,
            row.last4,
            row.ferrum_credential_index,
            row.status,
            row.created_at,
            row.rotated_at,
            row.expires_at,
          ],
        );
        return row;
      },
      async findById(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM credential_metadata WHERE id = $1'),
          [id],
        );
        if (!row) return null;
        return {
          id: row.id as string,
          consumer_id: row.consumer_id as string,
          type: row.type as CredentialMetadataRow['type'],
          label: row.label as string,
          fingerprint: row.fingerprint as string,
          last4: (row.last4 as string | null) ?? null,
          ferrum_credential_index: Number(row.ferrum_credential_index ?? 0),
          status: row.status as CredentialMetadataRow['status'],
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
          rotated_at: toIsoString(row.rotated_at),
          expires_at: toIsoString(row.expires_at),
        };
      },
      async listForConsumer(consumerId) {
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM credential_metadata WHERE consumer_id = $1
               ORDER BY created_at DESC`),
          [consumerId],
        );
        return rows.map((row) => ({
          id: row.id as string,
          consumer_id: row.consumer_id as string,
          type: row.type as CredentialMetadataRow['type'],
          label: row.label as string,
          fingerprint: row.fingerprint as string,
          last4: (row.last4 as string | null) ?? null,
          ferrum_credential_index: Number(row.ferrum_credential_index ?? 0),
          status: row.status as CredentialMetadataRow['status'],
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
          rotated_at: toIsoString(row.rotated_at),
          expires_at: toIsoString(row.expires_at),
        }));
      },
      async updateStatus(id, status) {
        await client.exec(
          sql('UPDATE credential_metadata SET status = $1 WHERE id = $2'),
          [status, id],
        );
      },
      async delete(id) {
        await client.exec(sql('DELETE FROM credential_metadata WHERE id = $1'), [id]);
      },
    },
    apiAssets: {
      async insert(row: ApiAssetRow) {
        await client.exec(
          sql(`INSERT INTO api_assets (id, api_spec_id, proxy_id, namespace, provider_id,
                  title, description, slug, version, visibility, requestable, lifecycle,
                  tags, contact_name, contact_email, contact_url, support_notes,
                  operation_count, content_hash,
                  proxy_hosts, proxy_paths, proxy_upstream_url, timeout_connect_ms,
                  timeout_read_ms, timeout_write_ms, body_size_limit_bytes,
                  rate_limit_per_minute, operation_paths, operation_summaries, source_format,
                  policy_exception_id, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                       $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)`),
          [
            row.id,
            row.api_spec_id,
            row.proxy_id,
            row.namespace,
            row.provider_id,
            row.title,
            row.description,
            row.slug,
            row.version,
            row.visibility,
            boolValue(row.requestable === 1),
            row.lifecycle,
            dialect === 'postgres' ? row.tags : J(row.tags),
            row.contact_name,
            row.contact_email,
            row.contact_url,
            row.support_notes,
            row.operation_count,
            row.content_hash,
            dialect === 'postgres' ? row.proxy_hosts : J(row.proxy_hosts),
            dialect === 'postgres' ? row.proxy_paths : J(row.proxy_paths),
            row.proxy_upstream_url,
            row.timeout_connect_ms,
            row.timeout_read_ms,
            row.timeout_write_ms,
            row.body_size_limit_bytes,
            row.rate_limit_per_minute,
            dialect === 'postgres' ? row.operation_paths : J(row.operation_paths),
            dialect === 'postgres' ? row.operation_summaries : J(row.operation_summaries),
            row.source_format,
            row.policy_exception_id,
            row.created_at,
            row.updated_at,
          ],
        );
        return row;
      },
      async update(id, fields) {
        const existing = await this.findById(id);
        if (!existing) throw new Error(`Asset not found: ${id}`);
        const next = { ...existing, ...fields, updated_at: new Date().toISOString() };
        await client.exec(
          sql(`UPDATE api_assets SET
                 title = $1, description = $2, version = $3, visibility = $4,
                 requestable = $5, lifecycle = $6, tags = $7, contact_name = $8,
                 contact_email = $9, contact_url = $10, support_notes = $11,
                 operation_count = $12, content_hash = $13, api_spec_id = $14,
                 proxy_id = $15, namespace = $16, proxy_hosts = $17, proxy_paths = $18,
                 proxy_upstream_url = $19, timeout_connect_ms = $20, timeout_read_ms = $21,
                 timeout_write_ms = $22, body_size_limit_bytes = $23,
                 rate_limit_per_minute = $24, operation_paths = $25,
                 operation_summaries = $26, source_format = $27, policy_exception_id = $28,
                 updated_at = $29
               WHERE id = $30`),
          [
            next.title,
            next.description,
            next.version,
            next.visibility,
            boolValue(next.requestable === 1),
            next.lifecycle,
            dialect === 'postgres' ? next.tags : J(next.tags),
            next.contact_name,
            next.contact_email,
            next.contact_url,
            next.support_notes,
            next.operation_count,
            next.content_hash,
            next.api_spec_id,
            next.proxy_id,
            next.namespace,
            dialect === 'postgres' ? next.proxy_hosts : J(next.proxy_hosts),
            dialect === 'postgres' ? next.proxy_paths : J(next.proxy_paths),
            next.proxy_upstream_url,
            next.timeout_connect_ms,
            next.timeout_read_ms,
            next.timeout_write_ms,
            next.body_size_limit_bytes,
            next.rate_limit_per_minute,
            dialect === 'postgres' ? next.operation_paths : J(next.operation_paths),
            dialect === 'postgres' ? next.operation_summaries : J(next.operation_summaries),
            next.source_format,
            next.policy_exception_id,
            next.updated_at,
            id,
          ],
        );
        return (await this.findById(id))!;
      },
      async findById(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM api_assets WHERE id = $1'),
          [id],
        );
        return row ? hydrateAsset(row) : null;
      },
      async findBySpecId(specId) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM api_assets WHERE api_spec_id = $1'),
          [specId],
        );
        return row ? hydrateAsset(row) : null;
      },
      async findBySlug(slug) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM api_assets WHERE slug = $1'),
          [slug],
        );
        return row ? hydrateAsset(row) : null;
      },
      async delete(id) {
        await client.exec(sql('DELETE FROM api_assets WHERE id = $1'), [id]);
      },
      async list(opts) {
        const limit = opts.limit ?? 25;
        const offset = opts.offset ?? 0;
        const search = lowerSearch(dialect, opts.search ? `%${opts.search}%` : null);
        const visibility = (opts.visibility as ApiVisibility | undefined) ?? null;
        const providerId = opts.providerId ?? null;
        const titleMatch = caseInsensitiveLike(dialect, 'title', '$2');
        const descMatch = caseInsensitiveLike(dialect, 'description', '$3');
        const slugMatch = caseInsensitiveLike(dialect, 'slug', '$4');
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM api_assets
               WHERE ($1::text IS NULL OR ${titleMatch} OR ${descMatch} OR ${slugMatch})
                 AND ($5::text IS NULL OR visibility = $6)
                 AND ($7::text IS NULL OR provider_id = $8)
               ORDER BY updated_at DESC LIMIT $9 OFFSET $10`),
          [search, search, search, search, visibility, visibility, providerId, providerId, limit, offset],
        );
        const totalRow = await client.one<{ c: string }>(
          sql(`SELECT COUNT(*)::text as c FROM api_assets
               WHERE ($1::text IS NULL OR ${titleMatch} OR ${descMatch} OR ${slugMatch})
                 AND ($5::text IS NULL OR visibility = $6)
                 AND ($7::text IS NULL OR provider_id = $8)`),
          [search, search, search, search, visibility, visibility, providerId, providerId],
        );
        return { rows: rows.map(hydrateAsset), total: Number(totalRow?.c ?? 0) };
      },
    },
    apiSpecVersions: {
      async insert(row: ApiSpecVersionRow) {
        await client.exec(
          sql(`INSERT INTO api_spec_versions (id, api_asset_id, version, content_hash,
                  submitted_by, raw_spec, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`),
          [
            row.id,
            row.api_asset_id,
            row.version,
            row.content_hash,
            row.submitted_by,
            row.raw_spec,
            row.created_at,
          ],
        );
        return row;
      },
      async listForAsset(assetId) {
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM api_spec_versions WHERE api_asset_id = $1
               ORDER BY created_at DESC`),
          [assetId],
        );
        return rows.map((row) => ({
          id: row.id as string,
          api_asset_id: row.api_asset_id as string,
          version: row.version as string,
          content_hash: row.content_hash as string,
          submitted_by: row.submitted_by as string,
          raw_spec: row.raw_spec as string,
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
        }));
      },
      async latestForAsset(assetId) {
        const rows = await this.listForAsset(assetId);
        return rows[0] ?? null;
      },
      async get(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM api_spec_versions WHERE id = $1'),
          [id],
        );
        if (!row) return null;
        return {
          id: row.id as string,
          api_asset_id: row.api_asset_id as string,
          version: row.version as string,
          content_hash: row.content_hash as string,
          submitted_by: row.submitted_by as string,
          raw_spec: row.raw_spec as string,
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
        };
      },
    },
    policyExceptions: {
      async insert(row: PolicyExceptionRequestRow) {
        await client.exec(
          sql(`INSERT INTO policy_exception_requests (id, api_asset_id, provider_id,
                  pending_publish_id, violations, justification, status, reviewed_by,
                  reviewed_at, reviewer_notes, expires_at, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`),
          [
            row.id,
            row.api_asset_id,
            row.provider_id,
            row.pending_publish_id,
            dialect === 'postgres' ? row.violations : J(row.violations),
            row.justification,
            row.status,
            row.reviewed_by,
            row.reviewed_at,
            row.reviewer_notes,
            row.expires_at,
            row.created_at,
          ],
        );
        return row;
      },
      async update(id, fields) {
        const existing = await this.findById(id);
        if (!existing) throw new Error(`Policy exception not found: ${id}`);
        const next = { ...existing, ...fields };
        await client.exec(
          sql(`UPDATE policy_exception_requests SET
                 api_asset_id = $1, provider_id = $2, pending_publish_id = $3,
                 violations = $4, justification = $5, status = $6, reviewed_by = $7,
                 reviewed_at = $8, reviewer_notes = $9, expires_at = $10
               WHERE id = $11`),
          [
            next.api_asset_id,
            next.provider_id,
            next.pending_publish_id,
            dialect === 'postgres' ? next.violations : J(next.violations),
            next.justification,
            next.status,
            next.reviewed_by,
            next.reviewed_at,
            next.reviewer_notes,
            next.expires_at,
            id,
          ],
        );
        return (await this.findById(id))!;
      },
      async findById(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM policy_exception_requests WHERE id = $1'),
          [id],
        );
        return row ? hydratePolicyException(row) : null;
      },
      async listPending() {
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM policy_exception_requests
               WHERE status = 'pending' ORDER BY created_at ASC`),
          [],
        );
        return rows.map(hydratePolicyException);
      },
      async listForProvider(providerId) {
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM policy_exception_requests
               WHERE provider_id = $1 ORDER BY created_at DESC`),
          [providerId],
        );
        return rows.map(hydratePolicyException);
      },
      async listForAsset(apiAssetId) {
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM policy_exception_requests
               WHERE api_asset_id = $1 ORDER BY created_at DESC`),
          [apiAssetId],
        );
        return rows.map(hydratePolicyException);
      },
    },
    pendingPublishes: {
      async insert(row: PendingPublishRow) {
        await client.exec(
          sql(`INSERT INTO pending_publishes (id, provider_id, raw_spec, publish_input,
                  exception_request_id, created_at)
               VALUES ($1,$2,$3,$4,$5,$6)`),
          [
            row.id,
            row.provider_id,
            row.raw_spec,
            dialect === 'postgres' ? row.publish_input : J(row.publish_input),
            row.exception_request_id,
            row.created_at,
          ],
        );
        return row;
      },
      async update(id, fields) {
        const existing = await this.findById(id);
        if (!existing) throw new Error(`Pending publish not found: ${id}`);
        const next = { ...existing, ...fields };
        await client.exec(
          sql(`UPDATE pending_publishes SET provider_id = $1, raw_spec = $2,
                 publish_input = $3, exception_request_id = $4 WHERE id = $5`),
          [
            next.provider_id,
            next.raw_spec,
            dialect === 'postgres' ? next.publish_input : J(next.publish_input),
            next.exception_request_id,
            id,
          ],
        );
        return (await this.findById(id))!;
      },
      async findById(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM pending_publishes WHERE id = $1'),
          [id],
        );
        return row ? hydratePendingPublish(row) : null;
      },
      async delete(id) {
        await client.exec(sql('DELETE FROM pending_publishes WHERE id = $1'), [id]);
      },
    },
    accessRequests: {
      async insert(row: AccessRequestRow) {
        await client.exec(
          sql(`INSERT INTO access_requests (id, api_asset_id, client_user_id,
                  client_consumer_id, justification, status, provider_reason, reviewed_by,
                  created_at, reviewed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`),
          [
            row.id,
            row.api_asset_id,
            row.client_user_id,
            row.client_consumer_id,
            row.justification,
            row.status,
            row.provider_reason,
            row.reviewed_by,
            row.created_at,
            row.reviewed_at,
          ],
        );
        return row;
      },
      async update(id, fields) {
        const existing = await this.findById(id);
        if (!existing) throw new Error(`Request not found: ${id}`);
        const next = { ...existing, ...fields };
        await client.exec(
          sql(`UPDATE access_requests SET status = $1, provider_reason = $2,
                 reviewed_by = $3, reviewed_at = $4, client_consumer_id = $5,
                 justification = $6 WHERE id = $7`),
          [
            next.status,
            next.provider_reason,
            next.reviewed_by,
            next.reviewed_at,
            next.client_consumer_id,
            next.justification,
            id,
          ],
        );
        return next;
      },
      async findById(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM access_requests WHERE id = $1'),
          [id],
        );
        return row ? hydrateAccessRequest(row) : null;
      },
      async findOpenFor(clientUserId, apiAssetId) {
        const row = await client.one<Record<string, unknown>>(
          sql(`SELECT * FROM access_requests
               WHERE client_user_id = $1 AND api_asset_id = $2 AND status = 'pending'`),
          [clientUserId, apiAssetId],
        );
        return row ? hydrateAccessRequest(row) : null;
      },
      // listForClient/Provider/Asset SELECT full rows and hydrate inline. The
      // previous implementation re-fetched each row by id (N+1), which made
      // every dashboard render a quadratic load.
      async listForClient(clientUserId) {
        const rows = await client.query<Record<string, unknown>>(
          sql('SELECT * FROM access_requests WHERE client_user_id = $1 ORDER BY created_at DESC'),
          [clientUserId],
        );
        return rows.map(hydrateAccessRequest);
      },
      async listForProvider(providerId, status?: AccessRequestStatus) {
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT ar.* FROM access_requests ar
               JOIN api_assets a ON a.id = ar.api_asset_id
               WHERE a.provider_id = $1 AND ($2::text IS NULL OR ar.status = $3)
               ORDER BY ar.created_at DESC`),
          [providerId, status ?? null, status ?? null],
        );
        return rows.map(hydrateAccessRequest);
      },
      async listForAsset(apiAssetId) {
        const rows = await client.query<Record<string, unknown>>(
          sql('SELECT * FROM access_requests WHERE api_asset_id = $1 ORDER BY created_at DESC'),
          [apiAssetId],
        );
        return rows.map(hydrateAccessRequest);
      },
    },
    grants: {
      async insert(row: AccessGrantRow) {
        await client.exec(
          sql(`INSERT INTO access_grants (id, api_asset_id, client_user_id,
                  client_consumer_id, acl_group, status, approved_by, approved_at,
                  revoked_by, revoked_at, revoked_reason)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`),
          [
            row.id,
            row.api_asset_id,
            row.client_user_id,
            row.client_consumer_id,
            row.acl_group,
            row.status,
            row.approved_by,
            row.approved_at,
            row.revoked_by,
            row.revoked_at,
            row.revoked_reason,
          ],
        );
        return row;
      },
      async update(id, fields) {
        const existing = await this.findById(id);
        if (!existing) throw new Error(`Grant not found: ${id}`);
        const next = { ...existing, ...fields };
        await client.exec(
          sql(`UPDATE access_grants SET status = $1, revoked_by = $2, revoked_at = $3,
                 revoked_reason = $4 WHERE id = $5`),
          [next.status, next.revoked_by, next.revoked_at, next.revoked_reason, id],
        );
        return next;
      },
      async findById(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM access_grants WHERE id = $1'),
          [id],
        );
        return row ? hydrateAccessGrant(row) : null;
      },
      async findActiveFor(consumerId, apiAssetId) {
        const row = await client.one<Record<string, unknown>>(
          sql(`SELECT * FROM access_grants
               WHERE client_consumer_id = $1 AND api_asset_id = $2 AND status = 'active'`),
          [consumerId, apiAssetId],
        );
        return row ? hydrateAccessGrant(row) : null;
      },
      // SELECT full rows + hydrate inline so list endpoints are a single query.
      async listForClient(clientUserId) {
        const rows = await client.query<Record<string, unknown>>(
          sql('SELECT * FROM access_grants WHERE client_user_id = $1 ORDER BY approved_at DESC'),
          [clientUserId],
        );
        return rows.map(hydrateAccessGrant);
      },
      async listForAsset(apiAssetId) {
        const rows = await client.query<Record<string, unknown>>(
          sql('SELECT * FROM access_grants WHERE api_asset_id = $1 ORDER BY approved_at DESC'),
          [apiAssetId],
        );
        return rows.map(hydrateAccessGrant);
      },
    },
    conversations: {
      async insert(row: ConversationRow) {
        await client.exec(
          sql(`INSERT INTO conversations (id, api_asset_id, request_id, grant_id, type,
                  subject, participants, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`),
          [
            row.id,
            row.api_asset_id,
            row.request_id,
            row.grant_id,
            row.type,
            row.subject,
            dialect === 'postgres' ? row.participants : J(row.participants),
            row.created_at,
          ],
        );
        return row;
      },
      async findById(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM conversations WHERE id = $1'),
          [id],
        );
        if (!row) return null;
        return {
          id: row.id as string,
          api_asset_id: (row.api_asset_id as string | null) ?? null,
          request_id: (row.request_id as string | null) ?? null,
          grant_id: (row.grant_id as string | null) ?? null,
          type: row.type as ConversationRow['type'],
          subject: row.subject as string,
          participants: asJson<string[]>(row.participants, []),
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
        };
      },
      async listForUser(userId) {
        const rows =
          dialect === 'postgres'
            ? await client.query<{ id: string }>(
                `SELECT id FROM conversations
                 WHERE participants ? $1 ORDER BY created_at DESC`,
                [userId],
              )
            : await client.query<{ id: string }>(
                `SELECT id FROM conversations
                 WHERE JSON_CONTAINS(participants, JSON_QUOTE(?)) ORDER BY created_at DESC`,
                [userId],
              );
        return Promise.all(rows.map((r) => this.findById(r.id).then((v) => v!)));
      },
      async updateParticipants(id, participants) {
        await client.exec(
          sql('UPDATE conversations SET participants = $1 WHERE id = $2'),
          [dialect === 'postgres' ? participants : J(participants), id],
        );
      },
    },
    messages: {
      async insert(row: MessageRow) {
        await client.exec(
          sql(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at, read_by)
               VALUES ($1,$2,$3,$4,$5,$6)`),
          [
            row.id,
            row.conversation_id,
            row.sender_id,
            row.body,
            row.created_at,
            dialect === 'postgres' ? row.read_by : J(row.read_by),
          ],
        );
        return row;
      },
      async listForConversation(conversationId) {
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`),
          [conversationId],
        );
        return rows.map((row) => ({
          id: row.id as string,
          conversation_id: row.conversation_id as string,
          sender_id: row.sender_id as string,
          body: row.body as string,
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
          read_by: asJson<string[]>(row.read_by, []),
        }));
      },
      async markRead(conversationId, userId) {
        const rows = await this.listForConversation(conversationId);
        for (const r of rows) {
          if (r.sender_id !== userId && !r.read_by.includes(userId)) {
            const next = [...r.read_by, userId];
            await client.exec(
              sql('UPDATE messages SET read_by = $1 WHERE id = $2'),
              [dialect === 'postgres' ? next : J(next), r.id],
            );
          }
        }
      },
    },
    notifications: {
      async insert(row: NotificationRow) {
        await client.exec(
          sql(`INSERT INTO notifications (id, recipient_id, type, payload, read_at, created_at)
               VALUES ($1,$2,$3,$4,$5,$6)`),
          [
            row.id,
            row.recipient_id,
            row.type,
            dialect === 'postgres' ? row.payload : J(row.payload),
            row.read_at,
            row.created_at,
          ],
        );
        return row;
      },
      async listForUser(userId, limit) {
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM notifications WHERE recipient_id = $1
               ORDER BY created_at DESC LIMIT $2`),
          [userId, limit],
        );
        return rows.map((row) => ({
          id: row.id as string,
          recipient_id: row.recipient_id as string,
          type: row.type as NotificationRow['type'],
          payload: asJson<Record<string, unknown>>(row.payload, {}),
          read_at: toIsoString(row.read_at),
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
        }));
      },
      async markRead(id, userId, at) {
        return client.exec(
          sql('UPDATE notifications SET read_at = $1 WHERE id = $2 AND recipient_id = $3'),
          [at, id, userId],
        );
      },
      async unreadCount(userId) {
        const row = await client.one<{ c: string }>(
          sql(`SELECT COUNT(*)::text as c FROM notifications
               WHERE recipient_id = $1 AND read_at IS NULL`),
          [userId],
        );
        return Number(row?.c ?? 0);
      },
    },
    email: {
      async enqueue(row: EmailOutboxRow) {
        // The partial unique index on `idempotency_key` makes a duplicate
        // enqueue with the same key violate the constraint — ON CONFLICT
        // turns that into a no-op so the caller sees idempotent behavior.
        const conflictClause =
          dialect === 'postgres'
            ? ' ON CONFLICT (idempotency_key) DO NOTHING'
            : ' ON DUPLICATE KEY UPDATE idempotency_key = idempotency_key';
        await client.exec(
          sql(
            `INSERT INTO email_outbox (id, to_address, subject, template_id, payload,
                  status, attempts, last_error, scheduled_at, sent_at, created_at,
                  idempotency_key, headers)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)` + conflictClause,
          ),
          [
            row.id,
            row.to_address,
            row.subject,
            row.template_id,
            dialect === 'postgres' ? row.payload : J(row.payload),
            row.status,
            row.attempts,
            row.last_error,
            row.scheduled_at,
            row.sent_at,
            row.created_at,
            row.idempotency_key,
            row.headers == null
              ? null
              : dialect === 'postgres'
                ? row.headers
                : J(row.headers),
          ],
        );
      },
      async claimBatch(now, batchSize) {
        // Find candidate ids, then atomically transition each one to
        // `sending`. A conditional UPDATE guarantees that only one worker
        // claims a given row even when several poll concurrently.
        const candidates = await client.query<{ id: string }>(
          sql(`SELECT id FROM email_outbox WHERE status = 'pending' AND scheduled_at <= $1
               ORDER BY scheduled_at ASC LIMIT $2`),
          [now, batchSize],
        );
        const claimed: EmailOutboxRow[] = [];
        for (const c of candidates) {
          const affected = await client.exec(
            sql(`UPDATE email_outbox SET status = 'sending'
                 WHERE id = $1 AND status = 'pending'`),
            [c.id],
          );
          if (affected === 0) continue;
          const row = await client.one<Record<string, unknown>>(
            sql('SELECT * FROM email_outbox WHERE id = $1'),
            [c.id],
          );
          if (!row) continue;
          claimed.push({
            id: row.id as string,
            to_address: row.to_address as string,
            subject: row.subject as string,
            template_id: (row.template_id as string | null) ?? null,
            payload: asJson<Record<string, unknown>>(row.payload, {}),
            status: row.status as EmailOutboxRow['status'],
            attempts: Number(row.attempts ?? 0),
            last_error: (row.last_error as string | null) ?? null,
            scheduled_at: toIsoString(row.scheduled_at) ?? new Date().toISOString(),
            sent_at: toIsoString(row.sent_at),
            created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
            idempotency_key: (row.idempotency_key as string | null) ?? null,
            headers:
              row.headers == null
                ? null
                : asJson<Record<string, string>>(row.headers, {}),
          });
        }
        return claimed;
      },
      async markSent(id, at) {
        await client.exec(
          sql("UPDATE email_outbox SET status = 'sent', sent_at = $1 WHERE id = $2"),
          [at, id],
        );
      },
      async markFailed(id, attempts, error) {
        const backoffMs = Math.min(60_000 * attempts, 30 * 60_000);
        const scheduled = new Date(Date.now() + backoffMs).toISOString();
        const status = attempts >= 5 ? 'failed' : 'pending';
        await client.exec(
          sql(`UPDATE email_outbox SET attempts = $1, last_error = $2,
                 status = $3, scheduled_at = $4 WHERE id = $5`),
          [attempts, error, status, scheduled, id],
        );
      },
      async listFailed(opts) {
        const limit = opts.limit ?? 50;
        const offset = opts.offset ?? 0;
        const rows = await client.query<Record<string, unknown>>(
          sql(
            "SELECT * FROM email_outbox WHERE status = 'failed' ORDER BY created_at DESC LIMIT $1 OFFSET $2",
          ),
          [limit, offset],
        );
        const total = (
          await client.one<{ c: string }>(
            sql("SELECT COUNT(*)::text as c FROM email_outbox WHERE status = 'failed'"),
            [],
          )
        )?.c;
        return {
          rows: rows.map((row) => ({
            id: row.id as string,
            to_address: row.to_address as string,
            subject: row.subject as string,
            template_id: (row.template_id as string | null) ?? null,
            payload: asJson<Record<string, unknown>>(row.payload, {}),
            status: row.status as EmailOutboxRow['status'],
            attempts: Number(row.attempts ?? 0),
            last_error: (row.last_error as string | null) ?? null,
            scheduled_at: toIsoString(row.scheduled_at) ?? new Date().toISOString(),
            sent_at: toIsoString(row.sent_at),
            created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
            idempotency_key: (row.idempotency_key as string | null) ?? null,
            headers:
              row.headers == null
                ? null
                : asJson<Record<string, string>>(row.headers, {}),
          })),
          total: Number(total ?? 0),
        };
      },
      async requeue(id) {
        const changes = await client.exec(
          sql(
            "UPDATE email_outbox SET status = 'pending', attempts = 0, last_error = NULL, scheduled_at = $1 WHERE id = $2 AND status = 'failed'",
          ),
          [new Date().toISOString(), id],
        );
        return changes > 0;
      },
      async getTemplate(key) {
        const keyCol = ident(dialect, 'key');
        const row = await client.one<Record<string, unknown>>(
          sql(`SELECT * FROM email_templates WHERE ${keyCol} = $1`),
          [key],
        );
        if (!row) return null;
        return {
          key: row.key as string,
          subject_template: row.subject_template as string,
          body_template: row.body_template as string,
          enabled: asBool(row.enabled) ? 1 : 0,
          updated_at: toIsoString(row.updated_at) ?? new Date().toISOString(),
        };
      },
      async upsertTemplate(row: EmailTemplateRow) {
        await client.exec(
          sql(
            buildUpsert(
              dialect,
              'email_templates',
              ['key', 'subject_template', 'body_template', 'enabled', 'updated_at'],
              ['key'],
            ),
          ),
          [
            row.key,
            row.subject_template,
            row.body_template,
            boolValue(row.enabled === 1),
            row.updated_at,
          ],
        );
      },
      async listTemplates() {
        const keyCol = ident(dialect, 'key');
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM email_templates ORDER BY ${keyCol} ASC`),
          [],
        );
        return rows.map((row) => ({
          key: row.key as string,
          subject_template: row.subject_template as string,
          body_template: row.body_template as string,
          enabled: asBool(row.enabled) ? 1 : 0,
          updated_at: toIsoString(row.updated_at) ?? new Date().toISOString(),
        }));
      },
    },
    settings: {
      async get<T>(key: string): Promise<T | null> {
        const keyCol = ident(dialect, 'key');
        const row = await client.one<Record<string, unknown>>(
          sql(`SELECT * FROM app_settings WHERE ${keyCol} = $1`),
          [key],
        );
        if (!row) return null;
        return asJson<T>(row.value, null as T);
      },
      async set<T>(key: string, value: T, encrypted = false) {
        await client.exec(
          sql(
            buildUpsert(
              dialect,
              'app_settings',
              ['key', 'value', 'encrypted', 'updated_at'],
              ['key'],
            ),
          ),
          [key, JSON.stringify(value), boolValue(encrypted), new Date().toISOString()],
        );
      },
      async setIfAbsent<T>(key: string, value: T, encrypted = false) {
        const changed = await client.exec(
          sql(
            buildInsertIgnore(
              dialect,
              'app_settings',
              ['key', 'value', 'encrypted', 'updated_at'],
            ),
          ),
          [key, JSON.stringify(value), boolValue(encrypted), new Date().toISOString()],
        );
        return changed > 0;
      },
      async all() {
        const keyCol = ident(dialect, 'key');
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM app_settings ORDER BY ${keyCol} ASC`),
          [],
        );
        return rows.map((row) => ({
          key: row.key as string,
          value: asJson<unknown>(row.value, null),
          encrypted: asBool(row.encrypted) ? 1 : 0,
          updated_at: toIsoString(row.updated_at) ?? new Date().toISOString(),
        })) as AppSettingRow[];
      },
    },
    audit: {
      async insert(row: AuditLogRow) {
        await client.exec(
          sql(`INSERT INTO audit_logs (id, actor_id, actor_email, action, target_type,
                  target_id, reason, before, after, ip, user_agent, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`),
          [
            row.id,
            row.actor_id,
            row.actor_email,
            row.action,
            row.target_type,
            row.target_id,
            row.reason,
            dialect === 'postgres' ? row.before : row.before == null ? null : JSON.stringify(row.before),
            dialect === 'postgres' ? row.after : row.after == null ? null : JSON.stringify(row.after),
            row.ip,
            row.user_agent,
            row.created_at,
          ],
        );
      },
      async list(opts) {
        const limit = opts.limit ?? 50;
        const offset = opts.offset ?? 0;
        const action = opts.action ?? null;
        const actorId = opts.actorId ?? null;
        const rows = await client.query<Record<string, unknown>>(
          sql(`SELECT * FROM audit_logs
               WHERE ($1::text IS NULL OR action = $2)
                 AND ($3::text IS NULL OR actor_id = $4)
               ORDER BY created_at DESC LIMIT $5 OFFSET $6`),
          [action, action, actorId, actorId, limit, offset],
        );
        const totalRow = await client.one<{ c: string }>(
          sql(`SELECT COUNT(*)::text as c FROM audit_logs
               WHERE ($1::text IS NULL OR action = $2)
                 AND ($3::text IS NULL OR actor_id = $4)`),
          [action, action, actorId, actorId],
        );
        return {
          rows: rows.map((row) => ({
            id: row.id as string,
            actor_id: (row.actor_id as string | null) ?? null,
            actor_email: (row.actor_email as string | null) ?? null,
            action: row.action as string,
            target_type: row.target_type as string,
            target_id: (row.target_id as string | null) ?? null,
            reason: (row.reason as string | null) ?? null,
            before: asJson<unknown>(row.before, null),
            after: asJson<unknown>(row.after, null),
            ip: (row.ip as string | null) ?? null,
            user_agent: (row.user_agent as string | null) ?? null,
            created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
          })),
          total: Number(totalRow?.c ?? 0),
        };
      },
    },
    massEmail: {
      async insert(row: MassEmailCampaignRow) {
        await client.exec(
          sql(`INSERT INTO mass_email_campaigns (id, created_by, recipient_filter, subject,
                  body, status, sent_count, failed_count, created_at, completed_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`),
          [
            row.id,
            row.created_by,
            dialect === 'postgres' ? row.recipient_filter : J(row.recipient_filter),
            row.subject,
            row.body,
            row.status,
            row.sent_count,
            row.failed_count,
            row.created_at,
            row.completed_at,
          ],
        );
        return row;
      },
      async update(id, fields) {
        const existing = await this.findById(id);
        if (!existing) throw new Error(`Campaign not found: ${id}`);
        const next = { ...existing, ...fields };
        await client.exec(
          sql(`UPDATE mass_email_campaigns SET status = $1, sent_count = $2,
                 failed_count = $3, completed_at = $4 WHERE id = $5`),
          [next.status, next.sent_count, next.failed_count, next.completed_at, id],
        );
        return next;
      },
      async list() {
        const rows = await client.query<Record<string, unknown>>(
          sql('SELECT * FROM mass_email_campaigns ORDER BY created_at DESC'),
          [],
        );
        return rows.map((row) => ({
          id: row.id as string,
          created_by: row.created_by as string,
          recipient_filter: asJson<Record<string, unknown>>(row.recipient_filter, {}),
          subject: row.subject as string,
          body: row.body as string,
          status: row.status as MassEmailCampaignRow['status'],
          sent_count: Number(row.sent_count ?? 0),
          failed_count: Number(row.failed_count ?? 0),
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
          completed_at: toIsoString(row.completed_at),
        }));
      },
      async findById(id) {
        const row = await client.one<Record<string, unknown>>(
          sql('SELECT * FROM mass_email_campaigns WHERE id = $1'),
          [id],
        );
        if (!row) return null;
        return {
          id: row.id as string,
          created_by: row.created_by as string,
          recipient_filter: asJson<Record<string, unknown>>(row.recipient_filter, {}),
          subject: row.subject as string,
          body: row.body as string,
          status: row.status as MassEmailCampaignRow['status'],
          sent_count: Number(row.sent_count ?? 0),
          failed_count: Number(row.failed_count ?? 0),
          created_at: toIsoString(row.created_at) ?? new Date().toISOString(),
          completed_at: toIsoString(row.completed_at),
        };
      },
    },
  };
}
