import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Logger } from 'pino';
import type { FerrumAdminClient } from '../ferrum-admin/client.js';
import { createCachingFerrumAdminClient } from '../ferrum-admin/cache/caching-client.js';
import { createLruBackend } from '../ferrum-admin/cache/lru-backend.js';

const logger = { warn() {}, info() {} } as unknown as Logger;

test('Ferrum cache serves reads and invalidates list on mutation', async () => {
  let listCalls = 0;
  const inner: FerrumAdminClient = {
    async health() {
      return { ok: true };
    },
    async listNamespaces() {
      return ['default'];
    },
    async listApiSpecs() {
      listCalls++;
      return [{ api_spec_id: 'spec-1', proxy_id: 'proxy-1', title: 'API', version: '1' }];
    },
    async getApiSpec() {
      return null;
    },
    async getApiSpecRaw() {
      return null;
    },
    async createApiSpec() {
      return { api_spec_id: 'spec-2', proxy_id: 'proxy-2', title: 'Next', version: '1' };
    },
    async replaceApiSpec() {
      return { api_spec_id: 'spec-1', proxy_id: 'proxy-1', title: 'API', version: '2' };
    },
    async deleteApiSpec() {},
    async getConsumer() {
      return null;
    },
    async createConsumer() {
      return { consumer_id: 'consumer-1', username: 'u' };
    },
    async updateConsumer() {
      return { consumer_id: 'consumer-1', username: 'u' };
    },
    async deleteConsumer() {},
    async appendCredential() {
      return { index: 0, type: 'keyauth' };
    },
    async deleteCredential() {},
    async upsertPlugin(payload) {
      return payload;
    },
    async deletePlugin() {},
  };
  const client = createCachingFerrumAdminClient(inner, {
    backend: createLruBackend({ max: 100 }),
    logger,
    ttls: {
      apiSpec: 60_000,
      apiSpecList: 60_000,
      apiSpecRaw: 60_000,
      consumer: 60_000,
      namespaces: 60_000,
      health: 60_000,
      negative: 1_000,
    },
  });

  await client.listApiSpecs('default');
  await client.listApiSpecs('default');
  assert.equal(listCalls, 1);

  await client.createApiSpec('{}', 'application/json', 'default');
  await client.listApiSpecs('default');
  assert.equal(listCalls, 2);
});

