/**
 * Publishing — the bridge between "a provider uploaded a spec" and "a proxy
 * exists on the gateway".
 *
 * ## The Edge object graph behind one published API
 *
 * ```
 * apis row ─┬─ proxy            name `nexus-<slug>`, listen_path `/<ns>/<slug>`
 *           ├─ plugin_config    the auth plugin (key_auth | basic_auth | jwt_auth)
 *           ├─ plugin_config    access_control, only when `requestable`
 *           └─ plugin_config    rate_limiting, only when a rate limit is set
 * ```
 *
 * Nexus stores the proxy id on the `apis` row and **does not** store the plugin
 * config ids: they are looked up with `GET /plugins/config` filtered by
 * `proxy_id` whenever they need changing. That keeps the schema free of ids
 * whose lifecycle Nexus does not own, and reconciles automatically if an
 * operator ever recreates one by hand.
 *
 * ## Publishing is a multi-write sequence with no transaction
 *
 * Edge has no cross-resource transaction, so `publish` creates the proxy, then
 * each plugin config, and **rolls back what it created** if any step fails
 * (delete the plugin configs, then the proxy) before rethrowing. The Nexus rows
 * are written last but *inside* that same compensated block, in one store
 * transaction, so a store failure cannot leave a live proxy the portal has no
 * row for. `update` uses the same technique with an explicit undo stack, and
 * `updateSpec` moves the gateway before the revision becomes current.
 *
 * Where a step genuinely cannot be made atomic, the failure is arranged to land
 * in the safe direction and is documented at the call site: an API stays
 * reachable and authenticated rather than becoming open or orphaned.
 *
 * ## Retirement versus deletion
 *
 * `status: 'retired'` is a *catalog* state, not a gateway state: the proxy and
 * its plugins stay exactly as they are, existing grants keep working, and the
 * API simply stops appearing in the catalog for anyone but its owner and
 * admins. That is deliberate — retiring an API must never silently break the
 * integrations already calling it. `DELETE /api/apis/:id` is the destructive
 * operation: it revokes every grant, tears the Edge objects down and removes
 * the rows.
 *
 * @see ref-edge-admin.md §3 (proxies), §7 (access_control), §8 (plugin configs)
 */

import {
  ACCESS_CONTROL_PLUGIN,
  CREDENTIAL_TYPE_FOR_PLUGIN,
  RATE_LIMIT_PLUGIN,
  aclGroupForApi,
  listenPathFor,
  roleAtLeast,
  testConsumerUsername,
  type Api,
  type ApiSpecSummary,
  type ApiStats,
  type ApiStatus,
  type AuthPluginType,
  type CreateTestConsumerResponse,
  type Paginated,
  type PublishApiRequest,
  type RateLimitConfig,
  type UpdateApiRequest,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type {
  ApiFilter,
  ApiRecord,
  ApiSpecRecord,
  ListOptions,
  NexusStore,
  UserRecord,
} from '../db/store.js';
import type { CredentialsService } from '../credentials/service.js';
import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import type {
  EdgePluginConfig,
  EdgePluginConfigWrite,
  EdgePluginSettings,
  EdgeProxy,
} from '../ferrum-admin/types.js';
import { conflict, forbidden, notFound, specInvalid, validationFailed } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { NotificationsService } from '../notifications/service.js';
import {
  assertUpstreamAllowed,
  formatUpstreamUrl,
  parseOpenApiSpec,
  parseUpstreamUrl,
  resolveUpstream,
  slugify,
  type SpecUpstream,
  type UpstreamPolicy,
} from './oas.js';

/** Result of {@link PublishingService.publish} and `updateSpec`. */
export interface PublishResult {
  api: Api;
  spec: ApiSpecSummary;
}

/** Filters accepted by {@link PublishingService.list}. */
export interface ApiListFilter {
  mine?: boolean;
  owner_user_id?: Uuid;
  status?: ApiStatus;
  q?: string;
}

/** Publishing operations. All of them are provider-or-above. */
export interface PublishingService {
  /** APIs the caller may administer: their own, or every API for an admin. */
  list(
    actor: UserRecord,
    filter?: ApiListFilter,
    options?: ListOptions,
  ): Promise<Paginated<ApiRecord>>;
  /** One API with its current spec metadata and request/grant counters. */
  get(
    actor: UserRecord,
    apiId: Uuid,
  ): Promise<{ api: ApiRecord; spec: ApiSpecSummary | null; stats: ApiStats }>;
  /** Validate the spec, build the Edge objects, then persist the rows. */
  publish(owner: UserRecord, input: PublishApiRequest, ip?: string | null): Promise<PublishResult>;
  /** Change safe runtime settings; reconciles the Edge plugin configs. */
  update(
    actor: UserRecord,
    apiId: Uuid,
    patch: UpdateApiRequest,
    ip?: string | null,
  ): Promise<ApiRecord>;
  /** Store a new spec revision and make it current. */
  updateSpec(
    actor: UserRecord,
    apiId: Uuid,
    specText: string,
    version?: string,
    ip?: string | null,
  ): Promise<PublishResult>;
  /** Tear the API down: grants revoked, Edge objects deleted, rows removed. */
  remove(actor: UserRecord, apiId: Uuid, ip?: string | null): Promise<{ revoked_grants: number }>;
  /** Create (or replace) the provider's throwaway consumer for their own API. */
  createTestConsumer(
    actor: UserRecord,
    apiId: Uuid,
    label?: string | null,
    ip?: string | null,
  ): Promise<CreateTestConsumerResponse>;
  /** Ownership/role check reused by the access service's reviewer guards. */
  assertCanAdminister(actor: UserRecord, api: ApiRecord): void;
}

/** Dependencies of {@link createPublishingService}. */
export interface PublishingServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  edge: FerrumAdminClient;
  audit: AuditService;
  notifications: NotificationsService;
  credentials: CredentialsService;
}

