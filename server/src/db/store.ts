/**
 * Persistence interface for Ferrum Nexus.
 *
 * Every adapter (SQLite, PostgreSQL, MySQL, MongoDB) implements `NexusStore`.
 * Service modules talk to this interface and never reach into the driver.
 *
 * Identifiers are string UUIDs across all backends so the same logical schema
 * works regardless of database. Timestamps are ISO-8601 strings.
 */

import type {
  AccessRequestStatus,
  ApiLifecycleStatus,
  ApiVisibility,
  ConversationType,
  CredentialType,
  GrantStatus,
  NotificationType,
  UserRole,
  UserStatus,
} from '@ferrum-nexus/shared';

// ---------- Row types ----------

export interface UserRow {
  id: string;
  email: string;
  email_normalized: string;
  name: string | null;
  phone: string | null;
  status: UserStatus;
  email_verified_at: string | null;
  password_hash: string;
  last_login_at: string | null;
  failed_login_count: number;
  organization_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRoleRow {
  user_id: string;
  role: UserRole;
  created_at: string;
}

export interface OrganizationRow {
  id: string;
  name: string;
  domain: string | null;
  status: UserStatus;
  created_at: string;
}

export interface OrganizationMemberRow {
  organization_id: string;
  user_id: string;
  role: 'member' | 'owner';
  created_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  csrf_token: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  expires_at: string;
}

export interface EmailVerificationRow {
  token: string;
  user_id: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface PasswordResetRow {
  token: string;
  user_id: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface FerrumConsumerRow {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  namespace: string;
  ferrum_consumer_id: string;
  username: string;
  status: 'active' | 'denied' | 'archived';
  acl_groups: string[];
  created_at: string;
}

export interface CredentialMetadataRow {
  id: string;
  consumer_id: string;
  type: CredentialType;
  label: string;
  fingerprint: string;
  last4: string | null;
  ferrum_credential_index: number;
  status: 'active' | 'pending_removal' | 'expired';
  created_at: string;
  rotated_at: string | null;
  expires_at: string | null;
}

export interface ApiAssetRow {
  id: string;
  api_spec_id: string;
  proxy_id: string;
  namespace: string;
  provider_id: string;
  title: string;
  description: string | null;
  slug: string;
  version: string;
  visibility: ApiVisibility;
  requestable: number;
  lifecycle: ApiLifecycleStatus;
  tags: string[];
  contact_email: string | null;
  support_notes: string | null;
  operation_count: number;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiSpecVersionRow {
  id: string;
  api_asset_id: string;
  version: string;
  content_hash: string;
  submitted_by: string;
  raw_spec: string;
  created_at: string;
}

export interface AccessRequestRow {
  id: string;
  api_asset_id: string;
  client_user_id: string;
  client_consumer_id: string | null;
  justification: string;
  status: AccessRequestStatus;
  provider_reason: string | null;
  reviewed_by: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface AccessGrantRow {
  id: string;
  api_asset_id: string;
  client_user_id: string;
  client_consumer_id: string;
  acl_group: string;
  status: GrantStatus;
  approved_by: string;
  approved_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface ConversationRow {
  id: string;
  api_asset_id: string | null;
  request_id: string | null;
  grant_id: string | null;
  type: ConversationType;
  subject: string;
  created_at: string;
  participants: string[];
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  read_by: string[];
}

export interface NotificationRow {
  id: string;
  recipient_id: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface EmailOutboxRow {
  id: string;
  to_address: string;
  subject: string;
  template_id: string | null;
  payload: Record<string, unknown>;
  /**
   * `pending` rows are eligible to be claimed by the worker. The worker
   * atomically transitions a row to `sending` before delivering it; on
   * success it becomes `sent`, on failure it goes back to `pending` (with
   * backoff) or terminates at `failed`. The transient `sending` state
   * prevents concurrent workers from double-claiming the same row.
   */
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  last_error: string | null;
  scheduled_at: string;
  sent_at: string | null;
  created_at: string;
  /**
   * Optional caller-supplied dedup key. If a row with the same key already
   * exists the second enqueue is a no-op. Used by mass-email to make
   * campaign sends idempotent across worker retries.
   */
  idempotency_key: string | null;
  /**
   * Extra SMTP headers to set on the outgoing message (e.g.
   * `List-Unsubscribe`). Stored as a JSON object; null when no extras.
   */
  headers: Record<string, string> | null;
}

export interface EmailTemplateRow {
  key: string;
  subject_template: string;
  body_template: string;
  enabled: number;
  updated_at: string;
}

export interface AppSettingRow {
  key: string;
  value: unknown;
  encrypted: number;
  updated_at: string;
}

export interface AuditLogRow {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface MassEmailCampaignRow {
  id: string;
  created_by: string;
  recipient_filter: Record<string, unknown>;
  subject: string;
  body: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  sent_count: number;
  failed_count: number;
  created_at: string;
  completed_at: string | null;
}

// ---------- Query helpers ----------

export interface ListOptions {
  limit?: number;
  offset?: number;
  search?: string;
}

// ---------- Repositories ----------

export interface UsersRepo {
  insert(row: Omit<UserRow, 'created_at' | 'updated_at'>): Promise<UserRow>;
  findById(id: string): Promise<UserRow | null>;
  findByEmail(emailNormalized: string): Promise<UserRow | null>;
  updateContact(id: string, fields: Partial<Pick<UserRow, 'name' | 'phone'>>): Promise<UserRow>;
  updatePassword(id: string, passwordHash: string): Promise<void>;
  updateStatus(id: string, status: UserStatus): Promise<void>;
  markEmailVerified(id: string, at: string): Promise<void>;
  recordLogin(id: string, at: string): Promise<void>;
  recordFailedLogin(id: string): Promise<number>;
  resetFailedLogins(id: string): Promise<void>;
  list(opts: ListOptions): Promise<{ rows: UserRow[]; total: number }>;
  /**
   * Paginated lookup with optional role and status filters. Used by mass-
   * email and admin filtering so large user tables don't need to be loaded
   * into memory just to filter in JS.
   */
  listFiltered(opts: ListOptions & {
    role?: UserRole;
    status?: UserStatus;
  }): Promise<{ rows: UserRow[]; total: number }>;
  count(): Promise<number>;
}

export interface UserRolesRepo {
  add(userId: string, role: UserRole): Promise<void>;
  remove(userId: string, role: UserRole): Promise<void>;
  forUser(userId: string): Promise<UserRole[]>;
  setRoles(userId: string, roles: UserRole[]): Promise<void>;
}

export interface SessionsRepo {
  create(row: SessionRow): Promise<void>;
  find(id: string): Promise<SessionRow | null>;
  delete(id: string): Promise<void>;
  deleteForUser(userId: string): Promise<void>;
  cleanupExpired(now: string): Promise<number>;
}

export interface VerificationsRepo {
  createEmailToken(row: EmailVerificationRow): Promise<void>;
  findEmailToken(token: string): Promise<EmailVerificationRow | null>;
  consumeEmailToken(token: string, at: string): Promise<void>;
  createPasswordReset(row: PasswordResetRow): Promise<void>;
  findPasswordReset(token: string): Promise<PasswordResetRow | null>;
  consumePasswordReset(token: string, at: string): Promise<void>;
  /** Count password reset rows issued for `userId` since `since` (ISO timestamp). */
  countRecentPasswordResets(userId: string, since: string): Promise<number>;
}

export interface ConsumersRepo {
  insert(row: FerrumConsumerRow): Promise<FerrumConsumerRow>;
  findById(id: string): Promise<FerrumConsumerRow | null>;
  findByUserNamespace(userId: string, namespace: string): Promise<FerrumConsumerRow | null>;
  updateAclGroups(id: string, groups: string[]): Promise<void>;
  updateStatus(id: string, status: FerrumConsumerRow['status']): Promise<void>;
  listForUser(userId: string): Promise<FerrumConsumerRow[]>;
}

export interface CredentialsRepo {
  insert(row: CredentialMetadataRow): Promise<CredentialMetadataRow>;
  findById(id: string): Promise<CredentialMetadataRow | null>;
  listForConsumer(consumerId: string): Promise<CredentialMetadataRow[]>;
  updateStatus(id: string, status: CredentialMetadataRow['status']): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ApiAssetsRepo {
  insert(row: ApiAssetRow): Promise<ApiAssetRow>;
  update(id: string, fields: Partial<ApiAssetRow>): Promise<ApiAssetRow>;
  findById(id: string): Promise<ApiAssetRow | null>;
  findBySpecId(specId: string): Promise<ApiAssetRow | null>;
  findBySlug(slug: string): Promise<ApiAssetRow | null>;
  delete(id: string): Promise<void>;
  list(opts: ListOptions & { visibility?: ApiVisibility; providerId?: string }): Promise<{
    rows: ApiAssetRow[];
    total: number;
  }>;
}

export interface ApiSpecVersionsRepo {
  insert(row: ApiSpecVersionRow): Promise<ApiSpecVersionRow>;
  listForAsset(assetId: string): Promise<ApiSpecVersionRow[]>;
  latestForAsset(assetId: string): Promise<ApiSpecVersionRow | null>;
  get(id: string): Promise<ApiSpecVersionRow | null>;
}

export interface AccessRequestsRepo {
  insert(row: AccessRequestRow): Promise<AccessRequestRow>;
  update(id: string, fields: Partial<AccessRequestRow>): Promise<AccessRequestRow>;
  findById(id: string): Promise<AccessRequestRow | null>;
  findOpenFor(clientUserId: string, apiAssetId: string): Promise<AccessRequestRow | null>;
  listForClient(clientUserId: string): Promise<AccessRequestRow[]>;
  listForProvider(providerId: string, status?: AccessRequestStatus): Promise<AccessRequestRow[]>;
  listForAsset(apiAssetId: string): Promise<AccessRequestRow[]>;
}

export interface GrantsRepo {
  insert(row: AccessGrantRow): Promise<AccessGrantRow>;
  update(id: string, fields: Partial<AccessGrantRow>): Promise<AccessGrantRow>;
  findById(id: string): Promise<AccessGrantRow | null>;
  findActiveFor(consumerId: string, apiAssetId: string): Promise<AccessGrantRow | null>;
  listForClient(clientUserId: string): Promise<AccessGrantRow[]>;
  listForAsset(apiAssetId: string): Promise<AccessGrantRow[]>;
}

export interface ConversationsRepo {
  insert(row: ConversationRow): Promise<ConversationRow>;
  findById(id: string): Promise<ConversationRow | null>;
  listForUser(userId: string): Promise<ConversationRow[]>;
  updateParticipants(id: string, participants: string[]): Promise<void>;
}

export interface MessagesRepo {
  insert(row: MessageRow): Promise<MessageRow>;
  listForConversation(conversationId: string): Promise<MessageRow[]>;
  markRead(conversationId: string, userId: string, at: string): Promise<void>;
}

export interface NotificationsRepo {
  insert(row: NotificationRow): Promise<NotificationRow>;
  listForUser(userId: string, limit: number): Promise<NotificationRow[]>;
  markRead(id: string, userId: string, at: string): Promise<number>;
  unreadCount(userId: string): Promise<number>;
}

export interface EmailRepo {
  enqueue(row: EmailOutboxRow): Promise<void>;
  claimBatch(now: string, batchSize: number): Promise<EmailOutboxRow[]>;
  markSent(id: string, at: string): Promise<void>;
  markFailed(id: string, attempts: number, error: string): Promise<void>;
  /** Dead-letter view: messages that hit max attempts and won't be retried. */
  listFailed(opts: ListOptions): Promise<{ rows: EmailOutboxRow[]; total: number }>;
  /** Re-queue a failed message for delivery. Resets attempts to 0. */
  requeue(id: string): Promise<boolean>;
  getTemplate(key: string): Promise<EmailTemplateRow | null>;
  upsertTemplate(row: EmailTemplateRow): Promise<void>;
  listTemplates(): Promise<EmailTemplateRow[]>;
}

export interface SettingsRepo {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, encrypted?: boolean): Promise<void>;
  all(): Promise<AppSettingRow[]>;
}

export interface AuditRepo {
  insert(row: AuditLogRow): Promise<void>;
  list(opts: ListOptions & { action?: string; actorId?: string }): Promise<{
    rows: AuditLogRow[];
    total: number;
  }>;
}

export interface MassEmailRepo {
  insert(row: MassEmailCampaignRow): Promise<MassEmailCampaignRow>;
  update(id: string, fields: Partial<MassEmailCampaignRow>): Promise<MassEmailCampaignRow>;
  list(): Promise<MassEmailCampaignRow[]>;
  findById(id: string): Promise<MassEmailCampaignRow | null>;
}

export interface OrganizationsRepo {
  insert(row: OrganizationRow): Promise<OrganizationRow>;
  findById(id: string): Promise<OrganizationRow | null>;
  list(): Promise<OrganizationRow[]>;
  addMember(row: OrganizationMemberRow): Promise<void>;
  membersOf(orgId: string): Promise<OrganizationMemberRow[]>;
}

// ---------- Composite store ----------

export interface NexusStore {
  driver: 'sqlite' | 'postgres' | 'mysql' | 'mongodb';
  users: UsersRepo;
  userRoles: UserRolesRepo;
  sessions: SessionsRepo;
  verifications: VerificationsRepo;
  organizations: OrganizationsRepo;
  consumers: ConsumersRepo;
  credentials: CredentialsRepo;
  apiAssets: ApiAssetsRepo;
  apiSpecVersions: ApiSpecVersionsRepo;
  accessRequests: AccessRequestsRepo;
  grants: GrantsRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  notifications: NotificationsRepo;
  email: EmailRepo;
  settings: SettingsRepo;
  audit: AuditRepo;
  massEmail: MassEmailRepo;
  /**
   * Run a function within a transaction. With MongoDB this requires a replica
   * set; standalone MongoDB will execute callbacks without atomicity (a
   * warning is logged at startup).
   */
  transaction<T>(fn: (tx: NexusStore) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  migrate(): Promise<void>;
}
