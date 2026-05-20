/**
 * MongoDB adapter for Ferrum Nexus.
 *
 * The schema mirrors the SQL design: one collection per logical table, string
 * UUID `_id` values, and JSON arrays/objects stored natively. Multi-document
 * transactions require a replica set; with a standalone instance the callback
 * is executed without atomicity (a warning is logged at startup).
 */

import { MongoClient, type ClientSession, type Db, type Collection, type Filter } from 'mongodb';
import type { ResolvedConfig } from '../../../config/index.js';
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
  SessionRow,
  UserRoleRow,
  UserRow,
} from '../../store.js';
import type { AccessRequestStatus, UserRole } from '@ferrum-nexus/shared';

type WithId<T> = T & { _id: string };

/**
 * Convert a Mongo document (which stores the primary key as `_id`) to a row
 * shape (which uses `id`). TypeScript infers the input type from the call
 * site so the result is automatically typed as the corresponding row.
 */
function stripId<T extends { _id: string }>(
  row: T | null,
): (Omit<T, '_id'> & { id: string }) | null {
  if (!row) return null;
  const { _id, ...rest } = row;
  return { id: _id, ...rest } as Omit<T, '_id'> & { id: string };
}

function withId<T extends { id: string }>(row: T): WithId<Omit<T, 'id'>> {
  const { id, ...rest } = row;
  return { _id: id, ...(rest as Omit<T, 'id'>) } as WithId<Omit<T, 'id'>>;
}

