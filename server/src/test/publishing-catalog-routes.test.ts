import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { v4 as uuid } from 'uuid';
import type { ApiAsset, ApiAssetWithProvider } from '@ferrum-nexus/shared';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE_NAME } from '@ferrum-nexus/shared';
import type { ResolvedConfig } from '../config/index.js';
import { registerErrorHandler } from '../middleware/error-handler.js';
import { registerAuthPlugin } from '../middleware/auth-plugin.js';
import { createSessionService } from '../auth/session.js';
import { createSqliteStore } from '../db/adapters/sqlite/index.js';
import type { NexusStore } from '../db/store.js';
import { createAuditService } from '../audit/service.js';
import { createCatalogService } from '../api-catalog/service.js';
import { createPublishingService } from '../api-publishing/service.js';
import { createCredentialsService } from '../credentials/service.js';
import { createAccessRequestsService } from '../access-requests/service.js';
import { createGrantsService } from '../grants/service.js';
import { createMessagingService } from '../messaging/service.js';
import { createNotificationService } from '../notifications/service.js';
import type { EmailService } from '../email/service.js';
import { registerCatalogRoutes } from '../routes/catalog.js';
import { registerProviderRoutes } from '../routes/provider.js';
import {
  createCountingFerrumAdminClient,
  type CountingFerrumAdminClient,
} from './helpers/ferrum-admin.js';

interface Harness {
  app: FastifyInstance;
  store: NexusStore;
  ferrum: CountingFerrumAdminClient;
  providerId: string;
  authHeaders: Record<string, string>;
  close(): Promise<void>;
}

interface AssetResponse {
  asset: ApiAssetWithProvider;
}

interface ProviderAssetResponse {
  asset: ApiAsset;
}

interface CatalogListResponse {
  items: ApiAssetWithProvider[];
  total: number;
}

interface SpecResponse {
  assetId: string;
  version?: string;
  rawSpec: string | null;
}

const noopEmail: EmailService = {
  async enqueue() {},
  async flushOnce() {
    return 0;
  },
  startWorker() {
    return { stop() {} };
  },
  async seedTemplates() {},
};

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
    session: { cookieName: SESSION_COOKIE_NAME, ttlSeconds: 600, secure: false },
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

function spec(version: string, extraPath = false): string {
  return JSON.stringify(
    {
      openapi: '3.0.3',
      info: {
        title: 'Orders API',
        version,
        description: 'Manage orders.',
        contact: { email: 'orders-support@example.com' },
      },
      servers: [{ url: 'https://api.example.com' }],
      tags: [{ name: 'orders' }],
      paths: {
        '/orders': {
          get: {
            operationId: 'listOrders',
            responses: { '200': { description: 'ok' } },
          },
        },
        ...(extraPath
          ? {
              '/orders/{id}': {
                get: {
                  operationId: 'getOrder',
                  responses: { '200': { description: 'ok' } },
                },
              },
            }
          : {}),
      },
      'x-ferrum-proxy': {
        proxy_id: 'orders-proxy',
        paths: ['/orders'],
        upstream_url: 'https://orders.internal.example.com',
      },
    },
    null,
    2,
  );
}

