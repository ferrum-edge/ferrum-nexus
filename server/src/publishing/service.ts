/**
 * Publishing — the bridge between "a provider uploaded a spec" and "a proxy
 * exists on the gateway".
 *
 * ## The Edge object graph behind one published API
 *
 * ```
 * apis row ─── proxy  name `nexus-<slug>`, listen_path `/<ns>/<slug>`
 *               │
 *               │  proxy.plugins[] ── the association list; this is what makes
 *               │                     a config run at all
 *               ├─ plugin_config    the auth plugin (key_auth | basic_auth | jwt_auth)
 *               ├─ plugin_config    access_control, only when `requestable`
 *               ├─ plugin_config    rate_limiting, only when a rate limit is set
 *               └─ plugin_config    cors, only when a CORS policy is set
 * ```
 *
 * **A plugin config with a matching `proxy_id` is inert until the proxy's own
 * `plugins[]` names it.** Edge decides what to run in `plugin_cache.rs`
 * (`scoped_plugin_config_applies_to_proxy`): a proxy-scoped config applies only
 * when it targets the proxy *and* the proxy associates it. Creating the config
 * is therefore only half the job — every create is followed by an association
 * write, and every removal is preceded by a disassociation.
 *
 * Nexus stores the proxy id on the `apis` row and **does not** store the plugin
 * config ids: they are looked up with `GET /plugins/config` filtered by
 * `proxy_id` whenever they need changing. That keeps the schema free of ids
 * whose lifecycle Nexus does not own, and reconciles automatically if an
 * operator ever recreates one by hand.
 *
 * ## Every proxy write is read-modify-write
 *
 * `PUT /proxies/{id}` is a whole-resource replace against a struct carrying
 * `deny_unknown_fields`, with no concurrency token — the same shape as
 * `PUT /consumers/{id}`. A body built only from the fields Nexus models resets
 * everything it omits to its serde default, so an operator's `hosts`,
 * timeouts, backend TLS, `upstream_id` — and the association list itself —
 * would vanish the first time a provider moved an upstream. Every write
 * therefore goes through `mutateProxy`: `GET`, change the handful of fields
 * that are actually changing, `PUT` the whole document back, serialised per
 * proxy id so two concurrent round trips cannot lose one edit.
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
  type CorsConfig,
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
  EdgePluginAssociation,
  EdgePluginConfig,
  EdgePluginConfigWrite,
  EdgePluginSettings,
  EdgeProxy,
  EdgeProxyReplace,
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
 * Edge's browser-CORS plugin.
 *
 * Unlike `access_control` and `rate_limiting` this has no constant in `shared`:
 * the portal never names it, because a CORS policy is expressed on the API row
 * as {@link CorsConfig} and only this module turns that into a plugin.
 */
const CORS_PLUGIN = 'cors';

/**
 * Fields a `GET /proxies/{id}` returns that the **gateway** owns, and which are
 * therefore dropped from the body of the `PUT` that follows.
 *
 * Edge's deserializer accepts all three (they carry serde defaults) but
 * overwrites them: the namespace comes from `X-Ferrum-Namespace` and the
 * timestamps from the server. Echoing them back is at best ignored, so the
 * honest thing is not to send them at all.
 */
const SERVER_OWNED_PROXY_FIELDS = ['namespace', 'created_at', 'updated_at'] as const;

/** One entry of `Proxy.plugins`. */
function association(pluginConfigId: string): EdgePluginAssociation {
  return { plugin_config_id: pluginConfigId };
}

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

/**
 * Config for `cors`.
 *
 * Exactly the two keys the portal models. Edge's `cors` accepts six more
 * (`allowed_methods`, `allowed_headers`, `exposed_headers`, `max_age`,
 * `preflight_continue`, `unmatched_preflights`) and every one of them has a
 * native default that is right for a portal-published API, so sending a key
 * Nexus cannot let the provider change would only freeze that default in place.
 * `allowed_origins` is required — there is no implicit wildcard — which is why
 * an API with no policy has no `cors` plugin at all rather than an empty one.
 */