/* ── Edge plugin config bodies ──────────────────────────────────────────── */

/**
 * Config for an auth plugin.
 *
 * All three are sent as `{}`:
 * - `key_auth` defaults to `header:X-API-Key` + `hide_credentials: true`, which
 *   is exactly what the portal documents;
 * - `basic_auth` **must** be `{}` or `null` — a non-empty object is a 400
 *   (`ref-edge-admin.md` §8.7);
 * - `jwt_auth` defaults to `token_lookup: header:Authorization` and
 *   `consumer_claim_field: sub`, and Nexus hands the consumer username out as
 *   the `sub` value the client must send.
 */
export function authPluginConfig(_plugin: AuthPluginType): EdgePluginSettings {
  return {};
}

/**
 * Config for `access_control`.
 *
 * Only `allowed_groups` is ever set: group membership lives on the consumer, so
 * an approval writes one consumer row instead of contending on a shared plugin
 * config, and consumer deletion is never blocked by a referencing allow-list
 * (§7.5).
 */
export function accessControlConfig(apiId: Uuid): EdgePluginSettings {
  return { allowed_groups: [aclGroupForApi(apiId)] };
}

/**
 * Config for `rate_limiting`.
 *
 * Nexus's `RateLimitConfig` is `{ limit, window_seconds }`, which maps onto
 * Edge's **custom-pair** window (`window_seconds` + `max_requests`). The preset
 * trio (`requests_per_second|minute|hour`) is never mixed in — combining the two
 * families in one rule is a 400 (§8.8).
 *
 * `limit_by: 'consumer'` is the whole point of a portal quota: the limit is per
 * authenticated identity, not per source IP.
 */
export function rateLimitConfig(rateLimit: RateLimitConfig): EdgePluginSettings {
  return {
    limit_by: 'consumer',
    expose_headers: true,
    limits: [
      {
        scope: 'default',
        window_seconds: rateLimit.window_seconds,
        max_requests: rateLimit.limit,
      },
    ],
  };
}

/** Proxy name for an API's slug — a stable, greppable marker on the gateway. */
export function proxyNameForSlug(slug: string): string {
  return `nexus-${slug}`;
}

/**
 * `servers[0]` of an already-stored revision, or `null` when it can no longer
 * be parsed. A stored spec was valid when it was accepted, but a schema that
 * tightened since then must not make a new upload fail.
 */
function safeDefaultUpstream(rawSpec: string): SpecUpstream | null {
  try {
    return parseOpenApiSpec(rawSpec).defaultUpstream;
  } catch {
    return null;
  }
}

