/**
 * The only module in Nexus that speaks the Ferrum Edge Admin API's HTTP shape.
 *
 * Everything above it deals in domain objects and `NexusError`s. Failures are
 * classified into exactly two codes:
 *
 * - `EDGE_UNAVAILABLE` — DNS, connect, TLS, socket or timeout. Nothing reached
 *   the gateway.
 * - `EDGE_ERROR` — the gateway answered with a non-2xx status. Edge's flat
 *   `{"error": "..."}` text is **logged, never echoed to the browser**, because
 *   it can contain operator-facing configuration detail.
 *
 * A `503` carrying `applied: false` is a special case worth knowing about: the
 * write **is durable**, it just is not live yet. It surfaces as `EDGE_ERROR`
 * with an explicit message and is never retried automatically — a blind retry
 * of a create would `409`.
 */

import { readFileSync } from 'node:fs';

import { Agent, request, type Dispatcher } from 'undici';

import type { EdgeCredentialType } from '@ferrum-nexus/shared';

import type { EdgeConfig } from '../config/index.js';
import { edgeError, edgeUnavailable, internal } from '../lib/errors.js';
import { createAdminTokenMinter, DEFAULT_ADMIN_SUBJECT, type AdminTokenMinter } from './jwt.js';
import type {
  EdgeConsumer,
  EdgeConsumerWrite,
  EdgeCredentialEntry,
  EdgeHealth,
  EdgeListQuery,
  EdgePage,
  EdgePluginConfig,
  EdgePluginConfigWrite,
  EdgeProbe,
  EdgeProxy,
  EdgeProxyWrite,
} from './types.js';

/** Minimal logger surface, so this module does not depend on Fastify. */
export interface EdgeLogger {
  debug(obj: Record<string, unknown>, message?: string): void;
  warn(obj: Record<string, unknown>, message?: string): void;
  error(obj: Record<string, unknown>, message?: string): void;
}

/** A logger that drops everything — the default when none is supplied. */
export const silentEdgeLogger: EdgeLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/* ── Per-key serialization ──────────────────────────────────────────────── */

/** Runs work serially per key; independent keys still run concurrently. */
export type KeyedSerializer = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Build a per-key promise queue.
 *
 * Consumer mutations **must** go through this: `PUT /consumers/{id}` is a
 * whole-resource replace with no concurrency token, so two concurrent
 * GET→edit→PUT round trips would silently lose one ACL group change
 * (`ref-edge-admin.md` §7.2).
 *
 * **Multi-instance caveat:** this serialises within one Node process only. A
 * horizontally scaled Nexus needs either sticky routing per consumer or an
 * external lock; until then, run one writer.
 */
export function createKeyedSerializer(): KeyedSerializer {
  const queues = new Map<string, Promise<unknown>>();

  return function serializePerKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const guard: Promise<void> = result
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (queues.get(key) === guard) queues.delete(key);
      });
    queues.set(key, guard);
    return result;
  };
}

/* ── Client ─────────────────────────────────────────────────────────────── */

/** Options for one Admin API call. */
interface CallOptions {
  /** JSON request body. */
  body?: unknown;
  /** Query string parameters; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Return `null` instead of throwing when Edge answers `404`. */
  allow404?: boolean;
  /** Additional statuses to treat as success (e.g. `409` for "already exists"). */
  tolerate?: number[];
  /** Override the JWT `sub` claim so Edge's audit log names the acting user. */
  subject?: string;
}

/** Typed client for the subset of the Ferrum Edge Admin API that Nexus uses. */
export interface FerrumAdminClient {
  /** Namespace sent in `X-Ferrum-Namespace` on every namespace-scoped call. */
  readonly namespace: string;

