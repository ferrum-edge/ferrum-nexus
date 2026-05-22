import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ResolvedConfig } from '../config/index.js';
import { createAuditService } from '../audit/service.js';
import { createSqliteStore } from '../db/adapters/sqlite/index.js';
import { createPolicyService } from '../governance/policy-service.js';

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

test('policy service reports required field and plugin violations', async () => {
  const store = await createSqliteStore(config());
  try {
    const policy = createPolicyService(store, createAuditService(store));
    await policy.set({
      rules: [
        {
          id: 'info.contact.email.required',
          description: 'Contact email is required',
          severity: 'error',
          exceptionEligible: true,
          kind: 'required_field',
          params: { path: 'info.contact.email' },
        },
        {
          id: 'proxy.rate-limit.required',
          description: 'Rate limiting is required',
          severity: 'error',
          exceptionEligible: false,
          kind: 'plugin_required',
          params: { name: 'rate_limiting' },
        },
      ],
    });

    const result = await policy.evaluate(`{
      "openapi": "3.0.0",
      "info": { "title": "x", "version": "1" },
      "paths": {},
      "x-ferrum-proxy": { "proxy_id": "p", "paths": ["/x"] }
    }`);

    assert.deepEqual(result.blocking.map((v) => v.ruleId), [
      'info.contact.email.required',
      'proxy.rate-limit.required',
    ]);
  } finally {
    await store.close();
  }
});

