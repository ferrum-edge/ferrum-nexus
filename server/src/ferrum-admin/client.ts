/**
 * Typed wrapper around the Ferrum Edge Admin API.
 *
 * Each method takes an optional `namespace` (falling back to the configured
 * default) which is passed as the `X-Ferrum-Namespace` header. Errors raised
 * by Edge are wrapped in `ApiError(502)` with the upstream body included as
 * details so callers can surface gateway-side validation errors verbatim.
 */

import { readFileSync } from 'node:fs';
import { Agent as UndiciAgent, fetch, type Dispatcher } from 'undici';
import type { Logger } from 'pino';
import type { ResolvedConfig } from '../config/index.js';
import { ApiError, upstreamError } from '../lib/errors.js';
import { getAdminToken, invalidateAdminToken } from './jwt.js';
import { FERRUM_NAMESPACE_HEADER, type CredentialType } from '@ferrum-nexus/shared';

export interface FerrumProxy {
  proxy_id: string;
  name?: string;
  paths?: string[];
  hosts?: string[];
  upstream_id?: string;
  api_spec_id?: string | null;
  [key: string]: unknown;
}

export interface FerrumConsumer {
  consumer_id: string;
  username: string;
  acl_groups?: string[];
  status?: string;
  [key: string]: unknown;
}

