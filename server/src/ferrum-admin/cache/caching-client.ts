import type { Logger } from 'pino';
import type {
  FerrumAdminClient,
  FerrumApiSpec,
  FerrumConsumer,
  FerrumCredential,
  FerrumPlugin,
} from '../client.js';
import type { CredentialType } from '@ferrum-nexus/shared';
import type { FerrumCacheBackend, FerrumCacheTtls } from './types.js';

export interface CachingFerrumAdminClient extends FerrumAdminClient {
  invalidate(type: 'apiSpec' | 'apiSpecList' | 'apiSpecRaw' | 'consumer' | 'namespaces' | 'health', namespace?: string, id?: string): Promise<void>;
  invalidateNamespace(namespace?: string): Promise<void>;
  purge(): Promise<void>;
  refresh(): Promise<void>;
}

const nsKey = (namespace?: string): string => namespace ?? '_';

const keys = {
  health: 'health|_',
  namespaces: 'namespaces|_',
  apiSpecList: (namespace?: string) => `apiSpecList|${nsKey(namespace)}`,
  apiSpec: (namespace: string | undefined, id: string) => `apiSpec|${nsKey(namespace)}|${id}`,
  apiSpecRaw: (namespace: string | undefined, id: string) => `apiSpecRaw|${nsKey(namespace)}|${id}`,
  consumer: (namespace: string | undefined, id: string) => `consumer|${nsKey(namespace)}|${id}`,
};

