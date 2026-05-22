import Database from 'better-sqlite3';
import argon2 from 'argon2';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const dbPath = process.argv[2] ?? 'server/.context/dev.sqlite';
mkdirSync(dirname(dbPath), { recursive: true });
const password = 'password123';
const now = new Date();
const iso = (minutesAgo = 0) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const json = (value) => JSON.stringify(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');

const ids = {
  providerPayments: '10000000-0000-4000-8000-000000000001',
  providerIdentity: '10000000-0000-4000-8000-000000000002',
  providerOps: '10000000-0000-4000-8000-000000000003',
  clientAcme: '10000000-0000-4000-8000-000000000004',
  clientBeta: '10000000-0000-4000-8000-000000000005',
  pendingUser: '10000000-0000-4000-8000-000000000006',
  disabledUser: '10000000-0000-4000-8000-000000000007',
  orgFerrum: '20000000-0000-4000-8000-000000000001',
  orgAcme: '20000000-0000-4000-8000-000000000002',
  orgBlue: '20000000-0000-4000-8000-000000000003',
  paymentsApi: '30000000-0000-4000-8000-000000000001',
  identityApi: '30000000-0000-4000-8000-000000000002',
  shippingApi: '30000000-0000-4000-8000-000000000003',
  riskApi: '30000000-0000-4000-8000-000000000004',
  eventsApi: '30000000-0000-4000-8000-000000000005',
  sandboxApi: '30000000-0000-4000-8000-000000000006',
  reqAdminIdentity: '40000000-0000-4000-8000-000000000001',
  reqAdminShipping: '40000000-0000-4000-8000-000000000002',
  reqClientPayments: '40000000-0000-4000-8000-000000000003',
  reqClientEvents: '40000000-0000-4000-8000-000000000004',
  reqClientRisk: '40000000-0000-4000-8000-000000000005',
  grantAdminIdentity: '50000000-0000-4000-8000-000000000001',
  grantClientEvents: '50000000-0000-4000-8000-000000000002',
  grantBetaPaymentsRevoked: '50000000-0000-4000-8000-000000000003',
  adminConsumer: '60000000-0000-4000-8000-000000000001',
  clientAcmeConsumer: '60000000-0000-4000-8000-000000000002',
  clientBetaConsumer: '60000000-0000-4000-8000-000000000003',
  adminKeyCredential: '70000000-0000-4000-8000-000000000001',
  adminOldHmacCredential: '70000000-0000-4000-8000-000000000002',
  acmeKeyCredential: '70000000-0000-4000-8000-000000000003',
  convPayments: '80000000-0000-4000-8000-000000000001',
  convIdentity: '80000000-0000-4000-8000-000000000002',
  convEvents: '80000000-0000-4000-8000-000000000003',
  convAdmin: '80000000-0000-4000-8000-000000000004',
  pendingPublishClaims: '90000000-0000-4000-8000-000000000001',
  exceptionClaimsPending: '90000000-0000-4000-8000-000000000002',
  exceptionRiskApproved: '90000000-0000-4000-8000-000000000003',
  campaign: 'a0000000-0000-4000-8000-000000000001',
};

const allDemoUserIds = [
  ids.providerPayments,
  ids.providerIdentity,
  ids.providerOps,
  ids.clientAcme,
  ids.clientBeta,
  ids.pendingUser,
  ids.disabledUser,
];
const allApiIds = [
  ids.paymentsApi,
  ids.identityApi,
  ids.shippingApi,
  ids.riskApi,
  ids.eventsApi,
  ids.sandboxApi,
];
const allRequestIds = [
  ids.reqAdminIdentity,
  ids.reqAdminShipping,
  ids.reqClientPayments,
  ids.reqClientEvents,
  ids.reqClientRisk,
];
const allGrantIds = [ids.grantAdminIdentity, ids.grantClientEvents, ids.grantBetaPaymentsRevoked];
const allConsumerIds = [ids.adminConsumer, ids.clientAcmeConsumer, ids.clientBetaConsumer];
const allCredentialIds = [
  ids.adminKeyCredential,
  ids.adminOldHmacCredential,
  ids.acmeKeyCredential,
];
const allConversationIds = [ids.convPayments, ids.convIdentity, ids.convEvents, ids.convAdmin];
const allPolicyExceptionIds = [ids.exceptionClaimsPending, ids.exceptionRiskApproved];
const allPendingPublishIds = [ids.pendingPublishClaims];

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const tables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
);
if (!tables.has('users') || !tables.has('api_assets')) {
  console.error(
    `Demo seed target ${dbPath} has not been migrated. Run npm run migrate --workspace server first.`,
  );
  process.exit(1);
}

const passwordHash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function deleteIn(table, column, values) {
  if (values.length === 0) return;
  db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders(values)})`).run(...values);
}

function upsertSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, encrypted, updated_at)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = 0, updated_at = excluded.updated_at
  `).run(key, json(value), iso());
}