/* ── Service ────────────────────────────────────────────────────────────── */

/** Build the publishing service. */
export function createPublishingService(deps: PublishingServiceDeps): PublishingService {
  const { config, store, edge, audit, notifications, credentials } = deps;
  const namespace = config.edge.namespace;
  // Applied at every point a backend is about to be written to the gateway:
  // publish, PATCH `upstream_url`, and a spec revision the proxy follows.
  const upstreamPolicy: UpstreamPolicy = { allowPrivate: config.allowPrivateUpstreams };

  function assertCanAdminister(actor: UserRecord, api: ApiRecord): void {
    if (api.owner_user_id === actor.id) return;
    if (roleAtLeast(actor.role, 'admin')) return;
    throw forbidden('Only the API owner or an administrator can change this API');
  }

  async function loadApi(apiId: Uuid): Promise<ApiRecord> {
    const api = await store.apis.findById(apiId);
    if (!api) throw notFound('API', apiId);
    return api;
  }

  /** Every plugin config attached to the API's proxy, or `[]` when unpublished. */
  async function pluginsOf(api: ApiRecord): Promise<EdgePluginConfig[]> {
    if (!api.ferrum_proxy_id) return [];
    return edge.pluginConfigs.listByProxy(api.ferrum_proxy_id);
  }

  function findPlugin(plugins: EdgePluginConfig[], name: string): EdgePluginConfig | undefined {
    return plugins.find((plugin) => plugin.plugin_name === name);
  }

  async function attach(
    proxyId: string,
    pluginName: string,
    pluginConfig: EdgePluginSettings,
    subject: string,
  ): Promise<EdgePluginConfig> {
    const body: EdgePluginConfigWrite = {
      plugin_name: pluginName,
      scope: 'proxy',
      proxy_id: proxyId,
      enabled: true,
      config: pluginConfig,
    };
    return edge.pluginConfigs.create(body, subject);
  }

  /** Unique slug, or `CONFLICT` when the provider's choice is taken. */
  async function resolveSlug(requested: string | undefined, name: string): Promise<string> {
    const slug = slugify(requested && requested.trim() !== '' ? requested : name);
    if (slug === '') throw validationFailed('A URL-safe slug could not be derived from the name');
    if (await store.apis.findBySlug(slug)) {
      throw conflict(`The slug '${slug}' is already in use by another API`, { slug });
    }
    return slug;
  }

  function specSummary(record: ApiSpecRecord): ApiSpecSummary {
    const { raw_spec: _raw, ...summary } = record;
    return summary;
  }

  /** Remove the ACL group of `apiId` from one grantee's consumer, best effort. */
  async function stripGroup(userId: Uuid, apiId: Uuid): Promise<void> {
    const consumer = await store.consumers.findByUserAndNamespace(userId, namespace);
    if (!consumer) return;
    const group = aclGroupForApi(apiId);
    await credentials.provisioner.mutateAclGroups(
      consumer.ferrum_consumer_id,
      (groups) => groups.filter((entry) => entry !== group),
      userId,
    );
  }

  return {
    assertCanAdminister,

    async list(actor, filter = {}, options): Promise<Paginated<ApiRecord>> {
      const isAdmin = roleAtLeast(actor.role, 'admin');
      // A provider only ever sees their own APIs; `mine` is the admin's opt-in.
      const owner = !isAdmin || filter.mine ? actor.id : filter.owner_user_id;
      const storeFilter: ApiFilter = {
        ...(owner !== undefined ? { owner_user_id: owner } : {}),
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        ...(filter.q !== undefined ? { q: filter.q } : {}),
      };
      return store.apis.list(storeFilter, options);
    },

    async get(actor, apiId) {
      const api = await loadApi(apiId);
      assertCanAdminister(actor, api);
      const [spec, pending, active, total] = await Promise.all([
        store.apiSpecs.findCurrentByApi(api.id),
        store.accessRequests.count({ api_id: api.id, status: 'pending' }),
        store.grants.count({ api_id: api.id, status: 'active' }),
        store.accessRequests.count({ api_id: api.id }),
      ]);
      return {
        api,
        spec: spec ? specSummary(spec) : null,
        stats: { pending_requests: pending, active_grants: active, total_requests: total },
      };
    },

    async publish(owner, input, ip = null): Promise<PublishResult> {
      const name = input.name.trim();
      if (name === '') throw validationFailed('An API name is required');

      const parsed = parseOpenApiSpec(input.spec);
      const upstream = resolveUpstream(parsed, input.upstream_url);
      assertUpstreamAllowed(upstream, upstreamPolicy);
      const slug = await resolveSlug(input.slug, name);

      // The id is minted here because the ACL group name is derived from it and
      // the access_control plugin needs it before the row exists.
      const apiId = newId();
      const listenPath = listenPathFor(namespace, slug);
      const version = input.version?.trim() || parsed.version;

      const created: { proxyId?: string; pluginIds: string[] } = { pluginIds: [] };
      let persisted: { api: ApiRecord; spec: ApiSpecRecord };
      try {
        const proxy = await edge.proxies.create(
          {
            name: proxyNameForSlug(slug),
            listen_path: listenPath,
            backend_scheme: upstream.scheme,
            backend_host: upstream.host,
            backend_port: upstream.port,
            ...(upstream.basePath ? { backend_path: upstream.basePath } : {}),
            strip_listen_path: true,
          },
          owner.id,
        );
        created.proxyId = proxy.id;

        const auth = await attach(
          proxy.id,
          input.auth_plugin,
          authPluginConfig(input.auth_plugin),
          owner.id,
        );
        created.pluginIds.push(auth.id);

        if (input.requestable) {
          const acl = await attach(
            proxy.id,
            ACCESS_CONTROL_PLUGIN,
            accessControlConfig(apiId),
            owner.id,
          );
          created.pluginIds.push(acl.id);
        }
        if (input.rate_limit) {
          const limiter = await attach(
            proxy.id,
            RATE_LIMIT_PLUGIN,
            rateLimitConfig(input.rate_limit),
            owner.id,
          );
          created.pluginIds.push(limiter.id);
        }

        // The Nexus rows are written *inside* the compensated block: a store
        // failure here would otherwise leave a live, untracked proxy on the
        // gateway that nothing in the portal knows how to reach or delete. One
        // transaction so the API and its first spec revision commit together.
        persisted = await store.transaction(async (tx) => {
          const row = await tx.apis.create({
            id: apiId,
            name,
            slug,
            description: input.description ?? parsed.description,
            owner_user_id: owner.id,
            ferrum_proxy_id: created.proxyId ?? null,
            upstream_url: formatUpstreamUrl(upstream),
            namespace,
            version,
            spec_format: 'openapi',
            requestable: input.requestable,
            auth_plugin: input.auth_plugin,
            rate_limit: input.rate_limit ?? null,
            cors: input.cors ?? null,
            status: 'published',
            visibility: input.visibility,
          });
          const revision = await tx.apiSpecs.create({
            api_id: row.id,
            version,
            raw_spec: parsed.raw,
            parsed_title: parsed.title,
            parsed_version: parsed.version,
            is_current: true,
          });
          return { api: row, spec: revision };
        });
      } catch (error) {
        // Undo the Edge side so the whole publish reads as if it never
        // happened. Deleting the proxy cascades its proxy-scoped plugin
        // configs, but the explicit deletes make the intent obvious and survive
        // a partial cascade. The store transaction has already rolled itself
        // back, so nothing is left on the Nexus side either.
        for (const pluginId of created.pluginIds) {
          await edge.pluginConfigs.delete(pluginId, owner.id).catch(() => undefined);
        }
        if (created.proxyId) {
          await edge.proxies.delete(created.proxyId, owner.id).catch(() => undefined);
        }
        throw error;
      }

      const { api, spec } = persisted;

      // The audit row is deliberately outside the compensated block: both sides
      // now agree, and tearing a live API back down because the log write
      // failed would trade a missing audit row for an outage.
      await audit.record(
        { id: owner.id, role: owner.role },
        AuditAction.API_PUBLISH,
        { type: 'api', id: api.id },
        {
          slug,
          listen_path: listenPath,
          proxy_id: api.ferrum_proxy_id,
          auth_plugin: input.auth_plugin,
          requestable: input.requestable,
          visibility: input.visibility,
          rate_limit: input.rate_limit ?? null,
          upstream: `${upstream.scheme}://${upstream.host}:${upstream.port}`,
          spec_paths: parsed.pathCount,
          spec_operations: parsed.operationCount,
        },
        ip,
      );

      return { api, spec: specSummary(spec) };
    },

    async update(actor, apiId, patch, ip = null): Promise<ApiRecord> {
      const api = await loadApi(apiId);
      assertCanAdminister(actor, api);

      const update: Partial<ApiRecord> = {};
      const changed: string[] = [];
      const details: Record<string, unknown> = {};

      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (name === '') throw validationFailed('An API name is required');
        update.name = name;
        changed.push('name');
      }
      if (patch.description !== undefined) {
        update.description = patch.description;
        changed.push('description');
      }
      if (patch.version !== undefined && patch.version.trim() !== '') {
        update.version = patch.version.trim();
        changed.push('version');
      }
      if (patch.visibility !== undefined && patch.visibility !== api.visibility) {
        update.visibility = patch.visibility;
        changed.push('visibility');
      }
      if (patch.status !== undefined && patch.status !== api.status) {
        // Retirement is a catalog state only — the proxy and every live grant
        // keep working so integrations already in production do not break.
        update.status = patch.status;
        changed.push('status');
        details.gateway_untouched = true;
      }

      const plugins = await pluginsOf(api);
      const proxyId = api.ferrum_proxy_id;

      // Edge has no cross-resource transaction, so every gateway mutation below
      // records the call that undoes it. Any later failure — the next plugin
      // call, or the Nexus row update itself — unwinds them in reverse, so a
      // half-applied PATCH never leaves the gateway in a shape the portal does
      // not describe.
      const undo: (() => Promise<void>)[] = [];
      let updated: ApiRecord;

      try {
        if (patch.upstream_url !== undefined && patch.upstream_url.trim() !== '' && proxyId) {
          const upstream = parseUpstreamUrl(patch.upstream_url);
          if (!upstream) {
            throw specInvalid('The upstream URL must be an absolute http:// or https:// URL', {
              field: 'upstream_url',
              value: patch.upstream_url,
            });
          }
          assertUpstreamAllowed(upstream, upstreamPolicy);
          const before = await edge.proxies.get(proxyId);
          await replaceProxyBackend(proxyId, api.slug, upstream, actor.id);
          if (before) undo.push(() => restoreProxy(before, api.slug, actor.id));
          changed.push('upstream_url');
          details.upstream = `${upstream.scheme}://${upstream.host}:${upstream.port}`;
        }

        if (patch.auth_plugin !== undefined && patch.auth_plugin !== api.auth_plugin && proxyId) {
          const previous = findPlugin(plugins, api.auth_plugin);
          // Attach the replacement **before** removing the incumbent. For the
          // moment both are live the proxy accepts either credential (auth
          // plugins run in priority order until one succeeds, §3.4), which is a
          // vastly safer window than the one the other order opens: a live
          // proxy fronting the provider's upstream with no authentication
          // plugin at all.
          const attached = await attach(
            proxyId,
            patch.auth_plugin,
            authPluginConfig(patch.auth_plugin),
            actor.id,
          );
          undo.push(() => edge.pluginConfigs.delete(attached.id, actor.id));
          if (previous) {
            await edge.pluginConfigs.delete(previous.id, actor.id);
            undo.push(async () => {
              await attach(proxyId, previous.plugin_name, previous.config, actor.id);
            });
          }
          update.auth_plugin = patch.auth_plugin;
          changed.push('auth_plugin');
          // Credentials of the previous flavour are kept on the consumer (they may
          // still authenticate other APIs) but they no longer satisfy *this* API.
          details.previous_auth_plugin = api.auth_plugin;
          details.previous_credential_type = CREDENTIAL_TYPE_FOR_PLUGIN[api.auth_plugin];
          details.existing_credentials_invalidated = true;
        }

        if (patch.requestable !== undefined && patch.requestable !== api.requestable && proxyId) {
          const acl = findPlugin(plugins, ACCESS_CONTROL_PLUGIN);
          if (patch.requestable && !acl) {
            const attached = await attach(
              proxyId,
              ACCESS_CONTROL_PLUGIN,
              accessControlConfig(api.id),
              actor.id,
            );
            undo.push(() => edge.pluginConfigs.delete(attached.id, actor.id));
          } else if (!patch.requestable && acl) {
            // Dropping the gate opens the API to every authenticated consumer;
            // existing grants stay on the consumers and become inert.
            await edge.pluginConfigs.delete(acl.id, actor.id);
            undo.push(async () => {
              await attach(proxyId, ACCESS_CONTROL_PLUGIN, acl.config, actor.id);
            });
          }
          update.requestable = patch.requestable;
          changed.push('requestable');
        }

        if (patch.rate_limit !== undefined && proxyId) {
          const limiter = findPlugin(plugins, RATE_LIMIT_PLUGIN);
          if (patch.rate_limit === null) {
            if (limiter) {
              await edge.pluginConfigs.delete(limiter.id, actor.id);
              undo.push(async () => {
                await attach(proxyId, RATE_LIMIT_PLUGIN, limiter.config, actor.id);
              });
            }
          } else if (limiter) {
            await edge.pluginConfigs.replace(
              limiter.id,
              {
                plugin_name: RATE_LIMIT_PLUGIN,
                scope: 'proxy',
                proxy_id: proxyId,
                enabled: true,
                config: rateLimitConfig(patch.rate_limit),
              },
              actor.id,
            );
            undo.push(async () => {
              await edge.pluginConfigs.replace(
                limiter.id,
                {
                  plugin_name: RATE_LIMIT_PLUGIN,
                  scope: 'proxy',
                  proxy_id: proxyId,
                  enabled: limiter.enabled,
                  config: limiter.config,
                },
                actor.id,
              );
            });
          } else {
            const attached = await attach(
              proxyId,
              RATE_LIMIT_PLUGIN,
              rateLimitConfig(patch.rate_limit),
              actor.id,
            );
            undo.push(() => edge.pluginConfigs.delete(attached.id, actor.id));
          }
          update.rate_limit = patch.rate_limit;
          changed.push('rate_limit');
        }

        if (changed.length === 0) return api;

        const persisted = await store.apis.update(api.id, update);
        if (!persisted) throw notFound('API', apiId);
        updated = persisted;
      } catch (error) {
        for (const step of undo.reverse()) {
          await step().catch(() => undefined);
        }
        throw error;
      }

      await audit.record(
        { id: actor.id, role: actor.role },
        update.status === 'retired' ? AuditAction.API_RETIRE : AuditAction.API_UPDATE,
        { type: 'api', id: api.id },
        { changed_fields: changed, ...details },
        ip,
      );

      if (details.existing_credentials_invalidated === true) {
        await notifyGrantees(
          api.id,
          'system',
          `${updated.name} changed its authentication method`,
          `This API now uses ${updated.auth_plugin}. Issue a matching credential from your credentials page to keep calling it.`,
          '/credentials',
        );
      }

      return updated;
    },

    async updateSpec(actor, apiId, specText, version, ip = null): Promise<PublishResult> {
      const api = await loadApi(apiId);
      assertCanAdminister(actor, api);

      const parsed = parseOpenApiSpec(specText);
      const previous = await store.apiSpecs.findCurrentByApi(api.id);
      const nextVersion = version?.trim() || parsed.version;

      // The gateway moves **first**, and the revision only becomes current once
      // it has. The other order publishes a document describing a backend Edge
      // is not serving yet; this order's failure mode is compensated below, and
      // if the compensation itself fails the gateway wins — traffic keeps
      // flowing to the new upstream while the catalog still shows the previous
      // revision, which is the direction that does not break integrations.
      //
      // Follow the spec's `servers[0]` only while the proxy is still pointing
      // where the *previous* revision said it should. Once a provider supplies
      // an explicit upstream, the document stops being authoritative for it.
      let backendUpdated = false;
      let restoreBackend: (() => Promise<void>) | null = null;
      const nextUpstream = parsed.defaultUpstream;
      if (nextUpstream && api.ferrum_proxy_id) {
        const previousUpstream = previous ? safeDefaultUpstream(previous.raw_spec) : null;
        const proxy = await edge.proxies.get(api.ferrum_proxy_id);
        const followsSpec =
          proxy !== null &&
          previousUpstream !== null &&
          proxy.backend_host === previousUpstream.host &&
          proxy.backend_port === previousUpstream.port;
        const moved =
          previousUpstream === null ||
          previousUpstream.host !== nextUpstream.host ||
          previousUpstream.port !== nextUpstream.port ||
          previousUpstream.scheme !== nextUpstream.scheme;
        if (proxy && followsSpec && moved) {
          // Only a move the gateway would actually make is subject to the
          // policy: a document whose `servers[0]` is private can still be
          // stored for an API whose backend is pinned elsewhere.
          assertUpstreamAllowed(nextUpstream, upstreamPolicy);
          await replaceProxyBackend(api.ferrum_proxy_id, api.slug, nextUpstream, actor.id);
          backendUpdated = true;
          restoreBackend = () => restoreProxy(proxy, api.slug, actor.id);
        }
      }

      let spec: ApiSpecRecord;
      let updated: ApiRecord;
      try {
        const persisted = await store.transaction(async (tx) => {
          const revision = await tx.apiSpecs.create({
            api_id: api.id,
            version: nextVersion,
            raw_spec: parsed.raw,
            parsed_title: parsed.title,
            parsed_version: parsed.version,
            is_current: true,
          });
          await tx.apiSpecs.setCurrent(api.id, revision.id);
          const row =
            nextVersion === api.version
              ? api
              : ((await tx.apis.update(api.id, { version: nextVersion })) ?? api);
          return { spec: revision, api: row };
        });
        spec = persisted.spec;
        updated = persisted.api;
      } catch (error) {
        if (restoreBackend) await restoreBackend().catch(() => undefined);
        throw error;
      }

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.API_SPEC_UPDATE,
        { type: 'api', id: api.id },
        {
          spec_id: spec.id,
          version: nextVersion,
          spec_paths: parsed.pathCount,
          spec_operations: parsed.operationCount,
          backend_updated: backendUpdated,
        },
        ip,
      );

      return { api: updated, spec: specSummary(spec) };
    },

    async remove(actor, apiId, ip = null): Promise<{ revoked_grants: number }> {
      const api = await loadApi(apiId);
      assertCanAdminister(actor, api);

      // 1. Take the API off the gateway first: once the proxy is gone nobody can
      //    call it, so a later failure cannot leave it reachable-but-untracked.
      if (api.ferrum_proxy_id) {
        for (const plugin of await pluginsOf(api)) {
          await edge.pluginConfigs.delete(plugin.id, actor.id).catch(() => undefined);
        }
        await edge.proxies.delete(api.ferrum_proxy_id, actor.id);
      }

      // 2. Strip the ACL group from every grantee. The group would be inert with
      //    the proxy gone, but leaving 500-capped junk on consumers is not okay.
      const grants = await store.grants.listActiveByApi(api.id);
      for (const grant of grants) {
        await stripGroup(grant.user_id, api.id).catch(() => undefined);
      }

      // 3. Drop the rows. The store's delete helpers are the cascade.
      await store.transaction(async (tx) => {
        await tx.grants.deleteByApi(api.id);
        await tx.accessRequests.deleteByApi(api.id);
        await tx.apiSpecs.deleteByApi(api.id);
        await tx.apis.delete(api.id);
      });

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.API_DELETE,
        { type: 'api', id: api.id },
        { slug: api.slug, proxy_id: api.ferrum_proxy_id, revoked_grants: grants.length },
        ip,
      );

      for (const grant of grants) {
        await notifications
          .notify(
            grant.user_id,
            'access_revoked',
            `${api.name} was removed`,
            `The provider removed ${api.name} from the portal. Your access to it has ended.`,
            '/catalog',
          )
          .catch(() => undefined);
      }

      return { revoked_grants: grants.length };
    },

    async createTestConsumer(
      actor,
      apiId,
      label = null,
      ip = null,
    ): Promise<CreateTestConsumerResponse> {
      const api = await loadApi(apiId);
      assertCanAdminister(actor, api);

      const username = testConsumerUsername(api.id);
      const group = aclGroupForApi(api.id);

      // Serialise on the username rather than a consumer id: the id changes on
      // every replacement, so it is not a stable key, and two concurrent
      // requests would otherwise both delete and both create. The key is
      // prefixed so it can never collide with a consumer-id key used by the
      // credentials service.
      const replaced = await edge.serializePerKey(`test-consumer:${username}`, async () => {
        // Recreating replaces: a test consumer is disposable by definition, and
        // deleting it is the only way to reset its credentials show-once state.
        const existing = await edge.consumers.getByUsername(username);
        let revokedCredentials = 0;
        if (existing) {
          await edge.consumers.delete(existing.id, actor.id);
          // The credentials of the deleted consumer no longer exist on the
          // gateway; leaving their rows `active` would show the provider keys
          // that cannot authenticate anything. The mirror follows the gateway.
          for (const row of await store.credentials.listByConsumer(existing.id)) {
            if (row.status === 'revoked') continue;
            await store.credentials.update(row.id, { status: 'revoked' });
            revokedCredentials += 1;
          }
        }

        const consumer = await edge.consumers.create(
          { username, custom_id: `nexus-test:${api.id}`, acl_groups: [group] },
          actor.id,
        );

        const issued = await credentials.issueForConsumer({
          user: actor,
          consumerId: consumer.id,
          consumerUsername: consumer.username,
          credentialType: CREDENTIAL_TYPE_FOR_PLUGIN[api.auth_plugin],
          label: label ?? `Test consumer for ${api.slug}`,
        });

        return { consumer, issued, replacedExisting: existing !== null, revokedCredentials };
      });

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.TEST_CONSUMER_CREATE,
        { type: 'api', id: api.id },
        {
          consumer_username: username,
          consumer_id: replaced.consumer.id,
          credential_type: replaced.issued.credential.credential_type,
          replaced: replaced.replacedExisting,
          revoked_credentials: replaced.revokedCredentials,
        },
        ip,
      );

      return {
        credential: replaced.issued.credential,
        consumer_username: replaced.consumer.username,
        secret: replaced.issued.secret,
      };
    },
  };

  /** `PUT /proxies/{id}` with a fresh backend, preserving the routing fields. */
  async function replaceProxyBackend(
    proxyId: string,
    slug: string,
    upstream: SpecUpstream,
    subject: string,
  ): Promise<void> {
    await edge.proxies.replace(
      proxyId,
      {
        id: proxyId,
        name: proxyNameForSlug(slug),
        listen_path: listenPathFor(namespace, slug),
        backend_scheme: upstream.scheme,
        backend_host: upstream.host,
        backend_port: upstream.port,
        ...(upstream.basePath ? { backend_path: upstream.basePath } : {}),
        strip_listen_path: true,
      },
      subject,
    );
  }

  /**
   * Put a proxy back the way a `GET /proxies/{id}` found it.
   *
   * Used to compensate a backend replacement whose follow-up step failed. Only
   * the fields Nexus ever writes are restored; `listen_path` falls back to the
   * canonical path for the slug because `EdgeProxyWrite` requires one and an
   * operator-blanked value would not be routable anyway.
   */
  async function restoreProxy(proxy: EdgeProxy, slug: string, subject: string): Promise<void> {
    await edge.proxies.replace(
      proxy.id,
      {
        id: proxy.id,
        name: proxy.name ?? proxyNameForSlug(slug),
        listen_path: proxy.listen_path ?? listenPathFor(namespace, slug),
        backend_scheme: proxy.backend_scheme === 'http' ? 'http' : 'https',
        backend_host: proxy.backend_host ?? '',
        backend_port: proxy.backend_port ?? 443,
        ...(proxy.backend_path ? { backend_path: proxy.backend_path } : {}),
        strip_listen_path: proxy.strip_listen_path ?? true,
      },
      subject,
    );
  }

  /** Best-effort in-app notice to everyone holding an active grant on `apiId`. */
  async function notifyGrantees(
    apiId: Uuid,
    type: Parameters<NotificationsService['notify']>[1],
    title: string,
    body: string,
    link: string,
  ): Promise<void> {
    const grants = await store.grants.listActiveByApi(apiId);
    for (const grant of grants) {
      await notifications.notify(grant.user_id, type, title, body, link).catch(() => undefined);
    }
  }
}