export function createCachingFerrumAdminClient(
  inner: FerrumAdminClient,
  opts: { backend: FerrumCacheBackend; ttls: FerrumCacheTtls; logger: Logger },
): CachingFerrumAdminClient {
  const { backend, ttls, logger } = opts;

  async function cached<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
    negativeTtlMs = ttls.negative,
  ): Promise<T> {
    const hit = await backend.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await load();
    await backend.set(key, value, value === null ? negativeTtlMs : ttlMs);
    return value;
  }

  async function invalidate(
    type: Parameters<CachingFerrumAdminClient['invalidate']>[0],
    namespace?: string,
    id?: string,
  ): Promise<void> {
    switch (type) {
      case 'health':
        await backend.delete(keys.health);
        return;
      case 'namespaces':
        await backend.delete(keys.namespaces);
        return;
      case 'apiSpecList':
        await backend.delete(keys.apiSpecList(namespace));
        return;
      case 'apiSpec':
        if (id) await backend.delete(keys.apiSpec(namespace, id));
        return;
      case 'apiSpecRaw':
        if (id) await backend.delete(keys.apiSpecRaw(namespace, id));
        return;
      case 'consumer':
        if (id) await backend.delete(keys.consumer(namespace, id));
        return;
    }
  }

  const client: CachingFerrumAdminClient = {
    async health() {
      return cached(keys.health, ttls.health, () => inner.health());
    },
    async listNamespaces() {
      return cached(keys.namespaces, ttls.namespaces, () => inner.listNamespaces());
    },
    async listApiSpecs(namespace?: string) {
      return cached(keys.apiSpecList(namespace), ttls.apiSpecList, () => inner.listApiSpecs(namespace));
    },
    async getApiSpec(apiSpecId: string, namespace?: string) {
      return cached<FerrumApiSpec | null>(
        keys.apiSpec(namespace, apiSpecId),
        ttls.apiSpec,
        () => inner.getApiSpec(apiSpecId, namespace),
      );
    },
    async getApiSpecRaw(apiSpecId: string, namespace?: string) {
      return cached<string | null>(
        keys.apiSpecRaw(namespace, apiSpecId),
        ttls.apiSpecRaw,
        () => inner.getApiSpecRaw(apiSpecId, namespace),
      );
    },
    async createApiSpec(rawSpec, contentType, namespace) {
      const created = await inner.createApiSpec(rawSpec, contentType, namespace);
      await Promise.all([backend.delete(keys.apiSpecList(namespace)), backend.delete(keys.health)]);
      return created;
    },
    async replaceApiSpec(apiSpecId, rawSpec, contentType, namespace) {
      const updated = await inner.replaceApiSpec(apiSpecId, rawSpec, contentType, namespace);
      await Promise.all([
        backend.delete(keys.apiSpec(namespace, apiSpecId)),
        backend.delete(keys.apiSpecRaw(namespace, apiSpecId)),
        backend.delete(keys.apiSpecList(namespace)),
      ]);
      return updated;
    },
    async deleteApiSpec(apiSpecId, namespace) {
      await inner.deleteApiSpec(apiSpecId, namespace);
      await Promise.all([
        backend.delete(keys.apiSpec(namespace, apiSpecId)),
        backend.delete(keys.apiSpecRaw(namespace, apiSpecId)),
        backend.delete(keys.apiSpecList(namespace)),
      ]);
    },
    async getConsumer(consumerId, namespace) {
      return cached<FerrumConsumer | null>(
        keys.consumer(namespace, consumerId),
        ttls.consumer,
        () => inner.getConsumer(consumerId, namespace),
      );
    },
    async createConsumer(payload) {
      const created = await inner.createConsumer(payload);
      const id = created.consumer_id || created.username;
      await backend.delete(keys.consumer(payload.namespace, id));
      return created;
    },
    async updateConsumer(consumerId, fields, namespace) {
      const updated = await inner.updateConsumer(consumerId, fields, namespace);
      await backend.delete(keys.consumer(namespace, consumerId));
      return updated;
    },
    async deleteConsumer(consumerId, namespace) {
      await inner.deleteConsumer(consumerId, namespace);
      await backend.delete(keys.consumer(namespace, consumerId));
    },
    async appendCredential(consumerId: string, payload: FerrumCredential, namespace?: string) {
      const result = await inner.appendCredential(consumerId, payload, namespace);
      await backend.delete(keys.consumer(namespace, consumerId));
      return result;
    },
    async deleteCredential(
      consumerId: string,
      type: CredentialType,
      index: number,
      namespace?: string,
    ) {
      await inner.deleteCredential(consumerId, type, index, namespace);
      await backend.delete(keys.consumer(namespace, consumerId));
    },
    async upsertPlugin(payload: FerrumPlugin, namespace?: string) {
      const plugin = await inner.upsertPlugin(payload, namespace);
      await backend.deletePrefix(`apiSpec|${nsKey(namespace)}|`);
      await backend.delete(keys.apiSpecList(namespace));
      return plugin;
    },
    async deletePlugin(pluginId: string, namespace?: string) {
      await inner.deletePlugin(pluginId, namespace);
      await backend.deletePrefix(`apiSpec|${nsKey(namespace)}|`);
      await backend.delete(keys.apiSpecList(namespace));
    },
    invalidate,
    async invalidateNamespace(namespace) {
      await Promise.all([
        backend.delete(keys.apiSpecList(namespace)),
        backend.deletePrefix(`apiSpec|${nsKey(namespace)}|`),
        backend.deletePrefix(`apiSpecRaw|${nsKey(namespace)}|`),
        backend.deletePrefix(`consumer|${nsKey(namespace)}|`),
      ]);
    },
    async purge() {
      await backend.clear();
    },
    async refresh() {
      await backend.clear();
      await client.health().catch((err) => logger.warn({ err }, 'failed warming Ferrum health cache'));
      const namespaces = await client
        .listNamespaces()
        .catch((err) => {
          logger.warn({ err }, 'failed warming Ferrum namespace cache');
          return [] as string[];
        });
      for (const namespace of namespaces) {
        await client
          .listApiSpecs(namespace)
          .catch((err) => logger.warn({ err, namespace }, 'failed warming Ferrum API spec cache'));
      }
    },
  };

  return client;
}