function ensureAdmin() {
  const existing = db
    .prepare('SELECT * FROM users WHERE email_normalized = ?')
    .get('admin@example.com');
  const adminId = existing?.id ?? randomUUID();
  if (existing) {
    db.prepare(`
      UPDATE users SET
        name = ?, status = 'active', email_verified_at = COALESCE(email_verified_at, ?),
        password_hash = ?, failed_login_count = 0, updated_at = ?
      WHERE id = ?
    `).run('Local Demo Admin', iso(), passwordHash, iso(), adminId);
  } else {
    db.prepare(`
      INSERT INTO users (
        id, email, email_normalized, name, phone, status, email_verified_at,
        password_hash, last_login_at, failed_login_count, organization_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      adminId,
      'admin@example.com',
      'admin@example.com',
      'Local Demo Admin',
      null,
      'active',
      iso(),
      passwordHash,
      null,
      0,
      null,
      iso(6000),
      iso(),
    );
  }
  for (const role of ['admin', 'super_admin', 'provider', 'client']) {
    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role, created_at) VALUES (?, ?, ?)')
      .run(adminId, role, iso());
  }
  upsertSetting('bootstrapSuperAdminUserId', adminId);
  return adminId;
}

function insertUser({ id, email, name, roles, status = 'active', orgId = null, minutesAgo = 5000 }) {
  db.prepare(`
    INSERT INTO users (
      id, email, email_normalized, name, phone, status, email_verified_at,
      password_hash, last_login_at, failed_login_count, organization_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    email,
    email.toLowerCase(),
    name,
    null,
    status,
    status === 'active' ? iso(minutesAgo - 20) : null,
    passwordHash,
    status === 'active' ? iso(60 + minutesAgo / 100) : null,
    0,
    orgId,
    iso(minutesAgo),
    iso(minutesAgo - 5),
  );
  for (const role of roles) {
    db.prepare('INSERT INTO user_roles (user_id, role, created_at) VALUES (?, ?, ?)')
      .run(id, role, iso(minutesAgo));
  }
}

function insertOrg({ id, name, domain, minutesAgo = 6000 }) {
  db.prepare('INSERT INTO organizations (id, name, domain, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, domain, 'active', iso(minutesAgo));
}

function addMember(orgId, userId, role) {
  db.prepare(`
    INSERT INTO organization_members (organization_id, user_id, role, created_at)
    VALUES (?, ?, ?, ?)
  `).run(orgId, userId, role, iso(4200));
}

function makeSpec({ title, version, description, tags, contact, proxy, operations }) {
  const paths = {};
  for (const op of operations) {
    paths[op.path] ??= {};
    paths[op.path][op.method] = {
      tags: op.tags ?? tags,
      summary: op.summary,
      operationId: op.operationId,
      responses: {
        '200': {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: { type: 'object' },
            },
          },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title,
      version,
      description,
      contact,
    },
    servers: [{ url: `https://${proxy.hosts[0]}${proxy.paths[0]}` }],
    tags: tags.map((name) => ({ name })),
    paths,
    'x-ferrum-proxy': proxy,
  };
}

function operationSummaries(spec) {
  return Object.values(spec.paths).flatMap((item) =>
    Object.values(item).map((operation) => operation.summary).filter(Boolean),
  );
}

function operationCount(spec) {
  return Object.values(spec.paths).reduce((count, item) => count + Object.keys(item).length, 0);
}

function rateLimit(proxy) {
  const plugin = proxy.plugins?.find((item) => item.name === 'rate_limiting');
  return plugin?.config?.minute ?? plugin?.config?.limit ?? null;
}

function insertApi({
  id,
  providerId,
  title,
  description,
  slug,
  version,
  visibility,
  requestable,
  lifecycle,
  tags,
  contact,
  supportNotes,
  proxy,
  operations,
  minutesAgo,
  policyExceptionId = null,
}) {
  const spec = makeSpec({ title, version, description, tags, contact, proxy, operations });
  const rawSpec = JSON.stringify(spec, null, 2);
  const contentHash = hash(rawSpec);
  const apiSpecVersionId = id.replace('30000000', '31000000');
  db.prepare(`
    INSERT INTO api_assets (
      id, api_spec_id, proxy_id, namespace, provider_id, title, description, slug, version,
      visibility, requestable, lifecycle, tags, contact_email, support_notes, operation_count,
      content_hash, created_at, updated_at, proxy_hosts, proxy_paths, proxy_upstream_url,
      timeout_connect_ms, timeout_read_ms, timeout_write_ms, body_size_limit_bytes,
      rate_limit_per_minute, operation_paths, operation_summaries, source_format,
      policy_exception_id, contact_name, contact_url
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    id,
    `edge-spec-${slug}`,
    proxy.proxy_id,
    'default',
    providerId,
    title,
    description,
    slug,
    version,
    visibility,
    requestable ? 1 : 0,
    lifecycle,
    json(tags),
    contact.email ?? null,
    supportNotes,
    operationCount(spec),
    contentHash,
    iso(minutesAgo),
    iso(minutesAgo - 30),
    json(proxy.hosts ?? []),
    json(proxy.paths ?? []),
    proxy.upstream_url ?? null,
    proxy.timeouts?.connect_ms ?? null,
    proxy.timeouts?.read_ms ?? null,
    proxy.timeouts?.write_ms ?? null,
    proxy.body_size_limit_bytes ?? null,
    rateLimit(proxy),
    json(Object.keys(spec.paths)),
    json(operationSummaries(spec)),
    'openapi3',
    policyExceptionId,
    contact.name ?? null,
    contact.url ?? null,
  );
  db.prepare(`
    INSERT INTO api_spec_versions (id, api_asset_id, version, content_hash, submitted_by, raw_spec, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(apiSpecVersionId, id, version, contentHash, providerId, rawSpec, iso(minutesAgo));
  return { rawSpec, contentHash };
}

function insertConsumer({ id, userId, username, groups, minutesAgo = 3500 }) {
  db.prepare(`
    INSERT INTO ferrum_consumers (
      id, user_id, organization_id, namespace, ferrum_consumer_id, username, status, acl_groups, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, null, 'default', `edge-consumer-${username}`, username, 'active', json(groups), iso(minutesAgo));
}

function insertCredential({ id, consumerId, type, label, last4, index, status, minutesAgo }) {
  db.prepare(`
    INSERT INTO credential_metadata (
      id, consumer_id, type, label, fingerprint, last4, ferrum_credential_index,
      status, created_at, rotated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    consumerId,
    type,
    label,
    hash(`${consumerId}:${label}:${type}`),
    last4,
    index,
    status,
    iso(minutesAgo),
    status === 'pending_removal' ? iso(45) : null,
    null,
  );
}

function acl(apiId) {
  return `nexus:api:${apiId}:approved`;
}

function insertRequest({ id, apiId, clientId, consumerId, justification, status, providerReason, reviewedBy, createdAgo, reviewedAgo = null }) {
  db.prepare(`
    INSERT INTO access_requests (
      id, api_asset_id, client_user_id, client_consumer_id, justification, status,
      provider_reason, reviewed_by, created_at, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    apiId,
    clientId,
    consumerId,
    justification,
    status,
    providerReason,
    reviewedBy,
    iso(createdAgo),
    reviewedAgo == null ? null : iso(reviewedAgo),
  );
}

function insertGrant({ id, apiId, clientId, consumerId, approvedBy, approvedAgo, status, revokedBy = null, revokedAgo = null, revokedReason = null }) {
  db.prepare(`
    INSERT INTO access_grants (
      id, api_asset_id, client_user_id, client_consumer_id, acl_group, status,
      approved_by, approved_at, revoked_by, revoked_at, revoked_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    apiId,
    clientId,
    consumerId,
    acl(apiId),
    status,
    approvedBy,
    iso(approvedAgo),
    revokedBy,
    revokedAgo == null ? null : iso(revokedAgo),
    revokedReason,
  );
}

function insertConversation({ id, apiId, requestId = null, grantId = null, type, subject, participants, minutesAgo }) {
  db.prepare(`
    INSERT INTO conversations (id, api_asset_id, request_id, grant_id, type, subject, participants, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, apiId, requestId, grantId, type, subject, json(participants), iso(minutesAgo));
}

function insertMessage({ conversationId, senderId, body, minutesAgo, readBy }) {
  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_id, body, created_at, read_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), conversationId, senderId, body, iso(minutesAgo), json(readBy));
}

function insertNotification({ recipientId, type, payload, minutesAgo, read = false }) {
  db.prepare(`
    INSERT INTO notifications (id, recipient_id, type, payload, read_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), recipientId, type, json(payload), read ? iso(minutesAgo - 2) : null, iso(minutesAgo));
}

function insertAudit({ actorId, actorEmail, action, targetType, targetId, after, minutesAgo, reason = null }) {
  db.prepare(`
    INSERT INTO audit_logs (
      id, actor_id, actor_email, action, target_type, target_id, reason, before, after, ip, user_agent, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    actorId,
    actorEmail,
    action,
    targetType,
    targetId,
    reason,
    null,
    after == null ? null : json(after),
    '127.0.0.1',
    'Demo seed',
    iso(minutesAgo),
  );
}

function insertOutbox({ to, subject, templateId, payload, status, attempts, lastError, minutesAgo }) {
  db.prepare(`
    INSERT INTO email_outbox (
      id, to_address, subject, template_id, payload, status, attempts, last_error,
      scheduled_at, sent_at, created_at, idempotency_key, headers
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    to,
    subject,
    templateId,
    json(payload),
    status,
    attempts,
    lastError,
    iso(minutesAgo),
    status === 'sent' ? iso(minutesAgo - 1) : null,
    iso(minutesAgo),
    `demo:${to}:${subject}`,
    json({ 'X-Demo': 'true' }),
  );
}

function seedPolicy(adminId) {
  upsertSetting('governance_policy', {
    version: 4,
    updatedAt: iso(260),
    updatedBy: adminId,
    rules: [
      {
        id: 'info.contact.email.required',
        description: 'Every API must publish an owner contact email.',
        severity: 'error',
        exceptionEligible: false,
        kind: 'required_field',
        params: { path: 'info.contact.email' },
      },
      {
        id: 'proxy.rate-limit.required',
        description: 'Requestable APIs must declare rate limiting.',
        severity: 'error',
        exceptionEligible: true,
        kind: 'plugin_required',
        params: { name: 'rate_limiting' },
      },
      {
        id: 'proxy.body-size.max-10m',
        description: 'Body size limits should stay under 10 MiB.',
        severity: 'error',
        exceptionEligible: true,
        kind: 'body_size_max',
        params: { max_bytes: 10485760 },
      },
      {
        id: 'proxy.read-timeout.range',
        description: 'Read timeouts should be between 1s and 30s.',
        severity: 'warn',
        exceptionEligible: true,
        kind: 'timeout_range',
        params: { kind: 'read', min: 1000, max: 30000 },
      },
      {
        id: 'operations.summary.required',
        description: 'Each operation should include a summary.',
        severity: 'warn',
        exceptionEligible: false,
        kind: 'operation_summary_required',
      },
    ],
  });
}

const tx = db.transaction(() => {
  const adminId = ensureAdmin();

  deleteIn('messages', 'conversation_id', allConversationIds);
  deleteIn('conversations', 'id', allConversationIds);
  db.prepare(`DELETE FROM notifications WHERE recipient_id IN (${placeholders([adminId, ...allDemoUserIds])})`)
    .run(adminId, ...allDemoUserIds);
  db.prepare("DELETE FROM email_outbox WHERE idempotency_key LIKE 'demo:%'").run();
  deleteIn('mass_email_campaigns', 'id', [ids.campaign]);
  db.prepare(`
    DELETE FROM audit_logs
    WHERE user_agent = 'Demo seed'
       OR actor_id IN (${placeholders([adminId, ...allDemoUserIds])})
       OR target_id IN (${placeholders([...allApiIds, ...allRequestIds, ...allGrantIds, ...allPolicyExceptionIds])})
  `).run(...[adminId, ...allDemoUserIds], ...[...allApiIds, ...allRequestIds, ...allGrantIds, ...allPolicyExceptionIds]);
  deleteIn('policy_exception_requests', 'id', allPolicyExceptionIds);
  deleteIn('pending_publishes', 'id', allPendingPublishIds);
  deleteIn('access_grants', 'id', allGrantIds);
  deleteIn('access_requests', 'id', allRequestIds);
  deleteIn('credential_metadata', 'id', allCredentialIds);
  deleteIn('ferrum_consumers', 'id', allConsumerIds);
  deleteIn('api_spec_versions', 'api_asset_id', allApiIds);
  deleteIn('api_assets', 'id', allApiIds);
  db.prepare(`DELETE FROM organization_members WHERE organization_id IN (${placeholders([ids.orgFerrum, ids.orgAcme, ids.orgBlue])})`)
    .run(ids.orgFerrum, ids.orgAcme, ids.orgBlue);
  deleteIn('organizations', 'id', [ids.orgFerrum, ids.orgAcme, ids.orgBlue]);
  deleteIn('user_roles', 'user_id', allDemoUserIds);
  deleteIn('users', 'id', allDemoUserIds);
  db.prepare(`
    DELETE FROM users
    WHERE email_normalized IN (
      'provider-payments@example.com',
      'provider-identity@example.com',
      'provider-ops@example.com',
      'client-acme@example.com',
      'client-beta@example.com',
      'pending-user@example.com',
      'disabled-user@example.com'
    )
  `).run();

  insertOrg({ id: ids.orgFerrum, name: 'Ferrum Platform Team', domain: 'example.com' });
  insertOrg({ id: ids.orgAcme, name: 'Acme Marketplace', domain: 'acme.test' });
  insertOrg({ id: ids.orgBlue, name: 'Blue Orbit Logistics', domain: 'blueorbit.test' });

  db.prepare('UPDATE users SET organization_id = ?, updated_at = ? WHERE id = ?')
    .run(ids.orgFerrum, iso(), adminId);
  addMember(ids.orgFerrum, adminId, 'owner');

  insertUser({
    id: ids.providerPayments,
    email: 'provider-payments@example.com',
    name: 'Priya Shah',
    roles: ['provider'],
    orgId: ids.orgFerrum,
    minutesAgo: 5200,
  });
  insertUser({
    id: ids.providerIdentity,
    email: 'provider-identity@example.com',
    name: 'Mateo Rivera',
    roles: ['provider'],
    orgId: ids.orgFerrum,
    minutesAgo: 5100,
  });
  insertUser({
    id: ids.providerOps,
    email: 'provider-ops@example.com',
    name: 'Nina Brooks',
    roles: ['provider'],
    orgId: ids.orgBlue,
    minutesAgo: 5050,
  });
  insertUser({
    id: ids.clientAcme,
    email: 'client-acme@example.com',
    name: 'Avery Chen',
    roles: ['client'],
    orgId: ids.orgAcme,
    minutesAgo: 5000,
  });
  insertUser({
    id: ids.clientBeta,
    email: 'client-beta@example.com',
    name: 'Sam Taylor',
    roles: ['client'],
    orgId: ids.orgBlue,
    minutesAgo: 4950,
  });
  insertUser({
    id: ids.pendingUser,
    email: 'pending-user@example.com',
    name: 'Jordan Pending',
    roles: ['client'],
    status: 'pending_admin_approval',
    orgId: ids.orgAcme,
    minutesAgo: 80,
  });
  insertUser({
    id: ids.disabledUser,
    email: 'disabled-user@example.com',
    name: 'Casey Disabled',
    roles: ['client'],
    status: 'disabled',
    orgId: ids.orgBlue,
    minutesAgo: 4600,
  });

  addMember(ids.orgFerrum, ids.providerPayments, 'provider');
  addMember(ids.orgFerrum, ids.providerIdentity, 'provider');
  addMember(ids.orgBlue, ids.providerOps, 'owner');
  addMember(ids.orgAcme, ids.clientAcme, 'member');
  addMember(ids.orgBlue, ids.clientBeta, 'member');
  addMember(ids.orgAcme, ids.pendingUser, 'member');

  insertApi({
    id: ids.paymentsApi,
    providerId: adminId,
    title: 'Payments Ledger API',
    description: 'Real-time payment authorization, refund, and settlement workflows for product teams that need auditable money movement.',
    slug: 'payments-ledger-api-1-4-2',
    version: '1.4.2',
    visibility: 'public',
    requestable: true,
    lifecycle: 'published',
    tags: ['payments', 'ledger', 'finance'],
    contact: { name: 'Payments Platform', email: 'payments-api@example.com', url: 'https://docs.example.com/payments' },
    supportNotes: 'Tier 1 support responds in Slack channel #payments-api during US business hours.',
    proxy: {
      proxy_id: 'payments-ledger-v1',
      hosts: ['api.demo.nexus.local'],
      paths: ['/payments'],
      upstream_url: 'https://payments.internal.demo',
      timeouts: { connect_ms: 800, read_ms: 12000, write_ms: 12000 },
      body_size_limit_bytes: 2097152,
      plugins: [{ name: 'rate_limiting', config: { minute: 1200 } }],
    },
    operations: [
      { path: '/v1/payments', method: 'get', summary: 'List payments', operationId: 'listPayments' },
      { path: '/v1/payments', method: 'post', summary: 'Create payment', operationId: 'createPayment' },
      { path: '/v1/payments/{paymentId}', method: 'get', summary: 'Get payment status', operationId: 'getPayment' },
      { path: '/v1/refunds', method: 'post', summary: 'Create refund', operationId: 'createRefund' },
      { path: '/v1/settlements', method: 'get', summary: 'List settlements', operationId: 'listSettlements' },
    ],
    minutesAgo: 4300,
  });

  insertApi({
    id: ids.identityApi,
    providerId: ids.providerIdentity,
    title: 'Identity Verification API',
    description: 'KYC checks, document capture, and risk signals for onboarding flows with policy-friendly audit trails.',
    slug: 'identity-verification-api-2-1-0',
    version: '2.1.0',
    visibility: 'public',
    requestable: true,
    lifecycle: 'published',
    tags: ['identity', 'kyc', 'risk'],
    contact: { name: 'Identity Platform', email: 'identity-api@example.com', url: 'https://docs.example.com/identity' },
    supportNotes: 'Attach the applicant id and request id when opening support conversations.',
    proxy: {
      proxy_id: 'identity-verification-v2',
      hosts: ['api.demo.nexus.local'],
      paths: ['/identity'],
      upstream_url: 'https://identity.internal.demo',
      timeouts: { connect_ms: 1000, read_ms: 25000, write_ms: 15000 },
      body_size_limit_bytes: 8388608,
      plugins: [{ name: 'rate_limiting', config: { minute: 600 } }],
    },
    operations: [
      { path: '/v2/applicants', method: 'post', summary: 'Create applicant', operationId: 'createApplicant' },
      { path: '/v2/applicants/{id}', method: 'get', summary: 'Get applicant', operationId: 'getApplicant' },
      { path: '/v2/checks', method: 'post', summary: 'Run verification check', operationId: 'runCheck' },
      { path: '/v2/documents', method: 'post', summary: 'Upload document metadata', operationId: 'uploadDocument' },
    ],
    minutesAgo: 3900,
  });

  insertApi({
    id: ids.shippingApi,
    providerId: ids.providerOps,
    title: 'Shipment Tracking API',
    description: 'Carrier-agnostic shipment milestones, ETA updates, exception webhooks, and fulfillment visibility.',
    slug: 'shipment-tracking-api-3-0-1',
    version: '3.0.1',
    visibility: 'public',
    requestable: true,
    lifecycle: 'published',
    tags: ['logistics', 'tracking', 'fulfillment'],
    contact: { name: 'Logistics API Team', email: 'logistics-api@example.com', url: 'https://docs.example.com/logistics' },
    supportNotes: 'Use low-volume sandbox keys for webhook receiver testing.',
    proxy: {
      proxy_id: 'shipment-tracking-v3',
      hosts: ['api.demo.nexus.local'],
      paths: ['/shipments'],
      upstream_url: 'https://shipments.internal.demo',
      timeouts: { connect_ms: 700, read_ms: 9000, write_ms: 9000 },
      body_size_limit_bytes: 1048576,
      plugins: [{ name: 'rate_limiting', config: { minute: 900 } }],
    },
    operations: [
      { path: '/v3/shipments', method: 'get', summary: 'Search shipments', operationId: 'searchShipments' },
      { path: '/v3/shipments/{id}', method: 'get', summary: 'Get shipment timeline', operationId: 'getShipment' },
      { path: '/v3/webhooks', method: 'post', summary: 'Register tracking webhook', operationId: 'registerWebhook' },
    ],
    minutesAgo: 3300,
  });

  insertApi({
    id: ids.riskApi,
    providerId: ids.providerPayments,
    title: 'Portfolio Risk API',
    description: 'Internal portfolio exposure, counterparty risk, and exception monitoring for finance operations.',
    slug: 'portfolio-risk-api-0-9-5',
    version: '0.9.5',
    visibility: 'internal',
    requestable: true,
    lifecycle: 'deprecated',
    tags: ['risk', 'finance', 'internal'],
    contact: { name: 'Risk Systems', email: 'risk-api@example.com', url: 'https://docs.example.com/risk' },
    supportNotes: 'Deprecated in favor of Risk Signals API. Exception approved for legacy consumers through quarter end.',
    proxy: {
      proxy_id: 'portfolio-risk-v0',
      hosts: ['internal.demo.nexus.local'],
      paths: ['/risk'],
      upstream_url: 'https://risk.internal.demo',
      timeouts: { connect_ms: 1000, read_ms: 45000, write_ms: 15000 },
      body_size_limit_bytes: 15728640,
      plugins: [{ name: 'rate_limiting', config: { minute: 180 } }],
    },
    operations: [
      { path: '/v0/exposures', method: 'get', summary: 'List exposure snapshots', operationId: 'listExposures' },
      { path: '/v0/counterparties/{id}', method: 'get', summary: 'Get counterparty risk', operationId: 'getCounterpartyRisk' },
    ],
    minutesAgo: 2900,
    policyExceptionId: ids.exceptionRiskApproved,
  });

  insertApi({
    id: ids.eventsApi,
    providerId: adminId,
    title: 'Customer Events API',
    description: 'High-volume event ingestion for product analytics, lifecycle messaging, and experimentation systems.',
    slug: 'customer-events-api-1-8-0',
    version: '1.8.0',
    visibility: 'public',
    requestable: true,
    lifecycle: 'published',
    tags: ['events', 'analytics', 'streaming'],
    contact: { name: 'Events Platform', email: 'events-api@example.com', url: 'https://docs.example.com/events' },
    supportNotes: 'Use the batch endpoint for backfills larger than 10,000 events.',
    proxy: {
      proxy_id: 'customer-events-v1',
      hosts: ['api.demo.nexus.local'],
      paths: ['/events'],
      upstream_url: 'https://events.internal.demo',
      timeouts: { connect_ms: 500, read_ms: 6000, write_ms: 12000 },
      body_size_limit_bytes: 5242880,
      plugins: [{ name: 'rate_limiting', config: { minute: 5000 } }],
    },
    operations: [
      { path: '/v1/events', method: 'post', summary: 'Ingest event', operationId: 'ingestEvent' },
      { path: '/v1/events/batch', method: 'post', summary: 'Ingest event batch', operationId: 'ingestEventBatch' },
      { path: '/v1/schemas', method: 'get', summary: 'List event schemas', operationId: 'listSchemas' },
      { path: '/v1/schemas/{name}', method: 'put', summary: 'Update event schema', operationId: 'updateSchema' },
    ],
    minutesAgo: 2500,
  });

  insertApi({
    id: ids.sandboxApi,
    providerId: ids.providerOps,
    title: 'Carrier Sandbox API',
    description: 'Private test harness for provider teams validating carrier integrations before public catalog release.',
    slug: 'carrier-sandbox-api-0-3-0',
    version: '0.3.0',
    visibility: 'private',
    requestable: false,
    lifecycle: 'draft',
    tags: ['logistics', 'sandbox'],
    contact: { name: 'Carrier Integrations', email: 'carrier-api@example.com', url: 'https://docs.example.com/carrier-sandbox' },
    supportNotes: 'Draft asset used to preview provider-only publishing state.',
    proxy: {
      proxy_id: 'carrier-sandbox-v0',
      hosts: ['sandbox.demo.nexus.local'],
      paths: ['/carrier-sandbox'],
      upstream_url: 'https://carrier-sandbox.internal.demo',
      timeouts: { connect_ms: 1000, read_ms: 10000, write_ms: 10000 },
      body_size_limit_bytes: 1048576,
      plugins: [{ name: 'rate_limiting', config: { minute: 120 } }],
    },
    operations: [
      { path: '/v0/carriers', method: 'get', summary: 'List sandbox carriers', operationId: 'listSandboxCarriers' },
      { path: '/v0/simulations', method: 'post', summary: 'Create carrier simulation', operationId: 'createSimulation' },
    ],
    minutesAgo: 1600,
  });

  insertConsumer({
    id: ids.adminConsumer,
    userId: adminId,
    username: 'admin-demo',
    groups: [acl(ids.identityApi), acl(ids.eventsApi)],
  });
  insertConsumer({
    id: ids.clientAcmeConsumer,
    userId: ids.clientAcme,
    username: 'client-acme',
    groups: [acl(ids.eventsApi)],
  });
  insertConsumer({
    id: ids.clientBetaConsumer,
    userId: ids.clientBeta,
    username: 'client-beta',
    groups: [],
  });

  insertCredential({
    id: ids.adminKeyCredential,
    consumerId: ids.adminConsumer,
    type: 'keyauth',
    label: 'Browser demo key',
    last4: 'A19F',
    index: 0,
    status: 'active',
    minutesAgo: 700,
  });
  insertCredential({
    id: ids.adminOldHmacCredential,
    consumerId: ids.adminConsumer,
    type: 'hmac_auth',
    label: 'Old reporting integration',
    last4: '8842',
    index: 1,
    status: 'pending_removal',
    minutesAgo: 1200,
  });
  insertCredential({
    id: ids.acmeKeyCredential,
    consumerId: ids.clientAcmeConsumer,
    type: 'keyauth',
    label: 'Acme production ingestion',
    last4: 'C0DE',
    index: 0,
    status: 'active',
    minutesAgo: 640,
  });

  insertRequest({
    id: ids.reqAdminIdentity,
    apiId: ids.identityApi,
    clientId: adminId,
    consumerId: ids.adminConsumer,
    justification: 'Demo admin persona needs KYC checks for portal onboarding flows.',
    status: 'approved',
    providerReason: 'Approved for low-volume evaluation.',
    reviewedBy: ids.providerIdentity,
    createdAgo: 1500,
    reviewedAgo: 1460,
  });
  insertRequest({
    id: ids.reqAdminShipping,
    apiId: ids.shippingApi,
    clientId: adminId,
    consumerId: null,
    justification: 'Evaluate shipment webhooks for a fulfillment dashboard integration.',
    status: 'pending',
    providerReason: null,
    reviewedBy: null,
    createdAgo: 110,
  });
  insertRequest({
    id: ids.reqClientPayments,
    apiId: ids.paymentsApi,
    clientId: ids.clientBeta,
    consumerId: null,
    justification: 'Need payment authorization and refund access for the Blue Orbit checkout pilot.',
    status: 'pending',
    providerReason: null,
    reviewedBy: null,
    createdAgo: 55,
  });
  insertRequest({
    id: ids.reqClientEvents,
    apiId: ids.eventsApi,
    clientId: ids.clientAcme,
    consumerId: ids.clientAcmeConsumer,
    justification: 'Send product and checkout analytics events from Acme Marketplace.',
    status: 'approved',
    providerReason: 'Approved with standard 5,000 requests/min limit.',
    reviewedBy: adminId,
    createdAgo: 980,
    reviewedAgo: 920,
  });
  insertRequest({
    id: ids.reqClientRisk,
    apiId: ids.riskApi,
    clientId: ids.clientBeta,
    consumerId: ids.clientBetaConsumer,
    justification: 'Explore portfolio risk exposure for a partner dashboard.',
    status: 'denied',
    providerReason: 'Internal-only API. Use the public Risk Signals API when it is published.',
    reviewedBy: ids.providerPayments,
    createdAgo: 1300,
    reviewedAgo: 1260,
  });

  insertGrant({
    id: ids.grantAdminIdentity,
    apiId: ids.identityApi,
    clientId: adminId,
    consumerId: ids.adminConsumer,
    approvedBy: ids.providerIdentity,
    approvedAgo: 1460,
    status: 'active',
  });
  insertGrant({
    id: ids.grantClientEvents,
    apiId: ids.eventsApi,
    clientId: ids.clientAcme,
    consumerId: ids.clientAcmeConsumer,
    approvedBy: adminId,
    approvedAgo: 920,
    status: 'active',
  });
  insertGrant({
    id: ids.grantBetaPaymentsRevoked,
    apiId: ids.paymentsApi,
    clientId: ids.clientBeta,
    consumerId: ids.clientBetaConsumer,
    approvedBy: adminId,
    approvedAgo: 1800,
    status: 'revoked',
    revokedBy: adminId,
    revokedAgo: 700,
    revokedReason: 'Pilot environment rotated to a separate consumer.',
  });

  insertConversation({
    id: ids.convPayments,
    apiId: ids.paymentsApi,
    requestId: ids.reqClientPayments,
    type: 'access_request',
    subject: 'Blue Orbit payment pilot access',
    participants: [adminId, ids.clientBeta],
    minutesAgo: 55,
  });
  insertMessage({
    conversationId: ids.convPayments,
    senderId: ids.clientBeta,
    body: 'We are ready to start the checkout pilot and need Payments Ledger API access for the staging and production consumers.',
    minutesAgo: 52,
    readBy: [ids.clientBeta],
  });
  insertMessage({
    conversationId: ids.convPayments,
    senderId: adminId,
    body: 'Thanks. I am checking the requested volume and PCI notes before approving.',
    minutesAgo: 40,
    readBy: [adminId, ids.clientBeta],
  });

  insertConversation({
    id: ids.convIdentity,
    apiId: ids.identityApi,
    requestId: ids.reqAdminIdentity,
    grantId: ids.grantAdminIdentity,
    type: 'api_support',
    subject: 'Identity sandbox document upload limits',
    participants: [adminId, ids.providerIdentity],
    minutesAgo: 380,
  });
  insertMessage({
    conversationId: ids.convIdentity,
    senderId: adminId,
    body: 'Can you confirm the recommended document metadata size for sandbox checks?',
    minutesAgo: 375,
    readBy: [adminId],
  });
  insertMessage({
    conversationId: ids.convIdentity,
    senderId: ids.providerIdentity,
    body: 'Keep each document metadata payload under 8 MiB. The viewer should show that body limit in the key facts panel.',
    minutesAgo: 360,
    readBy: [ids.providerIdentity],
  });

  insertConversation({
    id: ids.convEvents,
    apiId: ids.eventsApi,
    grantId: ids.grantClientEvents,
    type: 'announcement',
    subject: 'Customer Events schema validation rollout',
    participants: [adminId, ids.clientAcme],
    minutesAgo: 620,
  });
  insertMessage({
    conversationId: ids.convEvents,
    senderId: adminId,
    body: 'Schema validation warnings will become errors next Monday. Please check the /v1/schemas endpoint for your current event contracts.',
    minutesAgo: 615,
    readBy: [adminId, ids.clientAcme],
  });

  insertConversation({
    id: ids.convAdmin,
    apiId: null,
    type: 'admin_direct',
    subject: 'Pending registration review',
    participants: [adminId, ids.pendingUser],
    minutesAgo: 75,
  });
  insertMessage({
    conversationId: ids.convAdmin,
    senderId: ids.pendingUser,
    body: 'I requested access as part of the Acme Marketplace integration team.',
    minutesAgo: 73,
    readBy: [ids.pendingUser],
  });

  insertNotification({
    recipientId: adminId,
    type: 'access_request_created',
    payload: { apiTitle: 'Payments Ledger API', requestId: ids.reqClientPayments },
    minutesAgo: 55,
  });
  insertNotification({
    recipientId: adminId,
    type: 'message_received',
    payload: { subject: 'Identity sandbox document upload limits', conversationId: ids.convIdentity },
    minutesAgo: 360,
  });
  insertNotification({
    recipientId: adminId,
    type: 'credential_rotation_due',
    payload: { label: 'Old reporting integration', credentialId: ids.adminOldHmacCredential },
    minutesAgo: 125,
  });
  insertNotification({
    recipientId: adminId,
    type: 'api_spec_updated',
    payload: { apiTitle: 'Customer Events API', apiAssetId: ids.eventsApi },
    minutesAgo: 240,
    read: true,
  });
  insertNotification({
    recipientId: ids.clientAcme,
    type: 'access_request_approved',
    payload: { apiTitle: 'Customer Events API', grantId: ids.grantClientEvents },
    minutesAgo: 920,
  });

  seedPolicy(adminId);

  const pendingClaimsSpec = makeSpec({
    title: 'Partner Claims API',
    version: '0.1.0',
    description: 'Early partner claims submission API awaiting governance review before publication.',
    tags: ['claims', 'partners'],
    contact: { name: 'Identity Platform', email: 'identity-api@example.com', url: 'https://docs.example.com/claims' },
    proxy: {
      proxy_id: 'partner-claims-v0',
      hosts: ['api.demo.nexus.local'],
      paths: ['/claims'],
      upstream_url: 'https://claims.internal.demo',
      timeouts: { connect_ms: 1000, read_ms: 40000, write_ms: 15000 },
      body_size_limit_bytes: 20971520,
      plugins: [],
    },
    operations: [
      { path: '/v0/claims', method: 'post', summary: 'Submit partner claim', operationId: 'submitClaim' },
    ],
  });
  const pendingClaimsRaw = JSON.stringify(pendingClaimsSpec, null, 2);
  db.prepare(`
    INSERT INTO pending_publishes (id, provider_id, raw_spec, publish_input, exception_request_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    ids.pendingPublishClaims,
    ids.providerIdentity,
    pendingClaimsRaw,
    json({
      rawSpec: pendingClaimsRaw,
      visibility: 'public',
      requestable: true,
      lifecycle: 'published',
      namespace: 'default',
      contactEmail: 'identity-api@example.com',
      supportNotes: 'Pending approval for larger claim payloads.',
    }),
    ids.exceptionClaimsPending,
    iso(100),
  );
  const claimViolations = [
    {
      ruleId: 'proxy.rate-limit.required',
      severity: 'error',
      message: 'Plugin rate_limiting is required',
      pointer: '/x-ferrum-proxy/plugins',
      exceptionEligible: true,
    },
    {
      ruleId: 'proxy.body-size.max-10m',
      severity: 'error',
      message: 'Body size limit must be at most 10485760 bytes',
      pointer: '/x-ferrum-proxy/body_size_limit_bytes',
      exceptionEligible: true,
    },
  ];
  db.prepare(`
    INSERT INTO policy_exception_requests (
      id, api_asset_id, provider_id, pending_publish_id, violations, justification,
      status, reviewed_by, reviewed_at, reviewer_notes, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ids.exceptionClaimsPending,
    null,
    ids.providerIdentity,
    ids.pendingPublishClaims,
    json(claimViolations),
    'The first partner requires larger claim evidence packages while we finish chunked uploads. Traffic will stay below 50 requests/min.',
    'pending',
    null,
    null,
    null,
    null,
    iso(95),
  );
  db.prepare(`
    INSERT INTO policy_exception_requests (
      id, api_asset_id, provider_id, pending_publish_id, violations, justification,
      status, reviewed_by, reviewed_at, reviewer_notes, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ids.exceptionRiskApproved,
    ids.riskApi,
    ids.providerPayments,
    null,
    json([
      {
        ruleId: 'proxy.body-size.max-10m',
        severity: 'error',
        message: 'Body size limit must be at most 10485760 bytes',
        pointer: '/x-ferrum-proxy/body_size_limit_bytes',
        exceptionEligible: true,
      },
    ]),
    'Legacy portfolio reports include larger payloads until the replacement endpoint is live.',
    'approved',
    adminId,
    iso(680),
    'Approved through quarter end for named legacy consumers only.',
    new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000).toISOString(),
    iso(740),
  );

  upsertSetting('branding', {
    productName: 'Ferrum Nexus Demo',
    logoUrl: null,
    primaryColor: '#2563eb',
    defaultTheme: 'system',
    supportEmail: 'support@example.com',
    footerNotice: 'Demo portal seeded with active catalog, approvals, credentials, and governance data.',
  });
  upsertSetting('captcha', { enabled: false, provider: null, siteKey: null });
  upsertSetting('registrationEnabled', true);
  upsertSetting('emailVerificationRequired', false);
  upsertSetting('registrationAllowedEmailDomains', ['example.com', 'acme.test', 'blueorbit.test']);
  upsertSetting('registrationRequiresAdminApproval', true);
  upsertSetting('emailFrom', 'Ferrum Nexus Demo <nexus@example.com>');
  upsertSetting('smtpHost', 'smtp.demo.local');
  upsertSetting('smtpPort', 587);
  upsertSetting('smtpUsername', 'nexus-demo');
  upsertSetting('smtpSecure', true);

  db.prepare(`
    INSERT INTO mass_email_campaigns (
      id, created_by, recipient_filter, subject, body, status, sent_count,
      failed_count, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ids.campaign,
    adminId,
    json({ role: 'client', status: 'active' }),
    'Developer portal maintenance window',
    'Ferrum Nexus will rotate sandbox credentials this Friday. Production credentials are not affected.',
    'completed',
    3,
    1,
    iso(1440),
    iso(1435),
  );
  insertOutbox({
    to: 'client-acme@example.com',
    subject: 'Customer Events API access approved',
    templateId: 'access_request_approved',
    payload: { apiTitle: 'Customer Events API' },
    status: 'sent',
    attempts: 1,
    lastError: null,
    minutesAgo: 920,
  });
  insertOutbox({
    to: 'pending-user@example.com',
    subject: 'Ferrum Nexus registration pending review',
    templateId: 'registration_pending_admin_approval',
    payload: { name: 'Jordan Pending' },
    status: 'sent',
    attempts: 1,
    lastError: null,
    minutesAgo: 80,
  });
  insertOutbox({
    to: 'provider-identity@example.com',
    subject: 'Policy exception request needs review',
    templateId: 'policy_exception_created',
    payload: { providerEmail: 'provider-identity@example.com' },
    status: 'failed',
    attempts: 5,
    lastError: 'SMTP connection refused in local demo mode',
    minutesAgo: 90,
  });

  insertAudit({
    actorId: adminId,
    actorEmail: 'admin@example.com',
    action: 'admin.registration_update',
    targetType: 'settings',
    targetId: 'registration',
    after: { registrationRequiresAdminApproval: true },
    minutesAgo: 300,
  });
  insertAudit({
    actorId: adminId,
    actorEmail: 'admin@example.com',
    action: 'provider.api_publish',
    targetType: 'api_asset',
    targetId: ids.paymentsApi,
    after: { title: 'Payments Ledger API', lifecycle: 'published' },
    minutesAgo: 4300,
  });
  insertAudit({
    actorId: ids.providerIdentity,
    actorEmail: 'provider-identity@example.com',
    action: 'provider.api_publish',
    targetType: 'api_asset',
    targetId: ids.identityApi,
    after: { title: 'Identity Verification API', lifecycle: 'published' },
    minutesAgo: 3900,
  });
  insertAudit({
    actorId: ids.clientBeta,
    actorEmail: 'client-beta@example.com',
    action: 'access_request.create',
    targetType: 'access_request',
    targetId: ids.reqClientPayments,
    after: { apiAssetId: ids.paymentsApi, status: 'pending' },
    minutesAgo: 55,
  });
  insertAudit({
    actorId: adminId,
    actorEmail: 'admin@example.com',
    action: 'access_request.approve',
    targetType: 'access_request',
    targetId: ids.reqClientEvents,
    after: { apiAssetId: ids.eventsApi, status: 'approved' },
    minutesAgo: 920,
  });
  insertAudit({
    actorId: adminId,
    actorEmail: 'admin@example.com',
    action: 'credential.create',
    targetType: 'credential',
    targetId: ids.adminKeyCredential,
    after: { type: 'keyauth', label: 'Browser demo key' },
    minutesAgo: 700,
  });
  insertAudit({
    actorId: adminId,
    actorEmail: 'admin@example.com',
    action: 'policy.update',
    targetType: 'governance_policy',
    targetId: '4',
    after: { version: 4, rules: 5 },
    minutesAgo: 260,
  });
  insertAudit({
    actorId: adminId,
    actorEmail: 'admin@example.com',
    action: 'admin.mass_email',
    targetType: 'mass_email',
    targetId: ids.campaign,
    after: { queued: 4, filter: { role: 'client', status: 'active' } },
    minutesAgo: 1440,
  });

  return adminId;
});

const adminId = tx();
const counts = {
  users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
  apis: db.prepare('SELECT COUNT(*) AS count FROM api_assets').get().count,
  requests: db.prepare('SELECT COUNT(*) AS count FROM access_requests').get().count,
  grants: db.prepare('SELECT COUNT(*) AS count FROM access_grants').get().count,
  conversations: db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count,
  notificationsForAdmin: db
    .prepare('SELECT COUNT(*) AS count FROM notifications WHERE recipient_id = ? AND read_at IS NULL')
    .get(adminId).count,
  policyExceptionsPending: db
    .prepare("SELECT COUNT(*) AS count FROM policy_exception_requests WHERE status = 'pending'")
    .get().count,
};

console.log(JSON.stringify({ dbPath, adminId, password, counts }, null, 2));
