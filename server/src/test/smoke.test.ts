/**
 * Smoke test for the SQLite store. Runs against an in-memory SQLite database
 * and exercises the core lifecycle: register a user, attach a role, create a
 * notification, list users, and verify counts.
 *
 * Run with: `npm test --workspace server`
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { v4 as uuid } from 'uuid';
import { createSqliteStore } from '../db/adapters/sqlite/index.js';
import type { ResolvedConfig } from '../config/index.js';

const config: ResolvedConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  publicUrl: 'http://127.0.0.1:8787',
  corsOrigins: '',
  trustProxy: false,
  secretKey: 'a'.repeat(64),
  db: { driver: 'sqlite', url: ':memory:' },
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

test('sqlite store: end-to-end user + notification lifecycle', async () => {
  const store = await createSqliteStore(config);
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

test('sqlite store: api asset round trip', async () => {
  const store = await createSqliteStore(config);
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

test('users.listFiltered filters by role and status', async () => {
  const store = await createSqliteStore(config);
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

test('email outbox claim transitions pending → sending exactly once', async () => {
  const store = await createSqliteStore(config);
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