export async function createMongoStore(config: ResolvedConfig): Promise<NexusStore> {
  if (!config.db.url) throw new Error('NEXUS_DB_URL is required for mongodb');
  const url = new URL(config.db.url);
  const dbName = (url.pathname || '/nexus').replace(/^\//, '') || 'nexus';
  const mongo = new MongoClient(config.db.url);
  await mongo.connect();
  const db: Db = mongo.db(dbName);

  let supportsTransactions = false;
  try {
    const status = await db.admin().command({ hello: 1 });
    supportsTransactions = !!(status as Record<string, unknown>).setName;
  } catch {
    supportsTransactions = false;
  }

  if (!supportsTransactions) {
    // eslint-disable-next-line no-console
    console.warn(
      '[ferrum-nexus] MongoDB is not running as a replica set — transactions are disabled. ' +
        'Multi-document workflows will not be atomic.',
    );
  }

  const c = {
    users: db.collection<WithId<Omit<UserRow, 'id'>>>('users'),
    userRoles: db.collection<UserRoleRow>('user_roles'),
    sessions: db.collection<WithId<Omit<SessionRow, 'id'>>>('sessions'),
    emailVerifications: db.collection<EmailVerificationRow & { _id: string }>(
      'email_verifications',
    ),
    passwordResets: db.collection<PasswordResetRow & { _id: string }>('password_resets'),
    organizations: db.collection<WithId<Omit<OrganizationRow, 'id'>>>('organizations'),
    orgMembers: db.collection<OrganizationMemberRow>('organization_members'),
    consumers: db.collection<WithId<Omit<FerrumConsumerRow, 'id'>>>('ferrum_consumers'),
    credentials: db.collection<WithId<Omit<CredentialMetadataRow, 'id'>>>('credential_metadata'),
    apiAssets: db.collection<WithId<Omit<ApiAssetRow, 'id'>>>('api_assets'),
    apiSpecVersions: db.collection<WithId<Omit<ApiSpecVersionRow, 'id'>>>('api_spec_versions'),
    accessRequests: db.collection<WithId<Omit<AccessRequestRow, 'id'>>>('access_requests'),
    accessGrants: db.collection<WithId<Omit<AccessGrantRow, 'id'>>>('access_grants'),
    conversations: db.collection<WithId<Omit<ConversationRow, 'id'>>>('conversations'),
    messages: db.collection<WithId<Omit<MessageRow, 'id'>>>('messages'),
    notifications: db.collection<WithId<Omit<NotificationRow, 'id'>>>('notifications'),
    emailOutbox: db.collection<WithId<Omit<EmailOutboxRow, 'id'>>>('email_outbox'),
    emailTemplates: db.collection<WithId<Omit<EmailTemplateRow, 'key'>> & { _id: string }>(
      'email_templates',
    ),
    appSettings: db.collection<{ _id: string; value: unknown; encrypted: boolean; updated_at: string }>(
      'app_settings',
    ),
    auditLogs: db.collection<WithId<Omit<AuditLogRow, 'id'>>>('audit_logs'),
    massEmail: db.collection<WithId<Omit<MassEmailCampaignRow, 'id'>>>('mass_email_campaigns'),
  };

  const migrate = async (): Promise<void> => {
    await Promise.all([
      c.users.createIndex({ email_normalized: 1 }, { unique: true }),
      c.users.createIndex({ status: 1 }),
      c.userRoles.createIndex({ user_id: 1, role: 1 }, { unique: true }),
      c.sessions.createIndex({ expires_at: 1 }),
      c.sessions.createIndex({ user_id: 1 }),
      c.emailVerifications.createIndex({ user_id: 1 }),
      c.consumers.createIndex({ user_id: 1, namespace: 1 }, { unique: true, sparse: true }),
      c.credentials.createIndex({ consumer_id: 1 }),
      c.apiAssets.createIndex({ slug: 1 }, { unique: true }),
      c.apiAssets.createIndex({ provider_id: 1 }),
      c.apiAssets.createIndex({ visibility: 1 }),
      c.apiAssets.createIndex({ lifecycle: 1 }),
      c.apiSpecVersions.createIndex({ api_asset_id: 1, created_at: -1 }),
      c.accessRequests.createIndex({ client_user_id: 1, api_asset_id: 1, status: 1 }),
      c.accessGrants.createIndex({ client_consumer_id: 1, api_asset_id: 1 }),
      c.conversations.createIndex({ participants: 1 }),
      c.messages.createIndex({ conversation_id: 1, created_at: 1 }),
      c.notifications.createIndex({ recipient_id: 1, read_at: 1 }),
      c.emailOutbox.createIndex({ status: 1, scheduled_at: 1 }),
      c.auditLogs.createIndex({ actor_id: 1 }),
      c.auditLogs.createIndex({ action: 1, created_at: -1 }),
    ]);
  };

  const runTxn = async <T>(fn: (session?: ClientSession) => Promise<T>): Promise<T> => {
    if (!supportsTransactions) {
      return fn(undefined);
    }
    const session = mongo.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  };

  const store: NexusStore = {
    driver: 'mongodb',
    users: {
      async insert(row) {
        const now = new Date().toISOString();
        const full: UserRow = { ...row, created_at: now, updated_at: now };
        await c.users.insertOne(withId(full));
        return full;
      },
      async findById(id) {
        return stripId(await c.users.findOne({ _id: id }));
      },
      async findByEmail(emailNormalized) {
        return stripId(await c.users.findOne({ email_normalized: emailNormalized }));
      },
      async updateContact(id, fields) {
        const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (fields.name !== undefined) update.name = fields.name;
        if (fields.phone !== undefined) update.phone = fields.phone;
        await c.users.updateOne({ _id: id }, { $set: update });
        const found = await c.users.findOne({ _id: id });
        return stripId(found)!;
      },
      async updatePassword(id, hash) {
        await c.users.updateOne(
          { _id: id },
          { $set: { password_hash: hash, updated_at: new Date().toISOString() } },
        );
      },
      async updateStatus(id, status) {
        await c.users.updateOne(
          { _id: id },
          { $set: { status, updated_at: new Date().toISOString() } },
        );
      },
      async markEmailVerified(id, at) {
        await c.users.updateOne(
          { _id: id },
          { $set: { email_verified_at: at, status: 'active', updated_at: new Date().toISOString() } },
        );
      },
      async recordLogin(id, at) {
        await c.users.updateOne(
          { _id: id },
          {
            $set: { last_login_at: at, failed_login_count: 0, updated_at: new Date().toISOString() },
          },
        );
      },
      async recordFailedLogin(id) {
        const res = await c.users.findOneAndUpdate(
          { _id: id },
          { $inc: { failed_login_count: 1 }, $set: { updated_at: new Date().toISOString() } },
          { returnDocument: 'after' },
        );
        return Number(res?.failed_login_count ?? 0);
      },
      async resetFailedLogins(id) {
        await c.users.updateOne(
          { _id: id },
          { $set: { failed_login_count: 0, updated_at: new Date().toISOString() } },
        );
      },
      async list(opts: ListOptions) {
        const limit = opts.limit ?? 25;
        const offset = opts.offset ?? 0;
        const filter: Filter<WithId<Omit<UserRow, 'id'>>> = opts.search
          ? {
              $or: [
                { email_normalized: { $regex: opts.search, $options: 'i' } },
                { name: { $regex: opts.search, $options: 'i' } },
              ],
            }
          : {};
        const [rows, total] = await Promise.all([
          c.users.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).toArray(),
          c.users.countDocuments(filter),
        ]);
        return { rows: rows.map((r) => stripId(r)!), total };
      },
      async listFiltered(opts) {
        const limit = opts.limit ?? 25;
        const offset = opts.offset ?? 0;
        const filter: Filter<WithId<Omit<UserRow, 'id'>>> = {};
        if (opts.status) filter.status = opts.status;
        if (opts.role) {
          // Pre-fetch matching user ids from user_roles. The collection is
          // expected to be small (one row per user-per-role), and we use the
          // (user_id, role) compound index that the migration creates.
          const roleRows = await c.userRoles
            .find({ role: opts.role }, { projection: { user_id: 1 } })
            .toArray();
          filter._id = { $in: roleRows.map((r) => r.user_id) };
        }
        const [rows, total] = await Promise.all([
          c.users.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).toArray(),
          c.users.countDocuments(filter),
        ]);
        return { rows: rows.map((r) => stripId(r)!), total };
      },
      async count() {
        return c.users.countDocuments({});
      },
    },
    userRoles: {
      async add(userId, role) {
        await c.userRoles.updateOne(
          { user_id: userId, role },
          { $setOnInsert: { user_id: userId, role, created_at: new Date().toISOString() } },
          { upsert: true },
        );
      },
      async remove(userId, role) {
        await c.userRoles.deleteOne({ user_id: userId, role });
      },
      async forUser(userId) {
        const rows = await c.userRoles.find({ user_id: userId }).toArray();
        return rows.map((r) => r.role);
      },
      async setRoles(userId, roles) {
        await c.userRoles.deleteMany({ user_id: userId });
        if (roles.length === 0) return;
        await c.userRoles.insertMany(
          roles.map((role: UserRole) => ({
            user_id: userId,
            role,
            created_at: new Date().toISOString(),
          })),
        );
      },
    },
    sessions: {
      async create(row) {
        await c.sessions.insertOne(withId(row));
      },
      async find(id) {
        return stripId(await c.sessions.findOne({ _id: id }));
      },
      async delete(id) {
        await c.sessions.deleteOne({ _id: id });
      },
      async deleteForUser(userId) {
        await c.sessions.deleteMany({ user_id: userId });
      },
      async cleanupExpired(now) {
        const res = await c.sessions.deleteMany({ expires_at: { $lt: now } });
        return res.deletedCount ?? 0;
      },
    },
    verifications: {
      async createEmailToken(row) {
        await c.emailVerifications.insertOne({ ...row, _id: row.token });
      },
      async findEmailToken(token) {
        return c.emailVerifications.findOne({ _id: token });
      },
      async consumeEmailToken(token, at) {
        await c.emailVerifications.updateOne({ _id: token }, { $set: { consumed_at: at } });
      },
      async createPasswordReset(row) {
        await c.passwordResets.insertOne({ ...row, _id: row.token });
      },
      async findPasswordReset(token) {
        return c.passwordResets.findOne({ _id: token });
      },
      async consumePasswordReset(token, at) {
        await c.passwordResets.updateOne({ _id: token }, { $set: { consumed_at: at } });
      },
    },
    organizations: {
      async insert(row) {
        await c.organizations.insertOne(withId(row));
        return row;
      },
      async findById(id) {
        return stripId(await c.organizations.findOne({ _id: id }));
      },
      async list() {
        const rows = await c.organizations.find().sort({ created_at: -1 }).toArray();
        return rows.map((r) => stripId(r)!);
      },
      async addMember(row) {
        await c.orgMembers.updateOne(
          { organization_id: row.organization_id, user_id: row.user_id },
          { $setOnInsert: row },
          { upsert: true },
        );
      },
      async membersOf(orgId) {
        return c.orgMembers.find({ organization_id: orgId }).toArray();
      },
    },
    consumers: {
      async insert(row) {
        await c.consumers.insertOne(withId(row));
        return row;
      },
      async findById(id) {
        return stripId(await c.consumers.findOne({ _id: id }));
      },
      async findByUserNamespace(userId, namespace) {
        return stripId(await c.consumers.findOne({ user_id: userId, namespace }));
      },
      async updateAclGroups(id, groups) {
        await c.consumers.updateOne({ _id: id }, { $set: { acl_groups: groups } });
      },
      async updateStatus(id, status) {
        await c.consumers.updateOne({ _id: id }, { $set: { status } });
      },
      async listForUser(userId) {
        const rows = await c.consumers.find({ user_id: userId }).toArray();
        return rows.map((r) => stripId(r)!);
      },
    },
    credentials: {
      async insert(row) {
        await c.credentials.insertOne(withId(row));
        return row;
      },
      async findById(id) {
        return stripId(await c.credentials.findOne({ _id: id }));
      },
      async listForConsumer(consumerId) {
        const rows = await c.credentials
          .find({ consumer_id: consumerId })
          .sort({ created_at: -1 })
          .toArray();
        return rows.map((r) => stripId(r)!);
      },
      async updateStatus(id, status) {
        await c.credentials.updateOne({ _id: id }, { $set: { status } });
      },
      async delete(id) {
        await c.credentials.deleteOne({ _id: id });
      },
    },
    apiAssets: {
      async insert(row) {
        await c.apiAssets.insertOne(withId(row));
        return row;
      },
      async update(id, fields) {
        const set = { ...fields, updated_at: new Date().toISOString() };
        delete (set as Record<string, unknown>).id;
        await c.apiAssets.updateOne({ _id: id }, { $set: set });
        return stripId(await c.apiAssets.findOne({ _id: id }))!;
      },
      async findById(id) {
        return stripId(await c.apiAssets.findOne({ _id: id }));
      },
      async findBySpecId(specId) {
        return stripId(await c.apiAssets.findOne({ api_spec_id: specId }));
      },
      async findBySlug(slug) {
        return stripId(await c.apiAssets.findOne({ slug }));
      },
      async delete(id) {
        await c.apiAssets.deleteOne({ _id: id });
      },
      async list(opts) {
        const limit = opts.limit ?? 25;
        const offset = opts.offset ?? 0;
        const filter: Filter<WithId<Omit<ApiAssetRow, 'id'>>> = {};
        if (opts.search) {
          filter.$or = [
            { title: { $regex: opts.search, $options: 'i' } },
            { description: { $regex: opts.search, $options: 'i' } },
            { slug: { $regex: opts.search, $options: 'i' } },
          ];
        }
        if (opts.visibility) filter.visibility = opts.visibility;
        if (opts.providerId) filter.provider_id = opts.providerId;
        const [rows, total] = await Promise.all([
          c.apiAssets.find(filter).sort({ updated_at: -1 }).skip(offset).limit(limit).toArray(),
          c.apiAssets.countDocuments(filter),
        ]);
        return { rows: rows.map((r) => stripId(r)!), total };
      },
    },
    apiSpecVersions: {
      async insert(row) {
        await c.apiSpecVersions.insertOne(withId(row));
        return row;
      },
      async listForAsset(assetId) {
        const rows = await c.apiSpecVersions
          .find({ api_asset_id: assetId })
          .sort({ created_at: -1 })
          .toArray();
        return rows.map((r) => stripId(r)!);
      },
      async latestForAsset(assetId) {
        const row = await c.apiSpecVersions
          .find({ api_asset_id: assetId })
          .sort({ created_at: -1 })
          .limit(1)
          .next();
        return stripId(row);
      },
      async get(id) {
        return stripId(await c.apiSpecVersions.findOne({ _id: id }));
      },
    },
    accessRequests: {
      async insert(row) {
        await c.accessRequests.insertOne(withId(row));
        return row;
      },
      async update(id, fields) {
        const set: Record<string, unknown> = { ...fields };
        delete set.id;
        await c.accessRequests.updateOne({ _id: id }, { $set: set });
        return stripId(await c.accessRequests.findOne({ _id: id }))!;
      },
      async findById(id) {
        return stripId(await c.accessRequests.findOne({ _id: id }));
      },
      async findOpenFor(clientUserId, apiAssetId) {
        return stripId(
          await c.accessRequests.findOne({
            client_user_id: clientUserId,
            api_asset_id: apiAssetId,
            status: 'pending',
          }),
        );
      },
      async listForClient(clientUserId) {
        const rows = await c.accessRequests
          .find({ client_user_id: clientUserId })
          .sort({ created_at: -1 })
          .toArray();
        return rows.map((r) => stripId(r)!);
      },
      async listForProvider(providerId, status?: AccessRequestStatus) {
        const assetIds = await c.apiAssets
          .find({ provider_id: providerId }, { projection: { _id: 1 } })
          .toArray();
        const ids = assetIds.map((r) => r._id);
        const filter: Filter<WithId<Omit<AccessRequestRow, 'id'>>> = {
          api_asset_id: { $in: ids },
        };
        if (status) filter.status = status;
        const rows = await c.accessRequests.find(filter).sort({ created_at: -1 }).toArray();
        return rows.map((r) => stripId(r)!);
      },
      async listForAsset(apiAssetId) {
        const rows = await c.accessRequests
          .find({ api_asset_id: apiAssetId })
          .sort({ created_at: -1 })
          .toArray();
        return rows.map((r) => stripId(r)!);
      },
    },
    grants: {
      async insert(row) {
        await c.accessGrants.insertOne(withId(row));
        return row;
      },
      async update(id, fields) {
        const set: Record<string, unknown> = { ...fields };
        delete set.id;
        await c.accessGrants.updateOne({ _id: id }, { $set: set });
        return stripId(await c.accessGrants.findOne({ _id: id }))!;
      },
      async findById(id) {
        return stripId(await c.accessGrants.findOne({ _id: id }));
      },
      async findActiveFor(consumerId, apiAssetId) {
        return stripId(
          await c.accessGrants.findOne({
            client_consumer_id: consumerId,
            api_asset_id: apiAssetId,
            status: 'active',
          }),
        );
      },
      async listForClient(clientUserId) {
        const rows = await c.accessGrants
          .find({ client_user_id: clientUserId })
          .sort({ approved_at: -1 })
          .toArray();
        return rows.map((r) => stripId(r)!);
      },
      async listForAsset(apiAssetId) {
        const rows = await c.accessGrants
          .find({ api_asset_id: apiAssetId })
          .sort({ approved_at: -1 })
          .toArray();
        return rows.map((r) => stripId(r)!);
      },
    },
    conversations: {
      async insert(row) {
        await c.conversations.insertOne(withId(row));
        return row;
      },
      async findById(id) {
        return stripId(await c.conversations.findOne({ _id: id }));
      },
      async listForUser(userId) {
        const rows = await c.conversations
          .find({ participants: userId })
          .sort({ created_at: -1 })
          .toArray();
        return rows.map((r) => stripId(r)!);
      },
      async updateParticipants(id, participants) {
        await c.conversations.updateOne({ _id: id }, { $set: { participants } });
      },
    },
    messages: {
      async insert(row) {
        await c.messages.insertOne(withId(row));
        return row;
      },
      async listForConversation(conversationId) {
        const rows = await c.messages
          .find({ conversation_id: conversationId })
          .sort({ created_at: 1 })
          .toArray();
        return rows.map((r) => stripId(r)!);
      },
      async markRead(conversationId, userId) {
        await c.messages.updateMany(
          { conversation_id: conversationId, sender_id: { $ne: userId } },
          { $addToSet: { read_by: userId } },
        );
      },
    },
    notifications: {
      async insert(row) {
        await c.notifications.insertOne(withId(row));
        return row;
      },
      async listForUser(userId, limit) {
        const rows = await c.notifications
          .find({ recipient_id: userId })
          .sort({ created_at: -1 })
          .limit(limit)
          .toArray();
        return rows.map((r) => stripId(r)!);
      },
      async markRead(id, userId, at) {
        const result = await c.notifications.updateOne(
          { _id: id, recipient_id: userId },
          { $set: { read_at: at } },
        );
        return result.matchedCount;
      },
      async unreadCount(userId) {
        return c.notifications.countDocuments({ recipient_id: userId, read_at: null });
      },
    },
    email: {
      async enqueue(row) {
        await c.emailOutbox.insertOne(withId(row));
      },
      async claimBatch(now, batchSize) {
        // findOneAndUpdate with `status: 'pending'` in the filter atomically
        // claims a row — even across multiple workers — so no two of them
        // can take ownership of the same email.
        const claimed: EmailOutboxRow[] = [];
        for (let i = 0; i < batchSize; i++) {
          const updated = await c.emailOutbox.findOneAndUpdate(
            { status: 'pending', scheduled_at: { $lte: now } },
            { $set: { status: 'sending' } },
            { sort: { scheduled_at: 1 }, returnDocument: 'after' },
          );
          if (!updated) break;
          const row = stripId(updated);
          if (row) claimed.push(row as EmailOutboxRow);
        }
        return claimed;
      },
      async markSent(id, at) {
        await c.emailOutbox.updateOne(
          { _id: id },
          { $set: { status: 'sent', sent_at: at } },
        );
      },
      async markFailed(id, attempts, error) {
        const backoffMs = Math.min(60_000 * attempts, 30 * 60_000);
        const scheduled = new Date(Date.now() + backoffMs).toISOString();
        const status = attempts >= 5 ? 'failed' : 'pending';
        await c.emailOutbox.updateOne(
          { _id: id },
          { $set: { attempts, last_error: error, status, scheduled_at: scheduled } },
        );
      },
      async getTemplate(key) {
        const row = await c.emailTemplates.findOne({ _id: key });
        if (!row) return null;
        const { _id, ...rest } = row as unknown as { _id: string } & EmailTemplateRow;
        return { ...rest, key: _id };
      },
      async upsertTemplate(row) {
        await c.emailTemplates.updateOne(
          { _id: row.key },
          { $set: { ...row, _id: row.key } },
          { upsert: true },
        );
      },
      async listTemplates() {
        const rows = await c.emailTemplates.find().sort({ _id: 1 }).toArray();
        return rows.map((row) => {
          const { _id, ...rest } = row as unknown as { _id: string } & EmailTemplateRow;
          return { ...rest, key: _id };
        });
      },
    },
    settings: {
      async get<T>(key: string): Promise<T | null> {
        const row = await c.appSettings.findOne({ _id: key });
        if (!row) return null;
        return row.value as T;
      },
      async set<T>(key: string, value: T, encrypted = false) {
        await c.appSettings.updateOne(
          { _id: key },
          {
            $set: {
              _id: key,
              value,
              encrypted,
              updated_at: new Date().toISOString(),
            },
          },
          { upsert: true },
        );
      },
      async all() {
        const rows = await c.appSettings.find().sort({ _id: 1 }).toArray();
        return rows.map((row) => ({
          key: row._id,
          value: row.value,
          encrypted: row.encrypted ? 1 : 0,
          updated_at: row.updated_at,
        })) as AppSettingRow[];
      },
    },
    audit: {
      async insert(row) {
        await c.auditLogs.insertOne(withId(row));
      },
      async list(opts) {
        const limit = opts.limit ?? 50;
        const offset = opts.offset ?? 0;
        const filter: Filter<WithId<Omit<AuditLogRow, 'id'>>> = {};
        if (opts.action) filter.action = opts.action;
        if (opts.actorId) filter.actor_id = opts.actorId;
        const [rows, total] = await Promise.all([
          c.auditLogs.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).toArray(),
          c.auditLogs.countDocuments(filter),
        ]);
        return { rows: rows.map((r) => stripId(r)!), total };
      },
    },
    massEmail: {
      async insert(row) {
        await c.massEmail.insertOne(withId(row));
        return row;
      },
      async update(id, fields) {
        const set: Record<string, unknown> = { ...fields };
        delete set.id;
        await c.massEmail.updateOne({ _id: id }, { $set: set });
        return stripId(await c.massEmail.findOne({ _id: id }))!;
      },
      async list() {
        const rows = await c.massEmail.find().sort({ created_at: -1 }).toArray();
        return rows.map((r) => stripId(r)!);
      },
      async findById(id) {
        return stripId(await c.massEmail.findOne({ _id: id }));
      },
    },
    async transaction<T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> {
      // Mongo's session is opaque to our service code; we pass `store` through
      // and rely on the connection's transactional context.
      return runTxn(async () => fn(store));
    },
    async migrate() {
      await migrate();
    },
    async close() {
      await mongo.close();
    },
  };

  return store;
}