export function corsPluginConfig(cors: CorsConfig): EdgePluginSettings {
  return {
    allowed_origins: [...cors.allowed_origins],
    allow_credentials: cors.allow_credentials,
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

  /* ── Proxy writes ─────────────────────────────────────────────────────── */

  /**
   * Read one proxy, change it, and write the **whole** document back.
   *
   * `PUT /proxies/{id}` is a whole-resource replace with no concurrency token,
   * so `change` receives the document the gateway just returned and returns it
   * with the handful of fields that are actually changing overwritten —
   * anything omitted from the body is reset to its serde default, which is how
   * an operator's `hosts`, timeouts, backend TLS or `upstream_id` used to
   * disappear the first time Nexus repointed a backend.
   *
   * Serialised on the proxy id for the same reason consumer writes are: two
   * concurrent GET→edit→PUT round trips would silently lose one edit. The key
   * is prefixed so it can never collide with the consumer-id keys the
   * credentials service uses.
   *
   * `change` may return `null` to mean "already as it should be", which skips
   * the write entirely. Returns the document **as it was found**, which is what
   * an undo step needs.
   */
  async function mutateProxy(
    proxyId: string,
    change: (proxy: EdgeProxy) => EdgeProxyReplace | null,
    subject: string,
  ): Promise<EdgeProxy> {
    return edge.serializePerKey(`proxy:${proxyId}`, async () => {
      const current = await edge.proxies.get(proxyId);
      if (!current) throw notFound('Proxy', proxyId);
      const body = change(current);
      if (body === null) return current;
      for (const field of SERVER_OWNED_PROXY_FIELDS) delete body[field];
      await edge.proxies.replace(proxyId, body, subject);
      return current;
    });
  }

  /** The proxy's association list, as plain plugin config ids. */
  function associatedIds(proxy: EdgeProxy): string[] {
    return (proxy.plugins ?? []).map((entry) => entry.plugin_config_id);
  }

  /**
   * Make the gateway actually run these plugin configs on this proxy.
   *
   * Idempotent: ids already in the list are left where they are, and a write
   * that would change nothing is skipped.
   */
  async function associate(proxyId: string, configIds: string[], subject: string): Promise<void> {
    await mutateProxy(
      proxyId,
      (proxy) => {
        const current = associatedIds(proxy);
        const additions = configIds.filter((id) => !current.includes(id));
        if (additions.length === 0) return null;
        return { ...proxy, plugins: [...current, ...additions].map(association) };
      },
      subject,
    );
  }

  /**
   * Stop the gateway running these plugin configs on this proxy.
   *
   * Always paired with — and ordered *before* — deleting the config. Edge's
   * `DELETE /plugins/config/{id}` clears the junction rows itself, so this is
   * not strictly required, but doing it in this order means the association
   * list never names a row that has already gone.
   */
  async function disassociate(
    proxyId: string,
    configIds: string[],
    subject: string,
  ): Promise<void> {
    await mutateProxy(
      proxyId,
      (proxy) => {
        const current = associatedIds(proxy);
        const kept = current.filter((id) => !configIds.includes(id));
        if (kept.length === current.length) return null;
        return { ...proxy, plugins: kept.map(association) };
      },
      subject,
    );
  }

  /**
   * Undo step for "a plugin config was created for this proxy": detach it, then
   * delete it.
   *
   * Registered *before* the association write, so it also cleans up a config
   * whose association never landed — detaching an id that is not in the list is
   * a no-op.
   */
  function undoAttach(proxyId: string, configId: string, subject: string): () => Promise<void> {
    return async () => {
      await disassociate(proxyId, [configId], subject);
      await edge.pluginConfigs.delete(configId, subject);
    };
  }

  /**
   * Undo step for "an associated plugin config is being removed": put it back
   * and re-associate it.
   *
   * The original row is reused when the delete never landed, so a failure
   * between the disassociate and the delete cannot leave a second copy of the
   * same plugin behind.
   */
  function undoRemoval(
    proxyId: string,
    config: EdgePluginConfig,
    subject: string,
  ): () => Promise<void> {
    return async () => {
      const survivor = await edge.pluginConfigs.get(config.id);
      const id = survivor
        ? config.id
        : (await attach(proxyId, config.plugin_name, config.config, subject)).id;
      await associate(proxyId, [id], subject);
    };
  }

  /**
   * Bring one *optional* plugin to `settings`, or remove it when `settings` is
   * `null`, pushing the step that undoes whatever it did onto `undo`.
   *
   * `rate_limiting` and `cors` are the same problem — an optional, replaceable,
   * proxy-scoped config — so they share this. Note the asymmetry: a replace
   * keeps the config id, so only the create and the delete touch the proxy's
   * association list.
   */
  async function reconcileOptionalPlugin(
    proxyId: string,
    existing: EdgePluginConfig | undefined,
    pluginName: string,
    settings: EdgePluginSettings | null,
    subject: string,
    undo: (() => Promise<void>)[],
  ): Promise<void> {
    if (settings === null) {
      if (!existing) return;
      undo.push(undoRemoval(proxyId, existing, subject));
      await disassociate(proxyId, [existing.id], subject);
      await edge.pluginConfigs.delete(existing.id, subject);
      return;
    }

    if (existing) {
      const body = (config: EdgePluginSettings, enabled: boolean): EdgePluginConfigWrite => ({
        plugin_name: pluginName,
        scope: 'proxy',
        proxy_id: proxyId,
        enabled,
        config,
      });
      await edge.pluginConfigs.replace(existing.id, body(settings, true), subject);
      undo.push(async () => {
        await edge.pluginConfigs.replace(
          existing.id,
          body(existing.config, existing.enabled),
          subject,
        );
      });
      return;
    }

    const attached = await attach(proxyId, pluginName, settings, subject);
    undo.push(undoAttach(proxyId, attached.id, subject));
    await associate(proxyId, [attached.id], subject);
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
        if (input.cors) {
          const cors = await attach(proxy.id, CORS_PLUGIN, corsPluginConfig(input.cors), owner.id);
          created.pluginIds.push(cors.id);
        }

        // None of the above is live yet. A proxy-scoped plugin config only runs
        // once the proxy's own `plugins[]` names it, so this single write is
        // what turns the API from open, ungated and unlimited into what the
        // portal says it is. Edge will not accept a config for a proxy that
        // does not exist, so the window between creating the proxy and this
        // call cannot be closed from here — only kept to one round trip, and
        // rolled back below if anything in it fails.
        await associate(proxy.id, created.pluginIds, owner.id);

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
        // happened. Deleting the proxy cascades its association rows and its
        // proxy-scoped plugin configs, so a half-written association list needs
        // no separate rollback; the explicit config deletes make the intent
        // obvious and survive a partial cascade. The store transaction has
        // already rolled itself back, so nothing is left on the Nexus side
        // either.
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
          cors: input.cors ?? null,
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
          const before = await replaceProxyBackend(proxyId, upstream, actor.id);
          undo.push(restoreProxyBackend(before, actor.id));
          // The row records where the gateway is now pointed, normalized rather
          // than however the provider typed it.
          update.upstream_url = formatUpstreamUrl(upstream);
          changed.push('upstream_url');
          details.upstream = `${upstream.scheme}://${upstream.host}:${upstream.port}`;
        }

        if (patch.auth_plugin !== undefined && patch.auth_plugin !== api.auth_plugin && proxyId) {
          const previous = findPlugin(plugins, api.auth_plugin);
          // Attach *and associate* the replacement before detaching the
          // incumbent. For the moment both are live the proxy accepts either
          // credential (auth plugins run in priority order until one succeeds,
          // §3.4), which is a vastly safer window than the one the other order
          // opens: a live proxy fronting the provider's upstream with no
          // authentication plugin the gateway actually runs. Associating is
          // part of that — a config the proxy does not name is not "attached"
          // in any sense the gateway cares about.
          const attached = await attach(
            proxyId,
            patch.auth_plugin,
            authPluginConfig(patch.auth_plugin),
            actor.id,
          );
          undo.push(undoAttach(proxyId, attached.id, actor.id));
          await associate(proxyId, [attached.id], actor.id);
          if (previous) {
            undo.push(undoRemoval(proxyId, previous, actor.id));
            await disassociate(proxyId, [previous.id], actor.id);
            await edge.pluginConfigs.delete(previous.id, actor.id);
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
            undo.push(undoAttach(proxyId, attached.id, actor.id));
            await associate(proxyId, [attached.id], actor.id);
          } else if (!patch.requestable && acl) {
            // Dropping the gate opens the API to every authenticated consumer;
            // existing grants stay on the consumers and become inert.
            undo.push(undoRemoval(proxyId, acl, actor.id));
            await disassociate(proxyId, [acl.id], actor.id);
            await edge.pluginConfigs.delete(acl.id, actor.id);
          }
          update.requestable = patch.requestable;
          changed.push('requestable');
        }

        if (patch.rate_limit !== undefined && proxyId) {
          await reconcileOptionalPlugin(
            proxyId,
            findPlugin(plugins, RATE_LIMIT_PLUGIN),
            RATE_LIMIT_PLUGIN,
            patch.rate_limit === null ? null : rateLimitConfig(patch.rate_limit),
            actor.id,
            undo,
          );
          update.rate_limit = patch.rate_limit;
          changed.push('rate_limit');
        }

        if (patch.cors !== undefined && proxyId) {
          await reconcileOptionalPlugin(
            proxyId,
            findPlugin(plugins, CORS_PLUGIN),
            CORS_PLUGIN,
            patch.cors === null ? null : corsPluginConfig(patch.cors),
            actor.id,
            undo,
          );
          update.cors = patch.cors;
          changed.push('cors');
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
      /** Normalized upstream the proxy now points at, when it moved. */
      let movedTo: string | null = null;
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
          await replaceProxyBackend(api.ferrum_proxy_id, nextUpstream, actor.id);
          backendUpdated = true;
          movedTo = formatUpstreamUrl(nextUpstream);
          restoreBackend = restoreProxyBackend(proxy, actor.id);
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
          // The row that records where the gateway points moves with the
          // gateway, in the same transaction as the revision: if this rolls
          // back, the compensation below puts the proxy back and the row never
          // claimed the new upstream in the first place.
          const changes: Partial<ApiRecord> = {};
          if (nextVersion !== api.version) changes.version = nextVersion;
          if (movedTo !== null) changes.upstream_url = movedTo;
          const row =
            Object.keys(changes).length === 0
              ? api
              : ((await tx.apis.update(api.id, changes)) ?? api);
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
      //
      //    The **proxy** goes first, before its plugin configs. Edge's
      //    `DELETE /plugins/config/{id}` deletes the config's `proxy_plugins`
      //    rows along with it rather than refusing while it is still
      //    associated, so deleting the auth config first would leave a live
      //    proxy fronting the provider's upstream with nothing authenticating
      //    it for as long as the teardown took. Deleting the proxy cascades
      //    both the association rows and every proxy-scoped config, so no
      //    disassociation step is needed at all; the sweep afterwards only
      //    exists in case a gateway ever leaves one behind, and 404s harmlessly
      //    when the cascade did its job.
      if (api.ferrum_proxy_id) {
        const attached = await pluginsOf(api);
        await edge.proxies.delete(api.ferrum_proxy_id, actor.id);
        for (const plugin of attached) {
          await edge.pluginConfigs.delete(plugin.id, actor.id).catch(() => undefined);
        }
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

  /**
   * Point a proxy at a new backend, leaving everything else exactly as it is.
   *
   * Only the four `backend_*` fields are touched: `name`, `listen_path`,
   * `hosts`, the timeouts, the TLS paths, `upstream_id` and the plugin
   * association list all come back off the `GET` untouched. Rebuilding the
   * document from the slug instead, as this used to, reset every one of them to
   * a default on a whole-resource `PUT`.
   *
   * Returns the proxy as it was before the move, ready for
   * {@link restoreProxyBackend}.
   */
  async function replaceProxyBackend(
    proxyId: string,
    upstream: SpecUpstream,
    subject: string,
  ): Promise<EdgeProxy> {
    return mutateProxy(
      proxyId,
      (proxy) => ({
        ...proxy,
        backend_scheme: upstream.scheme,
        backend_host: upstream.host,
        backend_port: upstream.port,
        // Explicitly `null` when the new upstream has no base path: this is a
        // merge, so omitting the key would keep the *old* path under the new
        // host.
        backend_path: upstream.basePath,
      }),
      subject,
    );
  }

  /**
   * Undo step that puts a proxy's backend back where
   * {@link replaceProxyBackend} found it.
   *
   * Only the backend fields are rewound, on top of a fresh read. A blanket
   * restore of the whole captured document would also revert the plugin
   * association changes a later step of the same PATCH made — those are undone
   * by their own steps, in their own order.
   */
  function restoreProxyBackend(previous: EdgeProxy, subject: string): () => Promise<void> {
    const backend = {
      backend_scheme: previous.backend_scheme,
      backend_host: previous.backend_host,
      backend_port: previous.backend_port,
      backend_path: previous.backend_path ?? null,
    };
    return async () => {
      await mutateProxy(previous.id, (proxy) => ({ ...proxy, ...backend }), subject);
    };
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
