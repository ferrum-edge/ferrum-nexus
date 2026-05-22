import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ResolvedConfig } from '../config/index.js';
import type { EmailService } from '../email/service.js';
import { ApiError } from '../lib/errors.js';
import { createAuditService } from '../audit/service.js';
import { createSqliteStore } from '../db/adapters/sqlite/index.js';
import { createNotificationService } from '../notifications/service.js';
import { createUsersService } from '../users/service.js';

function config(): ResolvedConfig {
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
    email: { from: 'noreply@example.com', smtpPort: 587, smtpSecure: false },
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

test('registration allowlist and admin approval gate are enforced', async () => {
  const store = await createSqliteStore(config());
  try {
    await store.settings.set('emailVerificationRequired', false);
    const users = createUsersService(
      config(),
      store,
      email,
      createAuditService(store),
      createNotificationService(store),
    );

    await users.register({
      email: 'admin@example.com',
      password: 'password123',
      desiredRole: 'client',
    });

    await store.settings.set('registrationAllowedEmailDomains', ['example.com']);
    await store.settings.set('registrationRequiresAdminApproval', true);

    await assert.rejects(
      () =>
        users.register({
          email: 'bad@elsewhere.test',
          password: 'password123',
          desiredRole: 'client',
        }),
      (err) => err instanceof ApiError && err.code === 'EMAIL_DOMAIN_NOT_ALLOWED',
    );

    const registered = await users.register({
      email: 'new@example.com',
      password: 'password123',
      desiredRole: 'provider',
    });
    assert.equal(registered.requiresAdminApproval, true);
    assert.equal(registered.user.status, 'pending_admin_approval');

    await assert.rejects(
      () => users.login({ email: 'new@example.com', password: 'password123' }),
      /administrator approval/,
    );

    const approved = await users.approveRegistration(registered.user.id);
    assert.equal(approved.user.status, 'active');
  } finally {
    await store.close();
  }
});