async function createHarness(): Promise<Harness> {
  const config = makeConfig();
  const store = await createSqliteStore(config);
  await store.migrate();
  const providerId = uuid();
  await store.users.insert({
    id: providerId,
    email: 'provider@example.com',
    email_normalized: 'provider@example.com',
    name: 'Provider User',
    phone: null,
    status: 'active',
    email_verified_at: new Date().toISOString(),
    password_hash: 'hash',
    last_login_at: null,
    failed_login_count: 0,
    organization_id: null,
  });
  await store.userRoles.add(providerId, 'provider');

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const sessions = createSessionService(config, store);
  const audit = createAuditService(store);
  const notifications = createNotificationService(store);
  const ferrum = createCountingFerrumAdminClient();
  const catalog = createCatalogService(store);
  const publishing = createPublishingService(config, store, ferrum, audit);
  const credentials = createCredentialsService(
    config,
    store,
    ferrum,
    audit,
    notifications,
    noopEmail,
  );
  const accessRequests = createAccessRequestsService(
    config,
    store,
    credentials,
    audit,
    notifications,
    noopEmail,
  );
  const grants = createGrantsService(store);
  const messaging = createMessagingService(store, notifications, noopEmail);

  registerErrorHandler(app);
  registerAuthPlugin(app, sessions);
  await registerCatalogRoutes(app, { catalog, accessRequests, store });
  await registerProviderRoutes(app, {
    publishing,
    catalog,
    accessRequests,
    grants,
    credentials,
    messaging,
    store,
  });

  const session = await sessions.createSession({
    userId: providerId,
    userAgent: 'node-test',
    ip: '127.0.0.1',
  });
  const authHeaders = {
    cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}; ${CSRF_COOKIE}=${session.csrfToken}`,
    [CSRF_HEADER]: session.csrfToken,
  };

  return {
    app,
    store,
    ferrum,
    providerId,
    authHeaders,
    async close() {
      await app.close();
      await store.close();
    },
  };
}

async function publishViaRoute(harness: Harness, rawSpec: string): Promise<ApiAsset> {
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/provider/apis',
    headers: { ...harness.authHeaders, 'content-type': 'application/json' },
    payload: JSON.stringify({
      rawSpec,
      visibility: 'public',
      requestable: false,
      lifecycle: 'published',
    }),
  });
  assert.equal(res.statusCode, 201, res.body);
  return (JSON.parse(res.body) as ProviderAssetResponse).asset;
}

test('provider publish and replace routes persist raw specs and count Gateway Admin API mutations', async () => {
  const harness = await createHarness();
  try {
    const initialSpec = spec('1.0.0');
    const asset = await publishViaRoute(harness, initialSpec);
    assert.equal(asset.providerId, harness.providerId);
    assert.equal(asset.title, 'Orders API');
    assert.equal(asset.version, '1.0.0');
    assert.equal(asset.proxyId, 'orders-proxy');
    assert.equal(harness.ferrum.count('createApiSpec'), 1);
    assert.equal(harness.ferrum.count('replaceApiSpec'), 0);
    assert.equal(harness.ferrum.count('upsertPlugin'), 0);

    const firstVersion = await harness.store.apiSpecVersions.latestForAsset(asset.id);
    assert.equal(firstVersion?.raw_spec, initialSpec);

    const nextSpec = spec('1.1.0', true);
    const replaceRes = await harness.app.inject({
      method: 'PUT',
      url: `/api/provider/apis/${asset.id}/spec`,
      headers: { ...harness.authHeaders, 'content-type': 'application/json' },
      payload: JSON.stringify({ rawSpec: nextSpec }),
    });
    assert.equal(replaceRes.statusCode, 200, replaceRes.body);
    const replaced = (JSON.parse(replaceRes.body) as ProviderAssetResponse).asset;
    assert.equal(replaced.version, '1.1.0');
    assert.equal(replaced.operationCount, 2);
    assert.equal(harness.ferrum.count('replaceApiSpec'), 1);

    const latest = await harness.store.apiSpecVersions.latestForAsset(asset.id);
    assert.equal(latest?.version, '1.1.0');
    assert.equal(latest?.raw_spec, nextSpec);
  } finally {
    await harness.close();
  }
});

test('catalog list, detail, and raw spec routes read from Nexus storage without Gateway Admin API calls', async () => {
  const harness = await createHarness();
  try {
    const rawSpec = spec('1.0.0');
    const asset = await publishViaRoute(harness, rawSpec);
    harness.ferrum.resetCalls();

    const listRes = await harness.app.inject({
      method: 'GET',
      url: '/api/catalog/apis?search=orders&limit=20',
      headers: harness.authHeaders,
    });
    assert.equal(listRes.statusCode, 200, listRes.body);
    const list = JSON.parse(listRes.body) as CatalogListResponse;
    assert.equal(list.total, 1);
    assert.equal(list.items[0]?.id, asset.id);

    const detailRes = await harness.app.inject({
      method: 'GET',
      url: `/api/catalog/apis/${asset.id}`,
      headers: harness.authHeaders,
    });
    assert.equal(detailRes.statusCode, 200, detailRes.body);
    const detail = JSON.parse(detailRes.body) as AssetResponse;
    assert.equal(detail.asset.providerName, 'Provider User');

    const specRes = await harness.app.inject({
      method: 'GET',
      url: `/api/catalog/apis/${asset.id}/spec`,
      headers: harness.authHeaders,
    });
    assert.equal(specRes.statusCode, 200, specRes.body);
    const raw = JSON.parse(specRes.body) as SpecResponse;
    assert.equal(raw.assetId, asset.id);
    assert.equal(raw.version, '1.0.0');
    assert.equal(raw.rawSpec, rawSpec);

    assert.equal(harness.ferrum.count(), 0);
  } finally {
    await harness.close();
  }
});

test('invalid and unsafe OpenAPI specs are rejected before any Gateway Admin API mutation', async () => {
  const harness = await createHarness();
  try {
    const unsupportedVersion = JSON.stringify({
      swagger: '2.0',
      info: { title: 'Legacy API', version: '1.0.0' },
      paths: {},
    });
    const unsupportedRes = await harness.app.inject({
      method: 'POST',
      url: '/api/provider/apis',
      headers: { ...harness.authHeaders, 'content-type': 'application/json' },
      payload: JSON.stringify({ rawSpec: unsupportedVersion }),
    });
    assert.equal(unsupportedRes.statusCode, 400, unsupportedRes.body);
    assert.equal(harness.ferrum.count('createApiSpec'), 0);

    const externalRef = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Unsafe API', version: '1.0.0' },
      paths: {},
      'x-ferrum-proxy': { proxy_id: 'unsafe-proxy', paths: ['/unsafe'] },
      components: {
        schemas: {
          Unsafe: { $ref: '//attacker.example/schema.json' },
        },
      },
    });
    const externalRefRes = await harness.app.inject({
      method: 'POST',
      url: '/api/provider/apis',
      headers: { ...harness.authHeaders, 'content-type': 'application/json' },
      payload: JSON.stringify({ rawSpec: externalRef }),
    });
    assert.equal(externalRefRes.statusCode, 400, externalRefRes.body);
    assert.equal(harness.ferrum.count('createApiSpec'), 0);
  } finally {
    await harness.close();
  }
});
