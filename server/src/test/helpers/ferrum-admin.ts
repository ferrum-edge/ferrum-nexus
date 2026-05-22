import type {
  FerrumAdminClient,
  FerrumApiSpec,
  FerrumConsumer,
  FerrumCredential,
  FerrumPlugin,
} from '../../ferrum-admin/client.js';
import { extractMetadata, parseSpec } from '../../api-publishing/oas.js';

export type FerrumAdminMethodName = keyof FerrumAdminClient;

export interface RecordedFerrumAdminCall {
  method: FerrumAdminMethodName;
  args: readonly unknown[];
}

export interface CountingFerrumAdminClient extends FerrumAdminClient {
  readonly calls: RecordedFerrumAdminCall[];
  readonly apiSpecs: Map<string, FerrumApiSpec>;
  readonly rawSpecs: Map<string, string>;
  readonly consumers: Map<string, FerrumConsumer>;
  readonly plugins: FerrumPlugin[];
  count(method?: FerrumAdminMethodName): number;
  callsFor(method: FerrumAdminMethodName): RecordedFerrumAdminCall[];
  resetCalls(): void;
}

export function createCountingFerrumAdminClient(): CountingFerrumAdminClient {
  const calls: RecordedFerrumAdminCall[] = [];
  const apiSpecs = new Map<string, FerrumApiSpec>();
  const rawSpecs = new Map<string, string>();
  const consumers = new Map<string, FerrumConsumer>();
  const plugins: FerrumPlugin[] = [];
  const credentialCounts = new Map<string, number>();
  let specSeq = 0;
  let consumerSeq = 0;
  let pluginSeq = 0;

  const record = (method: FerrumAdminMethodName, args: readonly unknown[] = []): void => {
    calls.push({ method, args });
  };

  const buildSpec = (
    rawSpec: string,
    namespace: string | undefined,
    apiSpecId = `spec-${++specSeq}`,
  ): FerrumApiSpec => {
    const meta = extractMetadata(rawSpec);
    const parsed = parseSpec(rawSpec);
    const proxyDescriptor = parsed['x-ferrum-proxy'];
    const proxyId =
      proxyDescriptor && typeof proxyDescriptor === 'object'
        ? (proxyDescriptor as Record<string, unknown>).proxy_id
        : null;
    return {
      api_spec_id: apiSpecId,
      proxy_id: typeof proxyId === 'string' && proxyId.length > 0 ? proxyId : `proxy-${apiSpecId}`,
      title: meta.title,
      version: meta.version,
      description: meta.description,
      contact: meta.contact,
      tags: meta.tags,
      servers: meta.servers,
      operation_count: meta.operationCount,
      content_hash: meta.contentHash,
      namespace,
    };
  };

  const client: CountingFerrumAdminClient = {
    calls,
    apiSpecs,
    rawSpecs,
    consumers,
    plugins,
    count(method) {
      return method ? calls.filter((call) => call.method === method).length : calls.length;
    },
    callsFor(method) {
      return calls.filter((call) => call.method === method);
    },
    resetCalls() {
      calls.length = 0;
    },
    async health() {
      record('health');
      return { ok: true };
    },
    async listNamespaces() {
      record('listNamespaces');
      return ['default'];
    },
    async listApiSpecs(namespace) {
      record('listApiSpecs', [namespace]);
      return [...apiSpecs.values()].filter((spec) => !namespace || spec.namespace === namespace);
    },
    async getApiSpec(apiSpecId, namespace) {
      record('getApiSpec', [apiSpecId, namespace]);
      const spec = apiSpecs.get(apiSpecId) ?? null;
      if (!spec || (namespace && spec.namespace !== namespace)) return null;
      return spec;
    },
    async getApiSpecRaw(apiSpecId, namespace) {
      record('getApiSpecRaw', [apiSpecId, namespace]);
      const spec = apiSpecs.get(apiSpecId) ?? null;
      if (!spec || (namespace && spec.namespace !== namespace)) return null;
      return rawSpecs.get(apiSpecId) ?? null;
    },
    async createApiSpec(rawSpec, _contentType, namespace) {
      record('createApiSpec', [rawSpec, _contentType, namespace]);
      const spec = buildSpec(rawSpec, namespace);
      apiSpecs.set(spec.api_spec_id, spec);
      rawSpecs.set(spec.api_spec_id, rawSpec);
      return spec;
    },
    async replaceApiSpec(apiSpecId, rawSpec, _contentType, namespace) {
      record('replaceApiSpec', [apiSpecId, rawSpec, _contentType, namespace]);
      if (!apiSpecs.has(apiSpecId)) {
        throw new Error(`Ferrum API spec not found: ${apiSpecId}`);
      }
      const spec = buildSpec(rawSpec, namespace, apiSpecId);
      apiSpecs.set(apiSpecId, spec);
      rawSpecs.set(apiSpecId, rawSpec);
      return spec;
    },
    async deleteApiSpec(apiSpecId, namespace) {
      record('deleteApiSpec', [apiSpecId, namespace]);
      apiSpecs.delete(apiSpecId);
      rawSpecs.delete(apiSpecId);
    },
    async getConsumer(consumerId, namespace) {
      record('getConsumer', [consumerId, namespace]);
      const consumer = consumers.get(consumerId) ?? null;
      if (!consumer) return null;
      return consumer;
    },
    async createConsumer(payload) {
      record('createConsumer', [payload]);
      const consumer: FerrumConsumer = {
        consumer_id: `consumer-${++consumerSeq}`,
        username: payload.username,
        acl_groups: payload.acl_groups ?? [],
        status: 'active',
      };
      consumers.set(consumer.consumer_id, consumer);
      return consumer;
    },
    async updateConsumer(consumerId, fields, namespace) {
      record('updateConsumer', [consumerId, fields, namespace]);
      const existing = consumers.get(consumerId) ?? {
        consumer_id: consumerId,
        username: consumerId,
        acl_groups: [],
        status: 'active',
      };
      const next: FerrumConsumer = { ...existing, ...fields };
      consumers.set(consumerId, next);
      return next;
    },
    async deleteConsumer(consumerId, namespace) {
      record('deleteConsumer', [consumerId, namespace]);
      consumers.delete(consumerId);
    },
    async appendCredential(consumerId, payload: FerrumCredential, namespace) {
      record('appendCredential', [consumerId, payload, namespace]);
      const key = `${consumerId}:${payload.type}`;
      const index = credentialCounts.get(key) ?? 0;
      credentialCounts.set(key, index + 1);
      return { index, type: payload.type };
    },
    async deleteCredential(consumerId, type, index, namespace) {
      record('deleteCredential', [consumerId, type, index, namespace]);
    },
    async upsertPlugin(payload, namespace) {
      record('upsertPlugin', [payload, namespace]);
      const plugin: FerrumPlugin = {
        ...payload,
        plugin_id: payload.plugin_id ?? `plugin-${++pluginSeq}`,
      };
      plugins.push(plugin);
      return plugin;
    },
    async deletePlugin(pluginId, namespace) {
      record('deletePlugin', [pluginId, namespace]);
      const index = plugins.findIndex((plugin) => plugin.plugin_id === pluginId);
      if (index >= 0) plugins.splice(index, 1);
    },
  };

  return client;
}