  /** Authenticated `GET /health` — reports `mode`, `ready`, `admin_writes_enabled`. */
  health(): Promise<EdgeHealth>;
  /** Unauthenticated `GET /live`. `true` when the gateway answered `200`. */
  live(): Promise<boolean>;
  /**
   * Best-effort version probe. Edge has **no `/version` endpoint**
   * (`ref-edge-admin.md` §10.5), so this returns `null` on a 404 rather than
   * failing; take the real version from your deployment metadata.
   */
  version(): Promise<string | null>;
  /** Combined reachability probe for `GET /api/health`; never throws. */
  probe(): Promise<EdgeProbe>;

  /** `GET /namespaces` — a list of name strings. */
  listNamespaces(): Promise<string[]>;
  /**
   * Make sure the configured namespace exists. Writing any resource with a new
   * `X-Ferrum-Namespace` already isolates data, so a failure here is logged and
   * swallowed rather than blocking startup.
   */
  ensureNamespace(description?: string): Promise<void>;

  readonly consumers: {
    list(query?: EdgeListQuery): Promise<EdgePage<EdgeConsumer>>;
    get(id: string): Promise<EdgeConsumer | null>;
    /**
     * Find a consumer by `username` by scanning `GET /consumers` pages — Edge
     * has no username filter. Nexus normally reads the mapping from its own
     * `consumers` table; this is the reconciliation path.
     */
    getByUsername(username: string): Promise<EdgeConsumer | null>;
    create(body: EdgeConsumerWrite, subject?: string): Promise<EdgeConsumer>;
    /**
     * Whole-resource replace. **Always build the body from a `get()` response** —
     * omitting `keyauth`/`jwt` deletes those credentials.
     */
    replace(id: string, body: EdgeConsumerWrite, subject?: string): Promise<EdgeConsumer>;
    delete(id: string, subject?: string): Promise<void>;
    /** Append one credential entry (rotation step 1). */
    addCredential(
      id: string,
      type: EdgeCredentialType,
      entry: EdgeCredentialEntry,
      subject?: string,
    ): Promise<EdgeConsumer>;
    /** Replace every entry of a credential type. */
    replaceCredentials(
      id: string,
      type: EdgeCredentialType,
      entries: EdgeCredentialEntry[],
      subject?: string,
    ): Promise<EdgeConsumer>;
    /** Remove one entry by 0-based index (rotation step 3); the array re-indexes. */
    deleteCredentialAt(
      id: string,
      type: EdgeCredentialType,
      index: number,
      subject?: string,
    ): Promise<EdgeConsumer>;
    /** Remove a whole credential type. Idempotent for the built-in types. */
    deleteCredentialType(id: string, type: EdgeCredentialType, subject?: string): Promise<void>;
  };

  readonly proxies: {
    list(query?: EdgeListQuery): Promise<EdgePage<EdgeProxy>>;
    get(id: string): Promise<EdgeProxy | null>;
    create(body: EdgeProxyWrite, subject?: string): Promise<EdgeProxy>;
    replace(id: string, body: EdgeProxyWrite, subject?: string): Promise<EdgeProxy>;
    delete(id: string, subject?: string): Promise<void>;
  };

  readonly pluginConfigs: {
    list(query?: EdgeListQuery): Promise<EdgePage<EdgePluginConfig>>;
    /** Every plugin config attached to one proxy (client-side filtered). */
    listByProxy(proxyId: string): Promise<EdgePluginConfig[]>;
    get(id: string): Promise<EdgePluginConfig | null>;
    create(body: EdgePluginConfigWrite, subject?: string): Promise<EdgePluginConfig>;
    replace(id: string, body: EdgePluginConfigWrite, subject?: string): Promise<EdgePluginConfig>;
    delete(id: string, subject?: string): Promise<void>;
  };

  /** Serialise work per consumer id — see {@link createKeyedSerializer}. */
  serializePerKey: KeyedSerializer;

  /** Release the undici dispatcher. */
  close(): Promise<void>;
}

const MAX_CONSUMER_SCAN_PAGES = 20;
const CONSUMER_SCAN_PAGE_SIZE = 500;

