/**
 * Smoke tests for every persistence adapter.
 *
 * SQLite always runs (in-memory). The other adapters opt in via env vars so
 * CI can wire them up against ephemeral services without requiring all of
 * them to be present on every developer laptop:
 *
 *   - NEXUS_TEST_POSTGRES_URL  (e.g. postgres://test:test@127.0.0.1:5432/nexus_test)
 *   - NEXUS_TEST_MYSQL_URL     (e.g. mysql://test:test@127.0.0.1:3306/nexus_test)
 *   - NEXUS_TEST_MONGO_URL     (must be a replica set; set NEXUS_DB_ALLOW_STANDALONE=true to relax)
 *
 * Each adapter runs the same lifecycle suite so any divergence in
 * placeholder rewriting, ILIKE/UPSERT translation, or JSON serialization
 * surfaces here instead of in production.
 *
 * Run with: `npm test --workspace server`
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { v4 as uuid } from 'uuid';
import type { NexusStore } from '../db/store.js';
import type { ResolvedConfig } from '../config/index.js';
import { createSqliteStore } from '../db/adapters/sqlite/index.js';

function makeConfig(overrides: Partial<ResolvedConfig['db']>): ResolvedConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:8787',
    corsOrigins: '',
    trustProxy: false,
    secretKey: 'a'.repeat(64),
    db: { driver: 'sqlite', url: ':memory:', requireReplicaSet: true, ...overrides },
    session: { cookieName: 'nexus_sid', ttlSeconds: 600, secure: false },
    ferrum: {
      adminUrl: 'http://127.0.0.1:8000',
      jwtSecret: 'b'.repeat(32),
      jwtIssuer: 'test',
      jwtSubject: 'test',
      jwtRole: 'admin',
      jwtTtl: 60,
      defaultNamespace: 'default',
    },
    email: {
      from: 'noreply@example.com',
      smtpPort: 587,
      smtpSecure: false,
    },
  };
}

type Adapter = {
  name: string;
  factory: () => Promise<NexusStore>;
};

async function loadAdapters(): Promise<Adapter[]> {
  const adapters: Adapter[] = [
    {
      name: 'sqlite',
      factory: async () => createSqliteStore(makeConfig({ driver: 'sqlite', url: ':memory:' })),
    },
  ];
  if (process.env.NEXUS_TEST_POSTGRES_URL) {
    const { createPostgresStore } = await import('../db/adapters/postgres/index.js');
    adapters.push({
      name: 'postgres',
      factory: async () =>
        createPostgresStore(
          makeConfig({ driver: 'postgres', url: process.env.NEXUS_TEST_POSTGRES_URL }),
        ),
    });
  }
  if (process.env.NEXUS_TEST_MYSQL_URL) {
    const { createMysqlStore } = await import('../db/adapters/mysql/index.js');
    adapters.push({
      name: 'mysql',
      factory: async () =>
        createMysqlStore(makeConfig({ driver: 'mysql', url: process.env.NEXUS_TEST_MYSQL_URL })),
    });
  }
  if (process.env.NEXUS_TEST_MONGO_URL) {
    const { createMongoStore } = await import('../db/adapters/mongodb/index.js');
    adapters.push({
      name: 'mongodb',
      factory: async () =>
        createMongoStore(
          makeConfig({
            driver: 'mongodb',
            url: process.env.NEXUS_TEST_MONGO_URL,
            requireReplicaSet: process.env.NEXUS_DB_ALLOW_STANDALONE !== 'true',
          }),
        ),
    });
  }
  return adapters;
}

const adapters = await loadAdapters();

for (const adapter of adapters) {
  test(`[${adapter.name}] end-to-end user + notification lifecycle`, async () => {
    const store = await adapter.factory();
    await store.migrate();
    try {
      const userId = uuid();
      const otherUserId = uuid();
      await store.users.insert({
        id: userId,
        email: 'alice@example.com',
        email_normalized: 'alice@example.com',
        name: 'Alice',
        phone: null,
        status: 'active',
        email_verified_at: new Date().toISOString(),
        password_hash: 'hash',
        last_login_at: null,
        failed_login_count: 0,
        organization_id: null,
      });
      await store.users.insert({
        id: otherUserId,
        email: 'mallory@example.com',
        email_normalized: 'mallory@example.com',
        name: 'Mallory',
        phone: null,
        status: 'active',
        email_verified_at: new Date().toISOString(),
        password_hash: 'hash',
        last_login_at: null,
        failed_login_count: 0,
        organization_id: null,
      });
      await store.userRoles.add(userId, 'client');

      const found = await store.users.findByEmail('alice@example.com');
      assert.ok(found, 'user should exist');
      assert.equal(found.email, 'alice@example.com');

      const roles = await store.userRoles.forUser(userId);
      assert.deepEqual(roles, ['client']);

      const notificationId = uuid();
      await store.notifications.insert({
        id: notificationId,
        recipient_id: userId,
        type: 'registration_confirmed',
        payload: { test: true },
        read_at: null,
        created_at: new Date().toISOString(),
      });
      const unread = await store.notifications.unreadCount(userId);
      assert.equal(unread, 1);
      assert.equal(
        await store.notifications.markRead(notificationId, otherUserId, new Date().toISOString()),
        0,
      );
      assert.equal(await store.notifications.unreadCount(userId), 1);
      assert.equal(
        await store.notifications.markRead(notificationId, userId, new Date().toISOString()),
        1,
      );
      assert.equal(await store.notifications.unreadCount(userId), 0);

      const list = await store.users.list({ limit: 10 });
      assert.equal(list.total, 2);
    } finally {
      await store.close();
    }
  });

  test(`[${adapter.name}] user search is case-insensitive`, async () => {
    const store = await adapter.factory();
    await store.migrate();
    try {
      await store.users.insert({
        id: uuid(),
        email: 'CamelCase@Example.com',
        email_normalized: 'camelcase@example.com',
        name: 'CamelCase User',
        phone: null,
        status: 'active',
        email_verified_at: null,
        password_hash: 'h',
        last_login_at: null,
        failed_login_count: 0,
        organization_id: null,
      });
      // Search uses ILIKE on Postgres and LOWER()-based LIKE on MySQL/SQLite.
      // Both should resolve to the same row regardless of how the caller
      // capitalizes the query.
      const upper = await store.users.list({ search: 'CAMEL', limit: 10 });
      const lower = await store.users.list({ search: 'camel', limit: 10 });
      assert.equal(upper.total, 1);
      assert.equal(lower.total, 1);
    } finally {
      await store.close();
    }
  });

  test(`[${adapter.name}] api asset round trip preserves JSON columns`, async () => {
    const store = await adapter.factory();
    await store.migrate();
    try {
      const userId = uuid();
      await store.users.insert({
        id: userId,
        email: 'provider@example.com',
        email_normalized: 'provider@example.com',
        name: 'Provider',
        phone: null,
        status: 'active',
        email_verified_at: new Date().toISOString(),
        password_hash: 'hash',
        last_login_at: null,
        failed_login_count: 0,
        organization_id: null,
      });

      const assetId = uuid();
      const now = new Date().toISOString();
      await store.apiAssets.insert({
        id: assetId,
        api_spec_id: 'spec-1',
        proxy_id: 'proxy-1',
        namespace: 'default',
        provider_id: userId,
        title: 'Orders API',
        description: 'Manages orders',
        slug: 'orders-api-1-0',
        version: '1.0.0',
        visibility: 'public',
        requestable: 1,
        lifecycle: 'published',
        tags: ['orders', 'commerce'],
        contact_email: 'api@example.com',
        support_notes: null,
        operation_count: 12,
        content_hash: 'abc',
        created_at: now,
        updated_at: now,
      });
      const fetched = await store.apiAssets.findById(assetId);
      assert.ok(fetched);
      assert.equal(fetched.title, 'Orders API');
      assert.deepEqual(fetched.tags, ['orders', 'commerce']);
      assert.equal(fetched.requestable, 1);

      const updated = await store.apiAssets.update(assetId, {
        title: 'Orders API v2',
        requestable: 0,
      });
      assert.equal(updated.title, 'Orders API v2');
      assert.equal(updated.requestable, 0);
    } finally {
      await store.close();
    }
  });

  test(`[${adapter.name}] email outbox claim transitions pending → sending exactly once`, async () => {
    const store = await adapter.factory();
    await store.migrate();
    try {
      const id = uuid();
      const now = new Date().toISOString();
      await store.email.enqueue({
        id,
        to_address: 'x@example.com',
        subject: 's',
        template_id: null,
        payload: {},
        status: 'pending',
        attempts: 0,
        last_error: null,
        scheduled_at: now,
        sent_at: null,
        created_at: now,
        idempotency_key: null,
        headers: null,
      });
      const first = await store.email.claimBatch(now, 10);
      assert.equal(first.length, 1);
      assert.equal(first[0]!.status, 'sending');
      // A second worker polling the same instant must not re-claim it.
      const second = await store.email.claimBatch(now, 10);
      assert.equal(second.length, 0);
    } finally {
      await store.close();
    }
  });

  test(`[${adapter.name}] email enqueue with idempotency key is a no-op on replay`, async () => {
    const store = await adapter.factory();
    await store.migrate();
    try {
      const now = new Date().toISOString();
      const row = {
        to_address: 'x@example.com',
        subject: 's',
        template_id: null,
        payload: {},
        status: 'pending' as const,
        attempts: 0,
        last_error: null,
        scheduled_at: now,
        sent_at: null,
        created_at: now,
        idempotency_key: 'dedup-key-1',
        headers: null,
      };
      await store.email.enqueue({ ...row, id: uuid() });
      // Second call with same key should not insert another row.
      await store.email.enqueue({ ...row, id: uuid() });
      const failed = await store.email.listFailed({ limit: 50 });
      assert.equal(failed.total, 0);
      // Confirm only one pending row exists for that address.
      const claim = await store.email.claimBatch(now, 10);
      assert.equal(claim.length, 1);
      const second = await store.email.claimBatch(now, 10);
      assert.equal(second.length, 0);
    } finally {
      await store.close();
    }
  });

  test(`[${adapter.name}] password reset throttle counter`, async () => {
    const store = await adapter.factory();
    await store.migrate();
    try {
      const userId = uuid();
      await store.users.insert({
        id: userId,
        email: 'pw@example.com',
        email_normalized: 'pw@example.com',
        name: null,
        phone: null,
        status: 'active',
        email_verified_at: null,
        password_hash: 'h',
        last_login_at: null,
        failed_login_count: 0,
        organization_id: null,
      });
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      assert.equal(await store.verifications.countRecentPasswordResets(userId, since), 0);
      await store.verifications.createPasswordReset({
        token: uuid(),
        user_id: userId,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        consumed_at: null,
      });
      await store.verifications.createPasswordReset({
        token: uuid(),
        user_id: userId,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        consumed_at: null,
      });
      assert.equal(await store.verifications.countRecentPasswordResets(userId, since), 2);
    } finally {
      await store.close();
    }
  });

  test(`[${adapter.name}] users.listFiltered filters by role and status`, async () => {
    const store = await adapter.factory();
    await store.migrate();
    try {
      const provider = uuid();
      const client = uuid();
      const pending = uuid();
      for (const [id, status] of [
        [provider, 'active'],
        [client, 'active'],
        [pending, 'pending'],
      ] as const) {
        await store.users.insert({
          id,
          email: `${id}@example.com`,
          email_normalized: `${id}@example.com`,
          name: null,
          phone: null,
          status,
          email_verified_at: null,
          password_hash: 'h',
          last_login_at: null,
          failed_login_count: 0,
          organization_id: null,
        });
      }
      await store.userRoles.add(provider, 'provider');
      await store.userRoles.add(client, 'client');
      await store.userRoles.add(pending, 'client');

      const allClients = await store.users.listFiltered({ role: 'client', limit: 50 });
      assert.equal(allClients.total, 2);
      const activeClients = await store.users.listFiltered({
        role: 'client',
        status: 'active',
        limit: 50,
      });
      assert.equal(activeClients.total, 1);
      assert.equal(activeClients.rows[0]!.id, client);
      const providers = await store.users.listFiltered({ role: 'provider', limit: 50 });
      assert.equal(providers.total, 1);
      assert.equal(providers.rows[0]!.id, provider);
    } finally {
      await store.close();
    }
  });
}
