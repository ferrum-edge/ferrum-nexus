import type DatabaseT from 'better-sqlite3';
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
  UserRoleRow,
  UserRow,
} from '../../store.js';
import type {
  AccessRequestStatus,
  ApiVisibility,
  UserRole,
  UserStatus,
} from '@ferrum-nexus/shared';

type SqliteDB = DatabaseT.Database;

const J = (value: unknown): string => JSON.stringify(value ?? null);
const P = <T>(value: string | null | undefined, fallback: T): T => {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

type ConsumerRowRaw = Omit<FerrumConsumerRow, 'acl_groups'> & { acl_groups: string };
type AssetJsonField =
  | 'tags'
  | 'proxy_hosts'
  | 'proxy_paths'
  | 'operation_paths'
  | 'operation_summaries';
type AssetRowRaw = Omit<ApiAssetRow, AssetJsonField> & {
  tags: string;
  proxy_hosts: string | null;
  proxy_paths: string | null;
  operation_paths: string | null;
  operation_summaries: string | null;
};
type ConversationRowRaw = Omit<ConversationRow, 'participants'> & { participants: string };
type MessageRowRaw = Omit<MessageRow, 'read_by'> & { read_by: string };
type NotificationRowRaw = Omit<NotificationRow, 'payload'> & { payload: string };
type OutboxRowRaw = Omit<EmailOutboxRow, 'payload' | 'headers'> & {
  payload: string;
  headers: string | null;
};
type AuditRowRaw = Omit<AuditLogRow, 'before' | 'after'> & { before: string; after: string };
type SettingRowRaw = Omit<AppSettingRow, 'value' | 'encrypted'> & { value: string; encrypted: number };
type CampaignRowRaw = Omit<MassEmailCampaignRow, 'recipient_filter'> & { recipient_filter: string };
type PolicyExceptionRaw = Omit<PolicyExceptionRequestRow, 'violations'> & { violations: string };
type PendingPublishRaw = Omit<PendingPublishRow, 'publish_input'> & { publish_input: string };

function hydrateConsumer(row: ConsumerRowRaw): FerrumConsumerRow {
  return { ...row, acl_groups: P<string[]>(row.acl_groups, []) };
}
function hydrateAsset(row: AssetRowRaw): ApiAssetRow {
  return {
    ...row,
    tags: P<string[]>(row.tags, []),
    proxy_hosts: P<string[]>(row.proxy_hosts, []),
    proxy_paths: P<string[]>(row.proxy_paths, []),
    proxy_upstream_url: row.proxy_upstream_url ?? null,
    timeout_connect_ms: row.timeout_connect_ms ?? null,
    timeout_read_ms: row.timeout_read_ms ?? null,
    timeout_write_ms: row.timeout_write_ms ?? null,
    body_size_limit_bytes: row.body_size_limit_bytes ?? null,
    rate_limit_per_minute: row.rate_limit_per_minute ?? null,
    operation_paths: P<string[]>(row.operation_paths, []),
    operation_summaries: P<string[]>(row.operation_summaries, []),
    source_format: row.source_format ?? 'openapi3',
    policy_exception_id: row.policy_exception_id ?? null,
  };
}
function hydrateConversation(row: ConversationRowRaw): ConversationRow {
  return { ...row, participants: P<string[]>(row.participants, []) };
}
function hydrateMessage(row: MessageRowRaw): MessageRow {
  return { ...row, read_by: P<string[]>(row.read_by, []) };
}
function hydrateNotification(row: NotificationRowRaw): NotificationRow {
  return { ...row, payload: P<Record<string, unknown>>(row.payload, {}) };
}
function hydrateOutbox(row: OutboxRowRaw): EmailOutboxRow {
  return {
    ...row,
    payload: P<Record<string, unknown>>(row.payload, {}),
    headers: row.headers == null ? null : P<Record<string, string>>(row.headers, {}),
  };
}
function hydrateAudit(row: AuditRowRaw): AuditLogRow {
  return {
    ...row,
    before: row.before ? JSON.parse(row.before) : null,
    after: row.after ? JSON.parse(row.after) : null,
  };
}
function hydrateCampaign(row: CampaignRowRaw): MassEmailCampaignRow {
  return { ...row, recipient_filter: P<Record<string, unknown>>(row.recipient_filter, {}) };
}
function hydratePolicyException(row: PolicyExceptionRaw): PolicyExceptionRequestRow {
  return { ...row, violations: P<PolicyExceptionRequestRow['violations']>(row.violations, []) };
}
function hydratePendingPublish(row: PendingPublishRaw): PendingPublishRow {
  return {
    ...row,
    publish_input: P<Record<string, unknown>>(row.publish_input, {}),
  };
}

export function buildSqliteRepos(db: SqliteDB): Omit<NexusStore, 'driver' | 'transaction' | 'migrate' | 'close'> {
  // ---------- USERS ----------
  const usersInsert = db.prepare(`
    INSERT INTO users (id, email, email_normalized, name, phone, status, email_verified_at,
                       password_hash, last_login_at, failed_login_count, organization_id,
                       created_at, updated_at)
    VALUES (@id, @email, @email_normalized, @name, @phone, @status, @email_verified_at,
            @password_hash, @last_login_at, @failed_login_count, @organization_id,
            @created_at, @updated_at)
  `);
  const usersFindById = db.prepare('SELECT * FROM users WHERE id = ?');
  const usersFindByEmail = db.prepare('SELECT * FROM users WHERE email_normalized = ?');
  const usersUpdateContact = db.prepare(`
    UPDATE users SET name = COALESCE(@name, name), phone = COALESCE(@phone, phone),
                     updated_at = @updated_at
    WHERE id = @id
  `);
  const usersUpdatePassword = db.prepare(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
  );
  const usersUpdateStatus = db.prepare(
    'UPDATE users SET status = ?, updated_at = ? WHERE id = ?',
  );
  const usersMarkVerified = db.prepare(
    "UPDATE users SET email_verified_at = ?, status = 'active', updated_at = ? WHERE id = ?",
  );
  const usersRecordLogin = db.prepare(
    'UPDATE users SET last_login_at = ?, failed_login_count = 0, updated_at = ? WHERE id = ?',
  );
  const usersIncFailed = db.prepare(
    'UPDATE users SET failed_login_count = failed_login_count + 1, updated_at = ? WHERE id = ? RETURNING failed_login_count',
  );
  const usersResetFailed = db.prepare(
    'UPDATE users SET failed_login_count = 0, updated_at = ? WHERE id = ?',
  );
  const usersCount = db.prepare('SELECT COUNT(*) as c FROM users');
  const usersList = db.prepare(`
    SELECT * FROM users
    WHERE (@search IS NULL OR email_normalized LIKE @search OR name LIKE @search)
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `);
  const usersListCount = db.prepare(`
    SELECT COUNT(*) as c FROM users
    WHERE (@search IS NULL OR email_normalized LIKE @search OR name LIKE @search)
  `);
  // Filtered listing for mass-email & admin: JOIN against user_roles when a
  // role filter is supplied so the database does the matching, not JS.
  const usersListFiltered = db.prepare(`
    SELECT u.* FROM users u
    WHERE (@status IS NULL OR u.status = @status)
      AND (@role IS NULL OR EXISTS (
        SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = @role
      ))
    ORDER BY u.created_at DESC
    LIMIT @limit OFFSET @offset
  `);
  const usersListFilteredCount = db.prepare(`
    SELECT COUNT(*) as c FROM users u
    WHERE (@status IS NULL OR u.status = @status)
      AND (@role IS NULL OR EXISTS (
        SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = @role
      ))
  `);

  // ---------- USER ROLES ----------
  const rolesAdd = db.prepare(
    'INSERT OR IGNORE INTO user_roles (user_id, role, created_at) VALUES (?, ?, ?)',
  );
  const rolesRemove = db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role = ?');
  const rolesForUser = db.prepare('SELECT role FROM user_roles WHERE user_id = ?');
  const rolesClearForUser = db.prepare('DELETE FROM user_roles WHERE user_id = ?');

  // ---------- SESSIONS ----------
  const sessionsInsert = db.prepare(`
    INSERT INTO sessions (id, user_id, csrf_token, user_agent, ip, created_at, expires_at)
    VALUES (@id, @user_id, @csrf_token, @user_agent, @ip, @created_at, @expires_at)
  `);
  const sessionsFind = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const sessionsDelete = db.prepare('DELETE FROM sessions WHERE id = ?');
  const sessionsDeleteForUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const sessionsCleanup = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

  // ---------- VERIFICATIONS ----------
  const evInsert = db.prepare(`
    INSERT INTO email_verifications (token, user_id, expires_at, consumed_at)
    VALUES (@token, @user_id, @expires_at, @consumed_at)
  `);
  const evFind = db.prepare('SELECT * FROM email_verifications WHERE token = ?');
  const evConsume = db.prepare(
    'UPDATE email_verifications SET consumed_at = ? WHERE token = ?',
  );
  const prInsert = db.prepare(`
    INSERT INTO password_resets (token, user_id, expires_at, consumed_at)
    VALUES (@token, @user_id, @expires_at, @consumed_at)
  `);
  const prFind = db.prepare('SELECT * FROM password_resets WHERE token = ?');
  const prConsume = db.prepare('UPDATE password_resets SET consumed_at = ? WHERE token = ?');
  // The `consumed_at IS NULL` filter restricts the count to live reset tokens
  // — a user who completed a reset shouldn't be billed against the throttle.
  const prCountRecent = db.prepare(
    "SELECT COUNT(*) as c FROM password_resets WHERE user_id = ? AND expires_at >= ?",
  );

  // ---------- ORGS ----------
  const orgInsert = db.prepare(`
    INSERT INTO organizations (id, name, domain, status, created_at)
    VALUES (@id, @name, @domain, @status, @created_at)
  `);
  const orgFind = db.prepare('SELECT * FROM organizations WHERE id = ?');
  const orgList = db.prepare('SELECT * FROM organizations ORDER BY created_at DESC');
  const orgAddMember = db.prepare(`
    INSERT OR IGNORE INTO organization_members (organization_id, user_id, role, created_at)
    VALUES (@organization_id, @user_id, @role, @created_at)
  `);
  const orgMembers = db.prepare(
    'SELECT * FROM organization_members WHERE organization_id = ?',
  );

  // ---------- CONSUMERS ----------
  const consInsert = db.prepare(`
    INSERT INTO ferrum_consumers (id, user_id, organization_id, namespace, ferrum_consumer_id,
                                  username, status, acl_groups, created_at)
    VALUES (@id, @user_id, @organization_id, @namespace, @ferrum_consumer_id,
            @username, @status, @acl_groups, @created_at)
  `);
  const consFindById = db.prepare('SELECT * FROM ferrum_consumers WHERE id = ?');
  const consFindByUserNs = db.prepare(
    'SELECT * FROM ferrum_consumers WHERE user_id = ? AND namespace = ?',
  );
  const consUpdateAcl = db.prepare(
    'UPDATE ferrum_consumers SET acl_groups = ? WHERE id = ?',
  );
  const consUpdateStatus = db.prepare(
    'UPDATE ferrum_consumers SET status = ? WHERE id = ?',
  );
  const consListForUser = db.prepare('SELECT * FROM ferrum_consumers WHERE user_id = ?');

  // ---------- CREDENTIALS ----------
  const credInsert = db.prepare(`
    INSERT INTO credential_metadata (id, consumer_id, type, label, fingerprint, last4,
                                     ferrum_credential_index, status, created_at, rotated_at,
                                     expires_at)
    VALUES (@id, @consumer_id, @type, @label, @fingerprint, @last4, @ferrum_credential_index,
            @status, @created_at, @rotated_at, @expires_at)
  `);
  const credFindById = db.prepare('SELECT * FROM credential_metadata WHERE id = ?');
  const credListForConsumer = db.prepare(
    'SELECT * FROM credential_metadata WHERE consumer_id = ? ORDER BY created_at DESC',
  );
  const credUpdateStatus = db.prepare(
    'UPDATE credential_metadata SET status = ? WHERE id = ?',
  );
  const credDelete = db.prepare('DELETE FROM credential_metadata WHERE id = ?');

  // ---------- API ASSETS ----------
  const assetInsert = db.prepare(`
    INSERT INTO api_assets (id, api_spec_id, proxy_id, namespace, provider_id, title,
                            description, slug, version, visibility, requestable, lifecycle,
                            tags, contact_name, contact_email, contact_url, support_notes,
                            operation_count, content_hash,
                            proxy_hosts, proxy_paths, proxy_upstream_url, timeout_connect_ms,
                            timeout_read_ms, timeout_write_ms, body_size_limit_bytes,
                            rate_limit_per_minute, operation_paths, operation_summaries,
                            source_format, policy_exception_id, created_at, updated_at)
    VALUES (@id, @api_spec_id, @proxy_id, @namespace, @provider_id, @title, @description,
            @slug, @version, @visibility, @requestable, @lifecycle, @tags, @contact_name,
            @contact_email, @contact_url, @support_notes, @operation_count, @content_hash,
            @proxy_hosts, @proxy_paths, @proxy_upstream_url, @timeout_connect_ms,
            @timeout_read_ms, @timeout_write_ms, @body_size_limit_bytes,
            @rate_limit_per_minute, @operation_paths, @operation_summaries, @source_format,
            @policy_exception_id, @created_at, @updated_at)
  `);
  const assetFindById = db.prepare('SELECT * FROM api_assets WHERE id = ?');
  const assetFindBySpec = db.prepare('SELECT * FROM api_assets WHERE api_spec_id = ?');
  const assetFindBySlug = db.prepare('SELECT * FROM api_assets WHERE slug = ?');
  const assetDelete = db.prepare('DELETE FROM api_assets WHERE id = ?');
  const assetList = db.prepare(`
    SELECT * FROM api_assets
    WHERE (@search IS NULL OR title LIKE @search OR description LIKE @search OR slug LIKE @search)
      AND (@visibility IS NULL OR visibility = @visibility)
      AND (@providerId IS NULL OR provider_id = @providerId)
    ORDER BY updated_at DESC
    LIMIT @limit OFFSET @offset
  `);
  const assetListCount = db.prepare(`
    SELECT COUNT(*) as c FROM api_assets
    WHERE (@search IS NULL OR title LIKE @search OR description LIKE @search OR slug LIKE @search)
      AND (@visibility IS NULL OR visibility = @visibility)
      AND (@providerId IS NULL OR provider_id = @providerId)
  `);

  // ---------- API SPEC VERSIONS ----------
  const specVerInsert = db.prepare(`
    INSERT INTO api_spec_versions (id, api_asset_id, version, content_hash, submitted_by,
                                    raw_spec, created_at)
    VALUES (@id, @api_asset_id, @version, @content_hash, @submitted_by, @raw_spec, @created_at)
  `);
  const specVerListForAsset = db.prepare(
    'SELECT * FROM api_spec_versions WHERE api_asset_id = ? ORDER BY created_at DESC',
  );
  const specVerLatest = db.prepare(
    'SELECT * FROM api_spec_versions WHERE api_asset_id = ? ORDER BY created_at DESC LIMIT 1',
  );
  const specVerGet = db.prepare('SELECT * FROM api_spec_versions WHERE id = ?');

  // ---------- GOVERNANCE ----------
  const pendingPublishInsert = db.prepare(`
    INSERT INTO pending_publishes (id, provider_id, raw_spec, publish_input,
                                   exception_request_id, created_at)
    VALUES (@id, @provider_id, @raw_spec, @publish_input, @exception_request_id, @created_at)
  `);
  const pendingPublishFind = db.prepare('SELECT * FROM pending_publishes WHERE id = ?');
  const pendingPublishDelete = db.prepare('DELETE FROM pending_publishes WHERE id = ?');
  const exceptionInsert = db.prepare(`
    INSERT INTO policy_exception_requests (id, api_asset_id, provider_id, pending_publish_id,
                                           violations, justification, status, reviewed_by,
                                           reviewed_at, reviewer_notes, expires_at, created_at)
    VALUES (@id, @api_asset_id, @provider_id, @pending_publish_id, @violations,
            @justification, @status, @reviewed_by, @reviewed_at, @reviewer_notes,
            @expires_at, @created_at)
  `);
  const exceptionFind = db.prepare('SELECT * FROM policy_exception_requests WHERE id = ?');
  const exceptionListPending = db.prepare(
    "SELECT * FROM policy_exception_requests WHERE status = 'pending' ORDER BY created_at ASC",
  );
  const exceptionListForProvider = db.prepare(
    'SELECT * FROM policy_exception_requests WHERE provider_id = ? ORDER BY created_at DESC',
  );
  const exceptionListForAsset = db.prepare(
    'SELECT * FROM policy_exception_requests WHERE api_asset_id = ? ORDER BY created_at DESC',
  );

  // ---------- ACCESS REQUESTS ----------
  const reqInsert = db.prepare(`
    INSERT INTO access_requests (id, api_asset_id, client_user_id, client_consumer_id,
                                 justification, status, provider_reason, reviewed_by,
                                 created_at, reviewed_at)
    VALUES (@id, @api_asset_id, @client_user_id, @client_consumer_id, @justification,
            @status, @provider_reason, @reviewed_by, @created_at, @reviewed_at)
  `);
  const reqFindById = db.prepare('SELECT * FROM access_requests WHERE id = ?');
  const reqFindOpen = db.prepare(`
    SELECT * FROM access_requests
    WHERE client_user_id = ? AND api_asset_id = ? AND status = 'pending'
  `);
  const reqListForClient = db.prepare(
    'SELECT * FROM access_requests WHERE client_user_id = ? ORDER BY created_at DESC',
  );
  const reqListForProvider = db.prepare(`
    SELECT ar.* FROM access_requests ar
    JOIN api_assets a ON a.id = ar.api_asset_id
    WHERE a.provider_id = @providerId
      AND (@status IS NULL OR ar.status = @status)
    ORDER BY ar.created_at DESC
  `);
  const reqListForAsset = db.prepare(
    'SELECT * FROM access_requests WHERE api_asset_id = ? ORDER BY created_at DESC',
  );

  // ---------- GRANTS ----------
  const grantInsert = db.prepare(`
    INSERT INTO access_grants (id, api_asset_id, client_user_id, client_consumer_id, acl_group,
                               status, approved_by, approved_at, revoked_by, revoked_at,
                               revoked_reason)
    VALUES (@id, @api_asset_id, @client_user_id, @client_consumer_id, @acl_group, @status,
            @approved_by, @approved_at, @revoked_by, @revoked_at, @revoked_reason)
  `);
  const grantFindById = db.prepare('SELECT * FROM access_grants WHERE id = ?');
  const grantFindActive = db.prepare(`
    SELECT * FROM access_grants
    WHERE client_consumer_id = ? AND api_asset_id = ? AND status = 'active'
  `);
  const grantListForClient = db.prepare(
    'SELECT * FROM access_grants WHERE client_user_id = ? ORDER BY approved_at DESC',
  );
  const grantListForAsset = db.prepare(
    'SELECT * FROM access_grants WHERE api_asset_id = ? ORDER BY approved_at DESC',
  );

  // ---------- CONVERSATIONS / MESSAGES ----------
  const convInsert = db.prepare(`
    INSERT INTO conversations (id, api_asset_id, request_id, grant_id, type, subject,
                               participants, created_at)
    VALUES (@id, @api_asset_id, @request_id, @grant_id, @type, @subject, @participants,
            @created_at)
  `);
  const convFind = db.prepare('SELECT * FROM conversations WHERE id = ?');
  const convListForUser = db.prepare(`
    SELECT * FROM conversations
    WHERE instr(participants, ?) > 0
    ORDER BY created_at DESC
  `);
  const convUpdateParticipants = db.prepare(
    'UPDATE conversations SET participants = ? WHERE id = ?',
  );
  const msgInsert = db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_id, body, created_at, read_by)
    VALUES (@id, @conversation_id, @sender_id, @body, @created_at, @read_by)
  `);
  const msgList = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
  );

  // ---------- NOTIFICATIONS ----------
  const notifInsert = db.prepare(`
    INSERT INTO notifications (id, recipient_id, type, payload, read_at, created_at)
    VALUES (@id, @recipient_id, @type, @payload, @read_at, @created_at)
  `);
  const notifList = db.prepare(`
    SELECT * FROM notifications WHERE recipient_id = ? ORDER BY created_at DESC LIMIT ?
  `);
  const notifMarkRead = db.prepare(
    'UPDATE notifications SET read_at = ? WHERE id = ? AND recipient_id = ?',
  );
  const notifUnread = db.prepare(
    'SELECT COUNT(*) as c FROM notifications WHERE recipient_id = ? AND read_at IS NULL',
  );

  // ---------- EMAIL ----------
  // OR IGNORE makes idempotent inserts a no-op when `idempotency_key` collides
  // with an existing row (the partial unique index enforces this only when
  // the key is non-null, so plain enqueues are unaffected).
  const outboxInsert = db.prepare(`
    INSERT OR IGNORE INTO email_outbox (id, to_address, subject, template_id, payload, status,
                              attempts, last_error, scheduled_at, sent_at, created_at,
                              idempotency_key, headers)
    VALUES (@id, @to_address, @subject, @template_id, @payload, @status, @attempts,
            @last_error, @scheduled_at, @sent_at, @created_at, @idempotency_key, @headers)
  `);
  const outboxFindCandidates = db.prepare(`
    SELECT id FROM email_outbox
    WHERE status = 'pending' AND scheduled_at <= ?
    ORDER BY scheduled_at ASC LIMIT ?
  `);
  const outboxClaim = db.prepare(`
    UPDATE email_outbox SET status = 'sending'
    WHERE id = ? AND status = 'pending'
  `);
  const outboxGet = db.prepare('SELECT * FROM email_outbox WHERE id = ?');
  const outboxMarkSent = db.prepare(
    "UPDATE email_outbox SET status = 'sent', sent_at = ? WHERE id = ?",
  );
  const outboxMarkFailed = db.prepare(`
    UPDATE email_outbox SET attempts = @attempts, last_error = @last_error,
           status = CASE WHEN @attempts >= 5 THEN 'failed' ELSE 'pending' END,
           scheduled_at = @scheduled_at
    WHERE id = @id
  `);
  const tmplGet = db.prepare('SELECT * FROM email_templates WHERE key = ?');
  const tmplUpsert = db.prepare(`
    INSERT INTO email_templates (key, subject_template, body_template, enabled, updated_at)
    VALUES (@key, @subject_template, @body_template, @enabled, @updated_at)
    ON CONFLICT (key) DO UPDATE SET
      subject_template = excluded.subject_template,
      body_template = excluded.body_template,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `);
  const tmplList = db.prepare('SELECT * FROM email_templates ORDER BY key ASC');

  // ---------- SETTINGS ----------
  const setGet = db.prepare('SELECT * FROM app_settings WHERE key = ?');
  const setUpsert = db.prepare(`
    INSERT INTO app_settings (key, value, encrypted, updated_at)
    VALUES (@key, @value, @encrypted, @updated_at)
    ON CONFLICT (key) DO UPDATE SET
      value = excluded.value,
      encrypted = excluded.encrypted,
      updated_at = excluded.updated_at
  `);
  const setInsertIfAbsent = db.prepare(`
    INSERT OR IGNORE INTO app_settings (key, value, encrypted, updated_at)
    VALUES (@key, @value, @encrypted, @updated_at)
  `);
  const setAll = db.prepare('SELECT * FROM app_settings ORDER BY key ASC');

  // ---------- AUDIT ----------
  const auditInsert = db.prepare(`
    INSERT INTO audit_logs (id, actor_id, actor_email, action, target_type, target_id,
                            reason, before, after, ip, user_agent, created_at)
    VALUES (@id, @actor_id, @actor_email, @action, @target_type, @target_id, @reason,
            @before, @after, @ip, @user_agent, @created_at)
  `);
  const auditList = db.prepare(`
    SELECT * FROM audit_logs
    WHERE (@action IS NULL OR action = @action)
      AND (@actorId IS NULL OR actor_id = @actorId)
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `);
  const auditListCount = db.prepare(`
    SELECT COUNT(*) as c FROM audit_logs
    WHERE (@action IS NULL OR action = @action)
      AND (@actorId IS NULL OR actor_id = @actorId)
  `);

  // ---------- MASS EMAIL ----------
  const campaignInsert = db.prepare(`
    INSERT INTO mass_email_campaigns (id, created_by, recipient_filter, subject, body,
                                       status, sent_count, failed_count, created_at,
                                       completed_at)
    VALUES (@id, @created_by, @recipient_filter, @subject, @body, @status, @sent_count,
            @failed_count, @created_at, @completed_at)
  `);
  const campaignList = db.prepare('SELECT * FROM mass_email_campaigns ORDER BY created_at DESC');
  const campaignFindById = db.prepare('SELECT * FROM mass_email_campaigns WHERE id = ?');

  return {
    users: {
      async insert(row) {
        const now = new Date().toISOString();
        const full: UserRow = { ...row, created_at: now, updated_at: now };
        usersInsert.run(full);
        return full;
      },
      async findById(id) {
        return (usersFindById.get(id) as UserRow | undefined) ?? null;
      },
      async findByEmail(emailNormalized) {
        return (usersFindByEmail.get(emailNormalized) as UserRow | undefined) ?? null;
      },
      async updateContact(id, fields) {
        usersUpdateContact.run({
          id,
          name: fields.name ?? null,
          phone: fields.phone ?? null,
          updated_at: new Date().toISOString(),
        });
        const row = usersFindById.get(id) as UserRow;
        return row;
      },
      async updatePassword(id, hash) {
        usersUpdatePassword.run(hash, new Date().toISOString(), id);
      },
      async updateStatus(id, status) {
        usersUpdateStatus.run(status, new Date().toISOString(), id);
      },
      async markEmailVerified(id, at) {
        usersMarkVerified.run(at, new Date().toISOString(), id);
      },
      async recordLogin(id, at) {
        usersRecordLogin.run(at, new Date().toISOString(), id);
      },
      async recordFailedLogin(id) {
        const row = usersIncFailed.get(new Date().toISOString(), id) as
          | { failed_login_count: number }
          | undefined;
        return row?.failed_login_count ?? 0;
      },
      async resetFailedLogins(id) {
        usersResetFailed.run(new Date().toISOString(), id);
      },
      async list(opts: ListOptions) {
        const limit = opts.limit ?? 25;
        const offset = opts.offset ?? 0;
        const search = opts.search ? `%${opts.search}%` : null;
        const rows = usersList.all({ search, limit, offset }) as UserRow[];
        const { c } = usersListCount.get({ search }) as { c: number };
        return { rows, total: c };
      },
      async listFiltered(opts) {
        const limit = opts.limit ?? 25;
        const offset = opts.offset ?? 0;
        const role = opts.role ?? null;
        const status = opts.status ?? null;
        const rows = usersListFiltered.all({
          role,
          status,
          limit,
          offset,
        }) as UserRow[];
        const { c } = usersListFilteredCount.get({ role, status }) as { c: number };
        return { rows, total: c };
      },
      async count() {
        return (usersCount.get() as { c: number }).c;
      },
    },
    userRoles: {
      async add(userId, role) {
        rolesAdd.run(userId, role, new Date().toISOString());
      },
      async remove(userId, role) {
        rolesRemove.run(userId, role);
      },
      async forUser(userId) {
        return (rolesForUser.all(userId) as { role: UserRole }[]).map((r) => r.role);
      },
      async setRoles(userId: string, roles: UserRole[]) {
        rolesClearForUser.run(userId);
        const now = new Date().toISOString();
        for (const role of roles) rolesAdd.run(userId, role, now);
      },
    },
    sessions: {
      async create(row) {
        sessionsInsert.run(row);
      },
      async find(id) {
        return (sessionsFind.get(id) as SessionRow | undefined) ?? null;
      },
      async delete(id) {
        sessionsDelete.run(id);
      },
      async deleteForUser(userId) {
        sessionsDeleteForUser.run(userId);
      },
      async cleanupExpired(now) {
        const info = sessionsCleanup.run(now);
        return Number(info.changes ?? 0);
      },
    },
    verifications: {
      async createEmailToken(row) {
        evInsert.run(row);
      },
      async findEmailToken(token) {
        return (evFind.get(token) as EmailVerificationRow | undefined) ?? null;
      },
      async consumeEmailToken(token, at) {
        evConsume.run(at, token);
      },
      async createPasswordReset(row) {
        prInsert.run(row);
      },
      async findPasswordReset(token) {
        return (prFind.get(token) as PasswordResetRow | undefined) ?? null;
      },
      async consumePasswordReset(token, at) {
        prConsume.run(at, token);
      },
      async countRecentPasswordResets(userId, since) {
        return (prCountRecent.get(userId, since) as { c: number }).c;
      },
    },
    organizations: {
      async insert(row) {
        orgInsert.run(row);
        return row;
      },
      async findById(id) {
        return (orgFind.get(id) as OrganizationRow | undefined) ?? null;
      },
      async list() {
        return orgList.all() as OrganizationRow[];
      },
      async addMember(row) {
        orgAddMember.run(row);
      },
      async membersOf(orgId) {
        return orgMembers.all(orgId) as OrganizationMemberRow[];
      },
    },
    consumers: {
      async insert(row) {
        consInsert.run({ ...row, acl_groups: J(row.acl_groups) });
        return row;
      },
      async findById(id) {
        const raw = consFindById.get(id) as ConsumerRowRaw | undefined;
        return raw ? hydrateConsumer(raw) : null;
      },
      async findByUserNamespace(userId, namespace) {
        const raw = consFindByUserNs.get(userId, namespace) as ConsumerRowRaw | undefined;
        return raw ? hydrateConsumer(raw) : null;
      },
      async updateAclGroups(id, groups) {
        consUpdateAcl.run(J(groups), id);
      },
      async updateStatus(id, status) {
        consUpdateStatus.run(status, id);
      },
      async listForUser(userId) {
        return (consListForUser.all(userId) as ConsumerRowRaw[]).map(hydrateConsumer);
      },
    },
    credentials: {
      async insert(row) {
        credInsert.run(row);
        return row;
      },
      async findById(id) {
        return (credFindById.get(id) as CredentialMetadataRow | undefined) ?? null;
      },
      async listForConsumer(consumerId) {
        return credListForConsumer.all(consumerId) as CredentialMetadataRow[];
      },
      async updateStatus(id, status) {
        credUpdateStatus.run(status, id);
      },
      async delete(id) {
        credDelete.run(id);
      },
    },
    apiAssets: {
      async insert(row) {
        assetInsert.run({
          ...row,
          tags: J(row.tags),
          proxy_hosts: J(row.proxy_hosts),
          proxy_paths: J(row.proxy_paths),
          operation_paths: J(row.operation_paths),
          operation_summaries: J(row.operation_summaries),
        });
        return row;
      },
      async update(id, fields) {
        const existing = assetFindById.get(id) as AssetRowRaw | undefined;
        if (!existing) throw new Error(`Asset not found: ${id}`);
        const next: AssetRowRaw = {
          ...existing,
          ...Object.fromEntries(
            Object.entries(fields).map(([k, v]) =>
              ['tags', 'proxy_hosts', 'proxy_paths', 'operation_paths', 'operation_summaries'].includes(k)
                ? [k, J(v)]
                : [k, v as unknown],
            ),
          ),
          updated_at: new Date().toISOString(),
        } as AssetRowRaw;
        db.prepare(`
          UPDATE api_assets SET
            title = @title, description = @description, version = @version,
            visibility = @visibility, requestable = @requestable, lifecycle = @lifecycle,
            tags = @tags, contact_name = @contact_name, contact_email = @contact_email,
            contact_url = @contact_url, support_notes = @support_notes,
            operation_count = @operation_count, content_hash = @content_hash,
            api_spec_id = @api_spec_id, proxy_id = @proxy_id, namespace = @namespace,
            proxy_hosts = @proxy_hosts, proxy_paths = @proxy_paths,
            proxy_upstream_url = @proxy_upstream_url, timeout_connect_ms = @timeout_connect_ms,
            timeout_read_ms = @timeout_read_ms, timeout_write_ms = @timeout_write_ms,
            body_size_limit_bytes = @body_size_limit_bytes,
            rate_limit_per_minute = @rate_limit_per_minute, operation_paths = @operation_paths,
            operation_summaries = @operation_summaries, source_format = @source_format,
            policy_exception_id = @policy_exception_id,
            updated_at = @updated_at
          WHERE id = @id
        `).run(next);
        return hydrateAsset(assetFindById.get(id) as AssetRowRaw);
      },
      async findById(id) {
        const raw = assetFindById.get(id) as AssetRowRaw | undefined;
        return raw ? hydrateAsset(raw) : null;
      },
      async findBySpecId(specId) {
        const raw = assetFindBySpec.get(specId) as AssetRowRaw | undefined;
        return raw ? hydrateAsset(raw) : null;
      },
      async findBySlug(slug) {
        const raw = assetFindBySlug.get(slug) as AssetRowRaw | undefined;
        return raw ? hydrateAsset(raw) : null;
      },
      async delete(id) {
        assetDelete.run(id);
      },
      async list(opts) {
        const limit = opts.limit ?? 25;
        const offset = opts.offset ?? 0;
        const search = opts.search ? `%${opts.search}%` : null;
        const visibility = (opts.visibility as ApiVisibility | undefined) ?? null;
        const providerId = opts.providerId ?? null;
        const rows = assetList.all({ search, visibility, providerId, limit, offset }) as AssetRowRaw[];
        const { c } = assetListCount.get({ search, visibility, providerId }) as { c: number };
        return { rows: rows.map(hydrateAsset), total: c };
      },
    },
    apiSpecVersions: {
      async insert(row: ApiSpecVersionRow) {
        specVerInsert.run(row);
        return row;
      },
      async listForAsset(assetId) {
        return specVerListForAsset.all(assetId) as ApiSpecVersionRow[];
      },
      async latestForAsset(assetId) {
        return (specVerLatest.get(assetId) as ApiSpecVersionRow | undefined) ?? null;
      },
      async get(id) {
        return (specVerGet.get(id) as ApiSpecVersionRow | undefined) ?? null;
      },
    },
    policyExceptions: {
      async insert(row) {
        exceptionInsert.run({ ...row, violations: J(row.violations) });
        return row;
      },
      async update(id, fields) {
        const existing = exceptionFind.get(id) as PolicyExceptionRaw | undefined;
        if (!existing) throw new Error(`Policy exception not found: ${id}`);
        const next: PolicyExceptionRaw = {
          ...existing,
          ...Object.fromEntries(
            Object.entries(fields).map(([key, value]) =>
              key === 'violations' ? [key, J(value)] : [key, value as unknown],
            ),
          ),
        } as PolicyExceptionRaw;
        db.prepare(`
          UPDATE policy_exception_requests SET
            api_asset_id = @api_asset_id, provider_id = @provider_id,
            pending_publish_id = @pending_publish_id, violations = @violations,
            justification = @justification, status = @status, reviewed_by = @reviewed_by,
            reviewed_at = @reviewed_at, reviewer_notes = @reviewer_notes,
            expires_at = @expires_at
          WHERE id = @id
        `).run(next);
        return hydratePolicyException(exceptionFind.get(id) as PolicyExceptionRaw);
      },
      async findById(id) {
        const row = exceptionFind.get(id) as PolicyExceptionRaw | undefined;
        return row ? hydratePolicyException(row) : null;
      },
      async listPending() {
        return (exceptionListPending.all() as PolicyExceptionRaw[]).map(hydratePolicyException);
      },
      async listForProvider(providerId) {
        return (exceptionListForProvider.all(providerId) as PolicyExceptionRaw[]).map(
          hydratePolicyException,
        );
      },
      async listForAsset(apiAssetId) {
        return (exceptionListForAsset.all(apiAssetId) as PolicyExceptionRaw[]).map(
          hydratePolicyException,
        );
      },
    },
    pendingPublishes: {
      async insert(row) {
        pendingPublishInsert.run({ ...row, publish_input: J(row.publish_input) });
        return row;
      },
      async update(id, fields) {
        const existing = pendingPublishFind.get(id) as PendingPublishRaw | undefined;
        if (!existing) throw new Error(`Pending publish not found: ${id}`);
        const next: PendingPublishRaw = {
          ...existing,
          ...Object.fromEntries(
            Object.entries(fields).map(([key, value]) =>
              key === 'publish_input' ? [key, J(value)] : [key, value as unknown],
            ),
          ),
        } as PendingPublishRaw;
        db.prepare(`
          UPDATE pending_publishes SET provider_id = @provider_id, raw_spec = @raw_spec,
            publish_input = @publish_input, exception_request_id = @exception_request_id
          WHERE id = @id
        `).run(next);
        return hydratePendingPublish(pendingPublishFind.get(id) as PendingPublishRaw);
      },
      async findById(id) {
        const row = pendingPublishFind.get(id) as PendingPublishRaw | undefined;
        return row ? hydratePendingPublish(row) : null;
      },
      async delete(id) {
        pendingPublishDelete.run(id);
      },
    },
    accessRequests: {
      async insert(row) {
        reqInsert.run(row);
        return row;
      },
      async update(id, fields) {
        const existing = reqFindById.get(id) as AccessRequestRow | undefined;
        if (!existing) throw new Error(`Request not found: ${id}`);
        const next: AccessRequestRow = { ...existing, ...fields };
        db.prepare(`
          UPDATE access_requests SET
            status = @status, provider_reason = @provider_reason, reviewed_by = @reviewed_by,
            reviewed_at = @reviewed_at, client_consumer_id = @client_consumer_id,
            justification = @justification
          WHERE id = @id
        `).run(next);
        return next;
      },
      async findById(id) {
        return (reqFindById.get(id) as AccessRequestRow | undefined) ?? null;
      },
      async findOpenFor(clientUserId, apiAssetId) {
        return (reqFindOpen.get(clientUserId, apiAssetId) as AccessRequestRow | undefined) ?? null;
      },
      async listForClient(clientUserId) {
        return reqListForClient.all(clientUserId) as AccessRequestRow[];
      },
      async listForProvider(providerId, status?: AccessRequestStatus) {
        return reqListForProvider.all({ providerId, status: status ?? null }) as AccessRequestRow[];
      },
      async listForAsset(apiAssetId) {
        return reqListForAsset.all(apiAssetId) as AccessRequestRow[];
      },
    },
    grants: {
      async insert(row) {
        grantInsert.run(row);
        return row;
      },
      async update(id, fields) {
        const existing = grantFindById.get(id) as AccessGrantRow | undefined;
        if (!existing) throw new Error(`Grant not found: ${id}`);
        const next = { ...existing, ...fields };
        db.prepare(`
          UPDATE access_grants SET
            status = @status, revoked_by = @revoked_by, revoked_at = @revoked_at,
            revoked_reason = @revoked_reason
          WHERE id = @id
        `).run(next);
        return next;
      },
      async findById(id) {
        return (grantFindById.get(id) as AccessGrantRow | undefined) ?? null;
      },
      async findActiveFor(consumerId, apiAssetId) {
        return (grantFindActive.get(consumerId, apiAssetId) as AccessGrantRow | undefined) ?? null;
      },
      async listForClient(clientUserId) {
        return grantListForClient.all(clientUserId) as AccessGrantRow[];
      },
      async listForAsset(apiAssetId) {
        return grantListForAsset.all(apiAssetId) as AccessGrantRow[];
      },
    },
    conversations: {
      async insert(row) {
        convInsert.run({ ...row, participants: J(row.participants) });
        return row;
      },
      async findById(id) {
        const raw = convFind.get(id) as ConversationRowRaw | undefined;
        return raw ? hydrateConversation(raw) : null;
      },
      async listForUser(userId) {
        return (convListForUser.all(`"${userId}"`) as ConversationRowRaw[]).map(
          hydrateConversation,
        );
      },
      async updateParticipants(id, participants) {
        convUpdateParticipants.run(J(participants), id);
      },
    },
    messages: {
      async insert(row) {
        msgInsert.run({ ...row, read_by: J(row.read_by) });
        return row;
      },
      async listForConversation(conversationId) {
        return (msgList.all(conversationId) as MessageRowRaw[]).map(hydrateMessage);
      },
      async markRead(conversationId, userId, _at) {
        const rows = msgList.all(conversationId) as MessageRowRaw[];
        const upd = db.prepare('UPDATE messages SET read_by = ? WHERE id = ?');
        for (const r of rows) {
          const readBy = P<string[]>(r.read_by, []);
          if (r.sender_id !== userId && !readBy.includes(userId)) {
            upd.run(J([...readBy, userId]), r.id);
          }
        }
      },
    },
    notifications: {
      async insert(row) {
        notifInsert.run({ ...row, payload: J(row.payload) });
        return row;
      },
      async listForUser(userId, limit) {
        return (notifList.all(userId, limit) as NotificationRowRaw[]).map(hydrateNotification);
      },
      async markRead(id, userId, at) {
        return notifMarkRead.run(at, id, userId).changes;
      },
      async unreadCount(userId) {
        return (notifUnread.get(userId) as { c: number }).c;
      },
    },
    email: {
      async enqueue(row) {
        outboxInsert.run({
          ...row,
          payload: J(row.payload),
          headers: row.headers == null ? null : J(row.headers),
          idempotency_key: row.idempotency_key,
        });
      },
      async claimBatch(now, batchSize) {
        // Atomically transition each candidate from `pending` to `sending`.
        // better-sqlite3 statements are serialized per-connection, so the
        // conditional UPDATE+SELECT cannot interleave with another worker.
        const candidates = outboxFindCandidates.all(now, batchSize) as { id: string }[];
        const claimed: OutboxRowRaw[] = [];
        for (const { id } of candidates) {
          const result = outboxClaim.run(id);
          if (Number(result.changes ?? 0) === 0) continue;
          const row = outboxGet.get(id) as OutboxRowRaw | undefined;
          if (row) claimed.push(row);
        }
        return claimed.map(hydrateOutbox);
      },
      async markSent(id, at) {
        outboxMarkSent.run(at, id);
      },
      async markFailed(id, attempts, error) {
        const backoffMs = Math.min(60_000 * attempts, 30 * 60_000);
        outboxMarkFailed.run({
          id,
          attempts,
          last_error: error,
          scheduled_at: new Date(Date.now() + backoffMs).toISOString(),
        });
      },
      async listFailed(opts) {
        const limit = opts.limit ?? 50;
        const offset = opts.offset ?? 0;
        const rows = db
          .prepare(
            "SELECT * FROM email_outbox WHERE status = 'failed' ORDER BY created_at DESC LIMIT ? OFFSET ?",
          )
          .all(limit, offset) as OutboxRowRaw[];
        const total = (
          db.prepare("SELECT COUNT(*) as c FROM email_outbox WHERE status = 'failed'").get() as {
            c: number;
          }
        ).c;
        return { rows: rows.map(hydrateOutbox), total };
      },
      async requeue(id) {
        // Only `failed` rows are eligible — re-queueing an already-pending row
        // would clobber its attempt counter.
        const info = db
          .prepare(
            "UPDATE email_outbox SET status = 'pending', attempts = 0, last_error = NULL, scheduled_at = ? WHERE id = ? AND status = 'failed'",
          )
          .run(new Date().toISOString(), id);
        return Number(info.changes ?? 0) > 0;
      },
      async getTemplate(key) {
        return (tmplGet.get(key) as EmailTemplateRow | undefined) ?? null;
      },
      async upsertTemplate(row) {
        tmplUpsert.run(row);
      },
      async listTemplates() {
        return tmplList.all() as EmailTemplateRow[];
      },
    },
    settings: {
      async get<T>(key: string): Promise<T | null> {
        const row = setGet.get(key) as SettingRowRaw | undefined;
        if (!row) return null;
        return JSON.parse(row.value) as T;
      },
      async set<T>(key: string, value: T, encrypted = false) {
        setUpsert.run({
          key,
          value: JSON.stringify(value),
          encrypted: encrypted ? 1 : 0,
          updated_at: new Date().toISOString(),
        });
      },
      async setIfAbsent<T>(key: string, value: T, encrypted = false) {
        const result = setInsertIfAbsent.run({
          key,
          value: JSON.stringify(value),
          encrypted: encrypted ? 1 : 0,
          updated_at: new Date().toISOString(),
        });
        return result.changes === 1;
      },
      async all() {
        return (setAll.all() as SettingRowRaw[]).map((row) => ({
          ...row,
          value: JSON.parse(row.value),
        }));
      },
    },
    audit: {
      async insert(row) {
        auditInsert.run({
          ...row,
          before: row.before == null ? null : JSON.stringify(row.before),
          after: row.after == null ? null : JSON.stringify(row.after),
        });
      },
      async list(opts) {
        const limit = opts.limit ?? 50;
        const offset = opts.offset ?? 0;
        const action = opts.action ?? null;
        const actorId = opts.actorId ?? null;
        const rows = auditList.all({ limit, offset, action, actorId }) as AuditRowRaw[];
        const { c } = auditListCount.get({ action, actorId }) as { c: number };
        return { rows: rows.map(hydrateAudit), total: c };
      },
    },
    massEmail: {
      async insert(row) {
        campaignInsert.run({ ...row, recipient_filter: J(row.recipient_filter) });
        return row;
      },
      async update(id, fields) {
        const existing = campaignFindById.get(id) as CampaignRowRaw | undefined;
        if (!existing) throw new Error(`Campaign not found: ${id}`);
        const next = {
          ...existing,
          ...Object.fromEntries(
            Object.entries(fields).map(([k, v]) =>
              k === 'recipient_filter' ? [k, J(v)] : [k, v],
            ),
          ),
        } as CampaignRowRaw;
        db.prepare(`
          UPDATE mass_email_campaigns SET
            status = @status, sent_count = @sent_count, failed_count = @failed_count,
            completed_at = @completed_at
          WHERE id = @id
        `).run(next);
        return hydrateCampaign(next);
      },
      async list() {
        return (campaignList.all() as CampaignRowRaw[]).map(hydrateCampaign);
      },
      async findById(id) {
        const raw = campaignFindById.get(id) as CampaignRowRaw | undefined;
        return raw ? hydrateCampaign(raw) : null;
      },
    },
  };
}