export interface FerrumCredential {
  type: CredentialType;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FerrumPlugin {
  plugin_id?: string;
  name: string;
  config: Record<string, unknown>;
  proxy_id?: string | null;
  consumer_id?: string | null;
  api_spec_id?: string | null;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface FerrumApiSpec {
  api_spec_id: string;
  proxy_id: string;
  title: string;
  version: string;
  description?: string | null;
  contact?: { name?: string; email?: string; url?: string } | null;
  tags?: string[];
  servers?: { url: string }[];
  operation_count?: number;
  content_hash?: string;
  namespace?: string;
  [key: string]: unknown;
}

export interface FerrumAdminClient {
  health(): Promise<{ ok: boolean; details?: unknown }>;
  listNamespaces(): Promise<string[]>;

  listApiSpecs(namespace?: string): Promise<FerrumApiSpec[]>;
  getApiSpec(apiSpecId: string, namespace?: string): Promise<FerrumApiSpec | null>;
  getApiSpecRaw(apiSpecId: string, namespace?: string): Promise<string | null>;
  createApiSpec(
    rawSpec: string,
    contentType: 'application/json' | 'application/yaml',
    namespace?: string,
  ): Promise<FerrumApiSpec>;
  replaceApiSpec(
    apiSpecId: string,
    rawSpec: string,
    contentType: 'application/json' | 'application/yaml',
    namespace?: string,
  ): Promise<FerrumApiSpec>;
  deleteApiSpec(apiSpecId: string, namespace?: string): Promise<void>;

  getConsumer(consumerId: string, namespace?: string): Promise<FerrumConsumer | null>;
  createConsumer(payload: {
    username: string;
    acl_groups?: string[];
    namespace?: string;
  }): Promise<FerrumConsumer>;
  updateConsumer(
    consumerId: string,
    fields: Partial<FerrumConsumer>,
    namespace?: string,
  ): Promise<FerrumConsumer>;
  deleteConsumer(consumerId: string, namespace?: string): Promise<void>;

  appendCredential(
    consumerId: string,
    payload: FerrumCredential,
    namespace?: string,
  ): Promise<{ index: number; type: CredentialType }>;
  deleteCredential(
    consumerId: string,
    type: CredentialType,
    index: number,
    namespace?: string,
  ): Promise<void>;

  upsertPlugin(payload: FerrumPlugin, namespace?: string): Promise<FerrumPlugin>;
  deletePlugin(pluginId: string, namespace?: string): Promise<void>;
}

export function createFerrumAdminClient(
  config: ResolvedConfig,
  logger: Logger,
): FerrumAdminClient {
  const baseUrl = config.ferrum.adminUrl.replace(/\/$/, '');
  const dispatcher: Dispatcher | undefined =
    config.ferrum.caPath && baseUrl.startsWith('https://')
      ? new UndiciAgent({ connect: { ca: readFileSync(config.ferrum.caPath, 'utf8') } })
      : undefined;

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    init: {
      namespace?: string;
      body?: string | null;
      contentType?: string;
      acceptText?: boolean;
    } = {},
  ): Promise<T> {
    const token = await getAdminToken(config.ferrum);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: init.acceptText ? 'text/plain' : 'application/json',
      [FERRUM_NAMESPACE_HEADER]: init.namespace ?? config.ferrum.defaultNamespace,
    };
    if (init.contentType) headers['content-type'] = init.contentType;
    const url = `${baseUrl}${path}`;
    const start = Date.now();
    const res = await fetch(url, {
      method,
      headers,
      body: init.body ?? null,
      signal: AbortSignal.timeout(30_000),
      ...(dispatcher && { dispatcher }),
    }).catch((err) => {
      logger.error({ err, url, method }, 'ferrum admin request failed');
      throw upstreamError('Cannot reach Ferrum Edge Admin API', { url });
    });
    const ms = Date.now() - start;
    logger.debug({ url, method, status: res.status, ms }, 'ferrum admin request');
    if (res.status === 401 || res.status === 403) {
      invalidateAdminToken();
      const body = await res.text().catch(() => '');
      throw upstreamError(`Ferrum Admin API rejected token: ${res.status}`, body);
    }
    if (res.status === 404) {
      return null as unknown as T;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ApiError(502, 'ferrum_error', `Ferrum Edge returned ${res.status}`, body);
    }
    if (res.status === 204) return undefined as unknown as T;
    if (init.acceptText) return (await res.text()) as unknown as T;
    if (res.headers.get('content-type')?.includes('application/json')) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  // URL-encode each path segment so a malformed/hostile ID can never inject
  // additional path components (`../`, `?`, etc.) into the Admin API URL.
  const seg = (value: string | number): string => encodeURIComponent(String(value));

  return {
    async health() {
      try {
        const data = await request<unknown>('GET', '/health');
        return { ok: true, details: data };
      } catch (err) {
        return { ok: false, details: err instanceof Error ? err.message : err };
      }
    },
    async listNamespaces() {
      const res = await request<{ namespaces: string[] } | string[]>('GET', '/namespaces');
      return Array.isArray(res) ? res : res.namespaces ?? [];
    },
    async listApiSpecs(namespace) {
      const res = await request<{ items: FerrumApiSpec[] } | FerrumApiSpec[]>(
        'GET',
        '/api-specs',
        { namespace },
      );
      return Array.isArray(res) ? res : res.items ?? [];
    },
    async getApiSpec(apiSpecId, namespace) {
      return request<FerrumApiSpec | null>('GET', `/api-specs/${seg(apiSpecId)}`, { namespace });
    },
    async getApiSpecRaw(apiSpecId, namespace) {
      return request<string | null>('GET', `/api-specs/${seg(apiSpecId)}/raw`, {
        namespace,
        acceptText: true,
      });
    },
    async createApiSpec(rawSpec, contentType, namespace) {
      return request<FerrumApiSpec>('POST', '/api-specs', {
        namespace,
        body: rawSpec,
        contentType,
      });
    },
    async replaceApiSpec(apiSpecId, rawSpec, contentType, namespace) {
      return request<FerrumApiSpec>('PUT', `/api-specs/${seg(apiSpecId)}`, {
        namespace,
        body: rawSpec,
        contentType,
      });
    },
    async deleteApiSpec(apiSpecId, namespace) {
      await request<void>('DELETE', `/api-specs/${seg(apiSpecId)}`, { namespace });
    },
    async getConsumer(consumerId, namespace) {
      return request<FerrumConsumer | null>('GET', `/consumers/${seg(consumerId)}`, { namespace });
    },
    async createConsumer(payload) {
      return request<FerrumConsumer>('POST', '/consumers', {
        namespace: payload.namespace,
        body: JSON.stringify({ username: payload.username, acl_groups: payload.acl_groups ?? [] }),
        contentType: 'application/json',
      });
    },
    async updateConsumer(consumerId, fields, namespace) {
      return request<FerrumConsumer>('PATCH', `/consumers/${seg(consumerId)}`, {
        namespace,
        body: JSON.stringify(fields),
        contentType: 'application/json',
      });
    },
    async deleteConsumer(consumerId, namespace) {
      await request<void>('DELETE', `/consumers/${seg(consumerId)}`, { namespace });
    },
    async appendCredential(consumerId, payload, namespace) {
      return request<{ index: number; type: CredentialType }>(
        'POST',
        `/consumers/${seg(consumerId)}/credentials/${seg(payload.type)}`,
        {
          namespace,
          body: JSON.stringify(payload.data),
          contentType: 'application/json',
        },
      );
    },
    async deleteCredential(consumerId, type, index, namespace) {
      await request<void>(
        'DELETE',
        `/consumers/${seg(consumerId)}/credentials/${seg(type)}/${seg(index)}`,
        { namespace },
      );
    },
    async upsertPlugin(payload, namespace) {
      const path = payload.plugin_id ? `/plugins/${seg(payload.plugin_id)}` : '/plugins';
      const method = payload.plugin_id ? 'PUT' : 'POST';
      return request<FerrumPlugin>(method, path, {
        namespace,
        body: JSON.stringify(payload),
        contentType: 'application/json',
      });
    },
    async deletePlugin(pluginId, namespace) {
      await request<void>('DELETE', `/plugins/${seg(pluginId)}`, { namespace });
    },
  };
}
