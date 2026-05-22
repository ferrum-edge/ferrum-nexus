import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import argon2 from 'argon2';
import { v4 as uuid } from 'uuid';
import type { ResolvedConfig } from '../config/index.js';
import { createAuditService } from '../audit/service.js';
import { createSqliteStore } from '../db/adapters/sqlite/index.js';
import type { FerrumAdminClient, FerrumCredential } from '../ferrum-admin/client.js';
import type { EmailService } from '../email/service.js';
import { createNotificationService } from '../notifications/service.js';
import { ARGON2_OPTIONS, createUsersService } from '../users/service.js';
import { createCredentialsService } from '../credentials/service.js';

function makeConfig(): ResolvedConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:8787',
    corsOrigins: '',
    trustProxy: false,
    secretKey: 'a'.repeat(64),
    db: { driver: 'sqlite', url: ':memory:', requireReplicaSet: true },
    session: { cookieName: 'nexus_sid', ttlSeconds: 600, secure: false },
    ferrum: {
      adminUrl: 'http://127.0.0.1:8000',
      jwtSecret: 'b'.repeat(32),
      jwtIssuer: 'test',
      jwtSubject: 'test',
      jwtRole: 'admin',
      jwtTtl: 60,
      defaultNamespace: 'default',
      cacheEnabled: true,
      cacheRefreshHours: 12,
      cacheTtls: {
        apiSpec: 300_000,
        apiSpecList: 60_000,
        apiSpecRaw: 300_000,
        consumer: 120_000,
        namespaces: 600_000,
        health: 10_000,
        negative: 15_000,
      },
    },
    email: {
      from: 'noreply@example.com',
      smtpPort: 587,
      smtpSecure: false,
    },
  };
}

const email: EmailService = {
  async enqueue() {},
  async flushOnce() {
    return 0;
  },
  startWorker() {
    return { stop() {} };
  },
  async seedTemplates() {},
};

function createFerrumStub(appended: Array<{ payload: FerrumCredential; namespace?: string }>) {
  return {
    async health() {
      return { ok: true };
    },
    async listNamespaces() {
      return ['default'];
    },
    async listApiSpecs() {
      return [];
    },
    async getApiSpec() {
      return null;
    },
    async getApiSpecRaw() {
      return null;
    },
    async createApiSpec() {
      throw new Error('not used');
    },
    async replaceApiSpec() {
      throw new Error('not used');
    },
    async deleteApiSpec() {},
    async getConsumer() {
      return null;
    },
    async createConsumer(payload: { username: string; acl_groups?: string[]; namespace?: string }) {
      return {
        consumer_id: 'edge-consumer-1',
        username: payload.username,
        acl_groups: payload.acl_groups ?? [],
      };
    },
    async updateConsumer(consumerId: string, fields: Record<string, unknown>) {
      return {
        consumer_id: consumerId,
        username: String(fields.username ?? 'consumer'),
        acl_groups: Array.isArray(fields.acl_groups) ? fields.acl_groups : [],
      };
    },
    async deleteConsumer() {},
    async appendCredential(_consumerId: string, payload: FerrumCredential, namespace?: string) {
      appended.push({ payload, namespace });
      return { index: appended.length - 1, type: payload.type };
    },
    async deleteCredential() {},
    async upsertPlugin(payload: { name: string; config: Record<string, unknown> }) {
      return payload;
    },
    async deletePlugin() {},
  } as unknown as FerrumAdminClient;
}

test('completePasswordReset clears failed login lockout', async () => {
  const config = makeConfig();
  const store = await createSqliteStore(config);
  await store.migrate();
  try {
    const userId = uuid();
    await store.users.insert({
      id: userId,
      email: 'locked@example.com',
      email_normalized: 'locked@example.com',
      name: 'Locked User',
      phone: null,
      status: 'active',
      email_verified_at: new Date().toISOString(),
      password_hash: await argon2.hash('old-password', ARGON2_OPTIONS),
      last_login_at: null,
      failed_login_count: 10,
      organization_id: null,
    });
    const token = uuid();
    await store.verifications.createPasswordReset({
      token,
      user_id: userId,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      consumed_at: null,
    });

    const users = createUsersService(
      config,
      store,
      email,
      createAuditService(store),
      createNotificationService(store),
    );
    await users.completePasswordReset(token, 'new-password');

    const updated = await store.users.findById(userId);
    assert.equal(updated?.failed_login_count, 0);
    const loggedIn = await users.login({ email: 'locked@example.com', password: 'new-password' });
    assert.equal(loggedIn.id, userId);
  } finally {
    await store.close();
  }
});

test('generated Basic and HMAC credentials expose username plus secret', async () => {
  const config = makeConfig();
  const store = await createSqliteStore(config);
  await store.migrate();
  try {
    const userId = uuid();
    await store.users.insert({
      id: userId,
      email: 'client@example.com',
      email_normalized: 'client@example.com',
      name: 'Client User',
      phone: null,
      status: 'active',
      email_verified_at: new Date().toISOString(),
      password_hash: 'hash',
      last_login_at: null,
      failed_login_count: 0,
      organization_id: null,
    });
    const appended: Array<{ payload: FerrumCredential; namespace?: string }> = [];
    const credentials = createCredentialsService(
      config,
      store,
      createFerrumStub(appended),
      createAuditService(store),
      createNotificationService(store),
      email,
    );

    const basic = await credentials.issue({
      userId,
      input: { type: 'basicauth', label: 'Basic', username: 'client-basic' },
    });
    assert.deepEqual(
      basic.secret?.fields?.map((field) => field.field),
      ['username', 'password'],
    );
    assert.equal(basic.secret?.fields?.[0]?.value, 'client-basic');
    assert.equal(basic.secret?.fields?.[1]?.value, appended[0]?.payload.data.password);

    const hmac = await credentials.issue({ userId, input: { type: 'hmac_auth', label: 'HMAC' } });
    assert.deepEqual(
      hmac.secret?.fields?.map((field) => field.field),
      ['username', 'secret'],
    );
    assert.equal(hmac.secret?.fields?.[0]?.value, appended[1]?.payload.data.username);
    assert.equal(hmac.secret?.fields?.[1]?.value, appended[1]?.payload.data.secret);
  } finally {
    await store.close();
  }
});