function buildDispatcher(config: EdgeConfig): Dispatcher {
  const isHttps = config.adminUrl.startsWith('https://');
  let ca: string | undefined;
  if (config.caFile) {
    try {
      ca = readFileSync(config.caFile, 'utf8');
    } catch (cause) {
      throw internal('FERRUM_ADMIN_CA_FILE could not be read', cause);
    }
  }
  return new Agent({
    connect: {
      timeout: config.timeoutMs,
      ...(isHttps && ca ? { ca } : {}),
    },
    headersTimeout: Math.max(config.timeoutMs, 30_000),
    bodyTimeout: Math.max(config.timeoutMs, 30_000),
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
  });
}

function isUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string') {
    return (
      code.startsWith('E') ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT' ||
      code === 'UND_ERR_SOCKET'
    );
  }
  return error.message.includes('fetch failed');
}

/** Build the Ferrum Edge Admin API client. */
export function createFerrumAdminClient(
  config: EdgeConfig,
  logger: EdgeLogger = silentEdgeLogger,
  deps: { minter?: AdminTokenMinter; dispatcher?: Dispatcher } = {},
): FerrumAdminClient {
  const minter = deps.minter ?? createAdminTokenMinter(config);
  const dispatcher = deps.dispatcher ?? buildDispatcher(config);
  const serializePerKey = createKeyedSerializer();
  const namespace = config.namespace;

  function urlFor(path: string, query?: CallOptions['query']): string {
    const url = new URL(config.adminUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: CallOptions = {},
  ): Promise<T | null> {
    const token = await minter.getToken(options.subject ?? DEFAULT_ADMIN_SUBJECT);
    const url = urlFor(path, options.query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'x-ferrum-namespace': namespace,
      accept: 'application/json',
    };
    const hasBody = options.body !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';

    let statusCode: number;
    let raw: string;
    try {
      const response = await request(url, {
        method,
        headers,
        dispatcher,
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      statusCode = response.statusCode;
      raw = await response.body.text();
    } catch (cause) {
      logger.error(
        { method, path, code: (cause as NodeJS.ErrnoException).code ?? null },
        'Ferrum Edge Admin API is unreachable',
      );
      if (isUnavailable(cause)) throw edgeUnavailable(undefined, cause);
      throw edgeUnavailable('The Ferrum Edge Admin API request failed', cause);
    }

    if (statusCode === 404 && options.allow404) return null;
    if (statusCode === 204 || raw.trim() === '') {
      if (statusCode >= 400 && !(options.tolerate ?? []).includes(statusCode)) {
        throw classify(statusCode, null, method, path);
      }
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (statusCode >= 400 && !(options.tolerate ?? []).includes(statusCode)) {
      throw classify(statusCode, parsed, method, path);
    }
    return parsed as T;
  }

  function classify(status: number, parsed: unknown, method: string, path: string): Error {
    const body = (parsed ?? {}) as { error?: unknown; applied?: unknown; reason?: unknown };
    const upstream = typeof body.error === 'string' ? body.error : `HTTP ${status}`;
    logger.error(
      { method, path, status, upstream, reason: body.reason ?? null },
      'Ferrum Edge Admin API returned an error',
    );

    if (status === 503 && body.applied === false) {
      return edgeError(
        'The gateway accepted the change but has not applied it yet; do not retry — verify the gateway configuration and try again once it recovers',
        { status, reason: typeof body.reason === 'string' ? body.reason : null },
      );
    }
    if (status === 401 || status === 403) {
      return edgeError('The gateway rejected the Nexus admin credentials', { status });
    }
    return edgeError('The gateway rejected the request', { status });
  }

  /** Same as `call`, for endpoints that must return a body. */
  async function callRequired<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: CallOptions = {},
  ): Promise<T> {
    const result = await call<T>(method, path, options);
    if (result === null || result === undefined) {
      throw edgeError('The gateway returned an empty response where one was expected');
    }
    return result;
  }

  return {
    namespace,

    async health(): Promise<EdgeHealth> {
      return callRequired<EdgeHealth>('GET', '/health');
    },

    async live(): Promise<boolean> {
      const result = await call<{ status?: string }>('GET', '/live', { allow404: true });
      return result !== null;
    },

    async version(): Promise<string | null> {
      const result = await call<{ version?: unknown }>('GET', '/version', {
        allow404: true,
        tolerate: [404, 405],
      });
      const version = (result ?? {}).version;
      return typeof version === 'string' ? version : null;
    },

    async probe(): Promise<EdgeProbe> {
      const started = Date.now();
      try {
        const health = await this.health();
        let version: string | null = null;
        try {
          version = await this.version();
        } catch {
          version = null;
        }
        return {
          reachable: true,
          latencyMs: Date.now() - started,
          mode: typeof health.mode === 'string' ? health.mode : null,
          adminWritesEnabled:
            typeof health.admin_writes_enabled === 'boolean' ? health.admin_writes_enabled : null,
          version,
          error: null,
        };
      } catch (error) {
        return {
          reachable: false,
          latencyMs: Date.now() - started,
          mode: null,
          adminWritesEnabled: null,
          version: null,
          error: error instanceof Error ? error.message : 'unknown error',
        };
      }
    },

    async listNamespaces(): Promise<string[]> {
      const page = await callRequired<EdgePage<string>>('GET', '/namespaces', {
        query: { limit: 1000 },
      });
      return Array.isArray(page.data) ? page.data : [];
    },

    async ensureNamespace(description?: string): Promise<void> {
      try {
        const existing = await call<unknown>(
          'GET',
          `/namespaces/${encodeURIComponent(namespace)}`,
          {
            allow404: true,
          },
        );
        if (existing !== null) return;
        await call('POST', '/namespaces', {
          body: { name: namespace, ...(description ? { description } : {}) },
          // 409: created concurrently. 501: MongoDB standalone refuses namespace writes.
          tolerate: [409, 501],
        });
      } catch (error) {
        // Namespaces are created implicitly by the first resource write, so a
        // failure here must not block startup.
        logger.warn(
          { namespace, error: error instanceof Error ? error.message : String(error) },
          'Could not pre-create the Ferrum namespace; it will be created implicitly',
        );
      }
    },

    consumers: {
      async list(query?: EdgeListQuery): Promise<EdgePage<EdgeConsumer>> {
        return callRequired<EdgePage<EdgeConsumer>>('GET', '/consumers', { query: { ...query } });
      },

      async get(id: string): Promise<EdgeConsumer | null> {
        return call<EdgeConsumer>('GET', `/consumers/${encodeURIComponent(id)}`, {
          allow404: true,
        });
      },

      async getByUsername(username: string): Promise<EdgeConsumer | null> {
        for (let pageIndex = 0; pageIndex < MAX_CONSUMER_SCAN_PAGES; pageIndex += 1) {
          const page = await callRequired<EdgePage<EdgeConsumer>>('GET', '/consumers', {
            query: { limit: CONSUMER_SCAN_PAGE_SIZE, offset: pageIndex * CONSUMER_SCAN_PAGE_SIZE },
          });
          const items = Array.isArray(page.data) ? page.data : [];
          // access_control matches usernames byte-for-byte, so this does too.
          const match = items.find((consumer) => consumer.username === username);
          if (match) return match;
          const total = page.pagination?.total ?? items.length;
          if ((pageIndex + 1) * CONSUMER_SCAN_PAGE_SIZE >= total || items.length === 0) return null;
        }
        return null;
      },

      async create(body: EdgeConsumerWrite, subject?: string): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>('POST', '/consumers', { body, subject });
      },

      async replace(id: string, body: EdgeConsumerWrite, subject?: string): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>('PUT', `/consumers/${encodeURIComponent(id)}`, {
          body,
          subject,
        });
      },

      async delete(id: string, subject?: string): Promise<void> {
        await call('DELETE', `/consumers/${encodeURIComponent(id)}`, { subject });
      },

      async addCredential(
        id: string,
        type: EdgeCredentialType,
        entry: EdgeCredentialEntry,
        subject?: string,
      ): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>(
          'POST',
          `/consumers/${encodeURIComponent(id)}/credentials/${type}`,
          { body: entry, subject },
        );
      },

      async replaceCredentials(
        id: string,
        type: EdgeCredentialType,
        entries: EdgeCredentialEntry[],
        subject?: string,
      ): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>(
          'PUT',
          `/consumers/${encodeURIComponent(id)}/credentials/${type}`,
          { body: entries, subject },
        );
      },

      async deleteCredentialAt(
        id: string,
        type: EdgeCredentialType,
        index: number,
        subject?: string,
      ): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>(
          'DELETE',
          `/consumers/${encodeURIComponent(id)}/credentials/${type}/${index}`,
          { subject },
        );
      },

      async deleteCredentialType(
        id: string,
        type: EdgeCredentialType,
        subject?: string,
      ): Promise<void> {
        await call('DELETE', `/consumers/${encodeURIComponent(id)}/credentials/${type}`, {
          subject,
        });
      },
    },

    proxies: {
      async list(query?: EdgeListQuery): Promise<EdgePage<EdgeProxy>> {
        return callRequired<EdgePage<EdgeProxy>>('GET', '/proxies', { query: { ...query } });
      },
      async get(id: string): Promise<EdgeProxy | null> {
        return call<EdgeProxy>('GET', `/proxies/${encodeURIComponent(id)}`, { allow404: true });
      },
      async create(body: EdgeProxyWrite, subject?: string): Promise<EdgeProxy> {
        return callRequired<EdgeProxy>('POST', '/proxies', { body, subject });
      },
      async replace(id: string, body: EdgeProxyWrite, subject?: string): Promise<EdgeProxy> {
        return callRequired<EdgeProxy>('PUT', `/proxies/${encodeURIComponent(id)}`, {
          body,
          subject,
        });
      },
      async delete(id: string, subject?: string): Promise<void> {
        await call('DELETE', `/proxies/${encodeURIComponent(id)}`, { subject, allow404: true });
      },
    },

    pluginConfigs: {
      async list(query?: EdgeListQuery): Promise<EdgePage<EdgePluginConfig>> {
        return callRequired<EdgePage<EdgePluginConfig>>('GET', '/plugins/config', {
          query: { ...query },
        });
      },
      async listByProxy(proxyId: string): Promise<EdgePluginConfig[]> {
        const page = await callRequired<EdgePage<EdgePluginConfig>>('GET', '/plugins/config', {
          query: { limit: 1000 },
        });
        const items = Array.isArray(page.data) ? page.data : [];
        return items.filter((config) => config.proxy_id === proxyId);
      },
      async get(id: string): Promise<EdgePluginConfig | null> {
        return call<EdgePluginConfig>('GET', `/plugins/config/${encodeURIComponent(id)}`, {
          allow404: true,
        });
      },
      async create(body: EdgePluginConfigWrite, subject?: string): Promise<EdgePluginConfig> {
        return callRequired<EdgePluginConfig>('POST', '/plugins/config', { body, subject });
      },
      async replace(
        id: string,
        body: EdgePluginConfigWrite,
        subject?: string,
      ): Promise<EdgePluginConfig> {
        return callRequired<EdgePluginConfig>('PUT', `/plugins/config/${encodeURIComponent(id)}`, {
          body,
          subject,
        });
      },
      async delete(id: string, subject?: string): Promise<void> {
        await call('DELETE', `/plugins/config/${encodeURIComponent(id)}`, {
          subject,
          allow404: true,
        });
      },
    },

    serializePerKey,

    async close(): Promise<void> {
      if (deps.dispatcher) return;
      await dispatcher.close();
    },
  };
}
